/**
 * Swarm tooling — generate agent definitions, and audit the roster.
 *
 *   swarm build-agents [--apply]   generate agents/*.md from registry/agents.yaml
 *   swarm doctor                   audit the roster (agent-guardian's job, §6)
 *   swarm show <agent>             print one agent's resolved definition
 *
 * agents/*.md are GENERATED. registry/agents.yaml is the single source of truth
 * (§DRY, §19) — a skill is reusable expertise, an agent is an execution identity
 * that consumes skills, and neither is copied into the other.
 *
 * Does NOT import orchestrator.mjs — that module dynamically imports this one, and
 * a static import back would deadlock on an unsettled top-level await. Helpers
 * arrive through opts.
 */

import fs from 'node:fs';
import path from 'node:path';

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
    escalates_to: a.escalates_to || 'orchestrator',
    // How this agent gets picked. `skill` = matched via the skills it declares.
    // `orchestrator` = dispatched explicitly by a coordinator. Coordinators and
    // generalists legitimately declare no skills; that is not unreachability.
    selected_by: a.selected_by || (a.skills && a.skills.length ? 'skill' : 'orchestrator'),
    uses_design_system: a.uses_design_system === true,
    // Frappe safety + safe_exec are emitted by default; an agent whose subject is
    // the swarm or the repo opts out. That boilerplate is ~1.1KB re-read on every
    // single dispatch, and in a git or governance agent it is answering a question
    // nobody asked.
    frappe: a.frappe === undefined ? (d.frappe === undefined ? true : d.frappe !== false) : a.frappe !== false,
    runs: a.runs || null,
    handoff: a.handoff || (spec.protocol && spec.protocol.required) || ['summary', 'handoff'],
  }));
  return {
    agents,
    protocol: spec.protocol || {},
    gates: spec.human_approval_required || [],
    resources: spec.resources || {},
    version: spec.version ?? 1,
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
     edit the registry and run: node scripts/swarm.mjs build-agents --apply -->

# ${a.id}

**Role.** ${a.role}.

**You own exactly this.** ${a.owns}

Work outside that sentence is not yours. If the task drifts, say so in \`handoff\` and stop — do not quietly expand scope. Another agent owns it, or nobody does and the orchestrator needs to know.
${a.skills.length ? `\n**Skills to load first.** ${a.skills.map((s) => `\`${s}\``).join(' · ')}\n\nThese carry the actual expertise. Load them before reasoning about the task; do not reconstruct their content from memory.` : ''}
${a.constraints ? `\n**Constraints.**\n\n${a.constraints}\n` : ''}${a.conflict_rule ? `\n**Conflict rule.** ${a.conflict_rule}\n` : ''}${a.governance ? `\n**Governance.** ${a.governance}\n` : ''}${a.runs ? `\n**Primary command.**\n\n\`\`\`bash\n${a.runs}\n\`\`\`\n` : ''}${a.uses_design_system ? designSystemSection(resources) : ''}${a.frappe ? frappeSafetySection() : ''}
## Stop and escalate

Return the question in \`handoff\` rather than deciding, if the task would require any of:

${gates.map((g) => `- ${g}`).join('\n')}

You cannot address the user. Escalate to: **${a.escalates_to}**.

## Your handoff (required)

Never finish with "done". Return these fields:

${handoffDoc}

Structured fields, not an essay. The orchestrator reads these to decide what happens next; prose it has to parse is a failure of the protocol.

## The spoken line — your LAST line, always

End your output with exactly this, on its own line:

\`\`\`
VOICE: <one clause>
\`\`\`

A speech synthesiser reads it aloud to someone who is not looking at the screen, very
often while three other sessions are running. That audience changes what a good summary
is:

- **One clause, under ten words.** Each word is roughly a fifth of a second of speech,
  and the whole announcement has to land inside about three. Ten words spoken is already
  longer than most people will wait to hear what changed.
- **Say what CHANGED, not what you did.** "Vendor Audit schema is in, with three child
  tables" — not "I have completed the data model design task as requested".
- **No paths, no identifiers, no camelCase, no version numbers.** A file path read aloud
  is unintelligible. Name the thing, not its location.
- **Lead with the problem if there is one.** That is the part worth interrupting someone
  for, and it is the reason this is spoken rather than written.
- **Plain words only.** No markdown, no quotes, no pipe characters, no emoji.

If you changed nothing, say that plainly: \`VOICE: nothing to change in the retrofit hooks\`.

This line is not a courtesy. Without it the announcement falls back to "task complete",
which tells the listener only that time passed.
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
  const { agents, protocol, gates } = loadAgents({ root, readYaml });
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

  // Reachability — only meaningful for agents routed BY SKILL. Coordinators and
  // generalists are dispatched explicitly and declare selected_by: orchestrator.
  for (const a of agents) {
    if (a.mode === ACTIVE && a.selected_by === 'skill' && !a.skills.length) {
      warn.push(`unreachable: "${a.id}" is skill-routed but declares no skills`);
    }
  }

  // governance completeness
  if (!gates.length) fail.push('governance: no human_approval_required gates declared (§24)');
  if (!protocol.required || !protocol.required.length) fail.push('protocol: no required fields declared (§7)');
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
