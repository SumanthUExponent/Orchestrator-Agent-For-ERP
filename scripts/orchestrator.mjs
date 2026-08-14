#!/usr/bin/env node
/**
 * Orchestrator CLI — registry build, health check, routing.
 *
 *   node scripts/orchestrator.mjs build     regenerate registry.generated.json
 *   node scripts/orchestrator.mjs health    validate the ecosystem (§17)
 *   node scripts/orchestrator.mjs route "<request>"   explain a routing decision
 *
 * Zero runtime dependencies, deliberately. This tool verifies that a skill
 * ecosystem is sound; making it depend on an npm install would put a supply
 * chain step in front of a security check (§32). The cost is the small YAML
 * subset reader below — the authored YAML is ours, so the subset is a contract
 * we control, and `health` fails loudly if a file exceeds it.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const P = {
  taxonomy: path.join(ROOT, 'registry', 'taxonomy.yaml'),
  overlay: path.join(ROOT, 'registry', 'overlay.yaml'),
  generated: path.join(ROOT, 'registry', 'registry.generated.json'),
  skills: path.join(ROOT, 'skills'),
};

/* ------------------------------------------------------------------ YAML
 * Supports exactly what registry/*.yaml uses: nested maps by 2-space indent,
 * "- " lists, [a, b] inline lists, > folded scalars, # comments, plain scalars.
 * Anything else throws — a silently mis-parsed registry is worse than a crash.
 */
