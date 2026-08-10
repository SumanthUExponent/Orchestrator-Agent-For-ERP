/**
 * Routing engine — hybrid: deterministic decision table first, scorer only when
 * the table is ambiguous (no rule matched).
 *
 * Why hybrid: a table is inspectable and testable, so common cases stay
 * predictable and regressions show up in a diff. But a table only answers what it
 * was written for. The scorer covers novel phrasing without turning every routine
 * decision into a floating-point argument.
 *
 * Nothing here executes a skill. This produces a PLAN — which skills, in what
 * order, behind which gates — and explains it (§26). Execution is the model's job.
 */

import fs from 'node:fs';
import path from 'node:path';

// NOTE: this module deliberately does NOT import orchestrator.mjs. The CLI
// dynamically imports this file while it is still evaluating its own top level;
// a static import back would create a cycle that never settles and the process
// would hang on an unsettled top-level await. The caller passes readYaml and
// root in through opts instead.

const norm = (s) => String(s || '').toLowerCase();
const has = (q, phrase) => q.includes(norm(phrase));

/* -------------------------------------------------- repository context (§7D) */
function repoCategories(routing, cwd) {
  const pats = Object.entries(routing.repo_context || {});
  if (!pats.length) return new Set();
  const files = [];
  const skip = new Set(['.git', 'node_modules', '.venv', '__pycache__', 'dist', 'build']);
  const walk = (dir, depth) => {
    if (depth > 4 || files.length > 4000) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (skip.has(e.name)) continue;
      const full = path.join(dir, e.name);
      const rel = path.relative(cwd, full).split(path.sep).join('/');
      if (e.isDirectory()) {
        files.push(rel + '/');
        walk(full, depth + 1);
      } else files.push(rel);
    }
  };
  walk(cwd, 0);
  const cats = new Set();
  for (const [glob, categories] of pats) {
    const re = new RegExp(
      '^' + glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*\//g, '(?:.*/)?').replace(/\*/g, '[^/]*') + '$'
    );
    if (files.some((f) => re.test(f))) for (const c of categories) cats.add(c);
  }
  return cats;
}

/* ------------------------------------------------------------- scorer (§9) */
function scoreSkill(skill, q, repoCats, routing) {
  const w = routing.signals;
  const words = new Set(q.split(/[^a-z0-9.]+/).filter(Boolean));

  let trigger = 0;
  for (const t of skill.triggers || []) {
    if (has(q, t)) {
      trigger = 1;
      break;
    }
    const tw = norm(t).split(/\s+/).filter(Boolean);
    const overlap = tw.filter((x) => words.has(x)).length / Math.max(tw.length, 1);
    trigger = Math.max(trigger, overlap * 0.7); // a partial match never counts as full
  }

  const catWords = new Set(norm(`${skill.category} ${skill.description}`).split(/[^a-z0-9]+/).filter((x) => x.length > 3));
  const inter = [...words].filter((x) => catWords.has(x)).length;
  const categoryIntent = Math.min(1, inter / 4);
  const repo = repoCats.has(skill.category) ? 1 : 0;
  const prio = (skill.priority || 0) / 100;

  const score =
    trigger * w.trigger_match.weight +
    categoryIntent * w.category_intent.weight +
    repo * w.repo_context.weight +
    prio * w.priority_bias.weight;

  return { score: Math.round(score * 100) / 100, parts: { trigger, categoryIntent, repo, prio } };
}

const band = (score, t) =>
  score >= t.mandatory ? 'mandatory' : score >= t.recommended ? 'recommended' : score >= t.conditional ? 'conditional' : score >= t.passive ? 'passive' : 'ignore';

/* --------------------------------------------------------- rule matching */
function ruleMatches(rule, q) {
  if (rule.unless && rule.unless.some((p) => has(q, p))) return false;
  if (rule.when_all && !rule.when_all.every((p) => has(q, p))) return false;
  if (rule.when_any && !rule.when_any.some((p) => has(q, p))) return false;
  if (!rule.when_all && !rule.when_any) return false;
  return true;
}

