#!/usr/bin/env bash
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
export JARVIS_DIR="$SB/jarvis"
export JARVIS_SETTINGS_FILE="$SB/settings.json"
echo '{}' > "$JARVIS_SETTINGS_FILE"
node "$REPO/scripts/jarvis.mjs" voice --apply >/dev/null 2>&1
J="$JARVIS_DIR"
trap 'rm -rf "$SB"' EXIT

. "$J/platform.sh"

echo "JARVIS platform and speech assertions"
echo "platform: $JV_OS"
echo

# ------------------------------------------------------------------ backends
echo "P1  the platform layer detects what is actually installed"
# The distinction that matters: a tool present on PATH but reported as NONE is a
# DETECTION bug and must fail. Nothing installed at all is not a bug — there is nothing
# to detect, and it is `jarvisctl doctor` that tells a user to install an engine, not the
# test suite. Conflating the two made an apt outage on a CI runner look like a defect.
present() { for c in "$@"; do command -v "$c" >/dev/null 2>&1 && return 0; done; return 1; }

sayb=$(jv_backend_say)
case "$sayb" in
  NONE*) if present piper spd-say espeak-ng espeak festival pico2wave; then
           bad "speech backend" "an engine is on PATH but the layer reports: $sayb"
         else skip "speech backend — no engine installed here"; fi ;;
  *) ok "speech backend: $sayb" ;;
esac

playb=$(jv_backend_play)
case "$playb" in
  NONE*) if present afplay paplay aplay ffplay mpv play cvlc; then
           bad "audio backend" "a player is on PATH but the layer reports: $playb"
         else skip "audio backend — no player installed here"; fi ;;
  *) ok "audio backend: $playb" ;;
esac
ok "banner backend: $(jv_backend_notify)"

echo
echo "P2  the platform layer is the ONLY place that names an OS tool"
# If an OS call leaks back into speaker.sh the layer stops being portable, and the
# breakage appears on someone else's machine rather than here.
leak=$(grep -nE '^[^#]*\b(afplay|osascript|say -v|paplay|aplay|powershell)' "$V/speaker.sh" "$V/jarvis.sh" 2>/dev/null | grep -v 'jv_' || true)
rc=0; [ -z "$leak" ] || rc=1; chk "$rc" "no OS-specific call outside platform.sh" "$leak"

echo
echo "P3  installed tones and the installed motif table agree"
. "$J/tones/motifs.sh"
missing=""; total=0
for k in boot 'done' approve nag err idle tick sub bye; do
  for o in 1 2 3 4; do
    var="MOTIF_${k}_${o}"; seq="${!var-}"
    [ -z "$seq" ] && { missing="$missing $k/$o:EMPTY"; continue; }
    for item in $seq; do
      total=$((total+1))
      [ -f "$J/tones/${item%%:*}" ] || missing="$missing $k/$o:${item%%:*}"
    done
  done
done
rc=0; [ -z "$missing" ] || rc=1; chk "$rc" "all $total referenced notes are present" "$missing"

echo
echo "P4  the Linux and Windows branches actually invoke something"
# These cannot be run for real from macOS, but the branch that dispatches to them can:
# stub the tools, force JV_OS, and assert the right one was called with the text. The
# alternative is shipping a Linux path nobody has ever executed.
STUB="$SB/stub"; mkdir -p "$STUB"
for tool in espeak-ng spd-say paplay aplay notify-send powershell.exe wslpath; do
  printf '#!/usr/bin/env bash\necho "%s $*" >> "%s/calls.log"\n' "$tool" "$SB" > "$STUB/$tool"
  chmod +x "$STUB/$tool"
done
printf '#!/usr/bin/env bash\nprintf "C:\\\\fake\\\\%%s" "$(basename "$2")"\n' > "$STUB/wslpath"; chmod +x "$STUB/wslpath"

