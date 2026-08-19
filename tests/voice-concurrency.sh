#!/usr/bin/env bash
# Concurrency harness for the voice layer.
#
# The interesting failures here are invisible to a unit test and inaudible to one
# person at one keyboard: a duplicate daemon, a queue entry claimed twice, a
# coalescing check that matches everything. They only appear under genuine
# parallel load, so this drives the real scripts with the audio tools stubbed.
#
# `say` is stubbed to log START, hold 1.2s, then log END. That is what makes
# overlapping speech — the failure this whole architecture exists to prevent —
# detectable rather than a matter of opinion.
#
# Usage: tests/voice-concurrency.sh [-v]

set -u
VERBOSE=0; [ "${1:-}" = "-v" ] && VERBOSE=1
REPO="$(cd "$(dirname "$0")/.." && pwd)"

SB=$(mktemp -d /tmp/jarvis-test-XXXXXX)
export HOME="$SB/home"
J="$HOME/.claude/jarvis"
mkdir -p "$J" "$SB/bin"

# Install through the REAL installer rather than copying files by hand. Hand-copying
# missed platform.sh and the generated tones the moment those were introduced, and the
# harness would have gone on testing an install nobody ships.
export CLAUDE_JARVIS_DIR="$J"
export CLAUDE_SETTINGS_FILE="$SB/settings.json"
echo '{}' > "$CLAUDE_SETTINGS_FILE"
node "$REPO/scripts/jarvis.mjs" voice --apply >/dev/null 2>&1 || { echo "install failed"; exit 1; }

AUDIT="$SB/audit.log"
: > "$AUDIT"

# Sub-second timestamps, and every obvious source is missing somewhere: macOS `date`
# has no %N, $EPOCHREALTIME needs bash 5 which macOS does not ship, and perl is absent
# from minimal Linux images. Try each in turn and fall back to whole seconds — the
# overlap check needs ordering, not precision, so a coarser clock still answers it.
cat > "$SB/bin/now" <<'STUB'
#!/usr/bin/env bash
if [ -n "${EPOCHREALTIME:-}" ]; then printf '%s\n' "${EPOCHREALTIME/,/.}"; exit 0; fi
if command -v perl >/dev/null 2>&1; then perl -MTime::HiRes -e 'printf "%.3f\n", Time::HiRes::time()'; exit 0; fi
if command -v python3 >/dev/null 2>&1; then python3 -c 'import time;print("%.3f"%time.time())'; exit 0; fi
n=$(date +%N 2>/dev/null)
case "$n" in ''|*[!0-9]*|N) printf '%s.000\n' "$(date +%s)" ;; *) printf '%s.%s\n' "$(date +%s)" "${n:0:3}" ;; esac
STUB

# Stub EVERY backend the platform layer might select, not just the macOS ones. The
# first version stubbed `say` and `afplay`; on Linux the layer correctly dispatched to
# espeak-ng and paplay instead, which were not stubbed — so nothing was captured and
# every assertion counted zero utterances while the code underneath was working.
#
# Speech stubs BLOCK for 1.2s. That is what makes overlapping speech detectable: the
# whole architecture exists to prevent it, and without a duration there is nothing to
# overlap.
for t in say espeak-ng espeak spd-say festival pico2wave; do
  cat > "$SB/bin/$t" <<STUB
#!/usr/bin/env bash
echo "\$($SB/bin/now) SAY_START \$*" >> $AUDIT
sleep 1.2
echo "\$($SB/bin/now) SAY_END" >> $AUDIT
STUB
done

for t in afplay paplay aplay ffplay mpv play cvlc; do
  cat > "$SB/bin/$t" <<STUB
#!/usr/bin/env bash
echo "\$($SB/bin/now) AFPLAY \$*" >> $AUDIT
sleep 0.2
STUB
done

for t in osascript notify-send; do
  cat > "$SB/bin/$t" <<STUB
#!/usr/bin/env bash
echo "\$($SB/bin/now) BANNER \$*" >> $AUDIT
STUB
done

