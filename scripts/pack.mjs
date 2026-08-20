/**
 * Context Pack — the deterministic half of "what is this repository".
 *
 * Every dispatched agent used to rediscover the same facts: which app owns what,
 * which branch we are on, where the DocTypes live. Five agents meant five identical
 * scans. This command answers all of it once, with commands rather than a model, so
 * the shared context costs ZERO tokens to produce.
 *
 * context-broker (the agent) reads this output and adds only the part a command
 * cannot know: which of these files matter for the request at hand. If the broker is
 * regenerating what is below, it is wasting the dispatch it was created to save.
 *
 * Deliberately shallow and bounded. A pack nobody reads because it is 400 lines long
 * has the same value as no pack.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const CAP = 40; // never print an unbounded list — that is how a pack becomes noise
const SKIP = new Set(['.git', 'node_modules', '.venv', 'env', '__pycache__', 'dist', 'build', '.mypy_cache']);

const sh = (cmd, args, cwd) => {
  try {
    return execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
};

/**
 * Bounded walk. Depth and count caps are the difference between a pack and a crawl.
 *
 * Reports whether it stopped early. Without that flag a truncated scan rendered
 * "DocTypes: none found" at a bench root holding thousands of them — the pack's whole
 * job is to be the trusted shared context, so a confident wrong answer here is worse
 * than no pack at all.
 */
function walk(root, { maxDepth = 5, maxFiles = 6000 } = {}) {
  const files = [];
  let truncated = false;
  const rec = (dir, depth) => {
    if (depth > maxDepth) {
      truncated = true;
      return;
    }
    if (files.length >= maxFiles) {
      truncated = true;
      return;
    }
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (SKIP.has(e.name) || e.name.startsWith('.') && e.isDirectory()) continue;
      const full = path.join(dir, e.name);
      const rel = path.relative(root, full).split(path.sep).join('/');
      if (e.isDirectory()) rec(full, depth + 1);
      else files.push(rel);
      if (files.length >= maxFiles) {
        truncated = true;
        return;
      }
    }
  };
  rec(root, 0);
  return { files, truncated };
}

