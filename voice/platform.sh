#!/bin/bash
# Platform abstraction. Everything that touches the operating system lives here, so
# speaker.sh contains no `say` and no `afplay` and never asks what OS it is on.
#
# Three capabilities, in descending order of importance:
#   jv_say <text>            block until spoken. Blocking is required: it is what
#                            serialises the announcements
#   jv_play_at <file> <secs> schedule one tone
#   jv_notify <title> <msg>  a desktop banner, if the platform has one
#
# Design note that matters more than the backends: the TONES ARE PRE-SYNTHESISED as
# plain WAV files, with pitch, envelope and loudness already baked in (see
# scripts/tones.mjs). The first version resampled macOS system sounds with `afplay -r`
# and set gain with `-v`, neither of which exists on Linux, and `aplay` and Windows'
# SoundPlayer have no volume control at all. Baking the shaping into the file reduces
# playback to "play this", which every platform can do — and it is also more precise
# than resampling, because the frequency and decay are chosen rather than inherited.

JV_OS=unknown
case "$(uname -s 2>/dev/null)" in
  Darwin)  JV_OS=macos ;;
  Linux)
    # WSL is Linux, but its audio and speech come from the Windows side.
    if grep -qiE '(microsoft|wsl)' /proc/version 2>/dev/null; then JV_OS=windows; else JV_OS=linux; fi ;;
  CYGWIN*|MINGW*|MSYS*) JV_OS=windows ;;
esac

have() { command -v "$1" >/dev/null 2>&1; }

# ------------------------------------------------------------------ Windows glue
# PowerShell is reached differently from WSL and from Git Bash, and a path handed to
# it must be a Windows path in both cases.
JV_PS=""
for c in powershell.exe pwsh.exe powershell; do have "$c" && { JV_PS="$c"; break; }; done

jv_winpath() {
  if have wslpath;   then wslpath -w "$1" 2>/dev/null && return; fi
  if have cygpath;   then cygpath -w "$1" 2>/dev/null && return; fi
  printf '%s' "$1"
}
# Single quotes are PowerShell's literal string; the only escape inside one is ''.
jv_psquote() { printf '%s' "$1" | sed "s/'/''/g"; }

# --------------------------------------------------------------------- speech
# macOS takes words per minute; SAPI takes -10..10 and Linux engines take their own
# scale. Convert from the single JARVIS_RATE the user sets, so the config means the
# same thing everywhere.
jv_rate_sapi()  { awk -v w="${JARVIS_RATE:-172}" 'BEGIN{r=int((w-175)/17+0.5); if(r<-10)r=-10; if(r>10)r=10; print r}'; }
jv_rate_espeak(){ printf '%s' "${JARVIS_RATE:-172}"; }   # espeak already speaks in wpm

jv_say() {
  local t="$1"
  # macOS-only inline markup. Elsewhere it would be READ ALOUD as "bracket bracket
  # s l n c", so it is stripped rather than left to embarrass itself.
  [ "$JV_OS" = macos ] || t=$(printf '%s' "$t" | sed 's/\[\[[^]]*\]\]//g; s/  */ /g')
  case "$JV_OS" in
    macos)
      say -v "${JARVIS_VOICE:-Daniel}" -r "${JARVIS_RATE:-172}" "$t" 2>/dev/null ;;
    windows)
      [ -n "$JV_PS" ] || return 0
      local q; q=$(jv_psquote "$t")
      local v; v=$(jv_psquote "${JARVIS_VOICE:-Microsoft George Desktop}")
      # SelectVoice throws if the voice is absent, so it is attempted and ignored —
      # a default voice is a far better outcome than no announcement.
      "$JV_PS" -NoProfile -NonInteractive -Command \
        "Add-Type -AssemblyName System.Speech; \$s = New-Object System.Speech.Synthesis.SpeechSynthesizer; try { \$s.SelectVoice('$v') } catch {}; \$s.Rate = $(jv_rate_sapi); \$s.Speak('$q')" \
        >/dev/null 2>&1 ;;
    linux)
      # -w waits, which is the whole point: without blocking, announcements overlap
      # and the single-drainer guarantee is worthless.
      if   have spd-say;   then spd-say -w -r "$(awk -v w="${JARVIS_RATE:-172}" 'BEGIN{r=int((w-175)*0.6); if(r<-100)r=-100; if(r>100)r=100; print r}')" "$t" 2>/dev/null
      elif have espeak-ng; then espeak-ng -v "${JARVIS_VOICE_LINUX:-en-gb-x-rp}" -s "$(jv_rate_espeak)" "$t" 2>/dev/null
      elif have espeak;    then espeak    -v "${JARVIS_VOICE_LINUX:-en-gb}"      -s "$(jv_rate_espeak)" "$t" 2>/dev/null
      elif have festival;  then printf '%s\n' "$t" | festival --tts 2>/dev/null
      elif have pico2wave; then
        local w; w=$(mktemp /tmp/jv-XXXXXX.wav)
        pico2wave -l en-GB -w "$w" "$t" 2>/dev/null && jv_play_now "$w"
        rm -f "$w"
      fi ;;
  esac
  return 0
}

