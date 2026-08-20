/**
 * Swarm tooling — generate agent definitions, and audit the roster.
 *
 *   jarvis.mjs agents [--apply]   generate agents/*.md from registry/agents.yaml
 *   swarm doctor                   audit the roster (agent-guardian's job, §6)
 *   swarm show <agent>             print one agent's resolved definition
 *
 * agents/*.md are GENERATED. registry/agents.yaml is the single source of truth
 * (§DRY, §19) — a skill is reusable expertise, an agent is an execution identity
 * that consumes skills, and neither is copied into the other.
 *
 * Does NOT import jarvis.mjs — that module dynamically imports this one, and
 * a static import back would deadlock on an unsettled top-level await. Helpers
 * arrive through opts.
 */

import fs from 'node:fs';
import path from 'node:path';
import { HALT_CONDITIONS } from './loop.mjs';
import os from 'node:os';
import * as graphModule from './graph.mjs';

const ACTIVE = 'active';
const PASSIVE = 'passive';
const VALIDATION = 'validation';
const CONTROL = 'control';
const MODES = [ACTIVE, VALIDATION, PASSIVE, CONTROL];
const TIERS = ['haiku', 'sonnet', 'opus', 'inherit'];

/** Resolve the agent set with defaults applied. */
export function loadAgents({ root, readYaml }) {
  const spec = readYaml(path.join(root, 'registry', 'agents.yaml'));
  const d = spec.defaults || {};
  const agents = Object.entries(spec.agents || {}).map(([id, a]) => ({
    id,
    role: a.role || '',
    mode: a.mode || ACTIVE,
    model: a.model || d.model || 'inherit',
    tools: a.tools || d.tools || [],
    skills: a.skills || [],
    owns: (a.owns || '').trim(),
    constraints: (a.constraints || '').trim(),
    governance: (a.governance || '').trim(),
    produces: a.produces || [],
    checks: a.checks || [],
    requires: a.requires || [],
    conflicts_with: a.conflicts_with || [],
    conflict_rule: (a.conflict_rule || '').trim(),
    escalates_to: a.escalates_to || 'JARVIS',
    // How this agent gets picked. `skill` = matched via the skills it declares.
    // `jarvis` = dispatched explicitly by a coordinator. Coordinators and
    // generalists legitimately declare no skills; that is not unreachability.
    selected_by: a.selected_by || (a.skills && a.skills.length ? 'skill' : 'jarvis'),
    uses_design_system: a.uses_design_system === true,
    // Frappe safety + safe_exec are emitted by default; an agent whose subject is
    // the swarm or the repo opts out. That boilerplate is ~1.1KB re-read on every
    // single dispatch, and in a git or governance agent it is answering a question
    // nobody asked.
    frappe: a.frappe === undefined ? (d.frappe === undefined ? true : d.frappe !== false) : a.frappe !== false,
    runs: a.runs || null,
    handoff: a.handoff || (spec.protocol && spec.protocol.required) || ['summary', 'handoff'],
    // The scope this agent may write to. Two agents sharing a scope may touch the same
    // files, so `plan` refuses to put them in one parallel batch. A reader has none.
    writes: a.writes || null,
  }));
  return {
    agents,
    protocol: spec.protocol || {},
    gates: spec.human_approval_required || [],
    resources: spec.resources || {},
    version: spec.version ?? 1,
    reviewLoop: spec.review_loop || {},
    reconciliation: spec.conflict_reconciliation || {},
  };
}

/* ------------------------------------------------------- agent generation */
function designSystemSection(res) {
  const ds = res.design_system;
  if (!ds) return '';
  const paths = (ds.search || []).map((p) => `  ${p}`).join('\n');
  return `
## Design system — consult before you design anything

Every visual and interaction decision is checked against the design system. It is not
a reference you may skip because you have an opinion; where it and your preference
disagree, **the design system wins**.

Resolve its location in this order — first hit wins:

\`\`\`
  $${ds.env}          (environment variable, if set)
${paths}
\`\`\`

Then read \`${ds.entry}\` first, and follow it to the primary file under \`project/\`
and every file that one imports.

${ds.usage}

If you cannot find it, say so in \`handoff\` and proceed on documented conventions —
but flag explicitly that the work is unverified against the design system. Silently
inventing a visual language is the failure this section exists to prevent.
`;
}

