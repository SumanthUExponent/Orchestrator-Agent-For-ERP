/**
 * Installer (§15) — resolve and place skills into the Claude Code skills dir.
 *
 * SECURITY POSTURE (§32). Installing a skill means placing text that an agent
 * will later treat as instructions, and optionally cloning it from a stranger's
 * repository. This installer therefore:
 *
 *   - is DRY-RUN by default; writing requires an explicit --apply
 *   - never touches the network unless --external is also passed
 *   - NEVER executes anything from a fetched repo: no npm install, no
 *     postinstall, no running its scripts. Files are copied; nothing is run
 *   - validates every skill name against a strict pattern, and rejects any
 *     provides_dir that is absolute or escapes the clone root (path traversal)
 *   - refuses symlinks when copying, so a repo cannot link out of its own tree
 *   - refuses to overwrite an existing skill without --force, so a third-party
 *     package can never silently shadow one of yours
 *
 * The threat is not hypothetical: a malicious skill only has to be *read* to
 * influence an agent. Fetching is opt-in for exactly that reason.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

const SAFE_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

/** Where Claude Code keeps user skills. Overridable for tests and odd setups. */
export function skillsDir() {
  return process.env.CLAUDE_SKILLS_DIR || path.join(os.homedir(), '.claude', 'skills');
}

/** Where Claude Code looks for sub-agent definitions. Agents are inert until they land here. */
export function agentsDir() {
  return process.env.CLAUDE_AGENTS_DIR || path.join(os.homedir(), '.claude', 'agents');
}

function assertSafeName(name) {
  if (name === '.' || name === '..' || !SAFE_NAME.test(name)) {
    throw new Error(`unsafe skill name rejected: ${JSON.stringify(name)}`);
  }
}

/** Reject absolute paths and anything escaping the clone root. */
function resolveInside(root, sub) {
  const target = path.resolve(root, sub || '.');
  const rel = path.relative(root, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`provides_dir escapes repo root: ${sub}`);
  return target;
}

/** Copy a directory tree, skipping symlinks and VCS metadata. */
function copyTree(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (e.isSymbolicLink()) continue; // a symlink could point anywhere
    if (e.name === '.git' || e.name === 'node_modules') continue;
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) copyTree(s, d);
    else if (e.isFile()) fs.copyFileSync(s, d);
  }
}

function skillDirsIn(root) {
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(root, e.name, 'SKILL.md')))
    .map((e) => e.name);
}

