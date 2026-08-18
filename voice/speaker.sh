#!/bin/bash
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
Q="$J/queue"; S="$J/state"; SND=/System/Library/Sounds
mkdir -p "$Q" "$S/active" "$S/pending" 2>/dev/null

SIR="${JARVIS_ADDRESS:-sir}"; [ -n "$SIR" ] && SIR=", $SIR"

pick()    { local a=("$@"); printf '%s' "${a[$(( RANDOM % ${#a[@]} ))]}"; }
nactive() { ls "$S/active" 2>/dev/null | wc -l | tr -d ' '; }
speak()   { say -v "$JARVIS_VOICE" -r "$JARVIS_RATE" "$1" 2>/dev/null; }
banner()  { osascript -e "display notification \"$2\" with title \"J.A.R.V.I.S. - $1\"" >/dev/null 2>&1 & }

# ---------------------------------------------------------------------- CHIMES
#
# One percussive atom, pitch-sequenced into motifs. The first cut layered two
# different system sounds 160ms apart, which measurement showed was wrong three
# ways: Blow and Hero are 1.4s and 1.06s long with their energy in the SAME
# 300-1000Hz band, so a 160ms offset produced a sustained chord rather than two
# notes; Submarine and Basso were layered over themselves, which is comb filtering
# and sounds like a fault; and Tink+Pop are 34Hz apart in dominant pitch, close
# enough to beat against each other.
#
# Tink is the atom because it is the only genuinely percussive one: 0.04s of
# audible sound in a 0.56s file. Intervals over a single atom are exact, the timbre
# stays constant, and the motif shape — rising, falling, insistent — carries the
# meaning instead of an arbitrary pairing.
ATOM=Tink
DARK=Basso        # low and short. Falling + dark = unambiguously bad news.

# Everything is transposed up from here. At rate 1.0 Tink puts 95% of its energy in
# 300-1000Hz, exactly where a male voice's first two formants live, so the chime
# masked the vowels of the first word — usually the project name. At 1.55 that drops
# to 7%, and the atom is brighter, which also helps it carry over music.
BASE_RATE=1.55

# Session identity, as a transposition of the whole motif. Spread over eight
# semitones rather than the three the first cut used, since absolute pitch memory is
# poor and these are heard minutes apart. It is a secondary cue in any case — with
# two or more sessions live the name is spoken as well.
sfactor() {
  case $(( ${1:-1} % 4 )) in
    1) echo 1.00 ;;   # +0 semitones
    2) echo 1.12 ;;   # +2
    3) echo 1.26 ;;   # +4
    *) echo 1.41 ;;   # +6
  esac
}

# afplay silently does nothing outside 0.4-3.0, so the rate is clamped rather than
# left to fail without a sound and without an error. The chosen tables top out at
# 2.92, which is deliberate headroom under that ceiling.
rate() { awk -v b="$BASE_RATE" -v f="$1" -v n="$2" 'BEGIN{r=b*f*n; if(r<0.4)r=0.4; if(r>3)r=3; printf "%.3f", r}'; }

# Per-atom loudness correction, then a per-category multiplier. Measured RMS differs
# by 4.6x across the system sounds, so at one fixed volume the error chime came out
# QUIETER than the routine completion. afplay accepts a gain above 1.0, which is
# what makes matching them possible rather than only attenuating to the quietest.
vol() { awk -v v="${JARVIS_VOLUME:-0.7}" -v m="$1" 'BEGIN{x=v*m; if(x<0)x=0; if(x>2)x=2; printf "%.2f", x}'; }
DARK_GAIN=1.42    # Basso rms 0.0258 vs Tink 0.0367; peaks at 0.39, ample headroom

# tone <volume> <rate> <delay> [atom]
tone() {
  ( [ "$3" != "0" ] && sleep "$3"
    afplay -v "$1" -r "$2" "$SND/${4:-$ATOM}.aiff" 2>/dev/null ) &
}

