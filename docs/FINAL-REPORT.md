# JARVIS — what changed, and why it is better

§21 of the evolution directive asks for this report under eleven specific headings, and
asks that "JARVIS is now more intelligent" not be said without demonstrating why. So
every claim below names the artifact that backs it, and the last section is the list of
things that are still not true.

Written after the work, from the repository — not from the plan.

---

## What Changed

Eleven phases, each closing a gap that was real rather than theoretical.

| # | Change | The gap it closed |
|---|---|---|
| 1 | Outcome ledger | Sub-agents reported into the void. Nothing recorded what a dispatch produced. |
| 2 | `readme.html` | The front page did not sell the thing. |
| 3 | Flip-centered evaluation | "Better" was unfalsifiable. Aggregate totals hide regressions. |
| 4 | Meta-routing | Six governance agents were unreachable — the system could not route work about itself. |
| 5 | Ledger-driven learning | No mechanism turned observation into a proposal. |
| 6 | Conflict reconciliation | Two agents who disagreed resolved by whichever handoff was read last. |
| 7 | Install drift detection | "Already installed" hid a six-commit-stale machine while `doctor` said Healthy. |
| 8 | Twelve-field handoff protocol | Seven declared fields reached no agent. Declared, not conveyed. |
| 9 | **The review-loop driver** | `review_loop` was declared and enforced by nothing. |
| 10 | Write-collision batching | §9 was one line of registry prose warning that collisions could happen. |
| 11 | Role-scoped context packs | One pack went to every agent regardless of role. |

Nine and eleven are the ones that change behaviour rather than reporting.

## Why It Is Better

Three properties the system did not have, in order of how much they matter.

**1. "Done" is now a computed verdict, not a judgement call.** `jarvis.mjs loop` reads
the collected handoffs and returns exit 0 only when every declared gate is met. It
refuses by default: an unparseable handoff, a missing field, a reviewer who never
reported, a SUCCESS with a non-empty `unverified` — all resolve toward *another round*.
The asymmetry is deliberate. A false "not done" costs one round; a false "done" ships the
defect.

Demonstration, from the real CLI: a handoff reading `Done! Looks good.` returns
**12 missing fields and exit 1**. A handoff claiming SUCCESS at HIGH confidence with
`unverified: nothing was run` is **refused and routed to test-engineer**. Neither of
those was previously distinguishable from a finished task.

**2. A regression in routing now blocks a commit.** `evaluate` reports per-probe P→F and
F→P against a stored baseline and treats one P→F as blocking. It earned this on its first
real use by blocking a change of mine — 10 probes flipped P→F on a commit I would
otherwise have made.

**3. Declaring a rule is now a commitment to enforcing it.** Three `doctor` checks exist
solely to stop the fixes above rotting back into the bugs they fixed:

- every field in `protocol.required` / `when_applicable` must have a description **and**
  must be rendered into an agent — a field nobody is shown is not a protocol;
- every condition in `review_loop.halt_on` must have code behind it in `scripts/loop.mjs`;
- every `tiebreak_precedence` entry must name a real agent.

Each was verified by planting a violation and watching `doctor` fail.

## New Agents

**None.** Deliberately, and this is the finding rather than an omission.

§13 forbids adding agents without measurable value; there was no mechanism to measure
value; so no new agent could be justified on evidence. The measurement got built instead.
The roster stayed at 45 with 0 duplicates and 0 unreachable. (It is 46 now: the
security reviewer below was added afterwards, on instruction.)

Four agents were **renamed** (domain-neutral), five **re-moded** `passive` → routable,
and one genuine gap is recorded and left open: **a security reviewer**. Security is
currently a human gate plus a checklist inside `code-reviewer`'s review — enough to stop
a bad change shipping, not enough to find one. It is not being added yet because the
ledger is empty, so the case for it would be intuition. If `learn` proposes it from
observed evidence, the loop worked.

## New/Updated Skills

No new skills. 21 registered, 0 missing, 0 orphaned, 0 routing conflicts — the skill
layer was never the constraint, and adding ten skills to a system that could not tell
whether a skill helped would have produced ten unmeasured skills.

Updated: the `jarvis` skill now documents the review loop it is expected to run, and
`build` regenerates the registry from the source tree.

## Routing Improvements

- **Meta-work is routable.** `audit the swarm roster for unused agents` convened nobody;
  six governance agents were unreachable because no skill claims work about JARVIS itself.
  Two narrow meta rules with an `unless` guard, so ordinary requests are untouched.
