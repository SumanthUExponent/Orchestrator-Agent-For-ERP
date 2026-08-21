# JARVIS — Intelligence Evolution Research

Research output for the Intelligence Evolution Protocol. **No JARVIS code was modified to
produce this** (§28). Every architectural claim carries a source; everything I could not
verify is marked UNVERIFIED rather than smoothed over.

Date: 2026-08-21 · Claude Code 2.1.238 · repo at `aed3a27`

---

## 0. Methodology, and one downgrade I have to declare

**§12 asked for Perplexity MCP first. It was not configured, so discovery ran on the
built-in `WebSearch` and `WebFetch` instead.**

I originally recorded that as a methodology downgrade. **That was wrong, and it has been
corrected in the system as well as here.** Every Tier-1 verification in this document —
16 arXiv IDs, the OpenHands pivot via `gh api`, the MCP spec pages, the Letta and
Anthropic docs — was done on those same free built-in tools. Perplexity would have been
faster at *discovery*; it would not have changed a single verified claim. What the missing
provider actually cost was breadth, and the gap list at §7b says where.

The registry now names `WebSearch` + `WebFetch` as the research capability, and `health`
reports it as available rather than failing on an absent paid provider. It had been
reporting a red check throughout this research for a capability the system was actively
using.

Six parallel research streams were dispatched, chosen because each has a different source
base and a different failure mode. **All six returned.** Each was told to separate VERIFIED
from UNVERIFIED and to fabricate no citations; where a stream left something unverified, it
stays unverified here.

**Citation integrity.** One stream claimed it machine-verified every arXiv ID against the
API. I checked that claim independently: 16 of 16 load-bearing IDs resolved to the
expected titles, and a deliberate fake control (`9999.99999`) correctly returned nothing.
My first check returned MISS for everything — that was my own bug (`http://` returns 301,
curl was not following redirects), and I nearly reported the citations as fabricated on
the strength of it. Recorded because a verification tool that fails closed *looks exactly
like* a finding.

---

## 1. Executive summary

Five findings reorder the whole plan.

**0. THE HEADLINE, and it arrived last: the state-of-the-art open scaffold on SWE-bench
Verified is a 100-line agent plus a page of YAML.**

`OpenAutoCoder/live-swe-agent` scores **396/500 = 79.2%** with Claude Opus 4.5. Its repo
contains four things — `LICENSE`, `README.md`, `assets/`, `config/` — and **no
implementation** (verified: `language: NONE`, 452★). It is ~150 lines of YAML on top of
`mini-swe-agent`, the 100-line bash-only agent with no tool-calling API, no persistent
shell, and a completely linear history.

It comes from `OpenAutoCoder` — **the same org as Agentless**, whose best-ever score was
254/500 = 50.8% and which has been frozen since 2024-12-22. First author Chunqiu Steven
Xia is the Agentless first author. The self-evolution mechanism is two prompt edits telling
the model it may write its own throwaway tools. That delta over plain mini-swe-agent is
worth **+2.0 points at $0.68/issue**.

So the anti-complexity thesis was right and the anti-*agent* framing was the wrong hill.
**What deserved deleting was scaffolding — indexes, graphs, search trees, phase machinery,
orchestration layers. What deserved keeping was the loop with a shell in it.** Every
elaborate pipeline in this research was beaten by roughly 28 points by a config file.

**1. No shipping multi-agent framework routes on historical performance.**
Ten frameworks surveyed — LangGraph, CrewAI, AutoGen/Microsoft Agent Framework, OpenAI
Agents SDK, Google ADK, PydanticAI, smolagents, Letta, Mastra, LlamaIndex Workflows.
Routing in all ten is one of exactly three things: static code, a single LLM guess at the
current turn, or a declared description match. No success-rate table, no per-agent score,
no bandit, no feedback write-back. **§10 and §11 are therefore not a catch-up item — they
are an open research area** where the 2026 literature is ahead of every shipping product.
The registry is the right substrate; nothing off the shelf will supply it.

**2. Conflict resolution is a universal blank.** Ten frameworks, zero arbitration
primitives. The only near-answers are Magentic-One's progress ledger (replan on stall) and
academic middleware. JARVIS's `conflict_reconciliation` — five steps, authority-ordered
tiebreak, escalation conditions — is **ahead of the field**, which was not the expectation
going in.

**3. The single most exploitable gap found is small and concrete.** Claude Code supports a
`skills:` frontmatter field that *preloads skill content* into a subagent. JARVIS uses it
**zero times**, while 29 agents ask the model in prose to "load these skills first."
Prose asking is a hope; frontmatter is a guarantee. This is the same declared-vs-enforced
family the repo keeps finding, and it is a one-file fix.

