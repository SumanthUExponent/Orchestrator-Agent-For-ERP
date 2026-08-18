# JARVIS tunables. Every value is overridable from the environment, so a single
# session can differ from the rest:  JARVIS_MIN_SECONDS=0 claude
#
# Edit this file to change the defaults for every session.

# "Daniel" is a macOS name — see `jarvisctl voices` for what you have. On Linux and
# Windows, leave this empty or set a name from `jarvisctl voices` for your platform.
# EMPTY has its own meaning: use the System Voice, which is the only way to reach a
# Siri voice on macOS. `jarvisctl voices --setup` explains that.
JARVIS_VOICE="${JARVIS_VOICE:-Daniel}"

# One voice per parallel session, pipe-separated, in start order. Four sessions in four
# voices is far easier to tell apart than four pitches of one voice — you recognise a
# voice without having to remember what slot 3 sounded like. Names that are not
# installed fall back to JARVIS_VOICE, and `jarvisctl doctor` says which did.
# Leave empty to use JARVIS_VOICE for everything.
#   macOS:   "Daniel|Karen|Reed (English (UK))|Sandy (English (UK))"
#            Run `jarvisctl voices` and paste the names EXACTLY as listed — the
#            qualifier is part of the name, and `say` silently falls back to a US
#            voice for a name it does not have.
#   Windows: "Microsoft George Desktop|Microsoft Hazel Desktop"
JARVIS_VOICES="${JARVIS_VOICES:-}"

# THE SINGLE BIGGEST THING YOU CAN CHANGE ABOUT HOW THIS SOUNDS.
#
# Built-in voices are whatever the OS happens to ship, and what macOS ships by default
# is a 2005-era synthesiser — the "compact" set. It sounds mechanical because it is.
# Two ways out, both free and both entirely offline:
#
#  1. macOS: download a Siri or Premium voice (`jarvisctl voices --setup`). Free, about
#     three times more natural. A Siri voice cannot be selected by name, so set it as
#     your System Voice and put JARVIS_VOICE="system" above.
#
#  2. Any platform: point this at a local neural engine. {out} is a .wav to write,
#     {text} is what to say. No account, no API, nothing leaves the machine.
#
#     Kokoro — 82M parameters, the best quality-per-megabyte available locally:
#       JARVIS_TTS_CMD='kokoro-tts --voice bm_george --output {out} "{text}"'
#     Piper — faster and smaller, but noticeably more robotic:
#       JARVIS_TTS_CMD='piper --model /path/en_GB-alan-medium.onnx --output_file {out} <<< "{text}"'
#
# If the command fails, the built-in voice still speaks: a broken template must never
# make the whole layer go quiet.
JARVIS_TTS_CMD="${JARVIS_TTS_CMD:-}"

# Convenience for piper specifically, if you would rather not write the template above.
JARVIS_PIPER_MODEL="${JARVIS_PIPER_MODEL:-}"
JARVIS_RATE="${JARVIS_RATE:-172}"                 # wpm. 165-180 reads as composed
JARVIS_ADDRESS="${JARVIS_ADDRESS:-sir}"           # "" for none
JARVIS_VOLUME="${JARVIS_VOLUME:-0.7}"             # chime volume, 0.0-1.0

# Stop fires after EVERY turn, not just long ones. Under this many seconds the
# turn gets a two-tone tick and no speech — otherwise asking the time gets
# announced as a completed task.
JARVIS_MIN_SECONDS="${JARVIS_MIN_SECONDS:-25}"

# A completion announced 90s late is noise, not information. Non-urgent items
# older than this are discarded rather than queued behind the backlog.
JARVIS_STALE="${JARVIS_STALE:-50}"

# Blocked-on-approval is the expensive failure: three sessions working while a
# fourth waits silently. Re-announce this many times, at this interval.
JARVIS_NAG="${JARVIS_NAG:-2}"
JARVIS_NAG_AFTER="${JARVIS_NAG_AFTER:-70}"

# After the nags are spent and a session is STILL blocked, escalate once: the loudest
# motif in the set, the duration spoken aloud, and a banner. Once only — repeating it
# would turn the most important alert into background noise. 0 disables.
JARVIS_ESCALATE="${JARVIS_ESCALATE:-300}"

# SubagentStop fires once per specialist. With a swarm dispatching batches of
# four that is four announcements for one batch, so speech is NOT the default:
#   silent  nothing
#   chime   one soft tone per batch (bursts coalesce)   <- default
#   speak   announce each one. Only sane with 1-2 agents
JARVIS_SUBAGENT="${JARVIS_SUBAGENT:-chime}"

# A directory basename is not a word. `say` renders "wt_nst" as two nonsense
# syllables, and "exponent_utilities" takes 1.6s to get through. Map the ones you
# actually run to something speakable:  "wt_nst=N S T;frappe-bench=bench"
# Without an entry, underscores and hyphens become spaces and a leading "wt " (the
# worktree prefix) is dropped.
JARVIS_NAMES="${JARVIS_NAMES:-}"

# Speak what the agents actually DID, rather than only that a turn ended.
#
# Every orchestrator agent is required to end its output with a line reading
# "VOICE: <one clause>", and those clauses are collected and read out on completion:
#
#   without:  "Done, sir. Six specialists, four minutes."          3.5s
#   with:     "Vendor Audit schema is in, sir. Four minutes."       2.8s
#
# The count of specialists disappears when there is a summary — it only ever existed
# because there was nothing better to say. 0 disables and restores the short form.
JARVIS_SUMMARY="${JARVIS_SUMMARY:-1}"

# How many of those clauses to speak. One, by default, and deliberately: a swarm run can
# dispatch a dozen, each clause costs roughly two seconds of speech, and `Stop` fires
# after every turn. Two is a reasonable choice if you want more detail and can live with
# announcements around four seconds instead of under three.
JARVIS_SUMMARY_MAX="${JARVIS_SUMMARY_MAX:-1}"

# Count the specialists a turn dispatched and mention it in the completion, so
# "six specialists, four minutes" distinguishes a swarm run from a one-liner.
JARVIS_COUNT_SUBAGENTS="${JARVIS_COUNT_SUBAGENTS:-1}"
