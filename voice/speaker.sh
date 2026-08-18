#!/usr/bin/env bash
# The single drainer. Exactly one instance runs, holding an exclusive lock, and it
# is the only process in the system that calls `say`. That is the entire reason
# this is a daemon and not a function: macOS does not queue concurrent `say`
# calls, it plays them at once, and four parallel Claude sessions then produce
# noise rather than information.
#
# Everything else here exists to keep the announcements worth listening to:
# priority ordering so a blocked session jumps the queue, debouncing so a burst
# collapses to one line, staleness so a late completion is dropped rather than
# read out, and phrase variety so it sounds like an assistant and not a beep.

J="$HOME/.claude/jarvis"
[ -f "$J/config.sh" ] && . "$J/config.sh"
# Every OS-specific call lives in platform.sh. Nothing below this line names `say`,
# `afplay` or `osascript`.
[ -f "$J/platform.sh" ] && . "$J/platform.sh"
Q="$J/queue"; S="$J/state"
mkdir -p "$Q" "$S/active" "$S/pending" 2>/dev/null

SIR="${JARVIS_ADDRESS:-sir}"; [ -n "$SIR" ] && SIR=", $SIR"

# Resolve one voice per session slot, ONCE. Four sessions in four different voices is a
# stronger cue than four pitches of one voice: you recognise a voice without having to
# remember what slot 3 sounded like.
#
# Resolved here rather than per announcement because validating a name costs a full
# `say -v '?'` listing — and validating matters: `say` falls back to the US default for
# a name it does not have, silently, so an uninstalled voice would give session 2 an
# American accent with nothing anywhere to explain it.
# Read through indirection in voice_for(), which is what lets a slot be looked up by
# number instead of by four branches. A static checker cannot see that.
# shellcheck disable=SC2034
JV_V1=""
# shellcheck disable=SC2034
JV_V2=""
# shellcheck disable=SC2034
JV_V3=""
# shellcheck disable=SC2034
JV_V4=""
resolve_voices() {
  local want="${JARVIS_VOICES:-}" i=1 v
  # Nothing configured: every slot uses the single voice, and there is nothing to
  # validate. Skip the `say -v '?'` listing entirely — it is a process spawn on every
  # daemon start to answer a question whose answer is already known, and it made the
  # daemon a second slower to reach its first announcement.
  if [ -z "$want" ]; then
    # All four are read by indirection in voice_for(); a static checker cannot see it.
    JV_V1="${JARVIS_VOICE:-}"
    # shellcheck disable=SC2034
    JV_V2="$JV_V1"
    # shellcheck disable=SC2034
    JV_V3="$JV_V1"
    # shellcheck disable=SC2034
    JV_V4="$JV_V1"
    return 0
  fi
  local rest="$want"
  while [ "$i" -le 4 ]; do
    v="${rest%%|*}"
    case "$rest" in *\|*) rest="${rest#*|}" ;; *) rest="" ;; esac
    [ -z "$v" ] && v="${JARVIS_VOICE:-}"
    # Unavailable name -> the configured default. `doctor` reports which fell back.
    jv_voice_exists "$v" || v="${JARVIS_VOICE:-}"
    eval "JV_V$i=\"\$v\""
    i=$(( i + 1 ))
    [ -z "$rest" ] && rest="$want"
  done
}
resolve_voices

# voice_for <ordinal>
voice_for() {
  local o="${1:-1}" v
  case "$o" in ''|*[!0-9]*) o=1 ;; esac
  o=$(( (o - 1) % 4 + 1 ))
  v="JV_V$o"; printf '%s' "${!v-}"
}

pick()    { local a=("$@"); printf '%s' "${a[$(( RANDOM % ${#a[@]} ))]}"; }
nactive() { ls "$S/active" 2>/dev/null | wc -l | tr -d ' '; }
speak()   { jv_say "$1" "${SPEAK_VOICE:-}"; }
banner()  { jv_notify "$1" "$2"; }