probe() {  # probe <os> <call> -> the logged invocation
  : > "$SB/calls.log"
  ( export PATH="$STUB:$PATH"
    . "$J/config.sh"
    . "$J/platform.sh"
    JV_OS="$1"
    # Re-resolve the PowerShell handle now that the stub is on PATH.
    # shellcheck disable=SC2034  # read by jv_say/jv_play_now after platform.sh is sourced
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
rc=0; [ "$rc" = 0 ] || rc=1; chk "$rc" "exit 0 with no engine present (rc=$rc)"
rc=0; [ -z "$out" ] || rc=1; chk "$rc" "and no output" "$out"

r=$(probe unknown 'jv_say "x"')
rc=0; [ -z "$r" ] || rc=1; chk "$rc" "an unrecognised platform calls nothing at all" "$r"

echo
echo "P6  a local neural engine can replace the built-in voice"
# The built-in voices are whatever the OS ships, and what macOS ships is a 2005-era
# synthesiser. JARVIS_TTS_CMD is the way out — but it must not become a way to break
# the layer, so a failing template has to fall back rather than go silent.
cat > "$SB/faketts" <<'TTS'
#!/usr/bin/env bash
out=""; txt=""
while [ $# -gt 0 ]; do case "$1" in --output) out="$2"; shift 2 ;; *) txt="$1"; shift ;; esac; done
printf '%s\n' "$txt" >> "$SBDIR/tts.log"
printf 'RIFF$\000\000\000WAVEfmt \020\000\000\000\001\000\001\000D\254\000\000\210X\001\000\002\000\020\000data\000\000\000\000' > "$out"
TTS
chmod +x "$SB/faketts"

: > "$SB/tts.log"
( export SBDIR="$SB"
  . "$J/config.sh"; . "$J/platform.sh"
  JARVIS_TTS_CMD="$SB/faketts --output {out} \"{text}\""
  jv_say "Done, sir. Four minutes." ) >/dev/null 2>&1
rc=0; grep -qF 'Done, sir. Four minutes.' "$SB/tts.log" || rc=1
chk "$rc" "the engine received the announcement verbatim" "$(cat "$SB/tts.log")"

# Apostrophes and quotes are ordinary in these phrasings ("that's everything, sir"),
# and the template is substituted rather than interpolated precisely so they cannot
# break the command or run anything unintended.
: > "$SB/tts.log"
( export SBDIR="$SB"
  . "$J/config.sh"; . "$J/platform.sh"
  JARVIS_TTS_CMD="$SB/faketts --output {out} \"{text}\""
  jv_say "That's everything, sir; \$(touch $SB/PWNED) done." ) >/dev/null 2>&1
rc=0; [ -e "$SB/PWNED" ] && rc=1
chk "$rc" "a shell metacharacter in the text is not executed" "$(cat "$SB/tts.log")"

# A template that fails must fall through to the built-in voice.
out=$( ( export SBDIR="$SB"
         . "$J/config.sh"; . "$J/platform.sh"
         JARVIS_TTS_CMD="/nonexistent-engine --output {out} \"{text}\""
         jv_say "fallback test" ) 2>&1 )
rc=$?
chk "$rc" "a broken engine falls back instead of erroring (rc=$rc)"
rc=0; [ -z "$out" ] || rc=1
chk "$rc" "and stays quiet on stdout" "$out"

rc=0
(
  . "$J/config.sh"; . "$J/platform.sh"
  # shellcheck disable=SC2034  # read by jv_backend_say, inside platform.sh
  JARVIS_TTS_CMD="/tmp/x --output {out} {text}"
  case "$(jv_backend_say)" in *JARVIS_TTS_CMD*) exit 0 ;; *) exit 1 ;; esac
) || rc=1
chk "$rc" "doctor reports the external engine, not the built-in voice"

# --------------------------------------------------------------------- names
echo
echo "N1  a directory basename comes out sayable"
spoken_of() (
  export JARVIS_LIB=1
  . "$J/config.sh"
  # shellcheck disable=SC2034  # read by spoken(), inside speaker.sh
  [ -n "${2:-}" ] && JARVIS_NAMES="$2"
  . "$J/platform.sh"; . "$J/speaker.sh"
  spoken "$1"
)
t() { r=$(spoken_of "$1" "${3:-}"); if [ "$r" = "$2" ]; then ok "$1 -> \"$r\""; else bad "$1 -> \"$r\", expected \"$2\""; fi; }
t "checkout"       "checkout"
t "shared_lib" "shared lib"
t "nsproto"            "nsproto"
t "wt_svc"             "S V C"                                    # worktree prefix + initialism
t "billing"            "billing"                                  # an ordinary word is left alone
t "wt_svc"             "the service tree"  "wt_svc=the service tree"  # explicit override wins

# ------------------------------------------------------------------- lengths
echo
echo "L1  announcements stay short — Stop fires after EVERY turn"
# Rendering speech to a file is the only way to measure it, and every platform does it
# differently. Where it can be done the budgets are enforced for real; where it cannot,
# the checks skip rather than pretending to pass.
speech_len=""
case "$JV_OS" in
  macos) have say && have afinfo && speech_len=macos ;;
  linux) have espeak-ng && speech_len=espeak ;;
