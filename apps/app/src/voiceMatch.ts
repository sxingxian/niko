// "Respond only to my voice", on this device: the voiceprint (256 numbers plus the levels set at setup), kept in
// IndexedDB encrypted with AES-GCM under a key made on this device that can't be read out (non-extractable), so the
// print is never sent anywhere and can't be copied off as plain numbers. Each device is set up on its own. Signing out
// deletes it. The model runs in voice.worker.ts.
import { cosine, decide, learnInto, makePrint, PRINT_SIZE, type Levels, type Strictness } from './voiceFeatures';

export interface VoiceHere { setUp: boolean; made?: number; phrases?: number; strict: Strictness; learn: boolean }
interface Stored { print: number[]; count: number; levels: Levels; strict: Strictness; learn: boolean; made: number; phrases: number }

const dbName = (account: string) => `niko-voice-${account}`;
const DBS_KEY = 'niko.voice.dbs'; // which accounts have a print here, so sign-out can delete them all
const listDbs = (): string[] => { try { return JSON.parse(localStorage.getItem(DBS_KEY) || '[]'); } catch { return []; } };
const saveDbs = (v: string[]) => { try { localStorage.setItem(DBS_KEY, JSON.stringify([...new Set(v)])); } catch { /* private mode */ } };

function open(account: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(dbName(account), 1);
    r.onupgradeneeded = () => { r.result.createObjectStore('kv'); };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
const tx = <T,>(db: IDBDatabase, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>) => new Promise<T>((resolve, reject) => {
  const t = db.transaction('kv', mode), req = fn(t.objectStore('kv'));
  t.oncomplete = () => resolve(req.result); t.onerror = () => reject(t.error); t.onabort = () => reject(t.error);
});
async function keyOf(db: IDBDatabase): Promise<CryptoKey> {
  const have = await tx<CryptoKey | undefined>(db, 'readonly', (s) => s.get('key'));
  if (have) return have;
  const k = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  await tx(db, 'readwrite', (s) => s.put(k, 'key'));
  return k;
}
const AD = new TextEncoder().encode('niko.voice.print.v1');
async function readStored(account: string): Promise<Stored | null> {
  const db = await open(account);
  try {
    const box = await tx<{ iv: Uint8Array<ArrayBuffer>; data: ArrayBuffer } | undefined>(db, 'readonly', (s) => s.get('print'));
    if (!box) return null;
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: box.iv, additionalData: AD }, await keyOf(db), box.data);
    const v = JSON.parse(new TextDecoder().decode(plain)) as Stored;
    return Array.isArray(v.print) && v.print.length === PRINT_SIZE ? v : null;
  } catch { return null; } finally { db.close(); }
}
async function writeStored(account: string, v: Stored): Promise<void> {
  const db = await open(account);
  try {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: AD }, await keyOf(db), new TextEncoder().encode(JSON.stringify(v)));
    await tx(db, 'readwrite', (s) => s.put({ iv, data }, 'print'));
    saveDbs([...listDbs(), account]);
  } finally { db.close(); }
  cached = { account, v }; changed();
}

let cached: { account: string; v: Stored | null } | null = null;
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((f) => f());
export const onVoiceChange = (f: () => void) => { listeners.add(f); return () => { listeners.delete(f); }; };
async function stored(account: string): Promise<Stored | null> {
  if (cached?.account === account) return cached.v;
  const v = await readStored(account).catch(() => null);
  cached = { account, v };
  return v;
}
export async function voiceHere(account: string): Promise<VoiceHere> {
  const v = await stored(account);
  return v ? { setUp: true, made: v.made, phrases: v.phrases, strict: v.strict, learn: v.learn } : { setUp: false, strict: 'balanced', learn: true };
}
export const voiceSupported = () => typeof Worker !== 'undefined' && typeof WebAssembly !== 'undefined' && typeof indexedDB !== 'undefined' && !!crypto?.subtle && !!navigator.mediaDevices?.getUserMedia;

