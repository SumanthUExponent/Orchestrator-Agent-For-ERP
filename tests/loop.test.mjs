/**
 * The loop driver's tests.
 *
 * The property under test is not "the code runs". It is that the driver REFUSES — that
 * every one of the four declared halt conditions actually fires, and that a handoff which
 * merely looks finished does not pass. A driver that says DONE too easily is worse than
 * no driver, because the coordinator stops looking.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHandoff, checkProtocol, objectionKey, sameObjection, verdict } from '../scripts/loop.mjs';

const PROTOCOL = {
  required: ['status', 'summary', 'voice', 'log', 'handoff'],
  when_applicable: ['objective', 'findings', 'testing', 'files_changed', 'dependencies', 'risks', 'questions'],
};
const LOOP = { rounds: 3, objection_must_state_remedy: true, revision_goes_to: 'original-author' };
const GATES = ['production deployment', 'destructive database changes'];

/** A handoff that should pass everything, so each test can spoil exactly one thing. */
const good = (over = {}) => {
  const f = {
    status: 'SUCCESS',
    summary: 'Added the Vendor Audit doctype.',
    objective: 'Add a Vendor Audit doctype.',
    findings: 'none',
    testing: 'run-tests: 4 passed, 0 failed',
    files_changed: 'vendor_audit.json',
    dependencies: 'none',
    risks: 'none',
    questions: 'none',
    handoff: 'nothing outstanding',
    confidence: 'HIGH',
    unverified: 'none',
    recommended_next_agent: 'none',
    ...over,
  };
  const body = Object.entries(f)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `- **${k}** — ${v}`)
    .join('\n');
  return `${body}\nVOICE: the Vendor Audit schema is in\nLOG: created the doctype; four tests pass.${over.__gate ? `\nGATE: ${over.__gate}` : ''}`;
};

const parse = (text, agent = 'builder') => parseHandoff(text, { agent });
const run = (handoffs, opts = {}) =>
  verdict({ handoffs, reviewLoop: LOOP, protocol: PROTOCOL, gates: GATES, ...opts });

describe('parsing what an agent actually returns', () => {
  test('reads all three label forms an agent might emit', () => {
    // The prompt shows the bolded form, agents type the plain form, and the decision
    // fields are uppercase markers. A parser that only handles one reports a protocol
    // violation for a compliant agent -- which teaches the coordinator to ignore it.
    const h = parse('- **status** — SUCCESS\nrisks: none\nCONFIDENCE: HIGH\nVOICE: it is in\nLOG: did it.');
    assert.equal(h.status, 'SUCCESS');
    assert.equal(h.fields.risks, 'none');
    assert.equal(h.confidence, 'HIGH');
    assert.equal(h.markers.voice, 'it is in');
  });

  test('a field value spanning several lines is not truncated', () => {
    const h = parse('- **testing** — ran the suite\n  4 passed, 0 failed\n\n- **status** — SUCCESS');
    assert.match(h.fields.testing, /4 passed/);
  });

  test('prose is not mistaken for fields', () => {
    const h = parse('I looked at this: it seemed fine.\n- **status** — SUCCESS');
    assert.equal(h.status, 'SUCCESS');
    assert.ok(!h.fields.i, 'a sentence opener was read as a field');
  });
});

describe('"none" is a claim; silence is not', () => {
  test('an omitted applicable field is missing, a "none" is not', () => {
    const omitted = parse(good({ risks: undefined }));
    assert.ok(checkProtocol(omitted, PROTOCOL).some((m) => m.field === 'risks'));
    const stated = parse(good({ risks: 'none' }));
    assert.deepEqual(checkProtocol(stated, PROTOCOL), []);
  });

  test('the twelve-field protocol is checked, not just the five required', () => {
    const bare = parse('- **status** — SUCCESS\n- **summary** — did it\n- **handoff** — none\nVOICE: done\nLOG: done.');
    const missing = checkProtocol(bare, PROTOCOL).map((m) => m.field);
    for (const f of PROTOCOL.when_applicable) assert.ok(missing.includes(f), `${f} not checked`);
  });
});