/**
 * Emitted only for agents that can actually touch Frappe code (`frappe: true`).
 * A git-safety or routing-auditor agent carrying safe_exec rules is answering a
 * question it will never be asked, on every dispatch, forever.
 */
function frappeSafetySection() {
  return `
## Before you change anything (Frappe safety, §14)

Inspect before you modify. Identify the owning app, the DocType ownership, and what depends on the code you are about to touch — hooks, client scripts, server scripts, reports, permissions, migrations. A change that works in isolation and breaks a caller is not a fix.

Never duplicate functionality that already exists, never modify another app's ownership without understanding why, and never delete anything without impact analysis.

## safe_exec (Server Scripts and System Console code)

No \`import\`. No f-strings or \`.format()\` — concatenate. No \`frappe.get_roles()\` — query \`Has Role\`. No \`doc.reload()\` — re-fetch with \`get_doc\`. No module-level \`return\` — assign \`frappe.response["message"]\`. No leading-underscore names, no tuple unpacking, no \`getattr\`/\`setattr\`.

These forms are longer on purpose. Do not "simplify" them.
`;
}

function agentMarkdown(a, protocol, gates, resources) {
  const fields = protocol.fields || {};
  const handoffDoc = a.handoff.map((f) => `- **${f}** — ${fields[f] || 'see registry/agents.yaml'}`).join('\n');
  // The second tier. These were declared in the registry from the start and reached no
  // agent, because only `required` was rendered -- so `risks`, `findings` and `testing`
  // existed as documentation of a protocol nobody was told to follow. A field an agent
  // is never shown is not a protocol, it is a comment.
  const applicable = (protocol.when_applicable || []).filter((f) => !a.handoff.includes(f));
  const applicableDoc = applicable.length
    ? `\n## Also address these — write "none" rather than omitting one\n\n${applicable
        .map((f) => `- **${f}** — ${fields[f] || 'see registry/agents.yaml'}`)
        .join('\n')}\n\nNot every one applies to every turn. **Silence is not one of the options.** An\nomitted \`risks\` and a \`risks: none\` read identically to whoever picks this up, and only\none of them is a statement — so the field you have nothing for is where you write\n"none". That is a claim you are making, and it is the point: it separates "I checked and\nthere are none" from "I did not think about it", which is the distinction every field\nbelow exists to preserve.\n`
    : '';

  const frontmatter = [
    '---',
    `name: ${a.id}`,
    `description: ${a.role}. ${a.owns.replace(/\s+/g, ' ')}`,
    `tools: ${a.tools.join(', ')}`,
    `model: ${a.model}`,
    '---',
  ].join('\n');

  return `${frontmatter}

<!-- GENERATED from registry/agents.yaml by scripts/swarm.mjs. Do not hand-edit;
     edit the registry and run: node scripts/jarvis.mjs agents --apply -->

# ${a.id}

**Role.** ${a.role}.

**You own exactly this.** ${a.owns}

Work outside that sentence is not yours. If the task drifts, say so in \`handoff\` and stop — do not quietly expand scope. Another agent owns it, or nobody does and JARVIS needs to know.
${a.skills.length ? `\n**Skills to load first.** ${a.skills.map((s) => `\`${s}\``).join(' · ')}\n\nThese carry the actual expertise. Load them before reasoning about the task; do not reconstruct their content from memory.` : ''}
${a.constraints ? `\n**Constraints.**\n\n${a.constraints}\n` : ''}${a.conflict_rule ? `\n**Conflict rule.** ${a.conflict_rule}\n` : ''}${a.governance ? `\n**Governance.** ${a.governance}\n` : ''}${a.runs ? `\n**Primary command.**\n\n\`\`\`bash\n${a.runs}\n\`\`\`\n` : ''}${a.uses_design_system ? designSystemSection(resources) : ''}${a.frappe ? frappeSafetySection() : ''}
## Stop and escalate