function parseYaml(src, file) {
  const lines = [];
  src.split(/\r?\n/).forEach((raw, i) => {
    if (!raw.trim() || /^\s*#/.test(raw)) return;
    const indent = raw.match(/^ */)[0].length;
    if (indent % 2) throw new Error(`${file}:${i + 1} odd indent (${indent}) — subset requires 2-space steps`);
    lines.push({ indent, text: raw.trim(), n: i + 1 });
  });

  let pos = 0;
  const scalar = (v) => {
    if (v === '' || v === undefined) return null;
    if (v === 'true') return true;
    if (v === 'false') return false;
    if (v === 'null') return null;
    if (/^-?\d+$/.test(v)) return Number(v);
    if (/^\[.*\]$/.test(v)) {
      const inner = v.slice(1, -1).trim();
      return inner ? inner.split(',').map((s) => scalar(s.trim())) : [];
    }
    // inline map: { label: Deploy, parallel: false }. taxonomy.yaml's phases use
    // this; without it they parse as strings and the parallel/gate flags vanish
    // silently — the worst kind of failure, since routing still "works".
    if (/^\{.*\}$/.test(v)) {
      const obj = {};
      const inner = v.slice(1, -1).trim();
      if (!inner) return obj;
      for (const part of inner.split(',')) {
        const kv = part.match(/^([^:]+):\s*(.*)$/);
        if (!kv) throw new Error(`inline map entry is not key: value -> "${part.trim()}"`);
        obj[kv[1].trim()] = scalar(kv[2].trim());
      }
      return obj;
    }
    return v.replace(/^["']|["']$/g, '');
  };

  function folded(minIndent) {
    const parts = [];
    while (pos < lines.length && lines[pos].indent >= minIndent) parts.push(lines[pos++].text);
    return parts.join(' ').trim();
  }

  function parse(indent) {
    if (pos < lines.length && lines[pos].indent === indent && lines[pos].text.startsWith('- ')) {
      const arr = [];
      while (pos < lines.length && lines[pos].indent === indent && lines[pos].text.startsWith('- ')) {
        const inner = lines[pos].text.slice(2).trim();
        const kv = inner.match(/^([^:]+):\s*(.*)$/);
        if (!kv) {
          // plain scalar item
          arr.push(scalar(inner));
          pos++;
          continue;
        }
        // list-of-maps: "- key: value" then sibling keys indented by 2 more.
        // routing.yaml's rules[] is this shape; without it the parser stops dead.
        pos++;
        const obj = {};
        const key = kv[1].trim();
        const rest = kv[2].trim();
        if (rest === '>' || rest === '|') obj[key] = folded(indent + 4);
        else if (rest === '') obj[key] = pos < lines.length && lines[pos].indent > indent + 2 ? parse(indent + 4) : null;
        else obj[key] = scalar(rest);
        if (pos < lines.length && lines[pos].indent === indent + 2) Object.assign(obj, parse(indent + 2));
        arr.push(obj);
      }
      return arr;
    }
    const map = {};
    while (pos < lines.length && lines[pos].indent === indent) {
      const { text, n } = lines[pos];
      const m = text.match(/^([^:]+):\s*(.*)$/);
      if (!m) throw new Error(`${file}:${n} not a key: "${text}"`);
      // Unquote KEYS as well as values. routing.yaml's repo_context keys are
      // quoted globs ("**/hooks.py"); leaving the quotes on produced a regex no
      // path could ever match, so the repo-context signal — a fifth of the
      // scorer — never fired once. Silent, and invisible to the tests because
      // they pin cwd to the repo root, which contains no Frappe files.
      const key = m[1].trim().replace(/^["']|["']$/g, '');
      const rest = m[2].trim();
      pos++;
      if (rest === '>' || rest === '|') map[key] = folded(indent + 2);
      else if (rest === '') map[key] = pos < lines.length && lines[pos].indent > indent ? parse(indent + 2) : null;
      else map[key] = scalar(rest);
    }
    return map;
  }
  const out = parse(0);
  if (pos !== lines.length) throw new Error(`${file}: stopped at line ${lines[pos]?.n} — unsupported structure`);
  return out;
}

export const readYaml = (p) => parseYaml(fs.readFileSync(p, 'utf8'), path.basename(p));

/* ------------------------------------------------------- skill discovery */
function frontmatter(file) {
  const t = fs.readFileSync(file, 'utf8');
  const m = t.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const grab = (k) => {
    const g = m[1].match(new RegExp(`^${k}:\\s*([\\s\\S]*?)(?=\\n[a-z_-]+:|$)`, 'm'));
    return g ? g[1].replace(/\s+/g, ' ').replace(/^[>|"']+|["']$/g, '').trim() : '';
  };
  return { name: grab('name'), description: grab('description') };
}

/** Auto-discovery (§14): any skills/<dir>/SKILL.md is a skill. No hardcoded list. */
function discover() {
  if (!fs.existsSync(P.skills)) return [];
  return fs
    .readdirSync(P.skills, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(P.skills, e.name, 'SKILL.md')))
    .map((e) => ({ id: e.name, ...frontmatter(path.join(P.skills, e.name, 'SKILL.md')) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/* --------------------------------------------------------------- build */
export function build({ quiet = false } = {}) {
  // Installed copies ship the prebuilt registry but not the source skills/ tree
  // (the skills live in ~/.claude/skills, not inside this one skill). Rescanning
  // there would find zero skills and report a healthy-looking empty ecosystem.
  // Use the shipped registry instead — and say so, so nobody mistakes a read for
  // a rebuild.
  if (!fs.existsSync(P.skills) && fs.existsSync(P.generated)) {
    const pre = JSON.parse(fs.readFileSync(P.generated, 'utf8'));
    if (!quiet) console.log(`registry loaded from ${path.basename(P.generated)} (installed copy — no source tree to scan)`);
    return pre;
  }
  const tax = readYaml(P.taxonomy);
  const ov = readYaml(P.overlay);
  const found = discover();
  const skills = found.map((s) => {
    const o = (ov.skills && ov.skills[s.id]) || {};
    return {
      id: s.id,
      name: s.name || s.id,
      description: s.description || '',
      category: o.category ?? null,
      mode: o.mode ?? null,
      priority: o.priority ?? 0,
      phase: o.category && tax.categories[o.category] ? tax.categories[o.category].phase : null,
      triggers: o.triggers || [],
      requires: o.requires || [],
      recommended_before: o.recommended_before || [],
      recommended_after: o.recommended_after || [],
      conflicts_with: o.conflicts_with || [],
      conflict_rule: o.conflict_rule || null,
      condition: o.condition || null,
    };
  });
  const external = Object.entries(ov.external || {}).map(([id, e]) => ({ id, ...e }));
  // No timestamp. The registry is committed so it can be reviewed in a diff; a
  // generatedAt field would dirty the working tree on every build and health
  // run, turning "is the registry current?" into noise. Deterministic output
  // means an unchanged file genuinely proves an unchanged registry.
  const out = {
    registryVersion: ov.version ?? 1,
    counts: {
      discovered: found.length,
      registered: skills.filter((s) => s.category).length,
      external: external.length,
    },
    categories: tax.categories,
    phases: tax.phases,
    modes: ov.modes || [],
    skills,
    external,
  };
  fs.writeFileSync(P.generated, JSON.stringify(out, null, 2) + '\n');
  if (!quiet) {
    console.log('registry built -> registry/registry.generated.json');
    console.log(`  discovered ${out.counts.discovered} · registered ${out.counts.registered} · external ${out.counts.external}`);
  }
  return out;
}

/* -------------------------------------------------------------- health */
function health() {
  const reg = build({ quiet: true });
  const tax = reg.categories;
  const ids = new Set(reg.skills.map((s) => s.id));
  const ov = readYaml(P.overlay);
  const fail = [];
  const warn = [];

  for (const id of Object.keys(ov.skills || {})) {
    if (!ids.has(id)) fail.push(`missing skill: overlay declares "${id}" but skills/${id}/SKILL.md does not exist`);
  }
  for (const s of reg.skills) {
    if (!s.category) {
      fail.push(`orphan skill: "${s.id}" has no overlay entry — it can never be routed`);
    } else {
      if (!tax[s.category]) fail.push(`invalid metadata: "${s.id}" category "${s.category}" not in taxonomy`);
      if (!reg.modes.includes(s.mode)) fail.push(`invalid metadata: "${s.id}" mode "${s.mode}" not one of ${reg.modes.join('|')}`);
    }
    if (!s.description) warn.push(`"${s.id}" has no description — routing relies on it`);
    for (const dep of [...s.requires, ...s.recommended_before, ...s.recommended_after, ...s.conflicts_with]) {
      if (!ids.has(dep)) fail.push(`broken dependency: "${s.id}" references unknown skill "${dep}"`);
    }
  }

  for (const c of Object.keys(tax)) {
    if (!reg.skills.some((s) => s.category === c)) warn.push(`empty category "${c}" — no skill claims it`);
  }

  for (const s of reg.skills) {
    for (const c of s.conflicts_with) {
      const other = reg.skills.find((x) => x.id === c);
      if (other && !other.conflicts_with.includes(s.id)) fail.push(`asymmetric conflict: "${s.id}" conflicts "${c}" but not vice versa`);
    }
  }

  const seen = new Map();
  for (const s of reg.skills) {
    for (const t of s.triggers) {
      const k = String(t).toLowerCase();
      if (seen.has(k)) warn.push(`routing conflict: trigger "${t}" claimed by both "${seen.get(k)}" and "${s.id}"`);
      else seen.set(k, s.id);
    }
  }

  // Normalise every ordering hint to ONE direction: edge A -> B means "A depends
  // on B, so B runs first". requires and recommended_after already point that way;
  // recommended_before points the opposite way and must be inverted. Treating them
  // as the same direction reports a false cycle for the ordinary case where A says
  // "I come before B" and B says "I require A".
  const edges = new Map(reg.skills.map((s) => [s.id, []]));
  for (const s of reg.skills) {
    for (const b of [...s.requires, ...s.recommended_after]) if (edges.has(b)) edges.get(s.id).push(b);
    for (const y of s.recommended_before) if (edges.has(y)) edges.get(y).push(s.id);
  }
  const state = new Map();
  const cycles = [];
  const walk = (id, stack) => {
    if (state.get(id) === 'done') return;
    if (state.get(id) === 'open') {
      cycles.push([...stack.slice(stack.indexOf(id)), id].join(' -> '));
      return;
    }
    state.set(id, 'open');
    for (const nxt of edges.get(id) || []) if (edges.has(nxt)) walk(nxt, [...stack, id]);
    state.set(id, 'done');
  };
  for (const id of edges.keys()) walk(id, []);
  for (const c of [...new Set(cycles)]) fail.push(`dependency cycle: ${c}`);

  const mark = (b, label) => `${b ? '✓' : '✗'} ${label}`;
  const count = (arr, p) => arr.filter((x) => x.startsWith(p)).length;
  console.log('ORCHESTRATOR HEALTH\n');
  console.log(mark(true, `Skills discovered: ${reg.counts.discovered}`));
  console.log(mark(reg.counts.registered === reg.counts.discovered, `Skills registered: ${reg.counts.registered}`));
  console.log(mark(!count(fail, 'missing'), `Missing skills: ${count(fail, 'missing')}`));
  console.log(mark(!count(fail, 'broken'), `Broken dependencies: ${count(fail, 'broken')}`));
  console.log(mark(!cycles.length, `Dependency cycles: ${[...new Set(cycles)].length}`));
  console.log(mark(!count(fail, 'invalid'), `Invalid metadata: ${count(fail, 'invalid')}`));
  console.log(mark(!count(warn, 'routing'), `Routing conflicts: ${count(warn, 'routing')}`));
  console.log(mark(!count(fail, 'orphan'), `Orphan skills: ${count(fail, 'orphan')}`));
  console.log(mark(true, `External sources declared: ${reg.counts.external}`));

  if (fail.length) {
    console.log('\nFAILURES');
    fail.forEach((f) => console.log('  - ' + f));
  }
  if (warn.length) {
    console.log('\nWARNINGS');
    warn.forEach((w) => console.log('  - ' + w));
  }
  console.log(`\nInstallation status: ${fail.length ? 'UNHEALTHY' : 'Healthy'}`);
  return fail.length ? 1 : 0;
}

/* ---------------------------------------------------------------- main */
// Run the CLI only when this file IS the process entry point. route.mjs imports
// this module for readYaml/ROOT; without the guard that import re-executes the
// switch against the same argv and recurses.
// argv[1] is the path as typed; import.meta.url is resolved through symlinks by
// Node. Comparing them raw fails wherever a symlink is in the path — on macOS
// /tmp is a link to /private/tmp, so the CLI silently did nothing and exited 0.
// realpath both sides before comparing.
const IS_ENTRY = (() => {
  if (!process.argv[1]) return false;
  try {
    return pathToFileURL(fs.realpathSync(process.argv[1])).href === pathToFileURL(fs.realpathSync(fileURLToPath(import.meta.url))).href;
  } catch {
    return pathToFileURL(process.argv[1]).href === import.meta.url;
  }
})();
if (IS_ENTRY) {
const [, , cmd, ...rest] = process.argv;
try {
  switch (cmd) {
    case 'build':
      build();
      break;
    case 'health':
      process.exit(health());
      break;
    case 'route': {
      // route.mjs must not import this module back — see the note at its top.
      // Helpers are handed over explicitly so the graph stays acyclic.
      const { route } = await import('./route.mjs');
      const args = rest.filter((a) => !a.startsWith('--'));
      const effortFlag = rest.find((a) => a.startsWith('--effort='));
      route(build({ quiet: true }), args.join(' '), {
        readYaml,
        root: ROOT,
        effort: effortFlag ? effortFlag.split('=')[1] : undefined,
      });
      break;
    }
    case 'plan': {
      // Same acyclic-import discipline as route: both modules are handed in rather
      // than imported by plan.mjs, so nothing points back at this file.
      const routeModule = await import('./route.mjs');
      const swarmModule = await import('./swarm.mjs');
      const { render } = await import('./plan.mjs');
      const args = rest.filter((a) => !a.startsWith('--'));
      const effortFlag = rest.find((a) => a.startsWith('--effort='));
      process.exit(
        render(build({ quiet: true }), args.join(' '), {
          readYaml,
          root: ROOT,
          routeModule,
          swarmModule,
          effort: effortFlag ? effortFlag.split('=')[1] : undefined,
        })
      );
      break;
    }
    case 'pack': {
      const { render } = await import('./pack.mjs');
      process.exit(render(rest.find((a) => !a.startsWith('--')) || process.cwd()));
      break;
    }
    case 'install': {
      const { install, render } = await import('./install.mjs');
      render(
        install({
          root: ROOT,
          readYaml,
          apply: rest.includes('--apply'),
          external: rest.includes('--external'),
          force: rest.includes('--force'),
        })
      );
      break;
    }
    case 'agents': {
      const { buildAgents, render } = await import('./swarm.mjs');
      render(buildAgents({ root: ROOT, readYaml, apply: rest.includes('--apply') }));
      break;
    }
    case 'doctor': {
      const { doctor } = await import('./swarm.mjs');
      process.exit(doctor({ root: ROOT, readYaml, registry: build({ quiet: true }) }));
      break;
    }
    case 'show-agent': {
      const { show } = await import('./swarm.mjs');
      process.exit(show({ root: ROOT, readYaml, id: rest[0] }));
      break;
    }
    default:
      console.log(
        [
          'usage: orchestrator.mjs <command>',
          '',
          '  build                      regenerate the skill registry',
          '  health                     validate the skill ecosystem (§17)',
          '  route "<request>"          explain a routing decision (which skills)',
          '  plan "<request>"           execution plan: agents, parallel batches, model tier',
          '  pack [dir]                 deterministic Context Pack — zero tokens, share it',
          '  install [--apply] [--external] [--force]',
          '  agents [--apply]           generate agents/*.md from registry/agents.yaml',
          '  doctor                     audit the agent roster (§6)',
          '  show-agent <id>            print one resolved agent definition',
        ].join('\n')
      );
      process.exit(2);
  }
} catch (e) {
  console.error('ERROR: ' + e.message);
  process.exit(1);
}
}