describe('the driver refuses', () => {
  test('"Done! Looks good." is not done', () => {
    const v = run([parse('Done! Looks good.')]);
    assert.equal(v.done, false);
    assert.ok(v.blocking.some((b) => b.kind === 'protocol'));
    assert.ok(v.blocking.some((b) => b.kind === 'status'));
  });

  test('SUCCESS with a non-empty unverified is not done', () => {
    // The protocol calls this the most expensive thing an agent can write. Reading the
    // status and stopping is exactly the mistake -- so the driver reads both.
    const v = run([parse(good({ unverified: 'nothing was run; no migration' }))]);
    assert.equal(v.done, false);
    assert.ok(v.blocking.some((b) => b.kind === 'unverified'), 'unverified SUCCESS passed');
  });

  test('PARTIAL is not done however good the review was', () => {
    const v = run([parse(good({ status: 'PARTIAL', remaining: 'the child table' })), parse(good({ verdict: 'accept' }), 'reviewer')]);
    assert.equal(v.done, false);
    assert.ok(v.blocking.some((b) => b.kind === 'status'));
  });

  test('LOW confidence asks for another pair of eyes', () => {
    const v = run([parse(good({ confidence: 'LOW' }))]);
    assert.equal(v.done, false);
  });

  test('a reviewer on the panel who returned no verdict is a missing review, not a tacit yes', () => {
    const v = run([parse(good()), parse(good({ verdict: '' }), 'reviewer')]);
    assert.equal(v.done, false);
    assert.ok(v.blocking.some((b) => b.kind === 'no-verdict'));
  });

  test('revise without a remedy is an opinion, and is called one', () => {
    const v = run([parse(good({ verdict: 'revise' }), 'reviewer')]);
    assert.ok(v.blocking.some((b) => b.kind === 'objection-without-remedy'));
  });

  test('nothing returned is not done', () => {
    const v = run([]);
    assert.equal(v.done, false);
    assert.ok(v.blocking.some((b) => b.kind === 'no-handoffs'));
  });
});

describe('the driver accepts, but only on evidence', () => {
  test('verified work plus an accepting reviewer is done', () => {
    const v = run([parse(good()), parse(good({ verdict: 'accept' }), 'reviewer')]);
    assert.equal(v.done, true, v.reason);
  });

  test('clean work with no panel convened is done, and says so', () => {
    const v = run([parse(good())]);
    assert.equal(v.done, true, v.reason);
    assert.match(v.reason, /no panel/);
  });
});

describe('the four halt conditions all fire', () => {
  test('a human gate halts, and outranks unanimous acceptance', () => {
    const v = run([parse(good({ status: 'BLOCKED', __gate: 'production deployment' })), parse(good({ verdict: 'accept' }), 'reviewer')]);
    assert.equal(v.done, false, 'a crossed gate was allowed to read as done');
    assert.ok(v.halt.some((h) => h.kind === 'human-gate'));
  });

  test('a gate named in handoff without the marker is still caught', () => {
    const v = run([parse(good({ status: 'BLOCKED', handoff: 'needs sign-off for production deployment' }))]);
    assert.ok(v.halt.some((h) => h.kind === 'human-gate'), 'only the marker was honoured');
  });

  test('the round cap halts with items still open', () => {
    const v = run([parse(good({ status: 'FAILED' }))], { round: 3 });
    assert.ok(v.halt.some((h) => h.kind === 'round-cap'));
  });

  test('the cap does NOT halt a clean round', () => {
    const v = run([parse(good())], { round: 3 });
    assert.equal(v.done, true, 'a clean final round was reported as a cap halt');
  });

  test('the same objection, reworded, halts for no progress', () => {
    const first = 'the child table has no parent link so rows orphan on delete';
    const again = 'the child table STILL has no parent link, so rows will orphan on delete';
    const r1 = run([parse(good({ verdict: `revise ${first}` }), 'reviewer')]);
    const r2 = run([parse(good({ verdict: `revise ${again}` }), 'reviewer')], { round: 2, history: r1.history });
    assert.ok(r2.halt.some((h) => h.kind === 'no-progress'), 'a reworded repeat read as progress');
  });

  test('a genuinely new objection does NOT halt', () => {
    // The failure that matters in the other direction: a threshold loose enough to catch
    // rewording must not collapse two different objections about the same subsystem.
    const r1 = run([parse(good({ verdict: 'revise the child table has no parent link' }), 'reviewer')]);
    const r2 = run([parse(good({ verdict: 'revise the permission matrix omits the Sales Manager role' }), 'reviewer')], {
      round: 2,
      history: r1.history,
    });
    assert.ok(!r2.halt.some((h) => h.kind === 'no-progress'), 'a new objection was treated as a repeat');
  });
});