esac
if [ -z "$speech_len" ]; then
  skip "speech-duration budgets (no TTS engine here that renders to a file)"
else
  measure() {
    case "$speech_len" in
      macos)
        say -v "${JARVIS_VOICE:-Daniel}" -r "${JARVIS_RATE:-172}" -o "$SB/len.aiff" "$1" 2>/dev/null
        afinfo "$SB/len.aiff" 2>/dev/null | awk -F': ' '/estimated duration/{printf "%.2f", $2}' ;;
      espeak)
        # espeak-ng speaks noticeably faster than macOS `say` at the same nominal wpm,
        # so the budgets below are enforced against whatever THIS engine produces —
        # the point is that an announcement stays short, not that two engines agree.
        espeak-ng -s "${JARVIS_RATE:-172}" -w "$SB/len.wav" "$1" 2>/dev/null
        node -e '
          const fs=require("fs"),b=fs.readFileSync(process.argv[1]);
          let p=12,dataLen=0,rate=b.readUInt32LE(24),bytes=b.readUInt32LE(28);
          while(p<b.length-8){const id=b.toString("ascii",p,p+4),sz=b.readUInt32LE(p+4);
            if(id==="data"){dataLen=sz;break} p+=8+sz+(sz%2)}
          process.stdout.write((dataLen/(bytes||rate*2)).toFixed(2));
        ' "$SB/len.wav" ;;
    esac
  }
  # rc MUST be reset inside the function. A mechanical rewrite hoisted `rc=0` outside the
  # definition, so it was set once for the whole run — and after the first genuine failure
  # every later budget reported FAIL regardless of its own measurement. A sticky false
  # failure is the same class of defect as a silent false pass: the assertion stops
  # answering the question it claims to.
  budget() {
    local d rc=0
    d=$(measure "$3")
    awk -v d="$d" -v m="$2" 'BEGIN{exit (d<=m)?0:1}' || rc=1
    chk "$rc" "$1 = ${d}s (budget ${2}s)"
  }
  budget "done, solo, no crew " 2.2 "Done, sir. 4 minutes."
  budget "done, solo, swarm   " 3.4 "Done, sir. 6 specialists, 4 minutes."
  budget "approval, solo      " 1.8 "Your approval, sir."
  budget "error, solo         " 1.8 "A problem, sir."
  budget "idle, solo          " 1.8 "Standing by, sir."
  budget "boot                " 3.2 "Good afternoon, sir. checkout online."
  budget "approval, 2 sessions" 2.6 "N S T needs your approval, sir."
  # A summarised completion carries real information, so it earns more seconds than
  # "task complete" — but not many more. The agent contract caps the clause at ten
  # words precisely because each word is roughly a fifth of a second of speech.
  # Every announcement now names its session, always. That costs about 1.3s and is worth
  # it: an announcement you cannot attribute is worthless to someone running four
  # projects, and the old rule — name it only when several are live — depended on
  # live-session bookkeeping that is exactly the thing most likely to be stale.
  budget "named + summary        " 4.6 "checkout: Invoice schema is in, sir. 4 minutes."
  # Six words is the contract, and this is where the number comes from: a word costs
  # about 0.38s on macOS `say`, and the name plus the duration spend two seconds before
  # the clause starts.
  #
  # The budgets carry roughly 10% headroom because they are enforced against whatever
  # engine THIS machine has, and engines differ at the same nominal words-per-minute:
  # espeak-ng renders the six-word case at 5.03s where `say` gives 4.78s. The contract
  # being asserted is "an announcement stays short", not "two synthesisers agree to the
  # centisecond" — a budget with no margin fails on a difference that is not a defect.
  budget "named + 6-word clause  " 5.4 "checkout: the invoice schema and seed data are in, sir. 4 minutes."
  budget "two in one directory   " 4.9 "checkout two: Invoice schema is in, sir. 4 minutes."
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
echo "R1  nothing unspeakable survives the pipeline"
# The readability gate. A clause that still carries a path, an underscore, a camelCase
# boundary or a fused run of letters is not a shortened announcement -- it is a
# different and meaningless one. Every example below is a real line out of the daily
# log, from before the separator fix and the pronunciation layer.
#
# The two functions are lifted with awk rather than sourced: jarvis.sh is a hook and
# sourcing it would run the hook body. (`sed -n '/^f() {/,/^}/p'` is not portable --
# BSD sed rejects the parens.)
eval "$(awk '/^speakable_separators\(\) \{/,/^\}/' "$J/jarvis.sh")"
eval "$(awk '/^clip\(\) \{/,/^\}/' "$J/jarvis.sh")"
# config.sh must be sourced here: the suite does not load it globally, so the
# pronunciation tables were EMPTY and the camelCase exemption below iterated over
# nothing -- which is why "JavaScript" was reported as an unsplit identifier.
. "$J/config.sh"
. "$J/pronounce.sh"

