/**
 * JARVIS routing test suite (§29).
 *
 * These are regression tests for ROUTING DECISIONS, not for prose. Every case
 * below corresponds to a defect found while building the engine — each one
 * failed at some point, which is the only reason it earns a test.
 *
 * Run: node --test tests/
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { build, readYaml, ROOT } from '../scripts/jarvis.mjs';
import { plan } from '../scripts/route.mjs';
import * as E from '../scripts/evaluate.mjs';

const reg = build({ quiet: true });
const P = (request, opts = {}) => plan(reg, request, { readYaml, root: ROOT, cwd: ROOT, ...opts });
const ids = (p) => p.selected.map((s) => s.id);
const phaseOf = (p, id) => p.phases.find((ph) => ph.skills.includes(id))?.phase;

describe('registry integrity', () => {
  test('every discovered skill is registered', () => {
    assert.equal(reg.counts.registered, reg.counts.discovered);
  });
  test('every skill resolves to a taxonomy category and a phase', () => {
    for (const s of reg.skills) {
      assert.ok(reg.categories[s.category], `${s.id} has unknown category ${s.category}`);
      assert.equal(typeof s.phase, 'number', `${s.id} has no phase`);
    }
  });
  test('phases parse as objects, not strings', () => {
    // Regression: inline-map YAML parsed as a string, silently losing the
    // parallel and gate flags while routing still appeared to work.
    for (const [n, ph] of Object.entries(reg.phases)) {
      assert.equal(typeof ph, 'object', `phase ${n} parsed as ${typeof ph}`);
      assert.equal(typeof ph.label, 'string');
    }
  });
});

describe('effort selection (§24)', () => {
  test('a typo is minimal', () => assert.equal(P('Fix the typo in the Vendor label').effort, 'minimal'));
  test('end-to-end work is full', () => assert.equal(P('Design a new Asset Handover module end-to-end').effort, 'full'));
  test('ordinary work is standard', () => assert.equal(P('Add an API endpoint for pricing').effort, 'standard'));
  test('explicit override beats inferred effort (§23)', () =>
    assert.equal(P('Design a new module end-to-end', { effort: 'minimal' }).effort, 'minimal'));
});

describe('decision table (§7)', () => {
  test('System Console work routes to the automation engine', () => {
    const p = P('System Console installer for a Vendor Audit DocType');
    assert.ok(ids(p).includes('console-automation-engine'));
  });
  test('a Script Report via console beats the generic installer rule (§19)', () => {
    // Ordering regression: the narrow rule must sit above the broad one, and the
    // conflict must resolve to exactly one deployment engine.
    const p = P('Build a console script that creates a Script Report for stock movement');
    assert.ok(ids(p).includes('console-report-engineer'));
    assert.ok(!ids(p).includes('console-automation-engine'));
    assert.ok(p.dropped.some((d) => d.id === 'console-automation-engine'));
  });
  test('"a new X module" matches without the contiguous phrase "new module"', () => {
    const p = P('Design a new Asset Handover module end-to-end');
    assert.ok(p.matchedRules.includes('new-module'));
  });
  test('a module named "Handover" does not trigger the handover-doc rule', () => {
    // Regression: the bare trigger "handover" matched a module name.
    const p = P('Design a new Asset Handover module end-to-end');
    assert.ok(!ids(p).includes('business-process-doc'));
  });
});

describe('dependency resolution (§11)', () => {
  test('a hard requires pulls its dependency in', () => {
    const p = P('Add an approval workflow to the Vendor DocType');
    assert.ok(ids(p).includes('frappe-doctype'), 'frappe-workflow requires frappe-doctype');
  });
  test('soft ordering hints do NOT conscript skills', () => {
    // Regression: recommended_after chained a bug report into a full build plan
    // via frappe-workflow -> frappe-doctype -> module-planner.
    const p = P('The approval emails stopped sending after yesterdays release');
    assert.ok(!ids(p).includes('module-planner'));
  });
  test('dependencies are ordered into earlier or equal phases', () => {
    const p = P('Add an approval workflow to the Vendor DocType');
    assert.ok(phaseOf(p, 'frappe-doctype') <= phaseOf(p, 'frappe-workflow'));
  });
});

describe('gates and validation', () => {
  test('full effort demands sign-off', () => {
    assert.ok(P('Design a new Asset Handover module end-to-end').gates.includes('sign-off'));
  });
  test('a trivial ask carries no gates', () => {
    assert.deepEqual(P('Fix the typo in the Vendor label').gates, []);
  });
  test('validation survives the relevance floor', () => {
    // Regression: the floor dropped frappe-testing from a production-fix flow.
    const p = P('The approval emails stopped sending after yesterdays release');
    assert.ok(ids(p).includes('frappe-testing'), 'verification must never be optimised away');
  });
});

describe('over-routing guards (§25)', () => {
  test('a typo activates no skills at all', () => {
    const p = P('Fix the typo in the Vendor label');
    assert.equal(p.phases.length, 0);
    assert.equal(p.method, 'scorer');
  });
  test('a composite category cannot drag in an irrelevant member', () => {
    // Regression: upgrade-checker joined every new-module plan purely by sharing
    // the planning category.
    const p = P('Design a new Asset Handover module end-to-end');
    assert.ok(!ids(p).includes('upgrade-checker'));
  });
  test('effort caps bound the plan size', () => {
    const routing = readYaml(`${ROOT}/registry/routing.yaml`);
    const p = P('Design a new Asset Handover module end-to-end');
    assert.ok(p.selected.length <= routing.effort_modes.full.max_skills);
  });
});

describe('scorer fallback (§9)', () => {
  test('an unmatched request falls through to the scorer', () => {
    assert.equal(P('Make the thing better somehow').method, 'scorer');
  });
  test('scores are explainable and bounded', () => {
    const p = P('Make the thing better somehow');
    for (const r of p.runnersUp) {
      assert.ok(r.score >= 0 && r.score <= 1, `score ${r.score} out of range`);
      assert.equal(typeof r.band, 'string');
    }
  });
});

describe('flip-centered evaluation', () => {
  // The whole point is that an aggregate total hides regressions. These assert the
  // classification directly, because that is the logic a release decision rests on.
  test('a pass that becomes a fail is a regression, and it blocks', () => {
    const flips = E.compare(
      [{ id: 'a', pass: false, fails: ['x'] }, { id: 'b', pass: true, fails: [] }],
      { results: [{ id: 'a', pass: true }, { id: 'b', pass: true }] }
    );
    assert.equal(flips.regressions.length, 1);
    assert.equal(flips.regressions[0].id, 'a');
    assert.equal(flips.fixes.length, 0);
  });

  test('a fail that becomes a pass is a fix, and it is the evidence', () => {
    const flips = E.compare(
      [{ id: 'a', pass: true, fails: [] }],
      { results: [{ id: 'a', pass: false }] }
    );
    assert.equal(flips.fixes.length, 1);
    assert.equal(flips.regressions.length, 0);
  });

  test('a swapped pair does NOT look unchanged', () => {
    // Two probes trade places. The total is identical -- 1 of 2 both times -- which is
    // exactly the case a score cannot see and this must.
    const flips = E.compare(
      [{ id: 'a', pass: false, fails: ['broke'] }, { id: 'b', pass: true, fails: [] }],
      { results: [{ id: 'a', pass: true }, { id: 'b', pass: false }] }
    );
    assert.equal(flips.regressions.length, 1, 'the regression must surface');
    assert.equal(flips.fixes.length, 1, 'and so must the fix');
    assert.equal(flips.unchanged, 0);
  });

  test('a probe with no baseline is new, not a flip', () => {
    const flips = E.compare([{ id: 'z', pass: false, fails: ['x'] }], { results: [] });
    assert.equal(flips.new.length, 1);
    assert.equal(flips.regressions.length, 0, 'a new probe must not read as a regression');
  });

  test('the shape check reads a plan, not a feeling', () => {
    const plan = { effort: 'standard', batches: [{ members: [{ id: 'backend' }] }], panel: [] };
    assert.equal(E.checkProbe({ id: 'p', expect: { minAgents: 1 } }, plan, []).pass, true);
    assert.equal(E.checkProbe({ id: 'p', expect: { maxAgents: 0 } }, plan, []).pass, false);
    assert.equal(E.checkProbe({ id: 'p', expect: { mustInclude: ['nope'] } }, plan, []).pass, false);
    assert.equal(E.checkProbe({ id: 'p', expect: { reviewPanel: true } }, plan, []).pass, false,
      'an empty panel means nothing would review the work');
    assert.equal(E.checkProbe({ id: 'p', expect: { humanGateCount: 1 } }, plan, ['production deployment']).pass, true);
  });
});
