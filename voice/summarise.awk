# Pick the sentence from a turn that best reports an OUTCOME.
#
# WHY A SCORED PICK, NOT THE OPENING SENTENCE
#
# The main thread emits no VOICE marker -- one in a reply is visible clutter for the
# person reading it -- so on an ordinary turn this is the ONLY source of a summary,
# which makes it the common case rather than the exception. Taking the opening
# sentence is cheap and was wrong most of the time. Real announcements it produced:
#
#   "I cannot restart myself from inside the session the running process is..."
#   "Typo cladue to claude."
#   "The lane pipes stdout, so it is never a TTY..."
#
# The opening sentence of a reply is very often meta-commentary, a discourse opener,
# or a capability disclaimer. None of those is what happened. So every candidate
# sentence is scored on shape alone and the best one wins -- and when nothing scores,
# NOTHING is returned, because the terse completion form is a far better announcement
# than a confidently-read fragment.
#
# No model call, no network, no state. Shape only: an outcome verb, the absence of a
# first-person or discourse opener, a sentence that terminates, a sane word count.
#
# It is an `awk -f` program rather than an inline one deliberately: a program in a
# single-quoted shell string may contain no apostrophe anywhere, including in its
# comments, and that trap has already cost this repo two debugging rounds.
#
# Usage: printf %s "$HOOK_PAYLOAD" | awk -f summarise.awk    (exit 1 = no summary)

# ------------------------------------------------------------------ extraction
# Accumulate the whole payload, then work in END. JSON escapes real newlines, so
# concatenating input lines cannot join two sentences that were separate.
{ raw = raw $0 }

