#!/usr/bin/env bash
# JARVIS hook entry point. Runs on EVERY hook event, so it must stay cheap.
#
# It does not speak. It writes one queue file and exits. Speaking from inside the
# hook is what makes parallel sessions unintelligible: two `say` calls on macOS do
# not queue, they play simultaneously. All audio goes through speaker.sh, of which
# exactly one instance exists.
#
# Cost discipline: no python3, no jq, no cksum on the common path. Session id is
# extracted with bash parameter expansion, and the session's ordinal is assigned
# once at startup rather than hashed on every event.
#
# Always exits 0. A notification system that can block a tool call is a liability.

# JARVIS_DIR, with the historical name as a fallback. The installer has always
# honoured this variable; the runtime scripts did not, so an install anywhere but
# the default silently found no config.sh, no tones and no state -- and said
# nothing about it, because every lookup is guarded. CI installs to a temp dir,
# which is how an audition that rendered ": . 4 minutes." got past a ceiling check.
J="${JARVIS_DIR:-${CLAUDE_JARVIS_DIR:-$HOME/.claude/jarvis}}"
[ -f "$J/config.sh" ] && . "$J/config.sh"

Q="$J/queue"; S="$J/state"
mkdir -p "$Q" "$S/active" "$S/start" "$S/pending" "$S/subs" "$S/notes" "$S/inflight" "$S/swarm" \
         "$J/ledger" \
         "$S/done" "$S/todo" "$S/heads" "$S/cwd" "$S/ctxj" "$S/ctx" \
         "$J/briefings" "$J/daily" "$J/run" 2>/dev/null

MODE="$1"

# Drain the event JSON. If a script does not read stdin, invoking it by hand
# hangs on a read that never completes.
IN=""
[ -t 0 ] || IN=$(cat 2>/dev/null)

