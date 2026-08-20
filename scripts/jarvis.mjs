#!/usr/bin/env node
/**
 * JARVIS CLI — registry build, health check, routing.
 *
 *   node scripts/jarvis.mjs build     regenerate registry.generated.json
 *   node scripts/jarvis.mjs health    validate the ecosystem (§17)
 *   node scripts/jarvis.mjs route "<request>"   explain a routing decision
 *   node scripts/jarvis.mjs voice --apply       install the voice layer
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
/**
 * Strip quotes only when they are a MATCHED PAIR wrapping the whole value.
 *
 * The old form was `.replace(/^["']|["']$/g, '')`, which strips a leading or a
 * trailing quote independently. Any value merely ENDING in a quote lost it:
 *   runs: node scripts/jarvis.mjs route "<request>"
 * became `... route "<request>` — an unterminated quote, shipped into the generated
 * agent as its primary command. Silent, and only visible if you ran the command.
 */
function unquote(v) {
  const q = v[0];
  if ((q === '"' || q === "'") && v.length > 1 && v[v.length - 1] === q) return v.slice(1, -1);
  return v;
}

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
    return unquote(v);
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
      const key = unquote(m[1].trim());
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
  console.log('JARVIS HEALTH\n');
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
      const { render, executionPlan } = await import('./plan.mjs');
      const args = rest.filter((a) => !a.startsWith('--'));
      const effortFlag = rest.find((a) => a.startsWith('--effort='));
      const request = args.join(' ');
      const reg = build({ quiet: true });
      const planOpts = {
        readYaml,
        root: ROOT,
        routeModule,
        swarmModule,
        reviewLoop: swarmModule.loadAgents({ root: ROOT, readYaml }).reviewLoop,
        effort: effortFlag ? effortFlag.split('=')[1] : undefined,
      };
      const rc = render(reg, request, planOpts);

      // PRINT the human-approval gates, not just speak them.
      //
      // `Gates: verify` in the plan above is a PHASE gate. The seven human gates are a
      // different thing entirely and the planner never computed them, so
      // "drop the audit table" printed no warning at all -- the only place they
      // surfaced was the spoken announcement, which is no use to someone reading.
      //
      // matchGates is a heuristic and says so: two independent signals per gate, and []
      // when unsure, because a false gate warning is the one warning people learn to
      // ignore. The authoritative path is still an agent refusing and emitting GATE:.
      try {
        const { matchGates } = await import('./voice.mjs');
        const { gates: sevenGates } = swarmModule.loadAgents({ root: ROOT, readYaml });
        const hit = matchGates(request, sevenGates);
        if (hit.length) {
          console.log('\nHuman approval required before this runs');
          for (const g of hit) console.log(`  ! ${g}`);
          console.log('  Nothing here dispatches on its own. This is the line a human signs.');
        }
      } catch { /* voice module absent: the plan above is still complete */ }

      // Speak the decisions AFTER printing them, so the text is on screen before the
      // voice starts. Announced from HERE and not from plan.mjs render(), which stays
      // pure: executionPlan is unit-tested and must not spawn anything.
      //
      // Wrapped, and silent on failure. A planner that cannot plan because the voice
      // layer is missing would be a far worse tool than a quiet one. --quiet-voice
      // suppresses it entirely.
      if (!rest.includes('--quiet-voice')) {
        try {
          const { announcePlan } = await import('./voice.mjs');
          const { gates: humanGates } = swarmModule.loadAgents({ root: ROOT, readYaml });
          announcePlan(executionPlan(reg, request, planOpts), {
            requestedEffort: planOpts.effort,
            request,
            gates: humanGates,
          });
        } catch { /* voice layer absent: nothing to announce through */ }
      }
      process.exit(rc);
      break;
    }
    case 'bench': {
      const routeModule = await import('./route.mjs');
      const swarmModule = await import('./swarm.mjs');
      const planModule = await import('./plan.mjs');
      const { render } = await import('./bench.mjs');
      process.exit(
        render(build({ quiet: true }), {
          readYaml,
          root: ROOT,
          cwd: ROOT,
          routeModule,
          swarmModule,
          planModule,
          loadAgents: swarmModule.loadAgents,
        })
      );
      break;
    }
    case 'pack': {
      const { render, ROLE_SCOPES } = await import('./pack.mjs');
      // `--for <agent>` narrows the pack to the sections that role needs (§14). The
      // flag's VALUE is not a directory, so it must be excluded from the positional --
      // the same defect that fed `--round 2` back in as a filename in `loop`.
      const fi = rest.indexOf('--for');
      const role = fi >= 0 ? rest[fi + 1] : null;
      const consumed = new Set(fi >= 0 ? [fi, fi + 1] : []);
      const dir = rest.find((a, i) => !a.startsWith('--') && !consumed.has(i)) || process.cwd();
      if (role && !ROLE_SCOPES[role]) {
        console.error(`pack: no scope mapped for "${role}" — emitting the FULL pack rather than guessing.`);
        console.error(`  Mapped roles: ${Object.keys(ROLE_SCOPES).sort().join(', ')}`);
      }
      process.exit(render(dir, { role }));
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
    case 'voice': {
      const { installVoice, render } = await import('./voice.mjs');
      process.exit(
        render(
          installVoice({
            root: ROOT,
            apply: rest.includes('--apply'),
            force: rest.includes('--force'),
          })
        )
      );
      break;
    }
    case 'agents': {
      const { buildAgents, render } = await import('./swarm.mjs');
      render(buildAgents({ root: ROOT, readYaml, apply: rest.includes('--apply') }));
      break;
    }
    case 'learn': {
      // Reads the ledger, proposes, writes a file nothing loads. The last step is a
      // human on purpose -- see the header of learn.mjs.
      const learnModule = await import('./learn.mjs');
      const voiceModule = await import('./voice.mjs');
      process.exit(
        learnModule.render({
          root: ROOT,
          ledgerDir: path.join(voiceModule.jarvisDir(), 'ledger'),
          apply: rest.includes('--apply'),
        })
      );
      break;
    }
    case 'evaluate': {
      // Flip-centered, per the assessment. Cheap because routing involves no model.
      const evalModule = await import('./evaluate.mjs');
      const planModule = await import('./plan.mjs');
      const routeModule = await import('./route.mjs');
      const swarmModule = await import('./swarm.mjs');
      const voiceModule = await import('./voice.mjs');
      process.exit(
        evalModule.render({
          root: ROOT,
          readYaml,
          buildRegistry: build,
          planModule,
          routeModule,
          swarmModule,
          voiceModule,
          save: rest.includes('--save'),
        })
      );
      break;
    }
    case 'loop': {
      // The driver for `review_loop`. Reads collected handoffs and answers the one
      // question the loop existed to ask and nothing enforced: is this done?
      //
      // Exit code is the contract: 0 means done, 1 means another round is owed. That is
      // what makes it usable from a script, and what stops "done" being a judgement
      // call made by whoever is tired.
      const loopModule = await import('./loop.mjs');
      const { loadAgents } = await import('./swarm.mjs');
      const { protocol, gates, reviewLoop } = loadAgents({ root: ROOT, readYaml });

      // A flag's VALUE is not a handoff file. Filtering on the `--` prefix alone fed
      // `--round 2 --history h.json` back in as three files named "2" and "h.json",
      // and the run died on ENOENT reading "2" -- with the error swallowed if stderr
      // was redirected, which is exactly how it was found.
      const VALUED = new Set(['round', 'history', 'session']);
      const consumed = new Set();
      for (let i = 0; i < rest.length; i++) {
        const m = rest[i].match(/^--(.+)$/);
        if (m && VALUED.has(m[1])) { consumed.add(i); consumed.add(i + 1); }
      }
      const files = rest.filter((a, i) => !a.startsWith('--') && !consumed.has(i));
      const flag = (name) => {
        const i = rest.indexOf(`--${name}`);
        return i >= 0 ? rest[i + 1] : undefined;
      };

      let texts = [];
      if (files.length) {
        texts = files.map((f) => ({ agent: path.basename(f).replace(/\.[^.]+$/, ''), text: fs.readFileSync(f, 'utf8') }));
      } else {
        // stdin, so the coordinator can pipe handoffs straight in without touching disk.
        const chunks = [];
        for await (const c of process.stdin) chunks.push(c);
        const all = Buffer.concat(chunks).toString('utf8');
        if (!all.trim()) {
          console.error('loop: no handoffs. Pass files, or pipe them on stdin.');
          console.error('  A round with no output is not a round that passed, so this is exit 1.');
          process.exit(1);
        }
        // `---` between handoffs, since agents return markdown and that is the one
        // separator markdown already reserves.
        texts = all.split(/^---+$/m).filter((t) => t.trim()).map((t, i) => ({ agent: `agent-${i + 1}`, text: t }));
      }

      const handoffs = texts.map(({ agent, text }) => loopModule.parseHandoff(text, { agent }));
      const historyFile = flag('history');
      const history = historyFile && fs.existsSync(historyFile)
        ? JSON.parse(fs.readFileSync(historyFile, 'utf8'))
        : [];
      const v = loopModule.verdict({
        handoffs,
        round: Number(flag('round')) || 1,
        reviewLoop,
        protocol,
        gates,
        history,
      });
      const code = loopModule.render(v);
      // Carry the objection keys forward, or no-progress cannot be detected next round.
      if (historyFile) fs.writeFileSync(historyFile, JSON.stringify(v.history, null, 2) + '\n');

      // Record, unless told not to. ON by default: the ledger's whole problem was that
      // nothing ever wrote to it, and an opt-in recorder would have reproduced that
      // exactly. The driver already holds every handoff, so this costs one append.
      if (!rest.includes('--no-record')) {
        const voiceMod = await import('./voice.mjs');
        const res = loopModule.recordLedger(v, handoffs, {
          dir: path.join(voiceMod.jarvisDir(), 'ledger'),
          session: flag('session') || 'loop',
        });
        if (res.written) {
          console.log(`Ledger: +${res.written} row${res.written === 1 ? '' : 's'} -> ${res.file}`);
          console.log('  `jarvis.mjs learn` reads these. It proposes nothing until 5+ runs per agent.');
        } else if (res.error) {
          console.log(`Ledger: not written (${res.error}). The verdict above stands regardless.`);
        }
      }
      process.exit(code);
      break;
    }
    case 'graph': {
      // Reads a Graphify graph.json if one exists. No import of Graphify, no subprocess,
      // no network, no model -- this is a JSON reader, which is the only shape that fits
      // the no-new-dependencies rule. Absent graph => a message and exit 2, never a throw.
      const G = await import('./graph.mjs');
      const sub = rest[0] || 'status';
      const args = rest.slice(1).filter((a) => !a.startsWith('--'));
      const dirFlag = rest.indexOf('--dir');
      const where = dirFlag >= 0 ? rest[dirFlag + 1] : process.cwd();
      const depthFlag = rest.indexOf('--depth');
      const depth = depthFlag >= 0 ? Number(rest[depthFlag + 1]) || 2 : 2;
      const structural = rest.includes('--structural');

      const file = G.findGraph(where);
      if (!file) {
        console.log('No code graph found.');
        console.log('');
        console.log('JARVIS reads one if it is there and works fine without it. To create one:');
        console.log('  uv tool install graphifyy   # once');
        console.log('  graphify .                  # in the repo you want mapped');
        console.log('');
        console.log('It writes graphify-out/graph.json, which is all this reads. Until then,');
        console.log('`pack` gives the file listing and agents fall back to grep.');
        process.exit(2);
      }
      const g = G.load(file);
      if (!g.ok) { console.error(g.error); process.exit(1); }

      const pick = (q) => {
        const hits = G.resolve(g, q);
        if (!hits.length) {
          console.error(`No node matches "${q}".`);
          console.error('  Try `graph status` for the relation types, or a shorter substring.');
          process.exit(1);
        }
        if (hits.length > 1) {
          console.log(`"${q}" matched ${hits.length}; using the closest. Others:`);
          for (const h of hits.slice(1, 5)) console.log(`  - ${h.label}  (${h.source_file || '?'})`);
          console.log('');
        }
        return hits[0];
      };

      console.log(G.freshnessNote(g));
      console.log('');

      if (sub === 'status') {
        console.log(`Graph: ${file}`);
        console.log(`  ${g.counts.nodes} nodes, ${g.counts.links} edges, ${g.counts.inferred} INFERRED`);
        console.log(`  relations: ${g.counts.relations.join(', ')}`);
        console.log(`  built at: ${g.builtAt || 'unrecorded'}`);
      } else if (sub === 'dependents' || sub === 'dependencies') {
        const node = pick(args.join(' '));
        const fn = sub === 'dependents' ? G.dependents : G.dependencies;
        const rows = fn(g, node.id, { depth, structural });
        console.log(`${sub === 'dependents' ? 'What depends on' : 'What this depends on'}: ${node.label}`);
        console.log(`  ${node.source_file || '?'}  ${node.source_location || ''}`);
        console.log('');
        if (!rows.length) {
          console.log('  Nothing, by dependency relations at this depth.');
          console.log('  That is not proof of none: pass --structural for `contains`, or --depth 3.');
        }
        for (const r of rows) {
          const inf = r.confidence === 'INFERRED' ? '  [INFERRED]' : '';
          console.log(`  d${r.depth}  ${(r.node || {}).label || r.id}  --${r.via}-->${inf}`);
          if (r.at) console.log(`        ${r.at}`);
        }
        console.log('');
        console.log(`  ${rows.length} total. INFERRED edges were derived, not read from source.`);
      } else if (sub === 'path') {
        if (args.length < 2) { console.error('usage: graph path <from> <to>'); process.exit(1); }
        const a = pick(args[0]);
        const b = pick(args[1]);
        const chain = G.shortestPath(g, a.id, b.id);
        if (!chain) {
          console.log(`No path between ${a.label} and ${b.label}.`);
          console.log('  They are in different components of the graph — which is itself a finding.');
          process.exit(0);
        }
        console.log(`${a.label}  ->  ${b.label}   (${chain.length - 1} hop${chain.length === 2 ? '' : 's'})`);
        console.log('');
        for (const step of chain) {
          console.log(`  ${step.via ? `--${step.via}-->  ` : ''}${(step.node || {}).label || step.id}`);
        }
      } else if (sub === 'explain') {
        const node = pick(args.join(' '));
        const e = G.explain(g, node.id);
        console.log(`${e.node.label}`);
        console.log(`  ${e.node.source_file || '?'}  ${e.node.source_location || ''}   type: ${e.node.file_type}`);
        if (e.incoming.length) {
          console.log('', '\n  Depended on by:');
          for (const i of e.incoming.slice(0, 20)) console.log(`    ${i.label || i.from}  --${i.via}-->`);
        }
        if (e.outgoing.length) {
          console.log('\n  Depends on:');
          for (const o of e.outgoing.slice(0, 20)) console.log(`    --${o.via}-->  ${o.label || o.to}`);
        }
        if (e.hyperedges.length) {
          console.log('\n  Part of:');
          for (const h of e.hyperedges) console.log(`    ${h.label} (${h.relation})`);
        }
      } else {
        console.error(`graph: unknown subcommand "${sub}"`);
        console.error('  status | dependents <name> | dependencies <name> | path <a> <b> | explain <name>');
        process.exit(1);
      }
      process.exit(0);
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
          'usage: jarvis.mjs <command>',
          '',
          '  build                      regenerate the skill registry',
          '  health                     validate the skill ecosystem (§17)',
          '  route "<request>"          explain a routing decision (which skills)',
          '  plan "<request>"           execution plan: agents, parallel batches, model tier',
          '  pack [dir] [--for <agent>] deterministic Context Pack; --for narrows it by role (§14)',
          '  bench                      before/after efficiency benchmark over a fixed corpus',
          '  install [--apply] [--external] [--force]',
        '  voice [--apply] [--force]  install the JARVIS voice layer and its hooks',
          '  agents [--apply]           generate agents/*.md from registry/agents.yaml',
          '  graph <sub> [--dir d]      query a Graphify code graph if one exists (optional)',
          '                             status | dependents | dependencies | path | explain',
          '  loop [handoff...]          is it done? drives review_loop; exit 0 done, 1 owed',
          '  evaluate [--save]          flip-centered routing probes (§18)',
          '  learn [--apply]            propose routing hints from the ledger (§11)',
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
