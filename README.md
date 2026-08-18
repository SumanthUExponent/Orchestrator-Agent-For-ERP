# Orchestrator Agent for ERP

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

```bash
git clone https://github.com/SumanthUExponent/Orchestrator-Agent-For-ERP.git
cd Orchestrator-Agent-For-ERP

node scripts/orchestrator.mjs install              # dry run — shows the plan, writes nothing
node scripts/orchestrator.mjs install --apply      # install skills AND the 45 agents
node scripts/orchestrator.mjs health               # verify skills
node scripts/orchestrator.mjs doctor               # verify the swarm

node scripts/orchestrator.mjs voice --apply        # optional: give every session a voice
```

Skills land in `~/.claude/skills`, agents in `~/.claude/agents` (override with `CLAUDE_SKILLS_DIR` / `CLAUDE_AGENTS_DIR`).

**Restart Claude Code after installing.** Agent definitions are read at session start — until then they are on disk and invisible.

Nothing to install first; Node 18+ is all you need.

Optional third-party skill packs are declared in `registry/overlay.yaml` and fetched only when asked:

```bash
node scripts/orchestrator.mjs install --apply --external
```

Those are **not vendored** — they are other people's work under their own licences, resolved from source so upstream fixes reach you.

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

macOS only — it is built on `say`, `afplay` and `osascript`.

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
| Each session gets its own chime pitch | Assigned in start order, so you know *which* session before the sentence gets there |
| Two sessions in one directory stay distinct | Keyed on `session_id`, not `$PWD` |

It is swarm-aware. `SubagentStop` fires once per specialist, so a batch of four would
be four announcements — speech is therefore **not** the default for subagents. They
chime, and the count is carried into the completion instead: *"task complete, sir.
Six specialists, four minutes."* One line that distinguishes a swarm run from a
one-line edit. Set `JARVIS_SUBAGENT=silent|chime|speak` in
`~/.claude/jarvis/config.sh` to change that.

```
$ jarvisctl status
Active sessions: 2
  [1] frappe-bench             idle
  [2] wt_nst                   working 0m27s  ** BLOCKED ON APPROVAL **
Queued announcements: 0
Speaker: running (pid 51749)
```

`jarvisctl` also has `doctor`, `log`, `mute <min>`, `unmute`, `reset` and `voices`.
Everything is tunable in `config.sh`, which an upgrade will not overwrite.

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
| `npm test` | Routing, execution-plan, installer and voice-installer suites (74 tests). |
| `npm run test:voice` | Concurrency harness for the voice layer (25 checks, stubbed audio). |

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
voice/jarvisctl            status, doctor, log, mute, reset, voices
voice/config.sh            tunables; not overwritten by an upgrade
skills/                    in-tree skills
tests/                     regression suites
tests/voice-concurrency.sh voice behaviour under genuine parallel load
```

## Status and limits

Working: registry, auto-discovery, health checks, hybrid routing, skill→agent mapping, dependency-aware batching, model tiering, the deterministic context pack, conflict and contest handling, effort modes, user overrides, installer with dry-run and traversal defence, the voice layer, 74 passing regression
tests plus 25 concurrency checks.

Known gaps, stated plainly:

- **The cost index is a ratio, not a measurement.** `plan` reports relative cost from the tier weights in `scripts/plan.mjs`. It is honest about direction and magnitude; it is not a bill, and nothing here has been benchmarked against wall-clock.
- **Contest resolution is lexical.** When two agents claim one skill, the tiebreak is word overlap between the request and what the agent says it owns. It is inspectable and it beats dispatching both, but it will lose to phrasing that shares no vocabulary with the agent's `owns` sentence.
- **The seven human gates have never been exercised end to end.** They are declared and every agent is generated with the refusal text; no run has yet crossed one and been stopped.
- **No debugging skill in-tree.** A bug report routes toward the server and quality categories, but there is no investigation specialist to route *to*. The taxonomy will not invent a category with no member.
- **Version compatibility is declared, not enforced.** `package.json` carries a version; per-skill compatibility ranges are not yet checked at install time.
- **The voice layer has been verified, not tuned.** Queueing, coalescing, priority,
  the single-daemon lock and the eight hooks are covered by tests and were driven
  live on macOS. What no test can judge is whether the chime pairings sound good
  together, whether four pitch levels are distinguishable by ear, or whether any of
  it is audible over music — tune `config.sh` to taste.
- **Nothing fires when a permission prompt is granted.** Claude Code has no such
  event, so pending state is cleared on the next `Stop` or prompt submission
  instead. The alternative — hooking `PostToolUse` — would spawn a process on every
  single tool call to buy a small amount of precision.
- **The scorer is untuned.** Weights and thresholds are reasoned defaults, not fitted to a corpus. They live in `routing.yaml` precisely so they can be adjusted without touching the engine.

## Licence

MIT — see [LICENSE](LICENSE). Third-party skill packs referenced by the external manifest remain under their own licences and are not redistributed here.
