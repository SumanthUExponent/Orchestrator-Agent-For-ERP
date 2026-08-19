#!/usr/bin/env bash
# Turn text written for the eye into words that survive a speech synthesiser.
#
# WHY THIS EXISTS
#
# `spoken()` in speaker.sh normalises exactly one thing: the session name. Everything
# else in an announcement — the agent's clause, the fallback sentence, a pending item —
# went to the engine raw. Real lines out of the daily log:
#
#   appsexponentutilitieshooks.py
#   .claudestatusline.sh: binbash
#   wtnst build green
#
# The word-boundary half of that is fixed upstream in jarvis.sh, before the allowlist
# deletes the separators. What is left is this: an identifier with its boundaries intact
# is still not English. "hooks.py" is not a word, "ERP" is not a syllable, and "4m12s"
# is not a duration until someone says so.
#
# WHERE IT RUNS, AND WHY NOT EARLIER
#
# At SPEAK time, in speaker.sh — deliberately not in the hook. The daily log is a
# WRITTEN record and wants the richer original: "the hooks file in exponent utilities"
# is the right thing to hear and the wrong thing to read six hours later when you need
# to know which file. Separator repair belongs upstream because a fused token is wrong
# in both places; pronunciation belongs here because it is only right in one.
#
# CONSTRAINTS
#
# Zero dependencies: the vocabulary is data in config.sh, the rules are awk. No model
# call, no network, no NLP library. One awk process per announcement.
#
# The default tables are repeated inline below, verbatim. That duplication is deliberate
# and load-bearing: config.sh is NEVER overwritten on upgrade, so anyone who already has
# one would not receive these tables, the inline fallback would be the effective default,
# and pronunciation would silently do nothing for every existing user. The two copies are
# held in sync by tests/voice.test.mjs, "documented defaults are the real defaults".
#
# Everything emitted stays inside the speech allowlist ("A-Za-z0-9 .,;:'-"). A rule that
# would need a forbidden character does not ship. This file names no OS tool, so
# platform.sh remains the only place that does.
#
# Usage:  pronounce "updated apps exponent utilities hooks.py"
#         -> "updated apps exponent utilities the hooks file"
#
# EDITING NOTE: the awk program below is inside a single-quoted shell string, so it must
# contain NO apostrophe anywhere -- not even in a comment. One in the word "loop-s" ended
# the string mid-program and bash then tried to parse awk as shell.

