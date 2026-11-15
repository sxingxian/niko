// Main-thread side of the on-device voice: downloads it on request, and plays what the worker makes.
// It is only used once downloaded on this device; it never starts a large download by itself.
const READY_KEY = 'niko.kokoro.ready';
const MODEL_TAG = 'kokoro-82m-q8-fbae9257';
/** About 92 MB of model, 22 MB of speech runtime and half a megabyte per voice. */
export const KOKORO_DOWNLOAD_MB = 115;

let worker: Worker | null = null;
let next = 1;
const waiting = new Map<number, (m: any) => void>();
function getWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL('./kokoro.worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (ev) => waiting.get(ev.data.id)?.(ev.data);
  return worker;
}

const store = {
  get: (): string | null => { try { return localStorage.getItem(READY_KEY); } catch { return null; } },
  set: (v: string | null) => { try { if (v) localStorage.setItem(READY_KEY, v); else localStorage.removeItem(READY_KEY); } catch { /* private mode */ } },
};
export const kokoroSupported = () => typeof Worker !== 'undefined' && typeof WebAssembly !== 'undefined' && typeof caches !== 'undefined' && typeof AudioContext !== 'undefined';
export const kokoroReady = () => kokoroSupported() && store.get() === MODEL_TAG;

// Starting the speech engine takes a while (seconds on a laptop, longer on a phone), every time the app opens.
let loaded = false;
let loading: Promise<void> | null = null;
/** True once the engine is running in this tab, so speaking starts at once. */
export const kokoroLoaded = () => loaded;

/** Downloads (or loads from this device's cache) the voice. Reports progress as 0..1 while the model downloads. */
export function kokoroDownload(onProgress?: (p: number) => void): Promise<void> {
  const id = next++;
  const p = new Promise<void>((resolve, reject) => {
    waiting.set(id, (m) => {
      if (m.type === 'progress') onProgress?.(Math.min(1, m.loaded / m.total));
      else if (m.type === 'ready') { waiting.delete(id); loaded = true; store.set(MODEL_TAG); resolve(); }
      else if (m.type === 'error') { waiting.delete(id); reject(new Error(m.error)); }
    });
    getWorker().postMessage({ type: 'load', id });
  });
  loading = p.catch(() => undefined).finally(() => { loading = null; }); // the caller handles the failure
  return p;
}

/** Starts the engine in the background when the voice is downloaded here, so it is ready before Niko next speaks. */
export function kokoroWarm(): void {
  if (loaded || loading || !kokoroReady()) return;
  const go = () => { if (!loaded && !loading) kokoroDownload().catch(() => undefined); };
  const idle = (window as any).requestIdleCallback as ((cb: () => void, o?: { timeout: number }) => void) | undefined;
  if (idle) idle(go, { timeout: 4000 }); else window.setTimeout(go, 1500);
}

/** Removes the downloaded voice from this device. */
export async function kokoroRemove(): Promise<void> {
  worker?.terminate(); worker = null; waiting.clear(); loaded = false; loading = null;
  store.set(null);
  await Promise.all(['transformers-cache', 'niko-kokoro-voices'].map((n) => caches.delete(n).catch(() => false)));
}

let ctx: AudioContext | null = null;
export interface Speech { started: Promise<void>; done: Promise<void>; stop: () => void }

/** Speaks `text`. `started` settles when the first sound plays (or fails before any sound); `done` when it finishes. */
export function kokoroSpeak(text: string, voice: string): Speech {
  const id = next++;
  const sources: AudioBufferSourceNode[] = [];
  let stopped = false, ended = false, playing = 0, startedOk = false;
  let resolveStart!: () => void, rejectStart!: (e: Error) => void, resolveDone!: () => void;
  const started = new Promise<void>((a, b) => { resolveStart = a; rejectStart = b; });
  const done = new Promise<void>((a) => { resolveDone = a; });
  const finish = () => { waiting.delete(id); resolveDone(); };
  const stop = () => {
    if (stopped) return;
    stopped = true;
    worker?.postMessage({ type: 'cancel', id });
    for (const s of sources) { try { s.stop(); } catch { /* already ended */ } }
    if (!startedOk) rejectStart(new Error('stopped'));
    finish();
  };
  (async () => {
    try {
      ctx ??= new AudioContext();
      if (ctx.state === 'suspended') await ctx.resume();
    } catch { return rejectStart(new Error('This browser blocked sound until you tap the page.')); }
    let at = ctx.currentTime + 0.05;
    waiting.set(id, (m) => {
      if (stopped) return;
      if (m.type === 'chunk') {
        const buf = ctx!.createBuffer(1, m.audio.length, m.rate);
        buf.copyToChannel(m.audio, 0);
        const src = ctx!.createBufferSource();
        src.buffer = buf; src.connect(ctx!.destination);
        at = Math.max(at, ctx!.currentTime + 0.02);
        src.start(at); at += buf.duration;
        sources.push(src); playing++;
        src.onended = () => { playing--; if (ended && playing === 0) finish(); };
        if (!startedOk) { startedOk = true; resolveStart(); }
      } else if (m.type === 'end') {
        ended = true;
        if (!startedOk) { rejectStart(new Error('The on-device voice made no sound.')); finish(); }
        else if (playing === 0) finish();
      } else if (m.type === 'error') {
        if (!startedOk) rejectStart(new Error(m.error));
        finish();
      }
    });
    getWorker().postMessage({ type: 'speak', id, text, voice });
  })();
  return { started, done, stop };
}
