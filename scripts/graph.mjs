/**
 * Code-graph adapter — Graphify's knowledge graph as a context source.
 *
 * WHY THIS IS AN ADAPTER AND NOT A DEPENDENCY
 *
 * Graphify (github.com/Graphify-Labs/graphify, Apache-2.0) turns a codebase into a
 * queryable graph: tree-sitter AST extraction locally, then an optional LLM pass over
 * docs, then Leiden clustering. It is Python, installed with `uv tool install graphifyy`,
 * and its semantic pass calls a model.
 *
 * JARVIS may not take a runtime dependency, and may not make a model call or a network
 * request anywhere near the speech path. Both rules are non-negotiable and neither is
 * bent here. What this module does is READ A JSON FILE that another tool already
 * produced. No import of Graphify, no subprocess, no network, no model — and if the file
 * is absent, everything degrades to the existing behaviour rather than failing.
 *
 * WHAT IT BUYS
 *
 * `pack` walks the filesystem to a depth of 5 and a cap of 6000 files, and on a real
 * bench it prints "DocTypes: UNKNOWN — scan hit its limit". It lists what EXISTS. It
 * cannot say what CALLS what, and so `impact-analyst` — whose entire job is "identify
 * everything that depends on the code being changed" — has been working from a file
 * listing and its own greps.
 *
 * A graph answers that directly: reverse edges are the blast radius.
 *
 * THE FAILURE MODE THIS MODULE IS MOSTLY ABOUT
 *
 * A stale graph is worse than no graph. It answers confidently and it answers about code
 * that has changed, and nothing in the answer looks wrong — the same shape as an install
 * reporting "already installed" while six commits behind, and as a truncated pack whose
 * empty list reads as "none exist". Graphify records `built_at_commit`; every read
 * compares it to HEAD and every rendered answer carries the verdict. That check is not a
 * nicety here, it is the reason this is safe to put in front of an agent.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/**
 * Relation vocabularies, and why there are two lists rather than one.
 *
 * Graphify's relation names VARY between graphs. A graph built over a Python/Frappe tree
 * emitted `inherits`, `implements`, `method`, `references`; one built over this
 * JavaScript repo emitted `extends`, `imports_from`, `dynamic_import`, `indirect_call`,
 * `defines`. Same tool, different extractors.
 *
 * That matters more than it looks. An unclassified relation is silently EXCLUDED from a
 * dependency traversal, so "2 dependents" gets printed where the truthful answer is 40 —
 * a confident wrong answer with nothing in it that looks wrong. Same failure shape as a
 * stale graph, a truncated pack, and an install that says "already installed".
 *
 * So both vocabularies are covered, and `unclassifiedRelations()` reports anything a
 * future extractor emits that neither list knows. Being told the vocabulary moved is the
 * only way this stays correct.
 */
export const DEPENDENCY_RELATIONS = new Set([
  // seen in the Python/Frappe graph
  'calls', 'imports', 'references', 'inherits', 'implements', 'method',
  // seen in the JavaScript graph
  'extends', 'imports_from', 'dynamic_import', 'indirect_call',
]);

/**
 * Structural containment. True, useful for navigation, and NOT a dependency — `contains`
 * alone is over half the edges in a real graph, so counting it as a dependency floods
 * every blast radius with "this file holds that symbol".
 */
export const STRUCTURAL_RELATIONS = new Set(['contains', 'defines']);

/** Semantic/soft edges: real signal, but not "B breaks if A changes". */
export const SOFT_RELATIONS = new Set(['conceptually_related_to', 'shares_data_with', 'rationale_for', 'form']);

/**
 * Relations present in this graph that no list above classifies.
 *
 * Non-empty means dependency analysis is silently incomplete, so every caller that can
 * print a caveat prints this one.
 */
export function unclassifiedRelations(g) {
  return (g.counts ? g.counts.relations : [])
    .filter((r) => !DEPENDENCY_RELATIONS.has(r) && !STRUCTURAL_RELATIONS.has(r) && !SOFT_RELATIONS.has(r));
}

const MAX_NODES = 60; // never print an unbounded list; that is how context becomes noise

