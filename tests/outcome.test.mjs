/**
 * Tier 1 harness tests.
 *
 * The property under test is that the graders DISCRIMINATE: they pass a correct solution
 * and fail every wrong one. The grader rubric from Anthropic's skill-creator states the
 * bar — "a passing grade on a weak assertion is worse than useless, it creates false
 * confidence" — and an assertion is discriminating only if "it passes when the skill
 * genuinely succeeds and fails when it doesn't."
 *
 * A grader nobody has watched fail is a grader nobody should trust.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PROBES, run } from '../scripts/outcome.mjs';
import { ROOT } from '../scripts/jarvis.mjs';

const DT = ['tests', 'fixtures', 'demo_app', 'doctype', 'widget', 'widget.json'];

/** A throwaway workspace holding one widget.json, so each case spoils exactly one thing. */
const ws = (doc) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-outcome-'));
  fs.mkdirSync(path.join(d, ...DT.slice(0, -1)), { recursive: true });
  fs.writeFileSync(path.join(d, ...DT), typeof doc === 'string' ? doc : JSON.stringify(doc));
  fs.mkdirSync(path.join(d, 'tests', 'fixtures', 'scripts'), { recursive: true });
  for (const f of ['clean_server_script.py', 'violating_server_script.py']) {
    fs.copyFileSync(path.join(ROOT, 'tests', 'fixtures', 'scripts', f), path.join(d, 'tests', 'fixtures', 'scripts', f));
  }
  return d;
};

const base = () => JSON.parse(fs.readFileSync(path.join(ROOT, ...DT), 'utf8'));
const withField = (over = {}) => {
  const d = base();
  d.fields.push({ fieldname: 'vendor_ref', fieldtype: 'Data', label: 'Vendor Reference', reqd: 1, ...over });
  return d;
};
const gradeAddField = (doc) => {
  const dir = ws(doc);
  try {
    return run({ root: dir }).find((p) => p.id === 'add-a-field-to-a-doctype');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

describe('the model-free probes hold against the real fixtures', () => {
  test('all of them pass — they have known answers', () => {
    const free = run({ root: ROOT }).filter((r) => r.kind === 'model-free' && r.id !== 'destructive-request-hits-a-gate');
    const failed = free.filter((r) => !r.pass).map((r) => `${r.id}: ${r.detail}`);
    assert.deepEqual(failed, [], 'a known-answer probe failed');
  });

  test('no grader threw — a thrown grader is a broken check, not a finding', () => {
    // Three times in this project a broken check has been mistaken for a real defect.
    const broken = run({ root: ROOT }).filter((r) => r.broken);
    assert.deepEqual(broken.map((b) => `${b.id}: ${b.detail}`), []);
  });

  test('every probe declares its kind and a reason for existing', () => {
    for (const p of PROBES) {
      assert.ok(['model-free', 'dispatch'].includes(p.kind), `${p.id} has kind ${p.kind}`);
      assert.ok(p.why && p.why.length > 30, `${p.id} does not say why it exists`);
      if (p.kind === 'dispatch') assert.ok(p.task, `${p.id} is dispatch-required but states no task`);
    }
  });

  test('the safe_exec fixture plants every violation class the grader looks for', () => {
    // The harness caught this on its first run: the fixture demonstrated five classes and
    // the grader expected six, so it correctly reported "missed: fstring". The fixture was
    // incomplete, not the grader — which is exactly what a known-answer probe is for.
    const body = fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'scripts', 'violating_server_script.py'), 'utf8');
    for (const [name, re] of [
      ['import', /^\s*import\s+\w/m],
      ['format', /\.format\s*\(/],
      ['fstring', /\bf["'][^"']*\{/],
      ['get_roles', /frappe\.get_roles\s*\(/],
      ['reload', /\.reload\s*\(\s*\)/],
      ['return', /^\s*return\b/m],
    ]) {
      assert.ok(re.test(body), `the fixture plants no ${name} violation, so that check is untested`);
    }
  });
});

describe('the add-a-field grader discriminates', () => {
  test('a correct solution passes', () => {
    const r = gradeAddField(withField());
    assert.equal(r.pass, true, r.detail);
  });

  test('the wrong fieldtype fails, and says which', () => {
    const r = gradeAddField(withField({ fieldtype: 'Link' }));
    assert.equal(r.pass, false);
    assert.match(r.detail, /fieldtype is Link/);
  });

  test('omitting required fails', () => {
    const d = base();
    d.fields.push({ fieldname: 'vendor_ref', fieldtype: 'Data', label: 'Vendor Reference' });
    assert.equal(gradeAddField(d).pass, false);
  });

  test('the wrong label fails — "follow the spec literally" is part of the task', () => {
    const r = gradeAddField(withField({ label: 'Vendor Ref' }));
    assert.equal(r.pass, false);
    assert.match(r.detail, /label/);
  });

  test('scope creep fails even when the requested field is correct', () => {
    // "Change nothing else" is in the task, so a change that also deletes a field is a
    // failure however good the addition was. An agent that redesigns instead of doing what
    // was asked fails, however elegant the redesign.
    const d = withField();
    d.fields = d.fields.filter((f) => f.fieldname !== 'description');
    const r = gradeAddField(d);
    assert.equal(r.pass, false);
    assert.match(r.detail, /removed description/);
  });

  test('unparseable JSON fails distinctly from a missing field', () => {
    const broken = gradeAddField('{ "fields": [ ');
    assert.equal(broken.pass, false);
    assert.match(broken.detail, /unparseable/);
    const absent = gradeAddField(base());
    assert.match(absent.detail, /absent/);
    assert.notEqual(broken.detail, absent.detail, 'two different failures report identically');
  });

  test('an ungraded dispatch probe is not reported as a pass', () => {
    // The honest state of an un-run probe is "unmeasured", not "passing".
    assert.equal(gradeAddField(base()).pass, false);
  });
});
