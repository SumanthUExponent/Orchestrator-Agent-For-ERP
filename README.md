# Orchestrator Skill for ERP

Skill orchestration for [Claude Code](https://claude.com/claude-code), tuned for Frappe/ERPNext development.

You describe the work. The orchestrator decides which specialist skills apply, what order they run in, what can run in parallel, and which gates the work must clear before it can be called done.

```
$ node scripts/orchestrator.mjs route "System Console installer for a Vendor Audit DocType with approval workflow"

Effort: standard  ·  Decision: table (console-installer, data-model, workflow)
Gates: verify

Plan
  1. Plan
       - module-planner
  2. Build core [parallel]
       - frappe-doctype
       - frappe-workflow
  4. Deploy
       - console-automation-engine

Dropped
  - console-report-engineer: conflicts with console-automation-engine
```

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

## Install

```bash
git clone https://github.com/SumanthUExponent/Orchestrator-Skill-For-ERP.git
cd Orchestrator-Skill-For-ERP

node scripts/orchestrator.mjs install              # dry run — shows the plan, writes nothing
node scripts/orchestrator.mjs install --apply      # install the in-tree skills
node scripts/orchestrator.mjs health               # verify
```

Skills land in `~/.claude/skills` (override with `CLAUDE_SKILLS_DIR`). Nothing to install first; Node 18+ is all you need.

Optional third-party skill packs are declared in `registry/overlay.yaml` and fetched only when asked:

```bash
node scripts/orchestrator.mjs install --apply --external
```

Those are **not vendored** — they are other people's work under their own licences, resolved from source so upstream fixes reach you.

## Commands

| Command | Does |
|---|---|
| `install [--apply] [--external] [--force]` | Resolve and place skills. Dry run by default. |
| `build` | Regenerate `registry/registry.generated.json` from disk. |
| `health` | Validate the ecosystem: missing, orphan, cycles, conflicts. |
| `route "<request>"` | Explain a routing decision. |
| `npm test` | Run the routing regression suite. |

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
scripts/orchestrator.mjs   CLI: build, health, route, install
scripts/route.mjs          routing engine
scripts/install.mjs        installer
skills/                    in-tree skills
tests/                     routing regression suite
```

## Status and limits

Working: registry, auto-discovery, health checks, hybrid routing, dependency resolution, conflict handling, effort modes, user overrides, installer with dry-run and traversal defence, 22 passing regression tests.

Known gaps, stated plainly:

- **No debugging skill in-tree.** A bug report routes toward the server and quality categories, but there is no investigation specialist to route *to*. The taxonomy will not invent a category with no member.
- **Version compatibility is declared, not enforced.** `package.json` carries a version; per-skill compatibility ranges are not yet checked at install time.
- **The scorer is untuned.** Weights and thresholds are reasoned defaults, not fitted to a corpus. They live in `routing.yaml` precisely so they can be adjusted without touching the engine.

## Licence

MIT — see [LICENSE](LICENSE). Third-party skill packs referenced by the external manifest remain under their own licences and are not redistributed here.
