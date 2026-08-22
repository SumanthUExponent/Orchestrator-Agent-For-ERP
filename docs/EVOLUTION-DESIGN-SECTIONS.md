## §14 — Ranking model, with the weights explained

The directive asks for weighted scoring across 20 criteria. Applying 20 equal-weight
criteria would be the wrong answer dressed as rigour: most of them do not discriminate
between the systems studied, and several are irrelevant to a system that will adopt
*patterns* rather than *products*.

So the weights below are chosen for one specific decision — **"should JARVIS absorb this
pattern?"** — and the reasoning for each is stated. Criteria that cannot discriminate get
weight zero, named as such rather than quietly dropped.

| Criterion | Weight | Why this weight |
|---|---:|---|
| **Fit for JARVIS** | **25** | Dominant by design. A pattern that is excellent and inapplicable scores zero overall. Concretely: does it survive zero-runtime-dependencies, no-network-in-the-speech-path, and deterministic-routing? |
| **Verification** | **15** | The thing the research says models still lack. Every high-value absorb candidate turned out to be a verification mechanism. |
| **Failure recovery** | **12** | Second-most-common source of real value, and the one area where 2024-era designs still beat 2026 models. |
| **Reliability** | **10** | A pattern that works usually is a pattern that fails silently sometimes. |
| **Context management** | **8** | Real, but the most *deprecated* category — several 2024 mechanisms here have been withdrawn by their authors. |
| **Security** | **8** | Raised from a would-be 3 because the MCP findings made it load-bearing rather than hygienic. |
| **Multi-agent coordination** | **7** | Where the field is weakest, so where absorbing is hardest and least evidenced. |
| **Observability** | **5** | Necessary for the learning loop; not itself a capability. |
| **Memory** | **4** | High research interest, low immediate applicability under the dependency constraint. |
| **Cost efficiency** | **4** | Already measured by `bench`; a pattern rarely changes it much. |
| **Maintainability** | **2** | Matters for a dependency, not for an absorbed pattern. |
| Coding / reasoning / planning capability | **0** | These are properties of the *model*, not of a scaffold. Scoring a scaffold on them measures the model it was benchmarked with. |
| Tool use, MCP integration, extensibility, performance, community maturity, documentation | **0** | Do not discriminate — every system studied scores similarly, so including them adds arithmetic without changing any ranking. |

**The honest note on this model:** with Fit at 25 and the model-capability criteria at 0,
the ranking is mostly answering "does this fit, and does it help us verify or recover."
That is the right question for this decision and it is *not* a general-purpose system
ranking. Anyone reusing these weights to choose a framework to build on would be using
the wrong instrument.

### Applied — the absorb candidates scored

Scored 0-5 per criterion, weighted, normalised to 100.

| Pattern | Source | Fit | Verif | Recov | Score | Verdict |
|---|---|---:|---:|---:|---:|---|
| Validity check inside the write tool | SWE-agent linted editor | 5 | 5 | 4 | **94** | **ABSORB NOW** |
| `skills:` frontmatter preload | Claude Code docs | 5 | 3 | 2 | **81** | **ABSORB NOW** |
| Empty-diff false-completion check | OpenHands `empty_patch` | 5 | 5 | 2 | **88** | **ABSORB NOW** |
| Trifecta audit per agent | Willison / MCP findings | 5 | 2 | 3 | **79** | **ABSORB NOW** |
| Grounded critique (external signal required) | CRITIC vs 2310.01798 | 5 | 5 | 3 | **91** | **ABSORB NOW** |
| Nudge-then-terminate + id-stripped equality | OpenHands stuck detector | 4 | 3 | 5 | **80** | **ADAPT** |
| Keyed supersession + tombstones | Graphiti / 2606.24775 | 4 | 3 | 3 | **72** | **ADAPT** |
| `minimum_progress` compaction guard | OpenHands condenser | 3 | 3 | 4 | **63** | **ADAPT** |
| Capacity cap (Two-Gate) | 2510.04399 | 5 | 4 | 3 | **85** | **ABSORB NOW** |
| Held-out probe set | GEPA | 5 | 5 | 2 | **87** | **ABSORB NOW** |
| Pre-write admission + neutral steward | ATM 2607.00041 | 3 | 3 | 4 | **62** | **EXPERIMENT** |
| Decompose-on-failure | ADaPT 2311.05772 | 3 | 2 | 4 | **58** | **EXPERIMENT** |
| Skill-conditional performance routing | 2606.14200 + GraphPlanner | 2 | 3 | 2 | **44** | **EXPERIMENT — blocked on attribution** |
| Conversation-personalized PageRank | Aider repomap | 2 | 2 | 1 | **35** | **WATCH** — extractor must be rewritten for Frappe |
| Orthogonal code/conversation rewind | Cline shadow git | 2 | 2 | 4 | **44** | **WATCH** |
| Agent-team peer messaging | Claude Code agent teams | 2 | 1 | 2 | **30** | **WATCH** |
| Multi-agent debate | 2305.14325 lineage | 0 | 1 | 1 | **9** | **REJECT** |
| LLM-as-router | every framework | 0 | 0 | 1 | **5** | **REJECT** |
| Shared mutable blackboard | Letta / ADK | 0 | 0 | 0 | **0** | **REJECT** |
| Vector memory | mem0 lineage | 0 | 1 | 0 | **4** | **REJECT** |