# motif <kind> <ordinal>
#
# Ends by waiting out its own audible span, so speech starts AFTER the chime rather
# than underneath it. That costs about a third of a second and buys back the
# intelligibility of the first word.
motif() {
  local k="$1" f; f=$(sfactor "$2")
  case "$k" in
    done)                                  # rising fourth — resolved, positive
      tone "$(vol 1.0)"  "$(rate "$f" 1.000)" 0
      tone "$(vol 1.0)"  "$(rate "$f" 1.335)" 0.11
      sleep 0.30 ;;
    boot)                                  # rising arpeggio — powering up
      tone "$(vol 0.9)"  "$(rate "$f" 1.000)" 0
      tone "$(vol 0.9)"  "$(rate "$f" 1.260)" 0.10
      tone "$(vol 0.9)"  "$(rate "$f" 1.335)" 0.20
      sleep 0.40 ;;
    approve)                               # three insistent taps — rhythm, not pitch,
      tone "$(vol 1.25)" "$(rate "$f" 1.260)" 0     # so it reads as "attention"
      tone "$(vol 1.25)" "$(rate "$f" 1.260)" 0.13  # rather than as a notification
      tone "$(vol 1.25)" "$(rate "$f" 1.260)" 0.26
      sleep 0.42 ;;
    nag)                                   # the same figure, tighter and higher
      tone "$(vol 1.3)"  "$(rate "$f" 1.335)" 0
      tone "$(vol 1.3)"  "$(rate "$f" 1.335)" 0.10
      tone "$(vol 1.3)"  "$(rate "$f" 1.335)" 0.20
      sleep 0.36 ;;
    err)                                   # falling fifth, dark atom
      tone "$(vol "$(awk -v g=$DARK_GAIN 'BEGIN{printf "%.2f", 1.35*g}')")" 1.19 0    "$DARK"
      tone "$(vol "$(awk -v g=$DARK_GAIN 'BEGIN{printf "%.2f", 1.35*g}')")" 0.84 0.16 "$DARK"
      sleep 0.50 ;;
    idle)                                  # two soft taps — waiting, not urgent
      tone "$(vol 0.6)"  "$(rate "$f" 1.000)" 0
      tone "$(vol 0.6)"  "$(rate "$f" 1.000)" 0.14
      sleep 0.32 ;;
    tick)                                  # one quiet tap. A whole turn, in 40ms
      tone "$(vol 0.45)" "$(rate "$f" 1.335)" 0 ;;
    sub)                                   # background work: quiet, and a note BELOW
      # the tick so the two are not confused. It was 1.680, which at ordinals 3 and
      # 4 multiplied past afplay's 3.0 ceiling and clamped — silently collapsing two
      # sessions onto one identical tone. Every ratio here must survive the widest
      # session transposition (x1.41) without reaching the clamp.
      tone "$(vol 0.35)" "$(rate "$f" 1.190)" 0 ;;
    bye)                                   # falling arpeggio — powering down
      tone "$(vol 0.8)"  "$(rate "$f" 1.335)" 0
      tone "$(vol 0.8)"  "$(rate "$f" 1.260)" 0.10
      tone "$(vol 0.8)"  "$(rate "$f" 1.000)" 0.20
      sleep 0.42 ;;
  esac
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

