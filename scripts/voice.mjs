/**
 * Voice layer installer — place the JARVIS scripts and register the hooks.
 *
 * Same posture as install.mjs: DRY RUN by default, nothing written without
 * --apply. This one edits ~/.claude/settings.json, which is the single file that
 * decides whether Claude Code works at all, so it is more cautious than the rest:
 *
 *   - it backs the file up before touching it
 *   - it merges, never replaces. JARVIS's own UserPromptSubmit routing
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
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { generate } from './tones.mjs';

const SCRIPTS = ['jarvis.sh', 'speaker.sh', 'jarvisctl', 'demo.sh', 'platform.sh', 'pronounce.sh', 'summarise.awk'];
const EXECUTABLE = new Set(['jarvis.sh', 'speaker.sh', 'jarvisctl', 'demo.sh']);

/** Every hook the voice layer registers. Order here is the order written. */
export const HOOKS = [
  { event: 'SessionStart', matcher: '', arg: 'start', why: 'greet, and start the clock' },
  { event: 'UserPromptSubmit', matcher: '', arg: 'begin', why: 'restart the clock; clear pending approval' },
  { event: 'Stop', matcher: '', arg: 'done', why: 'announce completion, gated on elapsed time' },
  { event: 'Notification', matcher: 'permission_prompt', arg: 'permission', why: 'blocked on approval — the expensive failure' },
  { event: 'Notification', matcher: 'idle_prompt', arg: 'idle', why: 'waiting on you' },
  { event: 'SubagentStart', matcher: '', arg: 'substart', why: 'count specialists IN FLIGHT, for jarvisctl report' },
  { event: 'SubagentStop', matcher: '', arg: 'subagent', why: 'count specialists; chime per batch' },
  { event: 'StopFailure', matcher: '', arg: 'error', why: 'API error (NOT a failed tool call)' },
  // Compaction, not session closure, is where context is actually lost -- and it
  // happens repeatedly inside one long session, silently. PreCompact runs BEFORE the
  // discard and gets a longer budget than the others because it reads a slice of the
  // transcript; PostCompact is a pure payload read and needs none.
  {
    event: 'PreCompact',
    matcher: '',
    arg: 'precompact',
    timeout: 10,
    why: 'snapshot what is about to be discarded',
  },
  { event: 'PostCompact', matcher: '', arg: 'postcompact', why: 'record what survived' },
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
 * group level, so a group we share with the routing skill keeps its other entries.
 * Returns the number removed.
 */
export function stripJarvis(hooks) {
  let removed = 0;
  for (const event of Object.keys(hooks)) {
    const groups = Array.isArray(hooks[event]) ? hooks[event] : [];
    const kept = [];
    for (const g of groups) {
      const before = (g.hooks || []).length;
      // Match `jarvis.sh` specifically, NOT any command containing "jarvis".
      //
      // The loose test was survivable only while the routing skill was called
      // "orchestrator". Renaming it to jarvis made `skills/jarvis/scripts/jarvis.mjs`
      // match, so installing the voice layer deleted the routing gate and the context
      // pack -- the two hooks this function exists to protect. The voice hooks are
      // always `<dir>/jarvis.sh <arg>` (on Windows, `bash "C:/.../jarvis.sh" arg`), so
      // the file name is the precise and portable discriminator.
      g.hooks = (g.hooks || []).filter((h) => !String(h.command || '').includes('jarvis.sh'));
      removed += before - g.hooks.length;
      if (g.hooks.length) kept.push(g);
    }
    if (kept.length) hooks[event] = kept;
    else delete hooks[event];
  }
  return removed;
}

/**
 * The command Claude Code will execute for a hook.
 *
 * On Windows this cannot be the bare path. `path.join` produces
 * `C:\Users\me\.claude\jarvis\jarvis.sh`, and that string fails twice over: cmd.exe
 * cannot execute a .sh at all, and a shell that CAN would read the backslashes as
 * escapes. So the path is written with forward slashes — which Git Bash, WSL and
 * PowerShell all accept — and `bash` is named explicitly, which works whether the hook
 * is handed to cmd.exe or to a shell.
 */
export function hookCommand(script, arg, platform = process.platform) {
  if (platform === 'win32') return `bash "${script.replace(/\\/g, '/')}" ${arg}`;
  return `"${script}" ${arg}`;
}

/** Merge our hooks into a settings object, in place. Idempotent by construction. */
export function mergeHooks(settings, script, platform = process.platform) {
  const hooks = settings.hooks || (settings.hooks = {});
  const removed = stripJarvis(hooks);
  for (const h of HOOKS) {
    const entry = { type: 'command', command: hookCommand(script, h.arg, platform) };
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

/**
 * Hand one announcement to the voice layer, from Node.
 *
 * JARVIS routing is a CLI, not a Claude Code hook, so it has no payload to speak
 * through -- but it must not speak for itself either. Nothing outside the drainer ever
 * calls the speech engine, so this ENQUEUES exactly the way a hook does, by invoking
 * jarvis.sh, and returns immediately.
 *
 * Silent on every failure: not installed, not executable, spawn refused. A planner that
 * cannot plan because the voice layer is missing would be a much worse tool than a
 * silent one.
 *
 * stdio stdin is 'ignore' deliberately -- jarvis.sh does `[ -t 0 ] || IN=$(cat)`, which
 * would block forever on an inherited pipe with nothing written to it.
 */
export function announce(arg, text, { target = jarvisDir() } = {}) {
  try {
    const script = path.join(target, 'jarvis.sh');
    if (!fs.existsSync(script)) return false;
    spawnSync(script, [arg, String(text ?? '')], {
      stdio: ['ignore', 'ignore', 'ignore'],
      timeout: 4000,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Speak the parts of an execution plan a person would want to hear.
 *
 * Three things qualify, and nothing else: a gate (the loudest announcement the layer
 * has, and it names WHICH of the seven), an agent dropped by the router, and an effort
 * level capped below what was asked for. All three are decisions made on the user's
 * behalf, which is exactly the category worth one spoken line.
 */

/**
 * Which of the seven human-approval gates a request plainly crosses.
 *
 * Two independent signals per gate, never one. A single keyword is not enough: "drop"
 * alone appears in "drop the trailing comma", and a false gate announcement is the most
 * expensive false positive available -- it is the one alert the user is trained not to
 * ignore. Returns [] when unsure, which is the right answer when unsure.
 */
export function matchGates(request, gates = []) {
  const q = String(request || '').toLowerCase();
  if (!q) return [];

  // Keyed on a distinctive word of the GATE TEXT, never on list position. Position was
  // the first attempt and it silently mismatched every rule by one -- "deploy to
  // production" announced "destructive database changes" -- because the rule order and
  // the registry order were not the same list. Reordering registry/agents.yaml must not
  // be able to change which gate is named.
  const rules = [
    { key: 'database', all: [/\bdrop\b|\btruncate\b|\bwipe\b/, /\btable|\bdatabase|\bschema|\bdb\b/] },
    { key: 'production', all: [/\bproduction\b|\bprod\b/, /\bdeploy|\brelease\b|\bship\b/] },
    { key: 'git', all: [/force[- ]push|reset --hard|rewrite (the )?history|branch -d\b/] },
    { key: 'skill or agent', all: [/\bdelete\b|\bremove\b|\boverwrite\b/, /\bskills?\b|\bagents?\b/] },
    { key: 'swarm architecture', all: [/\bswarm\b/, /\barchitecture\b|\bregistry\b/] },
    { key: 'new agent', all: [/\bnew agent\b|generate an? agent/] },
    { key: 'security', all: [/\bsecret|\bcredential|\bpassword|\btoken\b|api key/] },
  ];

  const hit = [];
  for (const g of gates) {
    const gl = String(g).toLowerCase();
    const rule = rules.find((r) => gl.includes(r.key));
    if (!rule) continue;
    if (rule.all.every((re) => re.test(q))) hit.push(g);
  }
  return hit;
}

export function announcePlan(plan, { requestedEffort, request = '', gates = [], target = jarvisDir() } = {}) {
  if (!plan || typeof plan !== 'object') return;
  const spoken = [];

  // NOT plan.gates. Those are PHASE gates -- "verify" -- and announcing one as though
  // it were a human-approval gate is worse than saying nothing: it spends the loudest
  // motif in the set on a routine planning step.
  //
  // The seven human gates are a flat list in registry/agents.yaml, printed verbatim
  // into every agent prompt and enforced by the AGENT at runtime. Nothing in the
  // planner decides which one a request crosses, so there is nothing here to read.
  // What follows is therefore a HEURISTIC front end to the `gate` event, and it is
  // deliberately biased towards silence: every rule needs two independent signals, so
  // it under-reports rather than crying wolf on the loudest announcement in the system.
  // The authoritative path remains an agent calling `jarvis.sh gate "<gate>"` when it
  // actually refuses and escalates.
  for (const g of matchGates(request, gates)) {
    announce('gate', g, { target });
    spoken.push(`gate: ${g}`);
  }

  const dropped = plan.dropped || [];
  if (dropped.length) {
    // One line for the whole set. Naming every dropped agent would be a list read
    // aloud, which is the thing the written plan on screen is already better at.
    const first = dropped[0];
    const more = dropped.length > 1 ? `, and ${dropped.length - 1} more` : '';
    announce('route', `${first.id} was dropped${more}`, { target });
    spoken.push(`route: dropped ${dropped.length}`);
  }

  // Not spoken -- recorded, for `jarvisctl report` to read later. The in-flight count
  // comes from SubagentStart/Stop and says HOW MANY; only the planner knows in how many
  // batches and at what tier, and only at plan time.
  // Shape read from plan.mjs, not guessed: batches[] each carry members[], and the tier
  // is on member.agent.model. A first pass invented plan.agents and plan.dispatch and
  // silently recorded "0 batches, top tier unknown" for every plan.
  const batches = Array.isArray(plan.batches) ? plan.batches.length : 0;
  const tiers = [
    ...new Set(
      (plan.batches || [])
        .flatMap((b) => b.members || [])
        .map((m) => m && m.agent && m.agent.model)
        .filter(Boolean)
    ),
  ];
  const top = tiers.includes('opus') ? 'opus' : tiers.includes('sonnet') ? 'sonnet' : tiers[0] || '';
  if (batches || top) {
    announce('swarm', `${batches} batches, top tier ${top || 'unknown'}`, { target });
    spoken.push(`swarm: ${batches} batches ${top}`);
  }

  if (requestedEffort && plan.effort && plan.effort !== requestedEffort) {
    announce('route', `effort capped at ${plan.effort}`, { target });
    spoken.push(`route: effort ${plan.effort}`);
  }
  return spoken;
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

  // The session-context recorder ships WITH the voice layer, not only with the
  // skills install. The hooks registered below reference it, and a hook pointing at
  // a file that is not there degrades to a silent no-op -- which is safe, but means
  // `voice --apply` alone would install a compaction hook that never records
  // anything. Copying it here makes the voice layer self-contained, as it already
  // claims to be everywhere else.
  if (apply) {
    const ctxSrc = path.join(root, 'scripts', 'context.mjs');
    if (fs.existsSync(ctxSrc)) fs.copyFileSync(ctxSrc, path.join(target, 'context.mjs'));
  }

  // Tones are SYNTHESISED here rather than shipped. They are derived data — pitch,
  // envelope and loudness baked into plain WAV so playback needs no per-platform rate
  // or volume flags — and generating them keeps a megabyte of binaries out of the
  // repository and guarantees they match the motif table that ships with them.
  const tones = generate({ target, apply });

  // The extension point. Created empty with its contract documented, because a hook
  // directory nobody knows exists is not an extension point.
  if (apply) {
    const hd = path.join(target, 'hooks.d');
    fs.mkdirSync(hd, { recursive: true });
    const readme = path.join(from, 'hooks.d', 'README');
    if (fs.existsSync(readme)) fs.copyFileSync(readme, path.join(hd, 'README'));
  }

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
    // Same discriminator as stripJarvis, and it MUST stay the same: this is the count
    // reported as "left untouched", and if the two predicates disagree the installer
    // reports having preserved a hook it just deleted.
    (n, [, gs]) => n + gs.reduce((m, g) => m + g.hooks.filter((h) => !String(h.command).includes('jarvis.sh')).length, 0),
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

  return { target, settings, script, applied: apply, backup, foreign, tones, ...counts, ...scripts };
}

export function render(r) {
  console.log(`Voice scripts -> ${r.target}`);
  console.log(`Hooks         -> ${r.settings}`);
  console.log(r.applied ? `Mode: APPLY (backup at ${r.backup || 'n/a'})` : 'Mode: DRY RUN — nothing written. Add --apply to install.');

  console.log(`\n${r.applied ? 'Installed' : 'Would install'} (${r.written.length} files)`);
  for (const w of r.written) console.log(`  + ${w.name}`);
  console.log(
    `  + tones/                     ${r.tones.count} synthesised notes for ${r.tones.motifs} motifs (${Math.round(r.tones.bytes / 1024)}KB)`
  );
  for (const w of r.tones.warnings) console.log(`  ! ${w}`);
  if (r.skipped.length) {
    console.log('\nSkipped');
    for (const s of r.skipped) console.log(`  - ${s.name.padEnd(12)} ${s.reason}`);
  }

  console.log(`\nHooks ${r.applied ? 'registered' : 'to register'} (${r.added})`);
  for (const h of HOOKS) {
    console.log(`  ${h.event}${h.matcher ? `/${h.matcher}` : ''}`.padEnd(34) + `${h.arg.padEnd(11)} ${h.why}`);
  }
  if (r.removed) console.log(`\nReplaced ${r.removed} previous jarvis hook entr${r.removed === 1 ? 'y' : 'ies'} — re-running is safe.`);
  console.log(`Left untouched: ${r.foreign} non-jarvis hook entr${r.foreign === 1 ? 'y' : 'ies'} (the JARVIS routing gate and context pack).`);

  console.log(
    [
      '',
      r.applied ? 'Next:' : 'Then:',
      '  jarvisctl doctor        verify the install',
      '  jarvisctl test          hear every alert',
      '  jarvisctl status        which sessions are live and which are blocked',
      '',
      'Hooks are read AT SESSION START. Already-open sessions stay silent until restarted.',
      'macOS, Linux and Windows (WSL or Git Bash) are supported — `jarvisctl doctor`',
      'names the speech and audio backend it found, and what to install if it found none.',
    ].join('\n')
  );
  return 0;
}
