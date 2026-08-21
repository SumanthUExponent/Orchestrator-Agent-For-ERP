/**
 * Learning — turn ledger observations into routing hints a human can accept or refuse.
 *
 * WHAT THIS IS NOT
 *
 * It is not self-modification. Nothing here edits the registry, the routing table or an
 * agent. It writes a PROPOSAL to registry/hints.yaml, and a proposal only takes effect
 * once someone has read it and moved it into the real table. "Changing the swarm
 * architecture itself" and "generating a new agent" are two of the seven gates; a
 * system that quietly re-tunes its own router has removed the reason those gates exist.
 *
 * So the loop is deliberately open at the last step:
 *
 *   ledger  ->  proposal  ->  [ human reads it ]  ->  routing table
 *                    |
 *                    +-- evaluate: any P->F and the proposal is refused outright
 *
 * WHY THE EVIDENCE BAR IS HIGH
 *
 * A hint drawn from three runs is superstition. EvoRoute (arXiv 2601.02695) refines a
 * routing policy from environment feedback, but it samples many trajectories first --
 * we cannot afford that, so we compensate by refusing to propose anything until the
 * same signal has repeated. MIN_RUNS is the whole difference between learning and
 * pattern-matching on noise.
 *
 * WHAT IT LOOKS FOR
 *
 * Only signals the ledger can actually support, and each one is a fact rather than an
 * inference:
 *   - an agent that has never once reported SUCCESS      -> is it routed for the wrong work?
 *   - an agent that never reports STATUS at all          -> protocol failure, not routing
 *   - an agent whose work is repeatedly left unverified  -> its verification is missing
 *   - a recommended_next_agent that recurs               -> a dependency the registry lacks
 */

import fs from 'node:fs';
import path from 'node:path';

/** Below this, a pattern is noise. Raising it costs nothing; lowering it costs trust. */
export const MIN_RUNS = 5;

export function readLedger(dir) {
  if (!fs.existsSync(dir)) return [];
  const rows = [];
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort()) {
    for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      try { rows.push(JSON.parse(t)); } catch { /* a torn line is not worth failing over */ }
    }
  }
  return rows;
}

/**
 * Is this row evidence, or is it a dispatch that happened?
 *
 * The ledger reached 188 rows of which 168 named no agent and **every single one** reported
 * `status: unreported`. They were real SubagentStop events -- but for generic agents
 * (`general-purpose`, `Explore`, `claude-code-guide`) that were never given the handoff
 * protocol, so they emit no STATUS marker and there is nothing to learn from them.
 *
 * Counting them anyway is the confidently-wrong failure: `learn` would report "168 runs,
 * never emitted STATUS -> protocol failure" for agents that have no protocol, and the real
 * signal from the 20 attributable rows would be buried under it.
 *
 * Excluded, never deleted. The rows stay on disk -- they are a true record of what was
 * dispatched -- and the exclusion count is reported, because silently dropping 89% of the
 * corpus is exactly the kind of quiet filtering that makes a number untrustworthy.
 */
export function isEvidence(r) {
  const agent = String(r.agent || '').trim();
  const status = String(r.status || '').trim().toLowerCase();
  if (!agent || agent === 'unknown') return false;
  if (!status || status === 'unreported') return false;
  return true;
}

/** Aggregate per agent. Facts only — no scoring, no ranking. */
export function summarise(rows) {
  const by = new Map();
  for (const r of rows) {
    const a = r.agent || 'unknown';
    if (!by.has(a)) by.set(a, { agent: a, runs: 0, success: 0, partial: 0, blocked: 0, failed: 0, silent: 0, unverified: 0, next: new Map() });
    const e = by.get(a);
    e.runs++;
    const st = String(r.status || 'unreported').toUpperCase();
    if (st === 'SUCCESS') e.success++;
    else if (st === 'PARTIAL') e.partial++;
    else if (st === 'BLOCKED') e.blocked++;
    else if (st === 'FAILED') e.failed++;
    else e.silent++;
    if (r.unverified === 1 || r.unverified === true) e.unverified++;
    const n = r.next && r.next !== 'none' ? r.next : null;
    if (n) e.next.set(n, (e.next.get(n) || 0) + 1);
  }
  return [...by.values()];
}

