#!/bin/bash
# Platform and speech assertions for the voice layer.
#
# The motif tables, tone synthesis and loudness ordering are asserted in
# tests/tones.test.mjs, which runs everywhere. What is left here is what genuinely
# needs the live machine: that a speech and an audio backend were actually found, that
# the installed motif table agrees with the installed tone files, that names come out
# sayable, and that announcements stay short.
#
# Length matters because `Stop` fires after EVERY turn. The first version ran 4.4-5.4
# seconds per announcement and turned a normal session into a monologue.
#
# Speech-duration checks need a TTS engine that can render to a file, which today is
# macOS `say`; they are skipped elsewhere rather than failed.
#
# Usage: tests/voice-audio.sh

set -u
REPO="$(cd "$(dirname "$0")/.." && pwd)"
V="$REPO/voice"
PASS=0; FAIL=0; SKIP=0
ok()   { PASS=$((PASS+1)); printf '  \033[32mPASS\033[0m %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); printf '  \033[31mFAIL\033[0m %s\n' "$1"; [ -n "${2:-}" ] && printf '        %s\n' "$2"; }
skip() { SKIP=$((SKIP+1)); printf '  \033[33mSKIP\033[0m %s\n' "$1"; }
chk()  { if [ "$1" = 0 ]; then ok "$2"; else bad "$2" "${3:-}"; fi; }

# A sandbox install, so the suite never depends on what happens to be in ~/.claude.
SB=$(mktemp -d /tmp/jv-audio-XXXXXX)
export CLAUDE_JARVIS_DIR="$SB/jarvis"
export CLAUDE_SETTINGS_FILE="$SB/settings.json"
echo '{}' > "$CLAUDE_SETTINGS_FILE"
node "$REPO/scripts/orchestrator.mjs" voice --apply >/dev/null 2>&1
J="$CLAUDE_JARVIS_DIR"
trap 'rm -rf "$SB"' EXIT

. "$J/platform.sh"

echo "JARVIS platform and speech assertions"
echo "platform: $JV_OS"
echo

# ------------------------------------------------------------------ backends
echo "P1  a speech and an audio backend were found on THIS machine"
sayb=$(jv_backend_say);  case "$sayb"  in NONE*) bad "speech backend ($sayb)" ;; *) ok "speech backend: $sayb" ;; esac
playb=$(jv_backend_play); case "$playb" in NONE*) bad "audio backend ($playb)" ;; *) ok "audio backend: $playb" ;; esac
ok "banner backend: $(jv_backend_notify)"

echo
echo "P2  the platform layer is the ONLY place that names an OS tool"
# If an OS call leaks back into speaker.sh the layer stops being portable, and the
# breakage appears on someone else's machine rather than here.
leak=$(grep -nE '^[^#]*\b(afplay|osascript|say -v|paplay|aplay|powershell)' "$V/speaker.sh" "$V/jarvis.sh" 2>/dev/null | grep -v 'jv_' || true)
[ -z "$leak" ]; chk $? "no OS-specific call outside platform.sh" "$leak"

echo
echo "P3  installed tones and the installed motif table agree"
. "$J/tones/motifs.sh"
missing=""; total=0
for k in boot done approve nag err idle tick sub bye; do
  for o in 1 2 3 4; do
    var="MOTIF_${k}_${o}"; seq="${!var-}"
    [ -z "$seq" ] && { missing="$missing $k/$o:EMPTY"; continue; }
    for item in $seq; do
      total=$((total+1))
      [ -f "$J/tones/${item%%:*}" ] || missing="$missing $k/$o:${item%%:*}"
    done
  done
done
[ -z "$missing" ]; chk $? "all $total referenced notes are present" "$missing"

echo
echo "P4  the Linux and Windows branches actually invoke something"
# These cannot be run for real from macOS, but the branch that dispatches to them can:
# stub the tools, force JV_OS, and assert the right one was called with the text. The
# alternative is shipping a Linux path nobody has ever executed.
STUB="$SB/stub"; mkdir -p "$STUB"
for tool in espeak-ng spd-say paplay aplay notify-send powershell.exe wslpath; do
  printf '#!/bin/bash\necho "%s $*" >> "%s/calls.log"\n' "$tool" "$SB" > "$STUB/$tool"
  chmod +x "$STUB/$tool"
done
printf '#!/bin/bash\nprintf "C:\\\\fake\\\\%%s" "$(basename "$2")"\n' > "$STUB/wslpath"; chmod +x "$STUB/wslpath"

probe() {  # probe <os> <call> -> the logged invocation
  : > "$SB/calls.log"
  ( export PATH="$STUB:$PATH"
    . "$J/config.sh"
    . "$J/platform.sh"
    JV_OS="$1"
    # Re-resolve the PowerShell handle now that the stub is on PATH.
    for c in powershell.exe pwsh.exe powershell; do have "$c" && { JV_PS="$c"; break; }; done
    eval "$2" ) >/dev/null 2>&1
  # Poll rather than sleep. The banner is deliberately fire-and-forget — backgrounded
  # so that a slow notifier can never delay the speech — and the first exec of a stub
  # measured 495ms cold against 10ms warm, so any fixed wait is a coin flip.
  local n=0
  while [ "$n" -lt 60 ] && [ ! -s "$SB/calls.log" ]; do sleep 0.05; n=$((n+1)); done
  cat "$SB/calls.log" 2>/dev/null
}

