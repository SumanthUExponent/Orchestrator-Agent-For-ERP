/**
 * Voice layer test suite.
 *
 * The risk here is not that the voice sounds wrong — that is a matter of taste and
 * a human ear. The risk is settings.json: it is the one file that decides whether
 * Claude Code starts, it already holds the JARVIS routing gate and context
 * pack, and a malformed hook does not report an error. It simply stops arriving.
 *
 * So these tests are about the merge, not the audio. The audio behaviour — queueing,
 * coalescing, one daemon under parallel load — needs genuine concurrency and lives
 * in tests/voice-concurrency.sh (`npm run test:voice`).
 *
 * Run: node --test tests/
 */

import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ROOT } from '../scripts/jarvis.mjs';
import { installVoice, mergeHooks, stripJarvis, hookCommand, HOOKS } from '../scripts/voice.mjs';

let tmp;
const SETTINGS = () => path.join(tmp, 'settings.json');
const TARGET = () => path.join(tmp, 'jarvis');

// A realistic starting point: JARVIS's own two hooks are already there.
// Installing the voice layer over them must leave both completely alone.
const ROUTING_SETTINGS = {
  model: 'opus[1m]',
  hooks: {
    UserPromptSubmit: [{ hooks: [{ type: 'command', timeout: 5, command: "echo '{\"hookSpecificOutput\":{\"additionalContext\":\"ROUTING GATE\"}}'" }] }],
    SessionStart: [{ hooks: [{ type: 'command', timeout: 15, command: 'node ~/.claude/skills/jarvis/scripts/jarvis.mjs pack "$PWD"' }] }],
  },
};

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-voice-'));
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
beforeEach(() => {
  fs.rmSync(TARGET(), { recursive: true, force: true });
  fs.writeFileSync(SETTINGS(), JSON.stringify(ROUTING_SETTINGS, null, 2));
});

const run = (opts = {}) => installVoice({ root: ROOT, target: TARGET(), settings: SETTINGS(), ...opts });
const read = () => JSON.parse(fs.readFileSync(SETTINGS(), 'utf8'));
const commands = (s) =>
  Object.values(s.hooks || {}).flatMap((gs) => gs.flatMap((g) => g.hooks.map((h) => h.command)));
const jarvisCmds = (s) => commands(s).filter((c) => c.includes('jarvis.sh'));