# render <mode> <name> <extra> <ordinal>
render() {
  local mode="$1" name="$2" extra="$3" ord="$4"

  # One line per announcement. This is what `jarvisctl log` shows and what the
  # concurrency tests assert against — the behaviour that matters is unobservable
  # otherwise, since the output is sound.
  printf '%s %-8s %-20s %s\n' "$(date +%H:%M:%S)" "$mode" "$name" "${extra:-—}" >> "$J/log" 2>/dev/null
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
      motif done "$ord"
      if [ "$solo" = 1 ]; then
        speak "$(pick "Done$SIR.$crew $(dur "$el")." \
                      "Finished$SIR.$crew $(dur "$el")." \
                      "All done$SIR.$crew $(dur "$el").")"
      else
        speak "$(pick "$who done$SIR.$crew $(dur "$el")." \
                      "$who finished.$crew $(dur "$el")." \
                      "$who, all done.$crew $(dur "$el").")"
      fi
      banner "$name" "Complete - $(dur "$el")${crew:+ -$crew}" ;;

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
      # Only worth saying when the last one goes out. Per-session goodbyes with
      # four sessions open is four goodbyes for nothing.
      [ "$(nactive)" -eq 0 ] && { motif bye 1; speak "Goodbye$SIR."; } ;;
  esac
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
    IFS='|' read -r ts nm n < "$f"
    case "$ts" in ''|*[!0-9]*) continue ;; esac
    case "$n"  in ''|*[!0-9]*) n=0 ;; esac
    age=$(( now - ts ))
    if [ "$age" -ge $(( ${JARVIS_NAG_AFTER:-70} * (n + 1) )) ] && [ "$n" -lt "${JARVIS_NAG:-2}" ]; then
      printf '%s|%s|%s\n' "$ts" "$nm" "$(( n + 1 ))" > "$f"
      ord=1
      [ -e "$S/active/$(basename "$f")" ] && { read -r line < "$S/active/$(basename "$f")"; ord=${line##*|}; }
      printf 'nag|%s||%s|%s|%s\n' "$nm" "$now" "$ord" "$(basename "$f")" > "$Q/1-$now-$$-$RANDOM"
    fi
  done
}

# Sourced as a library (JARVIS_LIB=1) the file stops here, exposing motif(), rate(),
# vol(), spoken() and dur() for testing. A rate outside afplay's 0.4-3.0 window
# produces no sound AND no error, so it has to be asserted rather than heard.
[ "${JARVIS_LIB:-0}" = "1" ] && return 0

# Lifecycle ledger. A duplicate daemon is the failure this lock exists to prevent,
# and a point-in-time `ps` count misses one that starts and dies between samples —
# so every daemon records its own birth and death and the test counts births.
ledger() { printf '%s %s %s\n' "$(date +%s)" "$$" "$1" >> "$J/run/daemons.log" 2>/dev/null; }
cleanup() {
  [ "$(cat "$J/run/lock/pid" 2>/dev/null)" = "$$" ] && rm -rf "$J/run/lock"
  ledger exit
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

  f=$(ls "$Q" 2>/dev/null | grep -v '^\.' | sort | head -1)
  if [ -z "$f" ]; then
    idle_ticks=$(( idle_ticks + 1 ))
    [ $(( idle_ticks % 20 )) -eq 0 ] && check_nags
    [ "$idle_ticks" -gt 240 ] && break     # ~2 min quiet, then exit
    sleep 0.5; continue
  fi
  idle_ticks=0

  # Claim atomically. `cat` then `rm` let two readers take the same entry and
  # announce it twice; `mv` cannot, and losing the race is a clean skip.
  claim="$Q/.claim.$$"
  mv "$Q/$f" "$claim" 2>/dev/null || continue
  line=$(cat "$claim" 2>/dev/null); rm -f "$claim"
  [ -z "$line" ] && continue
  IFS='|' read -r mode name extra born ord key <<< "$line"

  pri=${f%%-*}
  case "$born" in ''|*[!0-9]*) born=0 ;; esac
  age=$(( $(date +%s) - born ))

  if [ "$pri" -ge 4 ]; then
    [ "$age" -gt "${JARVIS_STALE:-50}" ] && continue
    sleep 1.2                              # let a burst arrive, then collapse it

    # Collapse the burst in ONE pass. Six completions from one session must become
    # one announcement — but dropping this entry and letting the loop re-debounce
    # each of the other five costs 1.2s apiece, so the announcement lands seven
    # seconds after the work finished. Instead: take the NEWEST duplicate (its
    # elapsed time is the accurate one), delete the whole set, and speak once.
    #
    # -F is not optional. Without it the '|' is regex alternation and the empty
    # trailing alternative matches every file, which silently suppressed nearly
    # every announcement.
    newest=""
    for g in "$Q"/[0-9]*; do
      [ -e "$g" ] || continue
      grep -qF "$mode|$name|" "$g" 2>/dev/null && newest="$g"
    done
    if [ -n "$newest" ]; then
      nline=$(cat "$newest" 2>/dev/null)
      for g in "$Q"/[0-9]*; do
        [ -e "$g" ] || continue
        grep -qF "$mode|$name|" "$g" 2>/dev/null && rm -f "$g"
      done
      if [ -n "$nline" ]; then
        line="$nline"
        IFS='|' read -r mode name extra born ord key <<< "$line"
      fi
    fi
  fi

  render "$mode" "$name" "$extra" "$ord"
done
