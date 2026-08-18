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

export function render(cwd = process.cwd()) {
  const p = collect(cwd);
  const out = [
    '# Context Pack',
    '',
    'Generated by `orchestrator.mjs pack`. Deterministic — no model was involved, so',
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
  out.push('', '## Frappe surface', list('Apps', p.apps, p.truncated), list('DocTypes', p.doctypes, p.truncated), list('Reports', p.reports, p.truncated), list('Pages', p.pages, p.truncated));
  if (p.git && p.git.recent.length) {
    out.push('', '## Recently touched (last 8 commits)', ...p.git.recent.map((f) => `- ${f}`));
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
