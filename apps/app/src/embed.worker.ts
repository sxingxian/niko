// On-device search numbers for Knowledge (multilingual-e5-small, MIT, 384 numbers per text), run in a worker so the
// page never stalls. The model comes from Hugging Face's repository and is checked against a pinned SHA-256 before use,
// like the on-device voice; the tokenizer is pinned too, and the small settings files are size-limited and must be
// JSON. The runtime (ONNX Runtime WebAssembly) is served from Niko's own site. Files are kept in this site's own cache
// ("niko-knowledge-model"), apart from the voice's.
import { env, pipeline, type FeatureExtractionPipeline } from '@huggingface/transformers';
import { EMBED_MODEL_ID, EMBED_PINNED, embedFileFor, hexOf } from './embedPins';

env.allowLocalModels = false;
env.useBrowserCache = false;
env.useCustomCache = true;
const CACHE = 'niko-knowledge-model';
env.customCache = {
  match: async (key: string) => (await caches.open(CACHE)).match(key),
  put: async (key: string, res: Response) => { await (await caches.open(CACHE)).put(key, res); },
};
if (env.backends.onnx.wasm) env.backends.onnx.wasm.wasmPaths = `${import.meta.env.BASE_URL}ort/`;

type In = { type: 'load'; id: number } | { type: 'embed'; id: number; texts: string[] };
const post = (m: unknown) => (self as unknown as Worker).postMessage(m);

// Every request the library makes passes through here. Only the repository's known files are fetched; each is checked.
const realFetch = self.fetch.bind(self);
let loadingId = 0;
self.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const pin = embedFileFor(url);
  if (!pin) throw new Error('unexpected-file');
  const res = await realFetch(input, { ...init, credentials: 'omit', redirect: 'follow' });
  if (!res.ok || !res.body) return res;
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value); loaded += value.length;
    if (loaded > pin.bytes) throw new Error('model-mismatch');
    if (pin.sha256) post({ type: 'progress', id: loadingId, file: pin.name, loaded, total: pin.bytes });
  }
  const buf = new Uint8Array(loaded);
  let at = 0;
  for (const p of parts) { buf.set(p, at); at += p.length; }
  if (pin.sha256) {
    if (loaded !== pin.bytes || hexOf(await crypto.subtle.digest('SHA-256', buf)) !== pin.sha256) throw new Error('model-mismatch');
  } else {
    try { JSON.parse(new TextDecoder().decode(buf)); } catch { throw new Error('model-mismatch'); }
  }
  return new Response(buf, { status: 200, headers: { 'content-type': 'application/octet-stream', 'content-length': String(loaded) } });
};

let model: Promise<FeatureExtractionPipeline> | null = null;
// (Typed loosely: the library's overloads are too many for TypeScript to resolve here.)
const make = pipeline as unknown as (task: 'feature-extraction', id: string, o: { dtype: 'q8'; device: 'wasm' }) => Promise<FeatureExtractionPipeline>;
const load = () => (model ??= make('feature-extraction', EMBED_MODEL_ID, { dtype: 'q8', device: 'wasm' }).catch((e) => { model = null; throw e; }));

self.onmessage = async (ev: MessageEvent<In>) => {
  const m = ev.data;
  try {
    if (m.type === 'load') {
      if (!EMBED_PINNED) throw new Error('not-pinned');
      loadingId = m.id;
      await load();
      post({ type: 'ready', id: m.id });
    } else if (m.type === 'embed') {
      const ex = await load();
      const out: number[][] = [];
      // A few at a time keeps memory low on phones.
      for (let i = 0; i < m.texts.length; i += 8) {
        const t = await ex(m.texts.slice(i, i + 8), { pooling: 'mean', normalize: true });
        const dims = t.dims[1]!;
        const data = t.data as Float32Array;
        for (let j = 0; j < t.dims[0]!; j++) out.push(Array.from(data.subarray(j * dims, (j + 1) * dims), (x) => Math.round(x * 1e5) / 1e5));
      }
      post({ type: 'done', id: m.id, vectors: out });
    }
  } catch (e) {
    post({ type: 'error', id: m.id, error: String((e as Error)?.message ?? e) });
  }
};