/** Propose. Each proposal states the evidence, because an unexplained hint is a guess. */
export function propose(summary, { minRuns = MIN_RUNS } = {}) {
  const out = [];
  for (const e of summary) {
    if (e.runs < minRuns) continue;

    if (e.silent === e.runs) {
      out.push({
        kind: 'protocol',
        agent: e.agent,
        evidence: `${e.runs} runs, never emitted STATUS`,
        proposal: `${e.agent} does not follow the handoff protocol. This is not a routing problem and a routing hint will not fix it — regenerate the agent, or find out why the contract is not reaching it.`,
      });
      continue;
    }
    if (e.success === 0) {
      out.push({
        kind: 'routing',
        agent: e.agent,
        evidence: `${e.runs} runs, 0 SUCCESS (${e.failed} failed, ${e.partial} partial, ${e.blocked} blocked)`,
        proposal: `${e.agent} has never completed the work it is being given. Either it is routed for the wrong requests, or it is missing a capability. Look before re-routing.`,
      });
    }
    if (e.unverified >= Math.ceil(e.runs / 2)) {
      out.push({
        kind: 'verification',
        agent: e.agent,
        evidence: `${e.unverified} of ${e.runs} runs left work unverified`,
        proposal: `${e.agent} routinely hands over unchecked work. Pair it with a validation agent in the routing table, or give it the means to verify its own.`,
      });
    }
    for (const [next, n] of e.next) {
      if (n >= minRuns) {
        out.push({
          kind: 'dependency',
          agent: e.agent,
          evidence: `${e.agent} recommended ${next} on ${n} of ${e.runs} runs`,
          proposal: `Consider declaring ${next} in ${e.agent}'s recommended_after, so the router stops rediscovering it. The agents already know this; the registry does not.`,
        });
      }
    }
  }
  return out;
}

/**
 * The capacity cap — Two-Gate's second gate.
 *
 * arXiv:2510.04399 (TMLR 2026) proves PAC learnability survives self-modification *iff*
 * the policy-reachable family stays uniformly capacity-bounded, and proposes a two-gate
 * guardrail: a validation-improvement requirement AND a cap on how much may change. This
 * system had gate one (flip-gated evaluation, human approval) and nothing bounding the
 * SIZE of a single accepted change.
 *
 * Without it, "the proposal passed the gate" says nothing about blast radius: one approved
 * hint could rewrite the whole routing table and still pass 19 probes, because probes test
 * shape and not scope.
 *
 * Deliberately small numbers. A proposal that wants to change more than this is not a
 * refinement, it is an architecture change -- which is one of the seven human gates and
 * belongs there rather than here.
 */
export const CAPACITY_CAP = {
  proposals_per_run: 5,
  agents_touched: 3,
  // The optimiser may not propose changes to the machinery that judges it. This is the
  // one entry that is a boundary rather than a budget.
  forbidden_targets: ['registry/probes.json', 'scripts/evaluate.mjs', 'scripts/learn.mjs', '.eval-baseline.json'],
};

/**
 * Enforce the cap. Returns what survives plus what was withheld and why.
 *
 * Withheld, not silently truncated: a proposal dropped without a word is the same defect
 * as a silently-capped benchmark, and the whole point of the inert-file design is that a
 * human sees everything the loop concluded.
 */
export function applyCap(proposals, cap = CAPACITY_CAP) {
  const kept = [];
  const withheld = [];
  const agents = new Set();
  for (const pr of proposals) {
    if (kept.length >= cap.proposals_per_run) {
      withheld.push({ ...pr, why: `over the per-run cap of ${cap.proposals_per_run} proposals` });
      continue;
    }
    const next = new Set(agents);
    next.add(pr.agent);
    if (next.size > cap.agents_touched) {
      withheld.push({ ...pr, why: `would touch a ${next.size}th agent; cap is ${cap.agents_touched}` });
      continue;
    }
    agents.add(pr.agent);
    kept.push(pr);
  }
  return { kept, withheld };
}