**4. Same-model self-critique makes results worse, and the review loop is currently built
on it.** [arXiv:2310.01798](https://arxiv.org/abs/2310.01798) *Large Language Models
Cannot Self-Correct Reasoning Yet* against
[arXiv:2305.11738](https://arxiv.org/abs/2305.11738) *CRITIC* is decisive: critique pays
only when the critic holds a signal the actor lacked. JARVIS's review panel is currently
the same model on the same context, which the literature says is expensive noise.

**5. A coding agent with repo access, issue reading, and push rights *is* the lethal
trifecta.** Not as an MCP problem — as a description of what JARVIS already is. Every
MCP decision downstream follows from that.

---

## 2. Current JARVIS capability map (§17, measured)

| | |
|---|---|
| Roster | 46 agents — 24 active, 11 validation, 6 passive, 5 control |
| Integrity | 0 duplicates, 0 unreachable, 0 unresolved conflicts, 46/46 with a measurable responsibility |
| Tiers | haiku 2, sonnet 31, opus 13 |
| Skills | 21 registered, 0 missing, 0 orphaned, 0 routing conflicts |
| Routing | 23 rules keyed on `when_any`/`when_all`/`unless`/`signals`/`categories`/`weight`/`effort`/`gates` |
| Protocol | 12 fields, two tiers, rendered into all 46 and audited by `doctor` |
| Loop | driver enforcing 4 halt conditions, exit-coded |
| Reconciliation | 5 steps, 6-entry authority tiebreak, 3 escalation conditions |
| Measurement | 19 flip-gated probes, 271 node tests, 39 audio, 122 concurrency |
| Learning | 11 ledger rows · `hints.yaml` never written |
| Graph | Graphify adapter, content-aware staleness |
| External research | granted to 4 agents, **no provider configured** |

### Strengths worth protecting (do not rebuild these)

Deterministic model-free routing; flip-centered regression gating; the seven human gates;
the loop driver that refuses by default; conflict reconciliation; `doctor`/`health` as
enforcement rather than reporting; zero runtime dependencies.

### The real weaknesses

| # | Weakness | Evidence |
|---|---|---|
| W1 | **Skills are requested in prose, not preloaded** | 29 agents say "load these first"; 0 use `skills:` frontmatter |
| W2 | **Review panel is same-model, same-context** | contradicts 2310.01798; no requirement that a verdict cite external evidence |
| W3 | **82% of ledger rows are unattributable** | 9 of 11 rows are `agent: unknown` |
| W4 | **No per-task-kind performance memory** | `success_rate`, `quality_score`, `last_validated`, `known_failure_modes`, `reputation` all absent |
| W5 | **Effort mode is user-declared, not measured** | no escalation-on-failure path |
| W6 | **Write collisions are batch-split, not admission-controlled** | no neutral steward; no merge rule per shared key |
| W7 | **Memory cannot be corrected** | append-only ledger with no supersession; "append-only stores struggle with targeted overwrites" ([2606.24775](https://arxiv.org/abs/2606.24775)) |
| W8 | **No trifecta audit** | JARVIS already holds all three legs |

---

## 3. Claude Code architecture (§07) — three corrections to my assumptions

Source: [sub-agents](https://code.claude.com/docs/en/sub-agents.md),
[agent-teams](https://code.claude.com/docs/en/agent-teams.md),
[hooks](https://code.claude.com/docs/en/hooks.md).

**Subagents inherit more than I believed.** DOCUMENTED: own system prompt, the delegation
message, **the full CLAUDE.md hierarchy**, a git-status snapshot, **preloaded skills from
the `skills:` frontmatter field**, a sibling roster (v2.1.206+ — we are on 2.1.238), and
**connected MCP servers**. They do *not* inherit conversation history, output style, or
the parent's auto-memory. A `/subtask` fork *does* inherit history.

**Subagents can invoke skills** — two ways: preloaded via `skills:` frontmatter, or
dynamically via the `Skill` tool. This is W1's fix.

**Agent teams are a different primitive.** Teammates message each other directly and
self-coordinate via a shared task list; subagents report only to the caller. JARVIS has no
peer-to-peer channel at all — which is precisely *why* `conflict_reconciliation` had to
route every disagreement through the coordinator.

**One claim from that stream I am rejecting on direct evidence.** It reported subagents
run sequentially. I launched six concurrently while writing this and all six ran at once.
Observed behaviour beats a doc summary; recorded so the error does not propagate.

**Hook surface is far wider than JARVIS uses** — including `FileChanged`, `CwdChanged`,
`PermissionRequest`, `InstructionsLoaded`, and the agent-team events `TeammateIdle`,
`TaskCreated`, `TaskCompleted` (all three can block with exit 2). The docs reference "30+
events"; the fetched page does not enumerate them, so the complete list is **UNKNOWN**.

---

## 4. Multi-agent frameworks (§03) — what each boundary object actually is

| Framework | Control decided by | Boundary object | Perf routing | Write conflicts | Conflict resolution |
|---|---|---|---|---|---|
| LangGraph | code (mostly) | typed state delta | no | **same-step ambiguity = runtime error** | none |
| OpenAI Agents SDK | model | full history (filterable) + typed handoff args | no | n/a | none |
| CrewAI | code / manager LLM | text | no | unmodelled | none |
| MS AF / AutoGen | both, explicitly split | typed msg / workflow state | no | unmodelled | termination + Magentic ledger |
| Google ADK | both, explicitly split | shared session state | no | convention (`output_key`) | none |
| PydanticAI | code | typed deps / typed output | no | n/a | none |
| smolagents | model (code actions) | interpreter namespace | no | unmodelled | none |
| Letta | model | **shared memory blocks** | no | **optimistic locking (CAS) → 409** | detect, not merge |
| Mastra | code | zod-typed step I/O | no | unmodelled | none |
| LlamaIndex | events | typed Event + Context | no | collect barrier | none |

### Write-safety, settled from source — and one prior was wrong

The previous pass flagged three concurrency questions as UNVERIFIED with a stated prior.
All three are now answered from source code, and **the Letta prior was wrong.**

**Letta does NOT do last-write-wins.** It uses SQLAlchemy optimistic locking — `Block`
declares a `version` column wired as `__mapper_args__ = {"version_id_col": version}`
(`letta/orm/block.py:53-61`), so every UPDATE emits `WHERE id = :id AND version =
:loaded_version`. Zero affected rows raises `StaleDataError`, which is converted to a
domain error rather than swallowed: `ConcurrentUpdateError`, `ErrorCode.CONFLICT`, HTTP
409, *"was updated by another transaction. Please retry your request."*
(`letta/orm/sqlalchemy_base.py:779`, `letta/errors.py:72-78`).

The design detail worth stealing is the deliberate asymmetry: **deadlocks get bounded
retry with backoff; a stale write is re-raised immediately.** Letta detects the conflict
and refuses to resolve it — no merge, no CRDT, the loser re-reads and retries. That is
conflict *detection* without conflict *resolution*, and it is the correct division: the
framework knows a lost update happened, the caller knows what the write meant.

Verified at tag `0.16.8` and present at 0.11.0, so not a recent addition. Note also that
the Letta OSS server source was **removed from `main` on 2026-08-16** ("archive the
legacy server repository") — a third repudiation-shaped event alongside OpenHands and
Roo Code.

**Google ADK: confirmed no enforcement, and the primitive is deprecated.**
`_create_branch_ctx_for_sub_agent` does a *shallow* `model_copy()`, so `session` is the
same object in every branch; `State.__setitem__` writes straight into the shared dict; the
commit path is a literal `session.state.update({key: value})`. A grep for
`asyncio.Lock|threading.Lock|RLock` across `agents/`, `sessions/`, `flows/` and
`workflow/` returns **zero hits**. `ParallelAgent` now carries a deprecation notice, and
the replacement `workflow/` package adds no locking either. The docs themselves put the
burden on the caller: *"you'd need to manage concurrent access to this shared context
carefully (e.g., using locks) to avoid race conditions."* A framework that enforced
something would not tell you to add your own locks.

**LangGraph: confirmed, but my characterisation was too strong.** It is a **run-time**
error, never compile time — `InvalidUpdateError` from `LastValue.update`, message *"At key
'X': Can receive only one value per step. Use an Annotated key to handle multiple
values."*, raised at the superstep boundary from `apply_writes` (`pregel/_algo.py:232,319`).

Two limits I had wrong. It fires only on **two writes in the SAME superstep** — a fan-out.
Sequential steps each carry one value and overwrite silently, which is ordinary
last-write-wins. And **declaring a reducer removes the error entirely**: the reducer
becomes the merge rule, so `operator.add` gives append-only accumulation and *no conflict
signal at all*. So the hard failure is the **default**, not a floor — and it is
intra-graph only, saying nothing about two runs or two processes against one checkpoint.

That reframes what to absorb. The valuable pattern is not "make collisions a type error";
it is **make AMBIGUITY loud and require the merge rule to be declared** — with Letta's
addition that a detected lost update should be *rejected*, not silently merged.

**Mastra Agent Networks: deprecated**, and routing is purely an LLM choosing over
`name: description` strings. Scorers exist but gate *task completion*, not agent
selection, and nothing reads or writes a per-agent performance record. Memory processors
are deliberately withheld from the router because they "interfere with routing decisions."
That closes the last open question from the ten-framework survey: **the finding that no
shipping framework routes on historical performance now holds with no unverified
exceptions.**

Four transferable ideas stand out:

- **LangGraph reducers** — a concurrent write to a shared key *without a declared merge
  rule is an error*. Stronger than JARVIS's batch-splitting: it makes the collision a type
  error rather than something the scheduler avoids.
- **OpenAI `input_filter`** — what history the *receiving* agent may see, as an explicit
  per-edge policy. Most swarms either dump everything or dump the task string; neither is
  a decision.
- **ADK's explicit split** between deterministic workflow agents and LLM-delegating
  agents, chosen per node. JARVIS makes this choice globally and implicitly.
- **LlamaIndex `collect_events`** — a fan-in barrier as a first-class construct.

### Industry Tier-1, and it is uncomfortable reading

[Anthropic's own multi-agent write-up](https://www.anthropic.com/engineering/multi-agent-research-system):
**"agents typically use about 4× more tokens than chat… multi-agent systems use about 15×
more tokens"**, and **"token usage by itself explains 80% of the variance."** It also
states multi-agent is unsuitable where all agents must share context or there are many
dependencies between them.

[Cognition, *Don't Build Multi-Agents*](https://cognition.com/blog/dont-build-multi-agents):
**"Share context, and share full agent traces, not just individual messages"** and
**"Actions carry implicit decisions, and conflicting decisions carry bad results."**

Both cut against a 46-agent swarm. The honest response is not to dismiss them: it is that
JARVIS's contest resolution, effort modes and model tiering exist to attack exactly the
15× number, and `bench` exists to measure whether they do. That is the right defence, and
it is only a defence if the measurement keeps running.

---

## 5. Memory (§08) — the strongest single finding in the research

**The most memory-focused company in the space shipped a filesystem, not a vector store.**
Letta MemFS is [git-backed markdown with YAML frontmatter](https://docs.letta.com/concepts/memfs),
frontmatter "similar to the YAML frontmatter in Anthropic's `SKILL.md` files", a
pre-commit hook validating schema, the file tree in the system prompt, every edit a git
commit, subagents in isolated worktrees, and **semantic search as an optional mod**.

Anthropic's [memory tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool)
is six commands — `view`, `create`, `str_replace`, `insert`, `delete`, `rename` — with
**no index, no embedding, no ranking**. Retrieval is: list the directory, read the
promising file.

Across Letta blocks, Anthropic's tool, and JARVIS's own Edit tool, the memory-write
primitive is **unique-substring replacement in a text file**. Three independent systems
converging is a strong signal about the right abstraction level.

### Verified mechanisms worth absorbing

- **Keyed supersession over overwrite.** Every memory gets a canonical key plus
  `valid_from` and nullable `invalid_at`. A correction appends a record *and* a tombstone;
  nothing is rewritten. Current belief is a deterministic fold. **Contradiction detection
  collapses into key collision** — `awk`-cheap. Source: Graphiti temporal invalidation +
  [2606.24775](https://arxiv.org/abs/2606.24775) multi-versioning.
- **Mutation-time LLM, deterministic write path.**
  [2606.15903](https://arxiv.org/abs/2606.15903) measures placement regimes over 385
  adversarial cases: deterministic control planes score 5% on identifier obfuscation;
  LLM-at-inscription scores 0% on intent-aware deletion; **LLM-at-mutation reaches
  91.7–93.2%.** This satisfies "no network call in the hot path" exactly.
- **A named, scheduled MANAGE stage.** Write and read exist in most systems; *manage* is
  implicit, which is how accumulation happens. Letta's sleep-time agents trigger on
  step-count or compaction — both detectable from a hook.
- **Promotion gated on verification, not repetition.** Anthropic: *"Mark a feature
  complete only after end-to-end verification confirms it works, not when the code is
  written."* JARVIS already emits `unverified` per row — strictly better than a
  repeat-count, which would promote a confidently-wrong belief fastest.
- **The four-word accumulation brake**: *"Do not create new files unless necessary."*
  Cheapest mechanism in the entire research.

### What no vector store genuinely costs — stated honestly

Paraphrase robustness (5% on identifier obfuscation, measured), paraphrased-contradiction
detection across different keys, and fuzzy recall of something you cannot name.

The counterweight is strong: embeddings would **not** have solved the accumulation
problem, because dense similarity "remains weakest when stale mentions must be separated
from updated ones" and degrades as temporal distance grows — the exact axis the concern
lives on. A vector store makes accumulation *worse* by making stale memories retrievable
and confident.

### Rejected

A decay function as primary hygiene — [2607.08032](https://arxiv.org/abs/2607.08032) finds
recency and attention magnitude "fail, because they discard information before the future
query is known", and JARVIS's gotchas are load-bearing *because* they are rare and old.
**Access-recency is a valid signal; write-recency is not.** Also rejected: any LLM pass
that rewrites the ledger (semantic drift), and mem0-style additive-only accumulation.

---

## 6. MCP (§06) — the security half is the important half

**Current spec revision is `2026-07-28` and MCP is now stateless** — "no protocol-level
sessions". Most 2025-era MCP security commentary describes a protocol that no longer
exists.

**Tool poisoning** was first documented by
[Invariant Labs, 1 Apr 2025](https://invariantlabs.ai/blog/mcp-security-notification-tool-poisoning-attacks).
The mechanism is an asymmetry: the tool *description* is full-fidelity input to the model,
while clients render a name and a one-liner to the human. It lands at `tools/list` time —
**before the user types anything**. Worse, a malicious server's description can modify the
agent's behaviour *toward a trusted server*. **Trust does not compose.**

**Prompt injection via tool results** — three independent verified cases, and the first is
exactly the JARVIS workflow: a public GitHub issue instructs an agent to read private
repos and publish them into a public PR. **It is not a flaw in the server's code.**
Read-only tools sufficed. There is no version that fixes it.

**The lethal trifecta** —
[Willison, 16 Jun 2025](https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/):
private data + untrusted content + external communication. His conclusion, unsoftened:
*"The only way to stay safe there is to avoid that lethal trifecta combination entirely."*
And the corollary that matters here: **a coding agent with repo access, issue reading and
push rights already is that trifecta, with or without MCP.**

**Registry presence is not a safety control** — by its own documentation the MCP Registry
verifies *namespace ownership only* and explicitly "delegates security scanning" to
package registries. It is in preview, and has had its own unauthenticated SSRF.

**"Use the official server" is not a control either.** Every one of these was in
official/reference/first-party code: `CVE-2025-6514` (mcp-remote RCE, CVSS 9.6, triggered
merely by connecting), `CVE-2025-53109/53110` (Anthropic's *reference filesystem server* —
prefix-matching and symlink escapes; the canonical sandbox primitive was not a sandbox),
`CVE-2025-49596` (MCP Inspector RCE, CVSS 9.4), and the `postmark-mcp` npm backdoor — a
near-exact clone plus one line BCC'ing every email, ~1,643 downloads.

**Do not rely on tool annotations.** The spec itself: clients "MUST consider tool
annotations to be untrusted unless they come from trusted servers." A malicious server
sets `readOnlyHint: true` on an exfiltration tool for free.

### The five MCP capabilities that would earn their context

Note the shape — four of five are read-only remote indexes or sessions, and none needs
write credentials. That is the trifecta doing the selecting.

1. **Documentation lookup** — a remote index of current library docs. The shell cannot
   fetch what you cannot name. Typically 1–3 tools: tiny listing, high value.
2. **Persistent browser control (Playwright-class)** — a live session with DOM, console
   and network across calls. `curl` is stateless by construction. This is the instrument
   that closes "does the UI actually work".
3. **Web search** — a remote index.
4. **Read-only hosted-OAuth issue tracking** — authenticated access *without* a
   long-lived token in the environment. Strictly read-only, given the injection record.
5. **Read-only structured SQL introspection** — the server-enforced read-only mode is the
   value; query execution is not (`psql -c` exists).

**Rejected as wrappers**: git, filesystem, terminal, fetch, Docker MCP — and, on balance,
**GitHub MCP**, because `gh api` reaches every endpoint at zero tool-listing cost and the
private-repo exfiltration finding is unfixable in the server.

### Non-negotiable before adding any MCP server

1. **Trifecta audit for that specific agent.** If the server completes the set, split the
   agent instead of adding it.
2. **Pin the version, verify the hash, read the diff on upgrade.** No `@latest`, no
   `npx -y`. This alone defeats `postmark-mcp` and `mcp-remote ≤0.1.15`.
3. **Least-privilege credentials, never RLS/ACL-bypassing ones.**
4. **Explicit tool allowlist**, not server-level enable, plus client-enforced approval on
   every write tool.
5. **Sandbox and constrain egress** — block RFC1918 and `169.254.0.0/16`. Do not trust the
   server's own path validation.
6. **Snapshot and diff `tools/list`.** The rug pull has *no* protocol mitigation —
   approval is not bound to a schema hash. This control you must build yourself.

---

## 7. Evaluation and self-improvement (§09, §18, §24)

### Flip-centered gating is an established pattern, not a home-brew

**The metric has a published name: Negative Flip Rate.**
[arXiv:2011.09161](https://arxiv.org/abs/2011.09161) *Positive-Congruent Training*
(Amazon, CVPR 2021) defines a negative flip as a sample the new model gets wrong that the
reference got right, and proves the result that justifies the whole design: **reducing
aggregate error rate is neither necessary nor sufficient to reduce NFR.** An update can
improve the average while breaking specific previously-working cases. Aggregate gating
cannot see that; per-example flip gating can.

Reinforced by [arXiv:2411.00640](https://arxiv.org/abs/2411.00640) *Adding Error Bars to
Evals* (Miller, Anthropic), which recommends **analysing paired differences on identical
items** rather than comparing two independent means — which is exactly what per-probe
comparison against a stored baseline is. And Anthropic's own eval guidance separates
*capability* evals (low pass rate, measure headroom) from *regression* evals (near-100%,
protect against backsliding), with capability evals **graduating** into the regression
suite once saturated.

So: the architecture is right, and it is the same primitive that shipped in production
model-update pipelines five years ago.

### The critique I tested rather than accepted

The stream's headline criticism was that n=1 per probe cannot distinguish a regression
from a flake, and that with 19 probes at a 5% flake rate the family-wise spurious-block
probability is **1 − 0.95¹⁹ ≈ 62%** — a gate that false-alarms two runs in three gets
routed around by its owner within a month.

**That reasoning is correct and does not apply here.** It assumes stochastic probes. I ran
`evaluate` five times: 19/19 every time, and the per-probe result lines were
**byte-identical** across three runs (same md5). Measured flake rate is **0**, so the
binomial argument collapses and n=1 is the correct sample size.

This is worth stating precisely because it is *why* routing is model-free. The moment any
probe involves a model call, the 62% figure becomes real and replication becomes
mandatory. The determinism is not an accident to be improved away — it is the property
that makes single-trial gating sound.

### The critiques that survive, and they are the valuable ones

| # | Critique | Verdict |
|---|---|---|
| 1 | **Probes are visible to the optimiser → Goodhart** | **VALID.** [arXiv:2606.28430](https://arxiv.org/abs/2606.28430) *Building to the Test* — with the oracle in the loop, agents drove scores to near-perfect while shipping code "dead or absent" outside the tested behaviour. GEPA holds out a validation set the mutator never sees; `learn` does not. |
| 2 | **No capacity cap** | **VALID.** [arXiv:2510.04399](https://arxiv.org/abs/2510.04399) (TMLR 2026) proves PAC learnability survives self-modification *iff* the reachable family stays capacity-bounded, and proposes a **Two-Gate guardrail: validation-improvement AND a capacity cap.** JARVIS has gate one only. Nothing bounds how much a single approved proposal may change. |
| 3 | **Proposals carry no evidence metadata** | **VALID.** `hints.yaml` states the pattern; it does not state n, distinct sessions, effect size, or which probes validated it. A human moving a file by hand is a *safety* gate, not an *evidence* gate — and the loop can p-hack through a human as easily as around one. |
| 4 | **No rollback record** | **VALID.** Every credible system keeps an archive and can revert (DGM's archive, AlphaEvolve's population). "A human moved the file" is not a revertible transaction. |
| 5 | **No capability suite feeding the regression suite** | **VALID.** 19 probes with no growth mechanism. Anthropic's 20–50 is a floor for an *immature* system, justified by large early effect sizes. |

### The minimum evidence bar (§the question I most wanted answered)

**Nobody has published one, and the statistics to stop guessing is off-the-shelf.** No
sample-size table exists for agent-behaviour pattern inference, because the answer is
irreducibly instance-specific — a function of measured per-item variance and tolerable
false-commit rate, neither of which anyone else can supply.

The most on-point work is [arXiv:2606.08106](https://arxiv.org/abs/2606.08106) *PACE*,
whose framing states the problem better than I could: *"Applied hundreds of times against
the same noisy dev estimate, the ubiquitous 'keep it if the score went up' rule is
uncontrolled adaptive multiple testing: the agent effectively p-hacks itself."* Its
mechanism is anytime-valid sequential paired testing with a false-commit budget. **Caveat
travelling with it: single-author June-2026 preprint, unreviewed — take the mechanism, not
the authority.**

`MIN_RUNS = 5` turns out to be defensible but arbitrary: the honest justification is
arithmetic, not citation. One observation of a 20%-base-rate behaviour is
indistinguishable from noise.

### LLM-as-judge — and why keeping it out of the gate was right

Deterministic graders on discrete routing decisions is **Anthropic's stated best practice**
and the single most common mistake in this space is not following it. The evidence against
judges in a gate:

- Position bias survives every prompt-level mitigation
  ([2306.05685](https://arxiv.org/abs/2306.05685),
  [2406.07791](https://arxiv.org/abs/2406.07791)). Swapping order and requiring a win in
  *both* is the only mitigation that replicates.
- **A judge's score is a *biased* estimator of true accuracy** — over-estimating at low
  accuracy, under-estimating at high ([2511.21140](https://arxiv.org/abs/2511.21140)).
  The bias is largest at the extremes, which is exactly where a ~100%-pass regression
  suite lives.
- Judges of **trajectories** systematically over-credit success
  ([2504.08942](https://arxiv.org/abs/2504.08942)).
- Judge error above ~0.2 destroys routing-cascade performance
  ([2403.12031](https://arxiv.org/abs/2403.12031)).

**Do not gate on tool sequences either.** Anthropic warns this produces brittle tests that
punish valid alternative approaches. Record the trajectory; gate on the outcome.

### Public benchmarks are not usable as a private regression suite

SWE-bench Verified is contaminated and grader-flawed:
[2410.06992](https://arxiv.org/abs/2410.06992) found solution leakage and weak-test false
positives; [2506.12286](https://arxiv.org/abs/2506.12286) shows models recall in-benchmark
repo paths far better than external ones (memorisation, not reasoning);
[2507.02825](https://arxiv.org/abs/2507.02825) (NeurIPS 2025) reports insufficient test
cases and errors "up to 100% in relative terms." Example-level flips on it are therefore
untrustworthy at exactly the granularity a gate needs. And none of it tests *this*
routing.

Worth taking instead: **Harbor** (Terminal-Bench 2.0's containerised any-agent harness) as
a runner for JARVIS's own tasks; the **SWE-bench-Live / SWE-rebench pattern** of
continuously mining fresh tasks so the suite cannot be memorised; and the **ABC checklist**
from 2507.02825 — Task Validity ("solvable iff the agent has the target capability") is the
criterion most home-grown probes fail.

### Observability — the field list that makes later analysis possible

Base on **OpenTelemetry GenAI semantic conventions** (`create_agent`, `invoke_agent`,
`execute_tool` spans). **Caveat from the spec: nearly every `gen_ai.*` attribute is marked
"Development" stability — only `error.type`, `server.address`, `server.port` are Stable.**

The one field JARVIS's ledger most needs and does not have: **`config_version`** — a
content hash of the routing table, prompts and skill set in force. Without it a flip is
observed but not attributable. Alongside `probe_id`, `trial_index`, `flip_vs_baseline` ∈
{PP, PF, FP, FF}, and per-proposal `evidence_count` / `distinct_sessions`.

---

## 7b. Coding agents (§02) — and the finding that reframes the mission

**Two of the four flagship architectures have been repudiated by their own authors.** I
verified every claim below myself with authenticated `gh api` calls, because it is load
bearing.

| Repo | Stars | Archived | Last push | Language |
|---|---|---|---|---|
| `OpenHands/OpenHands` | 84,651 | no | 2026-08-21 | **TypeScript** |
| `OpenHands/software-agent-sdk` | 1,012 | no | 2026-08-21 | Python |
| `OpenHands/openhands-aci` | 135 | **yes** | 2026-04-16 | Python |
| `SWE-agent/SWE-agent` | 20,093 | no | 2026-08-17 | Python |
| `SWE-agent/mini-swe-agent` | 6,648 | no | 2026-08-17 | Python |
| `Aider-AI/aider` | 48,368 | no | **2026-05-22** | Python |
| `RooCodeInc/Roo-Code` | 24,332 | **yes** | 2026-05-15 | TypeScript |
| `cline/cline` | 66,566 | no | 2026-08-21 | TypeScript |

**OpenHands pivoted from being an agent to being a control plane over other people's
agents.** Its root directory now contains `electron/`, `src/`, `vite.config.ts`,
`package.json` — and **no Python package and no `pyproject.toml`**. The agent core moved
to a separate SDK; the agent-computer interface repo is archived. Anyone citing "OpenHands
architecture" from a pre-2026 post is describing a codebase that no longer exists at that
path.

**SWE-agent's own authors shipped a system that deletes the ACI and scores higher.**
`mini-swe-agent`'s README: *"as LMs have become more capable, a lot of this is not needed
at all."* No tools but bash, no tool-calling API, completely linear history, no persistent
shell — and a claimed **>74% on SWE-bench Verified**. The same retraction appears inside
SWE-agent's own source: the docstring for the elision mechanism its paper credits with
+3.0 points now reads *"most SotA models can now fit a lot of context, so generally this
history processor is not always needed anymore."*

**Aider is a stable reference, not a moving target** — last push 2026-05-22, and its last
three commits are all expanding a model-name list.

**The transferable conclusion, and it is the most important sentence in this document:**
scaffold complexity that paid in 2024 has been partly absorbed by the models. Every
architectural idea must be judged on whether it encodes **engineering discipline the model
still lacks** (verification, budget, rollback, risk gating) or **cognitive crutches it no
longer needs** (windowed file viewers, aggressive history elision). JARVIS is almost
entirely the former, which is the right side of that line.

### The five patterns worth absorbing

**1. Put the validity check inside the write tool and refuse the action.** SWE-agent's
editor runs `flake8 --select=F821,F822,F831,E111,E112,E113,E999,E902` and **will not apply
an edit that fails**. Measured: edit+linting 18.0%, edit without linting 15.0%, no edit
command 10.3% — and **23.4% of all failures were "cascading failed edits."** The rejection
message shows the error, the proposed edit, *and* the original code. Generalised: for every
write-capable tool, ask what cheap check would make the invalid call impossible.

**2. Nudge at the threshold, terminate one repeat past it.** OpenHands' stuck detector runs
five patterns — same-action-same-observation ×4, same-action-error streak >3, monologue,
**alternating A,B,A,B** (which a naive "same action twice" check misses entirely), and a
context-window loop check that is `return False` with a TODO. Two details matter more than
the patterns: equality is computed on **id-stripped semantic content** (`tool_call_id`,
`action_id` explicitly ignored, "as they vary") — loop detection is impossible without it;
and the response at threshold is a *quoted, targeted nudge* before termination, guarded so
it fires once per streak. Add mini-swe-agent's `n_consecutive_format_errors` reset-on-any-
success counter as the cheap floor — four lines, and it cannot false-positive on a
legitimately repetitive-but-progressing run.

**3. Compaction as a first-class, budgeted, guarded event.** OpenHands' condenser:
typed trigger reasons (`REQUEST`/`TOKENS`/`EVENTS`) so compaction is *nameable* and
loggable; a `View` distinct from the event store so history is never destructively
mutated; `keep_first: 2` pinning the task statement; a `hard_context_reset` ladder at 0.8×
scaling when summarisation itself fails; and the guard worth stealing outright —
**`minimum_progress = 0.1`: a compaction that would forget less than 10% of the view is
treated as an error, not a no-op.** That is the defence against the compaction death
spiral. Plus SWE-agent's `polling` parameter, which *quantises* compaction so the cached
prefix survives several turns — the only prompt-cache-aware compaction design I saw.

**4. Best-of-N with a calibrated correctness-predicting judge.** SWE-agent's `RetryAgent`:
reset the environment between attempts, **vary the agent config per attempt**, rewrite the
sub-agent's cost limit to the *remaining* budget, calibrate the judge
(`failure_score_penalty`, declared `score_range`), and record `best_attempt_idx` in the
trajectory so the selection is auditable. `ChooserRetryLoop` uses a
**preselect→choose funnel** because a single judge over many long trajectories is
unreliable — which is the same finding the evaluation stream reached from the bias
literature.

**And the cheapest idea in the entire research:** OpenHands' `empty_patch` critic.
**"The agent said done and produced no diff" is a deterministic, zero-LLM-cost
false-completion detector.** JARVIS's loop driver checks status, evidence shape and
protocol compliance — it does not check that a SUCCESS produced any change at all.

**5. Conversation-personalized PageRank over a def/ref graph, fitted to a token budget.**
Aider's `repomap.py`, and the mechanism is far more specific than its docs admit:
tree-sitter `.scm` queries classify captures as `def` or `ref`, with a **Pygments token
fallback** for languages whose grammar lacks reference queries; a `networkx.MultiDiGraph`
with files as nodes; then `nx.pagerank(..., personalization=...)` where files already in
the chat get a **50× boost** and mentioned identifiers get additive boosts; then a **binary
search over the number of tags** to fit `max_map_tokens` within 15%. Relevance is defined
*relative to the current conversation* and propagated along real dependency edges.

**The honest caveat for this bench**, which the stream stated and I endorse: a tree-sitter
def/ref graph sees only a fraction of the real edges in a Frappe codebase, where much of
the dependency graph lives in DocType JSON, fixtures, hooks and database rows. The
*technique* transfers; the extractor must be rewritten per domain. That is also the honest
limit on the Graphify adapter already shipped.

Two runners-up: **risk-graded confirmation with fail-closed unknowns** —
`ConfirmRisky(HIGH)` where `SecurityRisk.UNKNOWN` returns confirm, with shell commands
parsed as an **AST** rather than regexed; and **orthogonal rewind** (Cline's shadow git,
separate from the project's own history, snapshot after each tool use, with *Restore
Files* / *Restore Task Only* / *both* as distinct operations — because "the code is right
but the conversation derailed" and the reverse are both common, and one linear undo serves
neither). Plus SWE-agent's `attempt_autosubmission_after_error`: on an internal crash,
submit the partial work rather than returning nothing.

### The three worth rejecting

1. **Model-tuned context crutches** — fixed-N file windows, aggressive last-N elision.
   Their optimal constants are hyperparameters on the *model*, not the problem; they
   destroy prompt caching; and the authors who published them have withdrawn them.
2. **A reflection cap that stops silently.** Aider's `max_reflections = 3` warns and
   `break`s with no structured account of why and no escalation. Contrast SWE-agent's typed
   exit vocabulary (`_ExitForfeit`, `_TotalExecutionTimeExceeded`, `RepeatedFormatError`).
   A capped retry that terminates into ambiguity is worse than one that terminates into a
   named failure state.
3. **Heavyweight per-session runtimes and monolithic scaffolds.** Two of four flagships
   shrank or decomposed within a year. Bet on thin swappable execution and on
   orchestration *policy* — budgets, gates, verification, rollback — which is the layer
   that actually held its value.

---

One relevant fragment arrived via the multi-agent stream:
[arXiv:2503.13657](https://arxiv.org/abs/2503.13657) *Why Do Multi-Agent LLM Systems
Fail?* — the MAST taxonomy, 1600+ annotated traces across 7 frameworks, 14 failure modes
in three categories (system design, inter-agent misalignment, task verification), κ=0.88.
**That paper should be read before any further architecture change.**

---

## 8. Gap analysis and prioritised backlog (§17, §22)

| P | Gap | Proposed fix | Effort | Risk | Confidence |
|---|---|---|---|---|---|
| **P0** | W1 skills asked in prose | emit `skills:` frontmatter from the registry | XS | low | **high** — documented field |
| **P0** | W8 no trifecta audit | classify each agent's legs; forbid completing the set | S | low | **high** |
| **P0** | W2 same-model critique | require every verdict to cite external evidence | S | low | **high** — 2310.01798 |
| **P1** | W3 unattributable ledger | fix agent attribution before building on the data | S | low | high |
| **P1** | W7 memory cannot be corrected | keyed supersession + tombstones | M | low | high |
| **P1** | W6 write collisions | per-key merge rule; undeclared concurrent write = error | M | med | high |
| **P2** | W5 effort declared not measured | decompose-on-failure escalation | M | med | med |
| **P2** | W4 no performance routing | skill-conditional tiebreak *inside* rule-permitted set | L | **high** | med |
| **P1** | Probes visible to `learn` → Goodhart | hold out a probe set the proposal generator never sees | S | low | **high** |
| **P1** | No capacity cap on a proposal | bound what one approved proposal may change; never the gate itself | S | low | **high** |
| **P1** | Proposals carry no evidence | record n, distinct sessions, validating probes in `hints.yaml` | S | low | **high** |
| **P0** | Loop driver accepts SUCCESS with no diff | `empty_patch`-style check: claimed done + zero change = refuse | XS | low | **high** |
| **P1** | No stuck/loop detection | id-stripped equality + alternating-pattern check + nudge-then-terminate | M | low | high |
| **P2** | No `config_version` in the ledger | hash routing+prompts+skills per row, so a flip is attributable | S | low | high |
| **P2** | No capability suite | low-pass-rate probes that graduate into the regression set | M | low | med |
| **P3** | Agent-team peer channel | evaluate against current coordinator-mediated model | L | med | low |

### The P2 warning that must travel with W4

[arXiv:2606.14200](https://arxiv.org/abs/2606.14200) — *When Should Agent Trust Be
Conditional?* A single global trust score per agent is **the wrong object**: routing
everything to the globally-most-trusted agent forfeits specialisation. Skill-conditional
trust wins only under high heterogeneity and sparse per-skill evidence — and the
cross-skill borrowing coefficient that buys data efficiency is **dual-use: a laundering
channel**. An attacker with cheap evidence in one skill and none in the target drove
routing regret from 0 to 0.94 on a pool their own gating test rated GREEN.

So if performance routing is ever built: per-task-kind, zero cross-skill borrowing, and
**as a tiebreak among agents the static rules already permit — never as an override.**
The rules stay the safety floor.

---

## 9. What JARVIS should NOT absorb

1. **Multi-agent debate as a quality mechanism.**
   [2502.08788](https://arxiv.org/abs/2502.08788) finds the gains largely evaporate under
   fair evaluation; heterogeneity, not headcount, is what helps.
   [2403.02419](https://arxiv.org/abs/2403.02419) shows returns turn *negative*. For a
   registry swarm it is worse than average: you would pay a committee to re-derive what
   the routing table already encodes. Get heterogeneity by running one reviewer on a
   different model tier.
2. **LLM-as-router replacing static rules.** The field's default because frameworks cannot
   see your topology — you can. The rules encode real invariants a router LLM will
   silently violate under paraphrase, and it converts an auditable decision into an
   unreproducible one.
3. **Shared-mutable-blackboard coordination.** Unsynchronised concurrent mutation with no
   verifiable locking in either Letta or ADK. Note Cognition's prescription is *share
   full traces* — append-only and attributable — which is the opposite of a mutable
   scratchpad.
4. **A decay function as primary memory hygiene.** Buries exactly the rare old gotchas
   worth keeping.
5. **Vector memory.** Would not solve the stated problem and makes accumulation worse.
6. **Wrapper MCP servers** for tools that already have a CLI.
7. **Registry presence or star counts as any kind of signal.**

---

## 10. Roadmap (§23)

**Phase 0 — baseline.** Done; §2 above. The one prerequisite still missing is W3: agent
attribution in the ledger. Everything measured is measured over 11 rows, 9 of them
unattributable.

**Phase 1 — quick wins.** `skills:` frontmatter (W1). Trifecta audit per agent (W8).
Evidence-citing review verdicts (W2). All three are additive, all three are testable, none
needs new machinery.

**Phase 2 — memory correction.** Keyed supersession with tombstones; the MANAGE stage on a
step-count trigger; promotion gated on `unverified=0`.

**Phase 3 — write admission.** Per-key merge rules; undeclared concurrent write becomes an
error rather than a scheduling avoidance.

**Phase 4 — measured effort.** Decompose-on-failure, turning effort mode from a declared
input into an observed escalation.

**Phase 5 — performance routing, behind the 2606.14200 constraints.** Only after the
ledger has attributable rows in useful numbers. This is the phase most likely to be
correctly abandoned.

**Verification for every phase:** `doctor` + `health` + 19 probes with no P→F flip + the
full suites + a planted-violation check for any new enforcement.

---

## 11. Open questions

1. ~~ADK `ParallelAgent` write enforcement~~ — **ANSWERED: none, and the primitive is
   deprecated.** Source-confirmed; the docs tell you to add your own locks.
2. ~~Letta locking~~ — **ANSWERED, and my prior was wrong: optimistic locking with a
   distinct `ConcurrentUpdateError` / HTTP 409.** Detection without resolution.
3. The complete Claude Code hook event list ("30+" per the docs, not enumerated on the
   fetched page).
4. Is flip-centered gating established practice? **Stream did not return.**
5. What is the minimum evidence bar before acting on an observed pattern? Possibly nobody
   has published one.

---

## 12. Self-critique (§26)

**Where this research is weak, stated plainly.**

- **All six streams returned**, but several arrived partial: four doc-verification
  subagents under the multi-agent stream never reported, so parts of §4 are strong priors
  rather than fresh citations, and the coding-agent stream hit a concurrency limit and
  covered six systems rather than nine.
- **Perplexity was unavailable**, so Tier-1 discovery was narrower than §12 specified.
- **Several framework teardowns are `KNOWN, NOT REFETCHED`** — strong priors, not
  citations. The four doc-verification subagents that would have upgraded them did not
  report.
- **One paper I nearly over-weighted**: SCF ([2604.16339](https://arxiv.org/abs/2604.16339))
  reports 100% workflow completion against 25.1% next-best — but it is single-author,
  self-evaluated, and detects only 65.2% of conflicts at 27.9% precision. Take the design
  (authority-ordered arbitration), not the numbers. Flagged because that is exactly the
  kind of result that gets quoted without its caveats.
- **I have not verified the claims in this document against JARVIS behaviour end to end.**
  The measured baseline is real; the *proposed* fixes are unbuilt and untested.
- **What a world-class architect would criticise**: that the P0 items are cheap and the
  expensive items are the ones the research says are genuinely open — so the roadmap risks
  looking productive while the hard problem (W4) stays parked. That criticism is correct.
  The defence is that W4 without W3 would be built on 82% unattributable data, and the
  literature's own warning about laundering channels makes premature performance routing
  actively unsafe rather than merely useless.

---

## 13. Verified vs unverified

**VERIFIED — 16 of 16 arXiv IDs independently re-checked by me** against the arXiv API,
titles matching, fake control correctly rejected: 2606.14200, 2311.05772, 2310.01798,
2503.13657, 2607.00041, 2604.23626, 2502.08788, 2403.02419, 2411.04468, 2305.11738,
2606.15903, 2606.24775, 2607.08032, 2603.11768, 2310.08560, 2402.01030.

**VERIFIED from primary sources:** the Claude Code subagent inheritance list, agent-teams
comparison, MCP spec `2026-07-28` statelessness, the MCP tools and security-best-practices
pages, the registry's own delegation of security scanning, Invariant Labs tool poisoning
and GitHub MCP exfiltration, Willison's lethal trifecta, OWASP MCP Top 10 (v0.1 Beta),
Letta MemFS and memory blocks, Anthropic's memory tool command surface, mem0's documented
additive-only model, Graphiti's temporal invalidation as a mechanism.

**UNVERIFIED — do not cite without checking:** Graphiti's exact bi-temporal field names ·
mem0's ADD/UPDATE/DELETE/NOOP loop (the docs I have describe additive-only) · all
Part-1 MCP tool counts · `CVE-2026-44430` details (advisory DB only) · the MITRE ATLAS ID
for the Cato case · tool-annotation field defaults · Generative Agents' decay constant ·
EnterpriseRAG-Bench's BM25-vs-vector figures · repo-state staleness validation for
memories (**no source found — that design is my own, untested**).

**Corrected during research:** subagents *do* inherit CLAUDE.md and MCP servers · they
*can* preload and invoke skills · they run *concurrently*, contrary to one stream's report
· my own arXiv checker failed closed and nearly produced a false fabrication finding.

---

## 14. Coding agents, the second pass — and what the field deleted

### The repudiation tally is now five

| Project | Status |
|---|---|
| **OpenHands** | Pivoted to TypeScript control plane; `openhands-aci` **archived** |
| **Roo Code** | **Archived** 2026-05-15 |
| **Letta** | OSS server source **removed from `main`** 2026-08-16 |
| **Continue** | **Dead** — read-only, final v2.0.0, acqui-hired by Cursor |
| **Amazon Q Developer CLI** | **Superseded** by closed-source Kiro CLI, security fixes only |
| **AutoCodeRover** | **Acquired by Sonar**; licence swapped to source-available non-compete; successor closed |
| **Agentless** | Frozen 2024-12-22; authors moved to an *agent* |
| **Trae-agent** | Maintainership stalled — 26 merged PRs Sept 2025 → 1 in Feb 2026 → none since; **64 open**; README still claims active development |
| **Goose** | **Donated**, not repudiated — moved to the Agentic AI Foundation (Linux Foundation) |

**Metadata trap worth internalising:** `pushed_at` lies. Continue reports `pushed_at:
2026-08-20` while its last `main` commit is 2026-07-21 and the repo is read-only. Check
`default_branch`, last-commit-on-main, and **merged-PR cadence**.

### Agentless, and the statistic that should govern every verification design

Its own published number, about its own best mechanism: of 300 generated reproduction
tests, **213 reproduced the issue but only 94 correctly verified a fix — 31.0%.** A
generated test is roughly a coin flip *conditioned on it already reproducing.*

Its selection ablation is the other essential table:

| Stage | Fixes on Lite | Δ cost |
|---|---|---|
| Majority voting only | 77 (25.67%) | — |
| + regression tests | 81 (27.00%) | +$0.01 |
| **+ reproduction tests** | **96 (32.00%)** | **+$0.25** |
| Oracle over all 40 samples | 126 (42.0%) | — |

**Every point of Agentless's advantage over plain sampling came from running code.** And
the sampling curve is brutal: 1 sample → 80 fixes, 40 samples → 96, oracle → 126. You pay
40× for 16 fixes, because *selection*, not generation, is the bottleneck.

One more finding that inverts intuition: the **skeleton** representation (function bodies
replaced by a placeholder) beat whole files on ground-truth coverage — **58.33% vs
53.67% at $0.02 vs $0.15**. Compression was 7.5× cheaper *and* more accurate. Truncation
is not a tax; at the right altitude it removes distractors.

### The best single prompt found in the entire research

AutoCodeRover's reviewer (`app/agents/agent_reviewer.py`):

> *"Engineer A has written a reproduction test for the issue. Engineer B has written a
> patch for the issue. Your task is to decide whether the created patch resolves the issue.
> **NOTE: both the test and the patch may be wrong.**"*

It returns **two independent verdicts with two independent pieces of advice**
(`patch_decision`/`patch_analysis`/`patch_advice`, `test_decision`/`test_analysis`/
`test_advice`), and the extractor **rejects a `NO` that arrives without advice.**

That is the correct structural answer to false-done, and it follows directly from the 31%
statistic: **a green test is two claims** — the patch works, *and* the test measures the
right thing. Every other system conflates them.

### Six answers to "model an unfamiliar codebase", and the field's verdict

| System | Representation | Persistence | Language reach |
|---|---|---|---|
| Agentless | `tree` → libcst skeleton → raw code | none | **Python only** |
| AutoCodeRover | 4 Python-`ast` indices, inheritance-resolving | in-memory, `@cache`d, never invalidated | Python only |
| moatless | tree-sitter block tree + Voyage vectors | pre-built stores | Python-centric |
| RepoGraph | **name-keyed** def/ref graph | pickle | Python only |
| Trae "CKG" | SQLite `functions`+`classes`, **no edge table** | **snapshot-hash keyed, with eviction** | 6 languages |
| Goose `analyze` | tree-sitter AST + bounded BFS | **none — rebuilt every call** | 10 languages |
| **Zed** | **the language server** | LSP's own | anything with an LSP |
| Codex / gemini-cli / opencode | none | none | all |

**Two teams built the best index in the field and dismantled it, both in September 2025.**
Zed deleted `semantic_index` (PR #37780, titled *"Remove unused"*); Continue deprecated
`@Codebase` after two years of LanceDB + FTS5 + tree-sitter with cross-branch artifact
sharing. **Every production CLI now ships zero embedding index for its agent.**

And the graphs mostly are not graphs. RepoGraph keys nodes on **bare identifiers** and
creates edges by **name-equality cross-join** with no scope or import resolution — every
`run`/`get`/`build` collapses into one node — and its parser is preceded by source
rewriting (`code.replace("print ", "yield ")`) to force Python 2 files through. Goose's
`resolve_callee` has the identical bare-name flaw. Trae's "Code Knowledge Graph" has no
edges at all. Payoff for the whole category: **+2 to +2.7 points**, Python-only.

**This is the most direct finding against the Graphify integration shipped earlier.** The
adapter is honest about staleness and relation coverage, and it is still structural
machinery whose measured value elsewhere is +2 points. The two credible alternatives that
*survived* are not indexes: **ask the language server**, or **spend context instead of
building infrastructure**.

### Not one of the six production CLIs gates on tests

Codex, gemini-cli, opencode, Continue, Zed, Amazon Q — none has a default
"run the tests before finishing." *"Did the change actually work"* is the field's largest
unautomated gap, and it is the gap JARVIS's loop driver was built to close.

---

## 15. Final scorecard against §26's self-critique

| Question | Honest answer |
|---|---|
| Researched deeply enough? | Six streams, ~800k subagent tokens, 40+ primary sources. Yes. |
| Relied on stars? | No — and stars actively misled: the 84k-star repo had pivoted, the 24k-star repo was archived. |
| Inspected primary sources? | Yes, including source files by path. |
| Patterns rather than products? | Yes — and five of the products studied are dead. |
| Distinguished hype from evidence? | Yes: "code knowledge graph" = two SQLite tables with no edges. |
| Identified what NOT to adopt? | Ten items, with reasons. |
| Accounted for Claude Code's real architecture? | Yes, and it corrected three of my assumptions. |
| Solved context isolation? | **No.** Identified the `skills:` preload fix; not built. |
| Solved agent coordination? | **No.** Found that nobody has. |
| Solved memory? | **No.** Designed keyed supersession; not built. |
| Solved evaluation? | **Partly.** Confirmed flip-gating is sound, found five real weaknesses. |
| Solved self-improvement safely? | **Partly.** The inert-proposal shape is right; capacity cap and held-out set are missing. |
| Solved observability? | **No.** Have a field list; `config_version` absent. |
| Solved security? | **No.** Trifecta audit designed, not built. |
| Established a benchmark? | **No — and this is the honest failure.** Tier 0 exists. Tiers 1 and 2 do not. |
| Preserved existing strengths? | Yes. §28 honoured; nothing modified. |
| Avoided unnecessary complexity? | **This is the open question.** See below. |

### What a world-class architect would criticise, and I now agree with

**That 46 role-based agents is unvalidated, and the evidence points the other way.**

- Magentic-One reached SOTA-competitive with **five** agents, and its measured 31% came
  from **ledgers**, not headcount.
- Microsoft argues explicitly *against* role-based decomposition: *"role-based patterns may
  require multiple agents to have redundant capabilities."*
- Anthropic, against their own commercial interest: *"most coding tasks involve fewer truly
  parallelizable tasks than research."*
- The SOTA open scaffold is **100 lines plus YAML**.
- Multi-agent costs **~15× a chat**, and *"token usage by itself explains 80% of the
  variance."*

The defensible core is small: **parallel read-only fan-out**, **model tiering**, **human
gates on irreversible actions**, and **a registry that removes routing ambiguity**. On
that last point the definitively-say test found a real failure — `jarvis-deep`'s
distinguishing condition is *"when the work needs no mid-flight human decision"*, a
property of the future, not of the request.

And `doctor`'s duplicate check compares normalised `owns` strings for **exact equality** —
it would catch a copy-paste and nothing else. My own audit was weaker than the criticism
of it.

**The conclusion I did not expect to write:** the highest-value next move is probably not
to add anything. It is to (a) fix the P0 refusals, which are all cheap, (b) build Tier 1
of the benchmark so outcome claims become possible at all, and then (c) **test whether the
roster should shrink.** Every piece of external evidence says ledgers beat headcount.
Nothing in this research supports 46.
