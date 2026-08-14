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
import { readYaml, ROOT } from '../scripts/orchestrator.mjs';
import { install } from '../scripts/install.mjs';

let tmp;
let prevAgents;
let prevSkills;

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-install-'));
  prevAgents = process.env.CLAUDE_AGENTS_DIR;
  prevSkills = process.env.CLAUDE_SKILLS_DIR;
  process.env.CLAUDE_AGENTS_DIR = path.join(tmp, 'agents');
  process.env.CLAUDE_SKILLS_DIR = path.join(tmp, 'skills');
});

after(() => {
  if (prevAgents === undefined) delete process.env.CLAUDE_AGENTS_DIR;
  else process.env.CLAUDE_AGENTS_DIR = prevAgents;
  if (prevSkills === undefined) delete process.env.CLAUDE_SKILLS_DIR;
  else process.env.CLAUDE_SKILLS_DIR = prevSkills;
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
