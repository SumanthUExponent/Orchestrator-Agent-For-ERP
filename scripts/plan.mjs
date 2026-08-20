/**
 * Execution plan — routing selects SKILLS; this turns them into AGENTS, batches, and
 * a model tier per dispatch.
 *
 * That gap used to be closed by hand: `route` printed skills and a human mapped them
 * onto agents from memory, which meant the mapping was re-derived every session and
 * the parallelism in the phase table was usually not taken. Everything here is
 * mechanical, so it is free and it cannot drift from the registry.
 *
 * Nothing is dispatched from here. This prints a plan a human or JARVIS
 * skill executes — same contract as route.mjs (§26).
 */

import path from 'node:path';

/**
 * Relative cost index, NOT a price and NOT a measurement. It exists so a plan can
 * say "this run is a third of the all-opus baseline" in a number you can argue with.
 * Roughly tracks published output-token ratios between the tiers; edit it here if
 * that changes — nothing else reads these values.
 */
const COST = { haiku: 1, sonnet: 3, opus: 15, inherit: 15 };
const MAX_BATCH = 4; // past this the returns are unreadable and merging costs more than the batch saved

/**
 * Lexical overlap between the request and what an agent says it owns.
 *
 * Used for ONE job: settling which agent gets a skill when several declare it. Two
 * agents sharing a skill is the design working (§19), but dispatching both on a
 * request that only wanted one is the over-dispatch this whole layer exists to stop —
 * "console installer" pulled in demo-builder purely because it also lists
 * console-automation-engine. Nothing else scores; the routing table still decides
 * which SKILLS apply, and this only decides who carries one.
 */
function affinity(agent, q) {
  const words = new Set(q.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3));
  const mine = new Set(`${agent.role} ${agent.owns}`.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3));
  let hits = 0;
  for (const w of words) if (mine.has(w)) hits++;
  return hits;
}

/** Layer an agent by its hard dependencies, so a requirement never shares a batch. */
function depthOf(id, byId, seen = new Set()) {
  if (seen.has(id)) return 0; // a cycle is doctor's problem, not this function's
  const a = byId.get(id);
  if (!a || !a.requires.length) return 0;
  seen.add(id);
  return 1 + Math.max(0, ...a.requires.filter((r) => byId.has(r)).map((r) => depthOf(r, byId, new Set(seen))));
}

export function executionPlan(reg, request, opts = {}) {
  const { readYaml, root } = opts;
  if (!readYaml || !root) throw new Error('executionPlan() requires opts.readYaml and opts.root');

  const { plan } = opts.routeModule;
  const { loadAgents } = opts.swarmModule;
  const routed = plan(reg, request, opts);
  const { agents } = loadAgents({ root, readYaml });
  const byId = new Map(agents.map((a) => [a.id, a]));

  // skill -> the agents that declare it. Several agents legitimately share a skill
  // (§19), so this is one-to-many and the ambiguity is reported, never guessed away.
  const phaseOfSkill = new Map();
  for (const ph of routed.phases) for (const s of ph.skills) phaseOfSkill.set(s, ph.phase);

  const picked = new Map(); // agentId -> { via: [skills], phase }
  const contested = [];
  for (const [skill, phase] of phaseOfSkill) {
    // never auto-selected by a skill: passive audits the swarm, control decides how
    // much swarm to convene — neither is domain work someone asked for.
    const claimants = agents.filter((a) => a.mode !== 'passive' && a.mode !== 'control' && a.skills.includes(skill));
    let winners = claimants;
    if (claimants.length > 1) {
      const scored = claimants.map((a) => ({ a, n: affinity(a, request) }));
      const best = Math.max(...scored.map((s) => s.n));
      // A tie at zero means the request says nothing either way. Keep everyone and
      // report it — guessing here is how a plan quietly doubles its own cost.
      winners = best === 0 ? claimants : scored.filter((s) => s.n === best).map((s) => s.a);
      for (const { a, n } of scored) {
        if (winners.includes(a)) continue;
        contested.push({ id: a.id, skill, reason: `contested ${skill}; ${winners.map((w) => w.id).join('/')} matched the request more closely (${best} vs ${n})` });
      }
    }
    for (const a of winners) {
      const cur = picked.get(a.id) || { via: [], phase };
      cur.via.push(skill);
      cur.phase = Math.min(cur.phase, phase);
      picked.set(a.id, cur);
    }
  }

  const unmapped = [...phaseOfSkill.keys()].filter((s) => !agents.some((a) => a.skills.includes(s)));

  // Agent-level conflicts. Same policy as the skill layer: the better-matched agent
  // wins, the loser is recorded with the rule that settled it — never dropped silently.
  const dropped = [];
  for (const id of [...picked.keys()]) {
    if (!picked.has(id)) continue;
    for (const c of byId.get(id).conflicts_with || []) {
      if (!picked.has(c) || !picked.has(id)) continue;
      const mine = picked.get(id).via.length;
      const theirs = picked.get(c).via.length;
      const loser = mine >= theirs ? c : id;
      const winner = loser === c ? id : c;
      picked.delete(loser);
      dropped.push({ id: loser, reason: `conflicts with ${winner}`, rule: byId.get(id).conflict_rule || byId.get(c).conflict_rule || null });
    }
  }

  // Hard dependency expansion, over agents this time.
  let grew = true;
  while (grew) {
    grew = false;
    for (const id of [...picked.keys()]) {
      for (const dep of byId.get(id).requires || []) {
        if (byId.has(dep) && !picked.has(dep)) {
          picked.set(dep, { via: [], phase: picked.get(id).phase, why: `required by ${id}` });
          grew = true;
        }
      }
    }
  }

  // Batch. Sort key is (routing phase, dependency depth) — phase carries the semantic
  // order the taxonomy declares, depth guarantees no agent shares a batch with
  // something it requires. Chunking is what actually converts the plan into
  // concurrent dispatches, which is the whole point.
  const rows = [...picked.entries()]
    .map(([id, meta]) => ({ id, ...meta, depth: depthOf(id, byId), agent: byId.get(id) }))
    .sort((a, b) => a.phase - b.phase || a.depth - b.depth || a.id.localeCompare(b.id));

  const batches = [];
  for (const r of rows) {
    const key = `${r.phase}:${r.depth}`;
    const last = batches[batches.length - 1];
    if (last && last.key === key && last.members.length < MAX_BATCH) last.members.push(r);
    else batches.push({ key, phase: r.phase, depth: r.depth, members: [r] });
  }

  const cost = rows.reduce((n, r) => n + (COST[r.agent.model] ?? COST.opus), 0);
  const baseline = rows.length * COST.opus;

  return {
    request,
    effort: routed.effort,
    gates: routed.gates,
    routedSkills: routed.selected.map((s) => s.id),
    repoSignals: routed.repoSignals,
    batches,
    dropped: [
      ...routed.dropped.map((d) => ({ ...d, layer: 'skill' })),
      ...dropped.map((d) => ({ ...d, layer: 'agent' })),
      ...contested.filter((c) => !picked.has(c.id)).map((c) => ({ ...c, layer: 'contested' })),
    ],
    unmapped,
    // The review panel: the validation-mode agents this plan already selected. The loop
    // does not recruit anyone new -- it re-runs the reviewers that were coming anyway,
    // which is why it costs rounds rather than headcount.
    panel: rows.filter((r) => r.agent && r.agent.mode === 'validation').map((r) => r.id),
    builders: rows.filter((r) => r.agent && r.agent.mode === 'active').map((r) => r.id),
    agentCount: rows.length,
    serialSteps: rows.length,
    batchedSteps: batches.length,
    cost,
    baseline,
  };
}

