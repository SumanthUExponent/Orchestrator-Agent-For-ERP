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

SIR="${JARVIS_ADDRESS:-sir}"; [ -n "$SIR" ] && SIR=", $SIR"

pick()    { local a=("$@"); printf '%s' "${a[$(( RANDOM % ${#a[@]} ))]}"; }
nactive() { ls "$S/active" 2>/dev/null | wc -l | tr -d ' '; }
speak()   { say -v "$JARVIS_VOICE" -r "$JARVIS_RATE" "$1" 2>/dev/null; }
banner()  { osascript -e "display notification \"$2\" with title \"J.A.R.V.I.S. - $1\"" >/dev/null 2>&1 & }

# Stable per-session pitch, from the ordinal the hook assigned in start order.
# Hashing the path instead lets two sessions collide on the same tone, which
# defeats the point: the pitch is how you know WHICH session before the sentence
# gets there.
pitch() {
  case $(( ${1:-1} % 4 )) in
    1) echo 0.94 ;; 2) echo 1.00 ;; 3) echo 1.07 ;; *) echo 1.14 ;;
  esac
}

# Two tones, 160ms apart, at the session's pitch. Backgrounded so the chime
# overlaps the start of the speech rather than delaying it.
chime() {
  ( afplay -v "${JARVIS_VOLUME:-0.7}" -r "$3" "$SND/$1.aiff" 2>/dev/null &
    sleep 0.16
    afplay -v "${JARVIS_VOLUME:-0.7}" -r "$3" "$SND/$2.aiff" 2>/dev/null ) &
}

plural() { [ "$1" = "1" ] && printf '%s' "$2" || printf '%s' "$2s"; }

dur() {
  local s=${1:-0}
  if   [ "$s" -lt 90 ];   then echo "$s $(plural "$s" second)"
  elif [ "$s" -lt 5400 ]; then echo "$((s/60)) $(plural "$((s/60))" minute)"
  else echo "$((s/3600)) $(plural "$((s/3600))" hour)"; fi
}

# render <mode> <name> <extra> <ordinal>
render() {
  local mode="$1" name="$2" extra="$3" ord="$4"
  local r; r=$(pitch "$ord")
  # One line per announcement. This is what `jarvisctl log` shows and what the
  # concurrency tests assert against — the behaviour that matters is unobservable
  # otherwise, since the output is sound.
  printf '%s %-8s %-20s %s\n' "$(date +%H:%M:%S)" "$mode" "$name" "${extra:-—}" >> "$J/log" 2>/dev/null
  [ "$(wc -l < "$J/log" 2>/dev/null || echo 0)" -gt 500 ] && { tail -200 "$J/log" > "$J/log.t" 2>/dev/null && mv "$J/log.t" "$J/log"; }
  # Name the project only when it earns its place. With one session running,
  # "Watchtower, finished" is noise; with four it is the whole message.
  local multi=""; [ "$(nactive)" -gt 1 ] && multi="$name, "

  case "$mode" in
    boot)
      local h g; h=$(date +%H)
      if   [ "$h" -lt 12 ]; then g="Good morning"
      elif [ "$h" -lt 18 ]; then g="Good afternoon"
      else g="Good evening"; fi
      chime Blow Hero "$r"
      speak "$g$SIR. [[slnc 250]] $name is online. Standing by." ;;

    tick) chime Tink Pop "$r" ;;

    done)
      local el=${extra%%:*} subs=${extra##*:}
      case "$subs" in ''|*[!0-9]*) subs=0 ;; esac
      # A swarm run and a one-line edit both end in Stop. The specialist count is
      # the only thing in the announcement that distinguishes them.
      local crew=""
      [ "$subs" -ge 2 ] && crew=" $subs specialists,"
      chime Blow Hero "$r"
      speak "$(pick "${multi}task complete$SIR. [[slnc 200]]$crew $(dur "$el")." \
                    "${multi}all done in$crew $(dur "$el")$SIR. The floor is yours." \
                    "${multi}finished$SIR. [[slnc 200]]$crew $(dur "$el") on the clock." \
                    "${multi}that's everything$SIR.$crew $(dur "$el").")"
      banner "$name" "Complete - $(dur "$el")${crew:+ -$crew}" ;;

    approve)
      chime Submarine Submarine "$r"
      speak "$(pick "${multi}authorization required$SIR." \
                    "${multi}I need your approval before proceeding$SIR." \
                    "${multi}holding for clearance$SIR.")"
      banner "$name" "Approval required" ;;

    nag)
      chime Submarine Submarine "$r"
      speak "$(pick "$name is still waiting on you$SIR." \
                    "Still blocked on $name$SIR. [[slnc 200]] When you have a moment." \
                    "$name has not moved$SIR. It needs your clearance.")" ;;

    idle)
      chime Ping Ping "$r"
      speak "$(pick "${multi}awaiting your instruction$SIR." \
                    "${multi}standing by$SIR." \
                    "Whenever you're ready$SIR.")" ;;

    sub) chime Glass Glass "$r" ;;

    subspeak)
      chime Glass Glass "$r"
      speak "$(pick "${multi}specialist $extra has reported back." \
                    "${multi}subroutine $extra complete.")" ;;

    err)
      chime Basso Basso "$r"
      speak "$(pick "${multi}we've hit a problem$SIR." \
                    "${multi}error encountered$SIR. Your attention, please." \
                    "Something's gone wrong in $name$SIR.")"
      banner "$name" "Error" ;;

    bye)
      # Only worth saying when the last one goes out. Per-session goodbyes with
      # four sessions open is four goodbyes for nothing.
      [ "$(nactive)" -eq 0 ] && { chime Hero Blow 0.9; speak "All sessions closed. Goodbye$SIR."; } ;;
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
