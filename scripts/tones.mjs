/**
 * Tone synthesiser — the single source of truth for what JARVIS sounds like.
 *
 * The first version played macOS system sounds, resampled with `afplay -r` for pitch
 * and `-v` for gain. Measuring them showed why that had to go:
 *
 *   - the usable ones are 0.56-1.65s long, so "two notes 160ms apart" was really a
 *     sustained chord, and the same file layered over itself was comb filtering
 *   - measured RMS varies 4.6x between them, so one gain setting made the ERROR
 *     chime quieter than the routine completion
 *   - `afplay -r` clamps silently outside 0.4-3.0, which collapsed two sessions onto
 *     one identical tone
 *   - and none of `-r`, `-v` or `afplay` exists off macOS. `aplay` and Windows'
 *     Media.SoundPlayer have no volume control at all
 *
 * So the tones are synthesised here with pitch, envelope and loudness already baked
 * in. Playback becomes "play this file", which every platform can do, and the
 * frequency and decay are chosen rather than inherited.
 *
 * Output: <target>/tones/*.wav plus <target>/tones/motifs.sh, a plain shell table so
 * speaker.sh needs no parser and no jq.
 */

import fs from 'node:fs';
import path from 'node:path';

const SR = 44100;

/**
 * C6. Measurement picked this, not taste: the percussive atom's energy had to sit
 * ABOVE the 300-1000Hz band where a male voice's first two formants live, or the
 * chime masks the first word of the sentence — which is normally the project name.
 * At 1046Hz that band holds under 10% of the tone's energy.
 */
const ROOT = 1046.5;
const semi = (n) => ROOT * Math.pow(2, n / 12);

/** Session identity is a transposition of the whole motif, two semitones per slot. */
const SESSION_SEMIS = [0, 2, 4, 6];

/**
 * Motifs. The SHAPE carries the meaning, which is why a single atom is pitch-
 * sequenced rather than two different sounds being layered: rising resolves, falling
 * does not, and a repeated note at one pitch reads as insistence rather than as news.
 *
 * notes: [semitone-above-motif-root, delay-seconds]
 * gain:  relative loudness. Ordered by importance, not by taste — an urgent alert
 *        must never be quieter than a routine one, which it was.
 * dark:  a low, slower-decaying voice for bad news only.
 */
const MOTIFS = {
  boot:    { gain: 0.55, notes: [[0, 0], [7, 0.10], [12, 0.20]], transpose: true },
  done:    { gain: 0.62, notes: [[0, 0], [5, 0.11]], transpose: true },
  approve: { gain: 0.85, notes: [[4, 0], [4, 0.13], [4, 0.26]], transpose: true },
  nag:     { gain: 0.95, notes: [[7, 0], [7, 0.10], [7, 0.20]], transpose: true },
  err:     { gain: 1.00, notes: [[3, 0], [-4, 0.16]], dark: true, transpose: false },
  // Escalation: a session blocked long enough that the nags have run out. Five taps,
  // the loudest thing in the set, alternating high and low so it cannot be mistaken
  // for any of the others. It should be mildly annoying — that is its function.
  escalate: { gain: 1.00, notes: [[12, 0], [5, 0.11], [12, 0.22], [5, 0.33], [12, 0.44]], transpose: false },
  idle:    { gain: 0.38, notes: [[0, 0], [0, 0.14]], transpose: true },
  tick:    { gain: 0.28, notes: [[7, 0]], transpose: true },
  // High and quiet, not low and quiet. At -5 semitones this sat at 783Hz with 84% of
  // its energy in the speech band, where music masks it; an octave above the tick it
  // is both distinct from the tick and clear of the mud, while staying subtle.
  sub:     { gain: 0.22, notes: [[14, 0]], transpose: true },
  bye:     { gain: 0.50, notes: [[12, 0], [7, 0.10], [0, 0.20]], transpose: true },
};

/**
 * One struck tone. A pure sine is thin and disappears under music, so this is a
 * struck-bell model: a fundamental with a few inharmonic partials that decay faster
 * than it does, plus a 2ms noise transient for the attack. That is what makes it read
 * as a physical object being hit rather than as a beep.
 */
