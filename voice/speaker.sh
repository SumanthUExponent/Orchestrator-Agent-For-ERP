#!/usr/bin/env bash
# The single drainer. Exactly one instance runs, holding an exclusive lock, and it
# is the only process in the system that calls `say`. That is the entire reason
# this is a daemon and not a function: macOS does not queue concurrent `say`
# calls, it plays them at once, and four parallel Claude sessions then produce
# noise rather than information.
#
# Everything else here exists to keep the announcements worth listening to:
# priority ordering so a blocked session jumps the queue, debouncing so a burst
# collapses to one line, staleness so a late completion is dropped rather than
# read out, and phrase variety so it sounds like an assistant and not a beep.

# JARVIS_DIR, with the historical name as a fallback. The installer has always
# honoured this variable; the runtime scripts did not, so an install anywhere but
# the default silently found no config.sh, no tones and no state -- and said
# nothing about it, because every lookup is guarded. CI installs to a temp dir,
# which is how an audition that rendered ": . 4 minutes." got past a ceiling check.
J="${JARVIS_DIR:-${CLAUDE_JARVIS_DIR:-$HOME/.claude/jarvis}}"
[ -f "$J/config.sh" ] && . "$J/config.sh"
# Every OS-specific call lives in platform.sh. Nothing below this line names `say`,
# `afplay` or `osascript`.
[ -f "$J/platform.sh" ] && . "$J/platform.sh"
# Pronunciation is speech-only, so it is sourced by the DRAINER and not by the hook.
# The hook writes the daily log, and the log is read rather than heard: "the hooks file
# in exponent utilities" is the right thing to say and the wrong thing to read back
# tomorrow when you need to know which file it was.
[ -f "$J/pronounce.sh" ] && . "$J/pronounce.sh"
Q="$J/queue"; S="$J/state"
mkdir -p "$Q" "$S/active" "$S/pending" 2>/dev/null

SIR="${JARVIS_ADDRESS:-sir}"; [ -n "$SIR" ] && SIR=", $SIR"

# Resolve one voice per session slot, ONCE. Four sessions in four different voices is a
# stronger cue than four pitches of one voice: you recognise a voice without having to
# remember what slot 3 sounded like.
#
# Resolved here rather than per announcement because validating a name costs a full
# `say -v '?'` listing — and validating matters: `say` falls back to the US default for
# a name it does not have, silently, so an uninstalled voice would give session 2 an
# American accent with nothing anywhere to explain it.
# Read through indirection in voice_for(), which is what lets a slot be looked up by
# number instead of by four branches. A static checker cannot see that.
# shellcheck disable=SC2034
JV_V1=""
# shellcheck disable=SC2034
JV_V2=""
# shellcheck disable=SC2034
JV_V3=""
# shellcheck disable=SC2034
JV_V4=""
resolve_voices() {
  local want="${JARVIS_VOICES:-}" i=1 v
  # Nothing configured: every slot uses the single voice, and there is nothing to
  # validate. Skip the `say -v '?'` listing entirely — it is a process spawn on every
  # daemon start to answer a question whose answer is already known, and it made the
  # daemon a second slower to reach its first announcement.
  if [ -z "$want" ]; then
    # All four are read by indirection in voice_for(); a static checker cannot see it.
    JV_V1="${JARVIS_VOICE:-}"
    # shellcheck disable=SC2034
    JV_V2="$JV_V1"
    # shellcheck disable=SC2034
    JV_V3="$JV_V1"
    # shellcheck disable=SC2034
    JV_V4="$JV_V1"
    return 0
  fi
  local rest="$want"
  while [ "$i" -le 4 ]; do
    v="${rest%%|*}"
    case "$rest" in *\|*) rest="${rest#*|}" ;; *) rest="" ;; esac
    [ -z "$v" ] && v="${JARVIS_VOICE:-}"
    # Unavailable name -> the configured default. `doctor` reports which fell back.
    jv_voice_exists "$v" || v="${JARVIS_VOICE:-}"
    eval "JV_V$i=\"\$v\""
    i=$(( i + 1 ))
    [ -z "$rest" ] && rest="$want"
  done
}
resolve_voices

# voice_for <ordinal>
voice_for() {
  local o="${1:-1}" v
  case "$o" in ''|*[!0-9]*) o=1 ;; esac
  o=$(( (o - 1) % 4 + 1 ))
  v="JV_V$o"; printf '%s' "${!v-}"
}

pick()    { local a=("$@"); printf '%s' "${a[$(( RANDOM % ${#a[@]} ))]}"; }