# ---------------------------------------------------------------------- CHIMES
#
# The motif tables are GENERATED, not written here: scripts/tones.mjs synthesises one
# WAV per note with pitch, envelope and loudness already baked in, and emits this
# shell table alongside them. Two reasons it works that way.
#
# Musically: the first version layered pairs of macOS system sounds 160ms apart, and
# measurement showed that could not work — the usable ones are 0.56-1.65s long with
# their energy in the same 300-1000Hz band, so "two notes" was a sustained chord, and
# the same file over itself was comb filtering.
#
# Practically: shaping a sound at playback needs `afplay -r` and `-v`, which exist
# only on macOS. `aplay` and Windows' Media.SoundPlayer have no volume control at all.
# Baking it into the file reduces playback to "play this", which every platform can
# do — and the frequency and decay end up chosen rather than inherited.
TONES="$J/tones"
[ -f "$TONES/motifs.sh" ] && . "$TONES/motifs.sh"

# motif <kind> <session-ordinal>
#
# Ends by waiting out its own span, so speech starts AFTER the chime rather than
# underneath it. That costs about a third of a second and buys the intelligibility of
# the first word, which is normally the project name.
motif() {
  local k="$1" o="${2:-1}" v seq span item f d
  case "$o" in ''|*[!0-9]*) o=1 ;; esac
  [ "$o" -lt 1 ] || [ "$o" -gt 4 ] && o=$(( (o - 1) % 4 + 1 ))
  v="MOTIF_${k}_${o}"; seq="${!v-}"
  v="SPAN_${k}_${o}";  span="${!v-}"
  # No tones generated (or a partial install): stay silent rather than erroring. The
  # speech still carries the message, and `doctor` reports the missing set.
  [ -z "$seq" ] && return 0
  for item in $seq; do
    f="${item%%:*}"; d="${item##*:}"
    jv_play_at "$TONES/$f" "$d"
  done
  sleep "${span:-0.3}"
  return 0
}

plural() { [ "$1" = "1" ] && printf '%s' "$2" || printf '%s' "$2s"; }

dur() {
  local s=${1:-0}
  if   [ "$s" -lt 90 ];   then echo "$s $(plural "$s" second)"
  elif [ "$s" -lt 5400 ]; then echo "$((s/60)) $(plural "$((s/60))" minute)"
  else echo "$((s/3600)) $(plural "$((s/3600))" hour)"; fi
}

# The spoken form of a session name. A directory basename is not a word: `wt_nst` is
# a worktree prefix plus an initialism, and `say` renders it as two nonsense
# syllables. JARVIS_NAMES overrides per project: "wt_nst=N S T;frappe-bench=bench".
spoken() {
  local n="$1" rest="${JARVIS_NAMES:-}" pair
  while [ -n "$rest" ]; do
    pair="${rest%%;*}"
    case "$rest" in *\;*) rest="${rest#*;}" ;; *) rest="" ;; esac
    [ -z "$pair" ] && continue
    if [ "${pair%%=*}" = "$n" ]; then printf '%s' "${pair#*=}"; return; fi
  done
  n="${n//_/ }"; n="${n//-/ }"
  case "$n" in "wt "*) n="${n#wt }" ;; esac
  # A short token with no vowel is an initialism, not a word: stripping the worktree
  # prefix from `wt_nst` left "nst", which `say` pronounces as one nonsense syllable.
  # Spelling it out is both correct and shorter to hear than the mangled attempt.
  local out="" w
  for w in $n; do
    case "$w" in
      *[aeiouAEIOU]*) out="$out $w" ;;
      ?|??|???|????)  out="$out $(echo "$w" | tr 'a-z' 'A-Z' | sed 's/./& /g;s/ *$//')" ;;
      *)              out="$out $w" ;;
    esac
  done
  printf '%s' "${out# }"
}