describe('the shipped scripts are valid shell', () => {
  // A syntax error here is silent in production: the hook exits non-zero, Claude
  // Code carries on, and the layer simply never speaks.
  for (const f of ['jarvis.sh', 'speaker.sh', 'jarvisctl']) {
    test(`${f} parses`, () => {
      execFileSync('bash', ['-n', path.join(ROOT, 'voice', f)], { stdio: 'pipe' });
    });
  }
  test('every hook argument the installer registers is handled by jarvis.sh', () => {
    // Registering an event whose argument falls through the case statement is
    // invisible: the hook fires, the script exits 0, and nothing is ever announced.
    const src = fs.readFileSync(path.join(ROOT, 'voice', 'jarvis.sh'), 'utf8');
    const handled = new Set();
    for (const m of src.matchAll(/^\s{2}([a-z|]+)\)/gm)) m[1].split('|').forEach((a) => handled.add(a));
    for (const h of HOOKS) assert.ok(handled.has(h.arg), `jarvis.sh has no branch for "${h.arg}"`);
  });
  test('the hook never speaks — only the daemon does', () => {
    // The whole architecture rests on this. One `say` in the hook and four parallel
    // sessions talk over each other again.
    const src = fs.readFileSync(path.join(ROOT, 'voice', 'jarvis.sh'), 'utf8');
    assert.ok(!/^[^#\n]*\bsay\b/m.test(src), 'jarvis.sh calls say directly');
    assert.ok(!/^[^#\n]*\bafplay\b/m.test(src), 'jarvis.sh calls afplay directly');
  });
});

describe('settings.json merge', () => {
  test('the JARVIS routing hooks survive untouched', () => {
    // The failure this prevents: the swarm goes quiet, the routing gate stops
    // arriving, and nothing anywhere reports why.
    const r = run({ apply: true });
    const after = read();
    const gate = commands(after).find((c) => c.includes('ROUTING GATE'));
    const pack = commands(after).find((c) => c.includes('jarvis.mjs pack'));
    assert.ok(gate, 'the UserPromptSubmit routing gate was destroyed');
    assert.ok(pack, 'the SessionStart context pack was destroyed');
    assert.equal(r.foreign, 2, 'foreign hook count misreported');
  });

  test('all eight events are registered', () => {
    run({ apply: true });
    const after = read();
    for (const h of HOOKS) {
      assert.ok(after.hooks[h.event], `${h.event} not registered`);
      const found = after.hooks[h.event].some((g) => g.hooks.some((x) => x.command.endsWith(` ${h.arg}`)));
      assert.ok(found, `${h.event} has no entry for "${h.arg}"`);
    }
    assert.equal(jarvisCmds(after).length, HOOKS.length);
  });

  test('re-running does not accumulate duplicates', () => {
    run({ apply: true });
    run({ apply: true });
    run({ apply: true });
    assert.equal(jarvisCmds(read()).length, HOOKS.length, 'hooks multiplied across installs');
  });

  test('a jarvis install at an OLD path is replaced, not left alongside', () => {
    // The first cut of this lived in ~/.claude/hooks/jarvis.sh. Matching on the
    // command string rather than the path means a move self-heals; matching on
    // position would leave both copies registered and everything said twice.
    const s = read();
    s.hooks.Stop = [{ matcher: '', hooks: [{ type: 'command', command: '"/Users/x/.claude/hooks/jarvis.sh" done' }] }];
    fs.writeFileSync(SETTINGS(), JSON.stringify(s));
    run({ apply: true });
    const cmds = jarvisCmds(read());
    assert.equal(cmds.length, HOOKS.length, 'the old entry was kept as well as the new one');
    assert.ok(!cmds.some((c) => c.includes('.claude/hooks/jarvis.sh')), 'old path still registered');
  });

  test('SessionEnd declares a timeout, or the goodbye is cut off', () => {
    // SessionEnd hooks share a 1.5s budget unless a timeout is set. The line is
    // longer than that, so without this it is truncated mid-word.
    run({ apply: true });
    const entry = read().hooks.SessionEnd.flatMap((g) => g.hooks).find((h) => h.command.includes('jarvis.sh'));
    assert.ok(entry.timeout >= 5, `SessionEnd timeout is ${entry.timeout}`);
  });

  test('a backup is written before the file is touched', () => {
    const r = run({ apply: true });
    assert.ok(fs.existsSync(r.backup), 'no backup');
    assert.deepEqual(JSON.parse(fs.readFileSync(r.backup, 'utf8')), ROUTING_SETTINGS);
  });

  test('the result is still valid JSON', () => {
    run({ apply: true });
    assert.doesNotThrow(() => read());
  });

  test('invalid settings.json is refused, not overwritten', () => {
    fs.writeFileSync(SETTINGS(), '{ this is not json');
    assert.throws(() => run({ apply: true }), /not valid JSON/);
    assert.equal(fs.readFileSync(SETTINGS(), 'utf8'), '{ this is not json', 'clobbered a file it could not parse');
  });

  test('a missing settings.json is created rather than fatal', () => {
    fs.rmSync(SETTINGS());
    run({ apply: true });
    assert.equal(jarvisCmds(read()).length, HOOKS.length);
  });
});

describe('dry run', () => {
  test('writes nothing at all', () => {
    const before = fs.readFileSync(SETTINGS(), 'utf8');
    const r = run({ apply: false });
    assert.equal(fs.readFileSync(SETTINGS(), 'utf8'), before, 'dry run modified settings.json');
    assert.equal(fs.existsSync(TARGET()), false, 'dry run wrote scripts');
    assert.equal(r.applied, false);
  });

  test('but reports the same hook count apply would write', () => {
    const dry = run({ apply: false });
    const real = run({ apply: true });
    assert.equal(dry.added, real.added);
    assert.equal(dry.written.length, real.written.length);
  });
});

describe('config.sh is the user\'s file', () => {
  test('an upgrade keeps their edits', () => {
    run({ apply: true });
    const cfg = path.join(TARGET(), 'config.sh');
    fs.appendFileSync(cfg, '\nJARVIS_VOICE="Oliver"\n');
    run({ apply: true });
    assert.match(fs.readFileSync(cfg, 'utf8'), /Oliver/, 'the upgrade reverted their voice');
  });

  test('but the scripts are always refreshed, or a fixed bug never lands', () => {
    run({ apply: true });
    const s = path.join(TARGET(), 'speaker.sh');
    fs.writeFileSync(s, '#!/bin/bash\n# stale\n');
    run({ apply: true });
    assert.ok(!fs.readFileSync(s, 'utf8').includes('# stale'), 'speaker.sh was not refreshed');
  });

  test('--force resets config.sh to the shipped defaults', () => {
    run({ apply: true });
    const cfg = path.join(TARGET(), 'config.sh');
    fs.appendFileSync(cfg, '\nJARVIS_VOICE="Oliver"\n');
    run({ apply: true, force: true });
    assert.ok(!fs.readFileSync(cfg, 'utf8').includes('Oliver'));
  });

  test('the scripts land executable', (t) => {
    // Windows has no execute bit — the mode is always 0o666 — and the hooks there
    // invoke `bash <script>` rather than executing it directly, so there is nothing
    // to assert. Skipping is honest; asserting would fail for a working install.
    if (process.platform === 'win32') return t.skip('no execute bit on Windows');
    run({ apply: true });
    for (const f of ['jarvis.sh', 'speaker.sh', 'jarvisctl']) {
      assert.ok(fs.statSync(path.join(TARGET(), f)).mode & 0o111, `${f} is not executable`);
    }
  });
});

describe('the hook command is executable on the platform it targets', () => {
  test('unix gets the bare quoted path', () => {
    assert.equal(hookCommand('/home/me/.claude/jarvis/jarvis.sh', 'done', 'linux'), '"/home/me/.claude/jarvis/jarvis.sh" done');
    assert.equal(hookCommand('/Users/me/.claude/jarvis/jarvis.sh', 'done', 'darwin'), '"/Users/me/.claude/jarvis/jarvis.sh" done');
  });

  test('windows names bash and uses forward slashes', () => {
    // The bare path fails twice on Windows: cmd.exe cannot execute a .sh, and a shell
    // that can would read `C:\Users\...` backslashes as escapes. Naming bash works
    // whether the hook is handed to cmd.exe or to a shell.
    const c = hookCommand('C:\\Users\\me\\.claude\\jarvis\\jarvis.sh', 'done', 'win32');
    assert.equal(c, 'bash "C:/Users/me/.claude/jarvis/jarvis.sh" done');
    assert.ok(!c.includes('\\'), 'a backslash survived into the hook command');
  });

  test('every platform still contains "jarvis", or the installer cannot find its own hooks', () => {
    // stripJarvis matches on the command string. If a platform ever produced a command
    // without that substring, re-running the installer would stop replacing its own
    // entries and start accumulating duplicates instead.
    for (const p of ['linux', 'darwin', 'win32']) {
      assert.ok(hookCommand('/x/.claude/jarvis/jarvis.sh', 'done', p).includes('jarvis.sh'));
    }
  });

  test('a windows merge is still idempotent', () => {
    const s = JSON.parse(JSON.stringify(ROUTING_SETTINGS));
    mergeHooks(s, 'C:\\Users\\me\\.claude\\jarvis\\jarvis.sh', 'win32');
    mergeHooks(s, 'C:\\Users\\me\\.claude\\jarvis\\jarvis.sh', 'win32');
    assert.equal(jarvisCmds(s).length, HOOKS.length, 'hooks multiplied on Windows');
  });
});

describe('stripJarvis', () => {
  test('removes only jarvis entries from a shared group', () => {
    const hooks = {
      Stop: [{ matcher: '', hooks: [{ command: '"/x/jarvis.sh" done' }, { command: 'echo keep-me' }] }],
    };
    const removed = stripJarvis(hooks);
    assert.equal(removed, 1);
    assert.deepEqual(hooks.Stop[0].hooks, [{ command: 'echo keep-me' }]);
  });

  test('drops a group that becomes empty, and the event with it', () => {
    const hooks = { Stop: [{ matcher: '', hooks: [{ command: '"/x/jarvis.sh" done' }] }] };
    stripJarvis(hooks);
    assert.equal(hooks.Stop, undefined, 'left an empty array behind');
  });

  test('is safe on an event with no hooks array', () => {
    const hooks = { Stop: [{ matcher: '' }] };
    assert.doesNotThrow(() => stripJarvis(hooks));
  });
});

describe('mergeHooks is pure enough to preview', () => {
  test('merging a copy does not touch the original', () => {
    const original = JSON.parse(JSON.stringify(ROUTING_SETTINGS));
    const copy = JSON.parse(JSON.stringify(original));
    mergeHooks(copy, '/x/jarvis.sh');
    assert.deepEqual(original, ROUTING_SETTINGS, 'the source object was mutated');
    assert.equal(jarvisCmds(copy).length, HOOKS.length);
  });
});

describe('documented defaults are the real defaults', () => {
  // config.sh is deliberately NOT overwritten on upgrade, so that a user's edits survive.
  // The consequence is easy to miss: for anyone who already has a config.sh, a newly
  // added setting never appears in theirs, and the EFFECTIVE default is the inline
  // `${VAR:-fallback}` in the scripts — not the value config.sh documents.
  //
  // That is exactly how JARVIS_SUMMARY_MAX came to be documented as 1 and behave as 2.
  // This test compares the two and fails on any divergence.
  const read = (f) => fs.readFileSync(path.join(ROOT, 'voice', f), 'utf8');
  const SCRIPTS = ['jarvis.sh', 'speaker.sh', 'platform.sh', 'jarvisctl', 'pronounce.sh'];

  // Where a divergence is intentional, it is named here with the reason.
  const EXEMPT = {
    // Not settings: internal flags with no place in a user's config.
    JARVIS_LIB: 'internal — selects library mode when sourcing speaker.sh',
    JARVIS_SESSION_KEY: 'per-invocation override, never configured globally',
    JARVIS_SESSION_NAME: 'per-invocation override, never configured globally',
    // Platform-specific and only meaningful on Linux, so config.sh does not carry it.
    JARVIS_VOICE_LINUX: 'espeak voice id, Linux only',
    // The one genuine tension. config.sh names a macOS voice because that is the
    // platform whose stock voices are worth overriding, but the scripts must fall back
    // to EMPTY — a macOS voice name passed to espeak or SAPI selects nothing, and empty
    // now carries meaning of its own: use the platform's own System Voice, which is the
    // only way to reach a Siri voice.
    JARVIS_VOICE: 'default is platform-specific; empty means the System Voice',
  };

  const configDefaults = () => {
    const out = new Map();
    // Trailing comments are the norm in config.sh, so the line must not be anchored at
    // the closing quote — anchoring there made three declared settings look undeclared.
    for (const m of read('config.sh').matchAll(/^(JARVIS_[A-Z_]+)="\$\{\1:-(.*?)\}"\s*(?:#.*)?$/gm)) {
      out.set(m[1], m[2]);
    }
    return out;
  };

  test('config.sh declares a default for every setting the scripts fall back on', () => {
    const declared = configDefaults();
    const missing = [];
    for (const f of SCRIPTS) {
      for (const m of read(f).matchAll(/\$\{(JARVIS_[A-Z_]+):-/g)) {
        const name = m[1];
        if (EXEMPT[name] || declared.has(name)) continue;
        missing.push(`${name} (used in ${f})`);
      }
    }
    assert.deepEqual([...new Set(missing)], [], 'settings with no documented default');
  });

  test('and every inline fallback agrees with it', () => {
    const declared = configDefaults();
    const clashes = [];
    for (const f of SCRIPTS) {
      // Only simple literal fallbacks are comparable; a fallback containing a command
      // substitution is computed, not a default.
      for (const m of read(f).matchAll(/\$\{(JARVIS_[A-Z_]+):-([^}$]*)\}/g)) {
        const [, name, fallback] = m;
        if (EXEMPT[name] || !declared.has(name)) continue;
        // A message string rather than a value — "unset" in a diagnostic line.
        if (fallback === 'unset') continue;
        if (declared.get(name) !== fallback) {
          clashes.push(`${name}: config.sh says "${declared.get(name)}", ${f} falls back to "${fallback}"`);
        }
      }
    }
    assert.deepEqual([...new Set(clashes)], [], 'documented default differs from effective default');
  });

  test('the test itself is looking at something', () => {
    // A regex that silently matches nothing would make both assertions above vacuous.
    // A regex that silently matched nothing, or only some, would make both assertions
    // above vacuous — which is how the first version of this test passed while missing
    // every setting that carried a trailing comment.
    const n = configDefaults().size;
    assert.ok(n >= 15, `only found ${n} declared defaults — the matcher is missing lines`);
  });
});