# wpick <weight> <text> [<weight> <text> ...]
#
# Weighted variant choice. Flat `pick` gives the blandest phrasing the same airtime
# as the best one; a weight lets the plainest form dominate while the alternates keep
# the same event from being worded identically twice running.
#
# Vary the wording, never the register -- see JARVIS_REGISTER in config.sh.
wpick() {
  local total=0 i r acc=0
  for (( i = 1; i <= $#; i += 2 )); do total=$(( total + ${!i} )); done
  [ "$total" -le 0 ] && return 0
  r=$(( RANDOM % total ))
  for (( i = 1; i <= $#; i += 2 )); do
    acc=$(( acc + ${!i} ))
    if [ "$r" -lt "$acc" ]; then local j=$(( i + 1 )); printf '%s' "${!j}"; return; fi
  done
}

nactive() { ls "$S/active" 2>/dev/null | wc -l | tr -d ' '; }
speak()   { jv_say "$1" "${SPEAK_VOICE:-}"; }
banner()  { jv_notify "$1" "$2"; }

# budget <class> <text>
#
# Trim a clause to fit the time this class of event has earned.
#
# MEASURED, not assumed. `say -v Daniel -r 172 -o f.aiff` plus `afinfo`, on this
# machine:
#
#   8 ordinary words (long)   3.806s   476 ms/word
#   6 ordinary words (short)  1.637s   273 ms/word
#   6 spelled letters         1.343s   224 ms/letter
#   3 spelled letters         0.816s   272 ms/letter
#
# So cost tracks SYLLABLES, not tokens, and the familiar 0.38 s/word is only an
# average across both extremes. Per LETTER of ordinary prose it is a steady ~70 ms
# (72 and 68 in the two samples above), while a spelled letter costs ~224 ms because
# each one is its own syllable plus a pause.
#
# Counting tokens instead produced a real defect: budgeting runs after pronunciation
# (it must -- pronouncing EXPANDS, and it is the spoken length that costs seconds), so
# "the ERP UAT run" has already become eight tokens of single letters, and a six-token
# trim yielded "the E R P U A". Not a shortened announcement -- a different one.
#
# Two further rules, both found by ear:
#   * never cut inside a spelled acronym; fall back to where the run began
#   * prefer a clause boundary, since punctuation is the pacing and cutting on a
#     comma is free: "the schema is in" reads finished, "the schema is in, with
#     three" dangles
#
# The allowance is configured in WORDS because that is what the agent contract speaks
# in; it is converted here at the average and then spent in milliseconds.
MS_PER_LETTER=70
MS_PER_SPELLED=224
MS_PER_WORD_AVG=380
# A digit is spoken as a word but has no letters, so the first model scored "4 minutes"
# as one word and under-read the whole line by up to 50%. A comma or full stop is a
# real pause and costs real time. Both were measured against the table in
# `jarvisctl audition`.
MS_PER_DIGIT=280
MS_PER_PAUSE=100

# The optional third argument is the frame cost in milliseconds, MEASURED by the caller
# with spoken_ms rather than assumed. The default reserve is an average across events,
# and the gate frame is the longest of any of them -- "Approval needed on <session>, sir."
# runs 2230ms against a 2200 default, which put the longest gate name at 5.10s. An
# announcement that must never be talked over cannot rely on an average.
budget() {
  local cls="$1" txt="$2" words
  case "$cls" in
    problem) words="${JARVIS_BUDGET_PROBLEM:-9}" ;;
    blocked) words="${JARVIS_BUDGET_BLOCKED:-9}" ;;
    *)       words="${JARVIS_BUDGET_ROUTINE:-10}" ;;
  esac
  case "$words" in ''|*[!0-9]*) words=6 ;; esac
  local cap=$(( words * MS_PER_WORD_AVG ))

  # The word allowance is not the real constraint -- the CEILING is, and the frame
  # around the clause (the session name, ", sir", the elapsed time) is charged against
  # it too. Measuring showed the frame costs about 2s across every event type, so a
  # 12-word problem clause landed the whole announcement at 5.54s. Whichever bound is
  # tighter wins.
  local ceiling="${JARVIS_CEILING_MS:-5000}" reserve="${3:-${JARVIS_FRAME_MS:-2200}}"
  case "$ceiling" in ''|*[!0-9]*) ceiling=5000 ;; esac
  case "$reserve" in ''|*[!0-9]*) reserve=2200 ;; esac
  local hard=$(( ceiling - reserve ))
  [ "$hard" -lt 600 ] && hard=600
  [ "$cap" -gt "$hard" ] && cap=$hard

  local -a w=(); local t
  for t in $txt; do w+=("$t"); done
  [ "${#w[@]}" -eq 0 ] && { printf ''; return; }

  local i spent=0 cost cut=0 clause=0 runstart=-1 bare digits marks
  for (( i = 0; i < ${#w[@]}; i++ )); do
    t="${w[$i]}"
    bare="${t//[^A-Za-z]/}"
    digits="${t//[^0-9]/}"
    marks="${t//[^,.;:]/}"
    # "I" and "a" are WORDS, not spelled letters. Treating every single character as an
    # acronym letter charged the pronoun 224ms and made it an acronym boundary, so the
    # trim retreated in front of it: "exactly the trap I had recorded" lost three words
    # and became "exactly the trap".
    if [ ${#bare} -eq 1 ] && [ "$bare" != I ] && [ "$bare" != a ] && [ "$bare" != A ]; then
      cost=$MS_PER_SPELLED
      [ "$runstart" -lt 0 ] && runstart=$i
    else
      cost=$(( ${#bare} * MS_PER_LETTER ))
      runstart=-1
    fi
    cost=$(( cost + ${#digits} * MS_PER_DIGIT + ${#marks} * MS_PER_PAUSE ))
    spent=$(( spent + cost ))
    [ "$spent" -gt "$cap" ] && break
    cut=$(( i + 1 ))
    case "$t" in *,|*\;) clause=$(( i + 1 )) ;; esac
  done

  # Everything fits.
  [ "$cut" -ge "${#w[@]}" ] && { printf '%s' "$txt"; return; }

  # A boundary inside an acronym: retreat to where that run started.
  if [ "$runstart" -ge 0 ] && [ "$runstart" -lt "$cut" ]; then cut=$runstart; fi
  # A clause boundary beats a word boundary, provided it keeps enough to be a statement.
  local on_clause=0
  if [ "$clause" -gt 0 ] && [ "$clause" -le "$cut" ] && [ "$clause" -ge 3 ]; then
    cut=$clause; on_clause=1
  fi

  # Never end on a function word. Trimming by time alone produced "four tests are
  # failing on the refund path in the." -- a dangling article, which a synthesiser
  # reads with a falling tone as though the sentence had finished. Retreat until the
  # last surviving token can actually end a clause.
  #
  # SKIPPED when the cut landed on a comma: the author put a boundary there, which is
  # direct evidence the clause ended, and retreating anyway wrecked a good one --
  # "the Vendor Audit schema is in," became "the Vendor Audit schema", losing the verb
  # the contract exists to require.
  local last
  while [ "$on_clause" -eq 0 ] && [ "$cut" -gt 2 ]; do
    last=$(printf '%s' "${w[$(( cut - 1 ))]}" | tr 'A-Z' 'a-z')
    last="${last//[^a-z]/}"
    # The list is held in a variable so the `case` subject is not a constant --
    # same logic, but shellcheck SC2194 rightly flags "case <literal> in" as the
    # sort of thing that is usually a forgotten $.
    local funcwords=" a an the of in on at to for with and or but from by into as is are was were that which than its their his her our i had has have been being will would can could should may might must do does did "
    case "$funcwords" in
      *" $last "*) cut=$(( cut - 1 )) ;;
      *) break ;;
    esac
  done

  local out=""
  for (( i = 0; i < cut; i++ )); do out="$out ${w[$i]}"; done
  out="${out# }"
  out="${out%"${out##*[!,;:]}"}"

  # Too little left to be a statement: say nothing, and let the caller use the terse
  # form. The same principle summarise.awk applies -- a fragment read with confidence
  # is worse than no summary at all.
  local real=0
  for t in $out; do [ ${#t} -ge 2 ] && real=$(( real + 1 )); done
  [ "$real" -lt 2 ] && { printf ''; return; }
  printf '%s' "$out"
}

# spoken_ms <text>  -- the measured cost model, exposed for the duration table that
# `jarvisctl audition` prints. Same constants, so the table cannot drift from the trim.
spoken_ms() {
  local t bare digits marks total=0
  for t in $1; do
    bare="${t//[^A-Za-z]/}"
    digits="${t//[^0-9]/}"
    marks="${t//[^,.;:]/}"
    if [ ${#bare} -eq 1 ] && [ "$bare" != I ] && [ "$bare" != a ] && [ "$bare" != A ]
      then total=$(( total + MS_PER_SPELLED ))
    else total=$(( total + ${#bare} * MS_PER_LETTER )); fi
    total=$(( total + ${#digits} * MS_PER_DIGIT + ${#marks} * MS_PER_PAUSE ))
  done
  printf '%s' "$total"
}

TONES="$J/tones"
[ -f "$TONES/motifs.sh" ] && . "$TONES/motifs.sh"

# motif <kind> <session-ordinal>
#
# Ends by waiting out its own span, so speech starts AFTER the chime rather than
# underneath it. That costs about a third of a second and buys the intelligibility of
# the first word, which is normally the project name.
motif() {
  local k="$1" o="${2:-1}" v seq span item f d
  case "$o" in ''|*[!0-9]*) o=1 ;; esac
  [ "$o" -lt 1 ] || [ "$o" -gt 4 ] && o=$(( (o - 1) % 4 + 1 ))
  v="MOTIF_${k}_${o}"; seq="${!v-}"
  v="SPAN_${k}_${o}";  span="${!v-}"
  # No tones generated (or a partial install): stay silent rather than erroring. The
  # speech still carries the message, and `doctor` reports the missing set.
  [ -z "$seq" ] && return 0
  for item in $seq; do
    f="${item%%:*}"; d="${item##*:}"
    jv_play_at "$TONES/$f" "$d"
  done
  sleep "${span:-0.3}"
  return 0
}

# cap <text> -- upper-case the first letter.
#
# Speech does not care: `say` reads "the" and "The" identically. The BANNER and the
# daily log do care, and both render this text, so a clause dropped in after a full
# stop was showing up as a sentence that starts mid-thought. Applied only where the
# template actually puts it after a stop -- after a colon, lower case is correct.
cap() {
  local t="$1"
  [ -z "$t" ] && return 0
  printf '%s%s' "$(printf '%s' "${t:0:1}" | tr 'a-z' 'A-Z')" "${t:1}"
}

plural() { [ "$1" = "1" ] && printf '%s' "$2" || printf '%s' "$2s"; }

dur() {
  local s=${1:-0}
  if   [ "$s" -lt 90 ];   then echo "$s $(plural "$s" second)"
  elif [ "$s" -lt 5400 ]; then echo "$((s/60)) $(plural "$((s/60))" minute)"
  else echo "$((s/3600)) $(plural "$((s/3600))" hour)"; fi
}

# The spoken form of a session name. A directory basename is not a word: `wt_nst` is
# a worktree prefix plus an initialism, and `say` renders it as two nonsense
# syllables. JARVIS_NAMES overrides per project: "wt_nst=N S T;frappe-bench=bench".
spoken() {
  local n="$1" rest="${JARVIS_NAMES:-}" pair
  while [ -n "$rest" ]; do
    pair="${rest%%;*}"
    case "$rest" in *\;*) rest="${rest#*;}" ;; *) rest="" ;; esac
    [ -z "$pair" ] && continue
    if [ "${pair%%=*}" = "$n" ]; then printf '%s' "${pair#*=}"; return; fi
  done
  n="${n//_/ }"; n="${n//-/ }"
  case "$n" in "wt "*) n="${n#wt }" ;; esac
  # A short token with no vowel is an initialism, not a word: stripping the worktree
  # prefix from `wt_nst` left "nst", which `say` pronounces as one nonsense syllable.
  # Spelling it out is both correct and shorter to hear than the mangled attempt.
  local out="" w
  for w in $n; do
    case "$w" in
      *[aeiouAEIOU]*) out="$out $w" ;;
      ?|??|???|????)  out="$out $(echo "$w" | tr 'a-z' 'A-Z' | sed 's/./& /g;s/ *$//')" ;;
      *)              out="$out $w" ;;
    esac
  done
  printf '%s' "${out# }"
}

# The number word for a session slot, so the spoken ordinal matches the chime pitch and
# the two cues reinforce each other rather than being separate things to learn.
ordinal_word() {
  case "${1:-1}" in 1) echo one ;; 2) echo two ;; 3) echo three ;; 4) echo four ;; *) echo "$1" ;; esac
}

# The spoken identifier for a session. ALWAYS spoken, never conditional.
#
# It used to be spoken only when more than one session was live, to save a second of
# speech. That was wrong twice over: an announcement you cannot attribute is worthless,
# and the rule depended on live-session bookkeeping being accurate — which is exactly the
# thing most likely to be stale, so the failure mode was an anonymous announcement at the
# moment several projects were running.
#
# Sessions that SHARE a name get the ordinal appended. Several terminals open in one
# directory is the normal case for a bench or a monorepo, and they would otherwise all
# announce themselves identically — which is the same failure in a different disguise.
label_for() {
  local name="$1" ord="$2" n=0 f nm
  for f in "$S"/active/*; do
    [ -r "$f" ] || continue
    IFS='|' read -r nm _ < "$f"
    [ "$nm" = "$name" ] && n=$(( n + 1 ))
  done
  if [ "$n" -gt 1 ]; then
    printf '%s %s' "$(spoken "$name")" "$(ordinal_word "$ord")"
  else
    printf '%s' "$(spoken "$name")"
  fi
}

# render <mode> <name> <extra> <ordinal> [summary]
render() {
  local mode="$1" name="$2" extra="$3" ord="$4" summary="${5:-}"

  # Resolve the once-only farewell BEFORE anything is logged. Closing a terminal fires
  # every session's SessionEnd, so four byes reach render and three of them are
  # non-events — but they were still being written to the log, which then claimed four
  # farewells had been announced when one was. A log that overstates what was said is
  # worse than no log, because it is what `jarvisctl log` shows and what the
  # simulation reports.
  if [ "$mode" = bye ]; then
    { [ "$(nactive)" -eq 0 ] && mkdir "$J/run/farewell" 2>/dev/null; } || return 0
  fi

  # The voice for this session slot, for as long as this announcement lasts.
  local SPEAK_VOICE; SPEAK_VOICE=$(voice_for "$ord")

  # One line per announcement. This is what `jarvisctl log` shows and what the
  # concurrency tests assert against — the behaviour that matters is unobservable
  # otherwise, since the output is sound.
  printf '%s %-8s %-20s %-9s %s\n' "$(date +%H:%M:%S)" "$mode" "$name" "${extra:-—}" "${summary:-}" >> "$J/log" 2>/dev/null
  [ "$(wc -l < "$J/log" 2>/dev/null || echo 0)" -gt 500 ] && { tail -200 "$J/log" > "$J/log.t" 2>/dev/null && mv "$J/log.t" "$J/log"; }

  # Who this is about, always. The brevity saved by omitting it is not worth the
  # ambiguity: someone running four projects needs to know which one is talking before
  # they can use anything else in the sentence.
  local who; who="$(label_for "$name" "$ord")"

  # Pronounce the free text ONCE, here, rather than at each speak site. There are
  # eleven of those and a missed one is not a visible bug -- it is gibberish that only
  # a person with speakers ever finds.
  #
  # $extra is only free text for `brief`. Everywhere else it is a number (elapsed
  # seconds, a specialist count, a blocked duration) that the callers below format
  # themselves, and running those through a word-splitter would corrupt them.
  if command -v pronounce >/dev/null 2>&1; then
    [ -n "$summary" ] && summary="$(pronounce "$summary")"
    case "$mode" in brief|route|gate) extra="$(pronounce "$extra")" ;; esac
  fi

  # Strip a trailing full stop. Every clause here is a FRAGMENT embedded in a frame that
  # supplies its own sentence punctuation, and a lifted fallback sentence arrives with a
  # period already on it: "...exactly the trap I had recorded., sir. 3 minutes."
  #
  # Done here rather than in clip(), because clip also serves the LOG and DECISION
  # markers -- written prose, whole sentences, where the final period belongs.
  summary="${summary%.}"
  case "$mode" in brief|route|gate) extra="${extra%.}" ;; esac

  # Budget AFTER pronunciation, never before. Pronouncing expands: "the ERP UAT run"
  # is three words written and five spoken, and it is the spoken count that costs
  # seconds. Trimming first would let an announcement sail past the ceiling.
  # Budgeting happens in the BRANCH that speaks, never here. It was done centrally
  # first, with the average frame reserve, and then again in the branch with the
  # measured one -- so the average trimmed the clause before the accurate cap ever saw
  # it. "exactly the trap I had recorded" came out as "exactly the trap I had".
  #
  # Only `done` and `err` speak $summary; approve, nag and escalate use fixed phrases,
  # and brief carries its text in $extra.
  # gate and route put their text in $extra rather than $summary, because neither is a
  # turn summary -- one is a cause, the other a decision. Same ceiling applies.
  # gate and route are budgeted inside their own branches, where the frame is known
  # exactly. Charging them the average 2.2s reserve was wrong in both directions: it put
  # the longest gate name over the ceiling, and it trimmed "the console report engineer
  # was dropped" down to "the console report engineer" -- which says nothing at all.
  # route has the shortest frame of any event, so it can afford the whole clause.

  case "$mode" in
    boot)
      local h g; h=$(date +%H)
      if   [ "$h" -lt 12 ]; then g="Good morning"
      elif [ "$h" -lt 18 ]; then g="Good afternoon"
      else g="Good evening"; fi
      motif boot "$ord"
      # Boot is the moment the name matters most: it is how you learn what this session
      # will be called for the rest of its life.
      speak "$g$SIR. $who online." ;;

    tick) motif tick "$ord" ;;

    done)
      local el=${extra%%:*} subs=${extra##*:}
      case "$subs" in ''|*[!0-9]*) subs=0 ;; esac
      # A swarm run and a one-line edit both end in Stop. The specialist count is
      # the only thing in the announcement that distinguishes them.
      local crew=""
      [ "$subs" -ge 2 ] && crew=" $subs specialists,"
      motif 'done' "$ord"
      if [ -n "$summary" ]; then
        # The summary IS the content, so the specialist count goes. That count only ever
        # existed because there was nothing better to say than "time passed" — a run that
        # can report "schema is in, all tests pass" does not need to also report that six
        # agents were involved in it.
        # The most-heard informative announcement in the whole layer, and it had
        # exactly ONE phrasing -- so variation was absent precisely where content
        # was present. Weighted, with the plainest form dominant.
        # Fit the ASSEMBLED line, not an estimate of its frame. Measuring the frame
        # alone missed the variant prefix ("From ...", "... reports"), and the model
        # under-reads by roughly a fifth, so two of three completions measured 5.3s.
        # SLACK covers both; it is not a guess to be tuned by taste, it is the gap
        # between the model and `afinfo`.
        _ceil=$(( ${JARVIS_CEILING_MS:-5000} - ${JARVIS_MODEL_SLACK_MS:-800} ))
        _dur="$(dur "$el")"
        _line=$(wpick 4 "$who: $summary$SIR. $_dur." \
                       2 "$who, $summary$SIR. $_dur." \
                       2 "$who reports $summary$SIR. $_dur." \
                       1 "From $who, $summary$SIR. $_dur.")

        # Over budget: drop the ELAPSED TIME before touching the sentence. When there is
        # something to report, the duration is the least valuable thing in the line --
        # exactly the argument config.sh already makes for dropping the specialist count
        # once a summary exists. Truncating content to keep a timestamp is backwards.
        if [ "$(spoken_ms "$_line")" -gt "$_ceil" ]; then
          _line="$who: $summary$SIR."
        fi
        # Still over: now the sentence itself is too long, so trim it.
        if [ "$(spoken_ms "$_line")" -gt "$_ceil" ]; then
          summary="$(budget routine "$summary" "$(spoken_ms "$who $SIR . .")")"
          _line="$who: $summary$SIR."
        fi
        speak "$_line"
        banner "$name" "$summary  ($(dur "$el"))"
      else
        # All three carry $SIR. Two of them did not, so the persona addressed you on
        # one completion in three -- which reads as two different narrators rather
        # than one assistant with a habit.
        speak "$(pick "$who done$SIR.$crew $(dur "$el")." \
                      "$who finished$SIR.$crew $(dur "$el")." \
                      "$who, all done$SIR.$crew $(dur "$el").")"
        banner "$name" "Complete - $(dur "$el")${crew:+ -$crew}"
      fi ;;

    gate)
      # The loudest announcement in the system, and the only one that names its own
      # cause. Seven gates exist and they are not interchangeable: "needs your
      # approval" tells you to look; "a production deployment needs your approval"
      # tells you what you are about to be asked to authorise.
      #
      # The escalate motif, deliberately -- the same one a session blocked for five
      # minutes gets. A gate IS that situation, caught earlier.
      motif escalate 1
      # "<session> has hit a gate, sir. <gate> needs your approval." measured 5.12s on
      # the longer gate names -- over the ceiling, on the one announcement that must
      # never be talked over. "has hit a gate" was the redundant part: the escalate
      # motif already carries the severity, and leading with the ASK is drier anyway.
      # Measure this exact frame rather than trusting the average reserve, and charge
      # the deliberate 200ms pause to it as well.
      _gframe=$(( $(spoken_ms "Approval needed on $who$SIR. .") + 200 ))
      extra="$(budget blocked "$extra" "$_gframe")"
      speak "Approval needed on $who$SIR. [[slnc 200]] $(cap "$extra")."
      banner "$name" "GATE - $extra" ;;

    route)
      # A decision JARVIS routing made on your behalf. Information, not an
      # interruption, so it takes the quiet motif and the routine budget.
      motif idle "$ord"
      _rframe=$(spoken_ms "$who $SIR . .")
      extra="$(budget blocked "$extra" "$_rframe")"
      speak "$(wpick 3 "$who: $extra$SIR." \
                     1 "On $who, $extra$SIR.")" ;;

    approve)
      motif approve "$ord"
      speak "$(pick "$who needs your approval$SIR." \
                    "$who is holding for clearance$SIR." \
                    "$who needs you$SIR.")"
      banner "$name" "Approval required" ;;

    escalate)
      # The nags have run out and it is still blocked. This is the most expensive
      # failure the whole layer exists to catch — a session that has been stopped for
      # minutes while the others work — so it gets the loudest motif, a named duration,
      # and a banner that stays on screen.
      motif escalate 1
      speak "$who has been waiting $(dur "$extra")$SIR. [[slnc 200]] It is going nowhere without you."
      banner "$name" "STILL BLOCKED - $(dur "$extra")" ;;

    nag)
      motif nag "$ord"
      speak "$(pick "$who is still waiting$SIR." \
                    "Still blocked on $who$SIR." \
                    "$who has not moved$SIR.")" ;;

    idle)
      motif idle "$ord"
      speak "$(pick "$who is standing by$SIR." "$who awaits instruction$SIR.")" ;;

    sub) motif sub "$ord" ;;

    subspeak)
      motif sub "$ord"
      speak "$(pick "Specialist $extra, back." "Subroutine $extra complete.")" ;;

    err)
      motif err "$ord"
      # "Something has gone wrong in <session>" is a 2.9s frame, and with a 9-word
      # problem clause behind it `jarvisctl audition` measured the whole announcement
      # at 5.17s -- past the ceiling. Shorter is also drier, which the register wants.
      # An error used to announce only THAT something broke, never what. The clause is
      # the reason this event is spoken rather than logged, so it is carried now -- but
      # conditionally: appended unconditionally it read "has a problem, sir. ." on the
      # ordinary case where no agent left one.
      local etail=""
      if [ -n "$summary" ]; then
        _eframe=$(spoken_ms "$who has a problem $SIR . .")
        summary="$(budget problem "$summary" "$_eframe")"
        [ -n "$summary" ] && etail=" $(cap "$summary")."
      fi
      speak "$(wpick 3 "$who has a problem$SIR.$etail" \
                     2 "Trouble in $who$SIR.$etail" \
                     1 "$who has hit a problem$SIR.$etail")"
      banner "$name" "Error" ;;

    brief)
      # Spoken as a session closes, and only when something is still outstanding. It is
      # priority 3 — ahead of the farewell, behind anything urgent — so a session that is
      # shutting down still gets its say before "all sessions closed".
      motif idle "$ord"
      speak "$who closing$SIR. [[slnc 150]] $(cap "$extra")." ;;

    bye)
      # Reaching here at all means this session won the farewell — see the guard at
      # the top of render(). mkdir is the atomic test-and-set; `nactive -eq 0` alone
      # is not enough, because every closing session removes its own marker before
      # the first bye is ever claimed.
      motif bye 1
      # The only moment anything here has a view of the whole day. One line, once,
      # across every session — which is the point of having a single assistant rather
      # than one narrator per terminal.
      digest=""
      if [ "${JARVIS_DAY_DIGEST:-1}" = "1" ] && [ -s "$S/day" ]; then
        turns=$(grep -c '' "$S/day" 2>/dev/null); turns=${turns:-0}
        probs=$(grep -c '|problem|' "$S/day" 2>/dev/null); probs=${probs:-0}
        if [ "$turns" -gt 0 ]; then
          digest=" $turns $(plural "$turns" turn)"
          if [ "$probs" -gt 0 ]; then
            # Name where it was left, because "one problem outstanding" without a
            # session name is a puzzle rather than a report.
            last=$(grep '|problem|' "$S/day" 2>/dev/null | tail -1 | cut -d'|' -f1)
            digest="$digest, and $probs $(plural "$probs" problem) outstanding, last in $(spoken "$last")"
          else
            digest="$digest, nothing outstanding"
          fi
        fi
      fi
      rm -f "$S/day"
      speak "All sessions closed$SIR.$digest." ;;
  esac

  # Extension point. Anything executable in hooks.d gets the event after it has been
  # announced: mode, session name, extra, ordinal. Backgrounded, output discarded, and
  # its exit status ignored — a user script must never be able to stall or kill the
  # daemon, because it would take every announcement down with it.
  if [ -d "$J/hooks.d" ]; then
    for h in "$J/hooks.d"/*; do
      [ -f "$h" ] && [ -x "$h" ] || continue
      ( "$h" "$mode" "$name" "$extra" "$ord" >/dev/null 2>&1 ) &
    done
  fi
  return 0
}

# Re-announce sessions still blocked on approval. Driven from the idle loop, so it
# needs no additional hook — and there is no hook that could serve it anyway,
# since nothing fires when a permission prompt goes unanswered.
check_nags() {
  [ "${JARVIS_NAG:-2}" = "0" ] && return
  local now f ts nm n age line ord
  now=$(date +%s)
  for f in "$S"/pending/*; do
    [ -e "$f" ] || continue
    IFS='|' read -r ts nm n esc < "$f"
    case "$ts" in ''|*[!0-9]*) continue ;; esac
    case "$n"  in ''|*[!0-9]*) n=0 ;; esac
    case "$esc" in ''|*[!0-9]*) esc=0 ;; esac
    age=$(( now - ts ))
    ord=1
    [ -r "$S/active/$(basename "$f")" ] && { read -r line < "$S/active/$(basename "$f")"; ord=${line##*|}; }

    if [ "$age" -ge $(( ${JARVIS_NAG_AFTER:-70} * (n + 1) )) ] && [ "$n" -lt "${JARVIS_NAG:-2}" ]; then
      printf '%s|%s|%s|%s\n' "$ts" "$nm" "$(( n + 1 ))" "$esc" > "$f"
      printf 'nag|%s||%s|%s|%s\n' "$nm" "$now" "$ord" "$(basename "$f")" > "$Q/1-$now-$$-$RANDOM"
    elif [ "$esc" = 0 ] && [ "${JARVIS_ESCALATE:-300}" != "0" ] && [ "$age" -ge "${JARVIS_ESCALATE:-300}" ]; then
      # Once only, and only after the nags are spent. Repeating an escalation turns the
      # most important alert in the set into background noise, which is the one thing
      # it cannot afford to become.
      printf '%s|%s|%s|1\n' "$ts" "$nm" "$n" > "$f"
      printf 'escalate|%s|%s|%s|%s|%s\n' "$nm" "$age" "$now" "$ord" "$(basename "$f")" > "$Q/0-$now-$$-$RANDOM"
    fi
  done
}

# Sourced as a library (JARVIS_LIB=1) the file stops here, exposing motif(), rate(),
# spoken(), dur() and the generated motif table for testing. A motif that references
# a tone which was never generated is silent and reports nothing, so it has to be
# asserted rather than heard.
[ "${JARVIS_LIB:-0}" = "1" ] && return 0

# Lifecycle ledger. A duplicate daemon is the failure this lock exists to prevent,
# and a point-in-time `ps` count misses one that starts and dies between samples —
# so every daemon records its own birth and death and the test counts births.
ledger() { printf '%s %s %s\n' "$(date +%s)" "$$" "$1" >> "$J/run/daemons.log" 2>/dev/null; }
# Idempotent, and it must be. `trap ... EXIT INT TERM` runs the TERM handler and
# then, because the shell goes on to exit, the EXIT handler as well — so cleanup ran
# twice and wrote two exit lines for one daemon. That made "how many daemons are
# live" read one below the truth, which is what `doctor` reports and what the test
# harness asserts on.
CLEANED=""
cleanup() {
  [ -n "$CLEANED" ] && return 0
  CLEANED=1
  trap - EXIT INT TERM
  [ "$(cat "$J/run/lock/pid" 2>/dev/null)" = "$$" ] && rm -rf "$J/run/lock"
  ledger exit
  return 0
}
trap cleanup EXIT INT TERM
echo $$ > "$J/run/lock/pid"
ledger start

idle_ticks=0
while :; do
  # If the lock is no longer ours, stand down immediately. This is what makes a
  # duplicate daemon impossible rather than merely unlikely, and it is also how an
  # orphan left behind by `jarvisctl reset` cleans itself up.
  [ "$(cat "$J/run/lock/pid" 2>/dev/null)" = "$$" ] || exit 0

  # Lowest-sorting queue entry, by glob rather than by `ls | grep`. Queue names begin
  # with the priority digit and claims begin with a dot, so the pattern excludes claims
  # by construction — and glob expansion is already sorted, which is what puts urgent
  # items first.
  f=""
  for g in "$Q"/[0-9]*; do
    [ -e "$g" ] || continue
    f=${g##*/}
    break
  done
  if [ -z "$f" ]; then
    idle_ticks=$(( idle_ticks + 1 ))
    [ $(( idle_ticks % 20 )) -eq 0 ] && check_nags
    [ "$idle_ticks" -gt 240 ] && break     # ~2 min quiet, then exit
    sleep 0.5; continue
  fi
  idle_ticks=0

  # Mute is checked HERE as well as in the hook. The hook cannot cover two cases:
  # an item queued in the second before you muted, and — worse — the nags, which the
  # daemon generates itself from its idle loop and which therefore never pass through
  # a hook at all. Muting for fifteen minutes did not stop it nagging.
  if [ -f "$S/muted" ] && [ "$(cat "$S/muted" 2>/dev/null)" -gt "$(date +%s)" ] 2>/dev/null; then
    rm -f "$Q"/[0-9]* 2>/dev/null
    sleep 0.5; continue
  fi

  # Claim atomically. `cat` then `rm` let two readers take the same entry and
  # announce it twice; `mv` cannot, and losing the race is a clean skip.
  claim="$Q/.claim.$$"
  mv "$Q/$f" "$claim" 2>/dev/null || continue
  line=$(cat "$claim" 2>/dev/null); rm -f "$claim"
  [ -z "$line" ] && continue
  # `key` is unused but must be read: without it the trailing field would be appended
  # to `ord`, and the chime would land on the wrong session.
  # shellcheck disable=SC2034
  IFS='|' read -r mode name extra born ord key summary <<< "$line"

  pri=${f%%-*}
  case "$born" in ''|*[!0-9]*) born=0 ;; esac
  age=$(( $(date +%s) - born ))

  if [ "$pri" -ge 4 ]; then
    [ "$age" -gt "${JARVIS_STALE:-50}" ] && continue

    # TRAILING debounce: wait for the burst to STOP, not merely for a fixed interval
    # to pass. A single 1.2s wait collapses only what has already arrived, so a burst
    # spread wider than the window straddles it — six subagent events 0.3s apart
    # produced two chimes, and six completions produced two announcements. Each round
    # absorbs everything matching, keeps the NEWEST (its elapsed time is the accurate
    # one), and goes round again only if more turned up while it was absorbing.
    #
    # Bounded at five rounds. An unbounded wait would let a session that chatters
    # steadily defer its own announcement forever.
    absorbed=0
    while [ "$absorbed" -lt 5 ]; do
      sleep 1.2
      # Ownership is re-checked HERE as well as at the top of the loop. The debounce
      # can hold this for six seconds, and an orphan that keeps announcing for six
      # seconds after being replaced is exactly the overlap the lock exists to prevent.
      [ "$(cat "$J/run/lock/pid" 2>/dev/null)" = "$$" ] || exit 0
      newest=""
      for g in "$Q"/[0-9]*; do
        [ -e "$g" ] || continue
        # -F is not optional: without it '|' is regex alternation, and the empty
        # trailing alternative matches every file.
        grep -qF "$mode|$name|" "$g" 2>/dev/null && newest="$g"
      done
      [ -z "$newest" ] && break
      nline=$(cat "$newest" 2>/dev/null)
      for g in "$Q"/[0-9]*; do
        [ -e "$g" ] || continue
        grep -qF "$mode|$name|" "$g" 2>/dev/null && rm -f "$g"
      done
      if [ -n "$nline" ]; then
        line="$nline"
        # shellcheck disable=SC2034
        IFS='|' read -r mode name extra born ord key summary <<< "$line"
      fi
      absorbed=$(( absorbed + 1 ))
    done
  fi

  render "$mode" "$name" "$extra" "$ord" "$summary"
done
