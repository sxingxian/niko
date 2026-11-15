// The on-device voice (Kokoro-82M, Apache-2.0), run in a worker so speaking never blocks the page.
// The model and voices come from Hugging Face's official repository. The model is checked against a pinned
// SHA-256 before use, so a changed or tampered file is refused rather than run. The speech runtime
// (ONNX Runtime WebAssembly) is served from Niko's own site, never a third-party CDN.
import { KokoroTTS, env } from 'kokoro-web';

const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const MODEL_FILE = /\/onnx\/model_quantized\.onnx(\?|$)/;
const MODEL_SHA256 = 'fbae9257e1e05ffc727e951ef9b9c98418e6d79f1c9b6b13bd59f5c9028a1478';
const MODEL_BYTES = 92_361_116;
const VOICE_FILE = /\/voices\/([a-z]{2}_[a-z]+)\.bin(\?|$)/;
const VOICE_BYTES = 522_240; // 510 × 256 float32: anything else is not a Kokoro voice
const VOICE_CACHE = 'niko-kokoro-voices';

env.wasmPaths = `${import.meta.env.BASE_URL}ort/`;

type In = { type: 'load'; id: number } | { type: 'speak'; id: number; text: string; voice: string } | { type: 'cancel'; id: number };
const post = (m: unknown, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(m, transfer);
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');

// Every request the library makes passes through here: the model is streamed with progress and verified,
// voices are size-checked and kept for offline use.
const realFetch = self.fetch.bind(self);
let loadingId = 0;
self.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const voice = VOICE_FILE.exec(url);
  if (voice) {
    const cache = await caches.open(VOICE_CACHE).catch(() => null);
    const hit = await cache?.match(url);
    if (hit) return hit;
    const res = await realFetch(input, init);
    if (!res.ok) return res;
    const buf = await res.arrayBuffer();
    if (buf.byteLength !== VOICE_BYTES) throw new Error('voice-mismatch');
    const out = new Response(buf, { headers: { 'content-type': 'application/octet-stream' } });
    await cache?.put(url, out.clone()).catch(() => undefined);
    return out;
  }
  const res = await realFetch(input, init);
  if (!MODEL_FILE.test(url) || !res.ok || !res.body) return res;
  const total = Number(res.headers.get('content-length')) || MODEL_BYTES;
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value); loaded += value.length;
    post({ type: 'progress', id: loadingId, loaded, total });
  }
  const buf = new Uint8Array(loaded);
  let at = 0;
  for (const p of parts) { buf.set(p, at); at += p.length; }
  if (hex(await crypto.subtle.digest('SHA-256', buf)) !== MODEL_SHA256) throw new Error('model-mismatch');
  return new Response(buf, { status: 200, headers: { 'content-type': 'application/octet-stream', 'content-length': String(loaded) } });
};

let tts: Promise<KokoroTTS> | null = null;
// Loading also runs two short warm-up lines. The first run after loading is much slower than the rest, so the
// first is thrown away; the second's timing says whether this device speaks faster than real time (rtf below 1).
let rtf: number | null = null;
const load = () => (tts ??= (async () => {
  const t = await KokoroTTS.from_pretrained(MODEL_ID, { dtype: 'q8', device: 'wasm' });
  await t.generate('Hi.', { voice: 'af_heart' as any });
  const t0 = performance.now();
  const a = await t.generate('Hello there, how are you?', { voice: 'af_heart' as any });
  rtf = (performance.now() - t0) / 1000 / Math.max(0.2, a.audio.length / a.sampling_rate);
  return t;
})().catch((e) => { tts = null; throw e; }));

/** Splits text into short phrases: sentences, long ones at commas, and a short first phrase so sound starts sooner. */
export function phrases(text: string): string[] {
  const out: string[] = [];
  const sentences = text.replace(/\s+/g, ' ').trim().split(/(?<=[.!?…])\s+(?=\S)/);
  for (const sen of sentences) {
    let rest = sen;
    while (rest.length > 140) {
      const cut = Math.max(rest.lastIndexOf(', ', 140), rest.lastIndexOf('; ', 140), rest.lastIndexOf(' – ', 140), rest.lastIndexOf(' — ', 140));
      const at = cut > 40 ? cut + 1 : (rest.lastIndexOf(' ', 140) > 40 ? rest.lastIndexOf(' ', 140) : 140);
      out.push(rest.slice(0, at).trim()); rest = rest.slice(at).trim();
    }
    if (rest) out.push(rest);
  }
  // The first phrase decides how long it takes to hear anything, so keep it to a few words when it is long.
  if (out[0] && out[0].length > 70) {
    const f = out[0];
    const comma = f.indexOf(', ', 20);
    const at = comma > 0 && comma < 70 ? comma + 1 : f.lastIndexOf(' ', 55) > 20 ? f.lastIndexOf(' ', 55) : 0;
    if (at) out.splice(0, 1, f.slice(0, at).trim(), f.slice(at).trim());
  }
  return out.filter(Boolean);
}

const cancelled = new Set<number>();
const why = (e: unknown) => {
  const m = String((e as Error)?.message ?? e);
  if (m === 'model-mismatch') return 'The downloaded voice model did not match its expected fingerprint, so it was not used.';
  if (m === 'voice-mismatch') return 'A downloaded voice file was not in the expected format, so it was not used.';
  if (/fetch|network|Failed to fetch/i.test(m)) return 'The on-device voice could not be downloaded. Check the connection and try again.';
  return 'The on-device voice could not start on this device.';
};

self.onmessage = async (ev: MessageEvent<In>) => {
  const m = ev.data;
  if (m.type === 'cancel') { cancelled.add(m.id); return; }
  if (m.type === 'load') {
    loadingId = m.id;
    try { await load(); post({ type: 'ready', id: m.id, rtf, threads: (globalThis as any).crossOriginIsolated ? Math.min(4, Math.ceil((navigator.hardwareConcurrency || 2) / 2)) : 1 }); }
    catch (e) { post({ type: 'error', id: m.id, error: why(e) }); }
    return;
  }
  try {
    const engine = await load();
    // Phrase by phrase: each is played as soon as it is made, while the next one is being made.
    for (const text of phrases(m.text)) {
      if (cancelled.has(m.id)) break;
      const t0 = performance.now();
      const a = await engine.generate(text, { voice: m.voice as any });
      if (cancelled.has(m.id)) break;
      const samples = a.audio as Float32Array;
      post({ type: 'chunk', id: m.id, audio: samples, rate: a.sampling_rate, took: (performance.now() - t0) / 1000 }, [samples.buffer]);
    }
    cancelled.delete(m.id);
    post({ type: 'end', id: m.id });
  } catch (e) { post({ type: 'error', id: m.id, error: why(e) }); }
};