/* ------------------------------------------------------------------ plan */
export function plan(reg, request, opts = {}) {
  const { readYaml, root } = opts;
  if (!readYaml || !root) throw new Error('plan() requires opts.readYaml and opts.root');
  const routing = readYaml(path.join(root, 'registry', 'routing.yaml'));
  const q = norm(request);
  const byId = new Map(reg.skills.map((s) => [s.id, s]));

  // effort (§24) — an explicit override always wins (§23)
  let effort = opts.effort || 'standard';
  if (!opts.effort) {
    if ((routing.complexity.minimal?.signals || []).some((s) => has(q, s))) effort = 'minimal';
    if ((routing.complexity.full?.signals || []).some((s) => has(q, s))) effort = 'full';
  }

  const matched = (routing.rules || []).filter((r) => ruleMatches(r, q));
  const repoCats = repoCategories(routing, opts.cwd || process.cwd());

  // composites (§20) — policies that add categories, never named skills
  const gates = new Set();
  const addedCats = new Set();
  for (const c of Object.values(routing.composites || {})) {
    const fires = (c.when_any && c.when_any.some((p) => has(q, p))) || (c.trigger_effort && c.trigger_effort === effort);
    if (!fires) continue;
    for (const cat of c.categories || []) addedCats.add(cat);
    for (const g of c.gates || []) gates.add(g);
  }

  const selected = new Map();
  const ruleCats = new Set(); // author-declared: no relevance floor
  let method = 'table';
  const scored = reg.skills.map((s) => ({ s, ...scoreSkill(s, q, repoCats, routing) })).sort((a, b) => b.score - a.score);

  if (matched.length) {
    for (const r of matched) {
      if (r.effort && !opts.effort) effort = r.effort;
      for (const id of r.skills || []) if (byId.has(id)) selected.set(id, { why: `rule:${r.id}` });
      for (const cat of r.categories || []) {
        addedCats.add(cat);
        ruleCats.add(cat); // explicit intent — the floor must not veto it
      }
    }
  } else {
    method = 'scorer';
    for (const { s, score } of scored) {
      if (score >= routing.thresholds.conditional) selected.set(s.id, { why: `scored ${score}` });
    }
  }

  for (const g of routing.effort_modes[effort]?.gates || []) gates.add(g);

  // categories -> skills, with a relevance floor.
  // A composite nominates a CATEGORY; it must not drag in every member. Without
  // this floor "new module" pulled upgrade-checker into the plan purely because
  // it shares the planning category. The skill still has to show some signal from
  // the request itself before a category can enrol it.
  const scoreOf = new Map(scored.map((x) => [x.s.id, x.score]));
  for (const cat of addedCats) {
    for (const s of reg.skills) {
      if (s.category !== cat || selected.has(s.id)) continue;
      const exempt =
        ruleCats.has(cat) || // a rule named this category outright
        s.mode === 'mandatory' ||
        s.mode === 'validation'; // verification is never optimised away
      if (exempt || (scoreOf.get(s.id) ?? 0) >= routing.thresholds.passive) {
        selected.set(s.id, { why: `category:${cat}` });
      }
    }
  }

  // dependency expansion (§11)
  let grew = true;
  while (grew) {
    grew = false;
    for (const id of [...selected.keys()]) {
      const s = byId.get(id);
      // Follow HARD dependencies only. recommended_before/after express ORDER
      // when two skills are both present — they must not conscript a skill into
      // a plan. Following them turned a bug report into a full build chain:
      // "approval" -> frappe-workflow -> frappe-doctype -> module-planner.
      for (const dep of s.requires || []) {
        if (byId.has(dep) && !selected.has(dep)) {
          selected.set(dep, { why: `required by ${id}` });
          grew = true;
        }
      }
    }
  }

  // conflicts (§19) — higher priority wins, the drop is recorded
  const dropped = [];
  for (const id of [...selected.keys()]) {
    if (!selected.has(id)) continue;
    const s = byId.get(id);
    for (const c of s.conflicts_with || []) {
      if (!selected.has(c) || !selected.has(id)) continue;
      const other = byId.get(c);
      const loser = (s.priority || 0) >= (other.priority || 0) ? c : id;
      const winner = loser === c ? id : c;
      selected.delete(loser);
      dropped.push({ id: loser, reason: `conflicts with ${winner}`, rule: s.conflict_rule || other.conflict_rule || null });
    }
  }

  // effort cap (§24) — a mandatory or validation skill is never dropped for budget
  const cap = routing.effort_modes[effort]?.max_skills ?? 99;
  let chosen = [...selected.keys()].map((id) => byId.get(id));
  if (chosen.length > cap) {
    const keep = chosen.filter((s) => s.mode === 'mandatory' || s.mode === 'validation');
    const rest = chosen.filter((s) => !keep.includes(s)).sort((a, b) => (b.priority || 0) - (a.priority || 0));
    const trimmed = [...keep, ...rest].slice(0, Math.max(cap, keep.length));
    for (const s of chosen) if (!trimmed.includes(s)) dropped.push({ id: s.id, reason: `effort cap (${effort}: max ${cap})` });
    chosen = trimmed;
  }

  // phase ordering (§11/§12) — equal phase may run in parallel
  const phases = new Map();
  for (const s of chosen) {
    const p = s.phase ?? 9;
    if (!phases.has(p)) phases.set(p, []);
    phases.get(p).push(s);
  }
  const ordered = [...phases.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([p, list]) => ({
      phase: p,
      label: reg.phases?.[p]?.label ?? `phase ${p}`,
      parallel: (reg.phases?.[p]?.parallel ?? false) && list.length > 1,
      gate: reg.phases?.[p]?.gate ?? null,
      skills: list.sort((a, b) => (b.priority || 0) - (a.priority || 0)).map((s) => s.id),
    }));

  return {
    request,
    effort,
    method,
    matchedRules: matched.map((r) => r.id),
    repoSignals: [...repoCats],
    gates: [...gates],
    phases: ordered,
    selected: chosen.map((s) => ({ id: s.id, why: selected.get(s.id)?.why, mode: s.mode })),
    dropped,
    runnersUp: scored
      .filter((x) => !chosen.some((c) => c.id === x.s.id))
      .slice(0, 4)
      .map((x) => ({ id: x.s.id, score: x.score, band: band(x.score, routing.thresholds) })),
  };
}