function tone(freq, { gain = 0.6, decay = 0.055, dark = false } = {}) {
  const partials = dark
    ? [[1, 1.0, 1.0], [2, 0.42, 1.5], [3.02, 0.16, 2.2], [4.1, 0.06, 3.0]]
    : [[1, 1.0, 1.0], [2.01, 0.34, 1.7], [3.04, 0.13, 2.6], [5.2, 0.05, 3.6]];
  // Five time-constants puts the tail at -43dB, which is inaudible. Six was chosen
  // arbitrarily and made every file 20% larger for silence.
  const len = Math.ceil(SR * (decay * 5 + 0.02));
  const out = new Float64Array(len);
  // A deterministic noise source: a fixed seed keeps the generated files identical
  // between runs, so a reinstall is a no-op in a diff rather than 80 changed files.
  let seed = 0x2545f491;
  const rnd = () => {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    return ((seed >>> 0) / 0xffffffff) * 2 - 1;
  };
  for (let i = 0; i < len; i++) {
    const t = i / SR;
    let v = 0;
    for (const [mult, amp, decayMult] of partials) {
      v += amp * Math.sin(2 * Math.PI * freq * mult * t) * Math.exp(-t / (decay / decayMult));
    }
    // Attack transient, and a 1.5ms fade-in so the waveform starts at zero — a hard
    // start is an audible click on top of the intended one.
    if (t < 0.002) v += rnd() * 0.5 * (1 - t / 0.002);
    const fin = Math.min(1, t / 0.0015);
    out[i] = v * fin;
  }
  // Normalise, then apply the intended gain, then soft-clip. Normalising first is
  // what makes `gain` mean the same thing for a bright tone and a dark one — the
  // failure being avoided is exactly the 4.6x spread across the system sounds.
  let peak = 0;
  for (const v of out) peak = Math.max(peak, Math.abs(v));
  const k = peak > 0 ? gain / peak : 0;
  const pcm = Buffer.alloc(len * 2);
  for (let i = 0; i < len; i++) {
    const x = Math.tanh(out[i] * k * 1.1) * 0.97;
    pcm.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(x * 32767))), i * 2);
  }
  return pcm;
}

function wav(pcm) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);          // PCM
  h.writeUInt16LE(1, 22);          // mono
  h.writeUInt32LE(SR, 24);
  h.writeUInt32LE(SR * 2, 28);     // byte rate
  h.writeUInt16LE(2, 32);          // block align
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

/** afplay's old 0.4-3.0 rate window is gone, but a sanity band is still worth having. */
const MIN_HZ = 120;
const MAX_HZ = 5000;

export function generate({ target, apply = false }) {
  const dir = path.join(target, 'tones');
  const files = new Map();   // filename -> buffer
  const table = [];
  const warnings = [];

  for (const [name, m] of Object.entries(MOTIFS)) {
    const ordinals = m.transpose ? [1, 2, 3, 4] : [1];
    for (const ord of ordinals) {
      const shift = m.transpose ? SESSION_SEMIS[ord - 1] : 0;
      const seq = [];
      let span = 0;
      for (const [n, delay] of m.notes) {
        const s = n + shift;
        const hz = m.dark ? semi(s) / 4 : semi(s);   // the dark voice is two octaves down
        if (hz < MIN_HZ || hz > MAX_HZ) warnings.push(`${name}/${ord}: ${hz.toFixed(0)}Hz outside ${MIN_HZ}-${MAX_HZ}`);
        // The measured reference was audible for only 0.04s — a click, not a chime.
        // 0.09 was slower than the thing it was modelled on; 0.055 puts the audible
        // part near 0.15s, which reads as percussive rather than as a bell.
        const decay = m.dark ? 0.14 : 0.055;
        const key = `${m.dark ? 'd' : 't'}${s >= 0 ? '' : 'm'}${Math.abs(s)}-g${Math.round(m.gain * 100)}.wav`;
        if (!files.has(key)) files.set(key, wav(tone(hz, { gain: m.gain, decay, dark: !!m.dark })));
        seq.push(`${key}:${delay}`);
        span = Math.max(span, delay + (m.dark ? 0.30 : 0.16));
      }
      table.push(`MOTIF_${name}_${ord}="${seq.join(' ')}"`);
      table.push(`SPAN_${name}_${ord}="${span.toFixed(2)}"`);
    }
    // Non-transposing motifs still have to answer for every ordinal, or a session in
    // slot 3 hitting an error would find no sequence and play nothing at all.
    if (!m.transpose) {
      for (const ord of [2, 3, 4]) {
        table.push(`MOTIF_${name}_${ord}="$MOTIF_${name}_1"`);
        table.push(`SPAN_${name}_${ord}="$SPAN_${name}_1"`);
      }
    }
  }

  const sh = [
    '# Generated by scripts/tones.mjs — do not edit.',
    '# Pitch, envelope and loudness are baked into the WAV files, so playback needs no',
    '# rate or volume flags and works identically on macOS, Linux and Windows.',
    '',
    ...table,
    '',
  ].join('\n');

  if (apply) {
    fs.mkdirSync(dir, { recursive: true });
    for (const [name, buf] of files) fs.writeFileSync(path.join(dir, name), buf);
    fs.writeFileSync(path.join(dir, 'motifs.sh'), sh);
    // Remove tones from an earlier generation, or a renamed gain leaves orphans that
    // accumulate on every upgrade.
    for (const f of fs.readdirSync(dir)) {
      if (f.endsWith('.wav') && !files.has(f)) fs.rmSync(path.join(dir, f));
    }
  }

  const bytes = [...files.values()].reduce((n, b) => n + b.length, 0);
  return { dir, count: files.size, bytes, motifs: Object.keys(MOTIFS).length, warnings, applied: apply };
}

export { MOTIFS, SESSION_SEMIS, ROOT };