# ---------------------------------------------------------------------- audio
# One shot, blocking. Tones are short so this is measured in tens of milliseconds.
jv_play_now() {
  [ -f "$1" ] || return 0
  case "$JV_OS" in
    macos) afplay "$1" 2>/dev/null ;;
    windows)
      [ -n "$JV_PS" ] || return 0
      local w; w=$(jv_winpath "$1")
      "$JV_PS" -NoProfile -NonInteractive -Command \
        "(New-Object Media.SoundPlayer '$(jv_psquote "$w")').PlaySync()" >/dev/null 2>&1 ;;
    linux)
      if   have paplay; then paplay "$1" 2>/dev/null
      elif have aplay;  then aplay -q "$1" 2>/dev/null
      elif have ffplay; then ffplay -nodisp -autoexit -loglevel quiet "$1" 2>/dev/null
      elif have mpv;    then mpv --really-quiet --no-video "$1" 2>/dev/null
      elif have play;   then play -q "$1" 2>/dev/null
      elif have cvlc;   then cvlc --intf dummy --play-and-exit --quiet "$1" 2>/dev/null
      fi ;;
  esac
  return 0
}

# jv_play_at <file> <delay-seconds> — schedule a tone inside a motif.
jv_play_at() {
  ( [ "${2:-0}" != "0" ] && sleep "$2"; jv_play_now "$1" ) &
}

# --------------------------------------------------------------- notifications
jv_notify() {
  case "$JV_OS" in
    macos)
      osascript -e "display notification \"$2\" with title \"J.A.R.V.I.S. - $1\"" >/dev/null 2>&1 & ;;
    linux)
      have notify-send && notify-send "J.A.R.V.I.S. - $1" "$2" >/dev/null 2>&1 & ;;
    windows)
      [ -n "$JV_PS" ] || return 0
      # BurntToast is not installed by default and there is no dependency-free toast
      # from PowerShell 5, so a missing module is a silent no-op. The banner is the
      # least important of the three channels; the speech already carried the message.
      "$JV_PS" -NoProfile -NonInteractive -Command \
        "if (Get-Module -ListAvailable -Name BurntToast) { Import-Module BurntToast; New-BurntToastNotification -Text 'J.A.R.V.I.S. - $(jv_psquote "$1")', '$(jv_psquote "$2")' }" \
        >/dev/null 2>&1 & ;;
  esac
  return 0
}

# ------------------------------------------------------------------- reporting
# What `jarvisctl doctor` prints. Names the backend actually selected, because "no
# sound" is otherwise indistinguishable from "wrong backend chosen".
jv_backend_say() {
  case "$JV_OS" in
    macos) echo "say (${JARVIS_VOICE:-Daniel})" ;;
    windows) [ -n "$JV_PS" ] && echo "$JV_PS + System.Speech" || echo "NONE — no powershell on PATH" ;;
    linux)
      for c in spd-say espeak-ng espeak festival pico2wave; do have "$c" && { echo "$c"; return; }; done
      echo "NONE — install espeak-ng or speech-dispatcher" ;;
    *) echo "NONE — unsupported platform" ;;
  esac
}
jv_backend_play() {
  case "$JV_OS" in
    macos) echo "afplay" ;;
    windows) [ -n "$JV_PS" ] && echo "$JV_PS + Media.SoundPlayer" || echo "NONE — no powershell on PATH" ;;
    linux)
      for c in paplay aplay ffplay mpv play cvlc; do have "$c" && { echo "$c"; return; }; done
      echo "NONE — install pulseaudio-utils or alsa-utils" ;;
    *) echo "NONE — unsupported platform" ;;
  esac
}
jv_backend_notify() {
  case "$JV_OS" in
    macos) echo "osascript" ;;
    linux) have notify-send && echo "notify-send" || echo "none (optional)" ;;
    windows) echo "BurntToast if installed (optional)" ;;
    *) echo "none" ;;
  esac
}