/* ---------------------------------------------------------------- render */
export function route(reg, request, opts = {}) {
  if (!String(request || '').trim()) {
    console.log('usage: orchestrator.mjs route "<request>"');
    return 2;
  }
  const p = plan(reg, request, opts);
  console.log(`Request: ${p.request}`);
  console.log(`Effort: ${p.effort}  ·  Decision: ${p.method}${p.matchedRules.length ? ` (${p.matchedRules.join(', ')})` : ''}`);
  if (p.repoSignals.length) console.log(`Repo signals: ${p.repoSignals.join(', ')}`);
  if (p.gates.length) console.log(`Gates: ${p.gates.join(' -> ')}`);
  if (!p.phases.length) {
    // An empty plan is a legitimate outcome for a trivial ask — but it must SAY
    // so. A silent blank was indistinguishable from a routing failure.
    console.log('\nPlan\n  (none) — no skill scored above the routing floor.');
    console.log('  Do this directly; orchestration would cost more than the task.');
    if (p.runnersUp.length) {
      console.log('\nClosest matches');
      for (const r of p.runnersUp) console.log(`  - ${r.id} (${r.score}, ${r.band})`);
    }
    return 0;
  }
  console.log('\nPlan');
  for (const ph of p.phases) {
    console.log(`  ${ph.phase}. ${ph.label}${ph.parallel ? ' [parallel]' : ''}${ph.gate ? `  <gate: ${ph.gate}>` : ''}`);
    for (const id of ph.skills) console.log(`       - ${id}`);
  }
  if (p.dropped.length) {
    console.log('\nDropped');
    for (const d of p.dropped) console.log(`  - ${d.id}: ${d.reason}`);
  }
  if (p.runnersUp.length) {
    console.log('\nConsidered, not selected');
    for (const r of p.runnersUp) console.log(`  - ${r.id} (${r.score}, ${r.band})`);
  }
  return 0;
}
