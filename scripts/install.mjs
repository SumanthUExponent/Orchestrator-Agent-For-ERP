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
  return process.env.JARVIS_SKILLS_DIR || process.env.CLAUDE_SKILLS_DIR || path.join(os.homedir(), '.claude', 'skills');
}

/** Where Claude Code looks for sub-agent definitions. Agents are inert until they land here. */
export function agentsDir() {
  return process.env.JARVIS_AGENTS_DIR || process.env.CLAUDE_AGENTS_DIR || path.join(os.homedir(), '.claude', 'agents');
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

  // 1. in-tree skills plus JARVIS itself
  const inTree = [
    ...skillDirsIn(path.join(root, 'skills')).map((n) => ({ name: n, from: path.join(root, 'skills', n), source: 'in-tree' })),
    ...(fs.existsSync(path.join(root, 'jarvis', 'SKILL.md'))
      ? [{ name: 'jarvis', from: path.join(root, 'jarvis'), source: 'in-tree' }]
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
        if (fs.existsSync(dest) && !force) {
          const stale = contentDiffers(path.join(provides, name), dest);
          skipped.push({
            name,
            source: id,
            stale,
            reason: stale
              ? 'existing skill wins, but it DIFFERS from this version — --force to replace'
              : 'existing skill wins (identical)',
          });
        }
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
    // Make the installed JARVIS skill self-contained.
    //
    // SKILL.md documents `node scripts/jarvis.mjs route "..."`. Installed
    // into ~/.claude/skills/jarvis/ there is no scripts/ directory there,
    // so the skill would instruct a command that cannot run — the worst kind of
    // defect, because the skill still looks correct. Ship the CLI and the
    // prebuilt registry alongside it. `route` and `health` then work from the
    // installed location; `build` stays a repo-side operation because it has to
    // scan the source tree.
    const orchDest = path.join(target, 'jarvis');
    if (fs.existsSync(orchDest)) {
      for (const dir of ['scripts', 'registry']) {
        const src = path.join(root, dir);
        if (fs.existsSync(src)) copyTree(src, path.join(orchDest, dir));
      }
      selfContained = true;
    }
  }

  /**
 * Is what is installed the same as what we would install?
 *
 * WHY THIS EXISTS, AND WHY IT IS NOT COSMETIC
 *
 * The skip used to be decided by existence alone, and reported as "already installed".
 * That sentence is true and useless: it reads as "up to date" when the thing installed is
 * six commits behind. The machine then runs old agents while `doctor` -- which reads the
 * INSTALLED registry -- reports Healthy, because a stale file is a perfectly valid file.
 *
 * Verified by walking into it: a run that added a conflict_reconciliation block to the
 * registry and a new section to all 45 agents was followed by an install that skipped all
 * 45 as "already installed", and the installed copy's doctor printed Healthy with the
 * whole block missing. There was nothing in either output to notice.
 *
 * So the three cases get three different words. Identical is silence. OUTDATED is a
 * warning with the fix in it. Absent is a write.
 */
function contentDiffers(src, dest) {
  const sStat = fs.statSync(src);
  if (sStat.isDirectory()) {
    // A skill is a tree. Compare the file SET first -- a missing file is drift that a
    // per-file loop over the source would never see.
    const list = (d, base = '') => {
      const out = [];
      for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const rel = base ? `${base}/${e.name}` : e.name;
        if (e.isDirectory()) out.push(...list(path.join(d, e.name), rel));
        else out.push(rel);
      }
      return out;
    };
    let a, b;
    try { a = list(src); b = list(dest); } catch { return true; }
    if (a.join('\n') !== b.join('\n')) return true;
    for (const rel of a) {
      try {
        if (!fs.readFileSync(path.join(src, rel)).equals(fs.readFileSync(path.join(dest, rel)))) return true;
      } catch { return true; }
    }
    return false;
  }
  try {
    return !fs.readFileSync(src).equals(fs.readFileSync(dest));
  } catch {
    return true; // unreadable is not "identical"
  }
}

// 4. agents — inert until they reach the agents dir, which is separate from skills
  const agentsSrc = path.join(root, 'agents');
  const agentsTo = agentsDir();
  let agentsWritten = 0;
  const agentFiles = fs.existsSync(agentsSrc) ? fs.readdirSync(agentsSrc).filter((f) => f.endsWith('.md')) : [];
  // The skip decision is made in BOTH modes, deliberately. It used to be computed
  // only under `apply`, so a dry run listed all 45 agents as writes while the real
  // run skipped every one that already existed — the preview reported the opposite
  // of what would happen, which is worse than having no preview. It mattered here:
  // an upgrade that re-tiers existing agents looks like it applied and does nothing.
  if (agentFiles.length) {
    if (apply) fs.mkdirSync(agentsTo, { recursive: true });
    for (const f of agentFiles) {
      assertSafeName(f.replace(/\.md$/, ''));
      const dest = path.join(agentsTo, f);
      if (fs.existsSync(dest) && !force) {
        const stale = contentDiffers(path.join(agentsSrc, f), dest);
        skipped.push({
          name: f,
          source: 'agent',
          stale,
          reason: stale
            ? 'OUTDATED — installed copy differs from this version. Re-run with --force --apply.'
            : 'identical — nothing to do',
        });
        continue;
      }
      // `planned` is the record of what this run acts on, in BOTH modes — it is what
      // render() lists, so leaving agents out of it under --apply printed a skills-only
      // list under a header claiming 45 agents were written.
      planned.push({ name: f.replace(/\.md$/, ''), source: 'agent', to: dest });
      if (apply) {
        fs.copyFileSync(path.join(agentsSrc, f), dest);
        agentsWritten++;
      }
    }
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
  console.log(`\n${result.applied ? 'Installed' : 'Would install'} (${result.planned.length})`);
  for (const p of result.planned) console.log(`  + ${p.name.padEnd(28)} ${p.source}`);
  if (result.skipped.length) {
    console.log(`\nSkipped (${result.skipped.length})`);
    for (const s of result.skipped) console.log(`  - ${s.name.padEnd(28)} ${s.reason}`);
  }
  // A drift warning that scrolls past with 45 other lines has not warned anyone, so it
  // goes last, after the lists, where the next command is read.
  const stale = result.skipped.filter((s) => s.stale);
  if (stale.length) {
    console.log(`\nDRIFT: ${stale.length} installed file${stale.length === 1 ? '' : 's'} differ${stale.length === 1 ? 's' : ''} from this version.`);
    console.log('  You are running an older copy. `doctor` will still say Healthy — a stale');
    console.log('  file is a valid file, so nothing else will tell you.');
    console.log('  Fix: node scripts/jarvis.mjs install --force --apply');
  }
  console.log('\nNext: node scripts/jarvis.mjs health');
  return 0;
}