Return the question in \`handoff\` rather than deciding, if the task would require any of:

${gates.map((g) => `- ${g}`).join('\n')}

You cannot address the user. Escalate to: **${a.escalates_to}**.

## Your handoff (required)

Never finish with "done". Return these fields:

${handoffDoc}

Structured fields, not an essay. JARVIS reads these to decide what happens next; prose it has to parse is a failure of the protocol.
${applicableDoc}
## Your first line: STATUS

Begin your handoff with one word.

\`\`\`
STATUS: SUCCESS | PARTIAL | BLOCKED | FAILED
\`\`\`

It describes the WORK, not your effort. JARVIS reads it to decide whether anything else
needs to happen, so a wrong one sends the next agent to the wrong place:

- **SUCCESS** — the objective is met and \`testing\` holds the evidence.
- **PARTIAL** — some of it is done. Say which part is not, in \`remaining\`.
- **BLOCKED** — you stopped on something outside your control. Name it in \`handoff\`.
- **FAILED** — you tried and it did not work. Say what you observed, not what you expected.

**SUCCESS on unverified work is the single most expensive thing you can write.** It ends
the loop, so nothing downstream looks again. If you did not check it, the status is
PARTIAL and the thing you did not check goes in \`unverified\`.

Three companions, and they are read by the router rather than by a person:

\`\`\`
CONFIDENCE: HIGH | MEDIUM | LOW
RECOMMENDED_NEXT_AGENT: test-engineer
UNVERIFIED: the migration path on an existing install
\`\`\`

\`CONFIDENCE\` is about the work, not about you — LOW is useful information, not an
admission. \`RECOMMENDED_NEXT_AGENT\` is a recommendation and not a dispatch: you have
just read the code and the router has not, so say what you think, and name one or say
"none". \`UNVERIFIED\` is the field a reviewer reads first; leaving it empty is a claim.

## The review loop

Work here goes round until it is good, not until it is finished. You are on one side of
that loop or the other.

**If you are reviewing** — return \`verdict: accept\` or \`verdict: revise\`.

- Judge against the **acceptance criteria**, not against how you would have done it.
  "I would have structured this differently" is not a defect.
- A \`revise\` MUST name what would satisfy you. An objection nobody can act on is not a
  review, it is an opinion, and it costs a whole round to discover that.
- One clear objection beats five speculative ones. The author gets your words verbatim.
- If it is genuinely fine, say \`accept\`. A reviewer who never accepts is a reviewer
  nobody can ship past.

**If your work is being revised** — you wrote it, so you fix it.

- You will receive the objection verbatim. Fix **that**, not your reading of the brief.
- If the objection is wrong, say so in \`handoff\` with the evidence. Do not silently
  ignore it and do not silently rewrite something else.
- If two rounds have not satisfied it, stop. Put the disagreement in \`handoff\` and let
  a human settle it. Grinding is worse than stopping.

The loop halts when every reviewer accepts, at the round cap, at any human gate, or
when the same objection comes back twice — because that last one means it is not
converging.

## When you disagree with another agent

Say so. A specialist who defers to a wrong finding because another agent got there first
has cost more than one who argues.

But disagree usefully:

- **State what would change your mind.** A position that cannot name its own falsifier is
  a preference, and preferences do not get reconciled — they get chosen between.
- **Quote them, do not characterise them.** "The architect prefers a looser boundary" is
  your reading. Their words are the evidence.
- **Argue the axes, not the author:** correctness, then safety, then reversibility, then
  cost, then ergonomics. An approach that is wrong is not rescued by being elegant, and
  seniority is not an axis.
- **Take it to \`handoff\`, not to the user.** You cannot address them; the coordinator
  reconciles, using the review loop.
- **If it is about one of the seven gates, stop.** That disagreement is not yours to
  settle and pressing on is how a gate gets crossed by accident.

A disagreement usually means the question was underspecified rather than that someone is
wrong. Saying *that* is often the most useful thing in your handoff.

## The spoken line — your LAST line, always

End your output with exactly this, on its own line:

\`\`\`
VOICE: <one clause>
\`\`\`

A speech synthesiser reads it aloud to someone who is not looking at the screen, very
often while three other sessions are running. **Write a sentence a person would say out
loud.** Not a status field, not a commit subject, not a fragment of log output — the
difference matters more than anything else on this page, because an identifier does not
survive being read aloud.

Six rules. The first is what most agents get wrong:

- **A real verb and a named subject.** Something must DO something. "Vendor Audit schema
  is in" has both; "schema done, 3 tables" has neither, and it is the single most common
  failure.
- **Length follows importance.** About six words for a routine outcome, up to twelve for
  a problem or something blocked on a human. Measured, not taste — the budget, the
  per-syllable costs and the reasoning are in the JARVIS skill, not repeated here.
- **No file paths, ever.** Name the thing, not its location. A path read aloud is one
  long nonsense word.
- **No identifiers.** No snake_case, no camelCase, no CONSTANT_CASE. "safe_exec" is heard
  as "safeexec". If you must refer to the thing, say it in words: "the safe exec guard".
- **No count without a noun.** "three child tables", never "3 tables" on its own and
  never a bare number.
- **No symbols.** No arrows, pipes, plus signs, brackets, backticks, markdown or emoji.
  They are deleted before speech, and deletion silently changes the meaning: "cladue →
  claude" became "cladue claude", which reverses the correction.

**Say what CHANGED, not what you did.** And **lead with the problem if there is one** —
that is the part worth interrupting someone for, and the reason this is spoken at all.

### Copy these

Good — each is a sentence, with a subject and a verb:

\`\`\`
VOICE: the Vendor Audit schema is in, with three child tables
VOICE: four tests are failing on the refund path
VOICE: the submit hook now fires on amend as well
\`\`\`

Bad — and exactly why:

\`\`\`
VOICE: schema done, 3 tables
        no verb, no named subject, and a count with no noun

VOICE: updated apps/exponent_utilities/hooks.py
        a file path; read aloud it is one unbroken nonsense word

VOICE: fixed safe_exec + str.format in the NSS DocType
        snake_case and a symbol; heard as "safeexec" and the plus vanishes
\`\`\`

If you changed nothing, say that plainly: \`VOICE: nothing to change in the retrofit hooks\`.

This line is not a courtesy. Without it the announcement falls back to "task complete",
which tells the listener only that time passed.

### The written line — longer, and never spoken

\`\`\`
LOG: <two or three sentences>
\`\`\`

This one goes to the daily log, which is READ and not heard. Every rule above is
about surviving a synthesiser, and none of them applies here — so this line carries
what the spoken one cannot: exact paths, identifiers, counts, and above all **why**.

\`\`\`
LOG: Added the three child tables to Vendor Audit in apps/exponent_utilities and
wired the submit hook. Chose a child table over a linked DocType because the rows
are never queried independently of the parent.
\`\`\`

The spoken clause answers "does this need me right now". This answers "what did the
swarm do today, and why" — six hours later, to someone who has forgotten. Write the
reasoning down here; it is the only place it survives.

### When you refuse: name the gate

If you stop because one of the human-approval gates is in the way, say which one, as
your last line:

\`\`\`
GATE: production deployment
\`\`\`

This is announced **immediately and above everything else** — a run that stopped for
authorisation is not a run that finished, and the person who has to authorise it is
usually not watching the screen. Use the wording from the list below **exactly**; it is
read aloud and it is the only thing that tells the listener what they are being asked to
approve.

Emit it only when you actually refused. A gate you merely noticed is not a gate you hit.

### Two more lines, when they apply

\`\`\`
PENDING: permissions matrix still needs an Auditor role
HEADS-UP: the submit hook now fires on amend as well
\`\`\`

Same rules — one clause, plain words, no paths. They are read back **at the end of the
session**, which is a different audience again: someone deciding whether they can walk
away, or picking the work up tomorrow having forgotten the detail.

- **PENDING** is work you did not finish, or that someone else must pick up. It is the
  only thing in your handoff that can still be acted on later, so it is the part read
  aloud last. An empty pending list is a good outcome, not a missing field — omit the
  line entirely rather than writing "none".
- **HEADS-UP** is a consequence somebody should know before it surprises them. A
  behaviour that changed, an assumption you had to make, a thing now wired differently.
  Not a risk register; one sentence someone would thank you for.

Omit either when it does not apply. Both are optional; \`VOICE\` is not.
`;
}

