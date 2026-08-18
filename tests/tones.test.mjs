/**
 * Tone synthesis test suite.
 *
 * Sound is the one output a test cannot listen to, so this asserts the things that
 * DETERMINE how it sounds and which fail silently when wrong. Every case here is a
 * defect that actually happened, or the invariant that prevents its return.
 *
 * These run on every platform, unlike the shell harnesses, because the synthesiser is
 * the part that has to produce identical output everywhere.
 *
 * Run: node --test tests/
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generate, MOTIFS, SESSION_SEMIS, ROOT } from '../scripts/tones.mjs';

let tmp;
let table;
before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jv-tones-'));
  generate({ target: tmp, apply: true });
  table = parseTable(fs.readFileSync(path.join(tmp, 'tones', 'motifs.sh'), 'utf8'));
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** Read the emitted shell table the way speaker.sh does — as plain assignments. */
function parseTable(src) {
  const out = { motif: {}, span: {} };
  for (const line of src.split('\n')) {
    const m = line.match(/^(MOTIF|SPAN)_([a-z]+)_(\d)="(.*)"$/);
    if (!m) continue;
    const [, kind, name, ord, val] = m;
    (kind === 'MOTIF' ? out.motif : out.span)[`${name}_${ord}`] = val;
  }
  // Non-transposing motifs are emitted as references to ordinal 1, exactly as the
  // shell would expand them — for the spans as well as the note sequences.
  for (const [kind, prefix] of [['motif', 'MOTIF'], ['span', 'SPAN']]) {
    for (const k of Object.keys(out[kind])) {
      const ref = out[kind][k].match(new RegExp(`^\\$${prefix}_([a-z]+)_1$`));
      if (ref) out[kind][k] = out[kind][`${ref[1]}_1`];
    }
  }
  return out;
}

const notes = (name, ord) => (table.motif[`${name}_${ord}`] || '').split(' ').filter(Boolean);
const hzOf = (semitone) => ROOT * Math.pow(2, semitone / 12);

/** Minimal WAV reader — enough to check what was actually written to disk. */
function readWav(file) {
  const b = fs.readFileSync(file);
  assert.equal(b.toString('ascii', 0, 4), 'RIFF', `${file} is not RIFF`);
  assert.equal(b.toString('ascii', 8, 12), 'WAVE', `${file} is not WAVE`);
  const channels = b.readUInt16LE(22);
  const rate = b.readUInt32LE(24);
  const bits = b.readUInt16LE(34);
  const n = b.readUInt32LE(40) / 2;
  const s = new Float64Array(n);
  for (let i = 0; i < n; i++) s[i] = b.readInt16LE(44 + i * 2) / 32768;
  let peak = 0;
  let sq = 0;
  for (const v of s) {
    peak = Math.max(peak, Math.abs(v));
    sq += v * v;
  }
  return { channels, rate, bits, samples: s, peak, rms: Math.sqrt(sq / n), seconds: n / rate };
}

describe('the emitted table is complete', () => {
  test('every motif answers for all four session ordinals', () => {
    // A session in slot 3 hitting an error must not find an empty sequence. It would
    // play nothing, report nothing, and look exactly like a working install.
    for (const name of Object.keys(MOTIFS)) {
      for (const ord of [1, 2, 3, 4]) {
        assert.ok(notes(name, ord).length > 0, `${name}/${ord} has no sequence`);
        assert.ok(table.span[`${name}_${ord}`], `${name}/${ord} has no span`);
      }
    }
  });

  test('every referenced tone exists on disk', () => {
    // The motif table and the WAV files are emitted together; if they can disagree,
    // a partial install is silent rather than broken.
    for (const name of Object.keys(MOTIFS)) {
      for (const ord of [1, 2, 3, 4]) {
        for (const item of notes(name, ord)) {
          const f = path.join(tmp, 'tones', item.split(':')[0]);
          assert.ok(fs.existsSync(f), `${name}/${ord} references missing ${item}`);
        }
      }
    }
  });

  test('the span covers the last note, or speech starts over the chime', () => {
    for (const name of Object.keys(MOTIFS)) {
      for (const ord of [1, 2, 3, 4]) {
        const last = Math.max(...notes(name, ord).map((i) => Number(i.split(':')[1])));
        assert.ok(Number(table.span[`${name}_${ord}`]) > last, `${name}/${ord} span ${table.span[`${name}_${ord}`]} <= last delay ${last}`);
      }
    }
  });
});

describe('pitch', () => {
  test('session ordinals are actually transposed', () => {
    // The predecessor multiplied playback rates and silently clamped at afplay's
    // ceiling, collapsing sessions 3 and 4 onto one identical tone.
    for (const [name, m] of Object.entries(MOTIFS)) {
      if (!m.transpose) continue;
      const seen = new Set([1, 2, 3, 4].map((o) => notes(name, o).join(' ')));
      assert.equal(seen.size, 4, `${name} does not differ across all four ordinals`);
    }
  });

  test('the error motif is deliberately NOT transposed', () => {
    // Bad news should sound the same whichever session it came from; the session is
    // named in the sentence.
    const a = notes('err', 1).join(' ');
    for (const o of [2, 3, 4]) assert.equal(notes('err', o).join(' '), a);
  });

  test('bright tones clear the speech formant band', () => {
    // The original atom put 95% of its energy in 300-1000Hz, exactly where a male
    // voice's F1 and F2 live, so the chime masked the first word of the sentence.
    for (const [name, m] of Object.entries(MOTIFS)) {
      if (m.dark) continue;
      for (const ord of [1, 2, 3, 4]) {
        const shift = m.transpose ? SESSION_SEMIS[ord - 1] : 0;
        for (const [n] of m.notes) {
          assert.ok(hzOf(n + shift) > 1000, `${name}/${ord} note at ${hzOf(n + shift).toFixed(0)}Hz is inside the speech band`);
        }
      }
    }
  });

  test('nothing is shrill', () => {
    for (const [name, m] of Object.entries(MOTIFS)) {
      for (const ord of [1, 2, 3, 4]) {
        const shift = m.transpose ? SESSION_SEMIS[ord - 1] : 0;
        for (const [n] of m.notes) {
          const hz = m.dark ? hzOf(n + shift) / 4 : hzOf(n + shift);
          assert.ok(hz < 5000, `${name}/${ord} note at ${hz.toFixed(0)}Hz`);
        }
      }
    }
  });
});

