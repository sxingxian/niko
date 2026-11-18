// Respond only to my voice: the filterbank matches Kaldi's (what the model was trained on), the pinned model file is
// the one in the build, the model runs with the same WebAssembly runtime the app uses and ignores loudness, levels are
// set from the setup phrases within fixed floors and ceilings, and learning moves the voiceprint only a little.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CEILINGS, cosine, decide, fbank, FLOORS, learnInto, makePrint, phraseCheck, trimSilence } from '../apps/app/src/voiceFeatures.ts';

const here = fileURLToPath(new URL('.', import.meta.url));
let pass = 0;
const ok = async (name, fn) => { try { await fn(); pass++; console.log('PASS', name); } catch (e) { console.log('FAIL', name, e?.stack ?? e?.message); process.exitCode = 1; } };

// The same signal as tests/fixtures/fbank-ref.json (made with kaldi-native-fbank: dither 0, snip edges, 80 bins, then
// each band's mean removed).
function signal(seconds = 1) {
  const n = 16000 * seconds, x = new Float32Array(n); let seed = 12345;
  for (let i = 0; i < n; i++) {
    seed = Number((BigInt(seed) * 1103515245n + 12345n) & 0x7fffffffn);
    const t = i / 16000;
    x[i] = 0.3 * Math.sin(2 * Math.PI * 220 * t) + 0.15 * Math.sin(2 * Math.PI * 1330 * t) * Math.sin(2 * Math.PI * 3 * t) + (seed / 0x7fffffff - 0.5) * 0.02;
  }
  return x;
}
const rnd = (seed) => () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 - 0.5; };
const vec = (r, base, spread) => base.map((b) => b + spread * r());

await ok('filterbank matches Kaldi', () => {
  const ref = JSON.parse(readFileSync(join(here, 'fixtures/fbank-ref.json'), 'utf8'));
  const { data, frames } = fbank(signal());
  assert.equal(frames, ref.frames);
  let worst = 0;
  for (const [k, row] of Object.entries(ref.rows)) row.forEach((v, b) => { worst = Math.max(worst, Math.abs(data[Number(k) * 80 + b] - v)); });
  assert.ok(worst < 1e-3, `largest difference ${worst}`);
});

await ok('filterbank edges: too short gives no frames; 25 ms gives one', () => {
  assert.equal(fbank(new Float32Array(399)).frames, 0);
  assert.equal(fbank(new Float32Array(400)).frames, 1);
  assert.equal(fbank(new Float32Array(16000)).frames, 98);
});

await ok('quiet edges are trimmed; length and noise are measured', () => {
  const x = new Float32Array(16000 * 3);
  x.set(signal(1), 16000);
  const t = trimSilence(x);
  assert.ok(t.length < 16000 * 1.3 && t.length >= 16000, `trimmed to ${t.length}`);
  const q = phraseCheck(x);
  assert.ok(q.seconds > 0.8 && q.seconds < 1.2, `speech ${q.seconds}s`);
  assert.ok(q.noise < 0.1);
  const noisy = signal(2).map((v, i) => v * 0.2 + Math.sin(i) * 0.25);
  assert.ok(phraseCheck(noisy).noise > 0.35, 'a steady loud background counts as noise');
});

await ok('the model file is the pinned one', () => {
  const pins = readFileSync(join(here, '../apps/app/src/voicePins.ts'), 'utf8');
  const sha = /VOICE_MODEL_SHA256 = '([0-9a-f]{64})'/.exec(pins)?.[1], bytes = Number(/VOICE_MODEL_BYTES = ([\d_]+)/.exec(pins)?.[1].replace(/_/g, ''));
  const file = readFileSync(join(here, '../apps/app/public/models/voice-check-v1.onnx'));
  assert.equal(file.length, bytes);
  assert.equal(createHash('sha256').update(file).digest('hex'), sha);
});

await ok('the model runs in the app’s runtime, gives 256 numbers, and ignores loudness', async () => {
  const ort = await import(pathToFileURL(join(here, '../node_modules/onnxruntime-web/dist/ort.node.min.mjs')).href);
  ort.env.wasm.numThreads = 1;
  const s = await ort.InferenceSession.create(readFileSync(join(here, '../apps/app/public/models/voice-check-v1.onnx')), { executionProviders: ['wasm'] });
  const emb = async (x) => { const { data, frames } = fbank(x); return Array.from((await s.run({ feats: new ort.Tensor('float32', data, [1, frames, 80]) })).embs.data); };
  const a = await emb(signal()), b = await emb(signal().map((v) => v * 0.25));
  assert.equal(a.length, 256);
  assert.ok(a.every(Number.isFinite));
  assert.ok(cosine(a, b) > 0.999, `quieter copy scored ${cosine(a, b)}`);
});

await ok('levels come from the setup phrases, within floors and ceilings', () => {
  const r = rnd(7), base = Array.from({ length: 256 }, () => r());
  const close = makePrint(Array.from({ length: 5 }, () => vec(r, base, 0.15)));
  assert.deepEqual(close.levels, CEILINGS, 'very consistent phrases: capped, so the owner isn’t made to repeat');
  const loose = makePrint(Array.from({ length: 5 }, () => vec(r, base, 2.5)));
  assert.deepEqual(loose.levels, FLOORS, 'very varied phrases: never below the floors');
  const mid = makePrint(Array.from({ length: 5 }, () => vec(r, base, 0.6)));
  assert.ok(mid.levels.relaxed < mid.levels.balanced && mid.levels.balanced < mid.levels.strict);
  assert.equal(mid.print.length, 256);
  assert.throws(() => makePrint([base, base]));
});

await ok('decisions follow the chosen strictness; strong matches need a clear margin', () => {
  const L = { relaxed: 0.45, balanced: 0.55, strict: 0.62 };
  assert.deepEqual(decide(0.5, L, 'relaxed'), { you: true, strong: false });
  assert.deepEqual(decide(0.5, L, 'balanced'), { you: false, strong: false });
  assert.deepEqual(decide(0.6, L, 'strict'), { you: false, strong: false });
  assert.equal(decide(0.7, L, 'balanced').strong, true);
  assert.equal(decide(0.67, L, 'balanced').strong, false, 'never below 0.68');
});

await ok('learning moves the voiceprint only a little, even from an unlike phrase', () => {
  const r = rnd(11), print = Array.from({ length: 256 }, () => r()), other = Array.from({ length: 256 }, () => r());
  const once = learnInto(print, 5, other);
  assert.equal(once.count, 6);
  assert.ok(cosine(once.print, print) > 0.97, `moved to ${cosine(once.print, print)}`);
  let p = print, c = 30;
  for (let i = 0; i < 3; i++) ({ print: p, count: c } = learnInto(p, c, other));
  assert.ok(cosine(p, print) > 0.98, 'a long-used print barely moves');
});

console.log(`${pass} voice match checks passed`);
