/**
 * The review-loop driver — the thing that says "not done yet", and why.
 *
 * WHAT WAS MISSING
 *
 * `registry/agents.yaml` declared `review_loop`: three rounds, a panel chosen by
 * quality-sentinel, criteria from requirements-analyst, four halt conditions. `plan`
 * printed it. Every agent was told about it. And nothing enforced it — the coordinator
 * was *expected* to honour the loop, which means the loop ran exactly as well as the
 * coordinator's attention on any given turn.
 *
 * That is the failure mode the loop exists to prevent, reproduced one level up. A
 * declared gate that nobody checks is worse than no gate: it reads as a guarantee in
 * the registry, in the plan output, and in all forty-five agent prompts, while the
 * actual behaviour is "whatever happened".
 *
 * So this module answers one question, deterministically, with no model involved:
 *
 *     given what the agents returned, is this done?
 *
 * and when the answer is no, it says which gate is unmet, what evidence is missing, and
 * who should fix it. It does not dispatch — the coordinator dispatches. It removes the
 * coordinator's ability to *skip* the question.
 *
 * WHY IT REFUSES BY DEFAULT
 *
 * `done` is false until something proves otherwise. An unparseable handoff, a missing
 * field, a reviewer who never reported — all of them mean not-done, not "probably
 * fine". The expensive direction of this error is asymmetric: a false "not done" costs
 * one more round, a false "done" ships the defect. So every ambiguity resolves toward
 * another round, and the round cap is what stops that being infinite.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *
 * It does not judge quality. It cannot tell whether a reviewer was right — only whether
 * the protocol was followed and the declared gates were addressed. Judgement is the
 * panel's job. This is the part that stops a run ending because everyone got tired.
 */

/**
 * The halt conditions this driver actually implements, and the registry wording each
 * one answers.
 *
 * This table is the bridge that makes `review_loop.halt_on` more than prose. `doctor`
 * checks every declared condition against it, so adding a fifth halt condition to the
 * registry without writing the code fails the audit instead of silently becoming
 * another declared-but-unenforced rule -- which is the exact defect this whole module
 * was written to fix. Declaring it and not enforcing it is the failure mode; this is the
 * check that stops the fix from regressing into the bug.
 */
export const HALT_CONDITIONS = [
  { kind: 'accepted', matches: /every reviewer.*accept/i },
  { kind: 'round-cap', matches: /round cap/i },
  { kind: 'human-gate', matches: /human_approval_required|human gate/i },
  { kind: 'no-progress', matches: /same objection|no progress/i },
];

/** Statuses that mean the work itself is not finished, whatever else was returned. */
const UNFINISHED = new Set(['PARTIAL', 'BLOCKED', 'FAILED']);

/**
 * Pull structured fields out of what an agent returned.
 *
 * Tolerant on purpose, in three ways that each cost a real bug elsewhere in this repo:
 * label case varies (`STATUS:` vs `status:`), agents emit the bolded form the prompt
 * showed them (`- **risks** — none`), and a field's value may run to several lines. A
 * strict parser here would report "protocol violation" for a compliant agent, which
 * teaches the coordinator to ignore the driver.
 */
