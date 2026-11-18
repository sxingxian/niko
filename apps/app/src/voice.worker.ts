// "Respond only to my voice": turns a phrase into a voiceprint's 256 numbers, in a worker so the page never stalls.
// The model comes from Niko's own site, is checked against its pinned SHA-256 and size before use, and is kept in this
// site's cache ("niko-voice-check"). Audio arrives as 16 kHz samples and never leaves the device.
import * as ort from 'onnxruntime-web';
import { fbank } from './voiceFeatures';
import { VOICE_MODEL_BYTES, VOICE_MODEL_SHA256, VOICE_MODEL_URL } from './voicePins';

ort.env.wasm.wasmPaths = `${import.meta.env.BASE_URL}ort/`;
ort.env.wasm.numThreads = 1;
const CACHE = 'niko-voice-check';
type In = { type: 'load'; id: number } | { type: 'embed'; id: number; samples: Float32Array };
const post = (m: unknown) => (self as unknown as Worker).postMessage(m);
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');

async function modelBytes(id: number): Promise<Uint8Array<ArrayBuffer>> {
  const cache = await caches.open(CACHE).catch(() => null);
  const check = async (buf: Uint8Array<ArrayBuffer>) => buf.length === VOICE_MODEL_BYTES && hex(await crypto.subtle.digest('SHA-256', buf)) === VOICE_MODEL_SHA256;
  const kept = await cache?.match(VOICE_MODEL_URL);
  if (kept) {
    const buf = new Uint8Array(await kept.arrayBuffer());
    if (await check(buf)) return buf;
    await cache?.delete(VOICE_MODEL_URL);
  }
  const res = await fetch(VOICE_MODEL_URL, { credentials: 'omit', cache: 'no-cache' });
  if (!res.ok || !res.body) throw new Error('model-unavailable');
  const reader = res.body.getReader();
  const buf = new Uint8Array(VOICE_MODEL_BYTES);
  let at = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (at + value.length > VOICE_MODEL_BYTES) throw new Error('model-mismatch');
    buf.set(value, at); at += value.length;
    post({ type: 'progress', id, loaded: at, total: VOICE_MODEL_BYTES });
  }
  if (!(await check(buf))) throw new Error('model-mismatch');
  await cache?.put(VOICE_MODEL_URL, new Response(buf, { headers: { 'content-type': 'application/octet-stream' } })).catch(() => undefined);
  return buf;
}
let session: Promise<ort.InferenceSession> | null = null;
const load = (id: number) => (session ??= modelBytes(id).then((b) => ort.InferenceSession.create(b, { executionProviders: ['wasm'] })).catch((e) => { session = null; throw e; }));

self.onmessage = async (ev: MessageEvent<In>) => {
  const m = ev.data;
  try {
    if (m.type === 'load') { await load(m.id); post({ type: 'done', id: m.id }); return; }
    const s = await load(m.id);
    const { data, frames } = fbank(m.samples);
    if (frames < 40) throw new Error('too-short');
    const out = await s.run({ feats: new ort.Tensor('float32', data, [1, frames, 80]) });
    post({ type: 'done', id: m.id, embedding: Array.from(out.embs!.data as Float32Array) });
  } catch (e) {
    post({ type: 'error', id: m.id, error: e instanceof Error ? e.message : 'failed' });
  }
};