END {
  # Locate the field, then read to the first UNESCAPED quote. Cutting at the first
  # quote of any kind truncates the message at its first quoted word; not cutting at
  # all feeds the JSON tail into the scorer.
  k = "\"last_assistant_message\":\""
  p = index(raw, k)
  if (p == 0) exit 1
  rest = substr(raw, p + length(k))
  msg = ""
  for (i = 1; i <= length(rest); i++) {
    c = substr(rest, i, 1)
    if (c == "\\") { msg = msg c substr(rest, i + 1, 1); i++; continue }
    if (c == "\"") break
    msg = msg c
  }
  if (msg == "") exit 1

  # Unescape. \n first would make the later \\ pass corrupt a literal backslash-n.
  gsub(/\\\\/, "\001", msg)
  gsub(/\\n/, "\n", msg)
  gsub(/\\t/, " ", msg)
  gsub(/\\"/, "\"", msg)
  gsub(/\001/, "\\", msg)

  # -------------------------------------------------------------- preprocessing
  # Strip what is written for the eye. A fenced block, a table row and a bullet
  # marker are all layout, and reading layout aloud is how "bash binbash" happened.
  nl = split(msg, L, "\n")
  fence = 0; text = ""
  for (li = 1; li <= nl; li++) {
    line = L[li]
    if (line ~ /^ *(```|~~~)/) { fence = 1 - fence; continue }
    if (fence) continue
    if (line ~ /^ *\|/) continue
    # UNWRAP inline code, do not delete it. Deleting was the single worst defect in
    # the whole layer: inline code carries the SUBJECT of the sentence, so real
    # announcements came out as
    #     "Fixed at , pushed."          from  Fixed at `abb3d0d`, pushed.
    #     "Done and pushed on ."        from  Done and pushed on `develop`.
    #     "the server side: and ."      from  ... `gate_note` and `log_note`.
    # Long spans are still dropped -- those are commands and paths, not subjects --
    # but anything short enough to be an identifier stays and pronounce.sh speaks it.
    while (match(line, /`[^`]*`/)) {
      inner = substr(line, RSTART + 1, RLENGTH - 2)
      line = substr(line, 1, RSTART - 1) \
             (length(inner) <= 24 ? inner : " ") \
             substr(line, RSTART + RLENGTH)
    }
    if (line ~ /^[ \t]*#+[ \t]/) continue
    sub(/^[ \t]*[>*+-][ \t]+/, "", line)
    sub(/^[ \t]*[0-9]+\.[ \t]+/, "", line)
    gsub(/\*\*/, "", line)
    gsub(/\[|\]/, "", line)
    text = text " " line
  }


  # -------------------------------------------------------- sentence split
  # A period is a boundary only when a space or the end follows it. Otherwise
  # "v2.1" and "hooks.py" each become two sentences.
  ns = 0; cur = ""
  n = length(text)
  for (i = 1; i <= n; i++) {
    c  = substr(text, i, 1)
    nx = (i < n) ? substr(text, i + 1, 1) : " "
    cur = cur c
    if ((c == "." || c == "!" || c == "?") && nx == " ") {
      ns++; sent[ns] = cur; cur = ""
      if (ns >= 12) break
    }
  }
  if (ns < 12 && cur ~ /[A-Za-z]/) { ns++; sent[ns] = cur }

  # ------------------------------------------------------------- outcome verbs
  # A turn that changed something says so with one of these. This is the whole
  # signal, and it is why a scored pick beats taking the opening sentence: the
  # opening is very often meta-commentary about what cannot be done.
  split("added fixed wrote built updated removed renamed migrated installed " \
        "verified ran passed failed created deleted merged committed landed " \
        "shipped replaced corrected patched wired synced restored generated " \
        "registered enabled disabled documented refactored tagged pushed " \
        "green complete done working live pass passes validates rebuilt " \
        "rebuild tagged cleared resolved landed added moved switched", V, " ")
  for (k in V) VERB[V[k]] = 1

  best = ""; bestscore = 0
  for (i = 1; i <= ns; i++) {
    s = sent[i]
    sub(/^[ \t]+/, "", s); sub(/[ \t]+$/, "", s)
    if (s !~ /[A-Za-z]/) continue

    nw = split(s, w, " ")

    # Real words, not fragments of punctuation. Removing inline code can leave a
    # sentence that is structurally intact and says nothing: "Typo -- -> ."
    real = 0; letters = 0
    for (j = 1; j <= nw; j++) {
      t = w[j]; gsub(/[^A-Za-z]/, "", t)
      letters += length(t)
      if (length(t) >= 2) real++
    }
    if (real < 3 || letters < 12) continue

    score = 0

    # An outcome verb anywhere is the strongest positive.
    for (j = 1; j <= nw; j++) {
      t = tolower(w[j]); gsub(/[^a-z]/, "", t)
      if (t in VERB) { score += 3; break }
    }

    # First person is the voice of meta-commentary, not of an outcome:
    # "I cannot restart myself from inside the session" was a real announcement.
    if (s ~ /^(I|Im|I have|I will|I can|I could)( |,|$)/) score -= 4
    if (tolower(s) ~ /(cannot|can not|can t|won t|unable to|not possible)/) score -= 3
    # A discourse opener announces that an answer is coming; it is never the answer.
    # "Let me walk through what I found." outscored the sentence that reported the
    # actual outcome, purely because it came first.
    if (s ~ /^(Let me|Let us|Lets|Here is|Heres|Here are|First|Next|Then|Also|So|Now let)( |,)/) score -= 5
    # An ANSWER is not an outcome. "Yes both, one commit, one branch, pushed." was a
    # real announcement: it answers a question nobody listening heard being asked.
    if (s ~ /^(Yes|No|Correct|Indeed|Right|Sure|Exactly|Both|Neither|Almost|Nearly|Probably|Possibly)( |,|\.)/) score -= 5
    # Action first. A sentence that OPENS on what was done is the one worth hearing,
    # which is the whole point of an announcement rather than a status field.
    if (s ~ /^(Added|Fixed|Wrote|Built|Updated|Removed|Renamed|Migrated|Installed|Verified|Ran|Created|Deleted|Merged|Committed|Landed|Shipped|Replaced|Corrected|Patched|Wired|Synced|Restored|Generated|Registered|Enabled|Disabled|Documented|Refactored|Tagged|Pushed|Rebuilt|Cleared|Resolved|Moved|Switched|Dropped|Split|Renamed)( |,)/) score += 4
    # "now" marks a state that changed, which is exactly what an announcement is for.
    if (tolower(s) ~ / now /) score += 2
    if (s ~ /\?$/) score -= 3
    if (s !~ /[.!?]$/) score -= 2
    if (nw >= 4 && nw <= 16) score += 1
    if (nw < 4) score -= 2
    # Earlier sentences are likelier to be the headline, so a later one has to be
    # strictly better to win. Ties go to the top of the message.
    score = score * 100 - i

    if (score > bestscore) { bestscore = score; best = s }
  }

  # Nothing scored: say nothing rather than read out a fragment. The terse form
  # is a worse announcement than a good sentence and a much better one than a
  # mangled half-sentence.
  if (bestscore <= 0) exit 1
  print best
}
