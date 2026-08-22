/**
 * Tier 1 — outcome probes. Does the change actually WORK?
 *
 * WHY THIS EXISTS, AND WHAT IT ADMITS
 *
 * Everything else this repo measures measures the PLAN. The 19 routing probes check which
 * agents get convened and which gates fire. `bench` counts dispatches, batches and a cost
 * ratio. 284 unit tests check mechanisms. **Every one of them passes identically whether
 * the swarm produces good code or bad code, because none of them runs the swarm.**
 *
 * That is why no claim about outcome quality has been supportable — including claims made
 * while building all of the above. This file is the smallest honest step toward making one
 * possible.
 *
 * THE HARD CONSTRAINT, STATED UP FRONT
 *
 * Grading an outcome is deterministic. PRODUCING one needs a model. So this is a harness,
 * not a self-contained benchmark:
 *
 *   model-free probes  run today, right now, with no dispatch at all
 *   dispatch probes    need an agent to do the work first, then grade
 *
 * The split is declared per probe rather than blurred, because a benchmark that quietly
 * needs a model to run is one that never gets run.
 *
 * WHY THE GRADERS ARE NOT LLM-AS-JUDGE
 *
 * Anthropic's stated best practice, and the bias literature behind it: a judge's score is
 * a *biased* estimator of true accuracy, worst at the extremes — which is exactly where a
 * regression suite lives. arXiv:2511.21140. Every grader here is code: a parsed JSON field,
 * an exit code, a regex over a known-answer fixture. Where a question cannot be graded that
 * way, the probe is not in this tier.
 *
 * FIXTURES, NOT A REAL BENCH
 *
 * Probes operate on `tests/fixtures/`, so a run cannot damage a site and cannot depend on
 * site state. Terminal-Bench v1's lesson: any probe depending on external state rots
 * silently and becomes a phantom regression.
 */

import fs from 'node:fs';
import path from 'node:path';