- **15 routing probes**, each verified by hand against the real command before being
  written down, gating every commit. Routing is deterministic and model-free, so the set
  runs in seconds.
- **Write collisions split batches.** Batching was (phase, depth) — correct for
  dependencies, silent about collisions. 18 writer agents now declare a `writes` scope
  and `plan` refuses to co-batch two that overlap, saying *why* so a collision split is
  not mistaken for a dependency. Honest caveat: `conflicts_with` already catches most
  same-scope pairs at routing time, so this is defence in depth and rarely fires — which
  is exactly why it is unit-tested rather than exercised through a request.

## Self-Improvement Mechanism

```
ledger  ->  learn  ->  proposal  ->  [ a human reads it ]  ->  routing table
                            |
                            +-- evaluate: any P->F and the proposal is refused
```

`MIN_RUNS = 5` is the whole difference between learning and pattern-matching on noise.

The loop is **deliberately open at the last step**. `learn` writes `registry/hints.yaml`,
which nothing loads. "Changing the swarm architecture itself" and "generating a new agent"
are two of the seven gates; a system that quietly re-tunes its own router has removed the
reason those gates exist. Versioned, diffable, revertible, inert.

**Unexercised.** The ledger is empty — zero rows. Every agent-health metric is therefore
computed over an empty set. `doctor` now says so out loud, because "the loop is built"
and "the loop is working" are different claims and only one was ever checkable.

## Quality Improvements

- **The protocol is twelve fields, and all twelve reach every agent.** Seven were
  declared in the registry and rendered nowhere.
- **Silence is not an option.** An inapplicable field is written `none`. An omitted
  `risks` and a `risks: none` read identically to whoever picks the work up, and only one
  is a statement — the distinction is the point.
- **Agents are told how to disagree**: state your falsifier, quote rather than
  characterise, argue the axes not the author, stop if it touches a gate.
- **Disagreement is a procedure, not a ranking.** Five steps reusing the review loop, with
  the rejected position recorded. Safety outranks architecture in the tiebreak on purpose
  — a wrong security call is not reversible by a later refactor and a wrong architecture
  call usually is — and there is a test asserting that ordering, because it is the kind of
  list someone tidies into alphabetical order.

## Performance/Token Improvements

Measured, not asserted. `bench` computes the before column from the same run, so nothing
is remembered from a previous version.

| Lever | Effect |
|---|---|
| Contest resolution | fewer dispatches — all claimants of a shared skill used to be convened |
| Batching | serial steps → batched steps |
| Model tiering | cost index vs an all-opus baseline |
| Role-scoped packs | measured on a real app: **79–80% smaller** for `ui-designer` and `requirements-analyst`; **63%** for `reporting-developer`; **16%** for `git-safety` |

The honest row: **`schema-builder` is 1% *larger*.** It legitimately needs almost the
whole surface, so scoping buys nothing and adds a footer line. Correct behaviour, not a
defect — and worth stating, because a table showing only the wins would imply scoping
always pays.

What none of this measures is **wall-clock**. Latency depends on the provider and the
task, not on this registry. Anyone quoting a speed-up from these numbers is quoting a
ratio, not a stopwatch.

## Tests & Evidence

| Gate | Result |
|---|---|
| `npm test` | **221 pass, 0 fail** |
| `tests/voice-audio.sh` | 39 pass, 0 fail |
| `tests/voice-concurrency.sh` | 122 pass, 0 fail |
| `jarvis.mjs evaluate` | 15/15 probes hold, no flips against baseline |
| `jarvis.mjs doctor` | Healthy — 46 agents, 0 duplicates, 0 unreachable |
| `jarvis.mjs health` | Healthy — 21 skills discovered, 0 missing, 0 orphaned |
| `shellcheck` | clean |
| CI | green on macOS, Ubuntu and Windows, node 18/20/22 |

Every enforcement check was verified by **planting a violation**, not by reading the code:
a tiebreak naming a non-agent, a halt condition with no implementation, a protocol field
with no description, a drifted install, a typo'd context-scope role. Each one fails as
intended.

## Known Limitations

All seven limitations in the first version of this report were closed on instruction. What
follows is what each turned out to require, and what is *still* not true afterwards —
because a limitations section that empties itself is a marketing document.