spoken_pipeline() {
  printf '%s' "$1" \
    | speakable_separators \
    | tr -cd "A-Za-z0-9 .,;:'-" \
    | tr -s ' ' \
    | { read -r l; pronounce "$l"; }
}

R1FAIL=""
# The tilde below is literal TEST DATA -- text to be pronounced, not a path to open --
# so it must NOT expand. Held in a variable because shellcheck SC2088 flags a quoted
# tilde as a probable mistake, and here it is the point.
LIT_TILDE='~'
for probe in \
  'updated services/shared_lib/hooks.py and the schema' \
  "$LIT_TILDE/.claude/statusline.sh: /bin/bash" \
  'billing_service_api schema is in, 3 tables' \
  'wt_svc build green; ran make migrate --env staging' \
  'getValue returned null from safe_exec' \
  'see scripts/jarvis.mjs and registry/agents.yaml'
do
  out=$(spoken_pipeline "$probe")
  case "$out" in
    */*)            R1FAIL="$R1FAIL\n    raw path survived: [$out]" ;;
  esac
  case "$out" in
    *_*)            R1FAIL="$R1FAIL\n    underscore survived: [$out]" ;;
  esac
  # A fused run: twelve or more letters with no boundary is not a word anyone says.
  if printf '%s' "$out" | grep -qE '[A-Za-z]{13,}'; then
    R1FAIL="$R1FAIL\n    unsplit identifier: [$out]"
  fi
  # An unsplit camelCase boundary -- but not in the layer's OWN vocabulary. The
  # pronunciation tables deliberately emit proper nouns like "JavaScript", which a
  # synthesiser says correctly and a naive [a-z][A-Z] check flags as an identifier.
  # Strip every table value first, so only text the layer did not choose is judged.
  probe_out="$out"
  for v in $(printf '%s;%s' "${JARVIS_EXTWORDS:-}" "${JARVIS_GLOSSARY:-}" | tr ';' '\n' | sed 's/^[^=]*=//' | tr ' ' '\n'); do
    [ -n "$v" ] && probe_out=${probe_out//"$v"/}
  done
  if printf '%s' "$probe_out" | grep -qE '[a-z][A-Z]'; then
    R1FAIL="$R1FAIL\n    unsplit camelCase: [$out]"
  fi
done
if [ -z "$R1FAIL" ]; then ok "no path, underscore, fused run or camelCase reaches speech"
else bad "unspeakable text reached speech" "$(printf '%b' "$R1FAIL")"; fi

echo
echo "R2  every variant of every event fits inside the ceiling"
# `jarvisctl audition` flags its own overruns, which is how the long error frame
# ("Something has gone wrong in <session>") was caught at 5.17s. If any variant is
# over, this fails rather than waiting for someone to notice by ear.
aud=$("$J/jarvisctl" audition --text 2>/dev/null)
# Match the MARKER on a variant line, not the closing sentence that explains it --
# "Anything marked OVER CEILING is too long..." made this test fail permanently.
over=$(printf '%s\n' "$aud" | grep -c -- '<-- OVER CEILING' || true)
lines=$(printf '%s\n' "$aud" | grep -cE '^  [a-z]' || true)
# A line with no CONTENT cannot be over the ceiling, so counting lines is not enough.
# On CI this passed with 30 renderings of ": . 4 minutes." because the runtime ignored
# JARVIS_DIR and found no config.sh -- a green check on an empty announcement.
sane=$(printf '%s\n' "$aud" | grep -cE '^  [a-z].*[0-9]+ms  .*[A-Za-z]{3,}.*\.')
if [ "${over:-0}" = "0" ] && [ "${lines:-0}" -ge 20 ] && [ "${sane:-0}" -ge 20 ]; then
  ok "$lines variants ($sane with real content), none over the ceiling"
else
  bad "a variant exceeds the ceiling, or audition produced nothing" \
      "$(printf '%s\n' "$aud" | grep -- '<-- OVER CEILING'; printf 'lines=%s sane=%s' "$lines" "$sane")"
fi

echo
echo "R3  every announcement obeys the register"
# The register is declared in config.sh as a persona, not a preference: dry,
# understated, addresses you as sir, never cheerful, never apologetic, no exclamations.
# These are the parts of it a machine can check, and each one has already been broken:
#   * two of three completions dropped "sir", so the persona addressed you on one turn
#     in three and read as two different narrators
#   * a clause dropped in after a full stop stayed lower case, which the desktop banner
#     and the daily log both render as a sentence starting mid-thought
aud=$("$J/jarvisctl" audition --text 2>/dev/null)
variants=$(printf '%s\n' "$aud" | grep -E '^  [a-z]')

R3FAIL=""
# One address per announcement -- not zero, not two.
bad=$(printf '%s\n' "$variants" | awk '{ n=gsub(/sir/,"sir"); if (n!=1) print }')
[ -z "$bad" ] || R3FAIL="$R3FAIL\n    address count not exactly one:\n$bad"

# A clause after a full stop begins a sentence.
bad=$(printf '%s\n' "$variants" | grep -oE '\. [a-z][a-z]+' | sort -u)
[ -z "$bad" ] || R3FAIL="$R3FAIL\n    lower case after a full stop: $(printf '%s' "$bad" | tr '\n' ' ')"

# Never cheerful, never apologetic, no exclamations.
bad=$(printf '%s\n' "$variants" | grep -iE '!|sorry|afraid|unfortunately|great |excellent|awesome|oops|please note')
[ -z "$bad" ] || R3FAIL="$R3FAIL\n    off-register wording:\n$bad"

if [ -z "$R3FAIL" ]; then
  ok "$(printf '%s\n' "$variants" | grep -c .) variants, all in register"
else
  bad "an announcement is off-register" "$(printf '%b' "$R3FAIL")"
fi

echo
printf 'RESULT: %s passed, %s failed, %s skipped\n' "$PASS" "$FAIL" "$SKIP"
[ "$FAIL" = 0 ] || exit 1
