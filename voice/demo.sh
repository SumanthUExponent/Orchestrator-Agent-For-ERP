#!/usr/bin/env bash
# A narrated simulation of a full working session across four parallel Claude Code
# sessions. Every event goes through the real hook and the real daemon — nothing is
# faked except the wall-clock, which is compressed: elapsed times are written
# directly into the state so a "four minute turn" does not take four minutes, and the
# nag interval is shortened so the reminder lands inside the demo rather than 70s
# after it.
#
# It exists because the individual behaviours are each verifiable in isolation but
# the SYSTEM is not: whether four sessions are distinguishable, whether the priority
# ordering reads correctly when things arrive together, and whether the whole thing
# is pleasant for ten minutes rather than merely correct once. That is a judgement
# only a person with speakers can make, and they need to hear it end to end to make
# it.
#
# Usage: jarvisctl demo        (or voice/demo.sh)

set -u
# JARVIS_DIR, with the historical name as a fallback. The installer has always
# honoured this variable; the runtime scripts did not, so an install anywhere but
# the default silently found no config.sh, no tones and no state -- and said
# nothing about it, because every lookup is guarded. CI installs to a temp dir,
# which is how an audition that rendered ": . 4 minutes." got past a ceiling check.
J="${JARVIS_DIR:-${CLAUDE_JARVIS_DIR:-$HOME/.claude/jarvis}}"; S="$J/state"
[ -f "$J/config.sh" ] && . "$J/config.sh"

# Shortened so the reminder arrives during the demo. The daemon inherits this from
# the environment because config.sh assigns with :- defaults.
export JARVIS_NAG_AFTER=14
export JARVIS_NAG=2
export JARVIS_NAMES="${JARVIS_NAMES:-wt_svc=N S T;billing=C R M}"

step=0
narrate() {
  step=$((step+1))
  printf '\n\033[1m%2d.\033[0m \033[36m%s\033[0m\n' "$step" "$1"
  [ -n "${2:-}" ] && printf '    \033[2m%s\033[0m\n' "$2"
  return 0
}
listen() { printf '    \033[2m-> expect: %s\033[0m\n' "$1"; }

# hook <key> <name> <mode>
hook() { JARVIS_SESSION_KEY="$1" JARVIS_SESSION_NAME="$2" "$J/jarvis.sh" "$3" </dev/null; }
# Pretend a turn has been running for N seconds, and that it dispatched M specialists.
elapsed() { echo $(( $(date +%s) - $2 )) > "$S/start/$1"; [ -n "${3:-}" ] && echo "$3" > "$S/subs/$1"; return 0; }
settle() {  # wait for the queue to drain, then let the last utterance finish
  local n=0
  while [ "$n" -lt 60 ]; do
    # Glob rather than `ls | grep`: queue entries start with the priority digit and
    # claims start with a dot, so the pattern excludes claims by construction.
    empty=1
    for g in "$J"/queue/[0-9]*; do [ -e "$g" ] && { empty=0; break; }; done
    [ "$empty" = 1 ] && break
    sleep 1; n=$((n+1))
  done
  sleep "${1:-3}"
}

trap 'echo; echo "interrupted — cleaning up"; "$J/jarvisctl" reset >/dev/null 2>&1; exit 130' INT

cat <<INTRO

  J.A.R.V.I.S. — full simulation
  ==============================
  Four parallel sessions, played through the real hooks and the real daemon.
  Roughly two and a half minutes. Turn the volume to where you would normally
  have it, and if you usually work with music on, put the music on.

  Listen for four things:
    1. can you tell the four sessions apart by their chime pitch alone
    2. does the urgent alert cut in front of the routine ones
    3. does anything ever talk over anything else
    4. would you still want this on after ten minutes

INTRO
sleep 2
# Stop any running daemon through the pid it recorded in its own lock. `pkill` is in
# procps, which minimal Linux images and Git Bash do not always ship.
dp=$(cat "$J/run/lock/pid" 2>/dev/null); [ -n "$dp" ] && kill "$dp" 2>/dev/null
"$J/jarvisctl" reset >/dev/null 2>&1
sleep 1

# ---------------------------------------------------------------- morning
narrate "09:04 — you open four sessions, one after another" \
        "Each greeting names its own project and is pitched two semitones above the last."
listen "four rising arpeggios, ascending in pitch, four different project names"
hook d1 checkout start; sleep 4
hook d2 wt_svc       start; sleep 4
hook d3 billing       start; sleep 4
hook d4 shared_lib start
settle 2

# ---------------------------------------------------------------- short turn
narrate "You ask checkout a three-second question" \
        "Stop fires after EVERY turn. Under 25 seconds it is not worth a sentence."
listen "one quiet tick. No speech at all"
hook d1 checkout begin; sleep 3; hook d1 checkout 'done'
settle 2

