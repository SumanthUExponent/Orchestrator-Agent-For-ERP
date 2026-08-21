/**
 * Evaluation — does a change to JARVIS make it better, or just different?
 *
 * WHY FLIPS AND NOT A SCORE
 *
 * "18 of 20 probes pass" is the number that hides regressions. Two probes can swap
 * places between runs and the total never moves, so the report reads identical while
 * the behaviour is worse. This reports EXAMPLE-LEVEL flips instead:
 *
 *   P->F   a regression. Blocking. One is enough to fail the run.
 *   F->P   a fix. This is the evidence that a change earned its place.
 *
 * The pattern is from AgentDevel (arXiv 2601.04620), which reframes agent
 * self-improvement as release engineering: the agent is a shippable artifact and
 * flip-centered gating is what stops a release accident.
 *
 * WHY IT IS CHEAP ENOUGH TO GATE EVERY COMMIT
 *
 * Routing is deterministic and involves no model. The whole set runs in seconds, so
 * this is not a benchmark you schedule -- it is a check you run.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *
 * It does not modify anything. It reports. Phase 4 proposes routing changes FROM this
 * evidence, and a human gates them, because "changing the swarm architecture itself"
 * is one of the seven gates and a system that can quietly re-tune its own router has
 * removed the reason the gates exist.
 */

import fs from 'node:fs';
import path from 'node:path';

const BASELINE = '.eval-baseline.json';

/** Run one probe against a plan and say whether the shape holds. */
export function checkProbe(probe, plan, humanGates) {
  const e = probe.expect || {};
  const agents = (plan.batches || []).flatMap((b) => b.members || []).map((m) => m.id);
  const fails = [];

  if (e.effort && plan.effort !== e.effort) {
    fails.push(`effort ${plan.effort}, expected ${e.effort}`);
  }
  if (e.maxAgents !== undefined && agents.length > e.maxAgents) {
    fails.push(`${agents.length} agents, expected at most ${e.maxAgents}`);
  }
  if (e.minAgents !== undefined && agents.length < e.minAgents) {
    fails.push(`${agents.length} agents, expected at least ${e.minAgents}`);
  }
  for (const id of e.mustInclude || []) {
    if (!agents.includes(id)) fails.push(`missing ${id}`);
  }
  for (const id of e.mustExclude || []) {
    if (agents.includes(id)) fails.push(`should not route ${id}`);
  }
  if (e.reviewPanel === true && !(plan.panel || []).length) {
    fails.push('no review panel, so nothing would review the work');
  }
  if (e.humanGates) {
    for (const g of e.humanGates) {
      if (!humanGates.includes(g)) fails.push(`gate not raised: ${g}`);
    }
  }
  if (e.humanGateCount !== undefined && humanGates.length !== e.humanGateCount) {
    fails.push(`${humanGates.length} gates raised, expected ${e.humanGateCount}`);
  }

  return { id: probe.id, pass: fails.length === 0, fails, agents: agents.length };
}

/**
 * Run the set. `deps` is handed in rather than imported so this module stays free of
 * the acyclic-import problem the rest of scripts/ is careful about.
 */
export function runProbes({ root, readYaml, buildRegistry, planModule, routeModule, swarmModule, voiceModule }) {
  const file = path.join(root, 'registry', 'probes.json');
  if (!fs.existsSync(file)) return { error: `no probe set at ${file}` };
  const { probes } = JSON.parse(fs.readFileSync(file, 'utf8'));
  const reg = buildRegistry({ quiet: true });
  const { gates: sevenGates, reviewLoop } = swarmModule.loadAgents({ root, readYaml });

  const results = [];
  for (const probe of probes) {
    let plan, gates = [];
    try {
      plan = planModule.executionPlan(reg, probe.request, {
        readYaml, root, routeModule, swarmModule, reviewLoop,
      });
      gates = voiceModule.matchGates(probe.request, sevenGates);
    } catch (err) {
      results.push({ id: probe.id, pass: false, fails: [`threw: ${err.message}`], agents: 0 });
      continue;
    }
    results.push(checkProbe(probe, plan, gates));
  }
  return { results, probes };
}

/** Compare against the stored baseline and classify every change as a flip. */
export function compare(results, baseline) {
  const prev = new Map((baseline?.results || []).map((r) => [r.id, r.pass]));
  const flips = { regressions: [], fixes: [], unchanged: 0, new: [] };
  for (const r of results) {
    if (!prev.has(r.id)) { flips.new.push(r); continue; }
    const was = prev.get(r.id);
    if (was && !r.pass) flips.regressions.push(r);
    else if (!was && r.pass) flips.fixes.push(r);
    else flips.unchanged++;
  }
  return flips;
}