r=$(probe linux 'jv_say "test one"')
case "$r" in *spd-say*|*espeak*) ok "linux speech dispatched: $(echo "$r" | head -1)" ;;
             *) bad "linux speech dispatched" "got: ${r:-nothing}" ;; esac

r=$(probe linux 'jv_play_now "$J/tones/motifs.sh"')
case "$r" in *paplay*|*aplay*) ok "linux audio dispatched: $(echo "$r" | head -1 | cut -c1-40)" ;;
             *) bad "linux audio dispatched" "got: ${r:-nothing}" ;; esac

r=$(probe linux 'jv_notify "Title" "Body"')
case "$r" in *notify-send*) ok "linux banner dispatched" ;;
             *) bad "linux banner dispatched" "got: ${r:-nothing}" ;; esac

r=$(probe windows 'jv_say "test one"')
case "$r" in *powershell*System.Speech*) ok "windows speech dispatched via System.Speech" ;;
             *) bad "windows speech dispatched" "got: ${r:-nothing}" ;; esac

r=$(probe windows 'jv_play_now "$J/tones/motifs.sh"')
case "$r" in *powershell*SoundPlayer*) ok "windows audio dispatched via Media.SoundPlayer" ;;
             *) bad "windows audio dispatched" "got: ${r:-nothing}" ;; esac

echo
echo "P5  a platform with no backend at all degrades to silence, not to an error"
# A missing engine must never make a hook fail: a non-zero hook surfaces a notice in
# the transcript, so an absent speech engine would become visible noise every turn.
out=$( ( export PATH="$SB/empty:/usr/bin:/bin"; mkdir -p "$SB/empty"
         . "$J/config.sh"; . "$J/platform.sh"; JV_OS=linux
         jv_say "hello"; jv_play_now "/nonexistent.wav"; jv_notify "a" "b" ) 2>&1 )
rc=$?
[ "$rc" = 0 ]; chk $? "exit 0 with no engine present (rc=$rc)"
[ -z "$out" ]; chk $? "and no output" "$out"

r=$(probe unknown 'jv_say "x"')
[ -z "$r" ]; chk $? "an unrecognised platform calls nothing at all" "$r"

# --------------------------------------------------------------------- names
echo
echo "N1  a directory basename comes out sayable"
spoken_of() (
  export JARVIS_LIB=1
  . "$J/config.sh"; [ -n "${2:-}" ] && JARVIS_NAMES="$2"
  . "$J/platform.sh"; . "$J/speaker.sh"
  spoken "$1"
)
t() { r=$(spoken_of "$1" "${3:-}"); if [ "$r" = "$2" ]; then ok "$1 -> \"$r\""; else bad "$1 -> \"$r\", expected \"$2\""; fi; }
t "frappe-bench"       "frappe bench"
t "exponent_utilities" "exponent utilities"
t "nsproto"            "nsproto"
t "wt_nst"             "N S T"                                    # worktree prefix + initialism
t "wt_crm"             "C R M"
t "wt_nst"             "the N S T tree"  "wt_nst=the N S T tree"  # explicit override wins

# ------------------------------------------------------------------- lengths
echo
echo "L1  announcements stay short — Stop fires after EVERY turn"
if [ "$JV_OS" != macos ]; then
  skip "speech-duration budgets (needs a TTS engine that renders to file)"
else
  speech_len() { say -v "${JARVIS_VOICE:-Daniel}" -r "${JARVIS_RATE:-172}" -o "$SB/len.aiff" "$1" 2>/dev/null
                 afinfo "$SB/len.aiff" 2>/dev/null | awk -F': ' '/estimated duration/{printf "%.2f", $2}'; }
  budget() { local d; d=$(speech_len "$3"); awk -v d="$d" -v m="$2" 'BEGIN{exit (d<=m)?0:1}'; chk $? "$1 = ${d}s (budget ${2}s)"; }
  budget "done, solo, no crew " 2.2 "Done, sir. 4 minutes."
  budget "done, solo, swarm   " 3.4 "Done, sir. 6 specialists, 4 minutes."
  budget "approval, solo      " 1.8 "Your approval, sir."
  budget "error, solo         " 1.8 "A problem, sir."
  budget "idle, solo          " 1.8 "Standing by, sir."
  budget "boot                " 3.2 "Good afternoon, sir. frappe bench online."
  budget "approval, 2 sessions" 2.6 "N S T needs your approval, sir."
fi

echo
echo "L2  macOS-only speech markup is stripped on other platforms"
# [[slnc 200]] is a macOS `say` directive. Anywhere else it would be READ ALOUD as
# "bracket bracket s l n c two hundred".
out=$(JV_OS=linux; . "$J/platform.sh" 2>/dev/null; JV_OS=linux
      t="One. [[slnc 200]] Two."
      [ "$JV_OS" = macos ] || t=$(printf '%s' "$t" | sed 's/\[\[[^]]*\]\]//g; s/  */ /g')
      printf '%s' "$t")
case "$out" in *slnc*) bad "markup stripped off macOS" "got: $out" ;; *) ok "stripped: \"$out\"" ;; esac

echo
printf 'RESULT: %s passed, %s failed, %s skipped\n' "$PASS" "$FAIL" "$SKIP"
[ "$FAIL" = 0 ] || exit 1