chmod +x "$SB/bin"/*
export PATH="$SB/bin:$PATH"

PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); printf '  \033[32mPASS\033[0m %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); printf '  \033[31mFAIL\033[0m %s\n' "$1"; [ -n "${2:-}" ] && printf '        %s\n' "$2"; }
check() { if [ "$1" = 0 ]; then ok "$2"; else bad "$2" "${3:-}"; fi; }

hook()    { local k="$1" n="$2" m="$3"; JARVIS_SESSION_KEY="$k" JARVIS_SESSION_NAME="$n" "$J/jarvis.sh" "$m" </dev/null; }
# Count daemon BIRTHS from the ledger, not live processes from ps. `ps -eo args`
# matches any other process whose command line happens to contain the pattern —
# including the harness itself under some shells — and a point-in-time sample also
# misses a duplicate that spawns and exits between checks. Births cannot be missed.
LEDGER="$J/run/daemons.log"
Q_SEED="$J/queue"
mkdir -p "$J/run"; : > "$LEDGER"
births() { local n; n=$(grep -c ' start$' "$LEDGER" 2>/dev/null); echo "${n:-0}"; }
live()   { local b e; b=$(births); e=$(grep -c ' exit$' "$LEDGER" 2>/dev/null); echo $(( b - ${e:-0} )); }
# grep -c always prints a number, but exits 1 when the count is zero. The obvious
# `|| echo 0` therefore appends a SECOND zero on the quiet path, and every
# arithmetic test downstream then fails on "0\n0" rather than on the behaviour.
says()    { local n; n=$(grep -c 'SAY_START' "$AUDIT" 2>/dev/null); echo "${n:-0}"; }
chimes()  { local n; n=$(grep -c 'AFPLAY'    "$AUDIT" 2>/dev/null); echo "${n:-0}"; }
# An empty queue does NOT mean the daemon is finished: the item has been claimed and
# is inside its debounce and its speech. Fixed sleeps here made every assertion a
# coin flip once the trailing debounce added over a second to each announcement.
quiet() {
  local n=0
  while [ "$n" -lt "${1:-30}" ]; do
    empty=1
    for g in "$J"/queue/[0-9]*; do [ -e "$g" ] && { empty=0; break; }; done
    [ "$empty" = 1 ] && sleep 4 && return 0
    sleep 0.5; n=$((n+1))
  done
  return 1
}
# wait_for <pattern> <file> [secs] — poll for something to actually happen.
# Fire a hook with a JSON payload, the way Claude Code delivers one.
say_hook() { printf '%s' "$2" | JARVIS_SESSION_KEY=s1 JARVIS_SESSION_NAME=alpha "$J/jarvis.sh" "$1" >/dev/null 2>&1; }
wait_for() {
  local pat="$1" f="$2" lim="${3:-25}" n=0
  while [ "$n" -lt "$lim" ]; do
    grep -qF "$pat" "$f" 2>/dev/null && return 0
    sleep 0.5; n=$((n+1))
  done
  return 1
}
# pkill is in procps, which minimal Linux images and Git Bash do not always ship. The
# lock records the daemon's own pid, so asking it is both more portable and more precise
# than matching a command line.
stop_daemon() {
  local p; p=$(cat "$J/run/lock/pid" 2>/dev/null)
  [ -n "$p" ] && kill "$p" 2>/dev/null
  command -v pkill >/dev/null 2>&1 && pkill -f 'jarvis/speaker.sh' 2>/dev/null
  return 0
}

fresh() {
  mkdir -p "$J/run"
  stop_daemon
  # Wait for the death to be RECORDED, not merely requested. bash defers a trap
  # until the current foreground command returns, so a daemon sitting in its
  # `sleep 0.5` poll writes its exit line up to half a second after the signal.
  # Truncating the ledger before that lands leaves an exit with no matching start,
  # and every live() reading for the rest of the run is off by one — which is
  # what made T6 report a negative number of daemons.
  local i=0
  while [ "$(live)" -gt 0 ] && [ "$i" -lt 20 ]; do sleep 0.2; i=$((i+1)); done
  "$J/jarvisctl" reset >/dev/null 2>&1
  : > "$AUDIT"; : > "$LEDGER"
}

# Speech must never overlap. With one drainer calling `say` synchronously this can
# only break if a second daemon exists, which is exactly what it is here to catch.
no_overlap() {
  awk '/SAY_START/{ if (open) { print "OVERLAP at " $1; bad=1 } open=1 }
       /SAY_END/{ open=0 }
       END{ exit bad?1:0 }' "$AUDIT"
}

echo "JARVIS concurrency harness"
echo "sandbox: $SB"
echo

# ---------------------------------------------------------------- T1
echo "T1  four sessions fire at once (2 boots, 1 approval, 1 error)"
fresh
hook s1 alpha   start      &
hook s2 bravo   start      &
hook s3 charlie permission &
hook s4 delta   error      &
wait
sleep 1
rc=0; d=$(births); [ "$d" = 1 ] || rc=1; check "$rc" "exactly one speaker daemon was ever started (saw $d)"
quiet 40
rc=0; no_overlap || rc=1; check "$rc" "no overlapping speech" "$(grep OVERLAP "$AUDIT" 2>/dev/null)"
rc=0; [ "$(says)" -ge 3 ] || rc=1; check "$rc" "all four sessions announced ($(says) utterances)"

echo
echo "T1b urgent items are spoken before routine ones"
# Priority only orders what is in the queue TOGETHER. Firing four hooks in parallel
# and asserting on the first utterance was a race: whichever hook won the spawn could
# have its own item claimed before the others were enqueued, so a boot legitimately
# came first. Seed the queue, THEN let the daemon in — which is the situation the
# priority prefix actually exists for.
fresh
now=$(date +%s)
printf 'boot|alpha|||1|s1\n'      > "$Q_SEED/4-$now-a-1"
printf 'boot|bravo|||2|s2\n'      > "$Q_SEED/4-$now-a-2"
printf 'approve|charlie|||3|s3\n' > "$Q_SEED/0-$now-a-3"
printf 'err|delta|||4|s4\n'       > "$Q_SEED/0-$now-a-4"
mkdir -p "$J/run"
mkdir "$J/run/lock" 2>/dev/null && nohup "$J/speaker.sh" >/dev/null 2>&1 &
wait_for SAY_START "$AUDIT" 30
# Assert on the render LOG, which records the MODE, not on the words. Matching spoken
# text is brittle for two reasons already hit: the phrasing gets shortened, and the
# solo register capitalises the opening word, so a lowercase pattern silently missed
# the very item it was checking for.
first=$(awk 'NR==1{print $2}' "$J/log" 2>/dev/null)
case "$first" in
  approve|err) ok "an urgent item was rendered first (was: $first)" ;;
  *) bad "an urgent item was rendered first" "first was: ${first:-nothing}; log: $(cat "$J/log" 2>/dev/null | tr '\n' ' ')" ;;
esac
quiet 40

# ---------------------------------------------------------------- T2
echo
echo "T2  six rapid completions from one session"
fresh
echo $(( $(date +%s) - 200 )) > "$HOME/.claude/jarvis/state/start/s1"
printf 'alpha|1\n' > "$HOME/.claude/jarvis/state/active/s1"
for i in 1 2 3 4 5 6; do
  echo $(( $(date +%s) - 200 )) > "$HOME/.claude/jarvis/state/start/s1"
  hook s1 alpha 'done'
done
quiet 40
rc=0; n=$(says); [ "$n" = 1 ] || rc=1; check "$rc" "collapsed to exactly one announcement (got $n)"

# ---------------------------------------------------------------- T2b
echo
echo "T2b a burst SPREAD OVER TIME also collapses to one"
fresh
printf 'alpha|1\n' > "$HOME/.claude/jarvis/state/active/s1"
# T2 fired all six at once, which fits inside a single debounce window and therefore
# never exercised the edge. Spaced 0.3s apart they straddle it: with a fixed one-shot
# wait this produced two announcements, and six subagent events produced two chimes.
# Only the end-to-end simulation surfaced it.
for i in 1 2 3 4 5 6; do
  echo $(( $(date +%s) - 200 )) > "$HOME/.claude/jarvis/state/start/s1"
  hook s1 alpha 'done'
  sleep 0.3
done
quiet 40
rc=0; n=$(says); [ "$n" = 1 ] || rc=1; check "$rc" "a staggered burst is still one announcement (got $n)"

echo
echo "T2c six subagents 0.3s apart are one chime"
fresh
printf 'alpha|1\n' > "$HOME/.claude/jarvis/state/active/s1"
hook s1 alpha begin
for i in 1 2 3 4 5 6; do hook s1 alpha subagent; sleep 0.3; done
quiet 40
rc=0; n=$(chimes); [ "$n" = 1 ] || rc=1; check "$rc" "one tone for the whole batch (got $n)"

# ---------------------------------------------------------------- T3
echo
echo "T3  a two-second turn"
fresh
printf 'alpha|1\n' > "$HOME/.claude/jarvis/state/active/s1"
hook s1 alpha begin
sleep 2
hook s1 alpha 'done'
quiet 20
rc=0; n=$(says); [ "$n" = 0 ] || rc=1; check "$rc" "no speech for a short turn ($n utterances)"
rc=0; [ "$(chimes)" -ge 1 ] || rc=1; check "$rc" "but it still ticked ($(chimes) chimes)"

# ---------------------------------------------------------------- T4
echo
echo "T4  muted"
fresh
"$J/jarvisctl" mute 5 >/dev/null
hook s1 alpha error
hook s1 alpha permission
sleep 3
rc=0; n=$(( $(says) + $(chimes) )); [ "$n" = 0 ] || rc=1; check "$rc" "silent while muted ($n audio events)"
"$J/jarvisctl" unmute >/dev/null

# ---------------------------------------------------------------- T5
echo
echo "T5  status reports a blocked session"
fresh
hook s1 alpha start
hook s2 bravo start
hook s2 bravo permission
# Capture once, then match. Piping straight into `grep -q` closes the pipe as soon as
# it matches, so the writer takes EPIPE and bash prints "write error: Broken pipe" —
# harmless, but it is noise in every CI log for a test that passed.
st_out=$("$J/jarvisctl" status 2>/dev/null)
rc=0; printf '%s\n' "$st_out" | grep -q 'BLOCKED ON APPROVAL' || rc=1; check "$rc" "status names the blocked session"
rc=0; printf '%s\n' "$st_out" | grep -q 'bravo' || rc=1; check "$rc" "and names which one it is"
quiet 40

# ---------------------------------------------------------------- T6
echo
echo "T6  orphaned daemon stands down"
fresh
hook s1 alpha start
sleep 1
rc=0; [ "$(live)" -ge 1 ] || rc=1; check "$rc" "a daemon is running"
rm -rf "$J/run/lock"
sleep 2
rc=0; n=$(live); [ "$n" = 0 ] || rc=1; check "$rc" "it exited on its own after losing the lock ($n still live)"

# ---------------------------------------------------------------- T7
echo
echo "T7  a swarm run: six specialists, then completion"
fresh
printf 'alpha|1\n' > "$HOME/.claude/jarvis/state/active/s1"
hook s1 alpha begin
for i in 1 2 3 4 5 6; do hook s1 alpha subagent; done
echo $(( $(date +%s) - 200 )) > "$HOME/.claude/jarvis/state/start/s1"
hook s1 alpha 'done'
quiet 40
rc=0; grep -q '6 specialists' "$AUDIT" || rc=1; check "$rc" "the completion names the specialist count" "$(grep SAY_START "$AUDIT" | tail -1)"
rc=0; n=$(says); [ "$n" -le 2 ] || rc=1; check "$rc" "six subagent events did not become six announcements (got $n)"

# ---------------------------------------------------------------- T8
echo
echo "T8  two sessions in the SAME directory"
fresh
printf '{"session_id":"aaaaaaaa-1111-2222-3333-444444444444"}' | "$J/jarvis.sh" start >/dev/null
printf '{"session_id":"bbbbbbbb-5555-6666-7777-888888888888"}' | "$J/jarvis.sh" start >/dev/null
n=$(ls "$HOME/.claude/jarvis/state/active" | wc -l | tr -d ' ')
rc=0; [ "$n" = 2 ] || rc=1; check "$rc" "tracked as two sessions, not merged (got $n)"
ords=$(cat "$HOME/.claude/jarvis/state/active"/* | sed 's/.*|//' | sort -u | wc -l | tr -d ' ')
rc=0; [ "$ords" = 2 ] || rc=1; check "$rc" "given distinct chime pitches (got $ords distinct)"
quiet 40

# ---------------------------------------------------------------- T9
echo
echo "T9  a stale completion is dropped, not read out late"
fresh
printf 'alpha|1\n' > "$HOME/.claude/jarvis/state/active/s1"
# Born well beyond JARVIS_STALE. Announcing this 90s after the fact is noise.
printf 'done|alpha|200:0|%s|1|s1\n' $(( $(date +%s) - 300 )) > "$J/queue/5-$(date +%s)-x-1"
hook s1 alpha idle    # wake the daemon
quiet 30
# Assert on the render LOG, not on the spoken words. The first version grepped the
# audit for phrases like "task complete"; when the wording was shortened the grep
# stopped matching and the test passed unconditionally. The log records the mode.
rc=0; grep -q ' done ' "$J/log" 2>/dev/null; [ $? = 1 ] || rc=1; check "$rc" "the stale completion was never rendered" "$(cat "$J/log" 2>/dev/null)"
rc=0; grep -q ' idle ' "$J/log" 2>/dev/null || rc=1; check "$rc" "but the fresh item that woke it was" "$(cat "$J/log" 2>/dev/null)"

# ---------------------------------------------------------------- T11
echo
echo "T11 the chime finishes before the speech starts"
fresh
printf 'alpha|1\n' > "$HOME/.claude/jarvis/state/active/s1"
echo $(( $(date +%s) - 200 )) > "$HOME/.claude/jarvis/state/start/s1"
hook s1 alpha 'done'
quiet 30
# Overlapped, the chime's energy lands on the vowel formants of the first word —
# which is the project name, the one part that has to be understood. The motif ends
# by waiting out its own audible span precisely so this holds.
lastchime=$(grep 'AFPLAY' "$AUDIT" | tail -1 | awk '{print $1}')
firstsay=$(grep 'SAY_START' "$AUDIT" | head -1 | awk '{print $1}')
if [ -n "$lastchime" ] && [ -n "$firstsay" ]; then
  awk -v c="$lastchime" -v s="$firstsay" 'BEGIN{exit (s>=c)?0:1}'
  check $? "speech starts after the last tone (chime $lastchime, speech $firstsay)"
else
  bad "speech starts after the last tone" "missing events: chime=$lastchime say=$firstsay"
fi
rc=0; n=$(chimes); [ "$n" = 2 ] || rc=1; check "$rc" "the completion is a two-note motif ($n tones)"

# ---------------------------------------------------------------- T10
echo
echo "T10 hooks are silent on stdout and stderr"
fresh
for m in start begin 'done' permission idle subagent error end; do
  out=$(JARVIS_SESSION_KEY=q1 JARVIS_SESSION_NAME=quiet "$J/jarvis.sh" "$m" </dev/null 2>&1)
  if [ -n "$out" ]; then bad "$m produced output" "$out"; else ok "$m is silent"; fi
done
# And with a payload carrying a marker, which is the path that actually runs. Without a
# marker the extraction bails early and never reaches the file it has to append to — so
# the version of this test that passed no stdin missed a hook writing to stderr on the
# FIRST note of every single turn.
rm -f "$HOME/.claude/jarvis/state/notes/q2"
for m in subagent 'done'; do
  out=$(printf '%s' '{"last_assistant_message":"VOICE: something changed in the thing"}' \
        | JARVIS_SESSION_KEY=q2 JARVIS_SESSION_NAME=quiet "$J/jarvis.sh" "$m" 2>&1)
  if [ -n "$out" ]; then bad "$m with a marker produced output" "$out"; else ok "$m is silent with a marker"; fi
done
quiet 40

# ---------------------------------------------------------------- T12
echo
echo "T12 closing four sessions at once says goodbye ONCE"
fresh
for i in 1 2 3 4; do hook s$i proj$i start; done
quiet 40
: > "$AUDIT"; : > "$J/log"
# Every SessionEnd fires together when a terminal quits, and all four remove their
# active marker before the FIRST bye reaches render — so `nactive -eq 0` was true for
# all of them and it said goodbye four times. No existing test could see this: each
# behaviour is correct in isolation.
for i in 1 2 3 4; do hook s$i proj$i end; done
# Match on the RENDER, not on the words. This asserted the literal "Goodbye" and broke
# the moment the farewell gained a day digest — the third time a spoken-text grep in this
# harness has quietly stopped testing what it claimed to.
wait_for ' bye ' "$J/log" 40
quiet 40
n=$(grep -c ' bye ' "$J/log" 2>/dev/null); n=${n:-0}
rc=0; [ "$n" = 1 ] || rc=1; check "$rc" "exactly one farewell rendered (got $n)" "$(cat "$J/log")"
u=$(says); rc=0; [ "$u" = 1 ] || rc=1; check "$rc" "and exactly one utterance (got $u)" "$(grep SAY_START "$AUDIT")"
# The log must agree with what was actually said. Three suppressed byes were still
# being logged, so `jarvisctl log` and the simulation both reported four farewells.
b=$(grep -c ' bye ' "$J/log" 2>/dev/null); b=${b:-0}
rc=0; [ "$b" = 1 ] || rc=1; check "$rc" "and the log records exactly one (got $b)" "$(cat "$J/log")"

echo
echo "T13 a new session re-arms the farewell"
hook s1 proj1 start
quiet 40
: > "$AUDIT"; : > "$J/log"
hook s1 proj1 end
wait_for ' bye ' "$J/log" 40
n=$(grep -c ' bye ' "$J/log" 2>/dev/null); n=${n:-0}
rc=0; [ "$n" = 1 ] || rc=1; check "$rc" "the next close bids farewell again (got $n)"

# ---------------------------------------------------------------- T14
echo
echo "T14 mute silences the daemon's own nags, not just the hooks"
fresh
# The nag is generated by the daemon from its idle loop, so it never passes through
# a hook — and the mute check lived only in the hook. Muting for fifteen minutes did
# not stop it nagging.
export JARVIS_NAG_AFTER=3 JARVIS_NAG=3
hook s1 alpha start
hook s1 alpha permission
quiet 40
"$J/jarvisctl" mute 1 >/dev/null
: > "$AUDIT"
sleep 12                      # four nag intervals
rc=0; n=$(( $(says) + $(chimes) )); [ "$n" = 0 ] || rc=1; check "$rc" "silent through four nag intervals ($n audio events)"
"$J/jarvisctl" unmute >/dev/null
unset JARVIS_NAG_AFTER JARVIS_NAG

# ---------------------------------------------------------------- T15
echo
echo "T15 a long-blocked session escalates — once"
fresh
export JARVIS_NAG_AFTER=2 JARVIS_NAG=1 JARVIS_ESCALATE=7
hook s1 alpha start
quiet 30
: > "$J/log"
hook s1 alpha permission
# check_nags runs from the daemon's IDLE loop, once every 10s of quiet — and the nag
# it fires first resets that counter, so the escalation lands on the second sweep, not
# the first. Roughly 25-30s here, whatever the thresholds are set to.
wait_for ' escalate ' "$J/log" 90
n=$(grep -c ' escalate ' "$J/log" 2>/dev/null); n=${n:-0}
rc=0; [ "$n" = 1 ] || rc=1; check "$rc" "escalated once (got $n)" "$(cat "$J/log")"
g=$(grep -c ' nag ' "$J/log" 2>/dev/null); g=${g:-0}
rc=0; [ "$g" -ge 1 ] || rc=1; check "$rc" "and nagged first ($g nags)"
# Repeating an escalation turns the most important alert in the set into background
# noise, which is the one thing it cannot afford to become.
sleep 22
n=$(grep -c ' escalate ' "$J/log" 2>/dev/null); n=${n:-0}
rc=0; [ "$n" = 1 ] || rc=1; check "$rc" "and does not escalate again (still $n)"
unset JARVIS_NAG_AFTER JARVIS_NAG JARVIS_ESCALATE

echo
echo "T15b answering the prompt stops the escalation"
fresh
export JARVIS_NAG_AFTER=2 JARVIS_NAG=1 JARVIS_ESCALATE=6
hook s1 alpha start
quiet 30
hook s1 alpha permission
sleep 2
hook s1 alpha begin        # what a granted permission looks like: the next prompt
: > "$J/log"
sleep 25
n=$(grep -cE ' (escalate|nag) ' "$J/log" 2>/dev/null); n=${n:-0}
rc=0; [ "$n" = 0 ] || rc=1; check "$rc" "silent once unblocked ($n reminders)" "$(cat "$J/log")"
unset JARVIS_NAG_AFTER JARVIS_NAG JARVIS_ESCALATE

# ---------------------------------------------------------------- T16
echo
echo "T16 hooks.d extensions receive events and cannot break the daemon"
fresh
mkdir -p "$J/hooks.d"
printf '#!/usr/bin/env bash\necho "$1 $2 $3 $4" >> "%s/hookargs.log"\n' "$SB" > "$J/hooks.d/10-log.sh"
# A hook that hangs, one that fails, one that is not executable. None may affect the
# announcements: a user script that could stall the drainer would take every future
# announcement down with it.
printf '#!/usr/bin/env bash\nsleep 45\n'      > "$J/hooks.d/20-hangs.sh"
printf '#!/usr/bin/env bash\nexit 3\n'        > "$J/hooks.d/30-fails.sh"
printf '#!/usr/bin/env bash\nexit 0\n'        > "$J/hooks.d/40-not-exec.sh"
chmod +x "$J/hooks.d/10-log.sh" "$J/hooks.d/20-hangs.sh" "$J/hooks.d/30-fails.sh"
: > "$SB/hookargs.log"
printf 'alpha|1\n' > "$HOME/.claude/jarvis/state/active/s1"
echo $(( $(date +%s) - 300 )) > "$HOME/.claude/jarvis/state/start/s1"
echo 4 > "$HOME/.claude/jarvis/state/subs/s1"
hook s1 alpha 'done'
wait_for 'done alpha' "$SB/hookargs.log" 30
rc=0; grep -q 'done alpha 300:4 1' "$SB/hookargs.log" || rc=1; check "$rc" "the extension got mode, name, extra and ordinal" "$(cat "$SB/hookargs.log")"
# And the next announcement still happens, despite the hanging hook.
: > "$AUDIT"
hook s1 alpha error
rc=0; wait_for SAY_START "$AUDIT" 30 || rc=1; check "$rc" "a hanging extension does not stall the queue"
rm -rf "$J/hooks.d"

# ---------------------------------------------------------------- T17
echo
echo "T17 specialists' spoken summaries reach the announcement"
fresh
printf 'alpha|1\n' > "$HOME/.claude/jarvis/state/active/s1"
# Every orchestrator agent is required to end with a VOICE: line. Stop and SubagentStop
# both carry last_assistant_message, so the clause is picked up from the hook payload —
# no transcript parsing, no model call, nothing leaving the machine.
say_hook begin '{}'
say_hook subagent '{"agent_type":"data-model-architect","last_assistant_message":"Long design text.\n\nVOICE: Vendor Audit schema is in\n"}'
rc=0; grep -qF 'Vendor Audit schema is in' "$HOME/.claude/jarvis/state/notes/s1" || rc=1
check "$rc" "a specialist's clause is captured" "$(cat "$HOME/.claude/jarvis/state/notes/s1" 2>/dev/null)"

say_hook subagent '{"agent_type":"code-reviewer","last_assistant_message":"No marker at all in this reply."}'
n=$(wc -l < "$HOME/.claude/jarvis/state/notes/s1" 2>/dev/null | tr -d ' ')
rc=0; [ "$n" = 1 ] || rc=1; check "$rc" "an agent that emits none adds nothing ($n note)"

echo $(( $(date +%s) - 200 )) > "$HOME/.claude/jarvis/state/start/s1"
say_hook 'done' '{}'
rc=0; wait_for 'Vendor Audit schema is in' "$AUDIT" 40 || rc=1
check "$rc" "and it is spoken on completion" "$(grep SAY_START "$AUDIT" | tail -1)"
# The count only ever existed because there was nothing better to say.
rc=0; grep -q 'specialists' "$AUDIT" && rc=1
check "$rc" "the specialist count is dropped when there is a summary"
quiet 40

echo
echo "T17f reset clears the notes too"
# reset listed every other state directory but not notes/, so a reset left the previous
# turn's clauses on disk for the next completion to announce.
fresh
printf 'alpha|1\n' > "$HOME/.claude/jarvis/state/active/s1"
say_hook subagent '{"last_assistant_message":"VOICE: a clause from before the reset"}'
"$J/jarvisctl" reset >/dev/null
rc=0; [ -s "$HOME/.claude/jarvis/state/notes/s1" ] && rc=1
check "$rc" "no clause survives a reset" "$(cat "$HOME/.claude/jarvis/state/notes/s1" 2>/dev/null)"

echo
echo "T17b a new turn starts with no inherited summary"
fresh
printf 'alpha|1\n' > "$HOME/.claude/jarvis/state/active/s1"
say_hook subagent '{"last_assistant_message":"VOICE: stale note from the previous turn"}'
say_hook begin '{}'
rc=0; [ -s "$HOME/.claude/jarvis/state/notes/s1" ] && rc=1
check "$rc" "notes cleared on the next prompt" "$(cat "$HOME/.claude/jarvis/state/notes/s1" 2>/dev/null)"
echo $(( $(date +%s) - 200 )) > "$HOME/.claude/jarvis/state/start/s1"
say_hook 'done' '{}'
quiet 40
rc=0; grep -q 'stale note' "$AUDIT" && rc=1
check "$rc" "and a stale clause is never spoken" "$(grep SAY_START "$AUDIT")"

echo
echo "T17c a turn with no summary still announces"
fresh
printf 'alpha|1\n' > "$HOME/.claude/jarvis/state/active/s1"
echo $(( $(date +%s) - 200 )) > "$HOME/.claude/jarvis/state/start/s1"
say_hook 'done' '{"last_assistant_message":"I fixed it."}'
rc=0; wait_for SAY_START "$AUDIT" 40 || rc=1
check "$rc" "falls back to the short form rather than going silent"
quiet 40

echo
echo "T17d agent output is not a trusted input"
fresh
printf 'alpha|1\n' > "$HOME/.claude/jarvis/state/active/s1"
say_hook begin '{}'
say_hook subagent '{"last_assistant_message":"VOICE: done | $(touch '"$SB"'/PWNED) and `id` \"q\" /etc/passwd"}'
note=$(cat "$HOME/.claude/jarvis/state/notes/s1" 2>/dev/null)
rc=0; [ -e "$SB/PWNED" ] && rc=1
check "$rc" "a command substitution in a clause is not executed"
case "$note" in *'|'*|*'$'*|*'`'*|*'"'*|*'/'*) bad "shell metacharacters are stripped" "kept: $note" ;;
  *) ok "shell metacharacters are stripped (became: $note)" ;; esac

echo
echo "T17e a runaway clause cannot monopolise the speaker"
fresh
printf 'alpha|1\n' > "$HOME/.claude/jarvis/state/active/s1"
say_hook begin '{}'
long=$(node -e 'process.stdout.write("word ".repeat(200))')
say_hook subagent "{\"last_assistant_message\":\"VOICE: $long\"}"
note=$(cat "$HOME/.claude/jarvis/state/notes/s1" 2>/dev/null); len=${#note}
rc=0; [ "$len" -le 140 ] || rc=1
check "$rc" "capped at 140 characters (got $len)"

# ---------------------------------------------------------------- T18
echo
echo "T18 the voice is not spent on completions with nothing to report"
fresh
# Running several sessions, Stop fires constantly and "Done, sir. Three minutes." carries
# no information — it is the announcement that made the layer feel talkative.
printf 'alpha|1\n' > "$HOME/.claude/jarvis/state/active/s1"
printf 'bravo|2\n' > "$HOME/.claude/jarvis/state/active/s2"
echo $(( $(date +%s) - 200 )) > "$HOME/.claude/jarvis/state/start/s1"
say_hook 'done' '{}'
quiet 40
n=$(says); rc=0; [ "$n" = 0 ] || rc=1
check "$rc" "two sessions live, nothing to say: ticks instead of speaking ($n utterances)"
c=$(chimes); rc=0; [ "$c" -ge 1 ] || rc=1
check "$rc" "but it still ticks, so the turn is not invisible ($c)"

echo
echo "T18b with something to say, it speaks — however many sessions are live"
fresh
printf 'alpha|1\n' > "$HOME/.claude/jarvis/state/active/s1"
printf 'bravo|2\n' > "$HOME/.claude/jarvis/state/active/s2"
say_hook begin '{}'
say_hook subagent '{"last_assistant_message":"VOICE: nineteen tests pass"}'
echo $(( $(date +%s) - 200 )) > "$HOME/.claude/jarvis/state/start/s1"
say_hook 'done' '{}'
rc=0; wait_for 'nineteen tests pass' "$AUDIT" 40 || rc=1
check "$rc" "an informative completion is always spoken" "$(grep SAY_START "$AUDIT" | tail -1)"
quiet 40

echo
echo "T18c alone, the short form is still spoken"
fresh
printf 'alpha|1\n' > "$HOME/.claude/jarvis/state/active/s1"
echo $(( $(date +%s) - 200 )) > "$HOME/.claude/jarvis/state/start/s1"
say_hook 'done' '{}'
rc=0; wait_for SAY_START "$AUDIT" 40 || rc=1
check "$rc" "one session, nothing to say: still worth a sentence"
quiet 40

echo
echo "T19 the farewell reports the whole day, once"
fresh
printf 'alpha|1\n' > "$HOME/.claude/jarvis/state/active/s1"
say_hook begin '{}'
say_hook subagent '{"last_assistant_message":"VOICE: schema is in"}'
echo $(( $(date +%s) - 200 )) > "$HOME/.claude/jarvis/state/start/s1"
say_hook 'done' '{}'
quiet 40
say_hook begin '{}'
say_hook subagent '{"last_assistant_message":"VOICE: four tests are failing on the refund path"}'
echo $(( $(date +%s) - 200 )) > "$HOME/.claude/jarvis/state/start/s1"
say_hook 'done' '{}'
quiet 40
: > "$AUDIT"
say_hook end '{}'
rc=0; wait_for 'All sessions closed' "$AUDIT" 40 || rc=1
check "$rc" "the farewell speaks" "$(grep SAY_START "$AUDIT")"
rc=0; grep -q '2 turns' "$AUDIT" || rc=1
check "$rc" "and counts the turns across the day" "$(grep SAY_START "$AUDIT")"
rc=0; grep -q '1 problem outstanding' "$AUDIT" || rc=1
check "$rc" "and names that something is outstanding"
rc=0; [ -e "$HOME/.claude/jarvis/state/day" ] && rc=1
check "$rc" "and clears the tally, so tomorrow starts fresh"

# ---------------------------------------------------------------- T20
echo
echo "T20 the end-of-session briefing"
fresh
rm -rf "$J/briefings"
printf 'alpha|1\n' > "$HOME/.claude/jarvis/state/active/s1"
ST="$HOME/.claude/jarvis/state"

say_hook begin '{}'
say_hook subagent '{"last_assistant_message":"VOICE: schema is in\nHEADS-UP: the submit hook now fires on amend"}'
say_hook subagent '{"last_assistant_message":"VOICE: fixtures exported\nPENDING: permissions matrix needs an Auditor role"}'
echo $(( $(date +%s) - 200 )) > "$ST/start/s1"
say_hook 'done' '{}'
quiet 40
say_hook begin '{}'
say_hook subagent '{"last_assistant_message":"VOICE: all tests pass\nPENDING: the offline sync path is untested"}'
echo $(( $(date +%s) - 200 )) > "$ST/start/s1"
say_hook 'done' '{}'
quiet 40

rc=0; grep -qF 'the submit hook now fires on amend' "$ST/heads/s1" || rc=1
check "$rc" "a HEADS-UP is collected" "$(cat "$ST/heads/s1" 2>/dev/null)"
n=$(grep -c '' "$ST/todo/s1" 2>/dev/null); n=${n:-0}
rc=0; [ "$n" = 2 ] || rc=1; check "$rc" "PENDING accumulates ACROSS turns (got $n)" "$(cat "$ST/todo/s1" 2>/dev/null)"
n=$(grep -c '' "$ST/done/s1" 2>/dev/null); n=${n:-0}
rc=0; [ "$n" -ge 2 ] || rc=1; check "$rc" "and so does what was done (got $n)"

: > "$AUDIT"; : > "$J/log"
say_hook end '{}'
rc=0; wait_for ' brief ' "$J/log" 40 || rc=1
check "$rc" "closing the session speaks a briefing" "$(cat "$J/log")"
# Poll for the speech, not for the log line: the log is written at the START of render,
# so it is present a debounce and a chime before anything is spoken.
rc=0; wait_for 'permissions matrix needs an Auditor role' "$AUDIT" 40 || rc=1
check "$rc" "and it names what is still pending" "$(grep SAY_START "$AUDIT" | head -2)"
# What was DONE is deliberately not spoken: it was already announced turn by turn, and
# the person hearing this is closing a terminal.
rc=0; grep -q 'fixtures exported' "$AUDIT" && rc=1
check "$rc" "but not everything already announced turn by turn"
quiet 40

b=$(ls "$J/briefings" 2>/dev/null | wc -l | tr -d ' ')
rc=0; [ "$b" -ge 1 ] || rc=1; check "$rc" "a full record is written to disk ($b file)"
f=$(ls "$J/briefings"/* 2>/dev/null | head -1)
for want in 'DONE' 'HEADS UP' 'PENDING' 'fixtures exported' 'offline sync path'; do
  rc=0; grep -qF "$want" "$f" || rc=1
  check "$rc" "the record contains \"$want\""
done
rc=0; "$J/jarvisctl" brief 2>/dev/null | grep -qF 'offline sync path' || rc=1
check "$rc" "and jarvisctl brief prints it"

echo
echo "T20b a session that finished cleanly says nothing on the way out"
fresh
rm -rf "$J/briefings"
printf 'alpha|1\n' > "$HOME/.claude/jarvis/state/active/s1"
say_hook begin '{}'
say_hook subagent '{"last_assistant_message":"VOICE: reviewed the hooks, nothing to change"}'
echo $(( $(date +%s) - 200 )) > "$ST/start/s1"
say_hook 'done' '{}'
quiet 40
: > "$J/log"
say_hook end '{}'
quiet 40
n=$(grep -c ' brief ' "$J/log" 2>/dev/null); n=${n:-0}
rc=0; [ "$n" = 0 ] || rc=1; check "$rc" "nothing outstanding, so nothing spoken ($n)" "$(cat "$J/log")"
rc=0; ls "$J/briefings"/* >/dev/null 2>&1 || rc=1
check "$rc" "but the record is written anyway"

echo
echo "T20c the session's lists do not leak into the next one"
rc=0; [ -e "$ST/todo/s1" ] && rc=1; check "$rc" "pending cleared on close"
rc=0; [ -e "$ST/done/s1" ] && rc=1; check "$rc" "done cleared on close"
rc=0; [ -e "$ST/heads/s1" ] && rc=1; check "$rc" "heads-up cleared on close"

# ---------------------------------------------------------------- T21
echo
echo "T21 prose ABOUT the markers is not harvested as data"
fresh
printf 'alpha|1\n' > "$HOME/.claude/jarvis/state/active/s1"
ST="$HOME/.claude/jarvis/state"
# This happened. Explaining the contract in a reply put "Material Movement schema is in"
# and a mangled half-sentence into a live session's briefing, because the markers sat
# inside a fenced block a few lines from the end. Neither a line-anchor nor a
# last-N-lines window separates that from a real handoff; only "markers are terminal".
say_hook subagent '{"last_assistant_message":"Here is how it works. Every agent ends with a line:\n\n```\nVOICE: Vendor Audit schema is in\nPENDING: permissions matrix needs a role\n```\n\nThat clause is spoken on completion."}'
rc=0; [ -s "$ST/notes/s1" ] && rc=1
check "$rc" "an explanation of the format yields no clause" "$(cat "$ST/notes/s1" 2>/dev/null)"
rc=0; [ -s "$ST/todo/s1" ] && rc=1
check "$rc" "and no pending item" "$(cat "$ST/todo/s1" 2>/dev/null)"

say_hook subagent '{"last_assistant_message":"The VOICE: marker goes last, as in VOICE: some example. Then prose continues after it."}'
rc=0; [ -s "$ST/notes/s1" ] && rc=1
check "$rc" "a marker mentioned mid-sentence yields nothing"

echo
echo "T21b a real handoff, where the markers ARE terminal, still works"
fresh
printf 'alpha|1\n' > "$HOME/.claude/jarvis/state/active/s1"
say_hook subagent '{"last_assistant_message":"I designed the entity graph.\n\nVOICE: Vendor Audit schema is in\nPENDING: permissions matrix needs a role\n"}'
rc=0; grep -qxF 'Vendor Audit schema is in' "$ST/notes/s1" || rc=1
check "$rc" "the clause is captured" "$(cat "$ST/notes/s1" 2>/dev/null)"
rc=0; grep -qxF 'permissions matrix needs a role' "$ST/todo/s1" || rc=1
check "$rc" "and the pending item"

echo
echo "T22 an ordinary turn — no specialists, no markers — still gets a summary"
fresh
printf 'alpha|1\n' > "$HOME/.claude/jarvis/state/active/s1"
# The main thread emits no markers; a VOICE line in a reply is clutter for whoever is
# reading it. So a chat where the work is done directly would never produce a summary at
# all — which is the COMMON case, and the reason nothing was ever spoken in a normal
# conversation.
MSG='{"last_assistant_message":"Found it, and it is exactly the trap I had recorded.\n\nMore detail follows here.\n\n## A heading\n\nAnd more."}'
say_hook begin "$MSG"
echo $(( $(date +%s) - 200 )) > "$ST/start/s1"
say_hook 'done' "$MSG"
rc=0; wait_for 'exactly the trap I had recorded' "$AUDIT" 40 || rc=1
check "$rc" "the turn's opening sentence is spoken" "$(grep SAY_START "$AUDIT" | tail -1)"
# One sentence, not the whole message.
rc=0; grep -q 'More detail follows' "$AUDIT" && rc=1
check "$rc" "and only the first sentence of it"
rc=0; grep -q 'A heading' "$AUDIT" && rc=1
check "$rc" "with the markdown left out"
quiet 40

echo
echo "T22b a specialist's clause still beats the fallback"
fresh
printf 'alpha|1\n' > "$HOME/.claude/jarvis/state/active/s1"
say_hook begin '{}'
say_hook subagent '{"last_assistant_message":"work done.\n\nVOICE: nineteen tests pass\n"}'
echo $(( $(date +%s) - 200 )) > "$ST/start/s1"
say_hook 'done' '{"last_assistant_message":"Some closing prose that should not win over the specialist."}'
rc=0; wait_for 'nineteen tests pass' "$AUDIT" 40 || rc=1
check "$rc" "the marker wins over the closing sentence"
rc=0; grep -q 'closing prose' "$AUDIT" && rc=1
check "$rc" "and the fallback is not used"

# ---------------------------------------------------------------- T23
echo
echo "T23 every announcement says WHICH session it is about"
fresh
ST="$HOME/.claude/jarvis/state"
printf 'alpha|1\n' > "$ST/active/s1"
# The name used to be spoken only when more than one session was live. That depended on
# bookkeeping which goes stale, so the failure mode was an anonymous announcement at
# exactly the moment several projects were running.
say_hook begin '{}'
say_hook subagent '{"last_assistant_message":"VOICE: nineteen tests pass"}'
echo $(( $(date +%s) - 200 )) > "$ST/start/s1"
say_hook 'done' '{}'
rc=0; wait_for 'alpha' "$AUDIT" 40 || rc=1
check "$rc" "a single live session is still named" "$(grep SAY_START "$AUDIT" | tail -1)"
quiet 40

echo
echo "T23b two sessions in the SAME directory are told apart"
fresh
# The normal case for a bench or a monorepo, and they would otherwise announce themselves
# identically — the same failure in a different disguise.
printf 'alpha|1\n' > "$ST/active/s1"
printf 'alpha|2\n' > "$ST/active/s2"
say_hook begin '{}'
say_hook subagent '{"last_assistant_message":"VOICE: nineteen tests pass"}'
echo $(( $(date +%s) - 200 )) > "$ST/start/s1"
say_hook 'done' '{}'
rc=0; wait_for 'alpha one' "$AUDIT" 40 || rc=1
check "$rc" "the ordinal disambiguates them" "$(grep SAY_START "$AUDIT" | tail -1)"
quiet 40

echo
echo "T23c distinct names are NOT given a pointless ordinal"
fresh
printf 'alpha|1\n' > "$ST/active/s1"
printf 'bravo|2\n' > "$ST/active/s2"
say_hook begin '{}'
say_hook subagent '{"last_assistant_message":"VOICE: nineteen tests pass"}'
echo $(( $(date +%s) - 200 )) > "$ST/start/s1"
say_hook 'done' '{}'
wait_for SAY_START "$AUDIT" 40
rc=0; grep -q 'alpha one' "$AUDIT" && rc=1
check "$rc" "no ordinal when the name is already unique" "$(grep SAY_START "$AUDIT" | tail -1)"
rc=0; grep -q 'alpha' "$AUDIT" || rc=1
check "$rc" "but it is still named"
quiet 40

echo
echo "T23d the path is recorded, so a spoken name can be traced to a project"
fresh
hook s1 alpha start
rc=0; [ -s "$ST/cwd/s1" ] || rc=1
check "$rc" "cwd captured for the session" "$(cat "$ST/cwd/s1" 2>/dev/null)"
rc=0; "$J/jarvisctl" status 2>/dev/null | grep -qF "$(cat "$ST/cwd/s1" 2>/dev/null)" || rc=1
check "$rc" "and status shows it, so names map back to paths"
quiet 40

# ---------------------------------------------------------------- T24
echo
echo "T24 the daily log — one file a day, every session, written as work happens"
fresh
ST="$HOME/.claude/jarvis/state"
DAY="$J/daily/$(date +%Y-%m-%d).md"
rm -rf "$J/daily"
printf 'alpha|1\n' > "$ST/active/s1"
say_hook begin '{}'
say_hook subagent '{"last_assistant_message":"VOICE: schema is in\nPENDING: permissions matrix needs a role"}'
echo $(( $(date +%s) - 200 )) > "$ST/start/s1"
say_hook 'done' '{}'
rc=0; grep -q '^# Daily log' "$DAY" 2>/dev/null || rc=1
check "$rc" "the day's file is created with a header" "$(cat "$DAY" 2>/dev/null)"
rc=0; grep -qF 'schema is in' "$DAY" 2>/dev/null || rc=1
check "$rc" "and the turn is recorded" "$(cat "$DAY" 2>/dev/null)"

echo
echo "T24b it records turns the VOICE stays quiet about"
# The log is a record; the voice is selective. Conflating them would make the quiet turns
# vanish from history — which is exactly the history you want tomorrow.
fresh; rm -rf "$J/daily"
printf 'alpha|1\n' > "$ST/active/s1"
printf 'bravo|2\n' > "$ST/active/s2"   # two live, so a summary-less turn is not spoken
echo $(( $(date +%s) - 200 )) > "$ST/start/s1"
say_hook 'done' '{}'
quiet 40
n=$(says); rc=0; [ "$n" = 0 ] || rc=1
check "$rc" "the turn was not announced ($n utterances)"
rc=0; grep -q '^- \*\*' "$DAY" 2>/dev/null || rc=1
check "$rc" "but it IS in the day's log" "$(cat "$DAY" 2>/dev/null)"

echo
echo "T24c a killed session still leaves its turns behind"
# SessionEnd may never fire. Assembling the log at close would lose the whole session.
fresh; rm -rf "$J/daily"
printf 'alpha|1\n' > "$ST/active/s1"
say_hook begin '{}'
say_hook subagent '{"last_assistant_message":"VOICE: work that must survive a kill"}'
echo $(( $(date +%s) - 200 )) > "$ST/start/s1"
say_hook 'done' '{}'
rm -f "$ST/active/s1"   # terminal killed: no SessionEnd
rc=0; grep -qF 'must survive a kill' "$DAY" 2>/dev/null || rc=1
check "$rc" "the turn survives with no SessionEnd"

echo
echo "T24d eight sessions appending at once do not corrupt the file"
fresh; rm -rf "$J/daily"
for i in 1 2 3 4 5 6 7 8; do
  ( printf 'p%s|%s\n' "$i" "$i" > "$ST/active/c$i"
    printf '%s' "{\"last_assistant_message\":\"VOICE: writer number $i finished\"}" \
      | JARVIS_SESSION_KEY="c$i" JARVIS_SESSION_NAME="proj$i" "$J/jarvis.sh" subagent >/dev/null 2>&1
    echo $(( $(date +%s) - 200 )) > "$ST/start/c$i"
    printf '%s' '{}' | JARVIS_SESSION_KEY="c$i" JARVIS_SESSION_NAME="proj$i" "$J/jarvis.sh" 'done' >/dev/null 2>&1 ) &
done
wait
n=$(grep -c '^- \*\*' "$DAY" 2>/dev/null); n=${n:-0}
rc=0; [ "$n" = 8 ] || rc=1; check "$rc" "all eight entries present (got $n)"
h=$(grep -c '^# Daily log' "$DAY" 2>/dev/null); h=${h:-0}
rc=0; [ "$h" = 1 ] || rc=1; check "$rc" "exactly one header, despite the race to create it (got $h)"
bad=$(grep -vcE '^(#|$|- \*\*[0-9]|### |- \*\*(Pending|Heads up)\*\*)' "$DAY" 2>/dev/null); bad=${bad:-0}
rc=0; [ "$bad" = 0 ] || rc=1; check "$rc" "no interleaved or malformed lines ($bad)"
d=$(grep -o 'writer number [0-9]' "$DAY" 2>/dev/null | sort -u | grep -c .); d=${d:-0}
rc=0; [ "$d" = 8 ] || rc=1; check "$rc" "all eight are distinct, none overwritten (got $d)"
quiet 40

echo
echo "T24i eight sessions appending LONG log entries do not interleave"
# The LOG marker is deliberately the longest thing written -- up to 380 characters,
# against a VOICE clause capped at 140. That matters here and nowhere else: the
# atomicity of file_append rests on ONE printf staying inside PIPE_BUF, which is 512
# bytes on macOS, the smallest of the three platforms. Eight writers at 380 characters
# is the case that would expose a torn write if the bound were wrong.
fresh; rm -rf "$J/daily"
LONGLOG="Added the three child tables to Vendor Audit in apps/exponent_utilities and wired the submit hook, then reran the suite. Chose a child table over a linked DocType because the rows are never queried independently of the parent, which also keeps the fixture export flat."
for i in 1 2 3 4 5 6 7 8; do
  ( printf 'p%s|%s\n' "$i" "$i" > "$ST/active/c$i"
    echo $(( $(date +%s) - 200 )) > "$ST/start/c$i"
    printf '%s' "{\"last_assistant_message\":\"VOICE: writer number $i finished\\nLOG: entry $i. $LONGLOG\\n\",\"hook_event_name\":\"Stop\"}" \
      | JARVIS_SESSION_KEY="c$i" JARVIS_SESSION_NAME="proj$i" "$J/jarvis.sh" 'done' >/dev/null 2>&1 ) &
done
wait

logs=$(grep -c '^  - entry ' "$DAY" 2>/dev/null); logs=${logs:-0}
rc=0; [ "$logs" = 8 ] || rc=1; check "$rc" "all eight LOG entries present (got $logs)"

# A torn write shows up as a line that is neither a turn line, a log line, a header nor
# blank -- i.e. one writer's bytes landing inside another writer's line.
torn=$(grep -vcE '^(#|$|- \*\*[0-9]|  - entry [0-9]|### |- \*\*(Pending|Heads up)\*\*)' "$DAY" 2>/dev/null); torn=${torn:-0}
rc=0; [ "$torn" = 0 ] || rc=1; check "$rc" "no torn or interleaved line ($torn)"

# Every log entry must be WHOLE: same trailing words as the source, not a prefix of it.
whole=$(grep -c 'keeps the fixture export flat' "$DAY" 2>/dev/null); whole=${whole:-0}
rc=0; [ "$whole" = 8 ] || rc=1; check "$rc" "every LOG entry survived intact end to end (got $whole)"

# And each is attributable: eight distinct entry numbers, none overwritten.
dl=$(grep -o '^  - entry [0-9]' "$DAY" 2>/dev/null | sort -u | grep -c .); dl=${dl:-0}
rc=0; [ "$dl" = 8 ] || rc=1; check "$rc" "eight distinct LOG entries (got $dl)"

# The bound itself: no appended line may exceed PIPE_BUF.
over=$(awk 'length($0) > 512 { n++ } END { print n+0 }' "$DAY" 2>/dev/null)
rc=0; [ "${over:-0}" = 0 ] || rc=1; check "$rc" "no appended line exceeds PIPE_BUF 512 bytes (${over:-0} over)"
quiet 40

echo
echo "T24e closing a session appends what is still outstanding"
fresh; rm -rf "$J/daily"
printf 'alpha|1\n' > "$ST/active/s1"
say_hook begin '{}'
say_hook subagent '{"last_assistant_message":"VOICE: done\nPENDING: the offline sync path is untested\nHEADS-UP: submit fires on amend now"}'
echo $(( $(date +%s) - 200 )) > "$ST/start/s1"
say_hook 'done' '{}'
say_hook end '{}'
rc=0; grep -q '^### .* closed' "$DAY" 2>/dev/null || rc=1
check "$rc" "a close block is written" "$(cat "$DAY" 2>/dev/null)"
rc=0; grep -qF 'Pending** · the offline sync path is untested' "$DAY" 2>/dev/null || rc=1
check "$rc" "with the pending item"
rc=0; grep -qF 'Heads up** · submit fires on amend now' "$DAY" 2>/dev/null || rc=1
check "$rc" "and the heads-up"

echo
echo "T24f reset clears STATE and never the records"
rc=0; [ -s "$DAY" ] || rc=1; check "$rc" "log present before reset"
"$J/jarvisctl" reset >/dev/null
rc=0; [ -s "$DAY" ] || rc=1
check "$rc" "and still present after — a reset is for state, not for history"

echo
echo "T24g yesterday resolves the last day WORKED, not literal yesterday"
rm -rf "$J/daily"; mkdir -p "$J/daily"
# No date arithmetic anywhere: `date -d` is GNU-only and `date -v` is BSD-only, and a
# weekend means literal yesterday has no log at all.
printf '# Daily log — 2000-01-03\n\n- **09:00** · `old` · 1m · ancient work\n' > "$J/daily/2000-01-03.md"
printf '# Daily log — 2000-01-07\n\n- **09:00** · `alpha` · 4m · the last thing I did\n- **10:00** · `alpha` · 2m · **PROBLEM** a test is failing\n- **Pending** · pick this up next\n' > "$J/daily/2000-01-07.md"
out=$("$J/jarvisctl" yesterday 2>/dev/null)
rc=0; printf '%s' "$out" | grep -q '2000-01-07' || rc=1
check "$rc" "picks the most recent earlier day" "$out"
rc=0; printf '%s' "$out" | grep -q '2000-01-03' && rc=1
check "$rc" "and not an older one"
rc=0; printf '%s' "$out" | grep -q 'the last thing I did' || rc=1
check "$rc" "reports what was done"
rc=0; printf '%s' "$out" | grep -qi 'pending' || rc=1
check "$rc" "and what is still pending"
# Today's own log must never be reported back as 'yesterday'.
printf '# Daily log — %s\n\n- **09:00** · `alpha` · 1m · today only\n' "$(date +%Y-%m-%d)" > "$J/daily/$(date +%Y-%m-%d).md"
out=$("$J/jarvisctl" yesterday 2>/dev/null)
rc=0; printf '%s' "$out" | grep -q 'today only' && rc=1
check "$rc" "today is excluded from 'yesterday'"

echo
echo "T24h no history at all is reported, not crashed"
rm -rf "$J/daily"; mkdir -p "$J/daily"
out=$("$J/jarvisctl" yesterday 2>&1); rc=$?
check "$rc" "exits cleanly with no logs (rc=$rc)"
rc=0; printf '%s' "$out" | grep -qi 'no earlier day' || rc=1
check "$rc" "and says so plainly" "$out"

# ---------------------------------------------------------------- teardown
echo
stop_daemon
sleep 0.3
if [ "$VERBOSE" = 1 ]; then echo "--- audit log ---"; cat "$AUDIT"; echo; fi
printf 'RESULT: %s passed, %s failed\n' "$PASS" "$FAIL"
rm -rf "$SB"
[ "$FAIL" = 0 ] || exit 1