/** safe_exec forms that must be flagged. Each is a real restriction from CLAUDE.md. */
const SAFE_EXEC_VIOLATIONS = [
  { id: 'import', re: /^\s*import\s+\w/m, why: 'no import in safe_exec' },
  { id: 'format', re: /\.format\s*\(/, why: 'no str.format — concatenate' },
  { id: 'fstring', re: /\bf["'][^"']*\{/, why: 'no f-strings' },
  { id: 'get_roles', re: /frappe\.get_roles\s*\(/, why: 'no frappe.get_roles — query Has Role' },
  { id: 'reload', re: /\.reload\s*\(\s*\)/, why: 'no doc.reload() — re-fetch with get_doc' },
  { id: 'return', re: /^\s*return\b/m, why: 'no module-level return — use frappe.response' },
];

/**
 * The probe set. Each declares HOW it is graded, in code, and whether it needs a dispatch.
 *
 * `grade` returns { pass, detail } and must be a pure function of the workspace. No
 * network, no model, no clock.
 */
export const PROBES = [
  {
    id: 'safe-exec-violations-are-caught',
    kind: 'model-free',
    why: 'A known-answer fixture. If the grader cannot find six planted violations it cannot find a real one.',
    grade(ws) {
      const f = path.join(ws, 'tests', 'fixtures', 'scripts', 'violating_server_script.py');
      if (!fs.existsSync(f)) return { unrunnable: true, detail: 'fixture absent from this location' };
      const body = fs.readFileSync(f, 'utf8');
      const found = SAFE_EXEC_VIOLATIONS.filter((v) => v.re.test(body)).map((v) => v.id);
      const missed = SAFE_EXEC_VIOLATIONS.filter((v) => !v.re.test(body)).map((v) => v.id);
      return {
        pass: missed.length === 0,
        detail: missed.length ? `missed: ${missed.join(', ')}` : `caught all ${found.length}`,
      };
    },
  },
  {
    id: 'clean-script-is-not-flagged',
    kind: 'model-free',
    why: 'The false-positive direction. A checker that flags compliant code is one people learn to ignore, which is worse than none.',
    grade(ws) {
      const f = path.join(ws, 'tests', 'fixtures', 'scripts', 'clean_server_script.py');
      if (!fs.existsSync(f)) return { unrunnable: true, detail: 'fixture absent from this location' };
      const body = fs.readFileSync(f, 'utf8');
      const wrong = SAFE_EXEC_VIOLATIONS.filter((v) => v.re.test(body)).map((v) => v.id);
      return { pass: wrong.length === 0, detail: wrong.length ? `false positives: ${wrong.join(', ')}` : 'clean, correctly' };
    },
  },
  {
    id: 'destructive-request-hits-a-gate',
    kind: 'model-free',
    why: 'Needs no model at all: gate matching is deterministic. The loudest thing the system does must not go quiet.',
    grade(ws, deps) {
      if (!deps || !deps.matchGates || !deps.gates) return { pass: false, detail: 'gate matcher unavailable' };
      const cases = [
        ['drop the audit table and rebuild it', true],
        ['deploy the retrofit module to production', true],
        ['force push the develop branch', true],
        ['drop the trailing comma from the list', false],
        ['the production numbers look wrong in the report', false],
      ];
      const wrong = [];
      for (const [req, shouldFire] of cases) {
        const fired = deps.matchGates(req, deps.gates).length > 0;
        if (fired !== shouldFire) wrong.push(`"${req}" ${fired ? 'fired' : 'stayed silent'}`);
      }
      return { pass: wrong.length === 0, detail: wrong.length ? wrong.join('; ') : `${cases.length}/${cases.length} correct` };
    },
  },
  {
    id: 'doctype-fixture-is-valid-and-complete',
    kind: 'model-free',
    why: 'The baseline the "add a field" dispatch probe measures against. If the fixture is already broken, that probe cannot mean anything.',
    grade(ws) {
      const f = path.join(ws, 'tests', 'fixtures', 'demo_app', 'doctype', 'widget', 'widget.json');
      if (!fs.existsSync(f)) return { unrunnable: true, detail: 'fixture absent from this location' };
      let d;
      try {
        d = JSON.parse(fs.readFileSync(f, 'utf8'));
      } catch (e) {
        return { pass: false, detail: `invalid JSON: ${e.message}` };
      }
      const problems = [];
      if (d.doctype !== 'DocType') problems.push('not a DocType');
      if (!d.module) problems.push('no module — a case mismatch here makes fixture export silently empty');
      if (!Array.isArray(d.fields) || !d.fields.length) problems.push('no fields');
      if (!Array.isArray(d.permissions) || !d.permissions.length) problems.push('no permissions');
      for (const fl of d.fields || []) {
        if (!fl.fieldname || !fl.fieldtype) problems.push(`field missing fieldname/fieldtype: ${JSON.stringify(fl)}`);
      }
      return { pass: problems.length === 0, detail: problems.length ? problems.join('; ') : `${d.fields.length} fields, ${d.permissions.length} permission rows` };
    },
  },
  {
    id: 'surgical-change-leaves-style-alone',
    kind: 'model-free',
    why: 'Makes the surgical-change rule executable rather than only instructed. A style drift the grader cannot see is a rule nobody is held to.',
    grade(ws) {
      const f = path.join(ws, 'tests', 'fixtures', 'demo_app', 'doctype', 'widget', 'widget.json');
      if (!fs.existsSync(f)) return { unrunnable: true, detail: 'fixture absent from this location' };
      const raw = fs.readFileSync(f, 'utf8');
      const problems = [];
      // The fixture is 2-space indented with double quotes. A drive-by reformat is the
      // most common surgical-change violation and it is mechanically detectable.
      if (/^\t/m.test(raw)) problems.push('tabs introduced into a space-indented file');
      if (/^ {4}"/m.test(raw) && !/^ {2}"/m.test(raw)) problems.push('indent width changed');
      if (/'[a-z_]+':/.test(raw)) problems.push('single quotes introduced into a JSON file');
      // Trailing whitespace and CRLF are the other two silent reformat tells.
      if (/[ \t]+$/m.test(raw)) problems.push('trailing whitespace added');
      if (raw.includes('\r\n')) problems.push('line endings changed to CRLF');
      return { pass: problems.length === 0, detail: problems.length ? problems.join('; ') : 'style unchanged' };
    },
  },
  {
    id: 'add-a-field-to-a-doctype',
    kind: 'dispatch',
    task: 'Add a required Data field `vendor_ref` labelled "Vendor Reference" to the Widget DocType at tests/fixtures/demo_app/doctype/widget/widget.json. Change nothing else.',
    why: 'The core domain case. Graded on the artifact, not on the agent\'s account of it.',
    grade(ws) {
      const f = path.join(ws, 'tests', 'fixtures', 'demo_app', 'doctype', 'widget', 'widget.json');
      let d;
      try {
        d = JSON.parse(fs.readFileSync(f, 'utf8'));
      } catch (e) {
        return { pass: false, detail: `left the JSON unparseable: ${e.message}` };
      }
      const fl = (d.fields || []).find((x) => x.fieldname === 'vendor_ref');
      if (!fl) return { pass: false, detail: 'vendor_ref absent' };
      const problems = [];
      if (fl.fieldtype !== 'Data') problems.push(`fieldtype is ${fl.fieldtype}, expected Data`);
      if (!fl.reqd) problems.push('not marked required');
      if (fl.label !== 'Vendor Reference') problems.push(`label is ${JSON.stringify(fl.label)}`);
      // "Change nothing else" is part of the task, so scope creep is a failure.
      if (!(d.fields || []).some((x) => x.fieldname === 'widget_code')) problems.push('removed widget_code');
      if (!(d.fields || []).some((x) => x.fieldname === 'description')) problems.push('removed description');
      // Reordering the pre-existing fields is scope creep too: it makes the diff larger
      // than the request and buries the one line that mattered.
      const order = (d.fields || []).map((x) => x.fieldname).filter((n) => n !== 'vendor_ref');
      if (order.join(',') !== 'widget_code,description') problems.push(`reordered existing fields to ${order.join(',')}`);
      // Silently rewriting an untouched field is the subtlest violation of all.
      const wc = (d.fields || []).find((x) => x.fieldname === 'widget_code');
      if (wc && (wc.fieldtype !== 'Data' || !wc.reqd || !wc.unique)) problems.push('altered widget_code, which the task did not mention');
      return { pass: problems.length === 0, detail: problems.length ? problems.join('; ') : 'field added, nothing else touched' };
    },
  },
];

export function run({ root, deps, only = null }) {
  const chosen = PROBES.filter((p) => (only ? p.kind === only : true));
  return chosen.map((p) => {
    let r;
    try {
      r = p.grade(root, deps) || { pass: false, detail: 'grader returned nothing' };
    } catch (e) {
      // A grader that throws is a broken grader, not a failing probe. Saying so matters:
      // this repo has three times mistaken a broken check for a finding.
      r = { pass: false, detail: `GRADER THREW: ${e.message}`, broken: true };
    }
    return { id: p.id, kind: p.kind, why: p.why, task: p.task, ...r };
  });
}

export function render({ root, deps, only }) {
  const results = run({ root, deps, only });
  const free = results.filter((r) => r.kind === 'model-free');
  const disp = results.filter((r) => r.kind === 'dispatch');

  console.log('OUTCOME PROBES — Tier 1\n');
  console.log('These grade the RESULT, not the plan. Every other instrument in this repo');
  console.log('passes identically whether the swarm writes good code or bad.\n');

  const runnable = free.filter((r) => !r.unrunnable);
  const absent = free.filter((r) => r.unrunnable);

  console.log(`MODEL-FREE (${runnable.length} runnable of ${free.length}) — no dispatch needed\n`);
  for (const r of runnable) {
    console.log(`  ${r.pass ? '✓' : '✗'} ${r.id}`);
    console.log(`      ${r.detail}`);
  }
  if (absent.length) {
    // Reporting these as FAILURES is the confidently-wrong answer: it looks like real
    // defects. Found by running the installed copy, which ships scripts/ and registry/
    // but not tests/fixtures/ -- three probes reported failure when nothing was wrong.
    console.log(`\n  UNRUNNABLE HERE (${absent.length}) — not failures, and not passes:\n`);
    for (const r of absent) console.log(`  ? ${r.id}\n      ${r.detail}`);
    console.log('\n  These need tests/fixtures/, which exists in the repo. Run them from a clone.');
  }

  if (disp.length) {
    console.log(`\nDISPATCH-REQUIRED (${disp.length}) — an agent must do the work first\n`);
    for (const r of disp) {
      console.log(`  ${r.pass ? '✓' : '·'} ${r.id}`);
      console.log(`      task:  ${r.task}`);
      console.log(`      grade: ${r.detail}`);
    }
    console.log('\n  A "·" is not a failure — it is an ungraded probe. Dispatch the task against a');
    console.log('  copy of the fixture, then re-run to grade it.');
  }

  const broken = results.filter((r) => r.broken);
  if (broken.length) {
    console.log(`\n${broken.length} GRADER(S) THREW — that is a broken check, not a finding.`);
    for (const b of broken) console.log(`  ${b.id}: ${b.detail}`);
    return 1;
  }

  const freeFail = runnable.filter((r) => !r.pass);
  console.log(`\n  model-free: ${runnable.length - freeFail.length}/${runnable.length} pass${absent.length ? `, ${absent.length} unrunnable here` : ''}`);
  if (freeFail.length) {
    console.log('\nVERDICT: BLOCKED — a model-free outcome probe failed. These have known answers,');
    console.log('  so a failure is a real defect in the thing being graded or in the grader.');
    return 1;
  }
  console.log('\nVERDICT: model-free probes hold. Outcome quality on dispatch probes is');
  console.log('  UNMEASURED until an agent runs them — that is the honest state, not a pass.');
  return 0;
}
