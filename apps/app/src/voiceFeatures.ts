// "Respond only to my voice": the sums behind the voice check, with no browser APIs so they're tested in Node.
// 80 Kaldi-style filterbank bands (what the WeSpeaker model was trained on: 25 ms frames every 10 ms, Povey window,
// pre-emphasis 0.97, DC removed, snip-edges, no dither), each band's mean over the phrase subtracted; and the voiceprint
// sums: how alike two prints are, levels set from the person's own setup phrases, and learning.

export const SAMPLE_RATE = 16000;
const FRAME = 400, SHIFT = 160, NFFT = 512, BANDS = 80;
const EPS = 1.1920928955078125e-7; // the smallest step of a float32, as Kaldi uses

const mel = (f: number) => 1127 * Math.log(1 + f / 700);
let tables: { window: Float64Array; banks: { start: number; weights: Float64Array }[]; cos: Float64Array; sin: Float64Array; rev: Uint16Array } | null = null;
function prepare() {
  if (tables) return tables;
  const window = new Float64Array(FRAME);
  for (let i = 0; i < FRAME; i++) window[i] = Math.pow(0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FRAME - 1)), 0.85);
  const lo = mel(20), hi = mel(SAMPLE_RATE / 2), step = (hi - lo) / (BANDS + 1), binHz = SAMPLE_RATE / NFFT;
  const banks: { start: number; weights: Float64Array }[] = [];
  for (let b = 0; b < BANDS; b++) {
    const left = lo + b * step, center = left + step, right = center + step;
    const w: number[] = []; let start = -1;
    for (let i = 0; i < NFFT / 2; i++) {
      const m = mel(binHz * i);
      if (m > left && m < right) { if (start < 0) start = i; w.push(m <= center ? (m - left) / (center - left) : (right - m) / (right - center)); }
      else if (start >= 0) break;
    }
    banks.push({ start: Math.max(0, start), weights: Float64Array.from(w) });
  }
  const cos = new Float64Array(NFFT / 2), sin = new Float64Array(NFFT / 2);
  for (let i = 0; i < NFFT / 2; i++) { cos[i] = Math.cos((-2 * Math.PI * i) / NFFT); sin[i] = Math.sin((-2 * Math.PI * i) / NFFT); }
  const rev = new Uint16Array(NFFT), bits = Math.log2(NFFT);
  for (let i = 0; i < NFFT; i++) { let r = 0; for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b); rev[i] = r; }
  return (tables = { window, banks, cos, sin, rev });
}
function fft(re: Float64Array, im: Float64Array) {
  const { cos, sin, rev } = prepare();
  for (let i = 0; i < NFFT; i++) { const j = rev[i]!; if (j > i) { [re[i], re[j]] = [re[j]!, re[i]!]; [im[i], im[j]] = [im[j]!, im[i]!]; } }
  for (let size = 2; size <= NFFT; size <<= 1) {
    const half = size >> 1, step = NFFT / size;
    for (let s = 0; s < NFFT; s += size) for (let k = 0; k < half; k++) {
      const c = cos[k * step]!, n = sin[k * step]!, a = s + k, b = a + half;
      const tr = re[b]! * c - im[b]! * n, ti = re[b]! * n + im[b]! * c;
      re[b] = re[a]! - tr; im[b] = im[a]! - ti; re[a] = re[a]! + tr; im[a] = im[a]! + ti;
    }
  }
}
/** Filterbank features for audio at 16 kHz in -1..1, as [frames × 80], with each band's mean removed. */
export function fbank(samples: Float32Array): { data: Float32Array; frames: number } {
  const { window, banks } = prepare();
  const frames = samples.length < FRAME ? 0 : 1 + Math.floor((samples.length - FRAME) / SHIFT);
  const out = new Float32Array(frames * BANDS);
  const re = new Float64Array(NFFT), im = new Float64Array(NFFT);
  for (let f = 0; f < frames; f++) {
    re.fill(0); im.fill(0);
    let mean = 0;
    for (let i = 0; i < FRAME; i++) { re[i] = samples[f * SHIFT + i]! * 32768; mean += re[i]!; }
    mean /= FRAME;
    for (let i = 0; i < FRAME; i++) re[i] = re[i]! - mean;
    for (let i = FRAME - 1; i > 0; i--) re[i] = re[i]! - 0.97 * re[i - 1]!;
    re[0] = re[0]! - 0.97 * re[0]!;
    for (let i = 0; i < FRAME; i++) re[i] = re[i]! * window[i]!;
    fft(re, im);
    for (let b = 0; b < BANDS; b++) {
      const { start, weights } = banks[b]!;
      let e = 0;
      for (let j = 0; j < weights.length; j++) { const k = start + j; e += weights[j]! * (re[k]! * re[k]! + im[k]! * im[k]!); }
      out[f * BANDS + b] = Math.log(Math.max(e, EPS));
    }
  }
  if (frames) for (let b = 0; b < BANDS; b++) {
    let m = 0; for (let f = 0; f < frames; f++) m += out[f * BANDS + b]!;
    m /= frames; for (let f = 0; f < frames; f++) out[f * BANDS + b] = out[f * BANDS + b]! - m;
  }
  return { data: out, frames };
}