export function install({ root, readYaml, apply = false, external = false, force = false, target = skillsDir() }) {
  const ov = readYaml(path.join(root, 'registry', 'overlay.yaml'));
  const planned = [];
  const skipped = [];

  // 1. in-tree skills plus the orchestrator itself
  const inTree = [
    ...skillDirsIn(path.join(root, 'skills')).map((n) => ({ name: n, from: path.join(root, 'skills', n), source: 'in-tree' })),
    ...(fs.existsSync(path.join(root, 'orchestrator', 'SKILL.md'))
      ? [{ name: 'orchestrator', from: path.join(root, 'orchestrator'), source: 'in-tree' }]
      : []),
  ];
  for (const s of inTree) {
    assertSafeName(s.name);
    const dest = path.join(target, s.name);
    if (fs.existsSync(dest) && !force) skipped.push({ ...s, reason: 'already installed (use --force to replace)' });
    else planned.push({ ...s, to: dest });
  }

  // 2. external sources — network access, opt-in only
  const externals = Object.entries(ov.external || {});
  if (!external) {
    for (const [id] of externals) skipped.push({ name: id, source: 'external', reason: 'skipped — pass --external to fetch' });
  } else {
    const cache = path.join(root, '.cache', 'external');
    fs.mkdirSync(cache, { recursive: true });
    for (const [id, spec] of externals) {
      assertSafeName(id);
      const repoDir = path.join(cache, id);
      if (!apply) {
        planned.push({ name: id, source: `external:${spec.repo}`, note: 'dry run — nothing fetched' });
        continue;
      }
      if (!fs.existsSync(repoDir)) {
        // --depth 1, no submodules, no tags. Nothing from the repo is executed.
        execFileSync('git', ['clone', '--depth', '1', '--no-tags', '--recurse-submodules=no', spec.repo, repoDir], { stdio: 'ignore' });
      }
      const provides = resolveInside(repoDir, spec.provides_dir || '.');
      const exclude = new Set(spec.exclude || []);
      for (const name of skillDirsIn(provides)) {
        assertSafeName(name);
        if (exclude.has(name)) {
          skipped.push({ name, source: id, reason: `excluded by manifest: ${spec.exclude_reason || 'see overlay.yaml'}` });
          continue;
        }
        const dest = path.join(target, name);
        if (fs.existsSync(dest) && !force) skipped.push({ name, source: id, reason: 'existing skill wins' });
        else planned.push({ name, from: path.join(provides, name), to: dest, source: id });
      }
    }
  }

  // 3. apply
  let written = 0;
  let selfContained = false;
  if (apply) {
    fs.mkdirSync(target, { recursive: true });
    for (const p of planned) {
      if (!p.from) continue;
      if (fs.existsSync(p.to) && force) fs.rmSync(p.to, { recursive: true, force: true });
      copyTree(p.from, p.to);
      written++;
    }
    // Make the installed orchestrator self-contained.
    //
    // SKILL.md documents `node scripts/orchestrator.mjs route "..."`. Installed
    // into ~/.claude/skills/orchestrator/ there is no scripts/ directory there,
    // so the skill would instruct a command that cannot run — the worst kind of
    // defect, because the skill still looks correct. Ship the CLI and the
    // prebuilt registry alongside it. `route` and `health` then work from the
    // installed location; `build` stays a repo-side operation because it has to
    // scan the source tree.
    const orchDest = path.join(target, 'orchestrator');
    if (fs.existsSync(orchDest)) {
      for (const dir of ['scripts', 'registry']) {
        const src = path.join(root, dir);
        if (fs.existsSync(src)) copyTree(src, path.join(orchDest, dir));
      }
      selfContained = true;
    }
  }

  // 4. agents — inert until they reach the agents dir, which is separate from skills
  const agentsSrc = path.join(root, 'agents');
  const agentsTo = agentsDir();
  let agentsWritten = 0;
  const agentFiles = fs.existsSync(agentsSrc) ? fs.readdirSync(agentsSrc).filter((f) => f.endsWith('.md')) : [];
  if (apply && agentFiles.length) {
    fs.mkdirSync(agentsTo, { recursive: true });
    for (const f of agentFiles) {
      assertSafeName(f.replace(/\.md$/, ''));
      const dest = path.join(agentsTo, f);
      if (fs.existsSync(dest) && !force) {
        skipped.push({ name: f, source: 'agent', reason: 'agent already installed (use --force to replace)' });
        continue;
      }
      fs.copyFileSync(path.join(agentsSrc, f), dest);
      agentsWritten++;
    }
  } else if (agentFiles.length) {
    for (const f of agentFiles) planned.push({ name: f.replace(/\.md$/, ''), source: 'agent', to: path.join(agentsTo, f) });
  }

  return { target, agentsTarget: agentsTo, planned, skipped, written, agentsWritten, applied: apply, selfContained };
}

export function render(result) {
  console.log(`Skills -> ${result.target}`);
  console.log(`Agents -> ${result.agentsTarget}`);
  console.log(
    result.applied
      ? `Mode: APPLY (${result.written} skills, ${result.agentsWritten} agents written)`
      : 'Mode: DRY RUN — nothing written. Add --apply to install.'
  );
  console.log(`\nWould install (${result.planned.length})`);
  for (const p of result.planned) console.log(`  + ${p.name.padEnd(28)} ${p.source}`);
  if (result.skipped.length) {
    console.log(`\nSkipped (${result.skipped.length})`);
    for (const s of result.skipped) console.log(`  - ${s.name.padEnd(28)} ${s.reason}`);
  }
  console.log('\nNext: node scripts/orchestrator.mjs health');
  return 0;
}