export function parseHandoff(text, { agent = 'unknown' } = {}) {
  const out = { agent, raw: text || '', fields: {}, markers: {} };
  if (!text) return out;

  // Terminal markers first — VOICE/LOG/GATE are anchored at line start by contract.
  for (const m of ['VOICE', 'LOG', 'GATE', 'PENDING', 'HEADS-UP']) {
    const re = new RegExp(`^\\s*${m}:\\s*(.+)$`, 'mi');
    const hit = text.match(re);
    if (hit) out.markers[m.toLowerCase().replace('-', '')] = hit[1].trim();
  }

  const lines = text.split('\n');
  let current = null;
  for (const line of lines) {
    // `- **risks** — none`, `**risks**: none`, `risks: none`, `RISKS: none`
    const bold = line.match(/^\s*[-*]?\s*\*\*([A-Za-z_]+)\*\*\s*[—:-]\s*(.*)$/);
    const plain = line.match(/^\s*[-*]?\s*([A-Za-z_]{3,28}):\s*(.*)$/);
    const hit = bold || plain;
    if (hit) {
      const key = hit[1].toLowerCase();
      // A prose line that happens to contain a colon is not a field. Only accept a key
      // that looks like a field name: no spaces, and not a bare sentence opener.
      if (/^[a-z_]+$/.test(key)) {
        current = key;
        out.fields[key] = hit[2].trim();
        continue;
      }
    }
    if (current && line.trim() && !/^\s*[-*]\s/.test(line)) {
      out.fields[current] = `${out.fields[current]} ${line.trim()}`.trim();
    } else if (!line.trim()) {
      current = null;
    }
  }

  out.status = (out.fields.status || '').toUpperCase().split(/[^A-Z]/).filter(Boolean)[0] || '';
  out.confidence = (out.fields.confidence || '').toUpperCase().split(/[^A-Z]/).filter(Boolean)[0] || '';
  out.verdict = (out.fields.verdict || '').toLowerCase().includes('revise')
    ? 'revise'
    : (out.fields.verdict || '').toLowerCase().includes('accept')
      ? 'accept'
      : '';
  return out;
}

/**
 * Protocol compliance for one handoff. Not quality — presence.
 *
 * `when_applicable` fields are checked for PRESENCE, not for content, because the whole
 * point of "write none rather than omitting" is that presence becomes meaningful. An
 * agent that wrote "risks: none" has made a claim; one that omitted the field has not,
 * and those must not read the same to whoever picks the work up.
 */
export function checkProtocol(h, protocol) {
  const missing = [];
  const required = protocol.required || [];
  const applicable = protocol.when_applicable || [];

  for (const f of required) {
    // voice/log are emitted as terminal markers, not as labelled fields.
    if (f === 'voice' || f === 'log') {
      if (!h.markers[f]) missing.push({ field: f, why: `no ${f.toUpperCase()}: line` });
      continue;
    }
    if (!h.fields[f] || !h.fields[f].trim()) missing.push({ field: f, why: 'required, absent' });
  }
  for (const f of applicable) {
    if (h.fields[f] === undefined) {
      missing.push({ field: f, why: 'omitted — "none" is a claim, silence is not' });
    }
  }
  return missing;
}

/**
 * Normalise an objection so "the same objection twice" can actually be detected.
 *
 * Without this the halt condition is unenforceable: a reviewer restating the same
 * objection in different words looks like progress, and the loop burns its whole cap
 * discovering it is stuck. Aggressive on purpose — punctuation, case, filler and
 * whitespace all go, because the question is whether the SUBSTANCE repeated.
 */