/** The part of a recording with speech in it: quiet edges trimmed (frames under a tenth of the loudest). */
export function trimSilence(samples: Float32Array): Float32Array {
  const win = 320, n = Math.floor(samples.length / win);
  if (n < 3) return samples;
  const rms = Array.from({ length: n }, (_, i) => { let s = 0; for (let j = 0; j < win; j++) { const x = samples[i * win + j]!; s += x * x; } return Math.sqrt(s / win); });
  const top = Math.max(...rms), floor = top * 0.1;
  let a = rms.findIndex((r) => r >= floor), b = n - 1 - [...rms].reverse().findIndex((r) => r >= floor);
  a = Math.max(0, a - 5); b = Math.min(n - 1, b + 5);
  return samples.subarray(a * win, (b + 1) * win);
}
/** How long the speech in a recording lasts (seconds), and how loud speech is against the quietest part. */
export function phraseCheck(samples: Float32Array): { seconds: number; loud: number; noise: number } {
  const win = 320, n = Math.floor(samples.length / win);
  const rms = Array.from({ length: n }, (_, i) => { let s = 0; for (let j = 0; j < win; j++) { const x = samples[i * win + j]!; s += x * x; } return Math.sqrt(s / win); }).sort((a, b) => a - b);
  if (!n) return { seconds: 0, loud: 0, noise: 1 };
  const noise = rms[Math.floor(n * 0.1)]!, loud = rms[Math.floor(n * 0.9)]!;
  const speech = rms.filter((r) => r > Math.max(noise * 3, 0.01)).length;
  return { seconds: (speech * win) / SAMPLE_RATE, loud, noise: loud ? noise / loud : 1 };
}

// ---------------------------------------------------------------- voiceprints
export const PRINT_SIZE = 256;
const norm = (v: ArrayLike<number>) => { let s = 0; for (let i = 0; i < v.length; i++) s += v[i]! * v[i]!; return Math.sqrt(s) || 1; };
export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let d = 0; for (let i = 0; i < a.length; i++) d += a[i]! * b[i]!;
  return d / (norm(a) * norm(b));
}
const unit = (v: ArrayLike<number>) => { const n = norm(v); return Array.from(v, (x) => x / n); };
const mean = (vs: number[][]) => unit(vs[0]!.map((_, i) => vs.reduce((s, v) => s + v[i]!, 0) / vs.length));

export type Strictness = 'relaxed' | 'balanced' | 'strict';
export interface Levels { relaxed: number; balanced: number; strict: number }
/** Never below these, whatever the setup phrases say (another adult usually scores under 0.4), and never above the
 *  ceilings, so a person whose phrases matched very closely isn't made to repeat themselves. */
export const FLOORS: Levels = { relaxed: 0.42, balanced: 0.5, strict: 0.58 };
export const CEILINGS: Levels = { relaxed: 0.55, balanced: 0.62, strict: 0.7 };
const clamp = (x: number, k: Strictness) => Math.round(Math.min(CEILINGS[k], Math.max(FLOORS[k], x)) * 1000) / 1000;
/** A voiceprint from the setup phrases, with levels set from how closely the phrases match each other: each phrase is
 *  compared with the print made from the others, and the levels sit below the weakest of those (everyday requests
 *  match a little less well than phrases said in one sitting). */
export function makePrint(embeddings: number[][]): { print: number[]; levels: Levels; spread: number[] } {
  if (embeddings.length < 3) throw new Error('At least three phrases are needed.');
  const spread = embeddings.map((e, i) => cosine(mean(embeddings.filter((_, j) => j !== i).map(unit)), e));
  const weakest = Math.min(...spread);
  return {
    print: mean(embeddings.map(unit)),
    levels: { strict: clamp(weakest - 0.08, 'strict'), balanced: clamp(weakest - 0.15, 'balanced'), relaxed: clamp(weakest - 0.22, 'relaxed') },
    spread: spread.map((s) => Math.round(s * 1000) / 1000),
  };
}
/** Whether a score is the person at the chosen strictness, and whether it's strong enough to learn from. */
export function decide(score: number, levels: Levels, strict: Strictness): { you: boolean; strong: boolean } {
  return { you: score >= levels[strict], strong: score >= Math.max(levels.strict + 0.05, 0.68) };
}
/** Adds a phrase to the print ("Keep learning my voice", or "That was me"). Older phrases keep most of the weight,
 *  and one phrase can never move the print far. */
export function learnInto(print: number[], count: number, embedding: number[]): { print: number[]; count: number } {
  const n = Math.min(count, 30), e = unit(embedding);
  return { print: unit(print.map((p, i) => (p * n + e[i]!) / (n + 1))), count: count + 1 };
}
