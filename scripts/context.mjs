/**
 * Session context — a handoff document per session, written as the session runs.
 *
 * This is the READ side and the RENDER side. The write side is voice/jarvis.sh,
 * which appends one JSON line per event from inside a hook, in pure bash, with no
 * process spawn at all. That split is the whole design:
 *
 *   hook (bash, hot)  ──►  <session>.jsonl   append-only, one printf, never rewritten
 *   context.mjs (cold) ──►  <session>.md     rendered projection, temp + rename
 *
 * The journal is the truth and the markdown is a view of it. A session killed at any
 * instant loses nothing: the journal is complete up to the last completed event, and
 * the markdown is either the previous valid render or the next one — `rename` gives
 * no third option. Re-rendering a stale file costs single-digit milliseconds, so the
 * markdown is refreshed at every compaction, at session end, and by the sweep that
 * runs at the next SessionStart. Nothing is ever "assembled at the end".
 *
 * NOTHING HERE SPAWNS A PROCESS OR NAMES AN OS TOOL. `voice/platform.sh` holds that
 * privilege exclusively and `tests/voice-audio.sh` check P2 fails the build on a leak.
 * The optional model call lives in platform.sh as `jv_llm_summarize` for exactly that
 * reason, and reaches this file only as another journal line.
 *
 * Zero dependencies, like the rest of the repo.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ---------------------------------------------------------------- settings --

const HOME = os.homedir();
const num = (v, d) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : d;
};

export const CFG = {
  // Where the documents live. Not in a git repo, deliberately: these are
  // machine-local, they carry absolute paths and session ids, they churn on every
  // turn, and the secret filter below is a mitigation rather than a guarantee.
  dir:
    process.env.JARVIS_CTX_DIR ||
    path.join(HOME, 'frappe-bench', 'Referencedocs', 'CLI-Session-Context'),
  state: process.env.JARVIS_CTX_STATE || path.join(HOME, '.claude', 'jarvis', 'state', 'ctx'),
  // A document over this has stopped being a handoff and become an archive.
  maxLines: num(process.env.JARVIS_CTX_MAX_LINES, 400),
  // Fewer meaningful events than this and the session gets no file at all.
  // Silence is the correct record for a session where nothing happened.
  minTurns: num(process.env.JARVIS_CTX_MIN_TURNS, 2),
  // How many sessions the SessionStart pointer may mention. It is a pointer, not
  // content: three lines that cost nothing, never the files themselves.
  pointerMax: num(process.env.JARVIS_CTX_POINTER_MAX, 3),
  // How far back the SessionStart pointer looks. Bounded so the cost of opening a
  // session does not grow with the size of the archive.
  pointerMonths: num(process.env.JARVIS_CTX_POINTER_MONTHS, 3),
};

// ------------------------------------------------------------ secret filter --

/**
 * Anything that looks like a credential never reaches disk.
 *
 * Ordered most-specific first: a bare `sk-ant-…` is unambiguous, `token = …` needs
 * the assignment to avoid eating the word "token" out of ordinary prose. The last
 * two rules are shape-based and will occasionally redact an innocent hash — that is
 * the correct trade. A false positive costs a line of a log; a false negative writes
 * a live credential into a file that gets re-injected into a future conversation.
 *
 * This exists because it already happened here: a PAT was committed in a
 * System-Console script on this machine. See memory `cs-command-center-dashboard`.
 */