// ---------------------------------------------------------------- the model
let worker: Worker | null = null, next = 1;
const waiting = new Map<number, (m: any) => void>();
function getWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL('./voice.worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (ev) => waiting.get(ev.data.id)?.(ev.data);
  return worker;
}
function call<T>(msg: Record<string, unknown>, onProgress?: (p: number) => void, transfer: Transferable[] = []): Promise<T> {
  const id = next++;
  return new Promise<T>((resolve, reject) => {
    waiting.set(id, (m) => {
      if (m.type === 'progress') { onProgress?.(m.loaded / m.total); return; }
      waiting.delete(id);
      if (m.type === 'error') reject(new Error(m.error)); else resolve(m as T);
    });
    getWorker().postMessage({ ...msg, id }, transfer);
  });
}
export const voiceErrorText = (e: unknown) => {
  const m = e instanceof Error ? e.message : '';
  return m === 'model-mismatch' ? 'The voice check that arrived didn’t match the expected file, so it wasn’t used.'
    : m === 'too-short' ? 'That was too short. Say the whole phrase.'
    : /fetch|network|unavailable|Failed/i.test(m) ? 'The voice check couldn’t be downloaded. Check your connection and try again.' : 'The voice check couldn’t start on this device.';
};
/** Downloads the model (or loads it from this device's cache). Progress 0..1. */
export const voiceLoad = (onProgress?: (p: number) => void) => call<unknown>({ type: 'load' }, onProgress).then(() => undefined);
/** A phrase's 256 numbers. */
export async function voiceEmbed(samples: Float32Array): Promise<number[]> {
  const copy = new Float32Array(samples);
  return (await call<{ embedding: number[] }>({ type: 'embed', samples: copy }, undefined, [copy.buffer])).embedding;
}

// ---------------------------------------------------------------- setup, checks and learning
/** Saves a new voiceprint from the setup phrases (replacing any earlier one), set to Balanced. Keeps the learning
 *  choice if a print was already here. */
export async function voiceSave(account: string, embeddings: number[][]): Promise<Levels> {
  const before = await stored(account);
  const { print, levels } = makePrint(embeddings);
  await writeStored(account, { print, count: embeddings.length, levels, strict: 'balanced', learn: before?.learn ?? true, made: Date.now(), phrases: embeddings.length });
  return levels;
}
/** How a phrase scores against the print made from the setup phrases (for the "Check it" step, before saving). */
export function scoreAgainst(embeddings: number[][], e: number[]): { score: number; levels: Levels } {
  const { print, levels } = makePrint(embeddings);
  return { score: cosine(print, e), levels };
}
export interface VoiceCheck { score: number; you: boolean; strong: boolean; embedding: number[] | null }
/** Checks a spoken request. Too short or unreadable counts as not a match (the "That was me" chip still offers it). */
export async function voiceCheck(account: string, samples: Float32Array): Promise<VoiceCheck> {
  const v = await stored(account);
  if (!v) return { score: 1, you: true, strong: false, embedding: null };
  let embedding: number[];
  try { embedding = await voiceEmbed(samples); } catch { return { score: 0, you: false, strong: false, embedding: null }; }
  const score = cosine(v.print, embedding);
  const d = decide(score, v.levels, v.strict);
  if (d.you && d.strong && v.learn) void voiceLearn(account, embedding);
  return { score, ...d, embedding };
}
/** "Keep learning my voice" and "That was me". Never learns from something that scores like another person. */
export async function voiceLearn(account: string, embedding: number[]): Promise<boolean> {
  const v = await stored(account);
  if (!v || !v.learn) return false;
  if (cosine(v.print, embedding) < 0.3) return false; // far too unlike: someone else, or noise
  const { print, count } = learnInto(v.print, v.count, embedding);
  await writeStored(account, { ...v, print, count });
  return true;
}
export async function voiceSetStrict(account: string, strict: Strictness) { const v = await stored(account); if (v) await writeStored(account, { ...v, strict }); }
export async function voiceSetLearn(account: string, learn: boolean) { const v = await stored(account); if (v) await writeStored(account, { ...v, learn }); }
export async function voiceDelete(account: string): Promise<void> {
  cached = { account, v: null };
  await new Promise<void>((resolve) => { const r = indexedDB.deleteDatabase(dbName(account)); r.onsuccess = r.onerror = r.onblocked = () => resolve(); });
  saveDbs(listDbs().filter((a) => a !== account));
  changed();
}
/** Signing out deletes every voiceprint kept on this device. */
export async function voiceForgetAll(): Promise<void> {
  for (const a of listDbs()) await voiceDelete(a);
  cached = null;
}
