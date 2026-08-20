# JARVIS — architecture assessment

Written before implementation, per the evolution directive §20. Nothing in here has been
built. Two gates apply: `full` effort mode requires sign-off before code, and
"changing the swarm architecture itself" is gate 5 of the seven.

**The headline finding is not what the directive expects.** Most of what it asks for
already exists and works. The system's real deficiency is narrower, deeper, and not on
the directive's list of asks: **JARVIS has no way to know whether it is any good, and
no way to route work about itself.**

---

## 1. Current architecture

```
request
  │
  ├─ route.mjs      deterministic decision table, then a scorer when the table is silent
  │                 → skills, effort mode (minimal ≤2 / standard ≤4 / full ≤8)
  │
  ├─ plan.mjs       skills → owning agents → dependency closure → batches by
  │                 (routing phase, dependency depth) → cost index vs all-opus
  │                 → prints. NEVER dispatches.
  │
  ├─ agents.yaml    45 agents · 24 active, 10 validation, 6 passive, 5 control
  │                 protocol: summary, voice, log, gate, verdict, files_changed,
  │                 decisions, findings, risks, testing, remaining, handoff
  │                 7 human-approval gates · review_loop: 3 rounds
  │
  ├─ context        pack.mjs   repo facts, deterministic, zero tokens
  │                 context.mjs 1482 lines — per-session handoff doc, journal,
  │                            compaction capture, secret redaction
  │                 daily log  written as work happens, LOG: marker
  │
  └─ voice          hook → queue → ONE drainer → speech. Gate hits are loudest.
```

Verified state: doctor Healthy — 0 broken dependencies, 0 unresolved conflicts,
0 duplicate responsibilities, 0 unreachable agents, 45/45 protocol compliance.

## 2. Current strengths — do not rebuild these

| Directive asks for | Status | Evidence |
|---|---|---|
| §8 intelligent routing | **exists** | decision table + scorer, three effort modes, cost index |
| §9 parallelism | **exists** | batching on (phase, depth); `MAX_BATCH`; no agent shares a batch with a dependency |
| §13 no sprawl | **exists, enforced** | doctor fails on duplicate responsibility, unreachable agent, broken dependency |
| §16 quality gates | **exists** | 7 human gates, declared, printed by `plan`, announced loudest by voice |
| §17 Frappe intelligence | **exists** | `safe_exec` rules, no-bench reality, per-agent `frappe:` flag |
| §14 memory separation | **mostly exists** | four distinct layers already; see gap 5 |
| §11 review loop | **exists** (built this session) | 3 rounds, panel by quality-sentinel, halts on same-objection-twice |
| §19 preserve what works | **enforced** | 159 node + 39 audio + 122 concurrency tests, CI on 3 platforms |

## 3. Current weaknesses — the real ones

**W1. The system cannot route work about itself.** Asked to "evolve the swarm", `route`
returns *no skills* and `plan` prints "Answer this directly." Meanwhile
`swarm-evolution`, `agent-guardian`, `skill-guardian`, `routing-auditor` and
`efficiency-auditor` all exist — and all are `mode: passive`, which means never routed.
Six agents whose entire subject is JARVIS itself, unreachable. This is the single
largest gap and it is why the directive had to be written by hand instead of routed.

**W2. Nothing measures outcome.** `doctor` and `health` are *static* checks — they
validate the registry against itself. Neither has ever observed a task. There is no
record of which agent produced work that was accepted, which was revised, which
verification caught a defect, or which dispatch was wasted. §12's "agent health" as
specified (successful tasks, failed tasks, average usefulness, routing frequency)
does not exist and cannot exist without W3.

**W3. The handoff protocol carries no decision-usable signal.** It has twelve fields,
all *descriptive*. It has no `status`, no `confidence`, no `recommended_next_agent`,
no `unverified`. So the orchestrator cannot automatically determine what the directive
§7 asks it to determine — whether work is complete, whether another agent is needed,
whether verification was sufficient. Every one of those judgements is currently made by
a human reading prose.

**W4. Conflicts are declared but never reconciled.** `conflicts_with` and
`conflict_rule` exist and doctor verifies they are resolvable — but that is *static*
conflict avoidance at routing time. The directive §15 asks for something different:
two agents that both did work and disagree about the finding. Nothing handles that.