# session_id, without spawning anything. Two sessions in one repo are then
# distinct — keying on $PWD alone silently merges them.
SID=""
case "$IN" in
  *'"session_id"'*)
    SID=${IN#*\"session_id\":\"}
    SID=${SID%%\"*}
    ;;
esac

# The spoken summary an agent left for us.
#
# Stop and SubagentStop both carry `last_assistant_message` — the agent's final text —
# and the documentation is explicit that this is what hooks should read, because the
# transcript file is written asynchronously and lags the conversation.
#
# Only the marker line is wanted, the marker is ASCII, and a newline inside a JSON
# string is the two characters backslash-n. So the line is isolated by hand rather than
# by parsing JSON: a `node` or `python3` spawn on a hook that fires after every turn and
# every specialist is a cost paid constantly for a value already in reach.
#
# The result is filtered to an ALLOWLIST, not escaped. It is about to be handed to a
# speech synthesiser and carried through a pipe-delimited queue line, and an agent's
# output is not a trusted input — so anything that is not plain speech is dropped.
# marker_note <MARKER>  — pull one clause out of the hook payload.
#
# VOICE is the outcome, spoken at the end of the turn. PENDING and HEADS-UP are
# optional and are read back at the END OF THE SESSION, where the audience is someone
# deciding whether they can walk away, or picking the work up tomorrow.
#
# The marker must BEGIN A LINE, and be among the LAST few lines of the message — which
# is exactly what the contract asks agents for. Without that anchor, prose ABOUT the
# contract is harvested as though it were a real summary: explaining the format in a
# reply put "Material Movement schema is in" and a mangled half-sentence into a live
# session's briefing. Documentation must not be mistaken for data.
#
# The clause is then filtered through an ALLOWLIST, not escaped. It is about to be read
# aloud and carried through a pipe-delimited queue line, and agent output is not a
# trusted input, so anything that is not plain speech is dropped.
# Make word separators AUDIBLE before the allowlist deletes them.
#
# The allowlist below is `tr -cd`, which DELETES. It does not substitute. So an
# identifier or a path arriving here unprepared does not lose its separators — it
# loses its word boundaries, and the tokens either side fuse into one
# unpronounceable blob:
#
#   apps/exponent_utilities/hooks.py  ->  appsexponentutilitieshooks.py
#   frappe_exponent_crm schema is in  ->  frappeexponentcrm schema is in
#   ~/.claude/statusline.sh: /bin/bash -> .claudestatusline.sh: binbash
#
# All three are real lines out of the daily log. This runs FIRST so the allowlist
# only ever sees text that is already spoken words. It does not widen the
# allowlist: every character it emits was already permitted.
#
# A handful of symbols carry meaning that deletion silently destroys, so they
# become the word they stand for rather than nothing. "Typo cladue -> claude"
# was being spoken as "Typo cladue claude", which reverses nothing and explains
# nothing. One awk pass, because sed's handling of multibyte literals and of
# escapes in the replacement differs between BSD and GNU.
speakable_separators() {
  awk '{
    gsub(/→/,  " to ")   # a literal arrow: \x escapes are silently inert in BWK awk
    gsub(/->/,  " to ")
    gsub(/=>/,  " to ")
    gsub(/&/,   " and ")
    gsub(/%/,   " percent ")
    gsub(/\+/, " plus ")
    gsub(/[_\/\\|]/, " ")
  } 1'
}

# Cap a clause without cutting a word in half.
#
# `${v:0:140}` cuts blind. Fourteen of the thirty entries in the daily log end
# mid-word — "...and an appsapp cw" — which a synthesiser reads as a nonsense
# syllable and then stops. Back off to the last space instead, and close the
# clause so it does not trail off in mid-air.
clip() {
  local s="$1" max="${2:-140}"
  if [ ${#s} -gt "$max" ]; then
    s="${s:0:$max}"
    case "$s" in *' '*) s="${s% *}" ;; esac
  fi
  # Trailing separators only. NO terminal full stop: the clause is a FRAGMENT that
  # render() embeds in a frame -- "$who: $summary$SIR. $(dur)." -- so a self-terminated
  # clause produces "schema is in., sir." Sentence punctuation belongs to the template
  # that owns the whole sentence, not to the piece being dropped into it.
  s="${s%"${s##*[!,;: ]}"}"
  printf '%s' "$s"
}

# marker_note <MARKER> [doc]
#
# The optional second argument selects the FILTER, not the extraction. Everything
# about finding the clause — the terminal-marker rule, the JSON unwrapping — is
# identical and must stay in one place, but the two consumers need different text:
#
#   (default)  speech. `speakable_separators` then a hard ALLOWLIST, because the
#              clause is about to be handed to a synthesiser and carried through a
#              pipe-delimited queue line.
#   doc        the handoff document. `apps/foo/hooks.py` must survive as a path;
#              running it through the speech allowlist would render it "apps foo
#              hooks.py", which is correct to SAY and useless to READ. Only the two
#              characters that would corrupt a JSON line are dropped.
#
# DECISION and GOTCHA are document-only and are never spoken, so they always take
# the second path.
marker_note() {
  local marker="$1" v filter="${2:-speech}"
  case "$IN" in *"$marker":*) ;; *) return 1 ;; esac
  # A marker qualifies only if it is TERMINAL: every non-empty line after it is another
  # marker, or the JSON tail. That is precisely what the contract asks agents for, and it
  # is the only rule that separates a real handoff from prose ABOUT the format.
  #
  # A line-anchor is not enough, and neither is a last-N-lines window — explaining the
  # contract in a reply puts the markers inside a fenced block three lines from the end,
  # and both rules harvested it. "Material Movement schema is in" and a mangled
  # half-sentence went into a live session's briefing that way.
  #
  # The field opener becomes a line break too, so a message that STARTS with the marker
  # is still line-anchored — otherwise the marker sits mid-line in the raw JSON and the
  # anchor never matches. awk for both substitutions, deliberately: `sed 's/\\n/\n/'`
  # puts a literal n in the replacement on BSD sed and a newline on GNU, so it would
  # behave differently on macOS and Linux.
  v=$(printf '%s' "$IN" \
      | awk '{ gsub(/"last_assistant_message":"/, "\n"); gsub(/\\n/, "\n") } 1' \
      | awk 'NF' \
      | awk -v M="$marker" '
          { line[++n] = $0 }
          END {
            i = n
            # Skip the JSON tail. Two shapes, and only the first was handled:
            #
            #   last_assistant_message LAST   -> tail line is `"}`      matched
            #   last_assistant_message FIRST  -> tail line is `","hook_event_name":"Stop"}`
            #
            # The second shape appears whenever the message ends with a newline AND any
            # field follows it in the payload -- and then NO marker was ever harvested,
            # for VOICE, PENDING, HEADS-UP, DECISION, GOTCHA and LOG alike. Silently:
            # the hook exits 0 and the announcement falls back to the terse form. Every
            # existing test happened to put the message last, so nothing caught it.
            while (i > 0 && (line[i] ~ /^["}\]]+,?$/ || line[i] ~ /^",/)) i--
            while (i > 0 && line[i] ~ /^(VOICE|PENDING|HEADS-UP|DECISION|GOTCHA|LOG|GATE|STATUS|CONFIDENCE|RECOMMENDED_NEXT_AGENT|UNVERIFIED):/) {
              if (out == "" && line[i] ~ "^" M ":") out = line[i]
              i--
            }
            if (out != "") { sub("^" M ":[ \t]*", "", out); print out }
          }' \
      | sed 's/".*//')
  # Held in a variable rather than a temp file: this runs on the `Stop` path, and a
  # scratch file per marker per turn is exactly the kind of constant cost the rest of
  # this file goes out of its way to avoid.
  if [ "$filter" = doc ] || [ "$filter" = log ]; then
    v=$(printf '%s' "$v" | tr -d '"\\' | tr -s ' ')
  else
    v=$(printf '%s' "$v" | speakable_separators | tr -cd "A-Za-z0-9 .,;:'-" | tr -s ' ')
  fi
  v="${v# }"; v="${v% }"
  # A runaway line would otherwise be read out for a minute. The document tolerates
  # more than an announcement does, but not without bound.
  #
  # LOG is deliberately the longest: it is written and never spoken, so it carries the
  # reasoning the clause has no room for. The bound is not taste, it is the atomicity
  # property in file_append -- ONE printf that cannot interleave with another session.
  # PIPE_BUF is 512 bytes on macOS (the smallest of the platforms), and the daily-log
  # prefix -- timestamp, session name, separators, all multi-byte middots -- costs up
  # to about 70 of them. 380 characters of prose leaves headroom at every step.
  case "$filter" in
    log) v=$(clip "$v" 380) ;;
    doc) v=$(clip "$v" 240) ;;
    *)   v=$(clip "$v" 140) ;;
  esac
  [ ${#v} -ge 3 ] || return 1
  printf '%s' "$v"
}

# The turn's own summary, when no agent left a marker.
#
# The main thread emits no markers, so this is the ONLY source of a summary on an
# ordinary turn -- the common case, not the exception.
#
# The selection logic lives in summarise.awk, which scores every candidate sentence
# and returns the one that best reports an OUTCOME. It used to take the opening
# sentence, which is cheap and was wrong most of the time: the opening of a reply is
# usually meta-commentary ("I cannot restart myself from inside the session"), a
# discourse opener ("Let me walk through what I found."), or a disclaimer.
#
# Returning 1 means "no summary", which yields the terse completion form. That is a
# worse announcement than a good sentence and a much better one than a fragment read
# out with confidence.
first_sentence() {
  local v awkp="$J/summarise.awk"
  # A partial upgrade must degrade, not error: no picker, no summary, terse form.
  [ -r "$awkp" ] || return 1
  v=$(printf '%s' "$IN" \
      | awk -f "$awkp" \
      | speakable_separators \
      | tr -cd "A-Za-z0-9 .,;:'-" \
      | tr -s ' ') || return 1
  v="${v# }"; v="${v% }"
  v=$(clip "$v" 120)
  # Too short to be a sentence, or so long it was never one.
  [ ${#v} -ge 12 ] || return 1
  printf '%s' "$v"
}

voice_note() { marker_note VOICE; }

# The written record a specialist leaves behind, as distinct from what it says.
#
# The 45 specialists know far more than the one clause that gets spoken, and the daily
# log is read rather than heard -- so this one keeps the paths, the identifiers, the
# counts, and the WHY. Never spoken, never queued, never allowlisted for speech.
log_note() { marker_note LOG log; }

# The gate an agent REFUSED at, which is the authoritative signal.
#
# `plan` can only guess which of the seven a request crosses -- nothing in the planner
# decides it, so its matcher is a keyword heuristic biased towards silence. THIS is the
# real thing: the agent that actually hit the gate says so, on its way to escalating.
#
# Deliberately NOT validated against the seven here: the shell layer has no access to
# registry/agents.yaml, and inventing a second copy of the list is how two lists start
# disagreeing. The contract carries the seven names verbatim for agents to copy, and a
# test asserts they are all present. What arrives is allowlist-filtered and budgeted
# like any other clause.
gate_note() { marker_note GATE; }

# ---------------------------------------------------------------- the ledger --
#
# What actually happened, per agent, so the system can eventually tell whether it is
# any good. `doctor` and `health` are STATIC -- they validate the registry against
# itself and have never observed a task. Nothing recorded which agent produced work
# that was accepted, which was revised, or which dispatch was wasted, so §12 agent
# health was unbuildable rather than unbuilt.
#
# One line per agent completion, appended through the same single-printf routine as
# everything else, so concurrent sessions cannot interleave. JSON-shaped for the
# evaluator to read, but written by shell: no dependency, no parser, no network.
#
# Deliberately NOT a score. It records observations; judging them is the evaluator's
# job and a human gates what the judgement changes.
ledger_append() {
  local agent="$1" st="$2" conf="$3" nxt="$4" unver="$5"
  [ -n "$agent" ] || agent=unknown
  local f
  f="$J/ledger/$(date +%Y-%m).jsonl"
  file_append "$f" "" "$(printf '{"t":"%s","session":"%s","agent":"%s","status":"%s","confidence":"%s","next":"%s","unverified":%s}' \
    "$(date +%Y-%m-%dT%H:%M:%S)" "$NAME" "$agent" "${st:-unreported}" "${conf:-unreported}" "${nxt:-none}" \
    "$([ -n "$unver" ] && echo 1 || echo 0)")"
  return 0
}

# The agent that just finished, from the hook payload. SubagentStop carries it; without
# it the ledger would record 45 agents as one.
agent_type_of() {
  case "$IN" in
    *'"agent_type"'*) v=${IN#*\"agent_type\":\"}; v=${v%%\"*}
                      printf '%s' "$(printf '%s' "$v" | tr -cd 'A-Za-z0-9-')" ;;
    *) printf '' ;;
  esac
}

# The permanent record of the day, as distinct from what gets announced.
#
# EVERY completed turn is written here, including the ones the voice deliberately stays
# quiet about. The log is a record and the voice is selective; conflating the two would
# mean the quiet turns vanished from history, which is exactly the history you want when
# you come back tomorrow having forgotten what you did.
#
# Append-only and written as it happens, not assembled at session end — a terminal that
# is killed, or a machine that reboots, must not take the day with it.
# file_append <file> <header-or-empty> <line>
#
# THE append routine. Every append in this system goes through here — the daily log,
# and the per-session context journal added later in this file. There is deliberately
# only one, because the three properties below were each paid for once and must not be
# re-derived by a second implementation that gets one of them wrong.
#
#   1. The header is created with noclobber, so create-or-skip is a SINGLE operation
#      rather than a check followed by a write. Two sessions finishing a turn in the
#      same instant would otherwise both find no file and both write a header.
#   2. The trailing newline is owned HERE, not by the caller. Callers build entries in
#      a command substitution and `$( )` strips trailing newlines, so a caller that
#      ended its own line found it silently removed and every entry ran into the next.
#   3. ONE printf, so the append is a single write() that cannot interleave with
#      another session's. Entries stay far below PIPE_BUF: clauses are capped at 140
#      characters and the per-session lists at eight items.
file_append() {
  local f="$1" hdr="$2" line="$3"
  [ -n "$f" ] || return 0
  case "$f" in */*) mkdir -p "${f%/*}" 2>/dev/null ;; esac
  [ -n "$hdr" ] && ( set -C; printf '%s\n\n' "$hdr" > "$f" ) 2>/dev/null
  printf '%s\n' "$line" >> "$f" 2>/dev/null
  return 0
}

daily_append() {
  local d
  d=$(date +%Y-%m-%d)
  file_append "$J/daily/$d.md" "$(printf '# Daily log — %s' "$d")" "$1"
}

# Append a clause to a per-session list, without duplicates. The same PENDING item
# repeated by three agents across four turns is one item, not twelve.
remember() {
  local file="$1" line="$2" n=0
  [ -z "$line" ] && return 0
  if [ -r "$file" ]; then
    grep -qxF "$line" "$file" 2>/dev/null && return 0
    n=$(grep -c '' "$file" 2>/dev/null); n=${n:-0}
  fi
  [ "$n" -lt 8 ] && printf '%s\n' "$line" >> "$file"
  return 0
}

# ---------------------------------------------------------------------------
# Session context — the handoff document
#
# One document per session, in $JARVIS_CTX_DIR, written AS THE SESSION RUNS.
# Distinct from the daily log, which is one line per turn across every session and
# answers "what did I do today"; this answers "what was this session for, what was
# decided, and what is still open" — which is what a FUTURE session needs loaded.
#
# The split that makes it affordable:
#
#   here (bash, hot)    append one JSON line to <session>.jsonl. No spawn, ever.
#   context.mjs (cold)  render the .md from that journal. Spawned at compaction,
#                       at session end, and by the SessionStart sweep.
#
# So `Stop` — which fires after every single turn — costs exactly one printf, the
# same as the daily log already did. node is never on that path. The journal is the
# truth and the markdown is a projection of it, so a session killed at any instant
# loses nothing: the sweep at the next SessionStart renders whatever was left.
# ---------------------------------------------------------------------------

CTX_DIR="${JARVIS_CTX_DIR:-$HOME/frappe-bench/Referencedocs/CLI-Session-Context}"
# Installed beside this file by `voice --apply`. The skills-install copy is the
# fallback, so either installer alone is enough.
CTX_MJS="${JARVIS_CTX_MJS:-}"
if [ -z "$CTX_MJS" ]; then
  if   [ -r "$J/context.mjs" ]; then CTX_MJS="$J/context.mjs"
  else CTX_MJS="$HOME/.claude/skills/jarvis/scripts/context.mjs"; fi
fi

# Enabled, installed, and node present. Any of the three missing is a silent no-op:
# a context recorder that can break a hook is exactly the liability this whole file
# is written to avoid.
#
# platform.sh is sourced HERE and nowhere else in this file. It is 14 KB, and this
# file runs on every hook event — sourcing it at the top would put that cost on
# `Stop`, which fires after every turn, to reach a function only the cold paths use.
# Every caller of ctx_on() is cold: first prompt, compaction, session end.
ctx_on() {
  [ "${JARVIS_CTX:-1}" = "1" ] || return 1
  [ -r "$CTX_MJS" ] || return 1
  if [ -z "${JV_OS:-}" ] && [ -r "$J/platform.sh" ]; then . "$J/platform.sh"; fi
  jv_have_node 2>/dev/null || return 1
  return 0
}

# The journal path, cached in a plain file at open time.
#
# Resolving it would otherwise mean asking context.mjs, and that is a node spawn on
# the `Stop` path — which is the one thing this design exists to avoid. It is written
# once, when the session is opened, and read with a bare `read` thereafter.
ctx_journal() {
  [ -r "$S/ctxj/$KEY" ] || return 1
  local p; read -r p < "$S/ctxj/$KEY" 2>/dev/null || return 1
  [ -n "$p" ] || return 1
  printf '%s' "$p"
}

# Strip anything credential-shaped, then make the text safe to sit inside a JSON
# string literal.
#
# Interval quantifiers ({16,}) are avoided deliberately: the awk that ships with
# macOS did not support them for most of its life, and a pattern that silently fails
# to match is worse here than a slightly blunter one. `+` costs nothing in precision
# for these shapes. The thorough, shape-based filter — long hex runs, base64, JWTs —
# lives in context.mjs, which handles every string that did not come through here.
#
# The double quote and the backslash are DELETED rather than escaped: this text is
# about to be interpolated into a JSON line by printf, and deleting two characters
# from a human-readable clause is a smaller loss than an escaping bug that corrupts
# the journal for the rest of the session.
ctx_clean() {
  sed -E \
    -e 's#sk-ant-[A-Za-z0-9_-]+#[REDACTED]#g' \
    -e 's#gh[pousr]_[A-Za-z0-9]+#[REDACTED]#g' \
    -e 's#github_pat_[A-Za-z0-9_]+#[REDACTED]#g' \
    -e 's#xox[baprs]-[A-Za-z0-9-]+#[REDACTED]#g' \
    -e 's#(AKIA|ASIA)[0-9A-Z]+#[REDACTED]#g' \
    -e 's#AIza[0-9A-Za-z_-]+#[REDACTED]#g' \
    -e 's#[Bb]earer [A-Za-z0-9._~+/-]+#[REDACTED]#g' \
    -e 's#(api[_-]?key|apikey|secret|access[_-]?token|auth[_-]?token|client[_-]?secret|password|passwd|private[_-]?key)([[:space:]]*[:=][[:space:]]*)[^[:space:],;]+#\1\2[REDACTED]#Ig' \
    2>/dev/null \
    | tr -d '"\\' \
    | tr '\n\r\t' '   ' \
    | tr -s ' '
}

# ctx_event <kind> <value> [extra-json]
# One JSON object, one line, one printf — through the same file_append as the daily
# log, per the rule that this system has exactly one append routine.
ctx_event() {
  local f v
  f=$(ctx_journal) || return 0
  [ -n "$2" ] || [ -n "${3:-}" ] || return 0
  v=$(printf '%s' "$2" | ctx_clean)
  v="${v# }"; v="${v% }"
  file_append "$f" "" "$(printf '{"t":%s,"k":"%s","v":"%s"%s}' "$NOW" "$1" "$v" "${3:-}")"
}

# Materialise the document. Called on the FIRST UserPromptSubmit, not at SessionStart,
# for two reasons that are both about the filename:
#
#   * the name is a slug of the first prompt, which does not exist at SessionStart.
#     Creating under a placeholder and renaming later races every append already in
#     flight, and the rename is unrecoverable if it loses.
#   * a session that never receives a prompt has nothing to record. No file is the
#     correct output, not an empty one.
#
# The SessionStart timestamp is still what lands in the front matter — it is stashed
# in $S/start/$KEY by the `start` mode above.
ctx_open() {
  ctx_on || return 0
  [ -e "$S/ctxj/$KEY" ] && return 0
  local prompt started jpath
  # Cut at the first unescaped closing quote, NOT at `","`. When `prompt` is the last
  # key in the payload -- which it is, in a real UserPromptSubmit -- there is no
  # following `","` at all, so the objective came out with a literal `"}` welded onto
  # the end of it. Trim both shapes, in that order.
  prompt=$(printf '%s' "$IN" \
    | sed -n 's/.*"prompt":"//p' \
    | sed -e 's/",".*//' -e 's/"[]}[:space:]]*$//' \
    | awk '{gsub(/\\n/," ")} 1' \
    | head -c 1200)
  [ -n "$prompt" ] || return 0
  started=$(cat "$S/start/$KEY" 2>/dev/null); [ -z "$started" ] && started=$NOW
  mkdir -p "$S/ctxj" 2>/dev/null
  jpath=$(JARVIS_CTX_DIR="$CTX_DIR" jv_node "$CTX_MJS" open \
            --key "$KEY" --session-id "$SID" --cwd "${CWD:-$PWD}" \
            --branch "$(ctx_branch)" --started "$started" --prompt "$prompt" 2>/dev/null)
  [ -n "$jpath" ] && printf '%s\n' "$jpath" > "$S/ctxj/$KEY" 2>/dev/null
  return 0
}

# The branch, read from git in the session's own directory. `git` is not an OS tool in
# the platform.sh sense — it is the same on every platform — but it may be absent, and
# this bench root is not a repository at all, so both outcomes are handled.
ctx_branch() {
  command -v git >/dev/null 2>&1 || { printf ''; return; }
  git -C "${CWD:-$PWD}" rev-parse --abbrev-ref HEAD 2>/dev/null | tr -d '\n' | tr -cd 'A-Za-z0-9._/-'
}


# The session's working directory, taken from the hook payload where it is given. Claude
# Code passes `cwd` explicitly; $PWD is only a proxy for it and the two can differ.
CWD=""
case "$IN" in
  *'"cwd"'*)
    CWD=${IN#*\"cwd\":\"}
    CWD=${CWD%%\"*}
    ;;
esac
# Anything that is not an absolute path is not a cwd.
case "$CWD" in /*|?:[/\\]*) ;; *) CWD="" ;; esac

NAME="${JARVIS_SESSION_NAME:-$(basename "${CWD:-$PWD}")}"
if [ -n "${JARVIS_SESSION_KEY:-}" ]; then KEY="$JARVIS_SESSION_KEY"
elif [ -n "$SID" ];                    then KEY="${SID: -12}"
else                                        KEY="pwd-${PWD//\//_}"
fi
# Map everything that is not alphanumeric to an underscore, including the dash. A
# session id's last 12 characters can begin with one ("-solo-000001"), and a state
# file whose name starts with a dash is a hazard the moment any future code passes it
# to a command without a `--` or a directory prefix.
KEY=${KEY//[^A-Za-z0-9]/_}
NOW=$(date +%s)

# Use the name this session was REGISTERED with, in preference to one derived from the
# current directory. Preserving the stored FILE was not enough: the announcement is built
# from $NAME, which was being recomputed on every event — so a session that cd'd into a
# subdirectory kept its record but started announcing itself as "erpnext" instead of
# "frappe bench". Attribution has to be stable for the life of the session or it is not
# attribution at all.
if [ -r "$S/active/$KEY" ]; then
  read -r _reg < "$S/active/$KEY" 2>/dev/null
  _reg=${_reg%%|*}
  [ -n "$_reg" ] && NAME="$_reg"
fi

[ -f "$S/muted" ] && [ "$(cat "$S/muted" 2>/dev/null)" -gt "$NOW" ] 2>/dev/null && exit 0

# Ordinal = this session's slot among the live ones, assigned once. It drives the
# chime pitch, so slots are guaranteed distinct in start order instead of colliding
# at random the way a hash of the path does. It also disambiguates two sessions in
# one repository, which is otherwise unfixable.
assign_ordinal() {
  local taken=" " f o line
  for f in "$S"/active/*; do
    [ -e "$f" ] || continue
    [ "$f" = "$S/active/$KEY" ] && continue
    [ -r "$f" ] || continue
    read -r line < "$f" 2>/dev/null || continue
    taken="$taken${line##*|} "
  done
  for o in 1 2 3 4 5 6 7 8; do
    case "$taken" in *" $o "*) ;; *) echo "$o"; return ;; esac
  done
  echo 1
}

mark_active() {
  # Registered once, and then left alone. An earlier version rewrote the record on every
  # event, re-deriving the name from the current directory on the reasoning that a session
  # which cd'd elsewhere had legitimately moved. That is wrong: the name is how you know
  # which of several projects is talking, and an identifier that changes when you cd into
  # a subdirectory is worse than no identifier at all.
  [ -e "$S/active/$KEY" ] && return 0
  printf '%s\n' "${CWD:-$PWD}" > "$S/cwd/$KEY" 2>/dev/null
  printf '%s|%s\n' "$NAME" "$(assign_ordinal)" > "$S/active/$KEY"
  return 0
}

ordinal() {
  local line
  # Guard the file before redirecting into `read`. A redirect that cannot open its
  # target is reported by the shell itself, so `|| { ... }` never suppresses it —
  # StopFailure and idle_prompt do not register a session, and both were printing
  # "No such file or directory" into the hook's stderr on every firing.
  [ -r "$S/active/$KEY" ] || { echo 1; return; }
  read -r line < "$S/active/$KEY" 2>/dev/null || { echo 1; return; }
  line=${line##*|}
  case "$line" in ''|*[!0-9]*) echo 1 ;; *) echo "$line" ;; esac
}

# enqueue <priority> <mode> <extra>
# Priority leads the filename so `sort` orders the queue: 0 urgent, 1 nag, 4+
# routine. The epoch is a fixed 10 digits, so lexical sort is chronological.
enqueue() {
  printf '%s|%s|%s|%s|%s|%s|%s\n' "$2" "$NAME" "$3" "$NOW" "$(ordinal)" "$KEY" "${4:-}" \
    > "$Q/$1-$NOW-$$-$RANDOM" 2>/dev/null
}

wake_speaker() {
  if mkdir "$J/run/lock" 2>/dev/null; then
    echo "$NOW" > "$J/run/lock/born" 2>/dev/null
    nohup "$J/speaker.sh" >/dev/null 2>&1 &
    return
  fi
  # The DAEMON writes its own pid. An empty pid file means "starting up", not
  # "dead" — a hook that wrote its own $$ and exited left a dead pid behind, and
  # the next hook reaped a live lock and started a second daemon.
  local p; p=$(cat "$J/run/lock/pid" 2>/dev/null)
  if [ -n "$p" ]; then
    kill -0 "$p" 2>/dev/null && return
  else
    # No pid yet. Give a genuine startup 30s before assuming the spawn failed,
    # otherwise a speaker.sh that cannot execute holds the lock forever and the whole
    # system goes quiet with no error anywhere.
    #
    # The age comes from a timestamp the lock carries, NOT from stat. `stat -f` exists
    # on both platforms and means completely different things: a format string on BSD,
    # `--file-system` on GNU — where it SUCCEEDS and prints filesystem information, so
    # a `stat -f ... || stat -c ...` fallback never reaches the fallback. That fed
    # filesystem text into an arithmetic expression, and the resulting syntax error
    # meant the daemon was never spawned on Linux at all: everything went silent, with
    # only a stray parse error to show for it.
    local born age
    born=$(cat "$J/run/lock/born" 2>/dev/null)
    case "$born" in ''|*[!0-9]*) born=$NOW ;; esac
    age=$(( NOW - born ))
    [ "$age" -lt 30 ] && return
  fi
  rm -rf "$J/run/lock" 2>/dev/null
  if mkdir "$J/run/lock" 2>/dev/null; then
    echo "$NOW" > "$J/run/lock/born" 2>/dev/null
    nohup "$J/speaker.sh" >/dev/null 2>&1 &
  fi
}

case "$MODE" in
  start|boot)                       # SessionStart
    # A new session means the previous farewell is spent. Without this the one-shot
    # goodbye marker would suppress the goodbye for every later run of the day.
    rm -rf "$J/run/farewell" 2>/dev/null
    mark_active
    echo "$NOW" > "$S/start/$KEY"
    rm -f "$S/subs/$KEY"
    # Tidy documents left `active` by a session that never got a SessionEnd — a
    # closed terminal, a reboot, a kill -9 — and print the pointer to any recent
    # session for this project that still has open threads. A POINTER, at most three
    # lines: it is injected before anyone has decided the work is worth loading, so
    # naming the file is the whole job. The contents are the reader's call.
    if ctx_on; then
      JARVIS_CTX_DIR="$CTX_DIR" jv_node "$CTX_MJS" startup --project "${CWD:-$PWD}" 2>/dev/null
    fi
    enqueue 4 boot "" ;;

  begin)                            # UserPromptSubmit — restart the clock
    mark_active
    echo "$NOW" > "$S/start/$KEY"
    # The first prompt is what names and opens the document; later ones are no-ops.
    ctx_open
    rm -f "$S/pending/$KEY" "$S/subs/$KEY" "$S/notes/$KEY" "$S/inflight/$KEY" "$S/swarm/$KEY" ;;

  precompact)                       # PreCompact — the point at which context is LOST
    # Compaction, not session closure, is where context actually goes. It happens
    # repeatedly inside a long session and it is silent. Everything below runs before
    # the discard, and every part of it is deterministic: the payload carries
    # `transcript_path`, a POINTER to the conversation, not the conversation, so the
    # snapshot is built by reading the transcript window since the last watermark.
    #
    # Repeated compactions therefore capture DISJOINT windows rather than re-reading
    # the whole file, and the cost is proportional to new content rather than to a
    # transcript that can reach twenty megabytes.
    ctx_on || exit 0
    TRIG=""
    case "$IN" in *'"trigger"'*) TRIG=${IN#*\"trigger\":\"}; TRIG=${TRIG%%\"*} ;; esac
    case "$TRIG" in manual|auto) ;; *) TRIG=auto ;; esac
    TPATH=""
    case "$IN" in *'"transcript_path"'*) TPATH=${IN#*\"transcript_path\":\"}; TPATH=${TPATH%%\"*} ;; esac
    # A JSON string escapes the separator on Windows; nothing else here can contain one.
    TPATH=${TPATH//\\\\//}
    [ -r "$TPATH" ] || exit 0
    ctx_open   # a session can compact before it has ever been opened by a prompt

    RES=$(JARVIS_CTX_DIR="$CTX_DIR" jv_node "$CTX_MJS" precompact \
            --key "$KEY" --transcript "$TPATH" --trigger "$TRIG" 2>/dev/null)
    SNAP=${RES%%|*}; REST=${RES#*|}; DROPPED=${REST%%|*}
    case "$SNAP" in ''|*[!0-9]*) exit 0 ;; esac

    # The optional model pass. Deterministic extraction has already recovered the
    # FACTS — files, commands, prompts, markers — and they are on disk before this
    # runs. What it cannot recover is a decision's REASONING, because the main thread
    # emits no markers. That is the one place a model call is the honest answer.
    #
    # Detached, so the hook has returned long before it starts. Floored, because a
    # small window is not worth a request. Capped per day, because a pathological
    # day must not run away — and both are RECORDED in the document when they bite,
    # since a silent cap reads as "nothing was there".
    if [ "${JARVIS_CTX_SUMMARY:-1}" = "1" ]; then
      MINC=${JARVIS_CTX_SUMMARY_MIN_CHARS:-16000}
      DAYMAX=${JARVIS_CTX_SUMMARY_DAILY_MAX:-20}
      CNTF="$S/ctx_llm_$(date +%Y%m%d)"
      CNT=$(cat "$CNTF" 2>/dev/null); case "$CNT" in ''|*[!0-9]*) CNT=0 ;; esac
      case "$DROPPED" in ''|*[!0-9]*) DROPPED=0 ;; esac
      if [ "$DROPPED" -lt "$MINC" ]; then
        ctx_event skipped "" ",\"n\":$SNAP,\"why\":\"window below the ${MINC}-char floor\""
      elif [ "$CNT" -ge "$DAYMAX" ]; then
        ctx_event skipped "" ",\"n\":$SNAP,\"why\":\"daily cap of $DAYMAX summaries reached\""
      else
        echo $(( CNT + 1 )) > "$CNTF" 2>/dev/null
        # `< /dev/null` is not decoration: this file reads stdin at the top, and a
        # detached copy that inherits the hook's stdin blocks on a read that never
        # returns — taking the model pass with it, silently.
        ( nohup "$J/jarvis.sh" llm "$KEY" "$SNAP" "$TPATH" </dev/null >/dev/null 2>&1 & ) 2>/dev/null
      fi
    fi
    enqueue 8 sub "$SNAP" ;;

  postcompact)                      # PostCompact — what survived
    # The payload carries the summary the model kept. Recording it next to the
    # snapshot of what was dropped is what makes the pair readable: one says what
    # was lost, the other what replaced it. Pure payload read — no transcript walk.
    ctx_on || exit 0
    SUMM=""
    case "$IN" in
      *'"summary"'*) SUMM=${IN#*\"summary\":\"}; SUMM=${SUMM%%\"*} ;;
    esac
    SUMM=$(printf '%s' "$SUMM" | awk '{gsub(/\\n/," ")} 1' | head -c 800)
    JARVIS_CTX_DIR="$CTX_DIR" jv_node "$CTX_MJS" postcompact \
      --key "$KEY" --summary "$SUMM" >/dev/null 2>&1
    exit 0 ;;

  llm)                              # internal: the detached model pass
    # Never invoked as a hook. Spawned by `precompact` above, already detached, so
    # it may take as long as it takes. It writes marker lines into the journal and
    # re-renders; if anything fails the document simply keeps the deterministic
    # facts it already had.
    ctx_on || exit 0
    LKEY="$2"; LN="$3"; LT="$4"
    KEY="$LKEY"
    [ -r "$S/ctxj/$KEY" ] || exit 0
    TMPI="$J/run/llm-in-$$"; TMPO="$J/run/llm-out-$$"
    JARVIS_CTX_DIR="$CTX_DIR" jv_node "$CTX_MJS" llmprompt \
      --key "$KEY" --n "$LN" --transcript "$LT" > "$TMPI" 2>/dev/null
    if [ -s "$TMPI" ] && jv_llm_summarize "$TMPI" "$TMPO"; then
      [ -s "$TMPO" ] && JARVIS_CTX_DIR="$CTX_DIR" jv_node "$CTX_MJS" reasoned \
        --key "$KEY" --n "$LN" --file "$TMPO" >/dev/null 2>&1
    fi
    rm -f "$TMPI" "$TMPO" 2>/dev/null
    exit 0 ;;

  done)                             # Stop
    # No "permission granted" event exists in Claude Code, so pending state is
    # cleared here and on begin. Accepting that imprecision is cheaper than
    # hooking PostToolUse, which would spawn a process on every tool call.
    rm -f "$S/pending/$KEY"
    st=$(cat "$S/start/$KEY" 2>/dev/null); [ -z "$st" ] && st=$NOW
    el=$(( NOW - st )); [ "$el" -lt 0 ] && el=0
    rm -f "$S/start/$KEY"
    subs=0
    [ "${JARVIS_COUNT_SUBAGENTS:-1}" = "1" ] && subs=$(cat "$S/subs/$KEY" 2>/dev/null)
    [ -z "$subs" ] && subs=0
    rm -f "$S/subs/$KEY"

    # What to actually say. Specialist notes first; failing that, a marker the main
    # thread left in its own final message.
    # The main thread can leave these too, not only the specialists.
    #
    # Extracted ONCE into variables and used twice — by the spoken briefing below and
    # by the handoff document further down. Calling marker_note again for the second
    # consumer would double the awk passes on the hottest path in the system. The
    # early `case "$IN"` guard already makes a turn with no markers free; this keeps a
    # turn WITH markers from paying twice.
    MK_PENDING=$(marker_note 'PENDING'  2>/dev/null)
    MK_HEADS=$(marker_note   'HEADS-UP' 2>/dev/null)
    remember "$S/todo/$KEY"  "$MK_PENDING"
    remember "$S/heads/$KEY" "$MK_HEADS"

    # A refused gate outranks everything else this turn. Enqueued at priority 0 BEFORE
    # the completion is even considered, so it is spoken first and the completion queues
    # behind it -- an agent that stopped because it needs authorisation is not a turn
    # that "finished".
    MK_GATE=$(gate_note 2>/dev/null) || MK_GATE=""
    if [ -n "$MK_GATE" ]; then
      mark_active
      enqueue 0 gate "$MK_GATE"
    fi

    SUMMARY=""
    if [ "${JARVIS_SUMMARY:-1}" = "1" ]; then
      if [ -s "$S/notes/$KEY" ]; then
        # This fallback IS the effective default for anyone who already had a config.sh
        # — it is deliberately preserved across upgrades, so a newly added setting never
        # appears in theirs. It must therefore match what config.sh documents.
        max=${JARVIS_SUMMARY_MAX:-1}

        # WHICH clause, when several arrived, is the whole question.
        #
        # A problem wins outright. The agent contract already tells specialists to lead
        # with one, and a problem is the only thing here genuinely worth interrupting
        # someone for — announcing "schema is in" while a sibling agent reported a failing
        # test would be actively misleading.
        #
        # Otherwise the LAST, not the first. In a requirements-design-build-test pipeline
        # the earliest agent to finish is the least conclusive; taking the first meant a
        # four-agent run announced its acceptance criteria and never mentioned that the
        # tests passed.
        SUMMARY=$(grep -inE '(^|[^a-z])(fail|failed|failing|error|errors|broken|blocked|cannot|missing|unsafe|conflict|conflicts|risk|risks)([^a-z]|$)' \
                    "$S/notes/$KEY" 2>/dev/null | head -1 | cut -d: -f2-)
        if [ -z "$SUMMARY" ]; then
          SUMMARY=$(tail -"$max" "$S/notes/$KEY" 2>/dev/null | tr '\n' ';' | sed 's/;$//; s/;/; /g')
        fi
      else
        SUMMARY=$(voice_note) || SUMMARY=""
        # No specialist left a clause, so fall back to how the turn itself ended.
        if [ -z "$SUMMARY" ] && [ "${JARVIS_FALLBACK_SUMMARY:-1}" = "1" ]; then
          SUMMARY=$(first_sentence) || SUMMARY=""
        fi
      fi
    fi
    [ -n "$SUMMARY" ] && remember "$S/done/$KEY" "$SUMMARY"
    rm -f "$S/notes/$KEY"

    # A completion with nothing to report is the announcement that makes this feel
    # talkative. Running four sessions, `Stop` fires constantly and "Done, sir. Three
    # minutes." carries no information — so by default the voice is saved for turns that
    # actually have something to say, and the rest just tick.
    speak_it=1
    if [ -z "$SUMMARY" ]; then
      case "${JARVIS_SPEAK_WITHOUT_SUMMARY:-auto}" in
        0) speak_it=0 ;;
        1) speak_it=1 ;;
        *) live=$(ls "$S/active" 2>/dev/null | wc -l | tr -d ' ')
           case "$live" in ''|*[!0-9]*) live=1 ;; esac
           [ "$live" -gt 1 ] && speak_it=0 ;;
      esac
    fi

    # The day's tally, for the single farewell. One line per completed turn across ALL
    # sessions, which is the only place anything has a view of the whole day.
    if [ "${JARVIS_DAY_DIGEST:-1}" = "1" ]; then
      flag=ok
      case "$SUMMARY" in
        *fail*|*error*|*broken*|*blocked*|*cannot*|*missing*|*unsafe*|*conflict*|*risk*) flag=problem ;;
      esac
      printf '%s|%s|%s\n' "$NAME" "$flag" "$SUMMARY" >> "$S/day" 2>/dev/null
    fi

    # Written whether or not it will be spoken. A turn the voice skips is still a turn
    # that happened.
    if [ "${JARVIS_DAILY_LOG:-1}" = "1" ]; then
      if [ "$el" -lt 60 ]; then _d="${el}s"; else _d="$(( el / 60 ))m"; fi
      _crew=""
      [ "$subs" -ge 2 ] && _crew=" · $subs specialists"
      _what="$SUMMARY"
      [ -z "$_what" ] && _what="_(nothing reported)_"
      _flag=""
      case "$SUMMARY" in
        *fail*|*error*|*broken*|*blocked*|*cannot*|*missing*|*unsafe*|*conflict*|*risk*) _flag="**PROBLEM** " ;;
      esac
      daily_append "$(printf -- '- **%s** · `%s` · %s%s · %s%s' \
        "$(date +%H:%M)" "$NAME" "$_d" "$_crew" "$_flag" "$_what")"

      # A specialist's fuller account, when it left one. A SECOND single-printf append
      # rather than one longer line: two writes of 400 bytes each stay inside the
      # atomicity budget where one of 800 would not, and the turn line stays scannable
      # with the detail indented beneath it.
      #
      # Written HERE, on the Stop path as the turn ends -- not assembled at SessionEnd.
      # A killed terminal must not take the day with it, which is the property the whole
      # daily log exists to hold.
      _log=$(log_note 2>/dev/null) || _log=""
      [ -n "$_log" ] && daily_append "$(printf -- '  - %s' "$_log")"
    fi

    # The same turn, into this session's own journal. One printf, no spawn — the
    # clause and the elapsed time were already computed for the line above, so the
    # marginal cost of the handoff document on the hottest path in the system is a
    # single additional write().
    if [ -n "$SUMMARY" ]; then
      _p=0; [ -n "$_flag" ] && _p=1
      ctx_event turn "$SUMMARY" ",\"el\":$el,\"subs\":$subs,\"p\":$_p"
    fi
    # Markers the main thread or a specialist left. PENDING and HEADS-UP are reused
    # from the extraction above rather than re-run. DECISION and GOTCHA are
    # document-only and never spoken, so they take the `doc` filter, which preserves
    # paths instead of reducing them to speakable words.
    ctx_event decision "$(marker_note 'DECISION' doc 2>/dev/null)"
    ctx_event gotcha   "$(marker_note 'GOTCHA'   doc 2>/dev/null)"
    ctx_event thread   "$MK_PENDING"
    ctx_event gotcha   "$MK_HEADS"

    if [ "$el" -lt "${JARVIS_MIN_SECONDS:-25}" ] || [ "$speak_it" = 0 ]; then
      enqueue 7 tick "$el"
    else
      enqueue 5 'done' "$el:$subs" "$SUMMARY"
    fi ;;

  swarm)                            # JARVIS routing: record the shape of the plan
    # Silent. `jarvisctl report` answers "what is the swarm doing right now", and the
    # in-flight COUNT alone cannot say in which batch or at which tier -- only the
    # planner knows that, and only at plan time. So it is recorded here and read there.
    mkdir -p "$S/swarm" 2>/dev/null
    SW=$(printf '%s' "${2:-}" | tr -cd "A-Za-z0-9 ,.:-" | tr -s ' ')
    printf '%s\n' "$(clip "$SW" 120)" > "$S/swarm/$KEY" 2>/dev/null
    exit 0 ;;

  gate)                             # JARVIS routing: a human-approval gate was hit
    # THE LOUDEST THING THIS LAYER SAYS, and the only announcement that names its own
    # cause. There are seven gates and they are not interchangeable -- "needs your
    # approval" tells you to look, "a production deployment needs your approval" tells
    # you what you are about to be asked. Priority 0, ahead of everything.
    #
    # The gate name arrives as $2 rather than in a JSON payload: the caller is the
    # JARVIS routing, a Node CLI, not a Claude Code hook, so there is no payload to put
    # it in.
    mark_active
    GATE=$(printf '%s' "${2:-}" | speakable_separators | tr -cd "A-Za-z0-9 .,;:'-" | tr -s ' ')
    GATE=$(clip "$GATE" 140)
    enqueue 0 gate "$GATE" ;;

  route)                            # JARVIS routing: a routing or planning decision
    # A dropped agent or a capped effort level is a decision someone made on your
    # behalf. One line, at routine priority -- it is information, not an interruption.
    mark_active
    RT=$(printf '%s' "${2:-}" | speakable_separators | tr -cd "A-Za-z0-9 .,;:'-" | tr -s ' ')
    RT=$(clip "$RT" 140)
    [ ${#RT} -ge 3 ] || exit 0
    enqueue 6 route "$RT" ;;

  substart)                         # SubagentStart — a specialist went out
    # The COMPLETION count already existed; this is the in-flight count, which is what
    # `jarvisctl report` needs to answer "what is the swarm doing right now" rather
    # than "what has it finished". Silent by design: a batch of four dispatching is
    # four events, and sub-agents do not speak.
    mkdir -p "$S/inflight" 2>/dev/null
    _n=$(cat "$S/inflight/$KEY" 2>/dev/null); case "$_n" in ''|*[!0-9]*) _n=0 ;; esac
    printf '%s\n' "$(( _n + 1 ))" > "$S/inflight/$KEY" 2>/dev/null
    exit 0 ;;

  permission|approve)               # Notification / permission_prompt
    mark_active
    printf '%s|%s|0|0\n' "$NOW" "$NAME" > "$S/pending/$KEY"
    enqueue 0 approve "" ;;

  idle)                             # Notification / idle_prompt
    enqueue 6 idle "" ;;

  subagent|sub)                     # SubagentStop
    # Record the outcome BEFORE anything else in this branch: the announcement is
    # optional and coalesced, but the measurement must not be.
    if [ "${JARVIS_LEDGER:-1}" = "1" ]; then
      ledger_append "$(agent_type_of)" \
        "$(marker_note STATUS 2>/dev/null)" \
        "$(marker_note CONFIDENCE 2>/dev/null)" \
        "$(marker_note RECOMMENDED_NEXT_AGENT 2>/dev/null)" \
        "$(marker_note UNVERIFIED 2>/dev/null)"
    fi
    # Decrement the in-flight count first, and never below zero: SubagentStop can fire
    # for a specialist whose start was missed (an older install, or a session that
    # began before SubagentStart was registered), and a negative count would render as
    # "minus one specialist running".
    _n=$(cat "$S/inflight/$KEY" 2>/dev/null); case "$_n" in ''|*[!0-9]*) _n=0 ;; esac
    [ "$_n" -gt 0 ] && printf '%s\n' "$(( _n - 1 ))" > "$S/inflight/$KEY" 2>/dev/null
    n=$(cat "$S/subs/$KEY" 2>/dev/null); [ -z "$n" ] && n=0
    echo $(( n + 1 )) > "$S/subs/$KEY"
    # Whatever this specialist wanted said. Capped: a swarm run can dispatch a dozen,
    # and a dozen clauses is a paragraph nobody asked to have read to them.
    remember "$S/todo/$KEY"  "$(marker_note 'PENDING' 2>/dev/null)"
    remember "$S/heads/$KEY" "$(marker_note 'HEADS-UP' 2>/dev/null)"
    if note=$(voice_note); then
      # Guard the file before redirecting into it. A redirect that cannot open its target
      # is reported by the SHELL, so `2>/dev/null` on the command never suppresses it —
      # and the very first note of every turn hits exactly that, printing an error from a
      # hook. A hook that writes to stderr surfaces a notice in the transcript.
      lines=0
      if [ -r "$S/notes/$KEY" ]; then
        lines=$(wc -l < "$S/notes/$KEY" 2>/dev/null | tr -d ' ')
        case "$lines" in ''|*[!0-9]*) lines=0 ;; esac
      fi
      [ "$lines" -lt 8 ] && printf '%s\n' "$note" >> "$S/notes/$KEY"
    fi
    case "${JARVIS_SUBAGENT:-chime}" in
      silent) exit 0 ;;
      speak)  enqueue 6 subspeak "$(( n + 1 ))" ;;
      *)      enqueue 8 sub "$(( n + 1 ))" ;;
    esac ;;

  error|err)                        # StopFailure — API error, not a failed tool
    enqueue 0 err "" ;;

  end|bye)                          # SessionEnd
    # The briefing is written in full and spoken in part, deliberately. Everything the
    # session achieved is worth having on record; only what is still outstanding is worth
    # reading aloud to someone who is closing the terminal.
    BRIEF="$J/briefings/$(date +%Y-%m-%d)-$NAME.txt"
    {
      printf '%s  %s\n\n' "$(date '+%Y-%m-%d %H:%M')" "$NAME"
      if [ -s "$S/done/$KEY" ]; then
        printf 'DONE\n'; sed 's/^/  - /' "$S/done/$KEY"; printf '\n'
      fi
      if [ -s "$S/heads/$KEY" ]; then
        printf 'HEADS UP\n'; sed 's/^/  - /' "$S/heads/$KEY"; printf '\n'
      fi
      if [ -s "$S/todo/$KEY" ]; then
        printf 'PENDING\n'; sed 's/^/  - /' "$S/todo/$KEY"; printf '\n'
      fi
    } >> "$BRIEF" 2>/dev/null

    # Spoken form: pending first, because it is the only thing that can still be acted
    # on; then one heads-up. A session that finished cleanly says nothing at all — the
    # farewell already reports the day's totals.
    SPOKEN=""
    if [ "${JARVIS_BRIEF:-1}" = "1" ]; then
      if [ -s "$S/todo/$KEY" ]; then
        SPOKEN="Pending: $(head -2 "$S/todo/$KEY" 2>/dev/null | tr '\n' ';' | sed 's/;$//; s/;/. And /g')"
      elif [ -s "$S/heads/$KEY" ]; then
        SPOKEN="Heads up: $(head -1 "$S/heads/$KEY" 2>/dev/null)"
      fi
    fi
    [ -n "$SPOKEN" ] && enqueue 3 brief "$SPOKEN"

    # And into the day's record — only when there is something outstanding, so a clean
    # session leaves the log uncluttered. Built as one string and written once, because
    # two sessions closing together must not interleave their blocks.
    if [ "${JARVIS_DAILY_LOG:-1}" = "1" ] && { [ -s "$S/todo/$KEY" ] || [ -s "$S/heads/$KEY" ]; }; then
      # Joined with real newlines held INSIDE the string, never at the end of a
      # substitution, for the same reason: a trailing newline would be stripped.
      _blk=$(printf '\n### %s · `%s` closed' "$(date +%H:%M)" "$NAME")
      if [ -s "$S/heads/$KEY" ]; then
        _blk="$_blk
$(sed 's/^/- **Heads up** · /' "$S/heads/$KEY" 2>/dev/null)"
      fi
      if [ -s "$S/todo/$KEY" ]; then
        _blk="$_blk
$(sed 's/^/- **Pending** · /' "$S/todo/$KEY" 2>/dev/null)"
      fi
      daily_append "$_blk"
    fi

    # Close the handoff document: flip the front matter to `closed`, fold the journal
    # into its final shape, and add the line to INDEX.md. A session that produced
    # nothing meaningful has its file removed here rather than left as a ceremonial
    # empty record — silence is the correct entry for "nothing happened".
    if ctx_on && [ -e "$S/ctxj/$KEY" ]; then
      # Everything the spoken briefing collected is already deduplicated and capped
      # at eight by remember(); reuse it wholesale rather than re-harvesting.
      if [ -s "$S/todo/$KEY" ]; then
        while IFS= read -r _l; do ctx_event thread "$_l"; done < "$S/todo/$KEY"
      fi
      if [ -s "$S/heads/$KEY" ]; then
        while IFS= read -r _l; do ctx_event gotcha "$_l"; done < "$S/heads/$KEY"
      fi
      # SessionEnd carries the transcript path, so the close can sweep everything
      # since the last compaction -- which for a session that never compacted is the
      # whole thing, and is the only place "Files touched" can come from.
      ETP=""
      case "$IN" in *'"transcript_path"'*) ETP=${IN#*\"transcript_path\":\"}; ETP=${ETP%%\"*} ;; esac
      ETP=${ETP//\\\\//}
      [ -r "$ETP" ] || ETP=""
      JARVIS_CTX_DIR="$CTX_DIR" jv_node "$CTX_MJS" close --key "$KEY" \
        ${ETP:+--transcript "$ETP"} >/dev/null 2>&1
      rm -f "$S/ctxj/$KEY" 2>/dev/null
    fi

    rm -f "$S/active/$KEY" "$S/start/$KEY" "$S/pending/$KEY" "$S/subs/$KEY" "$S/notes/$KEY" \
          "$S/done/$KEY" "$S/todo/$KEY" "$S/heads/$KEY" "$S/cwd/$KEY"
    enqueue 6 bye "" ;;

  *)
    exit 0 ;;
esac

wake_speaker
exit 0
