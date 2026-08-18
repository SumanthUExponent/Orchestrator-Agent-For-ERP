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
mkdir -p "$Q" "$S/active" "$S/start" "$S/pending" "$S/subs" "$J/run" 2>/dev/null

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

NAME="${JARVIS_SESSION_NAME:-$(basename "$PWD")}"
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
  if [ -e "$S/active/$KEY" ]; then
    # Already registered. Keep the ordinal; the name can legitimately change if
    # the session cd'd somewhere else.
    local line ord
    line=""
    [ -r "$S/active/$KEY" ] && read -r line < "$S/active/$KEY" 2>/dev/null
    ord=${line##*|}
    case "$ord" in ''|*[!0-9]*) ord=1 ;; esac
    printf '%s|%s\n' "$NAME" "$ord" > "$S/active/$KEY"
  else
    printf '%s|%s\n' "$NAME" "$(assign_ordinal)" > "$S/active/$KEY"
  fi
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
  printf '%s|%s|%s|%s|%s|%s\n' "$2" "$NAME" "$3" "$NOW" "$(ordinal)" "$KEY" \
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
    rm -f "$S/pending/$KEY" "$S/subs/$KEY" ;;

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
    if [ "$el" -lt "${JARVIS_MIN_SECONDS:-25}" ]; then enqueue 7 tick "$el"
    else enqueue 5 'done' "$el:$subs"; fi ;;

  permission|approve)               # Notification / permission_prompt
    mark_active
    printf '%s|%s|0|0\n' "$NOW" "$NAME" > "$S/pending/$KEY"
    enqueue 0 approve "" ;;

  idle)                             # Notification / idle_prompt
    enqueue 6 idle "" ;;

  subagent|sub)                     # SubagentStop
    n=$(cat "$S/subs/$KEY" 2>/dev/null); [ -z "$n" ] && n=0
    echo $(( n + 1 )) > "$S/subs/$KEY"
    case "${JARVIS_SUBAGENT:-chime}" in
      silent) exit 0 ;;
      speak)  enqueue 6 subspeak "$(( n + 1 ))" ;;
      *)      enqueue 8 sub "$(( n + 1 ))" ;;
    esac ;;

  error|err)                        # StopFailure — API error, not a failed tool
    enqueue 0 err "" ;;

  end|bye)                          # SessionEnd
    rm -f "$S/active/$KEY" "$S/start/$KEY" "$S/pending/$KEY" "$S/subs/$KEY"
    enqueue 6 bye "" ;;

  *)
    exit 0 ;;
esac

wake_speaker
exit 0