export function render({ root, save, ...deps }) {
  const out = runProbes({ root, ...deps });
  if (out.error) { console.error(out.error); return 1; }
  const { results } = out;

  const baseFile = path.join(root, BASELINE);
  const baseline = fs.existsSync(baseFile) ? JSON.parse(fs.readFileSync(baseFile, 'utf8')) : null;
  const passed = results.filter((r) => r.pass).length;

  // Gating and held-out are reported apart, because a regression in each means a
  // different thing. A gating probe breaking says a known case broke. A HELD-OUT probe
  // breaking says the change did not generalise -- and since the proposal generator never
  // sees these, it cannot have tuned against them. That makes them the only probes whose
  // pass is not potentially Goodharted (arXiv:2606.28430).
  const heldIds = new Set((out.probes || []).filter((p) => p.heldout).map((p) => p.id));
  const gating = results.filter((r) => !heldIds.has(r.id));
  const held = results.filter((r) => heldIds.has(r.id));

  console.log('ROUTING PROBES — gating set\n');
  for (const r of gating) {
    console.log(`  ${r.pass ? '✓' : '✗'} ${r.id}`);
    for (const f of r.fails) console.log(`      ${f}`);
  }
  if (held.length) {
    console.log('\nHELD-OUT SET — the optimiser never sees these\n');
    for (const r of held) {
      console.log(`  ${r.pass ? '✓' : '✗'} ${r.id}`);
      for (const f of r.fails) console.log(`      ${f}`);
    }
    const heldPass = held.filter((r) => r.pass).length;
    if (heldPass < held.length) {
      console.log(`\n  ${held.length - heldPass} HELD-OUT FAILURE(S). This is the loud kind: nothing tuned`);
      console.log('  against these, so a break here means the change did not generalise.');
    }
  }
  console.log(`\n  ${passed}/${results.length} hold  (${gating.filter((r) => r.pass).length}/${gating.length} gating, ${held.filter((r) => r.pass).length}/${held.length} held-out)`);

  if (!baseline) {
    console.log('\n  No baseline yet. A total on its own cannot tell you whether a change');
    console.log('  helped -- record one with --save, then every later run reports FLIPS.');
    if (save) {
      fs.writeFileSync(baseFile, JSON.stringify({ at: 'baseline', results }, null, 2) + '\n');
      console.log(`\n  Baseline written to ${BASELINE}.`);
    }
    return passed === results.length ? 0 : 1;
  }

  const flips = compare(results, baseline);
  console.log('\nFLIPS AGAINST BASELINE');
  if (flips.regressions.length) {
    console.log(`\n  REGRESSIONS  (${flips.regressions.length}) — these block`);
    for (const r of flips.regressions) console.log(`    P->F  ${r.id}: ${r.fails.join('; ')}`);
  }
  if (flips.fixes.length) {
    console.log(`\n  FIXES  (${flips.fixes.length}) — this is what earns a change its place`);
    for (const r of flips.fixes) console.log(`    F->P  ${r.id}`);
  }
  if (flips.new.length) {
    console.log(`\n  NEW PROBES  (${flips.new.length}) — no baseline, not counted as a flip`);
    for (const r of flips.new) console.log(`    ${r.pass ? '✓' : '✗'}  ${r.id}`);
  }
  if (!flips.regressions.length && !flips.fixes.length && !flips.new.length) {
    console.log('\n  none. Behaviour is identical to the baseline.');
  }
  console.log(`\n  ${flips.unchanged} unchanged`);

  if (flips.regressions.length) {
    console.log('\nVERDICT: BLOCKED — a probe that used to hold no longer does.');
    console.log('  Aggregate totals would have hidden this. Fix it or update the probe,');
    console.log('  but do not record a baseline over a regression.');
    return 1;
  }
  if (save) {
    fs.writeFileSync(baseFile, JSON.stringify({ at: 'baseline', results }, null, 2) + '\n');
    console.log(`\nVERDICT: ACCEPTED — baseline updated (${flips.fixes.length} fixes recorded).`);
  } else {
    console.log('\nVERDICT: no regressions. Re-run with --save to move the baseline.');
  }
  return 0;
}
