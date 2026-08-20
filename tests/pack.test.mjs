/**
 * Context-pack scoping (§14).
 *
 * The property that matters is NOT "the scoped pack is smaller". It is that no agent
 * silently loses a section it needs, and that a withheld section never reads as an empty
 * one — because an agent that reads "DocTypes: none found" when the list was merely
 * withheld will conclude there are no DocTypes, which is worse than sending it the
 * whole pack.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { render, ROLE_SCOPES, ROLE_ALIASES, SCOPABLE, collect } from '../scripts/pack.mjs';
import { ROOT } from '../scripts/jarvis.mjs';

let tmp;
let logged;
let realLog;

before(() => {
  // A tree with something in every scopable section, so a withheld section is
  // distinguishable from a genuinely empty one.
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-pack-'));
  const mk = (p, body = '{}') => {
    fs.mkdirSync(path.dirname(path.join(tmp, p)), { recursive: true });
    fs.writeFileSync(path.join(tmp, p), body);
  };
  // Kept shallow deliberately: `walk` caps at depth 5, and a fixture nested deeper is
  // invisible to it -- which reads as "the code stopped finding doctypes" rather than
  // "the fixture was too deep". Cost one debugging round to learn.
  mk('demo_app/hooks.py', '# hooks');
  mk('demo_app/doctype/widget/widget.json', '{"name":"Widget"}');
  mk('demo_app/report/widget_ledger/widget_ledger.json', '{"report_name":"x"}');
  mk('demo_app/page/widget_board/widget_board.json', '{"name":"y"}');
});

after(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** Capture what render() prints, since it writes to the console by design. */
const capture = (role) => {
  const lines = [];
  realLog = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  try {
    render(tmp, role ? { role } : {});
  } finally {
    console.log = realLog;
  }
  return lines.join('\n');
};

describe('the full pack is unchanged', () => {
  test('no role means every section, exactly as before', () => {
    // Scoping is opt-in. The default must not have moved -- every existing caller,
    // including the SessionStart hook, passes no role.
    const out = capture(null);
    for (const s of ['Apps', 'DocTypes', 'Reports', 'Pages']) {
      assert.match(out, new RegExp(`\\*\\*${s}\\*\\*`), `${s} missing from the unscoped pack`);
    }
    assert.ok(!out.includes('Scoped to'), 'an unscoped pack claimed to be scoped');
  });
});

describe('a scoped pack withholds only what the role does not need', () => {
  test('ui-designer gets pages, not the DocType inventory', () => {
    const out = capture('ui-designer');
    assert.match(out, /\*\*Pages\*\*/, 'a UI role lost the page list');
    assert.ok(!/\*\*DocTypes\*\*/.test(out), 'a UI role was handed the DocType inventory');
  });

  test('schema roles get DocTypes', () => {
    const out = capture('schema-builder');
    assert.match(out, /\*\*DocTypes\*\*/, 'a schema role lost the DocType list');
  });

  test('reporting roles get reports', () => {
    assert.match(capture('reporting-developer'), /\*\*Reports\*\*/);
  });

  test('impact-analyst gets the whole surface — that is the job', () => {
    const out = capture('impact-analyst');
    for (const s of ['Apps', 'DocTypes', 'Reports', 'Pages']) {
      assert.match(out, new RegExp(`\\*\\*${s}\\*\\*`), `impact analysis lost ${s}`);
    }
  });
});

describe('a withheld section never reads as an empty one', () => {
  test('the pack names what it withheld and how to get it', () => {
    // The defect this prevents: an agent reading an ABSENT list as an EMPTY list and
    // concluding the thing does not exist. Same class as the truncation warning.
    const out = capture('ui-designer');
    assert.match(out, /Scoped to `ui-designer`/);
    assert.match(out, /Withheld as not relevant/);
    assert.match(out, /NOT an empty one/);
    assert.match(out, /doctypes/, 'withheld sections were not named');
  });

  test('a role that needs everything gets no misleading withheld notice', () => {
    const out = capture('impact-analyst');
    assert.ok(!/Withheld as not relevant/.test(out), 'claimed to withhold nothing while listing withholdings');
  });
});

describe('the mapping cannot rot silently', () => {
  test('every mapped role names only scopable sections', () => {
    const ok = new Set(SCOPABLE);
    for (const [role, sections] of Object.entries(ROLE_SCOPES)) {
      assert.ok(sections.length, `${role} maps to an empty scope — that is a blind agent, not a narrow one`);
      for (const s of sections) {
        assert.ok(ok.has(s), `${role} names "${s}", which is not a scopable section (typo = silently withheld)`);
      }
    }
  });

  test('every mapped role is a real agent', () => {
    // A typo'd role never matches, so the agent silently receives the full pack and the
    // scoping looks like it is working. This is the only thing that catches that.
    // NOT `new URL(import.meta.url).pathname` — on Windows that is "/D:/a/..." and
    // path.resolve prepends the drive again, giving "D:\\D:\\a\\...". The repo already
    // exports a correctly-resolved ROOT; reuse it rather than re-deriving it wrongly.
    const ids = new Set(
      fs.readdirSync(path.join(ROOT, 'agents')).filter((f) => f.endsWith('.md')).map((f) => f.replace(/\.md$/, ''))
    );
    const ghosts = Object.keys(ROLE_SCOPES).filter((r) => !ids.has(r));
    // Every non-agent must be a DECLARED alias. A count-based tolerance ("at most four
    // unknown names") passes for a typo exactly as happily as for an alias, and a typo'd
    // role falls back to the full pack -- which is indistinguishable from scoping working.
    const undeclared = ghosts.filter((g) => !ROLE_ALIASES.has(g));
    assert.deepEqual(undeclared, [], 'roles mapped that are neither agents nor declared aliases');
    for (const a of ROLE_ALIASES) {
      assert.ok(ROLE_SCOPES[a], `alias "${a}" is declared but maps to no scope, so it does nothing`);
    }
  });

  test('an unmapped role gets the full pack rather than a guess', () => {
    const out = capture('some-agent-nobody-mapped');
    for (const s of ['Apps', 'DocTypes', 'Reports', 'Pages']) {
      assert.match(out, new RegExp(`\\*\\*${s}\\*\\*`), `an unmapped role was silently narrowed, losing ${s}`);
    }
  });
});

describe('collect is unaffected', () => {
  test('scoping is a render concern; the walk still finds everything', () => {
    const p = collect(tmp);
    assert.ok(p.doctypes.length, 'the walk stopped finding doctypes');
    assert.ok(p.reports.length, 'the walk stopped finding reports');
  });
});