# pronounce <text>
#
# Idempotent for already-spoken text: every rule is keyed on a shape that plain English
# does not have, so running it twice changes nothing.
pronounce() {
  [ -z "${1:-}" ] && return 0
  printf '%s' "$1" | awk \
    -v SPELL="${JARVIS_SPELL_OUT:-API;CRM;UI;UX;DB;SQL;CI;CD;PR;QA;URL;URI;SSH;TLS;SSL;HTTP;JSON;YAML;XML;HTML;CSS;CSV;PDF;JWT;JS;TS;VM;OS;IO;CPU;RAM;SDK;CLI;GUI;IDE;SPA;ORM;RPC;DNS;CDN;S3;EC2;VPC;IAM;TTS}" \
    -v ASWORD="${JARVIS_SAY_AS_WORD:-JARVIS;JSON5;REST;SOAP;CRON;SASS;JIRA;SCADA;CRUD;GRPC;OAUTH;YAML}" \
    -v GLOSS="${JARVIS_GLOSSARY:-nginx=engine X;venv=v env;cwd=working directory;env=environment;repo=repository;async=a sync;regex=regex;stdout=standard out;stderr=standard error;npm=N P M;mjs=M J S;jwt=J W T;yaml=yamel;sqlite=sequel light;kubectl=cube control;k8s=kubernetes;nodejs=node J S;psql=P sequel;localhost=local host;middleware=middleware;webhook=webhook}" \
    -v FILES="${JARVIS_FILEWORDS:-hooks.py=the hooks file;settings.json=the settings file;package.json=the package file;claude.md=the CLAUDE file;config.sh=the config file;hooks.py=the hooks file;pyproject.toml=the project file;modules.txt=the modules list}" \
    -v EXTS="${JARVIS_EXTWORDS:-py=Python file;js=JavaScript file;mjs=JavaScript file;ts=TypeScript file;json=config file;sh=shell script;md=markdown file;txt=text file;yaml=config file;yml=config file;toml=config file;css=stylesheet;html=page;vue=component;sql=S Q L file;log=log file}" '
    # ---------------------------------------------------------------- tables
    # "k=v;k=v" into an array, keyed lower-case. A bare "k" with no "=" is set
    # membership, which is how the two acronym lists are expressed.
    function load(spec, arr,    n, i, p, parts) {
      n = split(spec, parts, ";")
      for (i = 1; i <= n; i++) {
        if (parts[i] == "") continue
        p = index(parts[i], "=")
        if (p > 0) arr[tolower(substr(parts[i], 1, p - 1))] = substr(parts[i], p + 1)
        else       arr[tolower(parts[i])] = "\001"
      }
    }

    function numword(n) {
      if (n in NW) return NW[n]
      return n
    }

    # ------------------------------------------------------- letter spelling
    # "ERP" -> "E R P". Uppercased first: a spelled letter has to be a letter name,
    # and lower case reads as a syllable attempt.
    function spell(t,   i, out) {
      out = ""
      t = toupper(t)
      for (i = 1; i <= length(t); i++) out = out (i > 1 ? " " : "") substr(t, i, 1)
      return out
    }

    # ------------------------------------------------------- case splitting
    # getValue -> "get Value";  ERPNext -> "ERP Next".
    # Two rules, and the second is the one people forget: a capital that follows a
    # capital but is followed by a lower-case letter opens a new word, which is what
    # keeps a leading acronym intact instead of shattering it into initials.
    function decase(t,    i, c, p, nx, out) {
      out = substr(t, 1, 1)
      for (i = 2; i <= length(t); i++) {
        c  = substr(t, i, 1)
        p  = substr(t, i - 1, 1)
        nx = (i < length(t)) ? substr(t, i + 1, 1) : ""
        if (c ~ /[A-Z]/ && p ~ /[a-z0-9]/)                          out = out " " c
        else if (c ~ /[A-Z]/ && p ~ /[A-Z]/ && nx ~ /[a-z]/)        out = out " " c
        else                                                        out = out c
      }
      return out
    }

    # ------------------------------------------------------------- durations
    # 4m12s -> "four minutes twelve".  90s -> "ninety seconds".  2h5m -> "two hours five".
    function duration(t,   h, m, s, out) {
      out = ""
      if (match(t, /^[0-9]+h[0-9]+m$/)) {
        h = substr(t, 1, index(t, "h") - 1); m = substr(t, index(t, "h") + 1)
        sub(/m$/, "", m)
        return numword(h + 0) " " (h + 0 == 1 ? "hour" : "hours") " " numword(m + 0)
      }
      if (match(t, /^[0-9]+m[0-9]+s$/)) {
        m = substr(t, 1, index(t, "m") - 1); s = substr(t, index(t, "m") + 1)
        sub(/s$/, "", s)
        return numword(m + 0) " " (m + 0 == 1 ? "minute" : "minutes") " " numword(s + 0)
      }
      if (match(t, /^[0-9]+m$/)) { m = t; sub(/m$/, "", m)
        return numword(m + 0) " " (m + 0 == 1 ? "minute" : "minutes") }
      if (match(t, /^[0-9]+s$/)) { s = t; sub(/s$/, "", s)
        return numword(s + 0) " " (s + 0 == 1 ? "second" : "seconds") }
      if (match(t, /^[0-9]+h$/)) { h = t; sub(/h$/, "", h)
        return numword(h + 0) " " (h + 0 == 1 ? "hour" : "hours") }
      return ""
    }

    # -------------------------------------------------------------- versions
    # v2.1 -> "version two point one".  Left alone otherwise, because "2.1" on its own
    # is a number the engine already reads correctly.
    function version(t,    body, n, i, parts, out) {
      body = t; sub(/^[vV]/, "", body)
      if (body !~ /^[0-9]+(\.[0-9]+)+$/) return ""
      n = split(body, parts, ".")
      out = "version"
      for (i = 1; i <= n; i++) out = out (i > 1 ? " point " : " ") numword(parts[i] + 0)
      return out
    }

    # ------------------------------------------------------------ file names
    # hooks.py -> "the hooks file" from the named table, else the extension becomes a
    # noun: statusline.sh -> "the statusline shell script". Never "dot s h".
    # `i` MUST be in the local list. awk has no other way to declare a local, so
    # omitting it clobbers the counter of the main token loop -- which does not error,
    # it hangs forever.
    function filename(t,    base, ext, p, key, i) {
      key = tolower(t)
      if (key in FILEW) return FILEW[key]
      p = 0
      for (i = length(t); i > 1; i--) if (substr(t, i, 1) == ".") { p = i; break }
      if (p == 0) return ""
      base = substr(t, 1, p - 1); ext = tolower(substr(t, p + 1))
      if (!(ext in EXTW)) return ""
      if (base == "") return "the " EXTW[ext]
      return "the " decase(base) " " EXTW[ext]
    }

    BEGIN {
      split("zero one two three four five six seven eight nine ten eleven twelve " \
            "thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty", W, " ")
      for (i = 1; i <= 21; i++) NW[i - 1] = W[i]
      # Enough for a duration in seconds or minutes; past sixty the engine reads the
      # digits correctly on its own and a word form is only longer.
      split("thirty forty fifty", T, " ")
      for (i = 0; i < 3; i++) { NW[30 + i * 10] = T[i + 1] }
      for (b = 20; b <= 50; b += 10) {
        base = (b == 20) ? "twenty" : NW[b]
        for (d = 1; d <= 9; d++) NW[b + d] = base " " W[d + 1]
      }
      load(SPELL, SPELLA); load(ASWORD, ASWORDA)
      load(GLOSS, GLOSSA); load(FILES, FILEW); load(EXTS, EXTW)
    }

    {
      n = split($0, tok, " ")
      out = ""
      for (i = 1; i <= n; i++) {
        t = tok[i]
        if (t == "") continue

        # Punctuation rides along with the word it is attached to, so a clause keeps
        # its commas and full stops -- those are the pacing, not decoration.
        head = ""; tail = ""
        while (t ~ /^[^A-Za-z0-9]/) { head = head substr(t, 1, 1); t = substr(t, 2) }
        while (t ~ /[^A-Za-z0-9]$/) { tail = substr(t, length(t), 1) tail; t = substr(t, 1, length(t) - 1) }
        if (t == "") { out = out " " head tail; continue }

        key = tolower(t)
        rep = ""

        # Order matters. Most specific shape first; a token that matched a named rule
        # must not then be pulled apart by a general one.
        if      (key in GLOSSA)                 rep = GLOSSA[key]
        else if (key in ASWORDA)                rep = t
        else if (toupper(t) == t && t ~ /^[A-Z]+$/ && key in SPELLA) rep = spell(t)
        else if ((r = filename(t))  != "")      rep = r
        else if ((r = duration(t))  != "")      rep = r
        else if ((r = version(t))   != "")      rep = r
        # An all-caps token nobody declared: spell it. A word would have been written
        # in lower case, so capitals are a signal, and 2-5 letters is the length that
        # is an initialism rather than SHOUTING.
        else if (t ~ /^[A-Z][A-Z0-9]{1,4}$/)    rep = spell(t)
        # A short token with no vowel cannot be pronounced at all. This is the rule
        # that already earned its place on "nst".
        else if (t ~ /^[A-Za-z]{1,4}$/ && t !~ /[aeiouAEIOU]/) rep = spell(t)
        else if (t ~ /[a-z][A-Z]/ || t ~ /[A-Z][A-Z][a-z]/)    rep = decase(t)
        else                                    rep = t

        out = out " " head rep tail
      }
      sub(/^ /, "", out)
      gsub(/  +/, " ", out)
      print out
    }'
}