const SECRET_PATTERNS = [
  /sk-ant-[A-Za-z0-9_-]{16,}/g, // Anthropic
  /sk-[A-Za-z0-9]{32,}/g, // OpenAI-shaped
  /gh[pousr]_[A-Za-z0-9]{20,}/g, // GitHub PAT
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /xox[baprs]-[A-Za-z0-9-]{10,}/g, // Slack
  /AKIA[0-9A-Z]{16}/g, // AWS access key id
  /ASIA[0-9A-Z]{16}/g,
  /AIza[0-9A-Za-z_-]{30,}/g, // Google
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWT
  /-----BEGIN[A-Z ]*PRIVATE KEY-----/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/gi,
  // key = value, in any of the shapes a config file or a shell export uses.
  // The key name may carry a PREFIX -- DB_PASSWORD, MY_API_KEY, STRIPE_SECRET_KEY --
  // and an anchoring \b before the name never matches one, because the underscore is
  // itself a word character. That silently let through the single most common shape
  // there is: the assignment line in a .env file or a shell export.
  /(?:^|[^A-Za-z0-9])[A-Za-z0-9]*[_-]?(?:api[_-]?key|apikey|secret|access[_-]?token|auth[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|passphrase|private[_-]?key|encryption[_-]?key)[A-Za-z0-9_-]*\s*[:=]\s*["']?[^\s"',;]{4,}/gi,
  // Long unbroken hex or base64. Deliberately last, and deliberately blunt.
  /\b[A-Fa-f0-9]{40,}\b/g,
  /\b[A-Za-z0-9+/]{48,}={0,2}\b/g,
];

/** Paths whose CONTENT must never be recorded. The path itself still is. */
const SECRET_PATHS =
  /(^|[/\\])(\.env(\.[^/\\]*)?|.*\.pem|.*\.key|.*\.p12|.*\.pfx|id_rsa.*|id_ed25519.*|.*credentials.*|.*secrets?\.(json|ya?ml|toml|ini|sh))$/i;

export function redact(s) {
  if (s == null) return '';
  let out = String(s);
  for (const re of SECRET_PATTERNS) {
    // The assignment rule has to consume one character to its left to prove the key
    // name is not the tail of a longer word. Putting it back is not cosmetic: without
    // it, "run FOO_TOKEN=x now" loses the space and reads as "run[REDACTED] now".
    out = out.replace(re, (m) => {
      const lead = /^[^A-Za-z0-9]/.test(m) && !m.startsWith('-----') ? m[0] : '';
      return lead + '[REDACTED]';
    });
  }
  return out;
}

/**
 * Cap without cutting a word in half.
 *
 * `.slice(n)` cuts blind -- "...doesn't exist in the load" -- which reads as a
 * transcription error rather than as a truncation, and in a DECISION line the tail is
 * usually the "why", which is the whole reason the line is worth keeping. Back off to
 * the last space and mark the cut. voice/jarvis.sh `clip()` does the same thing for
 * the spoken path, for the same reason.
 */
export function clip(text, max) {
  const s = String(text || '');
  if (s.length <= max) return s;
  let cut = s.slice(0, max);
  const sp = cut.lastIndexOf(' ');
  if (sp > max * 0.6) cut = cut.slice(0, sp);
  return cut.replace(/[\s,;:.-]+$/, '') + '…';
}

export function isSecretPath(p) {
  return SECRET_PATHS.test(String(p || ''));
}

// ------------------------------------------------------------------ naming --

/**
 * The slug is derived from the FIRST PROMPT, not from the transcript's `ai-title`.
 *
 * The title is written asynchronously and does not exist for the first several
 * turns, so naming from it would mean creating the file under a placeholder and
 * renaming it later — and a rename races every append that is already in flight.
 * The first prompt is available in the UserPromptSubmit payload, at the exact moment
 * the file is created, and never changes afterwards. The title is still recorded, as
 * `name:` in the front matter, where being late costs nothing.
 */
const STOPWORDS = new Set(
  ('a an the and or but of for to in on at by with from into is are was were be been ' +
    'this that these those it its i we you my our your can could should would will ' +
    'please lets let me help need want make made do does did get got use using how ' +
    'what why when where which who all any some more most very just also then than')
    .split(' ')
);

export function slugify(text, maxWords = 5, maxLen = 44) {
  const words = String(text || '')
    .replace(/```[\s\S]*?```/g, ' ') // fenced code says nothing about the topic
    .replace(/[^A-Za-z0-9\s-]/g, ' ')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .filter((w) => w.length > 1 && !STOPWORDS.has(w));
  const picked = (words.length ? words : ['untitled']).slice(0, maxWords);
  let s = picked.join('-').slice(0, maxLen);
  s = s.replace(/-+$/, '').replace(/^-+/, '');
  return s || 'untitled';
}

export function projectSlug(cwd) {
  const base = path.basename(String(cwd || '').replace(/[/\\]+$/, '')) || 'session';
  return (
    base
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'session'
  );
}

/**
 * `<YYYY-MM-DD>--<project>--<name>--<short-id>.md`, in `sessions/<YYYY-MM>/`.
 *
 * The short id is the FIRST eight characters of the session id, which is also the
 * prefix of the raw transcript filename under `~/.claude/projects/`. That is not
 * decoration: it is how you get from a document back to the conversation it came
 * from, and it makes the name unique without a counter.
 */
export function fileName({ date, project, name, sid }) {
  return `${date}--${project}--${name}--${String(sid || '').slice(0, 8) || 'nosid'}.md`;
}

export function monthDir(date) {
  return String(date).slice(0, 7); // YYYY-MM
}

export function docPath(meta) {
  return path.join(CFG.dir, 'sessions', monthDir(meta.date), fileName(meta));
}

export function journalPath(meta) {
  return path.join(
    CFG.dir,
    'sessions',
    monthDir(meta.date),
    '.journal',
    fileName(meta).replace(/\.md$/, '.jsonl')
  );
}

// ------------------------------------------------------------------- state --

/** The sidecar that maps a live session KEY to its document. Small, rewritten whole. */
function statePath(key) {
  return path.join(CFG.state, `${key}.json`);
}

export function readState(key) {
  try {
    return JSON.parse(fs.readFileSync(statePath(key), 'utf8'));
  } catch {
    return null;
  }
}

export function writeState(key, st) {
  fs.mkdirSync(CFG.state, { recursive: true });
  writeAtomic(statePath(key), JSON.stringify(st, null, 2) + '\n');
}

// ------------------------------------------------------------------- write --

/**
 * Temp + rename, the only safe way to replace a file that something else may be
 * reading. The temp carries the pid so two writers cannot collide on it, and it is
 * created in the SAME directory because rename is only atomic within a filesystem.
 */
export function writeAtomic(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

/** Read a journal, skipping any line a crash left half-written. */
export function readJournal(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // A process killed mid-append leaves a partial final line. Dropping it is
      // correct and is exactly why the journal is line-delimited rather than one
      // JSON document: a truncated array is unreadable, a truncated line is one
      // lost event.
    }
  }
  return out;
}

/** Append one event. Used by the CLI; the hot path does this from bash instead. */
export function appendJournal(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(obj) + '\n');
}

// ------------------------------------------------------------ transcript IO --

/**
 * Everything worth keeping out of the slice of transcript that is about to be
 * discarded — extracted deterministically, with no model call.
 *
 * PreCompact's payload does NOT carry the conversation. It carries `transcript_path`,
 * a pointer to the JSONL. So the snapshot is built by reading the window between the
 * previous watermark and the current end of file, which also means repeated
 * compactions inside one session capture disjoint windows rather than re-capturing
 * everything, and cost is proportional to new content rather than to a file that can
 * reach twenty megabytes.
 */
export function extractWindow(transcript, fromOffset = 0, maxBytes = 8 * 1024 * 1024, withProse = false) {
  const res = {
    ok: false,
    from: fromOffset,
    to: fromOffset,
    truncated: false,
    turns: 0,
    replies: 0,
    chars: 0,
    files: [],
    commands: [],
    markers: [],
    prompts: [],
    title: null,
    branch: null,
    cwd: null,
    prose: [],
  };

  let fd, size;
  try {
    fd = fs.openSync(transcript, 'r');
    size = fs.fstatSync(fd).size;
  } catch {
    return res;
  }

  try {
    let start = Math.max(0, Math.min(fromOffset, size));
    let len = size - start;
    if (len > maxBytes) {
      // Read the TAIL of an oversized window, not the head: the most recent turns
      // are the ones a future session needs, and a head-truncated window would
      // report the beginning of a long stretch of work and drop its conclusion.
      start = size - maxBytes;
      len = maxBytes;
      res.truncated = true;
    }
    if (len <= 0) {
      res.ok = true;
      res.to = size;
      return res;
    }
    const buf = Buffer.allocUnsafe(len);
    fs.readSync(fd, buf, 0, len, start);
    res.to = size;
    res.chars = len;

    const text = buf.toString('utf8');
    const lines = text.split('\n');
    // Drop a leading PARTIAL record -- but only when there actually is one.
    //
    // A watermark left by a previous snapshot is the file size at that moment, which
    // is always a line boundary, so the first line after it is complete and dropping
    // it silently loses a whole turn. The size-cap path is different: it seeks to an
    // arbitrary byte and almost always lands mid-record.
    //
    // The one byte before the start says which case this is, exactly, rather than
    // inferring it from `start > 0` -- which was wrong for every repeat compaction.
    if (start > 0) {
      const prev = Buffer.allocUnsafe(1);
      let boundary = false;
      try {
        fs.readSync(fd, prev, 0, 1, start - 1);
        boundary = prev[0] === 0x0a;
      } catch {
        boundary = false;
      }
      if (!boundary) lines.shift();
    }

    const files = new Map();
    const cmds = new Set();
    for (const line of lines) {
      if (!line.trim()) continue;
      let o;
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      if (o.gitBranch && o.gitBranch !== 'HEAD') res.branch = o.gitBranch;
      if (o.cwd) res.cwd = o.cwd;
      if (o.type === 'ai-title' && o.aiTitle) res.title = o.aiTitle;

      if (o.type === 'user' && o.promptSource && !o.isMeta) {
        res.turns++;
        const c = o.message?.content;
        const t =
          typeof c === 'string'
            ? c
            : (c || [])
                .filter((b) => b.type === 'text')
                .map((b) => b.text)
                .join(' ');
        if (t) res.prompts.push(clip(redact(t).replace(/\s+/g, ' ').trim(), 240));
      }

      if (o.type !== 'assistant') continue;
      res.replies++;
      for (const b of o.message?.content || []) {
        if (b.type === 'text' && b.text) {
          for (const m of harvestMarkers(b.text)) res.markers.push(m);
          // Assistant prose is where reasoning lives, and it is the ONLY part of a
          // transcript a model is needed for. Collected opt-in, because it is the
          // one field here big enough to matter.
          if (withProse) res.prose.push(redact(b.text).replace(/\s+/g, ' ').trim().slice(0, 1500));
        }
        if (b.type !== 'tool_use') continue;
        const p = b.input?.file_path || b.input?.notebook_path;
        if (p && /^(Edit|Write|NotebookEdit|MultiEdit)$/.test(b.name)) {
          // The path is recorded; the content never is, and is never even read.
          const prev = files.get(p) || { path: p, ops: new Set() };
          prev.ops.add(b.name);
          files.set(p, prev);
        }
        if (b.name === 'Bash' && b.input?.description) {
          cmds.add(clip(redact(String(b.input.description)), 100));
        }
      }
    }

    res.files = [...files.values()].map((f) => ({
      path: f.path,
      ops: [...f.ops].join('+'),
      secret: isSecretPath(f.path),
    }));
    res.commands = [...cmds];
    res.ok = true;
    return res;
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      /* the descriptor is going away with the process anyway */
    }
  }
}