# render <mode> <name> <extra> <ordinal> [summary]
render() {
  local mode="$1" name="$2" extra="$3" ord="$4" summary="${5:-}"

  # Resolve the once-only farewell BEFORE anything is logged. Closing a terminal fires
  # every session's SessionEnd, so four byes reach render and three of them are
  # non-events — but they were still being written to the log, which then claimed four
  # farewells had been announced when one was. A log that overstates what was said is
  # worse than no log, because it is what `jarvisctl log` shows and what the
  # simulation reports.
  if [ "$mode" = bye ]; then
    { [ "$(nactive)" -eq 0 ] && mkdir "$J/run/farewell" 2>/dev/null; } || return 0
  fi

  # The voice for this session slot, for as long as this announcement lasts.
  local SPEAK_VOICE; SPEAK_VOICE=$(voice_for "$ord")

  # One line per announcement. This is what `jarvisctl log` shows and what the
  # concurrency tests assert against — the behaviour that matters is unobservable
  # otherwise, since the output is sound.
  printf '%s %-8s %-20s %-9s %s\n' "$(date +%H:%M:%S)" "$mode" "$name" "${extra:-—}" "${summary:-}" >> "$J/log" 2>/dev/null
  [ "$(wc -l < "$J/log" 2>/dev/null || echo 0)" -gt 500 ] && { tail -200 "$J/log" > "$J/log.t" 2>/dev/null && mv "$J/log.t" "$J/log"; }

  # Two registers, not one. Measured at rate 172, the original phrasings ran
  # 4.4-5.4 seconds EACH, and Stop fires on every turn over 25s — so a normal
  # session spent minutes being talked at. Naming the project is only worth its
  # 1.1-1.6s when there is more than one session to tell apart; alone, the terse
  # form says the same thing in 1.7s instead of 5.4s.
  local solo=1 who=""
  if [ "$(nactive)" -gt 1 ]; then
    solo=0
    who="$(spoken "$name")"
  fi

  case "$mode" in
    boot)
      local h g; h=$(date +%H)
      if   [ "$h" -lt 12 ]; then g="Good morning"
      elif [ "$h" -lt 18 ]; then g="Good afternoon"
      else g="Good evening"; fi
      motif boot "$ord"
      # Boot names the project even when solo: it is the one moment the name is
      # information rather than repetition.
      speak "$g$SIR. $(spoken "$name") online." ;;

    tick) motif tick "$ord" ;;

    done)
      local el=${extra%%:*} subs=${extra##*:}
      case "$subs" in ''|*[!0-9]*) subs=0 ;; esac
      # A swarm run and a one-line edit both end in Stop. The specialist count is
      # the only thing in the announcement that distinguishes them.
      local crew=""
      [ "$subs" -ge 2 ] && crew=" $subs specialists,"
      motif 'done' "$ord"
      if [ -n "$summary" ]; then
        # The summary IS the content, so the specialist count goes. That count only ever
        # existed because there was nothing better to say than "time passed" — a run that
        # can report "schema is in, all tests pass" does not need to also report that six
        # agents were involved in it.
        if [ "$solo" = 1 ]; then
          speak "$summary$SIR. $(dur "$el")."
        else
          speak "$who: $summary$SIR. $(dur "$el")."
        fi
        banner "$name" "$summary  ($(dur "$el"))"
      elif [ "$solo" = 1 ]; then
        speak "$(pick "Done$SIR.$crew $(dur "$el")." \
                      "Finished$SIR.$crew $(dur "$el")." \
                      "All done$SIR.$crew $(dur "$el").")"
        banner "$name" "Complete - $(dur "$el")${crew:+ -$crew}"
      else
        speak "$(pick "$who done$SIR.$crew $(dur "$el")." \
                      "$who finished.$crew $(dur "$el")." \
                      "$who, all done.$crew $(dur "$el").")"
        banner "$name" "Complete - $(dur "$el")${crew:+ -$crew}"
      fi ;;

    approve)
      motif approve "$ord"
      if [ "$solo" = 1 ]; then
        speak "$(pick "Your approval$SIR." "Approval needed$SIR." "Holding for clearance$SIR.")"
      else
        speak "$(pick "$who needs your approval$SIR." \
                      "$who is holding for clearance$SIR." \
                      "$who needs you$SIR.")"
      fi
      banner "$name" "Approval required" ;;

    escalate)
      # The nags have run out and it is still blocked. This is the most expensive
      # failure the whole layer exists to catch — a session that has been stopped for
      # minutes while the others work — so it gets the loudest motif, a named duration,
      # and a banner that stays on screen.
      motif escalate 1
      speak "$(spoken "$name") has been waiting $(dur "$extra")$SIR. [[slnc 200]] It is going nowhere without you."
      banner "$name" "STILL BLOCKED - $(dur "$extra")" ;;

    nag)
      motif nag "$ord"
      speak "$(pick "$(spoken "$name") is still waiting$SIR." \
                    "Still blocked on $(spoken "$name")$SIR." \
                    "$(spoken "$name") has not moved$SIR.")" ;;

    idle)
      motif idle "$ord"
      if [ "$solo" = 1 ]; then
        speak "$(pick "Standing by$SIR." "Awaiting instruction$SIR." "Whenever you're ready$SIR.")"
      else
        speak "$(pick "$who is standing by$SIR." "$who awaits instruction$SIR.")"
      fi ;;

    sub) motif sub "$ord" ;;

    subspeak)
      motif sub "$ord"
      speak "$(pick "Specialist $extra, back." "Subroutine $extra complete.")" ;;

    err)
      motif err "$ord"
      if [ "$solo" = 1 ]; then
        speak "$(pick "A problem$SIR." "We've hit a problem$SIR." "Something's gone wrong$SIR.")"
      else
        speak "$(pick "$who has a problem$SIR." "Something's gone wrong in $who$SIR.")"
      fi
      banner "$name" "Error" ;;

    bye)
      # Reaching here at all means this session won the farewell — see the guard at
      # the top of render(). mkdir is the atomic test-and-set; `nactive -eq 0` alone
      # is not enough, because every closing session removes its own marker before
      # the first bye is ever claimed.
      motif bye 1
      # The only moment anything here has a view of the whole day. One line, once,
      # across every session — which is the point of having a single assistant rather
      # than one narrator per terminal.
      digest=""
      if [ "${JARVIS_DAY_DIGEST:-1}" = "1" ] && [ -s "$S/day" ]; then
        turns=$(grep -c '' "$S/day" 2>/dev/null); turns=${turns:-0}
        probs=$(grep -c '|problem|' "$S/day" 2>/dev/null); probs=${probs:-0}
        if [ "$turns" -gt 0 ]; then
          digest=" $turns $(plural "$turns" turn)"
          if [ "$probs" -gt 0 ]; then
            # Name where it was left, because "one problem outstanding" without a
            # session name is a puzzle rather than a report.
            last=$(grep '|problem|' "$S/day" 2>/dev/null | tail -1 | cut -d'|' -f1)
            digest="$digest, and $probs $(plural "$probs" problem) outstanding, last in $(spoken "$last")"
          else
            digest="$digest, nothing outstanding"
          fi
        fi
      fi
      rm -f "$S/day"
      speak "All sessions closed$SIR.$digest." ;;
  esac

  # Extension point. Anything executable in hooks.d gets the event after it has been
  # announced: mode, session name, extra, ordinal. Backgrounded, output discarded, and
  # its exit status ignored — a user script must never be able to stall or kill the
  # daemon, because it would take every announcement down with it.
  if [ -d "$J/hooks.d" ]; then
    for h in "$J/hooks.d"/*; do
      [ -f "$h" ] && [ -x "$h" ] || continue
      ( "$h" "$mode" "$name" "$extra" "$ord" >/dev/null 2>&1 ) &
    done
  fi
  return 0
}

# Re-announce sessions still blocked on approval. Driven from the idle loop, so it
# needs no additional hook — and there is no hook that could serve it anyway,
# since nothing fires when a permission prompt goes unanswered.
check_nags() {
  [ "${JARVIS_NAG:-2}" = "0" ] && return
  local now f ts nm n age line ord
  now=$(date +%s)
  for f in "$S"/pending/*; do
    [ -e "$f" ] || continue
    IFS='|' read -r ts nm n esc < "$f"
    case "$ts" in ''|*[!0-9]*) continue ;; esac
    case "$n"  in ''|*[!0-9]*) n=0 ;; esac
    case "$esc" in ''|*[!0-9]*) esc=0 ;; esac
    age=$(( now - ts ))
    ord=1
    [ -r "$S/active/$(basename "$f")" ] && { read -r line < "$S/active/$(basename "$f")"; ord=${line##*|}; }

    if [ "$age" -ge $(( ${JARVIS_NAG_AFTER:-70} * (n + 1) )) ] && [ "$n" -lt "${JARVIS_NAG:-2}" ]; then
      printf '%s|%s|%s|%s\n' "$ts" "$nm" "$(( n + 1 ))" "$esc" > "$f"
      printf 'nag|%s||%s|%s|%s\n' "$nm" "$now" "$ord" "$(basename "$f")" > "$Q/1-$now-$$-$RANDOM"
    elif [ "$esc" = 0 ] && [ "${JARVIS_ESCALATE:-300}" != "0" ] && [ "$age" -ge "${JARVIS_ESCALATE:-300}" ]; then
      # Once only, and only after the nags are spent. Repeating an escalation turns the
      # most important alert in the set into background noise, which is the one thing
      # it cannot afford to become.
      printf '%s|%s|%s|1\n' "$ts" "$nm" "$n" > "$f"
      printf 'escalate|%s|%s|%s|%s|%s\n' "$nm" "$age" "$now" "$ord" "$(basename "$f")" > "$Q/0-$now-$$-$RANDOM"
    fi
  done
}

# Sourced as a library (JARVIS_LIB=1) the file stops here, exposing motif(), rate(),
# spoken(), dur() and the generated motif table for testing. A motif that references
# a tone which was never generated is silent and reports nothing, so it has to be
# asserted rather than heard.
[ "${JARVIS_LIB:-0}" = "1" ] && return 0

# Lifecycle ledger. A duplicate daemon is the failure this lock exists to prevent,
# and a point-in-time `ps` count misses one that starts and dies between samples —
# so every daemon records its own birth and death and the test counts births.
ledger() { printf '%s %s %s\n' "$(date +%s)" "$$" "$1" >> "$J/run/daemons.log" 2>/dev/null; }
# Idempotent, and it must be. `trap ... EXIT INT TERM` runs the TERM handler and
# then, because the shell goes on to exit, the EXIT handler as well — so cleanup ran
# twice and wrote two exit lines for one daemon. That made "how many daemons are
# live" read one below the truth, which is what `doctor` reports and what the test
# harness asserts on.
CLEANED=""
cleanup() {
  [ -n "$CLEANED" ] && return 0
  CLEANED=1
  trap - EXIT INT TERM
  [ "$(cat "$J/run/lock/pid" 2>/dev/null)" = "$$" ] && rm -rf "$J/run/lock"
  ledger exit
  return 0
}
trap cleanup EXIT INT TERM
echo $$ > "$J/run/lock/pid"
ledger start

idle_ticks=0
while :; do
  # If the lock is no longer ours, stand down immediately. This is what makes a
  # duplicate daemon impossible rather than merely unlikely, and it is also how an
  # orphan left behind by `jarvisctl reset` cleans itself up.
  [ "$(cat "$J/run/lock/pid" 2>/dev/null)" = "$$" ] || exit 0

  # Lowest-sorting queue entry, by glob rather than by `ls | grep`. Queue names begin
  # with the priority digit and claims begin with a dot, so the pattern excludes claims
  # by construction — and glob expansion is already sorted, which is what puts urgent
  # items first.
  f=""
  for g in "$Q"/[0-9]*; do
    [ -e "$g" ] || continue
    f=${g##*/}
    break
  done
  if [ -z "$f" ]; then
    idle_ticks=$(( idle_ticks + 1 ))
    [ $(( idle_ticks % 20 )) -eq 0 ] && check_nags
    [ "$idle_ticks" -gt 240 ] && break     # ~2 min quiet, then exit
    sleep 0.5; continue
  fi
  idle_ticks=0

  # Mute is checked HERE as well as in the hook. The hook cannot cover two cases:
  # an item queued in the second before you muted, and — worse — the nags, which the
  # daemon generates itself from its idle loop and which therefore never pass through
  # a hook at all. Muting for fifteen minutes did not stop it nagging.
  if [ -f "$S/muted" ] && [ "$(cat "$S/muted" 2>/dev/null)" -gt "$(date +%s)" ] 2>/dev/null; then
    rm -f "$Q"/[0-9]* 2>/dev/null
    sleep 0.5; continue
  fi

  # Claim atomically. `cat` then `rm` let two readers take the same entry and
  # announce it twice; `mv` cannot, and losing the race is a clean skip.
  claim="$Q/.claim.$$"
  mv "$Q/$f" "$claim" 2>/dev/null || continue
  line=$(cat "$claim" 2>/dev/null); rm -f "$claim"
  [ -z "$line" ] && continue
  # `key` is unused but must be read: without it the trailing field would be appended
  # to `ord`, and the chime would land on the wrong session.
  # shellcheck disable=SC2034
  IFS='|' read -r mode name extra born ord key summary <<< "$line"

  pri=${f%%-*}
  case "$born" in ''|*[!0-9]*) born=0 ;; esac
  age=$(( $(date +%s) - born ))

  if [ "$pri" -ge 4 ]; then
    [ "$age" -gt "${JARVIS_STALE:-50}" ] && continue

    # TRAILING debounce: wait for the burst to STOP, not merely for a fixed interval
    # to pass. A single 1.2s wait collapses only what has already arrived, so a burst
    # spread wider than the window straddles it — six subagent events 0.3s apart
    # produced two chimes, and six completions produced two announcements. Each round
    # absorbs everything matching, keeps the NEWEST (its elapsed time is the accurate
    # one), and goes round again only if more turned up while it was absorbing.
    #
    # Bounded at five rounds. An unbounded wait would let a session that chatters
    # steadily defer its own announcement forever.
    absorbed=0
    while [ "$absorbed" -lt 5 ]; do
      sleep 1.2
      # Ownership is re-checked HERE as well as at the top of the loop. The debounce
      # can hold this for six seconds, and an orphan that keeps announcing for six
      # seconds after being replaced is exactly the overlap the lock exists to prevent.
      [ "$(cat "$J/run/lock/pid" 2>/dev/null)" = "$$" ] || exit 0
      newest=""
      for g in "$Q"/[0-9]*; do
        [ -e "$g" ] || continue
        # -F is not optional: without it '|' is regex alternation, and the empty
        # trailing alternative matches every file.
        grep -qF "$mode|$name|" "$g" 2>/dev/null && newest="$g"
      done
      [ -z "$newest" ] && break
      nline=$(cat "$newest" 2>/dev/null)
      for g in "$Q"/[0-9]*; do
        [ -e "$g" ] || continue
        grep -qF "$mode|$name|" "$g" 2>/dev/null && rm -f "$g"
      done
      if [ -n "$nline" ]; then
        line="$nline"
        # shellcheck disable=SC2034
        IFS='|' read -r mode name extra born ord key summary <<< "$line"
      fi
      absorbed=$(( absorbed + 1 ))
    done
  fi

  render "$mode" "$name" "$extra" "$ord" "$summary"
done
