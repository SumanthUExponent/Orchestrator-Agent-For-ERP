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
