#!/bin/bash
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
node "$REPO/scripts/orchestrator.mjs" voice --apply >/dev/null 2>&1 || { echo "install failed"; exit 1; }

AUDIT="$SB/audit.log"
: > "$AUDIT"

# Sub-second timestamps. macOS `date` has no %N and $EPOCHREALTIME needs bash 5,
# which macOS does not ship; perl is always present.
cat > "$SB/bin/now" <<'STUB'
#!/bin/bash
perl -MTime::HiRes -e 'printf "%.3f\n", Time::HiRes::time()'
STUB

cat > "$SB/bin/say" <<STUB
#!/bin/bash
echo "\$($SB/bin/now) SAY_START \$*" >> $AUDIT
sleep 1.2
echo "\$($SB/bin/now) SAY_END" >> $AUDIT
STUB

cat > "$SB/bin/afplay" <<STUB
#!/bin/bash
echo "\$($SB/bin/now) AFPLAY \$*" >> $AUDIT
sleep 0.2
STUB

cat > "$SB/bin/osascript" <<STUB
#!/bin/bash
echo "\$($SB/bin/now) BANNER \$*" >> $AUDIT
STUB

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
    [ -z "$(ls "$J/queue" 2>/dev/null | grep -v '^\.')" ] && sleep 4 && return 0
    sleep 0.5; n=$((n+1))
  done
  return 1
}
# wait_for <pattern> <file> [secs] — poll for something to actually happen.
wait_for() {
  local pat="$1" f="$2" lim="${3:-25}" n=0
  while [ "$n" -lt "$lim" ]; do
    grep -qF "$pat" "$f" 2>/dev/null && return 0
    sleep 0.5; n=$((n+1))
  done
  return 1
}
fresh() {
  mkdir -p "$J/run"
  pkill -f 'jarvis/speaker.sh' 2>/dev/null
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
d=$(births); [ "$d" = 1 ]; check $? "exactly one speaker daemon was ever started (saw $d)"
quiet 40
no_overlap; check $? "no overlapping speech" "$(grep OVERLAP "$AUDIT" 2>/dev/null)"
[ "$(says)" -ge 3 ]; check $? "all four sessions announced ($(says) utterances)"

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
  hook s1 alpha done
done
quiet 40
n=$(says); [ "$n" = 1 ]; check $? "collapsed to exactly one announcement (got $n)"

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
  hook s1 alpha done
  sleep 0.3
done
quiet 40
n=$(says); [ "$n" = 1 ]; check $? "a staggered burst is still one announcement (got $n)"

echo
echo "T2c six subagents 0.3s apart are one chime"
fresh
printf 'alpha|1\n' > "$HOME/.claude/jarvis/state/active/s1"
hook s1 alpha begin
for i in 1 2 3 4 5 6; do hook s1 alpha subagent; sleep 0.3; done
quiet 40
n=$(chimes); [ "$n" = 1 ]; check $? "one tone for the whole batch (got $n)"

# ---------------------------------------------------------------- T3
echo
echo "T3  a two-second turn"
fresh
printf 'alpha|1\n' > "$HOME/.claude/jarvis/state/active/s1"
hook s1 alpha begin
sleep 2
hook s1 alpha done
quiet 20
n=$(says); [ "$n" = 0 ]; check $? "no speech for a short turn ($n utterances)"
[ "$(chimes)" -ge 1 ]; check $? "but it still ticked ($(chimes) chimes)"

# ---------------------------------------------------------------- T4
echo
echo "T4  muted"
fresh
"$J/jarvisctl" mute 5 >/dev/null
hook s1 alpha error
hook s1 alpha permission
sleep 3
n=$(( $(says) + $(chimes) )); [ "$n" = 0 ]; check $? "silent while muted ($n audio events)"
"$J/jarvisctl" unmute >/dev/null

# ---------------------------------------------------------------- T5
echo
echo "T5  status reports a blocked session"
fresh
hook s1 alpha start
hook s2 bravo start
hook s2 bravo permission
"$J/jarvisctl" status | grep -q 'BLOCKED ON APPROVAL'; check $? "status names the blocked session"
"$J/jarvisctl" status | grep -q 'bravo'; check $? "and names which one it is"
quiet 40

# ---------------------------------------------------------------- T6
echo
echo "T6  orphaned daemon stands down"
fresh
hook s1 alpha start
sleep 1
[ "$(live)" -ge 1 ]; check $? "a daemon is running"
rm -rf "$J/run/lock"
sleep 2
n=$(live); [ "$n" = 0 ]; check $? "it exited on its own after losing the lock ($n still live)"

# ---------------------------------------------------------------- T7
echo
echo "T7  a swarm run: six specialists, then completion"
fresh
printf 'alpha|1\n' > "$HOME/.claude/jarvis/state/active/s1"
hook s1 alpha begin
for i in 1 2 3 4 5 6; do hook s1 alpha subagent; done
echo $(( $(date +%s) - 200 )) > "$HOME/.claude/jarvis/state/start/s1"
hook s1 alpha done
quiet 40
grep -q '6 specialists' "$AUDIT"; check $? "the completion names the specialist count" "$(grep SAY_START "$AUDIT" | tail -1)"
n=$(says); [ "$n" -le 2 ]; check $? "six subagent events did not become six announcements (got $n)"

# ---------------------------------------------------------------- T8
echo
echo "T8  two sessions in the SAME directory"
fresh
printf '{"session_id":"aaaaaaaa-1111-2222-3333-444444444444"}' | "$J/jarvis.sh" start >/dev/null
printf '{"session_id":"bbbbbbbb-5555-6666-7777-888888888888"}' | "$J/jarvis.sh" start >/dev/null
n=$(ls "$HOME/.claude/jarvis/state/active" | wc -l | tr -d ' ')
[ "$n" = 2 ]; check $? "tracked as two sessions, not merged (got $n)"
ords=$(cat "$HOME/.claude/jarvis/state/active"/* | sed 's/.*|//' | sort -u | wc -l | tr -d ' ')
[ "$ords" = 2 ]; check $? "given distinct chime pitches (got $ords distinct)"
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
grep -q ' done ' "$J/log" 2>/dev/null; [ $? = 1 ]; check $? "the stale completion was never rendered" "$(cat "$J/log" 2>/dev/null)"
grep -q ' idle ' "$J/log" 2>/dev/null; check $? "but the fresh item that woke it was" "$(cat "$J/log" 2>/dev/null)"

# ---------------------------------------------------------------- T11
echo
echo "T11 the chime finishes before the speech starts"
fresh
printf 'alpha|1\n' > "$HOME/.claude/jarvis/state/active/s1"
echo $(( $(date +%s) - 200 )) > "$HOME/.claude/jarvis/state/start/s1"
hook s1 alpha done
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
n=$(chimes); [ "$n" = 2 ]; check $? "the completion is a two-note motif ($n tones)"

# ---------------------------------------------------------------- T10
echo
echo "T10 hooks are silent on stdout and stderr"
fresh
for m in start begin done permission idle subagent error end; do
  out=$(JARVIS_SESSION_KEY=q1 JARVIS_SESSION_NAME=quiet "$J/jarvis.sh" "$m" </dev/null 2>&1)
  if [ -n "$out" ]; then bad "$m produced output" "$out"; else ok "$m is silent"; fi
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
wait_for Goodbye "$AUDIT" 30
quiet 40
n=$(grep -c 'Goodbye' "$AUDIT" 2>/dev/null); n=${n:-0}
[ "$n" = 1 ]; check $? "exactly one goodbye spoken (got $n)" "$(grep SAY_START "$AUDIT")"
# The log must agree with what was actually said. Three suppressed byes were still
# being logged, so `jarvisctl log` and the simulation both reported four farewells.
b=$(grep -c ' bye ' "$J/log" 2>/dev/null); b=${b:-0}
[ "$b" = 1 ]; check $? "and the log records exactly one (got $b)" "$(cat "$J/log")"

echo
echo "T13 a new session re-arms the farewell"
hook s1 proj1 start
quiet 40
: > "$AUDIT"
hook s1 proj1 end
wait_for Goodbye "$AUDIT" 30
n=$(grep -c 'Goodbye' "$AUDIT" 2>/dev/null); n=${n:-0}
[ "$n" = 1 ]; check $? "the next close says goodbye again (got $n)"

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
n=$(( $(says) + $(chimes) )); [ "$n" = 0 ]; check $? "silent through four nag intervals ($n audio events)"
"$J/jarvisctl" unmute >/dev/null
unset JARVIS_NAG_AFTER JARVIS_NAG

# ---------------------------------------------------------------- teardown
echo
pkill -f 'jarvis/speaker.sh' 2>/dev/null
sleep 0.3
if [ "$VERBOSE" = 1 ]; then echo "--- audit log ---"; cat "$AUDIT"; echo; fi
printf 'RESULT: %s passed, %s failed\n' "$PASS" "$FAIL"
rm -rf "$SB"
[ "$FAIL" = 0 ] || exit 1