export function render({ root, ledgerDir, apply }) {
  const rows = readLedger(ledgerDir);
  if (!rows.length) {
    console.log('No ledger yet, so nothing to learn from.');
    console.log('It fills as sub-agents report. Until then, any "hint" would be invention.');
    return 0;
  }
  const usable = rows.filter(isEvidence);
  const excluded = rows.length - usable.length;
  const summary = summarise(usable);
  const proposals = propose(summary);

  console.log(`LEDGER: ${rows.length} rows, ${usable.length} usable across ${summary.length} agents`);
  if (excluded) {
    console.log(`  ${excluded} excluded: no agent named, or no status reported. Real dispatches,`);
    console.log(`  but of generic agents that were never given the handoff protocol — so there is`);
    console.log(`  nothing in them to learn from. Kept on disk; not counted.`);
  }
  if (!usable.length) {
    console.log('\nNothing usable yet. The loop fills as PROTOCOL-FOLLOWING agents report —');
    console.log('a dispatch of a generic agent is a fact about the session, not about an agent.');
    return 0;
  }
  console.log('');
  for (const e of summary.sort((a, b) => b.runs - a.runs)) {
    console.log(`  ${e.agent.padEnd(22)} ${String(e.runs).padStart(4)} runs   ${e.success} success · ${e.partial} partial · ${e.blocked} blocked · ${e.failed} failed${e.silent ? ` · ${e.silent} silent` : ''}`);
  }

  console.log(`\nPROPOSALS  (evidence bar: ${MIN_RUNS}+ runs before anything is proposed)\n`);
  if (!proposals.length) {
    console.log('  none. Either the evidence is thin, or nothing needs changing —');
    console.log('  and inventing a hint to look busy is how a learning loop starts lying.');
    return 0;
  }
  for (const p of proposals) {
    console.log(`  [${p.kind}] ${p.agent}`);
    console.log(`      evidence: ${p.evidence}`);
    console.log(`      proposal: ${p.proposal}\n`);
  }

  const { kept, withheld } = applyCap(proposals);
  if (withheld.length) {
    console.log(`WITHHELD BY THE CAPACITY CAP (${withheld.length})\n`);
    for (const w of withheld) console.log(`  [${w.kind}] ${w.agent} — ${w.why}`);
    console.log('\n  Not dropped silently. A change larger than the cap is not a refinement,');
    console.log('  it is an architecture change — which is one of the seven human gates.\n');
  }

  const file = path.join(root, 'registry', 'hints.yaml');
  const body = [
    '# PROPOSED routing hints — generated, and NOT read by the router.',
    '#',
    '# This file is a suggestion, not configuration. Nothing loads it. To act on a',
    '# proposal, move it into routing.yaml or agents.yaml by hand, then run',
    '# `npm run evaluate` — a proposal that causes a single P->F regression is refused,',
    '# whatever the ledger says about it.',
    '#',
    '# It is a file rather than an automatic edit because "changing the swarm',
    '# architecture itself" is one of the seven gates. Versioned, diffable, revertible,',
    '# and inert until a human moves it.',
    '',
    `generated_from: ${rows.length} agent runs`,
    `evidence_bar: ${MIN_RUNS}`,
    'proposals:',
    ...kept.flatMap((p) => [
      `  - kind: ${p.kind}`,
      `    agent: ${p.agent}`,
      `    evidence: ${p.evidence}`,
      `    proposal: >`,
      `      ${p.proposal}`,
    ]),
    '',
  ].join('\n');

  if (apply) {
    fs.writeFileSync(file, body);
    console.log(`Written to registry/hints.yaml. Nothing loads it — read it, then move`);
    console.log(`what you agree with into the real table and re-run \`npm run evaluate\`.`);
  } else {
    console.log('Dry run. Re-run with --apply to write registry/hints.yaml.');
  }
  return 0;
}
