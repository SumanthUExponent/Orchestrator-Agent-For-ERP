/**
 * Efficiency benchmark — before/after, over a fixed corpus.
 *
 * "It feels faster" is not evidence. This measures the three things the control
 * plane actually changed, on the same registry, with no model involved:
 *
 *   dispatches  how many agents get convened (contest resolution)
 *   steps       serial dispatches vs batched ones (parallelism)
 *   cost        the tier mix against an all-opus baseline (tiering)
 *
 * The "before" column is not a guess. It is computed from the same run: every agent
 * that WOULD have been dispatched under the old rules — all claimants of a shared
 * skill, all at session tier, all in sequence — is still present in the plan output
 * as a contested drop. Nothing here is remembered from a previous version.
 *
 * What this does NOT measure: wall-clock. Latency depends on the provider and the
 * task, not on this registry. Anyone quoting a speed-up from these numbers alone is
 * quoting a ratio, not a stopwatch.
 */

import fs from 'node:fs';
import path from 'node:path';

// Representative of the work this swarm is for, not chosen to flatter it: two are
// deliberately cases where the control plane should do nothing at all.
const CORPUS = [
  'System Console installer for a Vendor Audit DocType with approval workflow',
  'Design a new Asset Handover module end-to-end',
  'build a desk page, a script report and a print format',
  'redesign the customer portal dashboard and check accessibility',
  'add an API endpoint that pushes ticket updates to an external system',
  'write tests and a user guide for the existing module',
  'the approval emails stopped going out last week',
  'upgrade the site to v15 and check for breaking changes',
  'what does the routing table do',
  'fix the typo in the submit button label',
];

const OPUS = 15; // must match COST.opus in plan.mjs — the all-opus baseline unit

export function bench(reg, opts = {}) {
  const { executionPlan } = opts.planModule;
  const rows = CORPUS.map((request) => {
    const p = executionPlan(reg, request, opts);
    // Old behaviour: every claimant dispatched, at session tier, one after another.
    const contested = p.dropped.filter((d) => d.layer === 'contested').length;
    const beforeDispatches = p.agentCount + contested;
    return {
      request,
      before: { dispatches: beforeDispatches, steps: beforeDispatches, cost: beforeDispatches * OPUS },
      after: { dispatches: p.agentCount, steps: p.batchedSteps, cost: p.cost },
      effort: p.effort,
    };
  });

  const sum = (side, key) => rows.reduce((n, r) => n + r[side][key], 0);
  return {
    rows,
    totals: {
      before: { dispatches: sum('before', 'dispatches'), steps: sum('before', 'steps'), cost: sum('before', 'cost') },
      after: { dispatches: sum('after', 'dispatches'), steps: sum('after', 'steps'), cost: sum('after', 'cost') },
    },
  };
}

/** Prompt bytes an agent re-reads on every dispatch, and what tier it reads them at. */
export function promptWeight({ root, readYaml, loadAgents }) {
  const { agents } = loadAgents({ root, readYaml });
  const dir = path.join(root, 'agents');
  let total = 0;
  let suppressed = 0;
  for (const a of agents) {
    const f = path.join(dir, `${a.id}.md`);
    if (!fs.existsSync(f)) continue;
    total += fs.statSync(f).size;
    if (!a.frappe) suppressed++;
  }
  return { total, suppressed, count: agents.length, mean: Math.round(total / Math.max(agents.length, 1)) };
}
const pct = (before, after) => (before ? `${Math.round((1 - after / before) * 100)}%` : '—');

export function render(reg, opts = {}) {
  const { rows, totals } = bench(reg, opts);

  console.log('EFFICIENCY BENCHMARK\n');
  console.log('Before = every claimant of a routed skill, at session tier (opus), dispatched serially.');
  console.log('After  = contest-resolved, tiered, batched. Same registry, same corpus, no model involved.\n');

  const w = 52;
  console.log(`${'request'.padEnd(w)} ${'dispatch'.padEnd(9)} ${'steps'.padEnd(9)} ${'cost'.padEnd(11)} effort`);
  console.log('-'.repeat(w + 42));
  for (const r of rows) {
    const req = r.request.length > w - 2 ? r.request.slice(0, w - 3) + '…' : r.request;
    console.log(
      `${req.padEnd(w)} ${`${r.before.dispatches}->${r.after.dispatches}`.padEnd(9)} ${`${r.before.steps}->${r.after.steps}`.padEnd(9)} ${`${r.before.cost}->${r.after.cost}`.padEnd(11)} ${r.effort}`
    );
  }
  console.log('-'.repeat(w + 42));
  console.log(
    `${'TOTAL'.padEnd(w)} ${`${totals.before.dispatches}->${totals.after.dispatches}`.padEnd(9)} ${`${totals.before.steps}->${totals.after.steps}`.padEnd(9)} ${`${totals.before.cost}->${totals.after.cost}`.padEnd(11)}`
  );
  console.log(
    `${''.padEnd(w)} ${pct(totals.before.dispatches, totals.after.dispatches).padEnd(9)} ${pct(totals.before.steps, totals.after.steps).padEnd(9)} ${pct(totals.before.cost, totals.after.cost).padEnd(11)} lower`
  );

  const pw = promptWeight(opts);
  console.log('\nPrompt weight');
  console.log(`  ${pw.count} agent definitions · ${(pw.total / 1024).toFixed(1)}KB total · ${pw.mean}B mean`);
  console.log(`  Frappe/safe_exec boilerplate suppressed on ${pw.suppressed} agents whose subject is not the ERP`);

  console.log('\nRead this honestly');
  console.log('  cost is a RATIO between model tiers, not a price and not a stopwatch.');
  console.log('  steps counts dispatch rounds, so it bounds wall-clock only if batches truly run concurrently.');
  console.log('  A row that shows no change is the correct result: two of the corpus entries are');
  console.log('  requests the control plane should leave completely alone.');
  return 0;
}