# ---------------------------------------------------------------- swarm
narrate "wt_svc dispatches a swarm; six specialists report back over two seconds" \
        "SubagentStop fires once each. Six announcements would be intolerable, so they chime and are counted."
listen "ONE soft low tick, not six"
hook d2 wt_svc begin
for i in 1 2 3 4 5 6; do hook d2 wt_svc subagent; sleep 0.3; done
settle 2

narrate "…and the swarm turn completes, four minutes in" \
        "The specialist count is what distinguishes a swarm run from a one-line edit."
listen "rising two-note chime, then \"N S T done, sir. Six specialists, four minutes.\""
elapsed d2 245 6
hook d2 wt_svc 'done'
settle 2

# ---------------------------------------------------------------- the expensive failure
narrate "billing hits a permission prompt while the other three keep working" \
        "This is the failure the whole thing exists for: a session blocked in silence."
listen "three insistent taps — a different rhythm entirely — then \"C R M needs your approval, sir.\""
hook d3 billing permission
settle 2

narrate "Two other sessions finish at the same instant" \
        "One daemon holds the lock, so these serialise instead of talking over each other."
listen "two completions, one after the other, never overlapping"
elapsed d1 210 0
elapsed d4 380 3
hook d1 checkout 'done'
hook d4 shared_lib 'done'
settle 2

narrate "You still have not answered billing" \
        "Nothing fires when a permission prompt goes unanswered, so the daemon re-checks on its own."
listen "the taps return, tighter and higher: \"C R M is still waiting, sir.\""
sleep 16
settle 2

# ---------------------------------------------------------------- coalescing
narrate "shared_lib finishes six turns in two seconds" \
        "A burst is debounced, then collapsed to the newest — its elapsed time is the accurate one."
listen "ONE completion, not six"
for i in 1 2 3 4 5 6; do elapsed d4 $(( 90 + i * 10 )) 0; hook d4 shared_lib 'done'; sleep 0.3; done
settle 2

# ---------------------------------------------------------------- bad news
narrate "An API error ends a turn in checkout" \
        "StopFailure, not a failed tool call. Low, falling, on a darker instrument."
listen "a descending two-note thud, louder than the rest: \"checkout svc has a problem, sir.\""
hook d1 checkout error
settle 2

# ---------------------------------------------------------------- mute
narrate "You go into a meeting: mute for one minute, and an error arrives" \
        "The hook drops it, and the daemon drops anything already queued — including its own nags."
listen "complete silence for the next few seconds"
before=$(grep -c '' "$J/log" 2>/dev/null | tr -d ' '); before=${before:-0}
"$J/jarvisctl" mute 1 >/dev/null
hook d2 wt_svc error
hook d3 billing permission
sleep 8
after=$(grep -c '' "$J/log" 2>/dev/null | tr -d ' '); after=${after:-0}
printf '    \033[2mannounced during the mute: %s (must be 0)\033[0m\n' "$(( after - before ))"
"$J/jarvisctl" unmute >/dev/null
narrate "Meeting over, unmuted" "Nothing is replayed — a stale alert is noise, not information."
listen "still silence: the muted items were discarded, not deferred"
settle 2

# ---------------------------------------------------------------- idle
narrate "You walk away and leave a session waiting for input"
listen "two soft taps: \"…standing by, sir.\""
hook d2 wt_svc idle
settle 2

# ---------------------------------------------------------------- shutdown
narrate "18:30 — you close all four sessions at once" \
        "Four SessionEnd events, but only one farewell: a per-session goodbye would be four goodbyes."
listen "silence, then ONE falling arpeggio: \"Goodbye, sir.\""
hook d1 checkout end; hook d2 wt_svc end; hook d3 billing end; hook d4 shared_lib end
settle 4

# ---------------------------------------------------------------- summary
echo
echo "  ------------------------------------------------------------------"
echo "  What was announced, in order:"
"$J/jarvisctl" log 40 | sed 's/^/    /'
echo
echo "  Daemons started during the whole simulation: $(grep -c ' start$' "$J/run/daemons.log" 2>/dev/null || echo 0)  (must be 1)"
echo "  Goodbyes spoken: $(grep -c ' bye ' "$J/log" 2>/dev/null || echo 0)  (must be 1)"
echo "  ------------------------------------------------------------------"
echo
echo "  Now the part no test can answer. Which of these sounded wrong?"
echo "    - could you tell the four sessions apart"
echo "    - did the approval alert stand out from the completions"
echo "    - was anything too loud, too quiet, too long, or too frequent"
echo "    - would you leave this on all day"
echo
echo "  Motif tables: top of ~/.claude/jarvis/speaker.sh   Tunables: config.sh"
echo
"$J/jarvisctl" reset >/dev/null 2>&1
