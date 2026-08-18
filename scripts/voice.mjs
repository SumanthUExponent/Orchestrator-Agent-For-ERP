/**
 * Voice layer installer — place the JARVIS scripts and register the hooks.
 *
 * Same posture as install.mjs: DRY RUN by default, nothing written without
 * --apply. This one edits ~/.claude/settings.json, which is the single file that
 * decides whether Claude Code works at all, so it is more cautious than the rest:
 *
 *   - it backs the file up before touching it
 *   - it merges, never replaces. The orchestrator's own UserPromptSubmit routing
 *     gate and SessionStart context pack live in the same arrays; clobbering them
 *     would silently disable the swarm while appearing to succeed
 *   - it is IDEMPOTENT. Prior jarvis entries are removed before the new ones are
 *     added, matched on the command string rather than on position, so re-running
 *     it cannot accumulate duplicates and a moved script path self-heals
 *   - it writes the file atomically (temp + rename). A settings.json truncated
 *     halfway through a write is an unrecoverable start-up failure
 *
 * A malformed settings.json does not report an error — the hook simply stops
 * arriving. So the JSON is re-parsed from disk after writing, and the backup is
 * restored if it does not survive the round trip.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const SCRIPTS = ['jarvis.sh', 'speaker.sh', 'jarvisctl'];
const EXECUTABLE = new Set(SCRIPTS);

/** Every hook the voice layer registers. Order here is the order written. */
export const HOOKS = [
  { event: 'SessionStart', matcher: '', arg: 'start', why: 'greet, and start the clock' },
  { event: 'UserPromptSubmit', matcher: '', arg: 'begin', why: 'restart the clock; clear pending approval' },
  { event: 'Stop', matcher: '', arg: 'done', why: 'announce completion, gated on elapsed time' },
  { event: 'Notification', matcher: 'permission_prompt', arg: 'permission', why: 'blocked on approval — the expensive failure' },
  { event: 'Notification', matcher: 'idle_prompt', arg: 'idle', why: 'waiting on you' },
  { event: 'SubagentStop', matcher: '', arg: 'subagent', why: 'count specialists; chime per batch' },
  { event: 'StopFailure', matcher: '', arg: 'error', why: 'API error (NOT a failed tool call)' },
  // SessionEnd hooks share a 1.5s budget unless a timeout is declared, and the
  // goodbye line is longer than that, so it gets cut off mid-word without this.
  { event: 'SessionEnd', matcher: '', arg: 'end', timeout: 8, why: 'goodbye, once the last session closes' },
];

export function jarvisDir() {
  return process.env.CLAUDE_JARVIS_DIR || path.join(os.homedir(), '.claude', 'jarvis');
}
export function settingsFile() {
  return process.env.CLAUDE_SETTINGS_FILE || path.join(os.homedir(), '.claude', 'settings.json');
}

/**
 * Strip every hook entry that refers to jarvis, at the HOOK level rather than the
 * group level, so a group we share with the orchestrator keeps its other entries.
 * Returns the number removed.
 */
export function stripJarvis(hooks) {
  let removed = 0;
  for (const event of Object.keys(hooks)) {
    const groups = Array.isArray(hooks[event]) ? hooks[event] : [];
    const kept = [];
    for (const g of groups) {
      const before = (g.hooks || []).length;
      g.hooks = (g.hooks || []).filter((h) => !String(h.command || '').includes('jarvis'));
      removed += before - g.hooks.length;
      if (g.hooks.length) kept.push(g);
    }
    if (kept.length) hooks[event] = kept;
    else delete hooks[event];
  }
  return removed;
}

/** Merge our hooks into a settings object, in place. Idempotent by construction. */
export function mergeHooks(settings, script) {
  const hooks = settings.hooks || (settings.hooks = {});
  const removed = stripJarvis(hooks);
  for (const h of HOOKS) {
    const entry = { type: 'command', command: `"${script}" ${h.arg}` };
    if (h.timeout) entry.timeout = h.timeout;
    (hooks[h.event] || (hooks[h.event] = [])).push({ matcher: h.matcher, hooks: [entry] });
  }
  return { removed, added: HOOKS.length };
}

function copyScripts({ from, to, apply, force }) {
  const written = [];
  const skipped = [];
  for (const f of SCRIPTS.concat(['config.sh'])) {
    const src = path.join(from, f);
    if (!fs.existsSync(src)) continue;
    const dst = path.join(to, f);
    // config.sh is the one file the user is expected to edit. Overwriting it on
    // every upgrade would silently revert their voice and thresholds, so it is
    // only replaced with --force — the opposite rule from the scripts, which must
    // always be current or a fixed bug never lands.
    if (f === 'config.sh' && fs.existsSync(dst) && !force) {
      skipped.push({ name: f, reason: 'your settings kept (use --force to reset to defaults)' });
      continue;
    }
    if (apply) {
      fs.mkdirSync(to, { recursive: true });
      fs.copyFileSync(src, dst);
      if (EXECUTABLE.has(f)) fs.chmodSync(dst, 0o755);
    }
    written.push({ name: f, to: dst });
  }
  return { written, skipped };
}