describe('objection similarity', () => {
  test('rewording is the same objection', () => {
    assert.ok(sameObjection(objectionKey('the child table has no parent link so rows orphan'), objectionKey('the child table STILL has no parent link, so rows will orphan')));
  });

  test('different objections about the same subsystem are not', () => {
    assert.ok(!sameObjection(objectionKey('the child table has no parent link'), objectionKey('the child table is missing an index on parent')));
  });

  test('empty never matches, so a blank verdict cannot fake no-progress', () => {
    assert.ok(!sameObjection('', ''));
    assert.ok(!sameObjection(objectionKey('anything'), ''));
  });
});

describe('who picks it up next', () => {
  test('not-done always names someone', () => {
    const v = run([parse(good({ unverified: 'no migration run' }))]);
    assert.equal(v.done, false);
    assert.ok(v.next, 'refused without naming who should act');
  });
});

describe('claimed done, produced nothing (the empty-patch check)', () => {
  // OpenHands' cheapest critic: "the agent said done but there is no diff" is a
  // deterministic, zero-model-cost false-completion detector. The driver checked status,
  // evidence shape and protocol compliance -- never whether anything changed.
  //
  // Stated as an OR, because a reviewer legitimately writes nothing: it produces findings.
  // A builder produces files. Producing NEITHER and reporting SUCCESS is the empty patch.

  test('SUCCESS with no files and no findings is refused', () => {
    const v = run([parse(good({ files_changed: 'none', findings: 'none' }))]);
    assert.equal(v.done, false);
    assert.ok(v.blocking.some((b) => b.kind === 'empty-patch'), 'an empty patch passed as done');
  });

  test('a builder that changed files is fine', () => {
    const v = run([parse(good({ files_changed: 'vendor_audit.json', findings: 'none' }))]);
    assert.ok(!v.blocking.some((b) => b.kind === 'empty-patch'));
  });

  test('a reviewer with findings and no files is fine — that is the job', () => {
    const v = run([parse(good({ files_changed: 'none', findings: 'the permission check is bypassable' }))]);
    assert.ok(!v.blocking.some((b) => b.kind === 'empty-patch'), 'a reviewer was penalised for writing nothing');
  });

  test('it does not fire on a non-SUCCESS status', () => {
    // BLOCKED with nothing produced is already reported as BLOCKED. Saying it twice
    // teaches nothing and trains the reader to skim.
    const v = run([parse(good({ status: 'BLOCKED', files_changed: 'none', findings: 'none' }))]);
    assert.ok(!v.blocking.some((b) => b.kind === 'empty-patch'));
  });

  test('it does not fire when the fields were merely omitted', () => {
    // An omitted field is already a protocol violation. Reporting it as an empty patch as
    // well would double-count one defect and obscure which one to fix.
    const v = run([parse(good({ files_changed: undefined, findings: undefined }))]);
    assert.ok(v.blocking.some((b) => b.kind === 'protocol'), 'the omission was not caught at all');
    assert.ok(!v.blocking.some((b) => b.kind === 'empty-patch'));
  });
});