| Was | Now |
|---|---|
| 1. The learning loop had never run on real data | **Closed by making the driver the writer.** The ledger's only writer was a `SubagentStop` hook, and the coordinator often reads a handoff without one firing. The loop driver sees every handoff by construction — it cannot answer "is this done?" without them — so judging and recording are the same moment. The ledger now fills as a side effect of use. Format matches `voice/jarvis.sh` `ledger_append` exactly; `learn` reads driver-written rows, verified. |
| 2. The driver did not judge quality | **Partly closed, and honestly.** It still cannot tell whether a reviewer was *right*. It can now tell an assertion from evidence: `testing: passed` is an opinion, `testing: 4 passed, 0 failed` is output. The protocol always said "never assert a pass without output" and nothing checked it. |
| 3. No security reviewer | **Closed, overriding this report's own recommendation.** The assessment argued for waiting until the ledger could justify it; the owner decided otherwise, which is a legitimate call — "no evidence yet" is an argument for caution, not a veto. Deliberately given no Write tool: a reviewer that can rewrite what it reviews will fix the finding instead of reporting it. Its routing rule fires on the obvious words *and* on the changes that need it without being described as security work. |
| 4. Write scopes were coarse labels | **Closed with globs.** Three agents writing three different documents were serialised because all three said `docs`. They now run in **one batch instead of three**. |
| 5. The mode-scoping refactor | **Closed, on the third attempt, by writing the assertions first.** The two failures were both edits *inside* the agent template literal; this time the halves are built as strings outside it and the literal carries one interpolation. Reviewer-side guidance now reaches the 11 validation agents instead of all 46 — about 20 KB across a full roster dispatch. |
| 6. `objectionKey` was a bare heuristic | **Improved.** It handled inflection but not nominalisation, so "rows orphan on delete" and "orphaned rows on deletion" scored 0.5 and read as two different objections — which would have burned the loop's whole cap discovering it was stuck. Now stems nominalisations too. |
| 7. Per-role context (§14) | **Closed, and then extended.** The pack is role-scoped, and a code graph was added on top — see below. |

### What is still not true

1. **The ledger is still thin.** It now fills from use rather than never, but `learn` proposes nothing below 5 runs per agent, so the first real proposal is still ahead. That bar is the point and is not being lowered.
2. **The driver still does not dispatch.** It answers "is this done?" and names who is next; the coordinator dispatches. It removes the ability to *skip* the question, not the ability to ignore the answer.
3. **The evidence check is a shape check.** It can tell `4 passed, 0 failed` from `passed`. It cannot tell a real test run from a plausible-looking fabrication of one.
4. **`security-reviewer` has no observed value yet.** It was added on instruction, not on evidence, and this report records that so nobody later mistakes it for a measured decision. Its worth is now a question the ledger can eventually answer.
5. **Write globs are declared, not verified.** `docs/guides/**` is what an agent is *told* it owns. Nothing checks that it wrote only there.
6. **Stemming remains crude.** Suffix stripping, no dependency. It over-stems harmlessly (`table` → `tabl`) because both sides stem identically, but it will miss a heavily-reworded repeat.
7. **The code graph is only as fresh as its last build.** Staleness is detected and announced loudly; it is not prevented. A graph 43 commits behind — the state the one on this machine was actually in — answers confidently about code that has moved.
8. **Graph coverage depends on Graphify's extractors.** Relation vocabularies differ between languages, and an unclassified relation is excluded from traversal. Both observed vocabularies are handled and unknowns are reported as making every count a floor, but a new extractor can still narrow coverage silently until someone reads that warning.

## Future Evolution

In the order the evidence supports, which is not the order of ambition:

1. **Let the ledger fill.** Everything below depends on it, and nothing more should be
   built on top of an empty one.
2. **Then re-read `learn`'s proposals.** The first genuine test of whether the loop was
   worth building is whether it proposes something a human agrees with — the security
   reviewer being the obvious candidate.
3. **Wire the loop driver into dispatch,** so a round cannot be declared finished without
   the driver's exit code. Today it is available and honoured by convention, which is the
   weaker half of the same problem it fixed.
4. **Narrow write scopes to globs** once there is evidence of unnecessary serialisation.
5. **The mode-scoping refactor**, with assertions first.

Not on this list, deliberately: more agents, more skills, a message bus, vector memory,
tree search over trajectories. Each was evaluated and rejected with a reason in
`docs/ARCHITECTURE-ASSESSMENT.md`. The constraint was never the size of the roster.