export function render(reg, request, opts = {}) {
  if (!String(request || '').trim()) {
    console.log('usage: jarvis.mjs plan "<request>"');
    return 2;
  }
  const p = executionPlan(reg, request, opts);
  console.log(`Request: ${p.request}`);
  console.log(`Effort: ${p.effort}${p.gates.length ? `  ·  Gates: ${p.gates.join(' -> ')}` : ''}`);
  if (p.repoSignals.length) console.log(`Repo signals: ${p.repoSignals.join(', ')}`);
  console.log(`Skills routed: ${p.routedSkills.length ? p.routedSkills.join(', ') : '(none)'}`);

  if (!p.agentCount) {
    console.log('\nExecution plan\n  (none) — no agent claims the routed skills.');
    console.log('  Answer this directly. Dispatching would cost more than the task.');
    if (p.unmapped.length) console.log(`\n  Skills with no owning agent: ${p.unmapped.join(', ')}`);
    return 0;
  }

  console.log('\nExecution plan');
  p.batches.forEach((b, i) => {
    const par = b.members.length > 1 ? `  [${b.members.length} in parallel]` : '';
    console.log(`  Batch ${i + 1}  (phase ${b.phase})${par}`);
    for (const m of b.members) {
      const via = m.via.length ? `via ${m.via.join(', ')}` : m.why || 'dependency';
      console.log(`       - ${m.id.padEnd(22)} ${String(m.agent.model).padEnd(7)} ${via}`);
    }
  });

  if (p.dropped.length) {
    console.log('\nDropped');
    for (const d of p.dropped) console.log(`  - ${d.id} (${d.layer}): ${d.reason}`);
  }
  if (p.unmapped.length) {
    console.log(`\nSkills with no owning agent: ${p.unmapped.join(', ')}`);
    console.log('  Load these in the main thread — no agent carries them.');
  }

  // The review loop, if there is anything to review and anyone to review it. Printed
  // as part of the plan because the loop is the thing being signed off -- a plan that
  // hides its own iteration is a plan you cannot judge the cost of.
  const loop = opts.reviewLoop || {};
  if (loop.rounds && p.panel && p.panel.length && p.builders && p.builders.length) {
    console.log(`\nReview loop  (up to ${loop.rounds} rounds)`);
    console.log(`  Panel:     ${p.panel.join(', ')}`);
    console.log(`  Criteria:  ${loop.criteria_from || 'unset'} writes them; reviewers judge against those, not taste`);
    console.log(`  Revision:  back to the original author, with the objection verbatim`);
    console.log('  Halts on:  every reviewer accepts · the cap · a human gate · the same objection twice');
  } else if (loop.rounds && p.builders && p.builders.length && (!p.panel || !p.panel.length)) {
    console.log('\nReview loop  (none)');
    console.log('  No validation agent was routed, so nothing would review the work.');
    console.log('  Add a review skill to the request, or accept this as unreviewed.');
  }

  const pct = p.baseline ? Math.round((1 - p.cost / p.baseline) * 100) : 0;
  console.log('\nCost');
  console.log(`  Dispatches: ${p.agentCount}  ·  serial steps ${p.serialSteps} -> batched ${p.batchedSteps}`);
  console.log(`  Relative cost index: ${p.cost} vs ${p.baseline} all-opus baseline (${pct}% lower)`);
  console.log('  Index is a ratio between tiers, not a price and not a measurement — see COST in scripts/plan.mjs.');
  return 0;
}
