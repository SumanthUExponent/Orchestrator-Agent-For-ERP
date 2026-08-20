/**
 * Installer test suite.
 *
 * The dry run is the installer's safety contract: it is the thing a user reads
 * before letting it write to ~/.claude. A preview that disagrees with the apply is
 * worse than no preview, because it is trusted.
 *
 * Run: node --test tests/
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readYaml, ROOT } from '../scripts/jarvis.mjs';
import { install } from '../scripts/install.mjs';

let tmp;
let prevAgents;
let prevSkills;

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-install-'));
  prevAgents = process.env.JARVIS_AGENTS_DIR;
  prevSkills = process.env.JARVIS_SKILLS_DIR;
  process.env.JARVIS_AGENTS_DIR = path.join(tmp, 'agents');
  process.env.JARVIS_SKILLS_DIR = path.join(tmp, 'skills');
});

after(() => {
  if (prevAgents === undefined) delete process.env.JARVIS_AGENTS_DIR;
  else process.env.JARVIS_AGENTS_DIR = prevAgents;
  if (prevSkills === undefined) delete process.env.JARVIS_SKILLS_DIR;
  else process.env.JARVIS_SKILLS_DIR = prevSkills;
  fs.rmSync(tmp, { recursive: true, force: true });
});

const run = (opts) => install({ root: ROOT, readYaml, ...opts });
const agents = (r, key) => r[key].filter((x) => x.source === 'agent').length;

describe('dry run tells the truth about agents', () => {
  test('an empty target plans every agent as a write', () => {
    const dry = run({ apply: false });
    assert.ok(agents(dry, 'planned') > 0, 'nothing planned into an empty agents dir');
    assert.equal(agents(dry, 'skipped'), 0, 'skipped an agent that does not exist yet');
  });

  test('the dry run matches what apply actually does', () => {
    // Regression: the skip check ran only under `apply`, so a dry run listed all 45
    // agents as writes while the real run skipped every pre-existing one. An upgrade
    // that re-tiers existing agents then looked applied and changed nothing.
    const dry = run({ apply: false });
    const real = run({ apply: true });
    assert.equal(real.agentsWritten, agents(dry, 'planned'), 'apply wrote a different number than the dry run promised');
  });

  test('a second dry run now reports skips, because the files exist', () => {
    const dry = run({ apply: false });
    assert.equal(agents(dry, 'planned'), 0, 'planned a write over an existing agent without --force');
    assert.ok(agents(dry, 'skipped') > 0, 'existing agents were not reported as skipped');
  });

  test('--force turns those skips back into writes', () => {
    const dry = run({ apply: false, force: true });
    assert.equal(agents(dry, 'skipped'), 0, '--force still skipped an agent');
    assert.ok(agents(dry, 'planned') > 0);
  });

  test('an upgrade without --force is a no-op, and says so', () => {
    // This is the exact trap: re-tiered agents already exist by name, so a plain
    // --apply writes nothing and the tiering never lands.
    const real = run({ apply: true });
    assert.equal(real.agentsWritten, 0, 'wrote over existing agents without --force');
    assert.ok(agents(real, 'skipped') > 0);
  });
});

describe('the installer can tell stale from identical', () => {
  // "already installed" is true and useless -- it reads as up to date when the installed
  // copy is six commits behind. The machine then runs old agents while `doctor` reports
  // Healthy, because it reads the INSTALLED registry and a stale file is a valid file.
  // Hit for real: 45 agents skipped as "already installed" after a registry change, and
  // nothing in any output said so.

  test('a freshly installed agent is reported identical, not merely present', () => {
    run({ apply: true, force: true });
    const again = run({ apply: false });
    const skips = again.skipped.filter((s) => s.source === 'agent');
    assert.ok(skips.length > 0, 'nothing skipped after a full install');
    assert.ok(skips.every((s) => s.stale === false), 'a just-written file reported as stale');
    assert.ok(skips.every((s) => /identical/.test(s.reason)), skips[0]?.reason);
  });

  test('a modified installed agent is reported OUTDATED with the fix in the reason', () => {
    run({ apply: true, force: true });
    const target = path.join(process.env.JARVIS_AGENTS_DIR, 'architect.md');
    fs.appendFileSync(target, '\ndrift introduced by the test\n');
    const r = run({ apply: false });
    const hit = r.skipped.find((s) => s.name === 'architect.md');
    assert.ok(hit, 'the modified agent was not even skipped');
    assert.equal(hit.stale, true, 'a differing file was not flagged stale');
    assert.match(hit.reason, /OUTDATED/);
    assert.match(hit.reason, /--force/, 'flagged the drift without naming the fix');
  });

  test('a truncated installed agent counts as drift', () => {
    run({ apply: true, force: true });
    const target = path.join(process.env.JARVIS_AGENTS_DIR, 'code-reviewer.md');
    fs.writeFileSync(target, '');
    const hit = run({ apply: false }).skipped.find((s) => s.name === 'code-reviewer.md');
    assert.equal(hit.stale, true, 'an emptied agent read as identical');
  });

  test('--force still replaces rather than reporting drift', () => {
    run({ apply: true, force: true });
    const SENTINEL = 'ZZ-DRIFT-SENTINEL-ZZ';
    fs.appendFileSync(path.join(process.env.JARVIS_AGENTS_DIR, 'architect.md'), `\n${SENTINEL}\n`);
    const forced = run({ apply: true, force: true });
    assert.equal(forced.skipped.filter((s) => s.stale).length, 0, '--force left drift in place');
    const body = fs.readFileSync(path.join(process.env.JARVIS_AGENTS_DIR, 'architect.md'), 'utf8');
    assert.ok(!body.includes(SENTINEL), '--force did not overwrite the drifted file');
  });
});
