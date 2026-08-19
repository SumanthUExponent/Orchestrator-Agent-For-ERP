# JARVIS tunables. Every value is overridable from the environment, so a single
# session can differ from the rest:  JARVIS_MIN_SECONDS=0 claude
#
# Edit this file to change the defaults for every session.

# "Daniel" is a macOS name — see `jarvisctl voices` for what you have. On Linux and
# Windows, leave this empty or set a name from `jarvisctl voices` for your platform.
# EMPTY has its own meaning: use the System Voice, which is the only way to reach a
# Siri voice on macOS. `jarvisctl voices --setup` explains that.
JARVIS_VOICE="${JARVIS_VOICE:-Daniel}"

# ONE voice, deliberately. Leave this empty.
#
# An earlier version gave each parallel session its own voice, on the reasoning that a
# voice is easier to recognise than a pitch. In use that is wrong: four voices read as
# four different PEOPLE, which breaks the single-assistant model the whole thing rests
# on. You are not meant to be tracking four narrators — you are meant to have one
# assistant with an eye on everything, telling you which session it is talking about.
#
# The session name in the sentence is the identifier, and the chime pitch is a second
# cue underneath it. That is enough, and it costs no learning.
#
# The mechanism is still here if you want it — pipe-separated, in session start order —
# but it is off by default and not recommended.
#   macOS:   "Daniel|Karen|Reed (English (UK))|Sandy (English (UK))"
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
# Every JARVIS agent is required to end its output with a line reading
# "VOICE: <one clause>", and those clauses are collected and read out on completion:
#
#   without:  "Done, sir. Six specialists, four minutes."          3.5s
#   with:     "Vendor Audit schema is in, sir. Four minutes."       2.8s
#
# The count of specialists disappears when there is a summary — it only ever existed
# because there was nothing better to say. 0 disables and restores the short form.
JARVIS_SUMMARY="${JARVIS_SUMMARY:-1}"

# When no agent left a VOICE clause — which is every ordinary turn, since the main
# thread emits no markers — fall back to the opening sentence of its own final message.
# It is a decent summary of a turn and costs nothing. 0 restores the short form.
JARVIS_FALLBACK_SUMMARY="${JARVIS_FALLBACK_SUMMARY:-1}"

# When several specialists reported, the one that mentions a problem is spoken — the
# agent contract tells them to lead with one, and it is the only thing here worth
# interrupting you for. Failing that, the LAST clause: in a requirements-design-build-test
# pipeline the first agent to finish is the least conclusive.
#
# How many of those clauses to speak. One, by default, and deliberately: a swarm run can
# dispatch a dozen, each clause costs roughly two seconds of speech, and `Stop` fires
# after every turn. Two is a reasonable choice if you want more detail and can live with
# announcements around four seconds instead of under three.
JARVIS_SUMMARY_MAX="${JARVIS_SUMMARY_MAX:-1}"

# Count the specialists a turn dispatched and mention it in the completion, so
# "six specialists, four minutes" distinguishes a swarm run from a one-liner.
JARVIS_COUNT_SUBAGENTS="${JARVIS_COUNT_SUBAGENTS:-1}"

# Whether to SPEAK a completion that has nothing to report.
#
# This is the difference between a useful assistant and a talkative one. Running four
# sessions, `Stop` fires constantly, and "Done, sir. Three minutes." carries no
# information at all — it is the announcement that made the layer feel noisy.
#
#   auto  speak it only when ONE session is live; when several are, tick instead and
#         save the voice for turns that actually have something to say   <- default
#   1     always speak, informative or not
#   0     never speak a completion without a summary; tick every time
#
# Blocked approvals, errors and escalations always speak. Those are actionable.
JARVIS_SPEAK_WITHOUT_SUMMARY="${JARVIS_SPEAK_WITHOUT_SUMMARY:-auto}"

# Speak what is still outstanding as each session closes: "N S T closing, sir. Pending:
# the permissions matrix still needs an Auditor role." A session that finished cleanly
# says nothing — the farewell already reports the totals. The FULL record is always
# written either way; read it with `jarvisctl brief`. 0 disables the spoken part.
JARVIS_BRIEF="${JARVIS_BRIEF:-1}"

# A single markdown file per day, in ~/.claude/jarvis/daily/, recording every completed
# turn across EVERY session — what was done, how long it took, and what was left pending
# when each session closed. Written as work happens rather than assembled at the end, so
# a killed terminal cannot take the day with it.
#
# It records more than the voice announces: a turn the voice stays quiet about is still a
# turn that happened. Read it back with `jarvisctl yesterday`. 0 disables.
JARVIS_DAILY_LOG="${JARVIS_DAILY_LOG:-1}"

# One line at the very end of the day, when the last session closes: how many turns
# there were across ALL sessions, and whether anything is still outstanding. 0 disables.
JARVIS_DAY_DIGEST="${JARVIS_DAY_DIGEST:-1}"

