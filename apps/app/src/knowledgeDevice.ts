// Knowledge kept on "This device": files are read, kept and searched in this browser. Only the few pieces that may
// answer a question go with it to Niko, as untrusted text. Each account has its own IndexedDB database, and everything
// in it (names, text, rows, search numbers) is locked with AES-GCM using a key the server makes for that account, so
// on a shared computer another person can't read it, and nothing can be read while signed out. Clearing this site's
// data deletes it all.
import { api } from '@niko/ui';
import {
  KN_LEARNED_MAX, KN_MEANS_CHARS, KN_PIECES_PER_CALL, KN_SAID_CHARS, KN_SHEET_ROWS_PER_CALL, KN_TAUGHT_MAX, KN_TAUGHT_WORDS, knHowName, looksSecret, lookupRows, wordsAlike,
  type KnColType, type KnColumn, type KnDeviceKnowledge, type KnHow, type KnLearnedItem, type KnLearnedKind, type KnowledgeLimits, type KnTableAsk, type KnTarget,
} from '@niko/shared';
import { prepare, sha256Hex, type Piece } from './knowledge';
import { embedReady, embedTexts } from './embed';
import { LocalIndex } from './knowledgeLocal';

export interface DeviceFile {
  id: string; name: string; kind: string; collection: string; bytes: number; status: 'ready'; error: null; pieces: number; flagged: boolean;
  sheets: number; rows: number; columns: number; numbers: { cloudflare: number; device: number }; addedAt: string; sha256: string;
}
interface StoredPiece { heading: string | null; body: string; vector: number[] | null }
interface StoredSheet { name: string; columns: KnColumn[]; header: boolean; rows: string[][] }
export interface DeviceSheet { id: string; name: string; columns: KnColumn[]; rows: number; header: boolean; example: string[] }
type Rec = { id: string; fileId?: string; ord?: number; iv: Uint8Array<ArrayBuffer>; data: ArrayBuffer };

// ---------------------------------------------------------------- the lock
let keyed: { account: string; key: Promise<CryptoKey> } | null = null;
function keyFor(account: string): Promise<CryptoKey> {
  if (keyed?.account === account) return keyed.key;
  const key = api<{ key: string }>('/knowledge/device-key').then(({ key: hex }) => {
    if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error('This device’s Knowledge couldn’t be unlocked.');
    const raw = new Uint8Array(hex.match(/../g)!.map((h) => parseInt(h, 16)));
    return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
  });
  key.catch(() => { if (keyed?.key === key) keyed = null; });
  keyed = { account, key };
  return key;
}
const enc = new TextEncoder(), dec = new TextDecoder();
async function lock(account: string, aad: string, value: unknown): Promise<{ iv: Uint8Array<ArrayBuffer>; data: ArrayBuffer }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(aad) }, await keyFor(account), enc.encode(JSON.stringify(value)));
  return { iv, data };
}
async function unlock<T>(account: string, aad: string, r: { iv: Uint8Array<ArrayBuffer>; data: ArrayBuffer }): Promise<T> {
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: r.iv, additionalData: enc.encode(aad) }, await keyFor(account), r.data);
  return JSON.parse(dec.decode(pt)) as T;
}
/** Forgets the key and everything unlocked, e.g. when the person signs out. The locked files stay on the device. */
export function forgetDeviceKnowledge() { keyed = null; cache = null; }

