/**
 * Execution-plan test suite.
 *
 * Same rule as routing.test.mjs: a case earns a test by having failed. Everything
 * below is either a defect found while building the control plane, or an invariant
 * whose breach would make the plan quietly more expensive rather than visibly wrong —
 * the failure mode this layer exists to prevent.
 *
 * Run: node --test tests/
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { build, readYaml, ROOT } from '../scripts/orchestrator.mjs';
import * as routeModule from '../scripts/route.mjs';
import * as swarmModule from '../scripts/swarm.mjs';
import * as planModule from '../scripts/plan.mjs';
import { executionPlan } from '../scripts/plan.mjs';
import { collect } from '../scripts/pack.mjs';
import { bench } from '../scripts/bench.mjs';

const reg = build({ quiet: true });
const X = (request, opts = {}) => executionPlan(reg, request, { readYaml, root: ROOT, cwd: ROOT, routeModule, swarmModule, ...opts });
const agentIds = (p) => p.batches.flatMap((b) => b.members.map((m) => m.id));
const { agents } = swarmModule.loadAgents({ root: ROOT, readYaml });
const byId = new Map(agents.map((a) => [a.id, a]));

describe('agent registry integrity', () => {
  test('no agent inherits its model', () => {
    // `inherit` is what made all 39 agents run at session cost without anyone
    // choosing it. Every agent must state a tier it can be held to.
    const untiered = agents.filter((a) => a.model === 'inherit').map((a) => a.id);
    assert.deepEqual(untiered, [], `untiered agents: ${untiered.join(', ')}`);
  });
  test('opus is the minority tier', () => {
    // Not a style rule. If most agents are opus, the tiering has drifted back to
    // where it started and the plan's cost numbers stop meaning anything.
    const opus = agents.filter((a) => a.model === 'opus').length;
    assert.ok(opus < agents.length / 2, `${opus}/${agents.length} agents on opus`);
  });
  test('control agents cannot write', () => {
    for (const a of agents.filter((x) => x.mode === 'control')) {
      assert.ok(!a.tools.includes('Write') && !a.tools.includes('Edit'), `${a.id} can write — it is no longer a control agent`);
    }
  });
});

describe('skill -> agent mapping', () => {
  test('routed skills reach an owning agent', () => {
    const p = X('Build a Vendor Audit DocType with an approval workflow');
    assert.ok(agentIds(p).length > 0, 'no agent selected for a data-model request');
    assert.ok(agentIds(p).includes('data-model-architect'));
  });
  test('passive and control agents are never auto-selected', () => {
    const p = X('Build a Vendor Audit DocType with an approval workflow');
    for (const id of agentIds(p)) {
      assert.notEqual(byId.get(id).mode, 'passive', `${id} was auto-dispatched`);
      assert.notEqual(byId.get(id).mode, 'control', `${id} was auto-dispatched`);
    }
  });
  test('a skill no agent claims is reported, not silently lost', () => {
    const p = X('write a newsletter campaign');
    assert.ok(p.unmapped.includes('newsletter-builder'), 'unowned skill vanished from the plan');
  });
});

describe('contested skills (over-dispatch)', () => {
  test('a shared skill does not dispatch both claimants when the request favours one', () => {
    // Regression: "console installer" pulled in demo-builder purely because it also
    // declares console-automation-engine — a second full dispatch nobody asked for.
    const p = X('System Console installer for a Vendor Audit DocType');
    const ids = agentIds(p);
    assert.ok(ids.includes('console-deployer'), 'the installer agent was dropped');
    assert.ok(!ids.includes('demo-builder'), 'demo-builder was dispatched for an installer request');
  });
  test('the loser is recorded with a reason, never dropped silently', () => {
    const p = X('System Console installer for a Vendor Audit DocType');
    const d = p.dropped.find((x) => x.id === 'demo-builder');
    assert.ok(d, 'demo-builder disappeared without an entry in dropped');
    assert.match(d.reason, /contested/);
  });
});

describe('batching', () => {
  test('an agent never shares a batch with something it requires', () => {
    const p = X('Design a new Asset Handover module end-to-end');
    p.batches.forEach((b) => {
      const here = new Set(b.members.map((m) => m.id));
      for (const m of b.members) {
        for (const dep of byId.get(m.id).requires || []) {
          assert.ok(!here.has(dep), `${m.id} shares a batch with its dependency ${dep}`);
        }
      }
    });
  });
  test('independent same-phase agents do batch together', () => {
    // If this fails the batching is decorative: every plan would be serial and the
    // wall-clock claim would be false.
    const p = X('build a desk page, a script report and a print format');
    assert.ok(p.batches.some((b) => b.members.length > 1), 'no batch ran in parallel');
  });
  test('batches never exceed the concurrency cap', () => {
    const p = X('Design a new Asset Handover module end-to-end');
    for (const b of p.batches) assert.ok(b.members.length <= 4, `batch of ${b.members.length}`);
  });
});

describe('effort: fast path', () => {
  test('a question routes to fast and dispatches nothing', () => {
    const p = X('what does the routing table do');
    assert.equal(p.effort, 'fast');
    assert.equal(p.agentCount, 0, 'a plain question convened the swarm');
  });
  test('architecture wording overrules the question opener', () => {
    // "explain" alone must not downgrade real platform work to fast.
    assert.equal(X('explain how we would migrate the whole platform to v15').effort, 'full');
  });
  test('fast never applies to schema work', () => {
    assert.notEqual(X('add a field to the Vendor Audit DocType').effort, 'fast');
  });
});

describe('cost accounting', () => {
  test('a plan costs less than its all-opus baseline', () => {
    const p = X('Design a new Asset Handover module end-to-end');
    assert.ok(p.cost < p.baseline, `${p.cost} vs baseline ${p.baseline}`);
  });
  test('baseline is proportional to the dispatch count', () => {
    const p = X('Design a new Asset Handover module end-to-end');
    assert.equal(p.baseline, p.agentCount * 15);
  });
});

describe('yaml scalar quoting', () => {
  test('a value ending in a quote keeps it', () => {
    // Regression: unquoting stripped a leading OR trailing quote independently, so
    // `runs: ... route "<request>"` shipped into the generated agent as an
    // unterminated `route "<request>` — a primary command that cannot run.
    for (const a of agents.filter((x) => x.runs && x.runs.includes('"'))) {
      const quotes = (a.runs.match(/"/g) || []).length;
      assert.equal(quotes % 2, 0, `${a.id} runs has an unbalanced quote: ${a.runs}`);
    }
  });
  test('repo_context glob keys are still unquoted', () => {
    // The same helper unquotes keys; a matched-pair rule must not regress this.
    const routing = readYaml(`${ROOT}/registry/routing.yaml`);
    for (const k of Object.keys(routing.repo_context)) {
      assert.ok(!k.startsWith('"'), `glob key kept its quotes: ${k}`);
    }
  });
});

describe('efficiency benchmark', () => {
  test('the corpus costs less than its all-opus baseline', () => {
    const { totals } = bench(reg, { readYaml, root: ROOT, cwd: ROOT, routeModule, swarmModule, planModule });
    assert.ok(totals.after.cost < totals.before.cost, `${totals.after.cost} vs ${totals.before.cost}`);
    assert.ok(totals.after.dispatches <= totals.before.dispatches, 'contest resolution added dispatches');
    assert.ok(totals.after.steps <= totals.before.steps, 'batching added steps');
  });
  test('cheap requests stay cheap — the control plane leaves them alone', () => {
    // If this fails the layer has started convening a swarm for a typo, which is
    // the exact failure it was built to prevent.
    const { rows } = bench(reg, { readYaml, root: ROOT, cwd: ROOT, routeModule, swarmModule, planModule });
    for (const label of ['what does the routing table do', 'fix the typo in the submit button label']) {
      const r = rows.find((x) => x.request === label);
      assert.equal(r.after.dispatches, 0, `"${label}" dispatched ${r.after.dispatches} agent(s)`);
    }
  });
});

describe('context pack', () => {
  test('collects a repository without a model', () => {
    const c = collect(ROOT);
    assert.ok(c.fileCount > 0);
    assert.ok(Array.isArray(c.doctypes));
  });
  test('an empty list means absent only when the scan completed', () => {
    // Regression: a truncated walk rendered "DocTypes: none found" at a bench root
    // holding thousands. The pack is the trusted shared context — a confident wrong
    // answer here is worse than no pack.
    const c = collect(ROOT);
    assert.equal(typeof c.truncated, 'boolean');
    assert.equal(c.truncated, false, 'this repo is small enough to scan fully');
  });
  test('reports bench availability, because managed hosting has none', () => {
    // An agent that recommends `bench migrate` on Frappe Cloud has wasted the turn.
    // Regression: this searched downward only, so scanning apps/<app> answered "no
    // bench" on a machine that has one — the bench root is a PARENT of the app.
    assert.equal(collect(ROOT).benchRoot, null, 'this repo is not a bench');
  });
});
