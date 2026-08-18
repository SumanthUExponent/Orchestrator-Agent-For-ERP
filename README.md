# Orchestrator Agent for ERP

[![ci](https://github.com/SumanthUExponent/Orchestrator-Agent-For-ERP/actions/workflows/ci.yml/badge.svg)](https://github.com/SumanthUExponent/Orchestrator-Agent-For-ERP/actions/workflows/ci.yml)

A sub-agent swarm for [Claude Code](https://claude.com/claude-code), tuned for Frappe/ERPNext development.

45 specialist agents across 9 divisions, coordinated by an orchestrator, policed by passive governance agents that audit the swarm itself, and paced by a control plane whose entire job is to convene less of it.

You describe the work. The orchestrator decides which specialist skills apply, what order they run in, what can run in parallel, and which gates the work must clear before it can be called done.

```
$ node scripts/orchestrator.mjs plan "System Console installer for a Vendor Audit DocType with approval workflow"

Effort: standard  ·  Gates: verify
Skills routed: console-automation-engine, frappe-doctype, frappe-workflow

Execution plan
  Batch 1  (phase 2)
       - requirements-analyst   sonnet  required by frappe-architect
  Batch 2  (phase 2)
       - frappe-architect       opus    required by data-model-architect
  Batch 3  (phase 2)
       - data-model-architect   opus    via frappe-doctype
  Batch 4  (phase 2)
       - frappe-data            sonnet  required by frappe-backend
  Batch 5  (phase 2)
       - frappe-backend         sonnet  via frappe-workflow
  Batch 6  (phase 4)
       - console-deployer       opus    via console-automation-engine

Dropped
  - demo-builder (contested): contested console-automation-engine;
    console-deployer matched the request more closely (2 vs 0)

Cost
  Dispatches: 6  ·  serial steps 6 -> batched 6
  Relative cost index: 54 vs 90 all-opus baseline (40% lower)
```

`route` answers *which skills*. `plan` answers *which agents, in what batches, at which tier* — and tells you what the run cost.

## Why this exists

Once you have more than a dozen skills installed, three failures appear, and none is solved by adding more skills.

**You stop remembering what you have.** A skill you forget to invoke may as well not be installed.

**Skills start competing.** Two skills that both claim "build the deployment script" produce contradictory output and waste the work. Skill packs frequently ship their own entry-point router, so several things end up trying to be in charge.

**Skill descriptions are what routing runs on, and they are budgeted.** Claude Code allots roughly 1% of the context window to the skill listing. Past that, descriptions are truncated — so installing *more* skills can make routing *worse*, silently. Adding ~350 skills to a 50-skill setup takes the listing beyond 200% of budget and compresses every description to under half its text.

This repository is the machinery for deciding *what not to load*, and for making that decision inspectable.

## How it works

```
request → effort mode → decision table ─┬─ matched → skills
                                        └─ no match → scorer → thresholds
                                                 ↓
                        dependency expansion → conflict resolution
                                                 ↓
                                  effort cap → phase ordering → plan
```

**Decision table first.** An ordered rule list in `registry/routing.yaml`. First match wins; narrow rules sit above broad ones. Tables are inspectable, diffable and testable, so common cases cannot drift.

**Scorer only on ambiguity.** When no rule matches, four weighted signals produce a 0–1 confidence per skill: trigger match (0.45), category intent (0.25), repository context (0.20), priority bias (0.10). Thresholds map scores to mandatory / recommended / conditional / passive. This exists so novel phrasing still routes — not so every routine decision becomes a floating-point argument.

**Repository context matters.** The presence of `hooks.py` or a `doctype/` directory raises confidence for the server and data-model categories. "Add a field" routes differently in a Frappe app than in a React project.

**Phases, not hardcoded pairs.** Every category carries a phase number. Ordering, parallelism and gates fall out of the phase table, so adding a skill never means editing a sequence by hand.

## Speed is a design problem, not a model problem

A swarm gets slow in ways that never show up as an error. Four of them, and what the repository does about each:

**Everything ran on the biggest model.** Agents that said `model: inherit` silently cost whatever the session cost, so all 39 ran on Opus — nobody chose that, it was the default leaking through. Tiers are now explicit and `inherit` is gone: **12 opus, 31 sonnet, 2 haiku**. Opus is reserved for output that is a design decision with blast radius — a schema, an architecture, a review that gates a deploy. `doctor` fails an unknown tier and warns on any agent that goes back to inheriting.

**Every agent rediscovered the same repository.** Five dispatches meant five identical scans for the same `hooks.py` and the same DocType list. `orchestrator.mjs pack` answers that once with commands rather than a model, so the shared context costs **zero tokens**; `context-broker` adds only the judgement a command cannot have — which of those files matter here.

**The parallelism was theoretical.** The phase table said what could run concurrently and nothing acted on it. `plan` emits actual batches, guaranteeing no agent shares a batch with something it `requires`, capped at four abreast.

**Shared skills quietly doubled the bill.** Two agents legitimately declaring one skill is the design working — dispatching both when the request wanted one is not. `plan` settles it on request affinity and records the loser with the margin that decided it. Nothing is dropped silently.

The cheapest fix is upstream of all four: **most requests should never reach the swarm at all.** That is what the `fast` effort mode and `fast-path-triage` are for.

## The swarm

45 agents, generated from `registry/agents.yaml` — `agents/*.md` is build output, so adding an agent is a registry edit rather than 45 files to keep in sync.

| Division | Agents |
|---|---|
| Orchestration | `orchestrator-deep`, `delivery-orchestrator`, `research-orchestrator` |
| Planning | `requirements-analyst`, `business-analyst`, `frappe-architect`, `data-model-architect`, `impact-analyst` |
| Development | `frappe-data`, `frappe-backend`, `frappe-frontend`, `integration-developer`, `console-deployer`, `reporting-developer` |
| UI/UX | `ux-researcher`, `ui-designer`, `interaction-designer`, `mobile-ux`, `accessibility` |
| Data | `data-analyst`, `data-scientist`, `dataviz-specialist` |
| Quality | `test-engineer`, `uat-coordinator`, `qa-engineer`, `code-reviewer`, `performance-analyst` |
| Demo & docs | `demo-builder`, `user-guide-writer`, `process-documenter`, `knowledge-curator` |
| Ops | `git-safety`, `deployment-safety`, `migration-analyst` |
| Passive governance | `skill-guardian`, `agent-guardian`, `routing-auditor`, `knowledge-guardian`, `swarm-evolution`, `efficiency-auditor` |
| Control plane | `fast-path-triage`, `context-broker`, `swarm-dispatcher`, `result-synthesizer`, `quality-sentinel` |

**The control plane exists to prevent dispatches, not to add them.** An extra agent is a full round trip, so one that does not pay for its own latency is agent theatre with better vocabulary. Each is named for the specific waste it removes: triage decides how much swarm a request deserves → broker maps the ground once → dispatcher batches the run → *[specialists]* → synthesizer collapses the returns → sentinel decides what actually needs reviewing → auditor scores the run afterwards.

They are constrained accordingly. A control agent holds no `Write` or `Edit` tool and `doctor` fails the build if one appears — the moment it can build, it stops being cheaper than the specialist it was meant to replace. `quality-sentinel` may reduce review effort but never to zero on schema, deployment, security, or anything a specialist flagged as risky in its own handoff. `result-synthesizer` may merge a duplicate finding but may never drop one for brevity, and surfaces contradictions as contradictions rather than averaging them into a position no agent held.

**Where the orchestrator lives, and why it matters.** A Claude Code sub-agent cannot address the user — only the main thread can. So human-approval gates, live observability and conflict escalation stay in the orchestrator **skill** running in the main thread; that is the only surface which can both dispatch agents and talk to you. The three orchestrator *sub-agents* exist for delegated work needing no mid-flight decision, and they are mute by design: they return a question in `handoff` rather than guess.

**Every agent returns fields, not prose** — `summary`, `files_changed`, `decisions`, `findings`, `risks`, `testing`, `remaining`, `handoff`. An agent that finishes with "done" has failed the protocol.

**Seven gates require a human.** Destructive database changes, production deployment, destructive git operations, deleting a skill or agent, changing the swarm architecture, generating a new agent, security-sensitive changes. Agents refuse and escalate rather than cross them.

### Governance that audits its own author

```bash
node scripts/orchestrator.mjs doctor
```

Fails on agent theatre (an agent with no measurable responsibility), duplicate responsibilities, asymmetric conflicts, broken dependencies and missing protocol fields. It caught three defects in this repository's own registry during the build — including three ghost agents left by renames, since a stale agent still installs and can still be dispatched.

Note what it deliberately does *not* flag: two agents sharing a skill. That is the design working — a skill is reusable expertise, an agent is an identity that consumes it.

## Install

**Requirements:** Node 18 or newer, and git. Nothing else — no `npm install`, no
dependencies. On Windows you also need a bash: [Git for
Windows](https://gitforwindows.org) or WSL. Claude Code itself is assumed.

```bash
git clone https://github.com/SumanthUExponent/Orchestrator-Agent-For-ERP.git
cd Orchestrator-Agent-For-ERP

node scripts/orchestrator.mjs install              # dry run — shows the plan, writes nothing
node scripts/orchestrator.mjs install --apply      # install the skills AND the 45 agents
node scripts/orchestrator.mjs health               # verify the skills
node scripts/orchestrator.mjs doctor               # verify the swarm
```

Skills land in `~/.claude/skills`, agents in `~/.claude/agents` (override with
`CLAUDE_SKILLS_DIR` / `CLAUDE_AGENTS_DIR`).

**Restart Claude Code afterwards.** Agent definitions are read at session start — until
then they are on disk and invisible.

**Upgrading?** Existing agents are skipped by name, so a plain `--apply` over an
existing install writes nothing and any re-tiering silently never lands. Use `--force`.

Optional third-party skill packs are declared in `registry/overlay.yaml` and fetched
only when asked:

```bash
node scripts/orchestrator.mjs install --apply --external
```

Those are **not vendored** — they are other people's work under their own licences,
resolved from source so upstream fixes reach you.

### Adding the voice layer

```bash
node scripts/orchestrator.mjs voice               # dry run — shows every hook it will register
node scripts/orchestrator.mjs voice --apply
jarvisctl doctor                                  # names the backends it found on your machine
```

It runs on macOS, Linux and Windows and needs one speech engine and one audio player.
macOS and Windows already have both. On Linux, install them:

| | Debian / Ubuntu | Fedora | Arch |
|---|---|---|---|
| speech | `apt install espeak-ng` | `dnf install espeak-ng` | `pacman -S espeak-ng` |
| audio | `apt install pulseaudio-utils` *or* `alsa-utils` | `dnf install pulseaudio-utils` | `pacman -S libpulse` |
| banners *(optional)* | `apt install libnotify-bin` | `dnf install libnotify` | `pacman -S libnotify` |

**Do this before you judge how it sounds.** Every voice macOS ships by default is the
"compact" set — a 2005-era synthesiser. It sounds mechanical because it *is*, and no
amount of tuning fixes a bad synthesiser. Two ways out, both free and both entirely
offline:

```bash
jarvisctl voices --setup     # macOS: opens the free Siri / Premium downloads
```

Download a Siri or Premium English (UK) voice (100–500 MB, roughly three times more
natural), set it as your System Voice, then put `JARVIS_VOICE="system"` in
`~/.claude/jarvis/config.sh`. A Siri voice cannot be selected by name — `"system"`
tells JARVIS to omit the `-v` flag, which is what makes `say` use it.

Or point it at a local neural engine, on any platform:

```bash
# in ~/.claude/jarvis/config.sh — {out} is a .wav to write, {text} is what to say
JARVIS_TTS_CMD='kokoro-tts --voice bm_george --output {out} "{text}"'
```

[Kokoro](https://github.com/hexgrad/kokoro) is the one to reach for: 82M parameters,
and the best quality-per-megabyte available locally.
[Piper](https://github.com/rhasspy/piper) is faster and smaller but noticeably more
robotic. Anything that writes a WAV works. Nothing leaves your machine — no account, no
API — and if the command fails the built-in voice still speaks, because a broken
template must never make the whole layer go quiet.

`jarvisctl doctor` tells you which of these you are on, and says so loudly if you are
still on a compact voice.

`jarvisctl doctor` tells you exactly what it found and what to install if it found
nothing. Nothing here talks to a server: the speech is your operating system's, and the
chimes are synthesised on your machine at install time.

**Windows notes.** Run the installer from any shell, but the hooks are written to
invoke `bash`, so Git Bash or WSL must be on your PATH. `jarvisctl` is not symlinked
onto PATH there — call it as `~/.claude/jarvis/jarvisctl`. Desktop banners need the
[BurntToast](https://github.com/Windos/BurntToast) module; without it the speech still
works and the banner is skipped.

## The voice layer

Optional, and the reason it exists is parallelism. Running four sessions at once, the
expensive failure is not a slow agent — it is a session sitting silently on a
permission prompt while the other three work. You find out ten minutes later.

`voice --apply` installs a J.A.R.V.I.S.-style butler that announces what every
session is doing, so the terminal does not have to be watched:

```bash
node scripts/orchestrator.mjs voice          # dry run — shows every hook it will register
node scripts/orchestrator.mjs voice --apply
jarvisctl doctor                             # verify
jarvisctl test                               # hear every alert
```

Runs on **macOS, Linux and Windows** (WSL or Git Bash). `jarvisctl doctor` names the
speech and audio backend it found on your machine, and tells you what to install if it
found none.

| | speech | audio | banner |
|---|---|---|---|
| macOS | `say` | `afplay` | `osascript` |
| Linux | `spd-say`, `espeak-ng`, `espeak`, `festival` or `pico2wave` | `paplay`, `aplay`, `ffplay`, `mpv`, `play` or `cvlc` | `notify-send` |
| Windows | PowerShell `System.Speech` | PowerShell `Media.SoundPlayer` | BurntToast, if installed |

Every OS call lives in one file, `platform.sh`; a test asserts that no other script
names an OS tool. A machine with no speech engine at all degrades to silence and exits
zero — a hook that fails surfaces a notice in the transcript, so an absent engine must
never become visible noise.

**Nothing speaks from inside a hook.** That is the whole architecture. Two `say`
calls on macOS do not queue, they play at once, so four sessions announcing
themselves become four voices at once and no information. Instead the hook writes
one queue file and exits in milliseconds; a single daemon holding an exclusive lock
drains the queue and is the only process in the system that speaks.

What that buys, beyond not overlapping:

| Behaviour | Why |
|---|---|
| Blocked-on-approval jumps the queue | Priority leads the filename, so a stuck session is heard before a backlog of completions |
| Nags every 70s while still blocked | No hook fires when a permission prompt goes unanswered, so the daemon re-checks |
| Turns under 25s get a tick, not a sentence | `Stop` fires after **every** turn. Un-gated, asking the time is announced as a completed task |
| Six completions collapse to one | A burst is debounced 1.2s, then the newest is spoken and the rest deleted |
| Completions older than 50s are dropped | An announcement 90s late is noise, not information |
| Session name spoken only when 2+ are live | With one session, "frappe-bench, finished" is padding; with four it is the message |
| One voice, always | Four parallel sessions do **not** get four voices. Four voices read as four different *people*; the point is one assistant with an eye on everything, naming the session it is talking about. The chime pitch is a second cue underneath the name |
| A completion with nothing to report does not speak | With several sessions live, *"Done, sir. Three minutes."* is pure noise. It ticks instead, and the voice is saved for turns that have something to say (`JARVIS_SPEAK_WITHOUT_SUMMARY`) |
| Each session briefs you as it closes | Only what is still **outstanding** — what was done was already announced turn by turn. The full record goes to disk: `jarvisctl brief` |
| The last session out reports the day | *"All sessions closed, sir. Eleven turns, and one problem outstanding, last in C R M."* One line, once, across every session |
| A blocked session escalates once | After the nags are spent, the loudest motif in the set, the duration spoken aloud, and a banner. Once only — repeating it would make the most important alert in the set background noise |
| Two sessions in one directory stay distinct | Keyed on `session_id`, not `$PWD` |

It is swarm-aware. `SubagentStop` fires once per specialist, so a batch of four would
be four announcements — speech is therefore **not** the default for subagents. They
chime, and what they *found* is carried into the completion instead. Set
`JARVIS_SUBAGENT=silent|chime|speak` in `~/.claude/jarvis/config.sh` to change that.

### It says what changed, not that time passed

Every agent in the swarm is required to end its output with one line:

```
VOICE: Vendor Audit schema is in, three child tables
```

Those clauses are collected as each specialist finishes, and read out on completion:

| | |
|---|---|
| without | *"Done, sir. Six specialists, four minutes."* — 3.5s, and it reports only that time passed |
| with | *"Vendor Audit schema is in, sir. Four minutes."* — 2.8s, and it reports what changed |

The specialist count disappears when there is a summary, because that count was never
information — it was a proxy for "something substantial happened", added because there
was nothing better to say. A run that can say what it did does not also need to say how
many agents were involved in it.

**A marker only counts when it is terminal** — every non-empty line after it must be
another marker. That is what the contract asks agents for, and it is the only rule that
separates a real handoff from prose *about* the format. Neither a line anchor nor a
last-N-lines window does: documenting the format in a reply puts the markers inside a
fenced block a few lines from the end, and both of those rules harvested it as though it
were real. It happened, and a live session's briefing ended up containing an example
sentence and a mangled fragment.

**Every ordinary turn gets a summary too.** The main thread emits no markers — a `VOICE`
line in a reply is clutter for whoever is reading it — so a chat where the work is done
directly, with no specialists dispatched, would otherwise never produce a summary at all.
That is the common case, not the exception. Failing a marker, the turn's own opening
sentence is spoken: markdown stripped, one sentence, capped. No model call for that
either.

**No model call, and nothing leaves the machine.** `Stop` and `SubagentStop` both carry
`last_assistant_message`, so the clause is lifted straight from the hook payload — the
documentation is explicit that hooks should read that rather than the transcript, which
is written asynchronously and lags the conversation. The extraction is a single `sed`.

The contract is enforced rather than suggested: it is a protocol field, so `doctor`
fails the build if any agent omits it, and a test asserts every generated agent file
explains the *format* — an agent that returns a paragraph, or a file path, produces
something unintelligible read aloud.

Agent output is treated as untrusted. The clause is filtered through an **allowlist** of
plain-speech characters rather than escaped, and capped at 140 characters. A test feeds
it `VOICE: done | $(touch PWNED) and \`id\`` and asserts nothing executed and every
metacharacter is gone.

One clause is spoken by default, measured rather than guessed: each word costs roughly a
fifth of a second and `Stop` fires after *every* turn, so two clauses run to 4.2–6.5s —
back to the monologue the brevity work removed. `JARVIS_SUMMARY_MAX=2` if you want more
detail and can live with about four seconds instead of under three.

### The end-of-session briefing

Two optional lines sit alongside the required one, and they are read back when the
session closes rather than when the turn ends:

```
VOICE:    Material Movement schema is in
PENDING:  permissions matrix still needs an Auditor role
HEADS-UP: the submit hook now fires on amend as well
```

That is a different audience again — someone deciding whether they can walk away, or
picking the work up tomorrow having forgotten the detail. So the split is:

- **Spoken on close: only what is still outstanding.** *"N S T closing, sir. Pending: the
  permissions matrix still needs an Auditor role. And the offline sync path is
  untested."* What was *done* is deliberately not repeated — you heard it turn by turn,
  and you are closing a terminal.
- **A session that finished cleanly says nothing at all.** Silence is the correct report
  for "nothing needs you".
- **The full record is always written**, clean or not, and read with `jarvisctl brief`:

```
$ jarvisctl brief
== 2026-08-18-wt_nst.txt
  DONE
    - DocTypes built and fixtures exported
    - all twenty two tests pass
  HEADS UP
    - the submit hook now fires on amend as well
  PENDING
    - permissions matrix still needs an Auditor role
    - the offline sync path is still untested
```

`PENDING` accumulates across every turn of the session and is deduplicated — the same
item raised by three agents over four turns is one item, not twelve.

**Which clause, when several arrived, is the whole question.** A problem wins outright —
the contract already tells agents to lead with one, and announcing "schema is in" while a
sibling agent reported a failing test would be actively misleading. Otherwise the *last*
clause, not the first: in a requirements → design → build → test pipeline the earliest
agent to finish is the least conclusive, and taking the first meant a four-agent run
announced its acceptance criteria and never mentioned that the tests passed.

### The tones are synthesised, not sampled

The chimes are generated at install time — one WAV per note, with pitch, envelope and
loudness baked in — rather than shipped or sampled from the OS.

That started as a portability problem. Shaping a sound at playback needs `afplay -r`
for pitch and `-v` for gain, and neither exists off macOS: `aplay` and Windows'
`Media.SoundPlayer` have no volume control at all. Baking the shaping into the file
reduces playback to "play this", which every platform can do.

It turned out to fix the sound as well.

### The chimes are measured, not chosen

The first cut layered pairs of macOS system sounds 160ms apart. Analysing the actual
audio showed that was wrong three ways, none of them audible as a *bug* — it would
just have sounded cheap:

- **Blow + Hero** are 1.40s and 1.06s long with their energy in the same 300–1000 Hz
  band. Offset by 160ms they produce a sustained chord, not two notes.
- **Submarine over Submarine** and **Basso over Basso** are the same file played
  twice 160ms apart, which is comb filtering. It sounds like a fault.
- **Tink + Pop** are 34 Hz apart in dominant pitch — under a semitone, close enough
  to beat against each other.

So the chimes are now a struck-bell tone — a fundamental with inharmonic partials that
decay faster than it does, plus a 2ms noise transient — sequenced into motifs. The
intervals are exact because the frequencies are chosen, the timbre is constant, and the
*shape* carries the meaning: completion rises, error falls two octaves down, approval is
three taps at one pitch, because rhythm is identifiable where absolute pitch is not.

Three other things measurement settled:

| Finding | Change |
|---|---|
| At its natural pitch the sampled atom put **95%** of its energy in 300–1000 Hz — exactly where a male voice's first two formants live, so the chime masked the vowels of the first word | Tones are synthesised above that band; measured on the generated files it is now **0.0–0.1%**, and the motif waits out its own span so speech starts *after* it |
| Measured RMS differs **4.6×** across the macOS system sounds, so at one fixed volume the *error* chime came out quieter than the routine completion | Each tone is normalised then scaled by its category, so loudness tracks importance. A test reads the generated WAVs back and asserts an urgent alert is never quieter than a routine one |
| Announcements ran **4.4–5.4s each**, and `Stop` fires after every turn | Two registers. Alone, "Done, sir. Four minutes." is 1.67s; the project name is only worth its 1.1–1.6s when there is more than one session to tell apart |

`say` also mangles directory basenames: `wt_nst` is a worktree prefix plus an
initialism, and it reads as one nonsense syllable. Names are now normalised —
underscores and hyphens to spaces, the `wt` prefix dropped, and a short vowel-less
token spelled out, so `wt_nst` becomes "N S T". `JARVIS_NAMES="wt_nst=the N S T tree"`
overrides any of it.

To judge all of this by ear rather than by table:

```bash
jarvisctl chimes     # every motif back to back, then the four session pitches
jarvisctl demo       # a narrated four-session working day, end to end
jarvisctl test       # every alert as it really fires, chime and speech
```

`demo` is the one that finds things. Each behaviour is verifiable alone; whether the
*system* is pleasant for ten minutes is not, and it took an end-to-end run to expose
that six specialists produced two chimes rather than one, and that closing four
sessions said goodbye four times.

```
$ jarvisctl status
Active sessions: 2
  [1] frappe-bench             idle
  [2] wt_nst                   working 0m27s  ** BLOCKED ON APPROVAL **
Queued announcements: 0
Speaker: running (pid 51749)
```

`jarvisctl report` speaks where everything stands, blocked sessions first — the
announcements tell you what just *changed*, which is not the question you have after
twenty minutes away from the desk:

```
$ jarvisctl report
4 sessions, sir. Blocked: C R M, blocked for 8 minutes.
Working: frappe bench, 6 minutes, exponent utilities, 9 seconds. Idle: N S T.
```

`jarvisctl` also has `doctor`, `brief`, `log`, `mute <min>`, `unmute`, `reset`,
`voices`, `chimes` and `demo`. Everything is tunable in `config.sh`, which an upgrade will not
overwrite.

**Extensions.** Anything executable in `~/.claude/jarvis/hooks.d/` receives every event
— mode, session, extra, ordinal — after it has been announced. It is backgrounded with
its output discarded and its exit status ignored, so a script there can never stall the
drainer and take every future announcement with it (a test starts a hook that hangs for
45 seconds and asserts the queue keeps moving). Flash a lamp when a session blocks, post
to a dashboard, whatever you like.

**Everything runs locally.** No API, no network, no account. Speech is the operating
system's own synthesiser, or any local neural engine you point `JARVIS_TTS_CMD` at.
See [the voice-quality note](#adding-the-voice-layer) — it is the single biggest thing
you can change about how this sounds.

The installer **merges** into `settings.json` rather than replacing it: the
orchestrator's own routing gate and context-pack hooks live in the same arrays, and
clobbering them would disable the swarm while appearing to succeed. It is idempotent
(matched on the command string, so a moved install self-heals), backs the file up
first, writes atomically, and refuses to touch a `settings.json` it cannot parse.

## Commands

| Command | Does |
|---|---|
| `install [--apply] [--external] [--force]` | Resolve and place skills. Dry run by default. |
| `build` | Regenerate `registry/registry.generated.json` from disk. |
| `health` | Validate the ecosystem: missing, orphan, cycles, conflicts. |
| `route "<request>"` | Explain a routing decision — which skills, which phases. |
| `plan "<request>"` | Execution plan — which agents, parallel batches, model tier, relative cost. |
| `pack [dir]` | Deterministic Context Pack. No model involved, so it costs nothing to regenerate. |
| `agents [--apply]` | Generate `agents/*.md` from the registry. |
| `doctor` | Audit the agent roster. |
| `voice [--apply] [--force]` | Install the voice layer and its eight hooks. Dry run by default. |
| `npm test` | Routing, execution-plan, installer, voice-installer and tone-synthesis suites (105 tests). |
| `npm run test:audio` | Platform backends, installed-tone integrity, name handling, phrase-length budgets (34 checks). |
| `npm run test:voice` | The above plus the concurrency harness (90 checks, stubbed audio). |
| `npm run test:all` | Everything. |

## Health check

```
$ node scripts/orchestrator.mjs health

✓ Skills discovered: 20        ✓ Invalid metadata: 0
✓ Skills registered: 20        ✓ Routing conflicts: 0
✓ Missing skills: 0            ✓ Orphan skills: 0
✓ Broken dependencies: 0       ✓ External sources declared: 3
✓ Dependency cycles: 0         Installation status: Healthy
```

It catches: a skill declared in the overlay with no directory; a directory with no overlay entry (unroutable); unknown categories or modes; dependencies pointing at skills that do not exist; dependency cycles; asymmetric conflict declarations; two skills claiming the same trigger; and categories no skill claims.

## Adding a skill

1. Drop the directory into `skills/`. Auto-discovery finds any `skills/<name>/SKILL.md`.
2. Add an entry to `registry/overlay.yaml` — category, mode, priority, triggers, dependencies.
3. `node scripts/orchestrator.mjs build && node scripts/orchestrator.mjs health`
4. Add a routing test if the skill introduces a new request shape.

Step 2 is not optional: `health` reports an unregistered skill as an orphan, because a skill the router can never select is worse than one that is not installed — it looks present and never fires.

Orchestration metadata lives in the overlay rather than in each `SKILL.md` because third-party skills are not ours to edit. One source of truth; upstream stays pristine.

## Design decisions worth knowing

**No runtime dependencies.** A tool whose job is verifying a skill ecosystem should not require an `npm install` before it can run a security check. The cost is a small YAML subset reader that throws rather than mis-parsing.

**The installer is dry-run by default and never executes fetched code.** Installing a skill places text an agent will later treat as instructions. Fetching from a stranger's repository is opt-in, skill names are validated against a strict pattern, `provides_dir` cannot escape the clone root, symlinks are refused, and nothing from a fetched repo is ever run.

**Existing skills win.** A third-party pack cannot silently shadow one of yours without `--force`.

**Verification is never optimised away.** Effort caps can drop an optional skill; they cannot drop a validation skill. A plan that fits a budget by skipping its tests has not saved anything.

## Repository layout

```
orchestrator/SKILL.md      the skill Claude Code loads
registry/taxonomy.yaml     categories and execution phases
registry/overlay.yaml      per-skill orchestration metadata + external manifest
registry/routing.yaml      decision table, composites, scorer weights, thresholds
registry/agents.yaml       the 45 agents: mode, model tier, ownership, conflicts
scripts/orchestrator.mjs   CLI: build, health, route, plan, pack, install, agents, doctor
scripts/route.mjs          routing engine — request to skills
scripts/plan.mjs           execution planner — skills to agents, batches, tiers, cost
scripts/pack.mjs           deterministic context pack
scripts/swarm.mjs          agent generation and roster audit
scripts/install.mjs        installer
scripts/voice.mjs          voice-layer installer and settings.json merge
voice/jarvis.sh            hook entry point — enqueues and exits, never speaks
voice/speaker.sh           the single drainer: one lock, one voice
voice/platform.sh          every OS-specific call, and nothing else
voice/jarvisctl            status, doctor, log, mute, reset, voices, chimes, demo
voice/demo.sh              narrated four-session simulation
voice/config.sh            tunables; not overwritten by an upgrade
voice/hooks.d/             extension point: any executable gets every event
scripts/tones.mjs          motif definitions and the tone synthesiser
skills/                    in-tree skills
tests/                     regression suites
tests/tones.test.mjs       motif tables, pitch, measured loudness of the generated WAVs
tests/voice-audio.sh       platform backends, installed tones, names, phrase budgets
tests/voice-concurrency.sh voice behaviour under genuine parallel load
```

## Status and limits

Working: registry, auto-discovery, health checks, hybrid routing, skill→agent mapping, dependency-aware batching, model tiering, the deterministic context pack, conflict and contest handling, effort modes, user overrides, installer with dry-run and traversal defence, the cross-platform voice layer, spoken
agent summaries and end-of-session briefings, 105 passing regression tests plus 124
audio and concurrency checks.

Known gaps, stated plainly:

- **The cost index is a ratio, not a measurement.** `plan` reports relative cost from the tier weights in `scripts/plan.mjs`. It is honest about direction and magnitude; it is not a bill, and nothing here has been benchmarked against wall-clock.
- **Contest resolution is lexical.** When two agents claim one skill, the tiebreak is word overlap between the request and what the agent says it owns. It is inspectable and it beats dispatching both, but it will lose to phrasing that shares no vocabulary with the agent's `owns` sentence.
- **The seven human gates have never been exercised end to end.** They are declared and every agent is generated with the refusal text; no run has yet crossed one and been stopped.
- **No debugging skill in-tree.** A bug report routes toward the server and quality categories, but there is no investigation specialist to route *to*. The taxonomy will not invent a category with no member.
- **Version compatibility is declared, not enforced.** `package.json` carries a version; per-skill compatibility ranges are not yet checked at install time.
- **The voice layer is measured, but not heard.** Motif intervals, loudness matching,
  the speech-band clearance, phrase lengths, the single-daemon lock and all eight
  hooks are asserted by tests and were driven live on macOS. What no measurement
  settles is taste: whether a rising fourth reads as "done" to *you*, whether four
  transpositions two semitones apart are far enough apart in practice, and whether
  any of it carries over music at your volume. `jarvisctl chimes` auditions the lot and
  `jarvisctl demo` plays a full four-session working day; the motif definitions are at
  the top of `scripts/tones.mjs`.
- **Linux and Windows are covered by CI, not by ears.** Every suite runs on
  ubuntu-latest, windows-latest and macos-latest across Node 18/20/22, with a real
  speech engine and a real audio backend installed on the Linux job — which is how the
  three portability defects that shipped in the first cut were found. What CI cannot
  judge is whether the result *sounds* right on those platforms.
- **Nothing fires when a permission prompt is granted.** Claude Code has no such
  event, so pending state is cleared on the next `Stop` or prompt submission
  instead. The alternative — hooking `PostToolUse` — would spawn a process on every
  single tool call to buy a small amount of precision.
- **The scorer is untuned.** Weights and thresholds are reasoned defaults, not fitted to a corpus. They live in `routing.yaml` precisely so they can be adjusted without touching the engine.

## Licence

MIT — see [LICENSE](LICENSE). Third-party skill packs referenced by the external manifest remain under their own licences and are not redistributed here.