The five scoring above 85 are the P0 set, and they share a property worth naming: **every
one of them is a refusal.** Refuse an invalid edit, refuse a SUCCESS with no diff, refuse a
verdict with no external evidence, refuse a proposal that changes too much, refuse to let
the optimiser see its own gate. The highest-value absorbs are all things that say no.

---

## §19 — Capability registry design

The directive asks for four registries. JARVIS has one and a half: agents are fully
declared, skills are declared in `overlay.yaml`, MCPs and models are not modelled at all.

**Design principle, learned from the research:** every field must be either *declared by a
human* or *derived from measurement*, and the two must never mix in one field. A field that
is sometimes a declaration and sometimes an observation cannot be audited — and
`success_rate` written by hand is exactly the fiction the 2606.14200 laundering result
warns about.

### AGENTS — declared vs derived, split explicitly

```yaml
schema-builder:
  # ── DECLARED (human-authored, git-tracked, doctor-audited) ──
  role: Schema implementation
  mode: active
  model: sonnet                    # tier, not a performance claim
  tools: [Read, Grep, Glob, Bash, Edit, Write]
  skills: [frappe-doctype-development]   # → renders to `skills:` frontmatter (P0)
  writes: schema                   # collision scope
  owns: >
    ...
  conflicts_with: [...]
  trifecta:                        # NEW — §06 finding
    private_data: true             # reads the repo
    untrusted_content: false       # no web, no issues
    egress: true                   # can write files
    # doctor FAILS if all three are true without an explicit waiver

  # ── DERIVED (written only by the ledger reducer, never by hand) ──
  observed:                        # absent until there is evidence; absence is honest
    runs: 0
    per_task_kind: {}              # NOT a global score — 2606.14200
    last_validated: null
    known_failure_modes: []        # promoted only at unverified=0
```

The `observed` block is **absent, not zeroed**, until the ledger has attributable rows.
An `observed.runs: 0` and a missing block read differently to a router, and only one of
them is true today.

### SKILLS

```yaml
frappe-doctype-development:
  provides: DocType JSON, controller, permissions, fixtures
  triggers: [...]                  # routing key
  output_contract: files written + fixture list
  verification: bench migrate must apply cleanly
  preload_cost_bytes: 4200         # measured, because listing cost is real
  validated_at: 2026-08-21         # a skill nobody has run is not a validated skill
  conflicts_with: [...]
```

### MCPs — the registry that does not exist yet, and the one the research most demands

```yaml
mcp:
  playwright:
    capability: persistent browser session
    tool_count: 21                 # MEASURED — listings cost context every turn
    beats_shell_because: a live session with DOM and console across calls
    security_class: untrusted-content-ingesting
    pinned_version: "1.4.2"        # never @latest — postmark-mcp
    tools_hash: "sha256:…"         # rug-pull detection; approval is not bound to a schema
    granted_to: [qa-engineer]      # allowlist tools, not servers
    write_tools: []                # any entry here requires human approval
```

`tools_hash` is the one field with no protocol support behind it — the MCP spec has no
mechanism binding an approval to a schema, so this control must be built locally or not
exist.

### MODELS

Deliberately the thinnest registry, and that is a finding rather than an omission. The
research showed model-capability criteria do not discriminate between *scaffolds*, and a
hand-written "reasoning: high" is a claim nobody measured.

```yaml
sonnet:
  cost_index: 3                    # ratio only — bench says this is not a price
  context: 200000
  # NO capability scores. A hand-authored "coding: 4/5" is an opinion in a data structure.
```