// ---------------------------------------------------------------- the database
const STORES = ['files', 'pieces', 'sheets'] as const;
type StoreName = typeof STORES[number] | 'learned';
const dbName = (account: string) => `niko-knowledge-${account.replace(/[^A-Za-z0-9-]/g, '')}`;
const dbs = new Map<string, Promise<IDBDatabase>>();
function db(account: string): Promise<IDBDatabase> {
  let p = dbs.get(account);
  if (!p) {
    p = new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open(dbName(account), 2);
      r.onupgradeneeded = (ev) => {
        const d = r.result;
        if (ev.oldVersion < 1) {
          d.createObjectStore('files', { keyPath: 'id' });
          d.createObjectStore('pieces', { keyPath: ['fileId', 'ord'] }).createIndex('fileId', 'fileId');
          d.createObjectStore('sheets', { keyPath: 'id' }).createIndex('fileId', 'fileId');
        }
        // Version 2: what Niko learned, kept here for people whose Knowledge is on this device.
        if (ev.oldVersion < 2) d.createObjectStore('learned', { keyPath: 'id' });
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(new Error('This browser won’t keep files here (private browsing, or storage is full).'));
    });
    p.catch(() => dbs.delete(account));
    dbs.set(account, p);
  }
  return p;
}
const done = (t: IDBTransaction) => new Promise<void>((resolve, reject) => { t.oncomplete = () => resolve(); t.onerror = t.onabort = () => reject(t.error ?? new Error('This device couldn’t save that. It may be out of space.')); });
const req = <T>(r: IDBRequest<T>) => new Promise<T>((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
async function all(account: string, store: StoreName, fileId?: string): Promise<Rec[]> {
  const t = (await db(account)).transaction(store, 'readonly').objectStore(store);
  return req(fileId && store !== 'files' ? t.index('fileId').getAll(fileId) : t.getAll()) as Promise<Rec[]>;
}
async function put(account: string, store: StoreName, recs: Rec[]): Promise<void> {
  const t = (await db(account)).transaction(store, 'readwrite');
  for (const r of recs) t.objectStore(store).put(r);
  await done(t);
}
async function dropFile(account: string, id: string): Promise<void> {
  const d = await db(account);
  const t = d.transaction(STORES as unknown as string[], 'readwrite');
  t.objectStore('files').delete(id);
  for (const s of ['pieces', 'sheets'] as const) {
    const idx = t.objectStore(s).index('fileId');
    const r = idx.openKeyCursor(IDBKeyRange.only(id));
    r.onsuccess = () => { const c = r.result; if (c) { t.objectStore(s).delete(c.primaryKey); c.continue(); } };
  }
  await done(t);
}

// ---------------------------------------------------------------- what's kept, unlocked in memory while the app is open
interface Loaded { account: string; files: DeviceFile[]; pieces: Map<string, StoredPiece & { fileId: string }>; sheets: Map<string, StoredSheet & { fileId: string }>; index: LocalIndex; vectors: boolean }
let cache: Loaded | null = null;
let loading: Promise<Loaded> | null = null;
const pieceAad = (fileId: string, ord: number) => `piece:${fileId}:${ord}`;
async function load(account: string): Promise<Loaded> {
  if (cache?.account === account) return cache;
  if (loading) return loading;
  loading = (async () => {
    const files = await Promise.all((await all(account, 'files')).map((r) => unlock<DeviceFile>(account, `file:${r.id}`, r)));
    const pieces = new Map<string, StoredPiece & { fileId: string }>();
    for (const r of await all(account, 'pieces')) pieces.set(`${r.fileId}:${r.ord}`, { fileId: r.fileId!, ...(await unlock<StoredPiece>(account, pieceAad(r.fileId!, r.ord!), r)) });
    const sheets = new Map<string, StoredSheet & { fileId: string }>();
    for (const r of await all(account, 'sheets')) sheets.set(r.id, { fileId: r.fileId!, ...(await unlock<StoredSheet>(account, `sheet:${r.fileId}:${r.id}`, r)) });
    const index = new LocalIndex([...pieces.entries()].map(([id, p]) => ({ id, text: p.heading ? `${p.heading}\n${p.body}` : p.body, vector: p.vector })));
    return (cache = { account, files: files.sort((a, b) => b.addedAt.localeCompare(a.addedAt)), pieces, sheets, index, vectors: [...pieces.values()].some((p) => p.vector) });
  })().finally(() => { loading = null; });
  return loading;
}
const changed = () => { cache = null; };

// ---------------------------------------------------------------- files
export async function deviceFiles(account: string): Promise<DeviceFile[]> { return (await load(account)).files; }
export async function deviceUsage(account: string): Promise<{ files: number; bytes: number }> {
  const f = await deviceFiles(account);
  return { files: f.length, bytes: f.reduce((a, x) => a + x.bytes, 0) };
}

interface Incoming { name: string; kind: string; bytes: number; sha256: string; collection: string; flagged: boolean; pieces: Piece[]; vectors: (number[] | null)[]; sheets: StoredSheet[] }
async function keep(account: string, x: Incoming): Promise<DeviceFile> {
  const id = crypto.randomUUID();
  const meta: DeviceFile = {
    id, name: x.name.slice(0, 200), kind: x.kind, collection: x.collection.slice(0, 80) || 'General', bytes: x.bytes, status: 'ready', error: null,
    pieces: x.pieces.length, flagged: x.flagged, sheets: x.sheets.length, rows: x.sheets.reduce((a, s) => a + s.rows.length, 0),
    columns: x.sheets.reduce((a, s) => Math.max(a, s.columns.length), 0), numbers: { cloudflare: 0, device: x.vectors.filter(Boolean).length }, addedAt: new Date().toISOString(), sha256: x.sha256,
  };
  const pieces: Rec[] = [];
  for (let i = 0; i < x.pieces.length; i++) pieces.push({ id: '', fileId: id, ord: i, ...(await lock(account, pieceAad(id, i), { ...x.pieces[i], vector: x.vectors[i] ?? null })) });
  const sheets: Rec[] = [];
  for (const s of x.sheets) { const sid = crypto.randomUUID(); sheets.push({ id: sid, fileId: id, ...(await lock(account, `sheet:${id}:${sid}`, s)) }); }
  // The file's own record goes last, so a file only shows once all of it is kept.
  await put(account, 'pieces', pieces.map(({ id: _, ...r }) => r as Rec));
  await put(account, 'sheets', sheets);
  await put(account, 'files', [{ id, ...(await lock(account, `file:${id}`, meta)) }]);
  changed();
  return meta;
}
async function numbersFor(pieces: Piece[], onStep?: (done: number, total: number) => void): Promise<(number[] | null)[]> {
  if (!embedReady() || !pieces.length) return pieces.map(() => null);
  const out: (number[] | null)[] = [];
  for (let i = 0; i < pieces.length; i += 32) {
    onStep?.(i, pieces.length);
    const v = await embedTexts(pieces.slice(i, i + 32).map((p) => (p.heading ? `${p.heading}\n${p.body}` : p.body)), 'passage');
    out.push(...(v ?? pieces.slice(i, i + 32).map(() => null)));
  }
  return out;
}

/** Adds one file here: read in this browser only (nothing is sent to Cloudflare), split, given search numbers when
 *  the search model is on this device, and kept locked. */
export async function addFileHere(account: string, file: File, collection: string, opts: { limits: KnowledgeLimits; onStep?: (step: string, done: number, total: number) => void }): Promise<DeviceFile> {
  const have = await deviceFiles(account);
  if (have.length >= opts.limits.files) throw new Error(`You can keep up to ${opts.limits.files.toLocaleString()} files.`);
  opts.onStep?.('Reading', 0, 1);
  const prepared = await prepare(file, false);
  const sha256 = await sha256Hex(await file.arrayBuffer());
  if (have.some((f) => f.sha256 === sha256)) throw new Error('That file is already in your Knowledge.');
  const vectors = await numbersFor(prepared.pieces, (d, t) => opts.onStep?.('Making search numbers', d, t));
  opts.onStep?.('Keeping it here', 1, 1);
  return keep(account, { name: file.name, kind: prepared.kind, bytes: file.size, sha256, collection, flagged: prepared.flagged, pieces: prepared.pieces, vectors, sheets: prepared.sheets });
}
export async function removeHere(account: string, id: string): Promise<void> {
  await dropFile(account, id);
  await dropNotes(account, (await storedNotes(account)).filter((n) => n.kind === 'file-match' && n.target?.fileId === id).map((n) => n.id)).catch(() => undefined);
  changed();
}
async function rewriteMeta(account: string, id: string, change: (f: DeviceFile) => DeviceFile): Promise<void> {
  const f = (await deviceFiles(account)).find((x) => x.id === id);
  if (!f) throw new Error('No such file.');
  await put(account, 'files', [{ id, ...(await lock(account, `file:${id}`, change(f))) }]);
  changed();
}
export const keepHereAsData = (account: string, id: string) => rewriteMeta(account, id, (f) => ({ ...f, flagged: false }));
/** Forgets everything kept on this device for this account. */
export async function clearHere(account: string): Promise<void> {
  const d = dbs.get(account); dbs.delete(account);
  if (d) (await d.catch(() => null))?.close();
  await new Promise<void>((resolve) => { const r = indexedDB.deleteDatabase(dbName(account)); r.onsuccess = r.onerror = r.onblocked = () => resolve(); });
  changed();
}

// ---------------------------------------------------------------- sheets ("Check columns")
export async function sheetsHere(account: string, fileId: string): Promise<DeviceSheet[]> {
  const L = await load(account);
  return [...L.sheets.entries()].filter(([, s]) => s.fileId === fileId).map(([id, s]) => ({ id, name: s.name, columns: s.columns, rows: s.rows.length, header: s.header, example: s.rows[0] ?? [] }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
const uniqueNames = (names: string[]) => {
  const seen = new Set<string>();
  return names.map((n0, i) => {
    let n = n0.trim().slice(0, 120) || `Column ${i + 1}`;
    for (let k = 2; seen.has(n.toLowerCase()); k++) n = `${n0.trim().slice(0, 110) || 'Column'} (${k})`;
    seen.add(n.toLowerCase());
    return n;
  });
};
/** Same as the server: turning the header on makes the first row the names; off puts the names back as a row. */
export async function updateSheetHere(account: string, fileId: string, sheetId: string, b: { columns: KnColumn[]; header: boolean }): Promise<DeviceSheet> {
  const L = await load(account);
  const s = L.sheets.get(sheetId);
  if (!s || s.fileId !== fileId) throw new Error('No such sheet.');
  if (b.columns.length !== s.columns.length) throw new Error('Keep the same number of columns.');
  const types = b.columns.map((c) => (['text', 'number', 'date', 'yesno'].includes(c.type) ? c.type : 'text') as KnColType);
  let names = uniqueNames(b.columns.map((c) => c.name));
  let rows = s.rows;
  if (b.header && !s.header && rows.length) { names = uniqueNames(rows[0]!.map(String)); rows = rows.slice(1); }
  else if (!b.header && s.header) { rows = [names, ...rows]; names = names.map((_, i) => `Column ${i + 1}`); }
  const next: StoredSheet = { name: s.name, columns: names.map((name, i) => ({ name, type: types[i]! })), header: b.header, rows };
  await put(account, 'sheets', [{ id: sheetId, fileId, ...(await lock(account, `sheet:${fileId}:${sheetId}`, next)) }]);
  changed();
  return (await sheetsHere(account, fileId)).find((x) => x.id === sheetId)!;
}

// ---------------------------------------------------------------- answering
/** Searches this device's files for a question and returns what may go with it to Niko, or null with no files here. */
/** Searches this device's files (and what Niko learned here) for a question and returns what may go with it to
 *  Niko, or null when nothing is kept here. `pin` is a piece the person just said is the one. */
export async function searchHere(account: string, text: string, opts: { pin?: KnTarget | null; files?: boolean } = {}): Promise<KnDeviceKnowledge | null> {
  const notes = await notesHere(account).catch(() => [] as KnLearnedItem[]);
  const L = opts.files === false ? null : await load(account);
  const useful = notes.filter((n) => n.kind !== 'file-match' && (text.toLowerCase().includes(n.said.toLowerCase()) || wordsAlike(`${n.said} ${n.means}`, text) >= 0.2)).slice(0, 8);
  if (useful.length) void touchNotes(account, useful.map((n) => n.id));
  const learned = useful.map((n) => ({ kind: n.kind, said: n.said, means: n.means, level: n.level, how: n.how }));
  if (!L?.files.length) return learned.length ? { hits: [], tables: [], numbers: false, learned } : null;
  // What the person taught for questions like this: the piece to use, and pieces not to offer.
  const taught = notes.filter((n) => n.kind === 'file-match' && n.target && wordsAlike(n.said, text) >= KN_TAUGHT_WORDS).map((n) => n.target!);
  const no = taught.filter((t) => t.answer === 'no'), yes = opts.pin ?? taught.find((t) => t.answer === 'yes') ?? null;
  const qv = L.vectors ? (await embedTexts([text], 'query'))?.[0] ?? null : null;
  const byId = new Map(L.files.map((f) => [f.id, f]));
  const toHit = (key: string, similarity: number) => {
    const p = L.pieces.get(key); const f = p && byId.get(p.fileId);
    return p && f ? { file: f.name, fileId: f.id, piece: key, heading: p.heading, text: p.body, collection: f.collection, similarity } : null;
  };
  let hits = L.index.search(text, qv, 10).map((h) => toHit(h.id, h.similarity)).filter((h): h is NonNullable<typeof h> => !!h)
    .filter((h) => !no.some((t) => t.fileId === h.fileId && (t.piece === h.piece || (!!t.heading && t.heading === h.heading))));
  const pinned = yes ? toHit(yes.piece, 1) : null;
  if (pinned) hits = [{ ...pinned, taught: true } as typeof pinned & { taught: boolean }, ...hits.filter((h) => h.piece !== pinned.piece)];
  const ids = new Set(hits.map((h) => h.fileId));
  const tables = [...L.sheets.entries()].filter(([, s]) => ids.has(s.fileId)).slice(0, 6)
    .map(([sheet, s]) => ({ sheet, file: byId.get(s.fileId)!.name, name: s.name, rows: s.rows.length, columns: s.columns }));
  return { hits, tables, numbers: !!qv, learned };
}

// ---------------------------------------------------------------- what Niko learned, kept here
interface StoredNote { kind: KnLearnedKind; said: string; means: string; how: KnHow; target: KnTarget | null; uses: number; createdAt: string; lastUsed: string | null }
const noteAad = (id: string) => `learned:${id}`;
async function storedNotes(account: string): Promise<(StoredNote & { id: string })[]> {
  return Promise.all((await all(account, 'learned')).map(async (r) => ({ id: r.id, ...(await unlock<StoredNote>(account, noteAad(r.id), r)) })));
}
const asItem = (n: StoredNote & { id: string }): KnLearnedItem => ({ id: n.id, kind: n.kind, said: n.said, means: n.means, how: knHowName(n.how), level: 'sure', uses: n.uses, confirmed: true, target: n.target, createdAt: n.createdAt, lastUsed: n.lastUsed });
export async function notesHere(account: string): Promise<KnLearnedItem[]> {
  return (await storedNotes(account)).sort((a, b) => (b.lastUsed ?? b.createdAt).localeCompare(a.lastUsed ?? a.createdAt)).map(asItem);
}
async function putNote(account: string, id: string, n: StoredNote) { await put(account, 'learned', [{ id, ...(await lock(account, noteAad(id), n)) }]); }
async function dropNotes(account: string, ids: string[]) {
  if (!ids.length) return;
  const t = (await db(account)).transaction('learned', 'readwrite');
  for (const id of ids) t.objectStore('learned').delete(id);
  await done(t);
}
async function touchNotes(account: string, ids: string[]) {
  const now = new Date().toISOString();
  for (const n of (await storedNotes(account)).filter((x) => ids.includes(x.id))) await putNote(account, n.id, { ...n, uses: n.uses + 1, lastUsed: now });
}
/** Keeps a note here, with the same rules as in Niko: a name or correction replaces any note about the same words. */
export async function keepNoteHere(account: string, n: { kind: 'person' | 'correction' | 'remembered' | 'file-match'; said: string; means: string; how: KnHow; target?: KnTarget | null }): Promise<KnLearnedItem> {
  const said = n.said.trim().slice(0, n.kind === 'file-match' ? 200 : n.kind === 'remembered' ? KN_MEANS_CHARS : KN_SAID_CHARS), means = n.means.trim().slice(0, KN_MEANS_CHARS);
  if (!said || !means) throw new Error('There’s nothing to keep.');
  if (looksSecret(`${said} ${means}`)) throw new Error('Niko never keeps passwords, codes, or card and account numbers.');
  const have = await storedNotes(account);
  const same = have.filter((x) => (n.kind === 'person' || n.kind === 'correction') ? (x.kind === 'person' || x.kind === 'correction') && x.said.toLowerCase() === said.toLowerCase()
    : n.kind === 'remembered' ? x.kind === 'remembered' && x.means.toLowerCase() === means.toLowerCase()
    : x.kind === 'file-match' && x.said.toLowerCase() === said.toLowerCase() && x.target?.fileId === n.target?.fileId && x.target?.piece === n.target?.piece);
  await dropNotes(account, same.map((x) => x.id));
  if (have.length - same.length >= KN_LEARNED_MAX) throw new Error(`Niko keeps up to ${KN_LEARNED_MAX.toLocaleString()} notes. Forget some in What Niko learned.`);
  if (n.kind === 'file-match' && have.filter((x) => x.kind === 'file-match').length - same.length >= KN_TAUGHT_MAX) throw new Error(`Niko keeps up to ${KN_TAUGHT_MAX} taught matches.`);
  const id = crypto.randomUUID();
  const note: StoredNote = { kind: n.kind, said, means: n.kind === 'remembered' ? said : means, how: n.how, target: n.kind === 'file-match' ? n.target ?? null : null, uses: 0, createdAt: new Date().toISOString(), lastUsed: null };
  await putNote(account, id, note);
  return asItem({ id, ...note });
}
export async function editNoteHere(account: string, id: string, b: { said: string; means: string }): Promise<KnLearnedItem> {
  const n = (await storedNotes(account)).find((x) => x.id === id);
  if (!n) throw new Error('No such note.');
  if (n.kind === 'file-match') throw new Error('A taught match can’t be changed. Remove it instead.');
  const said = b.said.trim().slice(0, n.kind === 'remembered' ? KN_MEANS_CHARS : KN_SAID_CHARS), means = n.kind === 'remembered' ? said : b.means.trim().slice(0, KN_MEANS_CHARS);
  if (!said || !means) throw new Error('A note can’t be empty.');
  if (looksSecret(`${said} ${means}`)) throw new Error('Niko never keeps passwords, codes, or card and account numbers.');
  const next = { ...n, said, means };
  await putNote(account, id, next);
  return asItem(next);
}
export const forgetNoteHere = (account: string, id: string) => dropNotes(account, [id]);
export async function forgetAllHere(account: string): Promise<number> {
  const ids = (await storedNotes(account)).map((x) => x.id);
  await dropNotes(account, ids);
  return ids.length;
}
/** "That's the one" / "Not this one" for a file kept here. */
export const teachHere = (account: string, question: string, target: KnTarget) =>
  keepNoteHere(account, { kind: 'file-match', said: question, means: `${target.file}${target.heading ? ` › ${target.heading}` : ''}`, how: target.answer, target });
/** Runs the look-ups Niko asked for in tables kept here. */
export async function lookupHere(account: string, asks: (KnTableAsk & { sheet: string })[]): Promise<string[]> {
  const L = await load(account);
  return asks.slice(0, 3).map((a) => {
    const s = L.sheets.get(a.sheet);
    const f = s && L.files.find((x) => x.id === s.fileId);
    return s && f ? lookupRows({ file: f.name, name: s.name, columns: s.columns }, s.rows, a) : 'That table is no longer kept on this device.';
  });
}
// ---------------------------------------------------------------- search numbers
export async function missingNumbersHere(account: string): Promise<number> {
  return [...(await load(account)).pieces.values()].filter((p) => !p.vector).length;
}
/** Gives every piece kept here its search numbers, once the search model is on this device. */
export async function addNumbersHere(account: string, onStep?: (done: number, total: number) => void): Promise<void> {
  const L = await load(account);
  const todo = [...L.pieces.entries()].filter(([, p]) => !p.vector);
  for (let i = 0; i < todo.length; i += 32) {
    onStep?.(i, todo.length);
    const batch = todo.slice(i, i + 32);
    const v = await embedTexts(batch.map(([, p]) => (p.heading ? `${p.heading}\n${p.body}` : p.body)), 'passage');
    if (!v) throw new Error('The search model stopped. Try again.');
    const recs: Rec[] = [];
    for (let j = 0; j < batch.length; j++) {
      const [key, p] = batch[j]!;
      const ord = Number(key.slice(key.lastIndexOf(':') + 1));
      recs.push({ id: '', fileId: p.fileId, ord, ...(await lock(account, pieceAad(p.fileId, ord), { heading: p.heading, body: p.body, vector: v[j] })) });
    }
    await put(account, 'pieces', recs.map(({ id: _, ...r }) => r as Rec));
  }
  for (const f of L.files) await rewriteMeta(account, f.id, (x) => ({ ...x, numbers: { cloudflare: 0, device: x.pieces } }));
  changed();
}

// ---------------------------------------------------------------- moving between Niko and this device
type ServerFile = { id: string; name: string; kind: string; collection: string; bytes: number; status: string; flagged: boolean; sheets: number; sha256: string };
/** Copies files kept in Niko to this device, then removes each from Niko once its copy is kept here. Nothing is lost. */
export async function moveToDevice(account: string, files: ServerFile[], onStep?: (done: number, total: number, name: string) => void): Promise<void> {
  const ready = files.filter((f) => f.status === 'ready');
  for (let n = 0; n < ready.length; n++) {
    const f = ready[n]!;
    onStep?.(n, ready.length, f.name);
    const pieces: Piece[] = [];
    for (let start: number | null = 0; start !== null;) {
      const r: { pieces: { heading: string | null; body: string }[]; next: number | null } = await api(`/knowledge/files/${f.id}/pieces?start=${start}`);
      pieces.push(...r.pieces.map((p) => ({ heading: p.heading, body: p.body }))); start = r.next;
    }
    const sheets: StoredSheet[] = [];
    if (f.sheets) for (const s of (await api<{ sheets: DeviceSheet[] }>(`/knowledge/files/${f.id}/sheets`)).sheets) {
      const rows: string[][] = [];
      for (let start: number | null = 0; start !== null;) { const r: { rows: string[][]; next: number | null } = await api(`/knowledge/files/${f.id}/sheets/${s.id}/rows?start=${start}`); rows.push(...r.rows); start = r.next; }
      sheets.push({ name: s.name, columns: s.columns, header: s.header, rows });
    }
    await keep(account, { name: f.name, kind: f.kind, bytes: f.bytes, sha256: f.sha256, collection: f.collection, flagged: f.flagged, pieces, vectors: await numbersFor(pieces), sheets });
    await api(`/knowledge/files/${f.id}`, { method: 'DELETE' });
  }
  // What Niko learned moves too (taught matches point at the old copies, so they're left behind and removed).
  const learned = await api<{ items: KnLearnedItem[] }>('/knowledge/learned').catch(() => null);
  for (const n of learned?.items ?? []) {
    if (n.kind === 'person' || n.kind === 'correction' || n.kind === 'remembered') await keepNoteHere(account, { kind: n.kind, said: n.said, means: n.means, how: n.kind === 'remembered' ? 'remember' : n.kind === 'correction' ? 'corrected' : 'told' }).catch(() => undefined);
  }
  if (learned?.items.length) await api('/knowledge/learned', { method: 'DELETE' }).catch(() => undefined);
}
/** Copies this device's files into Niko, then removes each copy here once Niko has it. */
export async function moveToNiko(account: string, onStep?: (done: number, total: number, name: string) => void): Promise<void> {
  const L = await load(account);
  const files = [...L.files];
  for (let n = 0; n < files.length; n++) {
    const f = files[n]!;
    onStep?.(n, files.length, f.name);
    const started = await api<{ id: string; cloudflare: boolean }>('/knowledge/files', { method: 'POST', body: { name: f.name, bytes: f.bytes, sha256: f.sha256, collection: f.collection, flagged: f.flagged } });
    try {
      const pieces = [...L.pieces.entries()].filter(([, p]) => p.fileId === f.id).sort((a, b) => Number(a[0].split(':')[1]) - Number(b[0].split(':')[1])).map(([, p]) => p);
      for (let i = 0; i < pieces.length; i += KN_PIECES_PER_CALL) {
        const batch = pieces.slice(i, i + KN_PIECES_PER_CALL);
        const vectors = !started.cloudflare && batch.every((p) => p.vector) ? batch.map((p) => p.vector) : undefined;
        await api(`/knowledge/files/${started.id}/pieces`, { method: 'POST', body: { start: i, pieces: batch.map((p) => ({ heading: p.heading, body: p.body })), ...(vectors ? { vectors } : {}) } });
      }
      for (const s of [...L.sheets.values()].filter((s) => s.fileId === f.id)) {
        const sh = await api<{ id: string }>(`/knowledge/files/${started.id}/sheets`, { method: 'POST', body: { name: s.name, columns: s.columns, rows: s.rows.slice(0, KN_SHEET_ROWS_PER_CALL), header: s.header } });
        for (let i = KN_SHEET_ROWS_PER_CALL; i < s.rows.length; i += KN_SHEET_ROWS_PER_CALL) await api(`/knowledge/files/${started.id}/sheets/${sh.id}/rows`, { method: 'POST', body: { start: i, rows: s.rows.slice(i, i + KN_SHEET_ROWS_PER_CALL) } });
      }
      await api(`/knowledge/files/${started.id}/done`, { method: 'POST' });
    } catch (e) {
      await api(`/knowledge/files/${started.id}`, { method: 'DELETE' }).catch(() => undefined);
      throw e;
    }
    await dropFile(account, f.id);
  }
  // What Niko learned here moves into Niko too (taught matches point at the old copies and are dropped).
  for (const n of await storedNotes(account).catch(() => [])) {
    if (n.kind === 'person' || n.kind === 'correction' || n.kind === 'remembered') await api('/knowledge/learned', { method: 'POST', body: { kind: n.kind, said: n.said, means: n.means, how: n.how } }).catch(() => undefined);
  }
  await forgetAllHere(account).catch(() => undefined);
  changed();
}