**W5. Context is layered but not scoped per role.** Four layers exist, which is more
than most systems have. But every agent receives the same context pack. §14's "agents
should receive only the context necessary for their role" is not implemented.

**W6. Review-loop reachability.** `code-reviewer`'s only skill is external;
`qa-engineer` has none. Both were unreachable until this session. The review panel is
still assembled only from validation agents the *request* happened to route — ask for
"a review" and you get nobody.

## 4. Research — what the ecosystem has that JARVIS does not

Three findings are directly applicable. The rest of the 2026 literature is either
already reflected here or does not fit a zero-dependency, no-network design.

**EvoRoute** ([arXiv 2601.02695](https://arxiv.org/abs/2601.02695), ACL 2026) —
routing as a *policy refined by environment feedback*, not a fixed table. Reports
+10.3% task performance at ~20% of cost and ~3× faster by learning which backbone suits
which step. Names the tension explicitly as the **Agent System Trilemma**: performance
vs cost vs latency. JARVIS already prices routes (cost index) but never learns from
what the route produced. **This is the pattern for W2 and the learning loop.**

**AgentDevel** ([arXiv 2601.04620](https://arxiv.org/abs/2601.04620)) — reframes
self-improvement as *release engineering*: the agent is a shippable artifact and
improvement runs through a regression-aware pipeline. Three ideas worth taking:
an **implementation-blind critic** that characterises failure without seeing internals;
**executable diagnosis** producing auditable specs; and **flip-centered gating** —
judge a change by example-level P→F regressions and F→P fixes, not by aggregate score.
Directly answers §11's demand that self-improvement be "evidence-based, versioned,
auditable, reversible, tested". **This is the pattern for the evaluation framework.**

**MemEvolve / Prism / Awesome-Memory-for-Agents** — the memory literature splits
*personalised* from *self-improving* memory, the latter distilling reusable lessons from
interaction. JARVIS has the substrate (daily log, journal, `DECISION:`/`GOTCHA:`
markers) but nothing distils it. Lower priority than the above two: the substrate is
the hard part and it is already built.

## 5. Top 10 skills — and why the question is the wrong lever

The directive asks for the ten most relevant skills to adopt. Answering it literally
would be a mistake, and the directive itself says so at §13 ("more skills ≠ better
architecture") and §5 ("do not artificially limit yourself if the analysis shows a
different architecture is superior").

Evidence: 21 skills registered, 0 missing, 0 orphaned, 0 routing conflicts, 7
deliberately shared. The skill layer is not the constraint. Adding ten skills to a
system that cannot tell whether a skill helped would produce ten unmeasured skills.

**Recommendation: adopt two capability concepts, not ten skills.**

| # | Capability | Adopt / adapt / reject | Why |
|---|---|---|---|
| 1 | Outcome ledger (EvoRoute) | **adapt** | routing needs feedback before anything else pays off |
| 2 | Flip-centered evaluation (AgentDevel) | **adapt** | the only honest way to prove a change helped |
| 3 | Implementation-blind critic | **adapt** | reuses the review loop; no new agent |
| 4 | Lesson distillation from the log | defer | substrate exists; value depends on 1 |
| 5 | Role-scoped context slices | **adopt** | W5, cheap, immediate token saving |
| 6 | Semantic/vector memory | **reject** | needs a dependency and a network; violates a core property |
| 7 | Agent-to-agent message bus | **reject** | sub-agents cannot address each other in this host; the queue already serialises |
| 8 | Tree-search over trajectories | **reject** | EvoRoute's optimisation phase needs many speculative runs; cost is the thing we minimise |
| 9 | Skill auto-generation | **reject** | gate 6 exists precisely to stop this |
| 10 | External eval harness | **reject** | `promptfoo` was already benchmarked here; a local ledger is cheaper and honest |

## 6. Top 10 agents — same answer, same reason

45 agents, 0 duplicates, 0 unreachable, every one with a measurable responsibility.
The roster is not the constraint either. The directive's own §13 forbids adding agents
without measurable value, and there is currently **no mechanism to measure value** —
so no new agent can be justified on evidence today. That is itself the argument for
building the measurement first.

**Recommendation: add ONE agent and re-mode five.**

| Action | Agent | Why |
|---|---|---|
| **new** | `evaluator` | owns the outcome ledger and the flip-centered verdict. Nothing owns this. |
| **re-mode** | `swarm-evolution`, `agent-guardian`, `skill-guardian`, `routing-auditor`, `efficiency-auditor` | `passive` → routable on meta-requests, fixing W1 |
| reject | Research / Debugging / Release / Meta-Orchestrator agents | `research-orchestrator`, `qa-engineer`, `deployment-safety`, `delivery-orchestrator` already hold these responsibilities. Adding them duplicates, and doctor would fail it. |

## 7. Proposed architecture

The change is not a new layer. It is **closing the loop that is already 80% built.**

```
request
  │
  ▼
ROUTE ──────────────────► PLAN ──────────► execute (main thread)
  ▲                        │                    │
  │                        │                    ▼
  │                   review loop ◄──────── handoffs
  │                    (3 rounds)                │
  │                                              ▼
  │                                        OUTCOME LEDGER      ← new
  │                                      accepted / revised
  │                                      verified / unverified
  │                                      dispatched / wasted
  │                                              │
  └──────── routing hints ◄──── EVALUATOR ◄──────┘            ← new agent
            (evidence, versioned,      flip-centered:
             reversible, gated)        P→F regression = block
                                       F→P fix       = evidence
```

**Communication protocol (§7).** Extend the existing twelve fields with four that carry
*decisions* rather than description — `status`, `confidence`, `recommended_next_agent`,
`unverified`. Do not replace the protocol; the existing fields are load-bearing and
45 agents plus three test suites depend on them.

**Memory (§14).** Add role-scoped slices of the existing context pack. No new store.

**Self-improvement (§11).** The ledger records; the evaluator proposes; a **human gate
approves**. Routing hints are versioned files, diffable and revertible. No component
edits the registry autonomously — gate 5 and gate 6 already forbid it and that is
correct.

**Evaluation (§18).** A fixed set of routing probes with expected shapes, run before
and after any change. Report flips, not averages. This is the only way to answer
"is JARVIS better" with evidence rather than assertion.

## 8. What I will not do, and why

- **Not adding 10 skills or 10 agents.** No measurement exists to justify them; §13
  forbids unmeasured additions. Measurement first.
- **Not making `plan` dispatch.** It prints, you decide. That property is why the
  seven gates are meaningful.
- **Not adding a dependency or a network call.** Zero-dep and local-only are load-bearing
  properties, stated in `package.json` and enforced by CI.
- **Not letting anything self-modify the registry.** Gates 5 and 6 exist for this.
- **Not rewriting the handoff protocol.** Extending it is reversible; replacing it is not.

## 9. Risks

| Risk | Mitigation |
|---|---|
| Ledger becomes a write-only log nobody reads | The evaluator's verdict is printed by `plan`, or the ledger is not built |
| Re-moding 5 passive agents floods ordinary requests | Gate them behind meta-intent in the decision table; verify "fix a typo" still routes 0 agents |
| 4 new protocol fields dilute the contract | Optional except `status`; assert presence in the contract tests |
| Learning loop entrenches a bad early route | Flip-centered gating blocks P→F; hints are versioned and revertible |
| Scope: this directive could consume weeks | Phased below; each phase independently shippable and green |

## 10. Implementation phases

Each phase ends green (doctor + health + 159 node + 39 audio + 122 concurrency) and is
independently useful. **Phase 1 is the one that unblocks everything else.**

| Phase | Delivers | Fixes |
|---|---|---|
| **1** | Outcome ledger + 4 protocol fields | W2, W3 — makes measurement possible at all |
| **2** | `evaluator` agent + flip-centered probes; `plan` prints the verdict | §18 |
| **3** | Re-mode the 5 governance agents behind meta-intent routing | W1 |
| **4** | Versioned routing hints from the ledger, human-gated | §11 |
| **5** | Role-scoped context slices | W5, token cost |
| **6** | Conflict reconciliation using the review loop | W4 |

## 11. Definition of done for this work

Not "JARVIS is more intelligent". Specifically:

- `route "improve the swarm"` returns the governance agents instead of nothing
- the ledger shows, for a real run, which agents were accepted and which revised
- `plan` prints a flip-centered verdict against the probe set
- a deliberately bad routing hint is **blocked** by the P→F gate, demonstrated
- every existing test still passes, and the new behaviour has its own