export function buildAgents({ root, readYaml, apply = false }) {
  const { agents, protocol, gates, resources } = loadAgents({ root, readYaml });
  const dir = path.join(root, 'agents');
  const written = [];
  if (apply) fs.mkdirSync(dir, { recursive: true });
  for (const a of agents) {
    const file = path.join(dir, `${a.id}.md`);
    const body = agentMarkdown(a, protocol, gates, resources);
    if (apply) fs.writeFileSync(file, body);
    written.push({ id: a.id, mode: a.mode, model: a.model, bytes: body.length });
  }

  // Remove ghosts. Renaming an agent used to leave its old file behind, and a stale
  // agent still installs and can still be dispatched — a definition nobody maintains,
  // silently in the roster. Only delete files WE generated (marker present) that the
  // registry no longer declares; anything hand-written is left alone.
  const removed = [];
  if (fs.existsSync(dir)) {
    const live = new Set(agents.map((a) => `${a.id}.md`));
    for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.md'))) {
      if (live.has(f)) continue;
      const body = fs.readFileSync(path.join(dir, f), 'utf8');
      if (!body.includes('GENERATED from registry/agents.yaml')) continue; // not ours
      if (apply) fs.rmSync(path.join(dir, f));
      removed.push(f.replace(/\.md$/, ''));
    }
  }
  return { dir, written, removed, applied: apply };
}

