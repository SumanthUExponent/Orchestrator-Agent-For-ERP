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

J="$HOME/.claude/jarvis"
[ -f "$J/config.sh" ] && . "$J/config.sh"

Q="$J/queue"; S="$J/state"
mkdir -p "$Q" "$S/active" "$S/start" "$S/pending" "$S/subs" "$S/notes" \
         "$S/done" "$S/todo" "$S/heads" "$S/cwd" "$J/briefings" "$J/daily" "$J/run" 2>/dev/null

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

marker_note() {
  local marker="$1" v
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
            while (i > 0 && line[i] ~ /^["}\]]+,?$/) i--
            while (i > 0 && line[i] ~ /^(VOICE|PENDING|HEADS-UP):/) {
              if (out == "" && line[i] ~ "^" M ":") out = line[i]
              i--
            }
            if (out != "") { sub("^" M ":[ \t]*", "", out); print out }
          }' \
      | sed 's/".*//' \
      | speakable_separators \
      | tr -cd "A-Za-z0-9 .,;:'-" \
      | tr -s ' ')
  v="${v# }"; v="${v% }"
  # A runaway line would otherwise be read out for a minute.
  v=$(clip "$v" 140)
  [ ${#v} -ge 3 ] || return 1
  printf '%s' "$v"
}

# The turn's own closing sentence, when no agent left a marker.
#
# The main thread emits no markers — a VOICE line in a reply is visible clutter for the
# person reading it — so a chat where the work is done directly, with no specialists
# dispatched, would otherwise never produce a summary at all. That is the COMMON case,
# not the exception, and it is why nothing was ever spoken in an ordinary conversation.
#
# The opening sentence of the final message is a decent summary of a turn, and it costs
# nothing: no model call, no marker, no clutter.
first_sentence() {
  local v
  v=$(printf '%s' "$IN" \
      | sed -n 's/.*"last_assistant_message":"//p' \
      | awk '{gsub(/\\n/,"\n")} 1' \
      | sed -e 's/^[[:space:]#>*`_-]*//' \
      | sed -n '1,4p' \
      | tr '\n' ' ' \
      | sed 's/\([.!?]\)[[:space:]].*/\1/' \
      | speakable_separators \
      | tr -cd "A-Za-z0-9 .,;:'-" \
      | tr -s ' ')
  v="${v# }"; v="${v% }"
  v=$(clip "$v" 120)
  # Too short to be a sentence, or so long it was never one.
  [ ${#v} -ge 12 ] || return 1
  printf '%s' "$v"
}

voice_note() { marker_note VOICE; }

# The permanent record of the day, as distinct from what gets announced.
#
# EVERY completed turn is written here, including the ones the voice deliberately stays
# quiet about. The log is a record and the voice is selective; conflating the two would
# mean the quiet turns vanished from history, which is exactly the history you want when
# you come back tomorrow having forgotten what you did.
#
# Append-only and written as it happens, not assembled at session end — a terminal that
# is killed, or a machine that reboots, must not take the day with it.
daily_append() {
  local d f
  d=$(date +%Y-%m-%d)
  f="$J/daily/$d.md"
  # Create the header atomically. Two sessions finishing a turn in the same instant would
  # otherwise both find no file and both write one. noclobber makes the create-or-skip a
  # single operation instead of a check followed by a write.
  ( set -C; printf '# Daily log — %s\n\n' "$d" > "$f" ) 2>/dev/null
  # The trailing newline is added HERE, not by the caller. Callers build their entry in a
  # command substitution, and `$( )` strips trailing newlines — so a caller that ended its
  # own line found the newline silently removed, and every entry in the file ran into the
  # next one. Owning it at the sink means no caller can get it wrong.
  #
  # ONE printf, so the append is a single write() that cannot interleave with another
  # session's. Entries stay far below PIPE_BUF: clauses are capped at 140 characters and
  # the per-session lists at eight items.
  printf '%s\n' "$1" >> "$f" 2>/dev/null
  return 0
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
    enqueue 4 boot "" ;;

  begin)                            # UserPromptSubmit — restart the clock
    mark_active
    echo "$NOW" > "$S/start/$KEY"
    rm -f "$S/pending/$KEY" "$S/subs/$KEY" "$S/notes/$KEY" ;;

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
    remember "$S/todo/$KEY"  "$(marker_note 'PENDING' 2>/dev/null)"
    remember "$S/heads/$KEY" "$(marker_note 'HEADS-UP' 2>/dev/null)"

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
    fi

    if [ "$el" -lt "${JARVIS_MIN_SECONDS:-25}" ] || [ "$speak_it" = 0 ]; then
      enqueue 7 tick "$el"
    else
      enqueue 5 'done' "$el:$subs" "$SUMMARY"
    fi ;;

  permission|approve)               # Notification / permission_prompt
    mark_active
    printf '%s|%s|0|0\n' "$NOW" "$NAME" > "$S/pending/$KEY"
    enqueue 0 approve "" ;;

  idle)                             # Notification / idle_prompt
    enqueue 6 idle "" ;;

  subagent|sub)                     # SubagentStop
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

    rm -f "$S/active/$KEY" "$S/start/$KEY" "$S/pending/$KEY" "$S/subs/$KEY" "$S/notes/$KEY" \
          "$S/done/$KEY" "$S/todo/$KEY" "$S/heads/$KEY" "$S/cwd/$KEY"
    enqueue 6 bye "" ;;

  *)
    exit 0 ;;
esac

wake_speaker
exit 0
