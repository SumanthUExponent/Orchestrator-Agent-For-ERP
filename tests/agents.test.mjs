/**
 * Assertions on the GENERATED agent definitions.
 *
 * agents/*.md were previously unasserted by any suite, which is how the spoken-line
 * contract could say one thing in registry/agents.yaml and another in the 45 files
 * that agents actually read.
 *
 * The examples are tested by CONTENT, not by shape. Agents copy examples far more
 * reliably than they follow rules, so an example silently dropped from the generator
 * is a real regression in how the voice layer sounds — and it is invisible everywhere
 * else, because the format check would still pass.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'agents');
const FILES = fs.readdirSync(DIR).filter((f) => f.endsWith('.md'));
const read = (f) => fs.readFileSync(path.join(DIR, f), 'utf8');

// One positive and one negative example is not enough to establish a pattern; three
// of each is what the contract ships, and all six must survive generation.
const GOOD = [
  'VOICE: the Vendor Audit schema is in, with three child tables',
  'VOICE: four tests are failing on the refund path',
  'VOICE: the submit hook now fires on amend as well',
];
const BAD = [
  'VOICE: schema done, 3 tables',
  'VOICE: updated apps/exponent_utilities/hooks.py',
  'VOICE: fixed safe_exec + str.format in the NSS DocType',
];

describe('generated agents carry the spoken-line contract', () => {
  test('there are agents to check at all', () => {
    assert.ok(FILES.length >= 40, `expected the full roster, found ${FILES.length}`);
  });

  test('every agent carries all three GOOD examples', () => {
    const missing = [];
    for (const f of FILES) {
      const body = read(f);
      for (const ex of GOOD) if (!body.includes(ex)) missing.push(`${f}: ${ex}`);
    }
    assert.deepEqual(missing, [], 'agents missing a good example');
  });

  test('every agent carries all three BAD examples', () => {
    const missing = [];
    for (const f of FILES) {
      const body = read(f);
      for (const ex of BAD) if (!body.includes(ex)) missing.push(`${f}: ${ex}`);
    }
    assert.deepEqual(missing, [], 'agents missing a bad example');
  });

  test('each bad example is shipped with the reason it is bad', () => {
    // An example with no explanation is a pattern to copy, not a pattern to avoid.
    const reasons = [
      'no verb, no named subject',
      'a file path',
      'snake_case and a symbol',
    ];
    const missing = [];
    for (const f of FILES) {
      const body = read(f);
      for (const r of reasons) if (!body.includes(r)) missing.push(`${f}: ${r}`);
    }
    assert.deepEqual(missing, [], 'bad examples shipped without their reason');
  });

  test('the contract demands a sentence, not merely a length', () => {
    // The old contract capped the clause at six words and said nothing about
    // language, which is how "schema done, 3 tables" became the normal output.
    const missing = [];
    for (const f of FILES) {
      const body = read(f);
      if (!body.includes('A real verb and a named subject')) missing.push(f);
    }
    assert.deepEqual(missing, [], 'agents whose contract is still length-only');
  });

  test('the superseded length-only rule is gone everywhere', () => {
    const stale = FILES.filter((f) => read(f).includes('One clause, six words or fewer'));
    assert.deepEqual(stale, [], 'agents still carrying the old length-only rule');
  });

  test('every agent can name any of the seven gates verbatim', () => {
    // The GATE marker is read aloud and is the only thing that tells the listener what
    // they are being asked to authorise, so the agent must have the exact wording to
    // copy. jarvis.sh deliberately does NOT validate the name -- the shell layer has no
    // access to the registry, and a second copy of the list is how two lists start
    // disagreeing. This test is what makes that safe.
    const SEVEN = [
      'destructive database changes',
      'production deployment',
      'destructive git operations',
      'deleting or overwriting an existing skill or agent',
      'changing the swarm architecture itself',
      'generating a new agent',
      'security-sensitive changes',
    ];
    const missing = [];
    for (const f of FILES) {
      const body = read(f);
      for (const g of SEVEN) if (!body.includes(g)) missing.push(`${f}: ${g}`);
    }
    assert.deepEqual(missing, [], 'agents that cannot name a gate they must refuse at');
  });

  test('the contract tells agents to emit GATE when they refuse', () => {
    const missing = FILES.filter((f) => {
      const b = read(f);
      return !b.includes('GATE: production deployment') || !b.includes('name the gate');
    });
    assert.deepEqual(missing, [], 'agents not told to name the gate they refused at');
  });

  test('the contract names each thing that does not survive being spoken', () => {
    const required = ['No file paths', 'No identifiers', 'No count without a noun', 'No symbols'];
    const missing = [];
    for (const f of FILES) {
      const body = read(f);
      for (const r of required) if (!body.includes(r)) missing.push(`${f}: ${r}`);
    }
    assert.deepEqual(missing, [], 'contract rules missing from generated agents');
  });
});
