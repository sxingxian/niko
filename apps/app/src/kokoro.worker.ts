// The on-device voice (Kokoro-82M, Apache-2.0), run in a worker so speaking never blocks the page.
// The model and voices come from Hugging Face's official repository. The model is checked against a pinned
// SHA-256 before use, so a changed or tampered file is refused rather than run. The speech runtime
// (ONNX Runtime WebAssembly) is served from Niko's own site, never a third-party CDN.
import { KokoroTTS, TextSplitterStream, env } from 'kokoro-web';

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
const load = () => (tts ??= KokoroTTS.from_pretrained(MODEL_ID, { dtype: 'q8', device: 'wasm' }).catch((e) => { tts = null; throw e; }));
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
    try { await load(); post({ type: 'ready', id: m.id }); } catch (e) { post({ type: 'error', id: m.id, error: why(e) }); }
    return;
  }
  try {
    const engine = await load();
    // Text goes in through a splitter that is closed straight away: given a plain string, kokoro-js 1.2.1
    // never ends the stream and waits for more text, so nothing is ever spoken.
    const splitter = new TextSplitterStream();
    const parts = engine.stream(splitter, { voice: m.voice as any });
    splitter.push(m.text); splitter.close();
    for await (const part of parts) {
      if (cancelled.has(m.id)) break;
      const samples = part.audio.audio as Float32Array;
      post({ type: 'chunk', id: m.id, audio: samples, rate: part.audio.sampling_rate }, [samples.buffer]);
    }
    cancelled.delete(m.id);
    post({ type: 'end', id: m.id });
  } catch (e) { post({ type: 'error', id: m.id, error: why(e) }); }
};