function sh(cmd, args, cwd) {
  try {
    return execFileSync(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return null;
  }
}

/**
 * Find a graph by walking upward from `cwd`.
 *
 * Upward because the graph is built at a repo root and an agent is usually dispatched
 * against a subdirectory — the same reason `findBenchRoot` searches up. Searching only
 * `cwd` reported "no graph" on a machine that has one, which is a confident wrong answer.
 */
export function findGraph(cwd = process.cwd(), { maxUp = 6 } = {}) {
  let dir = path.resolve(cwd);
  for (let i = 0; i <= maxUp; i++) {
    const p = path.join(dir, 'graphify-out', 'graph.json');
    if (fs.existsSync(p)) return p;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

/**
 * Load and index a graph.
 *
 * Adjacency is built in BOTH directions at load time. Reverse edges are the whole point —
 * "what depends on this" is a reverse traversal, and computing it by scanning all edges
 * per query turns an O(1) lookup into an O(edges) one for the query that matters most.
 */
export function load(file, { root = null } = {}) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return { ok: false, error: `unreadable graph at ${file}: ${e.message}` };
  }
  const nodes = Array.isArray(raw.nodes) ? raw.nodes : [];
  // networkx node-link calls them `links`; tolerate `edges` in case a future version does.
  const links = Array.isArray(raw.links) ? raw.links : Array.isArray(raw.edges) ? raw.edges : [];
  if (!nodes.length) return { ok: false, error: `graph at ${file} has no nodes` };

  const byId = new Map();
  for (const n of nodes) if (n && n.id) byId.set(n.id, n);

  const out = new Map();
  const inc = new Map();
  for (const l of links) {
    if (!l || !l.source || !l.target) continue;
    if (!out.has(l.source)) out.set(l.source, []);
    if (!inc.has(l.target)) inc.set(l.target, []);
    out.get(l.source).push(l);
    inc.get(l.target).push(l);
  }

  const repoRoot = root || path.dirname(path.dirname(path.resolve(file)));
  const head = sh('git', ['rev-parse', 'HEAD'], repoRoot);
  const builtAt = raw.built_at_commit || null;
  // A graph with no recorded commit cannot be checked, which is not the same as fresh.
  const freshness = !builtAt
    ? { state: 'unknown', detail: 'the graph records no built_at_commit, so staleness cannot be checked' }
    : !head
      ? { state: 'unknown', detail: 'not a git repository here, so the build commit cannot be compared' }
      : head === builtAt
        ? { state: 'fresh', detail: `built at HEAD (${builtAt.slice(0, 8)})` }
        : staleness(repoRoot, builtAt, head, nodes);

  return {
    ok: true,
    file,
    repoRoot,
    nodes,
    links,
    byId,
    out,
    inc,
    hyperedges: Array.isArray(raw.hyperedges) ? raw.hyperedges : [],
    builtAt,
    head,
    freshness,
    counts: {
      nodes: nodes.length,
      links: links.length,
      inferred: links.filter((l) => l.confidence === 'INFERRED').length,
      relations: [...new Set(links.map((l) => l.relation).filter(Boolean))].sort(),
    },
  };
}

/**
 * Commit differs from HEAD — but is the graph actually out of date?
 *
 * A commit check alone is too coarse in a way that matters. `graphify update` skips
 * rewriting the graph when it finds no topology change, so a commit touching only docs,
 * tests or a README leaves `built_at_commit` behind while the graph is a perfectly
 * accurate description of the code. Reporting that as STALE is crying wolf, and a warning
 * that fires when nothing is wrong is one people learn to scroll past — which costs the
 * real warning its force.
 *
 * So the commit range is compared against the files the graph was actually BUILT from.
 * If none of them changed, the graph is current by content and says so, while still
 * naming the commit gap rather than hiding it. If any did, it is stale and names how many
 * of its own sources moved — which is more useful than a commit count, because two
 * commits touching one graphed file is a smaller problem than one commit touching forty.
 *
 * Uses git only. No dependency, and if git cannot answer, the answer defaults to STALE:
 * the direction that warns is the safe one.
 */
function staleness(repoRoot, builtAt, head, nodes) {
  const gap = sh('git', ['rev-list', '--count', `${builtAt}..HEAD`], repoRoot);
  const detail = `built at ${builtAt.slice(0, 8)}, HEAD is ${head.slice(0, 8)}`;
  const changed = sh('git', ['diff', '--name-only', `${builtAt}..HEAD`], repoRoot);
  if (changed === null) return { state: 'stale', detail, behind: gap };

  const touched = new Set(changed.split('\n').map((x) => x.trim()).filter(Boolean));
  if (!touched.size) return { state: 'stale', detail, behind: gap };

  const sources = new Set(nodes.map((n) => n && n.source_file).filter(Boolean));
  const movedSources = [...touched].filter((f) => sources.has(f));

  if (!movedSources.length) {
    return {
      state: 'current-by-content',
      detail: `${detail}, but none of the ${sources.size} graphed source files changed in those ${gap} commit(s)`,
      behind: gap,
    };
  }
  return {
    state: 'stale',
    detail: `${detail} — ${movedSources.length} graphed source file(s) changed`,
    behind: gap,
    movedSources: movedSources.slice(0, 8),
  };
}

/**
 * Resolve a human's words to node ids.
 *
 * Exact id, then exact label, then normalised label, then substring — in that order, and
 * the order matters: returning a fuzzy match when an exact one exists is how a query
 * about `Widget` answers about `WidgetLedgerEntry` and nobody notices.
 */
export function resolve(g, query, { limit = 8 } = {}) {
  const q = String(query || '').trim();
  if (!q) return [];
  if (g.byId.has(q)) return [g.byId.get(q)];

  const lower = q.toLowerCase();
  const norm = lower.replace(/[^a-z0-9]+/g, '');
  const exact = [];
  const normal = [];
  const partial = [];
  for (const n of g.nodes) {
    const label = String(n.label || '');
    if (label.toLowerCase() === lower) exact.push(n);
    else if (String(n.norm_label || '').toLowerCase().replace(/[^a-z0-9]+/g, '') === norm) normal.push(n);
    else if (label.toLowerCase().includes(lower) || String(n.id).toLowerCase().includes(norm)) partial.push(n);
  }
  return [...exact, ...normal, ...partial].slice(0, limit);
}

/**
 * What depends on this — the blast radius, as a reverse traversal.
 *
 * `structural` is off by default. `contains` is 53% of the edges in a real graph and it
 * means "this file holds that symbol", which floods a dependency answer with facts that
 * are true and irrelevant. Depth defaults to 2 for the same reason: depth 3 on a
 * well-connected node returns most of the repository, and an answer that includes
 * everything has told you nothing.
 */
export function dependents(g, id, { depth = 2, structural = false, includeInferred = true } = {}) {
  const wanted = (l) => {
    if (!includeInferred && l.confidence === 'INFERRED') return false;
    if (DEPENDENCY_RELATIONS.has(l.relation)) return true;
    return structural && STRUCTURAL_RELATIONS.has(l.relation);
  };
  const seen = new Map();
  let frontier = [id];
  for (let d = 1; d <= depth; d++) {
    const next = [];
    for (const cur of frontier) {
      for (const l of g.inc.get(cur) || []) {
        if (!wanted(l)) continue;
        if (seen.has(l.source)) continue;
        seen.set(l.source, { id: l.source, node: g.byId.get(l.source), via: l.relation, depth: d, confidence: l.confidence, at: l.source_file });
        next.push(l.source);
      }
    }
    frontier = next;
    if (!frontier.length) break;
  }
  return [...seen.values()].sort((a, b) => a.depth - b.depth || String(a.id).localeCompare(String(b.id)));
}

/** What this depends on — the forward direction. Same filtering rules. */
export function dependencies(g, id, { depth = 2, structural = false, includeInferred = true } = {}) {
  const wanted = (l) => {
    if (!includeInferred && l.confidence === 'INFERRED') return false;
    if (DEPENDENCY_RELATIONS.has(l.relation)) return true;
    return structural && STRUCTURAL_RELATIONS.has(l.relation);
  };
  const seen = new Map();
  let frontier = [id];
  for (let d = 1; d <= depth; d++) {
    const next = [];
    for (const cur of frontier) {
      for (const l of g.out.get(cur) || []) {
        if (!wanted(l)) continue;
        if (seen.has(l.target)) continue;
        seen.set(l.target, { id: l.target, node: g.byId.get(l.target), via: l.relation, depth: d, confidence: l.confidence, at: l.source_file });
        next.push(l.target);
      }
    }
    frontier = next;
    if (!frontier.length) break;
  }
  return [...seen.values()].sort((a, b) => a.depth - b.depth || String(a.id).localeCompare(String(b.id)));
}

/**
 * Shortest path between two nodes, undirected.
 *
 * Undirected on purpose: the question "how are these two related" does not care which
 * way the arrow points, and Graphify writes `directed: false` in the graph it emits.
 */
export function shortestPath(g, from, to) {
  if (from === to) return [{ id: from, node: g.byId.get(from) }];
  const prev = new Map([[from, null]]);
  const queue = [from];
  while (queue.length) {
    const cur = queue.shift();
    const edges = [...(g.out.get(cur) || []), ...(g.inc.get(cur) || [])];
    for (const l of edges) {
      const nxt = l.source === cur ? l.target : l.source;
      if (prev.has(nxt)) continue;
      prev.set(nxt, { from: cur, via: l.relation, confidence: l.confidence });
      if (nxt === to) {
        const chain = [];
        let at = to;
        while (at !== null && at !== undefined) {
          const step = prev.get(at);
          chain.unshift({ id: at, node: g.byId.get(at), via: step ? step.via : null, confidence: step ? step.confidence : null });
          at = step ? step.from : null;
        }
        return chain;
      }
      queue.push(nxt);
    }
  }
  return null;
}

/** One node and its immediate edges, both directions. */
export function explain(g, id) {
  const node = g.byId.get(id);
  if (!node) return null;
  return {
    node,
    outgoing: (g.out.get(id) || []).map((l) => ({ to: l.target, label: (g.byId.get(l.target) || {}).label, via: l.relation, confidence: l.confidence })),
    incoming: (g.inc.get(id) || []).map((l) => ({ from: l.source, label: (g.byId.get(l.source) || {}).label, via: l.relation, confidence: l.confidence })),
    hyperedges: g.hyperedges.filter((h) => Array.isArray(h.nodes) && h.nodes.includes(id)).map((h) => ({ id: h.id, label: h.label, relation: h.relation })),
  };
}

/**
 * The freshness banner.
 *
 * Printed above every answer, not once at the top of a session, because an agent reads
 * one answer and a caveat it did not see does not apply to it.
 */
export function freshnessNote(g) {
  const unknown = unclassifiedRelations(g);
  const vocab = unknown.length
    ? `\n> **UNKNOWN RELATIONS: ${unknown.join(', ')}.** These are excluded from dependency\n> traversal, so any count below is a FLOOR, not a total. Classify them in scripts/graph.mjs.`
    : '';
  const f = g.freshness;
  if (f.state === 'fresh') return `> Graph is current — ${f.detail}.${vocab}`;
  if (f.state === 'current-by-content') {
    return (
      `> Graph is current by content — ${f.detail}.\n` +
      '> The commit moved on, none of the code it describes did. Treated as usable.' +
      vocab
    );
  }
  if (f.state === 'stale') {
    return [
      `> **STALE GRAPH — ${f.detail}${f.behind ? `, ${f.behind} commit(s) behind` : ''}.**`,
      '> Every answer below describes the code as it was at that commit. A stale graph is',
      '> worse than none: it answers confidently about code that has changed. Rebuild with',
      '> `graphify .` before trusting an impact analysis.',
    ].join('\n') + vocab;
  }
  return `> Graph freshness UNKNOWN — ${f.detail}. Treat it as possibly stale.${vocab}`;
}

/** A compact section for the Context Pack. */
export function packSection(g, { limit = MAX_NODES } = {}) {
  const out = ['', '## Code graph', '', freshnessNote(g), ''];
  out.push(
    `- **Source**: \`${path.relative(g.repoRoot, g.file)}\` (Graphify)`,
    `- **Size**: ${g.counts.nodes} nodes, ${g.counts.links} edges${g.counts.inferred ? `, ${g.counts.inferred} INFERRED` : ''}`,
    `- **Relations**: ${g.counts.relations.join(', ')}`
  );
  // The most-depended-upon nodes are the ones a change is most likely to break, so they
  // are the ones worth spending pack space on.
  const inbound = [...g.inc.entries()]
    .map(([id, ls]) => ({ id, n: ls.filter((l) => DEPENDENCY_RELATIONS.has(l.relation)).length }))
    .filter((x) => x.n > 0)
    .sort((a, b) => b.n - a.n)
    .slice(0, 12);
  if (inbound.length) {
    out.push('', '**Most depended upon** — a change here has the widest blast radius:', '');
    for (const x of inbound) {
      const node = g.byId.get(x.id) || {};
      out.push(`- \`${node.label || x.id}\` — ${x.n} dependent${x.n === 1 ? '' : 's'}${node.source_file ? ` (${node.source_file})` : ''}`);
    }
  }
  out.push(
    '',
    'Query it rather than grepping: `jarvis.mjs graph dependents "<name>"` for blast radius,',
    '`graph path A B` for how two things connect, `graph explain "<name>"` for one node.'
  );
  if (g.counts.nodes > limit) {
    out.push('', `> Only the top ${inbound.length} of ${g.counts.nodes} nodes are listed. Absent is NOT the same as unconnected.`);
  }
  return out.join('\n');
}

/** Locate + load in one call, returning null rather than throwing when absent. */
export function open(cwd = process.cwd()) {
  const file = findGraph(cwd);
  if (!file) return null;
  const g = load(file);
  return g.ok ? g : null;
}