export function collect(cwd = process.cwd()) {
  const { files, truncated } = walk(cwd);
  const isRepo = sh('git', ['rev-parse', '--is-inside-work-tree'], cwd) === 'true';

  // A Frappe app is a directory with hooks.py. That is the definition the framework
  // itself uses, so it needs no configuration here and cannot drift.
  const apps = [...new Set(files.filter((f) => f.endsWith('hooks.py')).map((f) => f.split('/').slice(0, -1).join('/')))].sort();

  const doctypes = [...new Set(files.filter((f) => /\/doctype\/[^/]+\/[^/]+\.json$/.test(f)).map((f) => f.split('/doctype/')[1].split('/')[0]))].sort();
  const reports = [...new Set(files.filter((f) => /\/report\/[^/]+\//.test(f)).map((f) => f.split('/report/')[1].split('/')[0]))].sort();
  const pages = [...new Set(files.filter((f) => /\/page\/[^/]+\//.test(f)).map((f) => f.split('/page/')[1].split('/')[0]))].sort();

  const git = isRepo
    ? {
        branch: sh('git', ['rev-parse', '--abbrev-ref', 'HEAD'], cwd),
        head: sh('git', ['log', '--oneline', '-1'], cwd),
        dirty: (sh('git', ['status', '--porcelain'], cwd) || '').split('\n').filter(Boolean).length,
        recent: (sh('git', ['log', '--name-only', '--pretty=format:', '-8'], cwd) || '')
          .split('\n')
          .filter(Boolean)
          .filter((v, i, a) => a.indexOf(v) === i)
          .slice(0, CAP),
      }
    : null;

  return {
    cwd,
    fileCount: files.length,
    truncated,
    apps,
    doctypes,
    reports,
    pages,
    git,
    hasTests: files.some((f) => /(^|\/)test_[^/]+\.py$/.test(f) || /\.test\.(mjs|js|ts)$/.test(f)),
    // Managed hosting has no bench. Whether one exists here is a fact every agent
    // needs before recommending a command the user cannot run. Search UPWARD too:
    // the bench root sits above apps/<app>, so scanning an app directory alone
    // reported "no bench" on a machine that has one — a confident wrong answer in
    // a pack every agent reads.
    benchRoot: findBenchRoot(cwd),
  };
}

function findBenchRoot(start) {
  let dir = path.resolve(start);
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(dir, 'sites', 'common_site_config.json'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

const list = (label, arr, truncated) =>
  arr.length
    ? `- **${label}** (${arr.length}${truncated ? '+, scan truncated' : ''}): ${arr.slice(0, CAP).join(', ')}${arr.length > CAP ? ` … +${arr.length - CAP} more` : ''}`
    : `- **${label}**: ${truncated ? 'UNKNOWN — scan hit its limit before reaching them' : 'none found'}`;

/**
 * Which slice of the ground each role actually needs (§14).
 *
 * The pack is one artifact handed to every agent, which is the right call for the
 * *expensive* part -- walking the tree once instead of forty-five times. It is the wrong
 * call for delivery: a ui-designer reading the DocType inventory and the migration
 * history is paying attention to ground it will never touch, and §14's complaint is
 * exactly that ("agents should receive only the context necessary for their role.
 * Avoid context pollution").
 *
 * Scoped by SECTION, not by trimming lists. A shorter list of the wrong things is not
 * less pollution -- it is the same pollution, harder to notice. And a section an agent
 * needs is never withheld: the default is the full pack, `--for` is opt-in, and an
 * unknown role gets everything rather than a guess.
 *
 * The seven layers §14 names map onto this repo as:
 *   GLOBAL KNOWLEDGE   the agent prompt (registry-generated) -- not here
 *   PROJECT CONTEXT    root, bench, branch          always included, it is four lines
 *   REPOSITORY CONTEXT the surface lists            SCOPED, this is the bulk
 *   TASK CONTEXT       the request                  supplied by the dispatch
 *   AGENT MEMORY       the ledger                   scripts/learn.mjs
 *   EXECUTION STATE    in-flight swarm              jarvisctl report
 *   LESSONS LEARNED    daily log, DECISION markers  ~/.claude/jarvis/daily
 */
export const ROLE_SCOPES = {
  // Schema and data work needs the DocType inventory; UI work does not.
  'data-model-architect': ['doctypes', 'apps'],
  'schema-builder': ['doctypes', 'apps', 'recent'],
  'migration-analyst': ['doctypes', 'apps', 'recent'],
  'frappe-data': ['doctypes', 'apps', 'recent'],

  // Surface work needs pages and the design system, not the report inventory.
  'ui-designer': ['pages', 'apps'],
  'frontend': ['pages', 'apps', 'recent'],
  'frappe-frontend': ['pages', 'apps', 'recent'],
  'interaction-designer': ['pages'],
  'mobile-ux': ['pages'],
  'accessibility': ['pages'],

  'reporting-developer': ['reports', 'doctypes', 'apps'],
  'data-analyst': ['reports', 'doctypes'],
  'dataviz-specialist': ['reports'],

  // Review and impact work needs the whole surface -- that is the job.
  'impact-analyst': ['apps', 'doctypes', 'reports', 'pages', 'recent'],
  'code-reviewer': ['recent', 'apps'],
  'git-safety': ['recent'],
  'deployment-safety': ['recent', 'apps'],
  'test-engineer': ['apps', 'recent'],

  // Documentation describes what exists; it needs the inventory and not the history.
  'user-guide-writer': ['doctypes', 'pages', 'apps'],
  'process-documenter': ['doctypes', 'apps'],
  'uat-coordinator': ['doctypes', 'pages'],

  // Planning agents work before the code exists.
  'requirements-analyst': ['apps'],
  'architect': ['apps', 'doctypes'],
  'frappe-architect': ['apps', 'doctypes'],
  'business-analyst': ['apps'],
};

/**
 * Pre-rebrand agent names, kept so a dispatch written against the old roster still gets
 * a correctly scoped pack instead of silently falling back to the full one.
 *
 * Declared explicitly rather than tolerated by a count, because "at most four unknown
 * names" passes for a typo just as happily as for an alias — and a typo'd role reverts
 * to the full pack, which looks exactly like scoping working.
 */
export const ROLE_ALIASES = new Set(['frappe-data', 'frappe-frontend', 'frappe-architect']);

/** Sections a scoped pack can carry. Anything not listed is always included. */
export const SCOPABLE = ['apps', 'doctypes', 'reports', 'pages', 'recent'];

export function render(cwd = process.cwd(), { role = null } = {}) {
  const p = collect(cwd);
  // An unknown role gets the full pack. Guessing a scope for an agent nobody mapped is
  // how a specialist ends up blind to the one list it needed.
  const scope = role && ROLE_SCOPES[role] ? new Set(ROLE_SCOPES[role]) : null;
  const wants = (section) => !scope || scope.has(section);
  const out = [
    '# Context Pack',
    '',
    'Generated by `jarvis.mjs pack`. Deterministic — no model was involved, so',
    'this costs nothing to regenerate. Paste it into a dispatch instead of letting each',
    'agent rediscover it.',
    '',
    `- **Root**: \`${p.cwd}\``,
    `- **Files scanned**: ${p.fileCount}`,
  ];
  if (p.git) {
    out.push(`- **Branch**: ${p.git.branch}${p.git.dirty ? `  (${p.git.dirty} uncommitted change${p.git.dirty === 1 ? '' : 's'})` : '  (clean)'}`);
    out.push(`- **HEAD**: ${p.git.head}`);
  } else {
    out.push('- **Git**: not a repository');
  }
  out.push(`- **Bench**: ${p.benchRoot ? `available at \`${p.benchRoot}\`` : 'none found — do not recommend bench commands'}`);
  out.push(`- **Tests present**: ${p.hasTests ? 'yes' : 'no'}`);
  if (p.truncated) {
    out.push(
      '',
      `> **Scan truncated.** The walk stopped at its depth/file limit, so the lists below are`,
      `> incomplete. Treat an empty list as UNKNOWN, not as absent. Re-run \`pack\` against a`,
      `> narrower root (a single app rather than the bench) for a complete picture.`
    );
  }
  const surface = [];
  if (wants('apps')) surface.push(list('Apps', p.apps, p.truncated));
  if (wants('doctypes')) surface.push(list('DocTypes', p.doctypes, p.truncated));
  if (wants('reports')) surface.push(list('Reports', p.reports, p.truncated));
  if (wants('pages')) surface.push(list('Pages', p.pages, p.truncated));
  if (surface.length) out.push('', '## Frappe surface', ...surface);
  if (wants('recent') && p.git && p.git.recent.length) {
    out.push('', '## Recently touched (last 8 commits)', ...p.git.recent.map((f) => `- ${f}`));
  }
  if (scope) {
    // Say what was withheld and how to get it. A scoped pack that looks like a full one
    // is worse than no scoping: the agent reads an absent list as an empty list, which
    // is the same defect the truncation warning above exists to prevent.
    const held = SCOPABLE.filter((x) => !scope.has(x));
    if (held.length) {
      out.push(
        '',
        `> **Scoped to \`${role}\`.** Withheld as not relevant to this role: ${held.join(', ')}.`,
        `> An absent section is NOT an empty one. Run \`pack\` with no \`--for\` if you need the full ground.`
      );
    }
  }
  out.push(
    '',
    '## What this pack does not tell you',
    '',
    'It lists what exists, not what matters. Which of these files are relevant to the',
    'request, and why, is the one judgement `context-broker` is dispatched to add.'
  );
  console.log(out.join('\n'));
  return 0;
}