describe('meaning is carried by shape', () => {
  const dir = (name) => {
    const ns = MOTIFS[name].notes.map(([n]) => n);
    return ns[ns.length - 1] - ns[0];
  };
  test('completion rises', () => assert.ok(dir('done') > 0, 'a completion that falls reads as failure'));
  test('startup rises', () => assert.ok(dir('boot') > 0));
  test('error falls', () => assert.ok(dir('err') < 0, 'bad news that rises reads as good news'));
  test('shutdown falls', () => assert.ok(dir('bye') < 0));
  test('approval repeats one pitch, so it reads as insistence not news', () => {
    const ns = MOTIFS.approve.notes.map(([n]) => n);
    assert.equal(new Set(ns).size, 1);
    assert.ok(ns.length >= 3, 'fewer than three taps does not read as insistent');
  });
});

describe('loudness, measured from the written files', () => {
  const rmsOf = (name) => {
    const f = path.join(tmp, 'tones', notes(name, 1)[0].split(':')[0]);
    return readWav(f).rms;
  };
  test('an urgent alert is never quieter than a routine one', () => {
    // It was: measured RMS varies 4.6x across the macOS system sounds, so a single
    // volume setting made the error chime quieter than the completion.
    assert.ok(rmsOf('err') > rmsOf('done'), 'error is quieter than completion');
    assert.ok(rmsOf('nag') > rmsOf('done'), 'nag is quieter than completion');
    assert.ok(rmsOf('approve') > rmsOf('done'), 'approval is quieter than completion');
  });
  test('background events are quieter than the ones that need you', () => {
    assert.ok(rmsOf('sub') < rmsOf('done'), 'a subagent tick is as loud as a completion');
    assert.ok(rmsOf('tick') < rmsOf('done'));
    assert.ok(rmsOf('idle') < rmsOf('approve'));
  });
  test('nothing clips', () => {
    for (const f of fs.readdirSync(path.join(tmp, 'tones')).filter((x) => x.endsWith('.wav'))) {
      assert.ok(readWav(path.join(tmp, 'tones', f)).peak < 0.99, `${f} clips`);
    }
  });
});

describe('the files themselves', () => {
  test('are mono 16-bit PCM, which is what every backend can play', () => {
    for (const f of fs.readdirSync(path.join(tmp, 'tones')).filter((x) => x.endsWith('.wav'))) {
      const w = readWav(path.join(tmp, 'tones', f));
      assert.equal(w.channels, 1, `${f} is not mono`);
      assert.equal(w.bits, 16, `${f} is not 16-bit`);
      assert.equal(w.rate, 44100);
    }
  });

  test('are short — these are chimes, not notifications with a tail', () => {
    for (const f of fs.readdirSync(path.join(tmp, 'tones')).filter((x) => x.endsWith('.wav'))) {
      assert.ok(readWav(path.join(tmp, 'tones', f)).seconds < 1.0, `${f} runs long`);
    }
  });

  test('start and end at silence, or the tone has a click of its own', () => {
    for (const f of fs.readdirSync(path.join(tmp, 'tones')).filter((x) => x.endsWith('.wav'))) {
      const w = readWav(path.join(tmp, 'tones', f));
      assert.ok(Math.abs(w.samples[0]) < 0.02, `${f} starts mid-waveform`);
      assert.ok(Math.abs(w.samples[w.samples.length - 1]) < 0.02, `${f} is cut off before it decays`);
    }
  });

  test('generation is deterministic', () => {
    // The noise transient uses a seeded generator specifically so a reinstall is a
    // no-op rather than 54 changed files with identical sound.
    const a = fs.mkdtempSync(path.join(os.tmpdir(), 'jv-det-'));
    const b = fs.mkdtempSync(path.join(os.tmpdir(), 'jv-det-'));
    try {
      generate({ target: a, apply: true });
      generate({ target: b, apply: true });
      for (const f of fs.readdirSync(path.join(a, 'tones'))) {
        assert.deepEqual(fs.readFileSync(path.join(a, 'tones', f)), fs.readFileSync(path.join(b, 'tones', f)), `${f} differs between runs`);
      }
    } finally {
      fs.rmSync(a, { recursive: true, force: true });
      fs.rmSync(b, { recursive: true, force: true });
    }
  });

  test('a stale tone from an earlier generation is removed', () => {
    const orphan = path.join(tmp, 'tones', 'zz-orphan.wav');
    fs.writeFileSync(orphan, 'x');
    generate({ target: tmp, apply: true });
    assert.ok(!fs.existsSync(orphan), 'orphaned tones accumulate on every upgrade');
  });

  test('a dry run writes nothing', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'jv-dry-'));
    try {
      const r = generate({ target: d, apply: false });
      assert.ok(r.count > 0, 'dry run reported no tones');
      assert.ok(!fs.existsSync(path.join(d, 'tones')), 'dry run created files');
    } finally {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });
});
