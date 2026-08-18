# JARVIS tunables. Every value is overridable from the environment, so a single
# session can differ from the rest:  JARVIS_MIN_SECONDS=0 claude
#
# Edit this file to change the defaults for every session.

JARVIS_VOICE="${JARVIS_VOICE:-Daniel}"            # `jarvisctl voices` to audition
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

# Count the specialists a turn dispatched and mention it in the completion, so
# "six specialists, four minutes" distinguishes a swarm run from a one-liner.
JARVIS_COUNT_SUBAGENTS="${JARVIS_COUNT_SUBAGENTS:-1}"