# ============================================================== PRONUNCIATION
# How the voice says things that were written for the eye rather than the ear.
#
# JARVIS_NAMES above fixes ONE case: the session name. Everything else in an
# announcement went out raw, which is why the log is full of lines like
# "appsexponentutilitieshooks.py" and "wtnst build green". These five tables
# generalise it to every word spoken.
#
# All five are DATA in the same "k=v;k=v" shape as JARVIS_NAMES, so vocabulary is
# extended by editing a string — never by editing shell. Every one is
# environment-overridable, so a single session can differ from the rest.
#
# Anything a rule produces must already be inside the speech allowlist
# ("A-Za-z0-9 .,;:'-"). A pronunciation that needs a forbidden character does not
# ship — the allowlist wins, always.

# Said one letter at a time. "E R P" is right; "erp" is a noise.
JARVIS_SPELL_OUT="${JARVIS_SPELL_OUT:-ERP;UAT;QA;API;CRM;PR;UI;DB;SQL;CI;CD;NST;LMS;NSS;ECR;ECN;BOM;PDF;CSV;JSON;YAML;HTML;CSS;URL;SSH;TTS;VS;IDE;SPA;JS;TS;GL;PO;SO;HR}"

# Genuine words, even though they are capitalised. Do NOT spell these out.
JARVIS_SAY_AS_WORD="${JARVIS_SAY_AS_WORD:-ERPNext;JARVIS;SCADA;CRUD;JSON5;REST;SOAP;CRON;SASS;JIRA}"

# Words the synthesiser gets audibly wrong, and domain terms with a settled
# pronunciation. Matched whole-word, case-insensitively.
JARVIS_GLOSSARY="${JARVIS_GLOSSARY:-frappe=frappay;erpnext=E R P next;doctype=doc type;doctypes=doc types;macdev=mac dev;wsldev=W S L dev;crmdev=C R M dev;nginx=engine X;venv=v env;cwd=working directory;env=environment;repo=repository;auth=auth;jinja=jinja;bench=bench;fixture=fixture;fixtures=fixtures;workflow=workflow;async=a sync;regex=regex;stdout=standard out;stderr=standard error;npm=N P M;mjs=M J S}"

# Named files that deserve a name rather than a filename. Matched on the whole token.
JARVIS_FILEWORDS="${JARVIS_FILEWORDS:-hooks.py=the hooks file;settings.json=the settings file;package.json=the package file;claude.md=the CLAUDE file;config.sh=the config file;hooks.py=the hooks file;pyproject.toml=the project file;modules.txt=the modules list}"

# Fallback for any other FILE.EXT token: the extension becomes a noun, so
# "statusline.sh" is "the statusline shell script" and never "statusline dot s h".
JARVIS_EXTWORDS="${JARVIS_EXTWORDS:-py=Python file;js=JavaScript file;mjs=JavaScript file;ts=TypeScript file;json=config file;sh=shell script;md=markdown file;txt=text file;yaml=config file;yml=config file;toml=config file;css=stylesheet;html=page;vue=component;sql=S Q L file;log=log file}"

# ---------------------------------------------------------------------------
# Session context — the per-session handoff document
#
# Distinct from the daily log above. The daily log is one line per turn across
# every session and answers "what did I do today". This is one document per
# session and answers "what was this for, what was decided, and what is still
# open" — the questions a FUTURE session needs answered before it can be useful.
#
#   jarvisctl context [project]     what is still open, per project
#   jarvisctl context --reindex     rebuild INDEX.md from the documents
#   /load-context <name>            pull one document into a conversation
# ---------------------------------------------------------------------------

# Master switch. 0 disables every part of it; the voice layer is unaffected.
JARVIS_CTX="${JARVIS_CTX:-1}"

# Where the documents live. Deliberately NOT inside a git repository: they are
# machine-local, they carry absolute paths and session ids, they change on every
# turn, and the secret filter is a mitigation rather than a guarantee.
JARVIS_CTX_DIR="${JARVIS_CTX_DIR:-$HOME/frappe-bench/Referencedocs/CLI-Session-Context}"

# Path to context.mjs. EMPTY is the normal value and is not a missing setting: the
# hook then resolves it itself, preferring the copy installed beside it by
# `voice --apply` and falling back to the skills install, so either installer alone
# is sufficient. Set this only to point at a checkout somewhere else.
JARVIS_CTX_MJS="${JARVIS_CTX_MJS:-}"

# A document past this many lines has stopped being a handoff and become an
# archive. Over the cap the TURN LOG is compressed from the old end; decisions,
# gotchas, open threads and compaction snapshots are never dropped.
JARVIS_CTX_MAX_LINES=${JARVIS_CTX_MAX_LINES:-400}

# A session with fewer meaningful turns than this, and nothing else recorded,
# produces no file at all. Silence is the correct record for "nothing happened".
JARVIS_CTX_MIN_TURNS=${JARVIS_CTX_MIN_TURNS:-2}

# How many prior sessions the SessionStart pointer may name. It is a pointer, not
# content — the documents themselves are never injected without being asked for.
JARVIS_CTX_POINTER_MAX=${JARVIS_CTX_POINTER_MAX:-3}

