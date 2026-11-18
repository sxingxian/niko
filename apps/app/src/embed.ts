// Main-thread side of on-device search numbers for Knowledge: downloads the model on request and asks the worker for
// numbers. It never starts the download by itself, and is only used once the model is on this device.
import { KN_DEVICE_DIMS } from '@niko/shared';
import { EMBED_PINNED } from './embedPins';

const READY_KEY = 'niko.knowledge.model';
const MODEL_TAG = 'e5-small-q8-v1';

let worker: Worker | null = null;
let next = 1;
const waiting = new Map<number, (m: any) => void>();
function getWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL('./embed.worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (ev) => waiting.get(ev.data.id)?.(ev.data);
  return worker;
}
const store = {
  get: (): string | null => { try { return localStorage.getItem(READY_KEY); } catch { return null; } },
  set: (v: string | null) => { try { if (v) localStorage.setItem(READY_KEY, v); else localStorage.removeItem(READY_KEY); } catch { /* private mode */ } },
};
/** The browser can run it, and the model's fingerprints are pinned in this build. */
export const embedSupported = () => EMBED_PINNED && typeof Worker !== 'undefined' && typeof WebAssembly !== 'undefined' && typeof caches !== 'undefined';
export const embedReady = () => embedSupported() && store.get() === MODEL_TAG;

const plain = (e: string) => (e === 'model-mismatch' ? 'The search model that arrived didn’t match the expected file, so it wasn’t used.'
  : e === 'not-pinned' ? 'Search on this device isn’t available yet.'
  : /fetch|network|Failed/i.test(e) ? 'The search model couldn’t be downloaded. Check your connection and try again.' : 'The search model couldn’t start on this device.');

/** Downloads the model (or loads it from this device's cache). Reports progress as 0..1. */
export function embedDownload(onProgress?: (p: number) => void): Promise<void> {
  const id = next++;
  const seen = new Map<string, { loaded: number; total: number }>();
  return new Promise<void>((resolve, reject) => {
    waiting.set(id, (m) => {
      if (m.type === 'progress') {
        seen.set(m.file, { loaded: m.loaded, total: m.total });
        const all = [...seen.values()].reduce((a, x) => ({ loaded: a.loaded + x.loaded, total: a.total + x.total }), { loaded: 0, total: 0 });
        if (all.total) onProgress?.(Math.min(1, all.loaded / all.total));
      } else if (m.type === 'ready') { waiting.delete(id); store.set(MODEL_TAG); resolve(); }
      else if (m.type === 'error') { waiting.delete(id); reject(new Error(plain(m.error))); }
    });
    getWorker().postMessage({ type: 'load', id });
  });
}

/** Removes the model from this device. Files keep their numbers; searching goes back to words until it's back. */
export async function embedRemove(): Promise<void> {
  worker?.terminate(); worker = null; waiting.clear();
  store.set(null);
  await caches.delete('niko-knowledge-model').catch(() => false);
}

/** Search numbers for texts. e5 is told which side each text is on: a question ("query") or a piece of a file
 *  ("passage"). Resolves to null when the model isn't on this device, so callers search by words instead. */
export async function embedTexts(texts: string[], side: 'query' | 'passage'): Promise<number[][] | null> {
  if (!embedReady() || !texts.length) return texts.length ? null : [];
  const id = next++;
  return new Promise((resolve) => {
    waiting.set(id, (m) => {
      if (m.type === 'done') {
        waiting.delete(id);
        const ok = Array.isArray(m.vectors) && m.vectors.length === texts.length && m.vectors.every((v: number[]) => v.length === KN_DEVICE_DIMS);
        resolve(ok ? m.vectors : null);
      } else if (m.type === 'error') { waiting.delete(id); resolve(null); }
    });
    getWorker().postMessage({ type: 'embed', id, texts: texts.map((t) => `${side}: ${t}`) });
  });
}