---

## §24 — Benchmark design, and the honest limit on it

**What is measured today** — and both are about the *plan*, not the *result*:

| Instrument | Measures | Determinism |
|---|---|---|
| 19 probes | routing shape: effort, agent set, gates, panel | byte-identical across runs (verified 5×) |
| `bench` | dispatches, serial→batched steps, cost ratio | deterministic |
| 271 node + 39 audio + 122 concurrency | mechanism correctness | deterministic |

**The gap: nothing measures outcome quality on a real task.** Everything above would pass
identically whether the swarm produces good code or bad code, because none of it runs the
swarm. That is the honest statement of where §24 stands, and it is not fixable by adding
more deterministic probes.

### The three-tier design

**Tier 0 — plan-shape probes (exists, 19, free).** Deterministic, model-free, gates every
commit on flips. Extend by mining real requests. Cheap enough that there is no reason not
to grow it. **Must be split into a gating set and a held-out set the proposal generator
never sees** (GEPA; 2606.28430 Goodhart).

**Tier 1 — outcome probes on frozen fixtures (buildable, cheap-ish).** A small corpus of
*self-contained* tasks against a fixture app, each with a deterministic grader that is not
an LLM:

| Task | Deterministic grader |
|---|---|
| add a field to a DocType | field present in JSON, `bench migrate` exits 0 |
| fix a failing test | the named test passes, no other test regresses |
| write a Script Report | report runs, returns rows, SQL references only real columns |
| safe_exec violation in a Server Script | violation flagged; a clean script not flagged |
| destructive request | the human gate fires — this one needs no model at all |

Metrics: success, first-pass success (no rework round), rework rounds, tool-error count,
tokens, wall-clock. `pass^k` rather than `pass@1` where reliability matters ([τ-bench,
arXiv:2406.12045](https://arxiv.org/abs/2406.12045)).

**Critically — these are stochastic**, so the multiple-comparisons arithmetic that does
*not* apply to Tier 0 **does** apply here: measure the flake rate first, then require a
replicated flip. Same conclusion the evaluation stream reached; different tier.

**Tier 2 — judged quality (expensive, non-blocking, never a gate).** Everything the
directive lists that a deterministic grader cannot reach: UI/UX redesign quality,
architecture-decision soundness, ambiguity handling, conflicting requirements. LLM-as-judge
is the only instrument available and the bias literature says it must not gate:
position-swapped, cross-family, with a human-labelled calibration set, reported with error
bars, and **advisory only**.

### The baseline problem, stated plainly

§24 says establish a baseline before claiming improvement. Tier 0 has one
(`.eval-baseline.json`). **Tiers 1 and 2 have none, because they do not exist** — so no
claim about outcome quality improving is currently supportable, including any claim I have
made. The eleven phases shipped so far are justified by mechanism correctness and by
closing named defects, *not* by measured outcome improvement. That distinction should
survive into any future report.

---

## §24 addendum — the first graded outcome

Recorded because a measurement nobody wrote down did not happen.

**Date:** 2026-08-21 · **Probe:** `add-a-field-to-a-doctype` · **Result: PASS**

The task, verbatim: *"Add a required Data field `vendor_ref` labelled 'Vendor Reference' to
the Widget DocType at tests/fixtures/demo_app/doctype/widget/widget.json. Change nothing
else."*

The diff produced was two lines: the new field, and the comma the preceding line then
needed. Graded on the artifact rather than on an account of it —

| Probe | Result |
|---|---|
| `add-a-field-to-a-doctype` | ✓ field added, nothing else touched |
| `surgical-change-leaves-style-alone` | ✓ style unchanged |
| four other model-free probes | ✓ |

**What this does and does not license.** It is one task, one trial, on a fixture, done by
the coordinator rather than by a dispatched specialist. It establishes that the harness
grades a real change end to end and that the surgical rule is satisfiable by the agent
that wrote it. It does **not** establish that outcome quality improved, because there is no
before-baseline to compare against — the harness did not exist before today.

**The honest claim:** the instrument works. The measurement it produced is n=1.

**And running it found a defect no amount of reading would have.** Without deps the gate
probe returned `pass: false`, so a probe that never executed appeared as a real failure —
the same false-failure pattern as the missing-fixture case, one layer over, fixed there and
missed here. There is now a general test asserting that no probe describing its own
inability may report a verdict.
