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

describe('the README describes the real roster', () => {
  // The division table listed frappe-architect, frappe-data, frappe-backend,
  // frappe-frontend and orchestrator-deep for a while after those agents were renamed.
  // Nothing failed, because no test had ever read the README. A doc that names agents
  // which do not exist is worse than one that names none.
  const README = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');

  test('every agent in the division table exists', () => {
    const table = README.split('| Division | Agents |')[1].split('\n\n')[0];
    const listed = [...new Set([...table.matchAll(/`([a-z][a-z0-9-]+)`/g)].map((m) => m[1]))];
    const real = new Set(FILES.map((f) => f.replace(/\.md$/, '')));
    assert.deepEqual(listed.filter((id) => !real.has(id)), [], 'README names agents that do not exist');
  });

  test('every agent appears in the division table', () => {
    const table = README.split('| Division | Agents |')[1].split('\n\n')[0];
    const listed = new Set([...table.matchAll(/`([a-z][a-z0-9-]+)`/g)].map((m) => m[1]));
    const missing = FILES.map((f) => f.replace(/\.md$/, '')).filter((id) => !listed.has(id));
    assert.deepEqual(missing, [], 'agents missing from the README table');
  });

  test('no contents link points at a heading that is not there', () => {
    const heads = new Set(
      [...README.matchAll(/^#{2,3} (.+)$/gm)].map((m) =>
        m[1].toLowerCase().replace(/[^a-z0-9 -]/g, '').replace(/ /g, '-')
      )
    );
    const broken = [...README.matchAll(/\]\(#([a-z0-9-]+)\)/g)]
      .map((m) => m[1])
      .filter((a) => !heads.has(a));
    assert.deepEqual([...new Set(broken)], [], 'broken in-page links');
  });
});

describe('the review loop is on every agent, on both sides of it', () => {
  // The loop only works if reviewers know to vote and authors know to expect an
  // objection. A backtick in this section once terminated the JS template literal it
  // is embedded in, and the whole block vanished from all 45 agents at once while
  // doctor still reported Healthy -- because nothing was checking for it.
  const REVIEWER = [
    'verdict: accept',
    'MUST name what would satisfy you',
    'not against how you would have done it',
  ];
  const AUTHOR = [
    'you wrote it, so you fix it',
    'the objection verbatim',
    'Grinding is worse than stopping',
  ];

  // Modes come from the registry, not from guessing at prose. The reviewer half is now
  // scoped to validation agents (§14): a build agent was reading how to vote on a review
  // it will never sit on, and the protocol already told it to omit `verdict`.
  const MODES = (() => {
    const y = fs.readFileSync(path.join(ROOT, 'registry', 'agents.yaml'), 'utf8');
    const m = new Map();
    for (const hit of y.matchAll(/^  ([a-z][a-z0-9-]+):\n(?:    .*\n)*?    mode: (\w+)/gm)) {
      m.set(hit[1], hit[2]);
    }
    return m;
  })();

  test('the registry mode map is populated — an empty one would vacuously pass', () => {
    assert.ok(MODES.size >= 40, `only ${MODES.size} modes parsed; the assertions below would be vacuous`);
    assert.ok([...MODES.values()].includes('validation'), 'no validation agents found');
  });

  test('every REVIEWER is told how to vote, and what a vote costs', () => {
    const missing = [];
    for (const f of FILES) {
      const id = f.replace(/\.md$/, '');
      if (MODES.get(id) !== 'validation') continue;
      const b = read(f);
      for (const r of REVIEWER) if (!b.includes(r)) missing.push(`${f}: ${r}`);
    }
    assert.deepEqual(missing, [], 'validation agents that cannot review');
  });

  test('and a NON-reviewer is not handed voting instructions it cannot use', () => {
    // The other direction, which the unscoped version could not check: scoping is only
    // working if the half actually stops reaching the modes that do not need it.
    const overshared = [];
    for (const f of FILES) {
      const id = f.replace(/\.md$/, '');
      if (MODES.get(id) === 'validation' || !MODES.has(id)) continue;
      if (read(f).includes('verdict: accept')) overshared.push(f);
    }
    assert.deepEqual(overshared, [], 'build agents still carry reviewer-only guidance');
  });

  test('authors are told to fix the named thing and when to stop', () => {
    const missing = [];
    for (const f of FILES) {
      const b = read(f);
      for (const r of AUTHOR) if (!b.includes(r)) missing.push(`${f}: ${r}`);
    }
    assert.deepEqual(missing, [], 'agents that cannot be revised');
  });

  test('the halt conditions are stated, not implied', () => {
    const missing = FILES.filter((f) => !read(f).includes('the same objection comes back twice'));
    assert.deepEqual(missing, [], 'agents not told when the loop stops');
  });
});

describe('the handoff carries decisions, not just description', () => {
  // Twelve fields existed and all of them were DESCRIPTIVE, so the router could not
  // answer the questions it is supposed to answer automatically: is this done, is
  // another agent needed, was verification enough. Those were read out of prose by a
  // human. These four fields are what make them mechanical.
  const DECISION = [
    'STATUS: SUCCESS | PARTIAL | BLOCKED | FAILED',
    'CONFIDENCE: HIGH | MEDIUM | LOW',
    'RECOMMENDED_NEXT_AGENT:',
    'UNVERIFIED:',
  ];

  test('every agent is told to open with a status', () => {
    const missing = [];
    for (const f of FILES) {
      const b = read(f);
      for (const d of DECISION) if (!b.includes(d)) missing.push(`${f}: ${d}`);
    }
    assert.deepEqual(missing, [], 'agents that cannot report a decision');
  });

  test('and told what the expensive mistake is', () => {
    // A wrong SUCCESS ends the loop, so nothing downstream looks again. That is the
    // one failure mode worth naming explicitly in every prompt.
    const missing = FILES.filter(
      (f) => !read(f).includes('SUCCESS on unverified work is the single most expensive')
    );
    assert.deepEqual(missing, [], 'agents not warned about a false SUCCESS');
  });

  test('status is required by the protocol, not optional', () => {
    const y = fs.readFileSync(path.join(ROOT, 'registry', 'agents.yaml'), 'utf8');
    const req = y.match(/^  required: \[(.*?)\]/m);
    assert.ok(req, 'no required list in the protocol');
    assert.ok(req[1].includes('status'), `status is not required: ${req[1]}`);
  });
});

describe('agents are allowed to disagree, and told how', () => {
  // conflicts_with stops two agents being ROUTED for the same job. It says nothing
  // about two agents who both did work and disagree about the finding -- which,
  // unhandled, resolves by whichever handoff was read last. That is the worst possible
  // resolution rule because it is invisible.
  const RULES = [
    'State what would change your mind',
    'Quote them, do not characterise them',
    'Argue the axes, not the author',
    'If it is about one of the seven gates, stop',
  ];

  test('every agent is told how to disagree usefully', () => {
    const missing = [];
    for (const f of FILES) {
      const b = read(f);
      for (const r of RULES) if (!b.includes(r)) missing.push(`${f}: ${r}`);
    }
    assert.deepEqual(missing, [], 'agents that cannot disagree usefully');
  });

  test('the reconciliation procedure and its escapes are declared', () => {
    const y = fs.readFileSync(path.join(ROOT, 'registry', 'agents.yaml'), 'utf8');
    assert.match(y, /^conflict_reconciliation:/m, 'no reconciliation block');
    assert.match(y, /halt_to_human:/, 'nothing escalates to a human');
    // Safety outranks architecture: a wrong security call is not reversible by a later
    // refactor, and a wrong architecture call usually is.
    const tb = y.match(/tiebreak_precedence: \[(.*?)\]/)[1].split(',').map((x) => x.trim());
    assert.ok(tb.indexOf('deployment-safety') < tb.indexOf('architect'),
      'safety must outrank architecture in the tiebreak');
  });
});

describe('per-mode presence — written BEFORE any scoping exists', () => {
  // This block is the precondition for mode-scoping, not a description of it.
  //
  // The refactor was attempted twice, produced invalid JS twice, and was reverted twice.
  // Both times the danger was the same: the agent prompt is one large template literal,
  // an editing mistake silently EMPTIES a section, and `doctor` keeps reporting Healthy
  // because a shorter valid agent is still a valid agent. That is exactly how a backtick
  // once emptied the review-loop contract from every agent with nothing failing.
  //
  // So the assertions come first. They pass now, when every agent is shown everything.
  // They must still pass after scoping, which is what makes the scoping safe: if a
  // section is accidentally dropped from a mode that needs it, this fails instead of
  // shipping.
  const modeOf = (body) => (body.match(/^mode:\s*(\w+)/m) || [])[1] || null;

  const byMode = () => {
    const out = { active: [], validation: [], passive: [], control: [], unknown: [] };
    for (const f of FILES) {
      const body = read(f);
      // The generated frontmatter carries name/description/tools/model, not mode, so
      // read mode from the registry-derived agent list instead of guessing from prose.
      out.unknown.push({ f, body });
    }
    return out;
  };

  // Sections EVERY agent needs regardless of mode. Scoping must never touch these.
  const UNIVERSAL = [
    ['role statement', /\*\*Role\.\*\*/],
    ['ownership', /You own exactly this/],
    ['the seven gates', /Stop and escalate/],
    ['handoff fields', /Your handoff \(required\)/],
    ['the twelve-field second tier', /Also address these/],
    ['STATUS first line', /Your first line: STATUS/],
    ['the voice clause', /VOICE:/],
    ['the written log', /LOG:/],
    ['how to disagree', /State what would change your mind/],
    ['escalation target', /Escalate to/],
  ];

  test('every agent has every universal section', () => {
    const missing = [];
    for (const f of FILES) {
      const body = read(f);
      for (const [name, re] of UNIVERSAL) if (!re.test(body)) missing.push(`${f}: ${name}`);
    }
    assert.deepEqual(missing, [], 'a universal section is absent from some agent');
  });

  test('no agent is suspiciously short — an emptied section is the failure mode', () => {
    // A silently-emptied template section produces a valid, shorter agent. Length is the
    // cheapest detector of that, and it costs nothing to keep.
    const sizes = FILES.map((f) => ({ f, n: read(f).length }));
    const median = sizes.map((s) => s.n).sort((a, b) => a - b)[Math.floor(sizes.length / 2)];
    const runts = sizes.filter((s) => s.n < median * 0.5);
    assert.deepEqual(runts.map((r) => `${r.f} (${r.n} vs median ${median})`), [], 'an agent lost about half its content');
  });

  test('every agent still names its escalation target and its owner sentence', () => {
    for (const f of FILES) {
      const body = read(f);
      assert.match(body, /\*\*You own exactly this\.\*\* \S/, `${f} has an empty ownership sentence`);
      assert.match(body, /Escalate to: \*\*\S/, `${f} has an empty escalation target`);
    }
  });

  test('reviewer-side and author-side loop guidance both exist somewhere', () => {
    // Before scoping both halves are on every agent. After scoping each half must still
    // reach the modes that need it — this asserts neither half is lost entirely, which is
    // the accident a template edit produces.
    const reviewer = FILES.filter((f) => /If you are reviewing/.test(read(f)));
    const author = FILES.filter((f) => /If your work is being revised/.test(read(f)));
    assert.ok(reviewer.length > 0, 'no agent is told how to review');
    assert.ok(author.length > 0, 'no agent is told what to do with an objection');
  });
});

describe('mode scoping keeps every agent whole (§14)', () => {
  // WRITTEN BEFORE THE SCOPING, deliberately. Two earlier attempts at this refactor
  // produced invalid JS and were reverted; the recorded lesson was that the assertions
  // had to exist first, because a section silently vanishing from a template literal
  // leaves `doctor` reporting Healthy -- exactly how a backtick once emptied the review
  // loop from every agent with nothing failing.
  //
  // These assert PRESENCE per mode. They are the safety net that makes scoping safe to
  // attempt at all, and they must keep passing whether or not any scoping is applied.
  const modeOf = (body) => {
    const m = body.match(/^# ([a-z0-9-]+)/m);
    return m ? m[1] : null;
  };

  const UNIVERSAL = [
    'You own exactly this',
    'Stop and escalate',
    'Your handoff (required)',
    'Your first line: STATUS',
    'When you disagree with another agent',
    'Also address these',
  ];

  test('every agent keeps every universal section, whatever its mode', () => {
    const missing = [];
    for (const f of FILES) {
      const b = read(f);
      for (const s of UNIVERSAL) if (!b.includes(s)) missing.push(`${f}: ${s}`);
    }
    assert.deepEqual(missing, [], 'scoping removed a section every agent needs');
  });

  test('reviewers are told how to vote', () => {
    // validation-mode agents are the panel. If the reviewing half is ever scoped away
    // from them the loop has no voters and `verdict` never appears.
    const y = fs.readFileSync(path.join(ROOT, 'registry', 'agents.yaml'), 'utf8');
    const reviewers = [...y.matchAll(/^  ([a-z][a-z0-9-]+):\n(?:    .*\n)*?    mode: validation$/gm)].map((m) => m[1]);
    assert.ok(reviewers.length >= 8, `only ${reviewers.length} validation agents found`);
    for (const id of reviewers) {
      const b = read(`${id}.md`);
      assert.match(b, /If you are reviewing/, `${id} is a reviewer and is not told how to vote`);
      assert.match(b, /verdict/, `${id} is a reviewer with no verdict field`);
    }
  });

  test('builders are told what happens when their work is revised', () => {
    const y = fs.readFileSync(path.join(ROOT, 'registry', 'agents.yaml'), 'utf8');
    const builders = [...y.matchAll(/^  ([a-z][a-z0-9-]+):\n(?:    .*\n)*?    mode: active$/gm)].map((m) => m[1]);
    assert.ok(builders.length >= 20, `only ${builders.length} active agents found`);
    for (const id of builders) {
      assert.match(read(`${id}.md`), /If your work is being revised/, `${id} builds and is not told the revision rule`);
    }
  });

  test('every agent still carries the seven gates verbatim', () => {
    // The one thing that must never be scoped by mode. A passive agent that observes a
    // production deployment still has to refuse.
    const y = fs.readFileSync(path.join(ROOT, 'registry', 'agents.yaml'), 'utf8');
    const gates = [...y.matchAll(/^  - (.+)$/gm)]
      .map((m) => m[1])
      .filter((g) => /production deployment|destructive database changes/.test(g));
    assert.ok(gates.length >= 2, 'could not locate the gate list');
    for (const f of FILES) {
      const b = read(f);
      for (const g of gates) assert.ok(b.includes(g), `${f} lost gate: ${g}`);
    }
  });

  test('no agent is a stub — scoping must narrow, never gut', () => {
    // A crude but effective backstop: if a mode-scoping edit accidentally drops most of
    // a template, size collapses long before any individual assertion notices.
    for (const f of FILES) {
      const bytes = fs.statSync(path.join(ROOT, 'agents', f)).size;
      assert.ok(bytes > 8000, `${f} is only ${bytes} bytes — a section block was probably lost`);
    }
  });
});