/** Atomic write, then re-read. A half-written settings.json cannot be started from. */
function writeSettingsAtomic(file, obj) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n');
  JSON.parse(fs.readFileSync(tmp, 'utf8')); // throws before anything is at risk
  fs.renameSync(tmp, file);
}

export function installVoice({ root, apply = false, force = false, target = jarvisDir(), settings = settingsFile() }) {
  const from = path.join(root, 'voice');
  if (!fs.existsSync(from)) throw new Error(`no voice/ directory in ${root}`);

  const scripts = copyScripts({ from, to: target, apply, force });
  const script = path.join(target, 'jarvis.sh');

  let existing = {};
  if (fs.existsSync(settings)) {
    try {
      existing = JSON.parse(fs.readFileSync(settings, 'utf8'));
    } catch (e) {
      throw new Error(`${settings} is not valid JSON — fix it before installing hooks (${e.message})`);
    }
  }

  // Count on a deep copy so the dry run reports real numbers without mutating.
  const preview = JSON.parse(JSON.stringify(existing));
  const counts = mergeHooks(preview, script);
  const foreign = Object.entries(preview.hooks || {}).reduce(
    (n, [, gs]) => n + gs.reduce((m, g) => m + g.hooks.filter((h) => !String(h.command).includes('jarvis')).length, 0),
    0
  );

  let backup = null;
  if (apply) {
    if (fs.existsSync(settings)) {
      backup = `${settings}.bak`;
      fs.copyFileSync(settings, backup);
    }
    try {
      writeSettingsAtomic(settings, preview);
      JSON.parse(fs.readFileSync(settings, 'utf8'));
    } catch (e) {
      if (backup) fs.copyFileSync(backup, settings);
      throw new Error(`settings write failed and was rolled back: ${e.message}`);
    }
    // A convenience only. If ~/.local/bin is missing or not on PATH the layer
    // still works — jarvisctl is just reachable by full path instead.
    try {
      const bin = path.join(os.homedir(), '.local', 'bin');
      fs.mkdirSync(bin, { recursive: true });
      const link = path.join(bin, 'jarvisctl');
      if (fs.existsSync(link) || fs.lstatSync(link, { throwIfNoEntry: false })) fs.rmSync(link, { force: true });
      fs.symlinkSync(path.join(target, 'jarvisctl'), link);
    } catch {
      /* not fatal */
    }
  }

  return { target, settings, script, applied: apply, backup, foreign, ...counts, ...scripts };
}

export function render(r) {
  console.log(`Voice scripts -> ${r.target}`);
  console.log(`Hooks         -> ${r.settings}`);
  console.log(r.applied ? `Mode: APPLY (backup at ${r.backup || 'n/a'})` : 'Mode: DRY RUN — nothing written. Add --apply to install.');

  console.log(`\n${r.applied ? 'Installed' : 'Would install'} (${r.written.length} files)`);
  for (const w of r.written) console.log(`  + ${w.name}`);
  if (r.skipped.length) {
    console.log('\nSkipped');
    for (const s of r.skipped) console.log(`  - ${s.name.padEnd(12)} ${s.reason}`);
  }

  console.log(`\nHooks ${r.applied ? 'registered' : 'to register'} (${r.added})`);
  for (const h of HOOKS) {
    console.log(`  ${h.event}${h.matcher ? `/${h.matcher}` : ''}`.padEnd(34) + `${h.arg.padEnd(11)} ${h.why}`);
  }
  if (r.removed) console.log(`\nReplaced ${r.removed} previous jarvis hook entr${r.removed === 1 ? 'y' : 'ies'} — re-running is safe.`);
  console.log(`Left untouched: ${r.foreign} non-jarvis hook entr${r.foreign === 1 ? 'y' : 'ies'} (the orchestrator's routing gate and context pack).`);

  console.log(
    [
      '',
      r.applied ? 'Next:' : 'Then:',
      '  jarvisctl doctor        verify the install',
      '  jarvisctl test          hear every alert',
      '  jarvisctl status        which sessions are live and which are blocked',
      '',
      'Hooks are read AT SESSION START. Already-open sessions stay silent until restarted.',
    ].join('\n')
  );
  return 0;
}