/**
 * Pull DECISION / GOTCHA / PENDING / HEADS-UP out of an assistant message.
 *
 * Same terminal-marker rule that `voice/jarvis.sh marker_note` enforces, and for the
 * same reason: a line anchor alone harvests prose ABOUT the contract. Explaining the
 * format in a reply once put a mangled half-sentence into a live briefing.
 * Documentation must not be mistaken for data.
 */
const MARKER_RE = /^(DECISION|GOTCHA|PENDING|HEADS-UP|VOICE):\s*(.+)$/;

export function harvestMarkers(text) {
  const lines = String(text || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const out = [];
  let i = lines.length - 1;
  while (i >= 0) {
    const m = lines[i].match(MARKER_RE);
    if (!m) break;
    if (m[1] !== 'VOICE') out.unshift({ kind: m[1].toLowerCase(), text: clip(redact(m[2]), 200) });
    i--;
  }
  return out;
}

// ------------------------------------------------------------------ render --

const SECTIONS = ['objective', 'decision', 'file', 'gotcha', 'snapshot', 'thread'];

function fmtTime(epoch) {
  const d = new Date(epoch * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

function fmtStamp(epoch) {
  const d = new Date(epoch * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Exact-match dedup, same rule as `remember()` in voice/jarvis.sh. */
function dedup(items, keyOf = (x) => x) {
  const seen = new Set();
  const out = [];
  for (const it of items) {
    const k = keyOf(it);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(it);
  }
  return out;
}

/**
 * Fold the journal into the shape a future session should read.
 *
 * Order is deliberate and is the brief's, not a default: Objective, then Decisions
 * (the highest-value section — a decision without its why gets re-litigated in three
 * weeks), then the mechanical sections, then Open threads LAST, because that is the
 * part that gets acted on and the eye lands on the end of a document.
 */
export function fold(journal) {
  const s = {
    meta: {},
    objective: '',
    decisions: [],
    files: [],
    gotchas: [],
    snapshots: [],
    threads: [],
    turns: [],
    status: 'active',
    problems: 0,
  };
  for (const e of journal) {
    switch (e.k) {
      case 'meta':
        // Later meta events ADD to the earlier one. A plain Object.assign would let
        // the empty `title` written at open time overwrite the real one learned at
        // the first compaction, depending only on ordering.
        for (const [k, v] of Object.entries(e)) if (v !== '' && v != null) s.meta[k] = v;
        break;
      case 'objective':
        if (e.v) s.objective = e.v;
        break;
      case 'decision':
        s.decisions.push({ t: e.t, v: e.v });
        break;
      case 'gotcha':
        s.gotchas.push({ t: e.t, v: e.v });
        break;
      case 'thread':
        s.threads.push({ t: e.t, v: e.v });
        break;
      case 'file':
        s.files.push({ t: e.t, v: e.v, why: e.why || '' });
        break;
      case 'turn':
        s.turns.push({ t: e.t, v: e.v, el: e.el || 0, subs: e.subs || 0, p: e.p || 0 });
        if (e.p) s.problems++;
        break;
      case 'snapshot':
        s.snapshots.push(e);
        break;
      case 'survived': {
        const snap = s.snapshots.find((x) => x.n === e.n);
        if (snap) snap.survived = e.v;
        break;
      }
      case 'skipped': {
        // A cap that bit. Recorded rather than silent: a snapshot with no reasoning
        // and no explanation reads as "there was nothing to say", which is a
        // different and much worse claim than "we chose not to ask".
        const snap = s.snapshots.find((x) => x.n === e.n);
        if (snap) snap.skipped = e.why || 'skipped';
        break;
      }
      case 'reasoned': {
        const snap = s.snapshots.find((x) => x.n === e.n);
        if (snap) snap.reasonedCount = e.v;
        break;
      }
      case 'status':
        s.status = e.v;
        break;
      default:
        break;
    }
  }
  s.decisions = dedup(s.decisions, (d) => d.v);
  s.gotchas = dedup(s.gotchas, (g) => g.v);
  s.threads = dedup(s.threads, (t) => t.v);
  s.files = dedup(s.files, (f) => f.v);
  return s;
}

/** True when a session earned a file at all. */
export function isMeaningful(s) {
  const substance =
    s.decisions.length + s.gotchas.length + s.threads.length + s.files.length + s.snapshots.length;
  const realTurns = s.turns.filter((t) => t.v && t.v !== '_(nothing reported)_').length;
  return substance > 0 || realTurns >= CFG.minTurns;
}

export function render(s, meta) {
  const L = [];
  const started = s.meta.t || meta.started || 0;
  const updated = Math.max(started, ...s.turns.map((t) => t.t), ...s.snapshots.map((x) => x.t), 0);

  L.push('---');
  L.push(`session_id: ${s.meta.sid || meta.sid || ''}`);
  L.push(`name: ${(s.meta.title || meta.name || '').replace(/[:\n]/g, ' ')}`);
  L.push(`project: ${s.meta.cwd || meta.cwd || ''}`);
  L.push(`branch: ${s.meta.branch || meta.branch || '(not a git repo)'}`);
  L.push(`started: ${fmtStamp(started)}`);
  L.push(`updated: ${fmtStamp(updated || started)}`);
  L.push(`status: ${s.status}`);
  L.push(`open_threads: ${s.threads.length}`);
  L.push(`compactions: ${s.snapshots.length}`);
  L.push('---');
  L.push('');
  // The H1 prefers the session title, then the objective, then the slug: the slug
  // is a FILENAME and reads like one.
  L.push(`# ${s.meta.title || s.objective.slice(0, 80) || meta.slug || 'session'}`);
  L.push('');

  L.push('## Objective');
  L.push('');
  L.push(s.objective || '_(no prompt recorded)_');
  L.push('');

  L.push('## Decisions');
  L.push('');
  if (!s.decisions.length) {
    L.push('_None recorded. Emit a terminal `DECISION: <what> — <why, and what was rejected>`_');
    L.push('_line to capture one._');
  } else {
    for (const d of s.decisions) L.push(`- **${fmtTime(d.t)}** · ${d.v}`);
  }
  L.push('');

  L.push('## Files touched');
  L.push('');
  if (!s.files.length) L.push('_None._');
  else for (const f of s.files) L.push(`- \`${f.v}\`${f.why ? ` — ${f.why}` : ''}`);
  L.push('');

  L.push('## Gotchas');
  L.push('');
  if (!s.gotchas.length) L.push('_None recorded._');
  else for (const g of s.gotchas) L.push(`- ${g.v}`);
  L.push('');

  L.push('## Compaction snapshots');
  L.push('');
  if (!s.snapshots.length) {
    L.push('_No compaction occurred._');
    L.push('');
  } else {
    for (const snap of s.snapshots) L.push(...renderSnapshot(snap));
  }

  // Turn log, compressed when the document has outgrown its purpose.
  const turnLines = s.turns
    .filter((t) => t.v && t.v !== '_(nothing reported)_')
    .map(
      (t) =>
        `- **${fmtTime(t.t)}** · ${t.el >= 60 ? `${Math.round(t.el / 60)}m` : `${t.el}s`}${
          t.subs >= 2 ? ` · ${t.subs} specialists` : ''
        } · ${t.p ? '**PROBLEM** ' : ''}${t.v}`
    );

  // Open threads LAST. It is the only part that can still be acted on.
  const tail = [];
  tail.push('## Open threads');
  tail.push('');
  if (!s.threads.length) {
    tail.push(s.status === 'closed' ? '_Nothing outstanding._' : '_Nothing recorded yet._');
  } else {
    for (const t of s.threads) tail.push(`- [ ] ${t.v}`);
  }
  tail.push('');

  // The cap applies to the turn log, because it is the only section that grows
  // without bound and the least valuable per line. Decisions, gotchas, threads and
  // snapshots are never dropped — they are the reason the file is worth its tokens.
  const fixed = L.length + tail.length + 4;
  let kept = turnLines;
  let dropped = 0;
  if (fixed + turnLines.length > CFG.maxLines) {
    const room = Math.max(10, CFG.maxLines - fixed);
    dropped = turnLines.length - room;
    kept = turnLines.slice(-room); // the recent end is the useful end
  }
  L.push('## Turn log');
  L.push('');
  if (dropped > 0) L.push(`_${dropped} earlier turns compressed away; decisions and gotchas above are complete._`);
  if (!kept.length && !dropped) L.push('_No turns recorded._');
  L.push(...kept);
  L.push('');
  L.push(...tail);

  return L.join('\n').replace(/\n{3,}/g, '\n\n') + '\n';
}

function renderSnapshot(snap) {
  const L = [];
  const dropKb = Math.round((snap.chars || 0) / 1024);
  const approxTok = Math.round((snap.chars || 0) / 4 / 1000);
  L.push(`### ${snap.n} · ${fmtTime(snap.t)} · ${snap.trigger || 'auto'} compaction`);
  L.push('');
  L.push(
    `Discarded ~${dropKb} KB (~${approxTok}k tokens) covering ${snap.turns || 0} prompt(s) and ${
      snap.replies || 0
    } repl${snap.replies === 1 ? 'y' : 'ies'}.` + (snap.truncated ? ' **Window was capped — older content in this window was not read.**' : '')
  );
  L.push('');
  if (snap.prompt) {
    L.push(`_Last prompt before compaction:_ ${snap.prompt}`);
    L.push('');
  }
  if (snap.files?.length) {
    // The paths themselves are promoted into "Files touched", tagged with this
    // snapshot number, where they are deduplicated against the rest of the session.
    // Listing them again here is the same gotcha recorded twice -- the exact thing
    // the brief asks this file not to do -- and it is the section most likely to be
    // long. The count is what the snapshot needs to carry.
    const secret = snap.files.filter((f) => f.secret).length;
    L.push(
      `${snap.files.length} file(s) edited in this window — listed under **Files touched** as \`(compaction ${snap.n})\`.` +
        (secret ? ` ${secret} of them are credential-bearing paths whose content was never read.` : '')
    );
    L.push('');
  }
  if (snap.cmds?.length) {
    L.push('Commands run:');
    for (const c of snap.cmds.slice(0, 12)) L.push(`- ${c}`);
    if (snap.cmds.length > 12) L.push(`- _…and ${snap.cmds.length - 12} more_`);
    L.push('');
  }
  if (snap.reasonedCount) {
    // The recovered lines themselves are promoted into Decisions and Gotchas above,
    // where they are deduplicated against everything else and where a reader looking
    // for a decision will actually find them. Repeating them here would be the same
    // gotcha recorded twice.
    L.push(
      `_${snap.reasonedCount} decision/gotcha line(s) recovered from this window — see the sections above._`
    );
    L.push('');
  } else if (snap.skipped) {
    L.push(`_No model summary: ${snap.skipped}._`);
    L.push('');
  }
  if (snap.survived) {
    L.push(`**Survived compaction:** ${snap.survived}`);
    L.push('');
  }
  return L;
}

/**
 * The folder's own map, written once and never overwritten.
 *
 * A directory of a hundred timestamped files is not navigable because the naming is
 * consistent; it is navigable because the rule is written down where someone opening
 * the folder will see it. This is that file.
 */
const FOLDER_README = `# CLI Session Context

One handoff document per Claude Code session, written **as the session runs** by the
JARVIS hooks. Not an archive — the question each file answers is *"what would a future
session need to know to be immediately useful?"*

Nothing here is in git, deliberately. These are machine-local records that carry
absolute paths and session ids, they change on every turn, and the secret filter is a
mitigation rather than a guarantee.

## Layout

\`\`\`
CLI-Session-Context/
├── README.md          this file — the naming and structure rules
├── INDEX.md           one row per session: date, project, branch, objective, open count
└── sessions/
    └── <YYYY-MM>/                    one folder per month
        ├── <YYYY-MM-DD>--<project>--<name>--<short-id>.md
        └── .journal/
            └── <same name>.jsonl     append-only source of the .md above
\`\`\`

**Read \`INDEX.md\` first.** It exists so that individual documents are opened on
purpose rather than by browsing. A document is worth its tokens only when the index row
says it is.

## The filename

\`\`\`
2026-08-19--frappe-bench--durable-session-context--6655d427.md
└────┬───┘  └─────┬────┘  └──────────┬──────────┘  └───┬──┘
  start date    project          what it was about   short id
\`\`\`

| Part | Where it comes from |
|---|---|
| \`YYYY-MM-DD\` | the session's start time, local |
| \`project\` | the basename of the session's working directory, slugified |
| \`name\` | up to five meaningful words of the **first prompt** |
| \`short-id\` | the first 8 characters of the session id |

The short id is not decoration. It is also the prefix of the raw transcript under
\`~/.claude/projects/<project>/\`, so it is how you get from a document back to the
conversation that produced it.

The name comes from the first prompt rather than from the session title because the
title is written asynchronously and does not exist for the first several turns. Naming
from it would mean creating the file under a placeholder and renaming it later, and a
rename races every append already in flight. The title is still recorded, in the front
matter as \`name:\`, where being late costs nothing.

## Inside a document

Sections are in a fixed order, and the order is the point:

1. **Front matter** — session id, name, project, branch, start, last updated, status,
   open-thread count, compaction count.
2. **Objective** — what the session was for, from the first prompt.
3. **Decisions** — *the highest-value section.* Each with its reasoning and what was
   rejected. A decision without its why gets re-litigated in three weeks.
4. **Files touched** — path plus what changed.
5. **Gotchas** — what was surprising about this codebase. These are what make an old
   document worth reading.
6. **Compaction snapshots** — what was discarded at each compaction, and what survived.
7. **Turn log** — compressed from the old end once the file passes its line cap.
8. **Open threads** — **last, because it is the part you act on.**

\`status\` is one of \`active\`, \`closed\` or \`abandoned\`. Abandoned means the session
never reached SessionEnd — a closed terminal, a reboot — and was marked by the sweep at
a later SessionStart.

## The journal

\`.journal/<name>.jsonl\` is the append-only source. Hooks append one JSON line per
event, in pure bash, with no process spawn; the \`.md\` is a rendered projection of it,
written temp-then-rename. So a process killed at any instant loses at most the event in
flight, and the markdown on disk is always one valid render or the next — never a
half-written file.

You should not need to read a journal. It is there so the markdown can be rebuilt.

## Getting things in

Sections 3, 5 and 8 are filled from **terminal marker lines** in an assistant's final
message — the same contract the voice layer already uses:

\`\`\`
DECISION: chose X over Y — because Z, and Y would have meant W
GOTCHA: reload-doc silently no-ops here; migrate is the only reliable sync
PENDING: the permissions matrix still needs an Auditor role
\`\`\`

A marker only counts if it is **terminal** — every non-empty line after it is another
marker. That rule is what stops prose *about* the format being harvested as data.

Anything a marker did not capture is recovered at compaction: the discarded window is
read and summarised, and its decisions and gotchas land in the sections above.

## Commands

\`\`\`bash
jarvisctl context              # what is still open on this project
jarvisctl context <path>       # ... on another one
jarvisctl context --speak      # read the open threads aloud
jarvisctl context --reindex    # rebuild INDEX.md from the documents
/load-context <name>           # pull one document into a conversation
\`\`\`

## Never in these files

Credentials. Every string is filtered on the way in for API keys, tokens, PATs, AWS
keys, JWTs, private-key headers and \`secret = …\` assignments. Files whose path looks
like \`.env\`, \`*.pem\`, \`*.key\` or \`credentials\` have their **path recorded and their
contents never read**. There is a test that asserts it.
`;

/** Written once, by whichever process gets there first. Never overwritten. */
function ensureFolderReadme() {
  const f = path.join(CFG.dir, 'README.md');
  try {
    if (fs.existsSync(f)) return;
    fs.mkdirSync(CFG.dir, { recursive: true });
    fs.writeFileSync(f, FOLDER_README, { flag: 'wx' });
  } catch {
    // 'wx' throws when another process won the race, which is the desired outcome.
  }
}

// ------------------------------------------------------------------- index --

const INDEX_HEADER = `# Session index

One line per session, newest first. Open the file only when the objective or the open-thread
count says it is worth the tokens — that is what this index exists to decide.

Naming: \`sessions/<YYYY-MM>/<YYYY-MM-DD>--<project>--<name>--<short-id>.md\`
The short id is the first 8 characters of the session id, which is also the prefix of the raw
transcript under \`~/.claude/projects/\`.

| Date | Project | Branch | Objective | Open |
|---|---|---|---|---|`;

/**
 * Every document, newest month first.
 *
 * `maxMonths` bounds the walk. The pointer runs on SessionStart -- the critical path
 * of opening a session -- and "read every document ever written" is a cost that grows
 * without limit. Three months back is far more history than a pointer can use, and
 * the full walk is still available for the index, where it is the point.
 */
export function allDocs(maxMonths = Infinity) {
  const root = path.join(CFG.dir, 'sessions');
  const out = [];
  let months;
  try {
    months = fs
      .readdirSync(root)
      .filter((m) => /^\d{4}-\d{2}$/.test(m))
      .sort()
      .reverse()
      .slice(0, maxMonths);
  } catch {
    return out;
  }
  for (const m of months) {
    let files;
    try {
      files = fs.readdirSync(path.join(root, m)).filter((f) => f.endsWith('.md'));
    } catch {
      continue;
    }
    for (const f of files) out.push(path.join(root, m, f));
  }
  return out;
}

/** Front matter only — the index must never need to read a whole document. */
export function readFront(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8').slice(0, 4096);
  } catch {
    return null;
  }
  if (!raw.startsWith('---\n')) return null;
  const end = raw.indexOf('\n---', 4);
  if (end < 0) return null;
  const fm = {};
  for (const line of raw.slice(4, end).split('\n')) {
    const i = line.indexOf(':');
    if (i < 0) continue;
    fm[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  // The objective is the first non-empty line under `## Objective`.
  const om = /## Objective\n\n([^\n]+)/.exec(raw);
  fm._objective = om ? om[1] : '';
  fm._file = file;
  return fm;
}

export function buildIndex() {
  ensureFolderReadme();
  const rows = allDocs()
    .map(readFront)
    .filter(Boolean)
    .sort((a, b) => String(b.started || '').localeCompare(String(a.started || '')));
  const lines = [INDEX_HEADER];
  for (const r of rows) {
    const rel = path.relative(CFG.dir, r._file);
    const obj = (r._objective || '').replace(/\|/g, '\\|').slice(0, 90);
    const open = num(r.open_threads, 0);
    const mark = open > 0 ? `**${open}**` : '—';
    const status = r.status && r.status !== 'closed' ? ` _(${r.status})_` : '';
    lines.push(
      `| ${String(r.started || '').slice(0, 10)} | \`${path.basename(r.project || '')}\` | ${
        r.branch || '—'
      } | [${obj || r.name || 'session'}](${encodeURI(rel)})${status} | ${mark} |`
    );
  }
  writeAtomic(path.join(CFG.dir, 'INDEX.md'), lines.join('\n') + '\n');
  return rows.length;
}

/**
 * The SessionStart pointer. A POINTER — never contents.
 *
 * It is injected into a fresh context before anyone has decided the work is worth
 * loading, so it has exactly one job: say that something with open threads exists,
 * and name it precisely enough to load on purpose.
 */
export function pointer(project) {
  const want = projectSlug(project);
  const rows = allDocs(CFG.pointerMonths)
    .map(readFront)
    .filter(Boolean)
    .filter((r) => projectSlug(r.project) === want)
    .filter((r) => num(r.open_threads, 0) > 0)
    .sort((a, b) => String(b.started || '').localeCompare(String(a.started || '')))
    .slice(0, CFG.pointerMax);
  if (!rows.length) return '';
  const out = [
    `Prior session context for \`${want}\` — ${rows.length} recent session(s) left open threads:`,
  ];
  for (const r of rows) {
    out.push(
      `  - ${String(r.started || '').slice(0, 10)} · ${num(r.open_threads, 0)} open · ${(
        r._objective || r.name || ''
      ).slice(0, 70)} · \`${path.basename(r._file)}\``
    );
  }
  out.push('Run `/load-context <name>` to pull one in. Not loaded automatically — that is your call.');
  return out.join('\n');
}

// --------------------------------------------------------------------- CLI --

function arg(argv, name, dflt = '') {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : dflt;
}

function metaFor(key) {
  const st = readState(key);
  if (!st) return null;
  return st;
}

/** Re-render the markdown from the journal. Cheap, atomic, idempotent. */
export function renderDoc(key) {
  const st = metaFor(key);
  if (!st) return null;
  const journal = readJournal(st.journal);
  const s = fold(journal);
  if (!isMeaningful(s)) {
    // Silence is the correct record for a session where nothing happened. Remove a
    // file written optimistically before the session turned out to be trivial.
    try {
      fs.unlinkSync(st.doc);
    } catch {
      /* never existed, which is the same outcome */
    }
    return { doc: st.doc, skipped: true };
  }
  writeAtomic(st.doc, render(s, st));
  return { doc: st.doc, skipped: false, threads: s.threads.length, status: s.status };
}

function cmdOpen(argv) {
  const sid = arg(argv, 'session-id');
  const key = arg(argv, 'key');
  const cwd = arg(argv, 'cwd') || process.cwd();
  const started = num(arg(argv, 'started'), Math.floor(Date.now() / 1000));
  const prompt = arg(argv, 'prompt');
  const branch = arg(argv, 'branch');
  if (!key) return fail('--key is required');

  const existing = readState(key);
  if (existing?.doc) return void process.stdout.write(existing.journal + '\n');

  const d = new Date(started * 1000);
  const p = (n) => String(n).padStart(2, '0');
  const date = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  const meta = {
    key,
    sid,
    cwd,
    branch,
    started,
    date,
    project: projectSlug(cwd),
    name: slugify(prompt),
    slug: slugify(prompt),
  };
  meta.doc = docPath(meta);
  meta.journal = journalPath(meta);
  // Two sessions must never share a document. The short id makes a genuine collision
  // vanishingly unlikely, but the failure mode -- two sessions interleaved into one
  // record, with no error anywhere -- is bad enough to close off rather than to rely
  // on probability. Disambiguate by suffix, and keep the name stable thereafter.
  for (let dup = 2; fs.existsSync(meta.journal) && dup < 100; dup++) {
    const first = readJournal(meta.journal).find((e) => e.k === 'meta');
    if (first && first.sid === sid) break; // our own journal, from a restarted hook
    meta.name = `${slugify(prompt)}-${dup}`;
    meta.doc = docPath(meta);
    meta.journal = journalPath(meta);
  }
  writeState(key, meta);
  appendJournal(meta.journal, {
    t: started,
    k: 'meta',
    sid,
    cwd,
    branch: branch || '',
    title: '',
  });
  if (prompt) {
    appendJournal(meta.journal, {
      t: started,
      k: 'objective',
      v: clip(redact(prompt).replace(/\s+/g, ' ').trim(), 600),
    });
  }
  process.stdout.write(meta.journal + '\n');
}

function cmdPrecompact(argv) {
  const key = arg(argv, 'key');
  const transcript = arg(argv, 'transcript');
  const trigger = arg(argv, 'trigger', 'auto');
  const st = metaFor(key);
  if (!st) return fail('no session state for that key');

  const from = num(st.watermark, 0);
  const w = extractWindow(transcript, from);
  if (!w.ok) return fail('transcript unreadable');

  const n = num(st.snapshots, 0) + 1;
  const snap = {
    t: Math.floor(Date.now() / 1000),
    k: 'snapshot',
    n,
    trigger,
    chars: w.chars,
    turns: w.turns,
    replies: w.replies,
    truncated: w.truncated,
    prompt: w.prompts.length ? w.prompts[w.prompts.length - 1] : '',
    files: w.files,
    cmds: w.commands,
  };
  appendJournal(st.journal, snap);

  // Markers found in the discarded window are promoted into the permanent sections —
  // they are exactly the content compaction would otherwise destroy.
  for (const m of w.markers) {
    const k = m.kind === 'heads-up' ? 'gotcha' : m.kind === 'pending' ? 'thread' : m.kind;
    if (SECTIONS.includes(k)) appendJournal(st.journal, { t: snap.t, k, v: m.text });
  }
  for (const f of w.files) {
    appendJournal(st.journal, { t: snap.t, k: 'file', v: f.path, why: `${f.ops} (compaction ${n})` });
  }

  st.prevWatermark = from;
  st.watermark = w.to;
  st.snapshots = n;
  // The session title and the branch are written into the transcript some way in,
  // long after the document was named. They belong in the front matter, so they go
  // into the journal -- the state sidecar is deleted at close and render() only ever
  // reads the journal, so a value left in state alone is a value silently discarded.
  if ((w.title && !st.title) || (w.branch && !st.branch)) {
    if (w.title) st.title = st.title || w.title;
    if (w.branch) st.branch = st.branch || w.branch;
    appendJournal(st.journal, {
      t: snap.t,
      k: 'meta',
      sid: st.sid,
      cwd: st.cwd,
      branch: st.branch || '',
      title: st.title || '',
    });
  }
  writeState(key, st);
  renderDoc(key);

  // Emitted for voice/jarvis.sh to decide whether the model pass is worth making.
  process.stdout.write(`${n}|${w.chars}|${st.journal}\n`);
}

function cmdPostcompact(argv) {
  const key = arg(argv, 'key');
  const summary = arg(argv, 'summary');
  const st = metaFor(key);
  if (!st) return fail('no session state for that key');
  const n = num(st.snapshots, 0);
  if (!n) return; // nothing to attach to; PreCompact never ran
  if (st.survived === n) return; // idempotent: PostCompact and SessionStart both call this
  appendJournal(st.journal, {
    t: Math.floor(Date.now() / 1000),
    k: 'survived',
    n,
    v: clip(redact(summary).replace(/\s+/g, ' ').trim(), 400) || '(summary not supplied)',
  });
  st.survived = n;
  writeState(key, st);
  renderDoc(key);
}

function cmdReasoned(argv) {
  // The optional model pass, arriving late and out of band. It never blocks anything:
  // the snapshot was already written with the deterministic facts.
  const key = arg(argv, 'key');
  const n = num(arg(argv, 'n'), 0);
  const st = metaFor(key);
  if (!st) return;
  const body = fs.readFileSync(arg(argv, 'file'), 'utf8');
  const lines = harvestMarkers(body.trim());
  const t = Math.floor(Date.now() / 1000);
  for (const m of lines) {
    const k = m.kind === 'heads-up' ? 'gotcha' : m.kind === 'pending' ? 'thread' : m.kind;
    if (SECTIONS.includes(k)) appendJournal(st.journal, { t, k, v: m.text });
  }
  if (lines.length) {
    appendJournal(st.journal, { t, k: 'reasoned', n, v: lines.length });
  }
  renderDoc(key);
}

function cmdClose(argv) {
  const key = arg(argv, 'key');
  const status = arg(argv, 'status', 'closed');
  const st = metaFor(key);
  if (!st) return;
  const now = Math.floor(Date.now() / 1000);

  // Sweep the transcript TAIL -- everything since the last compaction, or the whole
  // session if it never compacted.
  //
  // Without this, "Files touched" and any terminal marker only ever came from a
  // compaction window, so a session that never compacted showed an empty section.
  // Most sessions never compact, so that was the common case, not the edge one.
  //
  // It is done HERE rather than on the Stop path deliberately: the Stop payload
  // carries `last_assistant_message`, not tool calls, so capturing edits per turn
  // would mean a PostToolUse hook -- a process spawn on every single tool call, which
  // is the one cost this design refuses to pay.
  const transcript = arg(argv, 'transcript');
  if (transcript) {
    const w = extractWindow(transcript, num(st.watermark, 0));
    if (w.ok) {
      for (const f of w.files) {
        appendJournal(st.journal, { t: now, k: 'file', v: f.path, why: f.ops });
      }
      for (const m of w.markers) {
        const k = m.kind === 'heads-up' ? 'gotcha' : m.kind === 'pending' ? 'thread' : m.kind;
        if (SECTIONS.includes(k)) appendJournal(st.journal, { t: now, k, v: m.text });
      }
      if (w.title && !st.title) {
        appendJournal(st.journal, {
          t: now, k: 'meta', sid: st.sid, cwd: st.cwd,
          branch: st.branch || w.branch || '', title: w.title,
        });
      }
    }
  }

  appendJournal(st.journal, { t: now, k: 'status', v: status });
  const r = renderDoc(key);
  buildIndex();
  try {
    fs.unlinkSync(statePath(key));
  } catch {
    /* already gone */
  }
  if (r && !r.skipped) process.stdout.write(`${r.doc}\n`);
}

/**
 * Mark documents whose session died without a SessionEnd.
 *
 * A terminal closed with the window, a reboot, a kill -9: all leave `status: active`
 * on a session that will never write again. Left alone the index would claim work is
 * in flight forever. Run at SessionStart, when it costs nothing anyone is waiting on.
 */
function cmdSweep(quiet = false) {
  const live = new Set();
  try {
    for (const f of fs.readdirSync(path.join(HOME, '.claude', 'jarvis', 'state', 'active')))
      live.add(f);
  } catch {
    /* no live sessions */
  }
  let swept = 0;
  let keys = [];
  try {
    keys = fs.readdirSync(CFG.state).filter((f) => f.endsWith('.json'));
  } catch {
    /* nothing staged */
  }
  for (const f of keys) {
    const key = f.replace(/\.json$/, '');
    if (live.has(key)) continue;
    const st = readState(key);
    if (!st) continue;
    appendJournal(st.journal, { t: Math.floor(Date.now() / 1000), k: 'status', v: 'abandoned' });
    renderDoc(key);
    try {
      fs.unlinkSync(statePath(key));
    } catch {
      /* already gone */
    }
    swept++;
  }
  if (swept && !quiet) buildIndex();
  if (!quiet) process.stdout.write(`${swept}\n`);
  return swept;
}

function cmdFind(argv) {
  const q = arg(argv, 'name').toLowerCase();
  const hits = allDocs()
    .filter((f) => !q || path.basename(f).toLowerCase().includes(q))
    .sort()
    .reverse();
  process.stdout.write(hits.slice(0, num(arg(argv, 'limit'), 10)).join('\n') + (hits.length ? '\n' : ''));
}

function cmdContext(argv) {
  const want = projectSlug(arg(argv, 'project') || process.cwd());
  const rows = allDocs()
    .map(readFront)
    .filter(Boolean)
    .filter((r) => !want || projectSlug(r.project) === want)
    .sort((a, b) => String(b.started || '').localeCompare(String(a.started || '')));
  const open = rows.filter((r) => num(r.open_threads, 0) > 0).slice(0, 5);
  if (!rows.length) {
    process.stdout.write(`No session context recorded for "${want}" yet.\n`);
    return;
  }
  const out = [`Session context for ${want} — ${rows.length} session(s), ${open.length} with open threads`, ''];
  for (const r of open) {
    out.push(`== ${String(r.started || '').slice(0, 16)}  ${r.branch || '—'}  ${path.basename(r._file)}`);
    out.push(`   ${r._objective || r.name || ''}`);
    const body = fs.readFileSync(r._file, 'utf8');
    const m = /## Open threads\n\n([\s\S]*?)(?:\n## |\n*$)/.exec(body);
    if (m) for (const l of m[1].split('\n').filter((x) => x.trim().startsWith('- '))) out.push(`   ${l.trim()}`);
    out.push('');
  }
  if (!open.length) out.push('Nothing outstanding. Most recent: ' + path.basename(rows[0]._file));
  out.push(`Index: ${path.join(CFG.dir, 'INDEX.md')}`);
  process.stdout.write(out.join('\n') + '\n');
}

/** Spoken form of the above — short, and only ever the outstanding part. */
function cmdSpeakable(argv) {
  const want = projectSlug(arg(argv, 'project') || process.cwd());
  const rows = allDocs()
    .map(readFront)
    .filter(Boolean)
    .filter((r) => projectSlug(r.project) === want && num(r.open_threads, 0) > 0)
    .sort((a, b) => String(b.started || '').localeCompare(String(a.started || '')));
  if (!rows.length) return void process.stdout.write(`Nothing outstanding on ${want}.\n`);
  const body = fs.readFileSync(rows[0]._file, 'utf8');
  const m = /## Open threads\n\n([\s\S]*?)(?:\n## |\n*$)/.exec(body);
  const items = m
    ? m[1]
        .split('\n')
        .filter((x) => x.trim().startsWith('- '))
        .map((x) => x.replace(/^-\s*\[[ x]\]\s*/, '').replace(/^-\s*/, '').trim())
        .slice(0, 2)
    : [];
  process.stdout.write(
    `On ${want.replace(/-/g, ' ')}: ${items.join('. And ') || 'nothing outstanding'}.\n`
  );
}

/**
 * SessionStart, in one spawn: sweep, reindex, and emit the pointer.
 *
 * Three things that all want to happen at exactly the same moment, on the one hook
 * where a few tens of milliseconds are affordable. Doing them as three invocations
 * would triple a cost paid on every session start for no benefit.
 *
 * The pointer is emitted as Claude Code's `additionalContext` envelope. Built with
 * JSON.stringify rather than by hand: the text contains backticks, newlines and
 * paths, and a hook whose stdout is not valid JSON silently stops injecting.
 */
function cmdStartup(argv) {
  const project = arg(argv, 'project') || process.cwd();
  // The sweep reports whether it changed anything. The index is only rebuilt when it
  // did -- it is already rebuilt at every close, so an unconditional walk here would
  // re-read the whole archive on every session start to learn nothing.
  const swept = cmdSweep(true);
  if (swept > 0) buildIndex();
  else ensureFolderReadme();
  const text = pointer(project);
  if (!text) return;
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text },
    }) + '\n'
  );
}

/**
 * Build the prompt for the optional model pass over a discarded window.
 *
 * Tool RESULTS are excluded and tool INPUTS are reduced to a name and a path. They
 * are the overwhelming bulk of a transcript — file contents, command output, search
 * results — and they are the part deterministic extraction already covered. What is
 * left is the conversation: what was asked and what was reasoned, which is the only
 * thing a model is needed for. That exclusion is what keeps a 150k-token window
 * inside a 20-40k-token request.
 */
function cmdLlmPrompt(argv) {
  const key = arg(argv, 'key');
  const st = metaFor(key);
  if (!st) return;
  const from = Math.max(0, num(st.prevWatermark, 0));
  const w = extractWindow(arg(argv, 'transcript'), from, 8 * 1024 * 1024, true);
  if (!w.ok) return;

  const convo = [];
  for (const p of w.prompts) convo.push(`USER: ${p}`);
  for (const a of w.prose) convo.push(`ASSISTANT: ${a}`);
  const body = convo.join('\n').slice(0, 60000);
  if (body.length < 200) return;

  process.stdout.write(
    [
      'You are reading a slice of a coding session that is about to be discarded by',
      'context compaction. Recover ONLY what a future session would otherwise have to',
      'rediscover. Be ruthless: an obvious or generic line is worse than no line.',
      '',
      'Output at most 5 lines, each on its own line, each starting with exactly one of:',
      '  DECISION: <what was decided> — <why, and what was rejected>',
      '  GOTCHA: <something surprising about this codebase>',
      '  PENDING: <something left unfinished>',
      '',
      'No preamble, no explanation, no markdown, no other text. If nothing is worth',
      'recording, output nothing at all.',
      '',
      '--- transcript slice ---',
      body,
    ].join('\n')
  );
}

function fail(msg) {
  process.stderr.write(`context: ${msg}\n`);
  process.exitCode = 1;
}

const USAGE = `usage: context.mjs <command> [--flags]

  open        --key K --session-id S --cwd D [--branch B] [--started EPOCH] [--prompt TEXT]
  render      --key K
  precompact  --key K --transcript PATH [--trigger auto|manual]
  postcompact --key K [--summary TEXT]
  reasoned    --key K --n N --file PATH
  close       --key K [--status closed|abandoned] [--transcript PATH]
  startup     --project PATH        (sweep + reindex + pointer, one spawn)
  llmprompt   --key K --n N --transcript PATH
  sweep
  index
  pointer     --project PATH
  context     --project PATH
  speakable   --project PATH
  find        --name QUERY [--limit N]
  path        --key K
`;

export function main(argv = process.argv.slice(2)) {
  const cmd = argv[0];
  switch (cmd) {
    case 'open':
      return cmdOpen(argv);
    case 'render': {
      const r = renderDoc(arg(argv, 'key'));
      if (r && !r.skipped) process.stdout.write(`${r.doc}\n`);
      return;
    }
    case 'precompact':
      return cmdPrecompact(argv);
    case 'postcompact':
      return cmdPostcompact(argv);
    case 'reasoned':
      return cmdReasoned(argv);
    case 'close':
      return cmdClose(argv);
    case 'sweep':
      return cmdSweep();
    case 'startup':
      return cmdStartup(argv);
    case 'llmprompt':
      return cmdLlmPrompt(argv);
    case 'index':
      return void process.stdout.write(`${buildIndex()}\n`);
    case 'pointer':
      return void process.stdout.write(pointer(arg(argv, 'project')) + '\n');
    case 'context':
      return cmdContext(argv);
    case 'speakable':
      return cmdSpeakable(argv);
    case 'find':
      return cmdFind(argv);
    case 'path': {
      const st = metaFor(arg(argv, 'key'));
      return void process.stdout.write((st?.journal || '') + '\n');
    }
    default:
      process.stdout.write(USAGE);
      process.exitCode = cmd ? 2 : 0;
  }
}

// Only run as a CLI, so the tests can import every function above.
if (process.argv[1] && process.argv[1].endsWith('context.mjs')) {
  try {
    main();
  } catch (e) {
    // A context recorder that can break a hook is a liability. Report and exit 0.
    process.stderr.write(`context: ${e.message}\n`);
  }
}