# --- the model pass over a discarded compaction window ---------------------
#
# Deterministic extraction recovers the FACTS from a window that is about to be
# discarded — which files changed, which commands ran, what was asked. It cannot
# recover a decision's REASONING unless an agent emitted a marker, and the main
# thread emits none. This is the one place in the system where a model call is
# the honest answer rather than a shortcut, so it is ON.
#
# It never blocks: the snapshot is written with the deterministic facts first and
# this runs detached, appending its lines when they arrive. No `claude` on PATH
# means it silently does not happen and nothing else changes.
#
# Cost, at Haiku 4.5 pricing ($1/MTok in, $5/MTok out): a window stripped of tool
# results runs 20-40k input tokens and returns under 200 out, so roughly $0.02
# to $0.04 per compaction. The daily cap bounds the worst case well under $1.
JARVIS_CTX_SUMMARY="${JARVIS_CTX_SUMMARY:-1}"
JARVIS_CTX_SUMMARY_MODEL="${JARVIS_CTX_SUMMARY_MODEL:-claude-haiku-4-5-20251001}"

# Floor: a window smaller than this is not worth a request. Roughly 4k tokens.
JARVIS_CTX_SUMMARY_MIN_CHARS="${JARVIS_CTX_SUMMARY_MIN_CHARS:-16000}"

# Ceiling, per day, across every session. A pathological day must not run away.
# Both this and the floor are RECORDED in the document when they bite — a silent
# cap reads as "there was nothing to say", which is a different claim entirely.
JARVIS_CTX_SUMMARY_DAILY_MAX="${JARVIS_CTX_SUMMARY_DAILY_MAX:-20}"

# How long a single summarisation may run before it is killed. There is no portable
# `timeout(1)` -- macOS ships none -- so the call carries its own watchdog. Without
# one, a hung request leaves a stray process per compaction and nothing notices it.
JARVIS_CTX_SUMMARY_TIMEOUT="${JARVIS_CTX_SUMMARY_TIMEOUT:-120}"

# ================================================================ THE REGISTER
# What JARVIS sounds like, written down so a new phrase can be judged against it
# rather than against taste. Printed by `jarvisctl audition`, which is where you
# check variants by ear.
#
# Dry, understated, economical. Addresses you as sir. Never cheerful, never
# apologetic, never cute. No exclamations. States what happened and stops.
#
# A variant that would not pass as something a composed human assistant would say
# does not ship. Vary the WORDING; never vary the register.
JARVIS_REGISTER="${JARVIS_REGISTER:-dry, understated, economical; addresses you as sir; never cheerful, never apologetic, never cute; no exclamations}"

# ------------------------------------------------------- adaptive clause budget
# Six words fixed is why everything sounded clipped. The budget is now per event
# class, because the announcements are not equally worth listening to.
#
# In WORDS. A word costs ~0.38s of speech, and the frame around your clause (the
# session name, the elapsed time) spends ~2s before it starts. Past about five
# seconds nobody is still listening, which is what sets the ceiling:
#
#   routine 10 words  -> ~3.8s clause, in practice capped by the ceiling below
#   problem  9 words  -> ~2.8s clause, capped by the ceiling below
#   blocked  9 words  -> ~2.8s clause, likewise
#
# Twelve was the first guess and it does not fit: measuring showed the frame costs
# about 2.2s, so inside a 5s ceiling there are only ~2.8s of clause to spend, whatever
# the word allowance says. "A problem earns more words" is 9 against 6, not 12.
#
# A routine completion stays terse. A problem, or a session blocked on approval,
# earns the words -- that is the announcement you actually want to hear.
JARVIS_BUDGET_ROUTINE="${JARVIS_BUDGET_ROUTINE:-10}"
JARVIS_BUDGET_PROBLEM="${JARVIS_BUDGET_PROBLEM:-9}"
JARVIS_BUDGET_BLOCKED="${JARVIS_BUDGET_BLOCKED:-9}"

# The hard ceiling on ONE announcement, and the time its frame costs.
#
# The frame is the session name, ", sir", and the elapsed time -- everything around the
# clause. Measured at about 2.2s across every event type, which is why a clause budget
# alone was not enough: a 12-word problem clause put the whole announcement at 5.54s.
# The effective clause budget is CEILING minus FRAME, and whichever of that and the
# per-class word allowance is tighter wins.
JARVIS_CEILING_MS="${JARVIS_CEILING_MS:-5000}"
JARVIS_FRAME_MS="${JARVIS_FRAME_MS:-2200}"

# The gap between the modelled cost and what `afinfo` actually reports.
#
# The model counts letters, spelled letters, digits and pauses, and it under-reads by
# roughly a fifth -- prosody, breath and phrase-final lengthening are not in it. Rather
# than pretend the model is exact, the fitting check aims this far below the ceiling.
# Measured, not tuned: two of three completions came out at 5.3s against a 5.0s ceiling.
JARVIS_MODEL_SLACK_MS="${JARVIS_MODEL_SLACK_MS:-800}"