export function objectionKey(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\b(the|a|an|is|are|was|were|be|been|to|of|in|on|at|it|its|this|that|these|those|and|but|so|or|if|as|has|have|had|will|does|do|did|should|would|could|must|still|also|now|again|yet|just|very|really)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Are two objections the same objection?
 *
 * NOT string equality, and that distinction is the whole halt condition. The first
 * version compared normalised strings and a reviewer who reworded — "the child table has
 * no parent link" then "the child table STILL has no parent link, so rows WILL orphan" —
 * read as a brand new objection. The loop would then spend its entire cap discovering it
 * was stuck, which is precisely the waste this condition exists to stop.
 *
 * So: overlap of content words, both directions. Jaccard rather than "contains", because
 * a reviewer who ADDS detail to the same objection has still not been answered, and one
 * who drops words has not either. 0.7 was picked by trying it against reworded pairs; it
 * catches restatement without collapsing two genuinely different objections about the
 * same subsystem, which share nouns but little else.
 */
export const SAME_OBJECTION = 0.7;

export function sameObjection(a, b, threshold = SAME_OBJECTION) {
  const A = new Set(String(a || '').split(' ').filter(Boolean));
  const B = new Set(String(b || '').split(' ').filter(Boolean));
  if (!A.size || !B.size) return false;
  let shared = 0;
  for (const t of A) if (B.has(t)) shared++;
  return shared / (A.size + B.size - shared) >= threshold;
}

/**
 * The verdict. `done` is false unless every check passes.
 *
 * `history` carries objection keys from previous rounds, so no-progress is detectable
 * across rounds rather than only within one.
 */
export function verdict({
  handoffs = [],
  round = 1,
  reviewLoop = {},
  protocol = {},
  gates = [],
  history = [],
} = {}) {
  const rounds = Number(reviewLoop.rounds) || 3;
  const blocking = [];
  const halt = [];

  if (!handoffs.length) {
    return {
      done: false,
      round,
      halt: [],
      blocking: [{ kind: 'no-handoffs', detail: 'nothing was returned, so nothing can be judged done' }],
      next: null,
      reason: 'No handoffs collected. A round with no output is not a round that passed.',
      objections: [],
    };
  }

  // 1. A crossed human gate halts everything, immediately and before any other
  //    consideration. It outranks the round cap and it outranks unanimous acceptance:
  //    a run that stopped for authorisation is not a run that finished.
  for (const h of handoffs) {
    if (h.markers.gate) {
      halt.push({ kind: 'human-gate', gate: h.markers.gate, agent: h.agent });
    }
    // Also catch an agent that named a gate in `handoff` without emitting the marker.
    const named = gates.find((g) => (h.fields.handoff || '').toLowerCase().includes(g.toLowerCase()));
    if (named && !h.markers.gate) {
      halt.push({ kind: 'human-gate', gate: named, agent: h.agent, note: 'named in handoff, no GATE: marker' });
    }
  }

  // 2. Protocol compliance. An unparseable or incomplete handoff cannot be judged, so
  //    it is not-done rather than assumed-fine.
  for (const h of handoffs) {
    const missing = checkProtocol(h, protocol);
    if (missing.length) {
      blocking.push({
        kind: 'protocol',
        agent: h.agent,
        detail: `${missing.length} field${missing.length === 1 ? '' : 's'} missing: ${missing.map((m) => m.field).join(', ')}`,
        missing,
      });
    }
  }

  // 3. The work itself. PARTIAL/BLOCKED/FAILED is not done, regardless of what the
  //    reviewers said — a panel can accept an approach and the work still be unbuilt.
  for (const h of handoffs) {
    if (UNFINISHED.has(h.status)) {
      blocking.push({
        kind: 'status',
        agent: h.agent,
        detail: `status ${h.status}${h.fields.remaining ? ` — remaining: ${h.fields.remaining}` : ''}`,
      });
    }
    if (!h.status) {
      blocking.push({ kind: 'status', agent: h.agent, detail: 'no STATUS returned' });
    }
  }

  // 4. Unverified work. SUCCESS + a non-empty `unverified` is the combination the
  //    protocol calls the most expensive thing an agent can write, so the driver treats
  //    it as an open item rather than reading the status and stopping.
  for (const h of handoffs) {
    const u = (h.fields.unverified || '').trim().toLowerCase();
    if (h.status === 'SUCCESS' && u && u !== 'none' && u !== 'nothing') {
      blocking.push({
        kind: 'unverified',
        agent: h.agent,
        detail: `claims SUCCESS with unverified: ${h.fields.unverified}`,
      });
    }
    if (h.confidence === 'LOW') {
      blocking.push({ kind: 'confidence', agent: h.agent, detail: 'LOW confidence — wants a second pair of eyes' });
    }
  }

  // 5. Reviewer verdicts. A reviewer that returned neither accept nor revise has not
  //    reviewed, which is a missing review and not a tacit accept.
  const reviewers = handoffs.filter((h) => h.fields.verdict !== undefined);
  const objections = [];
  for (const h of reviewers) {
    if (h.verdict === 'revise') {
      const remedy = h.fields.verdict.replace(/^revise[\s:—-]*/i, '').trim();
      if (reviewLoop.objection_must_state_remedy && !remedy) {
        blocking.push({
          kind: 'objection-without-remedy',
          agent: h.agent,
          detail: 'returned revise but named no remedy — an objection nobody can act on is an opinion',
        });
      }
      objections.push({ agent: h.agent, text: remedy || h.fields.verdict, key: objectionKey(remedy || h.fields.verdict) });
      blocking.push({ kind: 'revise', agent: h.agent, detail: remedy || 'revise, no detail' });
    } else if (h.verdict !== 'accept') {
      blocking.push({ kind: 'no-verdict', agent: h.agent, detail: 'is on the panel but returned no verdict' });
    }
  }

  // 6. No progress. The condition that matters most, because the other three end the
  //    loop cleanly and this one is the loop failing to converge.
  for (const o of objections) {
    if (o.key && history.some((prev) => sameObjection(o.key, prev))) {
      halt.push({
        kind: 'no-progress',
        agent: o.agent,
        objection: o.text,
        note: 'returned twice — spending another round on it is worse than handing it back',
      });
    }
  }

  // 7. The cap. Checked last so a run that would have halted for a better reason
  //    reports that reason instead.
  if (round >= rounds && blocking.length) {
    halt.push({ kind: 'round-cap', rounds, note: `round ${round} of ${rounds} with ${blocking.length} item(s) open` });
  }

  const accepted = reviewers.length > 0 && reviewers.every((h) => h.verdict === 'accept');
  const clean = blocking.length === 0;
  const done = clean && (accepted || reviewers.length === 0) && halt.every((h) => h.kind !== 'human-gate');

  // Who should pick it up. The registry says revisions go to the original author, so a
  // revise names the author rather than a fresh agent -- the author holds the context.
  let next = null;
  if (!done) {
    const revise = blocking.find((b) => b.kind === 'revise');
    const proto = blocking.find((b) => b.kind === 'protocol');
    const work = blocking.find((b) => b.kind === 'status' || b.kind === 'unverified');
    const source = revise || work || proto;
    if (source) {
      const author = handoffs.find((h) => h.agent === source.agent);
      next = reviewLoop.revision_goes_to === 'original-author' && revise
        ? handoffs.find((h) => h.fields.verdict === undefined)?.agent || source.agent
        : author?.fields?.recommended_next_agent || source.agent;
    }
  }

  const reason = done
    ? `Round ${round}: every gate met${reviewers.length ? `, ${reviewers.length} reviewer(s) accepted` : ', no panel was convened'}.`
    : halt.length
      ? `Round ${round}: HALTED — ${halt.map((h) => h.kind).join(', ')}. ${blocking.length} item(s) still open, handed back rather than resolved.`
      : `Round ${round} of ${rounds}: NOT DONE — ${blocking.length} item(s) open. Another round is owed.`;

  return {
    done,
    round,
    rounds,
    halt,
    blocking,
    objections,
    next,
    reason,
    history: [...history, ...objections.map((o) => o.key)].filter(Boolean),
  };
}

export function render(v) {
  console.log(v.done ? 'LOOP: DONE' : 'LOOP: NOT DONE');
  console.log(`  ${v.reason}\n`);

  if (v.blocking?.length) {
    console.log(`OPEN (${v.blocking.length}) — each of these is a reason this is not finished\n`);
    for (const b of v.blocking) {
      console.log(`  [${b.kind}] ${b.agent || ''}`);
      console.log(`      ${b.detail}`);
    }
    console.log('');
  }
  if (v.halt?.length) {
    console.log(`HALT (${v.halt.length}) — stop looping, for these reasons\n`);
    for (const h of v.halt) {
      console.log(`  [${h.kind}] ${h.gate || h.objection || h.note || ''}`);
      if (h.note && (h.gate || h.objection)) console.log(`      ${h.note}`);
    }
    console.log('');
  }
  if (!v.done && v.next) {
    console.log(`NEXT: ${v.next}`);
    console.log('  Send the objection verbatim. A paraphrase loses the thing that was objected to.\n');
  }
  if (v.done) {
    console.log('This is the only thing that authorises "done". Nothing else does — not a');
    console.log('plausible-looking diff, and not the coordinator running out of patience.\n');
  } else if (!v.halt?.length) {
    console.log(`Owed: round ${v.round + 1} of ${v.rounds}. Re-run with the new handoffs, and pass`);
    console.log('  --history to carry the objection keys — without it, no-progress cannot be seen.\n');
  }
  return v.done ? 0 : 1;
}