/* ------------------------------------------------------------- doctor (§6) */
export function doctor({ root, readYaml, registry }) {
  const { agents, protocol, gates, reviewLoop, reconciliation, resources } = loadAgents({ root, readYaml });
  const skillIds = new Set((registry.skills || []).map((s) => s.id));
  const agentIds = new Set(agents.map((a) => a.id));
  const fail = [];
  const warn = [];

  for (const a of agents) {
    if (!a.owns) fail.push(`agent theatre: "${a.id}" declares no measurable responsibility (owns is empty)`);
    if (!a.role) fail.push(`invalid: "${a.id}" has no role`);
    if (!a.tools.length) fail.push(`least privilege: "${a.id}" has no tools — it can do nothing`);
    if (!a.handoff.includes('handoff')) fail.push(`protocol: "${a.id}" omits the handoff field`);
    // Without this the voice layer has nothing to say but "task complete", which
    // reports only that time passed.
    if (!a.handoff.includes('voice')) fail.push(`protocol: "${a.id}" omits the voice field — JARVIS would have nothing to announce`);
    if (!a.handoff.includes('log')) fail.push(`protocol: "${a.id}" omits the log field — the daily log would record only what was SPOKEN, not what was done`);
    if (!MODES.includes(a.mode)) fail.push(`invalid mode: "${a.id}" declares "${a.mode}", not one of ${MODES.join('|')}`);
    if (!TIERS.includes(a.model)) fail.push(`invalid tier: "${a.id}" declares model "${a.model}", not one of ${TIERS.join('|')}`);
    // `inherit` makes an agent silently as expensive as whatever model the session
    // happens to run. That is how all 39 agents ended up on opus: nobody chose it.
    if (a.model === 'inherit') warn.push(`untiered: "${a.id}" inherits the session model — cost is whatever the session costs`);
    // A control agent exists to decide how much work happens, not to do it. Give it
    // Write and it stops being cheaper than the specialist it was meant to replace.
    if (a.mode === CONTROL) {
      const writes = a.tools.filter((t) => t === 'Write' || t === 'Edit');
      if (writes.length) fail.push(`control plane: "${a.id}" holds ${writes.join('/')} — a control agent decides, it does not build`);
      if (a.skills.length) warn.push(`control plane: "${a.id}" loads skills (${a.skills.join(', ')}) — control agents should carry no domain expertise`);
    }

    // skills an agent claims must exist somewhere we can see
    for (const s of a.skills) {
      const inRegistry = skillIds.has(s);
      const onDisk = fs.existsSync(path.join(root, 'skills', s, 'SKILL.md'));
      if (!inRegistry && !onDisk) warn.push(`"${a.id}" claims skill "${s}" which is not in this repo (may be installed externally)`);
    }
    for (const dep of a.requires) if (!agentIds.has(dep)) fail.push(`broken dependency: "${a.id}" requires unknown agent "${dep}"`);
    for (const c of a.conflicts_with) {
      if (!agentIds.has(c)) fail.push(`broken conflict: "${a.id}" conflicts with unknown agent "${c}"`);
      else {
        const other = agents.find((x) => x.id === c);
        if (!other.conflicts_with.includes(a.id)) fail.push(`asymmetric conflict: "${a.id}" conflicts "${c}" but not vice versa`);
        else if (!a.conflict_rule && !other.conflict_rule) fail.push(`unresolved conflict: "${a.id}" and "${c}" conflict with no conflict_rule`);
      }
    }
  }

  // Shared skills are NOT a defect — §19 says an agent consumes skills and §DRY
  // says do not duplicate knowledge, so two agents loading the same skill is the
  // design working. What matters is whether two agents own the same RESPONSIBILITY.
  const shared = new Map();
  for (const a of agents) {
    if (a.mode !== ACTIVE) continue;
    for (const s of a.skills) shared.set(s, [...(shared.get(s) || []), a.id]);
  }
  const sharedSkills = [...shared.entries()].filter(([, who]) => who.length > 1);

  // Duplicate responsibility IS a defect — that is agent theatre by another name.
  const norm = (s) => s.toLowerCase().replace(/[^a-z ]/g, ' ').split(/\s+/).filter((w) => w.length > 4).sort().join(' ');
  const seenOwns = new Map();
  for (const a of agents) {
    const k = norm(a.owns);
    if (!k) continue;
    if (seenOwns.has(k)) fail.push(`duplicate responsibility: "${a.id}" and "${seenOwns.get(k)}" own the same thing`);
    else seenOwns.set(k, a.id);
  }

  // A writer with no declared scope cannot be checked for collisions, so `plan` has to
  // assume it is safe to parallelise -- which is the assumption §9 was violated by. A
  // warning rather than a failure: a new agent should not be blocked from existing, but
  // it should not silently opt out of the collision check either.
  for (const a of agents) {
    const writer = a.tools.includes('Write') || a.tools.includes('Edit');
    if (writer && !a.writes) {
      warn.push(`write scope: "${a.id}" can write but declares no \`writes\` scope — plan cannot detect a collision for it (§9)`);
    }
    if (!writer && a.writes) {
      warn.push(`write scope: "${a.id}" declares writes: ${a.writes} but holds no write tool`);
    }
  }

  // Reachability — only meaningful for agents routed BY SKILL. Coordinators and
  // generalists are dispatched explicitly and declare selected_by: jarvis.
  for (const a of agents) {
    if (a.mode === ACTIVE && a.selected_by === 'skill' && !a.skills.length) {
      warn.push(`unreachable: "${a.id}" is skill-routed but declares no skills`);
    }
  }

  // Protocol completeness — a declared field that reaches no agent is not a protocol.
  //
  // This check exists because that is exactly what had happened: `findings`, `risks`,
  // `testing` and `files_changed` were declared in the registry and rendered nowhere,
  // because only `protocol.required` was written into the agent. Seven of the twelve
  // fields the protocol claimed to have were documentation of a rule nobody was told.
  // Nothing failed, because a field nobody emits is indistinguishable from a field
  // nobody needed.
  //
  // So the invariant is: every field named in `required` or `when_applicable` must have
  // a description AND must be rendered. Declaring a field is now a commitment to
  // conveying it.
  const declared = [...(protocol.required || []), ...(protocol.when_applicable || [])];
  for (const f of declared) {
    if (!protocol.fields || !protocol.fields[f]) {
      fail.push(`protocol: field "${f}" is required of agents but has no description (§7)`);
    }
  }
  if (agents.length) {
    const sample = agentMarkdown(agents[0], protocol, gates, resources);
    for (const f of declared) {
      // Either tier renders the field name; the decision markers render uppercase.
      if (!sample.includes(`**${f}**`) && !sample.includes(f.toUpperCase())) {
        fail.push(`protocol: field "${f}" is declared but reaches no agent — declared, not conveyed (§7)`);
      }
    }
  }

  // Every declared halt condition must have code behind it.
  //
  // `review_loop` was declared and unenforced for its whole life -- three rounds, four
  // halt conditions, printed by `plan`, told to all 45 agents, and honoured only as well
  // as the coordinator's attention. scripts/loop.mjs now implements it. This check is
  // what stops that regressing: a fifth condition added to the registry without code
  // fails the audit, rather than quietly becoming prose again.
  if (reviewLoop && reviewLoop.halt_on) {
    for (const cond of reviewLoop.halt_on) {
      if (!HALT_CONDITIONS.some((h) => h.matches.test(cond))) {
        fail.push(`review loop: halt condition "${cond}" is declared but scripts/loop.mjs implements no check for it (§6)`);
      }
    }
  }

  // Has the learning loop ever seen anything?
  //
  // `learn` says "no ledger yet" if you run it, and nothing else does -- so the swarm can
  // report Healthy for months while the self-improvement loop has observed zero runs and
  // every agent-health metric is computed over an empty set. That is not a broken
  // installation, so it is a warning and not a failure; but it must be VISIBLE, because
  // "the loop is built" and "the loop is working" are different claims and only one of
  // them was ever checkable.
  try {
    const ledgerDir = path.join(process.env.JARVIS_DIR || path.join(os.homedir(), '.claude', 'jarvis'), 'ledger');
    let rows = 0;
    if (fs.existsSync(ledgerDir)) {
      for (const f of fs.readdirSync(ledgerDir).filter((x) => x.endsWith('.jsonl'))) {
        rows += fs.readFileSync(path.join(ledgerDir, f), 'utf8').split('\n').filter((l) => l.trim() && !l.startsWith('#')).length;
      }
    }
    if (!rows) {
      warn.push('learning loop: the outcome ledger is empty — agent-health metrics and `learn` are computed over zero runs (§11/§12). Built and tested, but unexercised: it fills as sub-agents report.');
    }
  } catch {
    // A ledger we cannot read is not a roster problem; doctor is not the place to fail on it.
  }

  // Code graph, if one exists. Never a failure -- it is optional by design, and a repo
  // that has not run Graphify is the normal case. But a STALE graph is reported loudly,
  // because that is the state where an agent gets a confident answer about code that has
  // moved, and there is nothing in such an answer that looks wrong.
  try {
    const g = graphModule.open(root);
    if (g) {
      const unknown = graphModule.unclassifiedRelations(g);
      if (g.freshness.state === 'stale') {
        warn.push(`code graph: STALE — ${g.freshness.detail}${g.freshness.behind ? `, ${g.freshness.behind} commits behind` : ''}. Impact analysis from it describes code that has changed. Rebuild: \`graphify update .\``);
      }
      if (unknown.length) {
        warn.push(`code graph: unclassified relations (${unknown.join(', ')}) are excluded from dependency traversal, so every blast radius is a floor rather than a total (scripts/graph.mjs)`);
      }
    }
  } catch {
    // An unreadable graph is not a roster problem.
  }

  // governance completeness
  if (!gates.length) fail.push('governance: no human_approval_required gates declared (§24)');
  if (!protocol.required || !protocol.required.length) fail.push('protocol: no required fields declared (§7)');

  // The review loop is only real if its parts exist. A cap of 0 is an infinite loop
  // spelled optimistically, and a panel selector or criteria source naming an agent
  // that is not on the roster means the loop has nowhere to get "done" from.
  const loop = reviewLoop || {};
  const ids = new Set(agents.map((a) => a.id));
  if (!loop.rounds || Number(loop.rounds) < 2) {
    fail.push('review loop: rounds must be at least 2 — one build and one review');
  }
  for (const [key, who] of [['panel_selected_by', loop.panel_selected_by], ['criteria_from', loop.criteria_from]]) {
    if (!who) fail.push(`review loop: ${key} is not declared`);
    else if (!ids.has(who)) fail.push(`review loop: ${key} names "${who}", which is not an agent`);
  }
  if (!(loop.halt_on || []).length) fail.push('review loop: no halt condition declared — it would never stop');

  // Conflict reconciliation. A tiebreak list naming an agent that does not exist is a
  // procedure with a hole in exactly the place it is needed.
  const cr = reconciliation || {};
  if (!(cr.procedure || []).length) fail.push('conflict reconciliation: no procedure declared');
  if (!(cr.halt_to_human || []).length) fail.push('conflict reconciliation: nothing escalates to a human');
  for (const who of cr.tiebreak_precedence || []) {
    if (!ids.has(who)) fail.push(`conflict reconciliation: tiebreak names "${who}", which is not an agent`);
  }
  const passive = agents.filter((a) => a.mode === PASSIVE);
  if (!passive.length) warn.push('no passive governance agents — the swarm cannot audit itself (§6)');

  const byMode = agents.reduce((m, a) => ((m[a.mode] = (m[a.mode] || 0) + 1), m), {});
  const byTier = agents.reduce((m, a) => ((m[a.model] = (m[a.model] || 0) + 1), m), {});
  const mark = (b, s) => `${b ? '✓' : '✗'} ${s}`;
  console.log('SWARM DOCTOR\n');
  console.log(mark(true, `Agents defined: ${agents.length}  (${Object.entries(byMode).map(([k, v]) => `${k} ${v}`).join(', ')})`));
  console.log(mark(!byTier.inherit, `Model tiers: ${TIERS.filter((t) => byTier[t]).map((t) => `${t} ${byTier[t]}`).join(', ')}`));
  console.log(`  Frappe boilerplate suppressed on: ${agents.filter((a) => !a.frappe).length} agent(s) whose subject is not the ERP`);
  console.log(mark(!fail.some((f) => f.startsWith('agent theatre')), `Agents with a measurable responsibility: ${agents.filter((a) => a.owns).length}/${agents.length}`));
  console.log(mark(!fail.some((f) => f.startsWith('broken')), `Broken agent dependencies: ${fail.filter((f) => f.startsWith('broken')).length}`));
  console.log(mark(!fail.some((f) => f.includes('conflict')), `Unresolved conflicts: ${fail.filter((f) => f.includes('conflict')).length}`));
  console.log(mark(!fail.some((f) => f.startsWith('duplicate responsibility')), `Duplicate responsibilities: ${fail.filter((f) => f.startsWith('duplicate responsibility')).length}`));
  console.log(mark(!warn.some((w) => w.startsWith('unreachable')), `Unreachable agents: ${warn.filter((w) => w.startsWith('unreachable')).length}`));
  console.log(`  Shared skills (by design, not a defect): ${sharedSkills.length}`);
  for (const [s, who] of sharedSkills) console.log(`     ${s} <- ${who.join(', ')}`);
  console.log(mark(!fail.some((f) => f.startsWith('protocol')), `Protocol compliance: ${agents.filter((a) => a.handoff.includes('handoff')).length}/${agents.length}`));
  console.log(mark(!!gates.length, `Human-approval gates declared: ${gates.length}`));
  console.log(mark(!!passive.length, `Passive governance agents: ${passive.length}`));
  const rl = reviewLoop || {};
  console.log(mark(
    !fail.some((f) => f.startsWith('review loop')),
    `Review loop: ${rl.rounds || 0} rounds, panel by ${rl.panel_selected_by || '?'}, ${(rl.halt_on || []).length} halt conditions`
  ));
  const rc = reconciliation || {};
  console.log(mark(
    !fail.some((f) => f.startsWith('conflict reconciliation')),
    `Conflict reconciliation: ${(rc.procedure || []).length} steps, ${(rc.tiebreak_precedence || []).length} tiebreak, ${(rc.halt_to_human || []).length} escalations`
  ));

  if (fail.length) {
    console.log('\nFAILURES');
    fail.forEach((f) => console.log('  - ' + f));
  }
  if (warn.length) {
    console.log('\nWARNINGS');
    warn.forEach((w) => console.log('  - ' + w));
  }
  console.log(`\nSwarm status: ${fail.length ? 'UNHEALTHY' : 'Healthy'}`);
  return fail.length ? 1 : 0;
}

export function show({ root, readYaml, id }) {
  const { agents } = loadAgents({ root, readYaml });
  const a = agents.find((x) => x.id === id);
  if (!a) {
    console.log(`no such agent: ${id}`);
    return 1;
  }
  console.log(JSON.stringify(a, null, 2));
  return 0;
}

export function render(result) {
  console.log(result.applied ? `agents written -> ${result.dir}` : 'DRY RUN — nothing written. Add --apply.');
  for (const w of result.written) console.log(`  ${w.id.padEnd(22)} ${w.mode.padEnd(11)} model:${String(w.model).padEnd(8)} ${w.bytes}B`);
  if (result.removed && result.removed.length) {
    console.log(`\nRemoved ${result.removed.length} stale generated agent(s): ${result.removed.join(', ')}`);
  }
  console.log(`\n${result.written.length} agents`);
  return 0;
}
