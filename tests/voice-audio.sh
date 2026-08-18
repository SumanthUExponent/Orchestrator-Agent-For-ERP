#!/bin/bash
# Audio-design assertions for the voice layer.
#
# Sound is the one output a unit test cannot listen to, so this asserts the things
# that DETERMINE how it sounds and fail silently when wrong:
#
#   - afplay does nothing, and reports nothing, for a rate outside 0.4-3.0. A motif
#     table that multiplies past the ceiling is mute, not broken. It clamped once
#     already, collapsing two sessions onto one identical tone.
#   - the chime must finish before the speech starts. Overlapped, its energy sits on
#     the vowel formants of the first word, which is usually the project name.
#   - `Stop` fires after every turn, so announcement LENGTH is a feature. The first
#     cut ran 4.4-5.4s each and turned a normal session into a monologue.
#
# Uses the real `say` to measure durations, so it is macOS-only, like the layer.
#
# Usage: tests/voice-audio.sh

set -u
REPO="$(cd "$(dirname "$0")/.." && pwd)"
V="$REPO/voice"
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); printf '  \033[32mPASS\033[0m %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf '  \033[31mFAIL\033[0m %s\n' "$1"; [ -n "${2:-}" ] && printf '        %s\n' "$2"; }
chk() { if [ "$1" = 0 ]; then ok "$2"; else bad "$2" "${3:-}"; fi; }

MOTIFS="boot done approve nag err idle tick sub bye"

# ---- load speaker.sh as a library, with the players stubbed to print the table --
dump() {  # dump <motif> <ordinal>  ->  lines of "vol rate atom"
  (
    export JARVIS_LIB=1
    . "$V/config.sh"
    J=/tmp/jv-audio-$$; mkdir -p "$J/run" "$J/state/active" "$J/queue"
    afplay() { echo "$2 $4 $(basename "$5" .aiff)"; }
    sleep()  { :; }
    . "$V/speaker.sh"
    motif "$1" "$2" 2>/dev/null
    rm -rf "$J"
  )
}
spoken_of() {
  (
    export JARVIS_LIB=1
    . "$V/config.sh"
    [ -n "${2:-}" ] && JARVIS_NAMES="$2"
    J=/tmp/jv-audio-$$; mkdir -p "$J/run" "$J/state/active" "$J/queue"
    . "$V/speaker.sh"
    spoken "$1"
    rm -rf "$J"
  )
}
speech_len() { say -v "${JARVIS_VOICE:-Daniel}" -r "${JARVIS_RATE:-172}" -o /tmp/jv-len.aiff "$1" 2>/dev/null
               afinfo /tmp/jv-len.aiff 2>/dev/null | awk -F': ' '/estimated duration/{printf "%.2f", $2}'; }

echo "JARVIS audio-design assertions"
echo

# ---------------------------------------------------------------------- rates
echo "R1  every motif rate is inside afplay's 0.4-3.0 window"
outofrange=""
for k in $MOTIFS; do for o in 1 2 3 4; do
  while read -r v r a; do
    [ -z "${r:-}" ] && continue
    awk -v r="$r" 'BEGIN{exit (r<0.4||r>3.0)?1:0}' || outofrange="$outofrange $k/$o:$r"
  done <<< "$(dump "$k" "$o")"
done; done
[ -z "$outofrange" ]; chk $? "no rate outside the window" "$outofrange"

echo
echo "R2  no rate sits ON the clamp — a clamped table is mute, not wrong"
# 3.000 exactly means rate() saturated. The value is legal, the motif is not: two
# different ordinals that both saturate produce the identical tone.
clamped=""
for k in $MOTIFS; do for o in 1 2 3 4; do
  while read -r v r a; do
    [ "${r:-}" = "3.000" ] && clamped="$clamped $k/$o"
  done <<< "$(dump "$k" "$o")"
done; done
[ -z "$clamped" ]; chk $? "nothing reaches the ceiling" "$clamped"

echo
echo "R3  each session ordinal gets an audibly different motif"
same=""
for k in $MOTIFS; do
  [ "$k" = err ] && continue   # err is deliberately session-independent: bad is bad
  prev=""
  for o in 1 2 3 4; do
    cur=$(dump "$k" "$o" | awk '{print $2}' | tr '\n' ',')
    [ -n "$prev" ] && [ "$cur" = "$prev" ] && same="$same $k/$o"
    prev="$cur"
  done
done
[ -z "$same" ]; chk $? "adjacent ordinals differ for every motif" "$same"

echo
echo "R4  volumes are in range, and importance is ordered"
badvol=""
for k in $MOTIFS; do
  while read -r v r a; do
    [ -z "${v:-}" ] && continue
    awk -v v="$v" 'BEGIN{exit (v<=0||v>2.0)?1:0}' || badvol="$badvol $k:$v"
  done <<< "$(dump "$k" 1)"
done
[ -z "$badvol" ]; chk $? "no volume outside 0-2.0" "$badvol"
# An urgent alert must not be quieter than a routine one. It was: measured RMS
# differs 4.6x across the system sounds, so one fixed volume made the error chime
# quieter than the completion.
verr=$(dump err 1  | head -1 | awk '{print $1}')
vdone=$(dump done 1 | head -1 | awk '{print $1}')
vsub=$(dump sub 1  | head -1 | awk '{print $1}')
awk -v e="$verr" -v d="$vdone" 'BEGIN{exit (e>d)?0:1}'; chk $? "error ($verr) is louder than completion ($vdone)"
awk -v s="$vsub" -v d="$vdone" 'BEGIN{exit (s<d)?0:1}'; chk $? "subagent ($vsub) is quieter than completion ($vdone)"

echo
echo "R5  a two-note motif uses one atom, so the interval is exact"
# Layering two DIFFERENT system sounds gave a sustained chord, not two notes: they
# are 0.56-1.65s long with their energy in the same band.
mixed=""
for k in $MOTIFS; do
  n=$(dump "$k" 1 | awk '{print $3}' | sort -u | wc -l | tr -d ' ')
  [ "$n" -gt 1 ] && mixed="$mixed $k"
done
[ -z "$mixed" ]; chk $? "each motif is built from a single atom" "$mixed"

echo
echo "R6  direction carries meaning: good rises, bad falls"
r1=$(dump done 1 | sed -n 1p | awk '{print $2}'); r2=$(dump done 1 | sed -n 2p | awk '{print $2}')
awk -v a="$r1" -v b="$r2" 'BEGIN{exit (b>a)?0:1}'; chk $? "completion rises ($r1 -> $r2)"
e1=$(dump err 1 | sed -n 1p | awk '{print $2}'); e2=$(dump err 1 | sed -n 2p | awk '{print $2}')
awk -v a="$e1" -v b="$e2" 'BEGIN{exit (b<a)?0:1}'; chk $? "error falls ($e1 -> $e2)"
b1=$(dump bye 1 | sed -n 1p | awk '{print $2}'); b3=$(dump bye 1 | sed -n 3p | awk '{print $2}')
awk -v a="$b1" -v b="$b3" 'BEGIN{exit (b<a)?0:1}'; chk $? "shutdown falls ($b1 -> $b3)"

# ------------------------------------------------------------------- names
echo
echo "N1  spoken() turns a directory basename into something sayable"
t() { r=$(spoken_of "$1" "${3:-}"); if [ "$r" = "$2" ]; then ok "$1 -> \"$r\""; else bad "$1 -> \"$r\", expected \"$2\""; fi; }
t "frappe-bench"       "frappe bench"
t "exponent_utilities" "exponent utilities"
t "nsproto"            "nsproto"
t "wt_nst"             "N S T"                       # worktree prefix + initialism
t "wt_crm"             "C R M"
t "wt_nst"             "the N S T tree"  "wt_nst=the N S T tree"   # explicit override wins

# ---------------------------------------------------- announcement length
echo
echo "L1  announcements stay short — Stop fires after EVERY turn"
budget() {  # budget <label> <max seconds> <text>
  local d; d=$(speech_len "$3")
  awk -v d="$d" -v m="$2" 'BEGIN{exit (d<=m)?0:1}'
  chk $? "$1 = ${d}s (budget ${2}s)"
}
budget "done, solo, no crew " 2.2 "Done, sir. 4 minutes."
budget "done, solo, swarm   " 3.4 "Done, sir. 6 specialists, 4 minutes."
budget "approval, solo      " 1.8 "Your approval, sir."
budget "error, solo         " 1.8 "A problem, sir."
budget "idle, solo          " 1.8 "Standing by, sir."
budget "boot                " 3.2 "Good afternoon, sir. frappe bench online."
budget "approval, 2 sessions" 2.6 "N S T needs your approval, sir."

echo
echo "L2  [[slnc]] actually inserts silence (it is silently ignored by some voices)"
a=$(speech_len "One. Two.")
b=$(speech_len "One. [[slnc 600]] Two.")
awk -v a="$a" -v b="$b" 'BEGIN{exit (b-a>0.4)?0:1}'; chk $? "600ms pause lengthened the utterance ${a}s -> ${b}s"

echo
printf 'RESULT: %s passed, %s failed\n' "$PASS" "$FAIL"
rm -f /tmp/jv-len.aiff
[ "$FAIL" = 0 ] || exit 1
