// Knowledge kept on "This device": the browser keeps the files, reads them and searches them, and sends only the few
// pieces that may answer a question along with that question. These are the shared rules for what it may send, and
// the same spreadsheet look-ups the server runs, done here on rows the browser keeps.
import { isRemotePlace, tableTags, type KnColumn, type KnowledgeAccess, type KnowledgePrefs, type KnPlace, type KnRemotePlace, type KnTableAsk } from './knowledge';

/** Where files are kept and how they are searched, kept to what the account may use. */
export const knPlaceOf = (p: Pick<KnowledgePrefs, 'place'>, a: Pick<KnowledgeAccess, 'niko' | 'device'>): 'niko' | 'device' =>
  (p.place === 'device' && a.device) || (!a.niko && a.device) ? 'device' : 'niko';
/** Where their files' copies are kept, when that's one of their own apps or storage (allowed by their plan); the search
 *  pieces of those files are kept in Niko, so knPlaceOf is 'niko' for them. */
export const knRemoteOf = (p: Pick<KnowledgePrefs, 'place'>, a: KnowledgeAccess): KnRemotePlace | null =>
  isRemotePlace(p.place) && a[p.place] && knPlaceOf(p, a) === 'niko' ? p.place : null;
/** The place shown as chosen: one of their own apps or storage, else Niko or this device. */
export const knShownPlace = (p: Pick<KnowledgePrefs, 'place'>, a: KnowledgeAccess): KnPlace => knRemoteOf(p, a) ?? knPlaceOf(p, a);
export const knSearchOf = (p: Pick<KnowledgePrefs, 'search'> & { own?: KnowledgePrefs['own'] }, a: Pick<KnowledgeAccess, 'cloudflareSearch'> & Partial<Pick<KnowledgeAccess, 'ownKey' | 'ownServer'>>, place: 'niko' | 'device'): 'cloudflare' | 'device' | 'own' =>
  place === 'niko' && a.cloudflareSearch && p.search === 'cloudflare' ? 'cloudflare'
    : place === 'niko' && p.search === 'own' && !!p.own && (p.own.ref === 'self-hosted-ai' ? !!a.ownServer : !!a.ownKey) ? 'own' : 'device';

/** How close (0 to 1) a piece must be, by the on-device search numbers (multilingual-e5-small), to lead the answer and
 *  to be offered at all. e5 scores sit higher than Cloudflare's: unrelated text is usually around 0.72 to 0.8 and a
 *  real answer above 0.85. Like KN_LEAD and KN_SIMILAR, these can be tuned once real answers are seen. */
export const KN_DEVICE_LEAD = 0.86;
export const KN_DEVICE_SIMILAR = 0.82;
/** The on-device search model and its tokenizer (118 MB + 17 MB), downloaded once per device from Hugging Face and
 *  checked against pinned SHA-256 fingerprints. */
export const KN_DEVICE_MODEL_MB = 135;

/** What the browser may send with one question: its best matches and the tables behind them. */
export const KN_DEVICE_HITS_MAX = 10;
export const KN_DEVICE_TABLES_MAX = 6;
export const KN_DEVICE_TEXT_CHARS = 2000;
export const KN_TABLE_RESULT_CHARS = 4000;
export interface KnDeviceHit { file: string; heading: string | null; text: string; collection: string; similarity: number; fileId?: string; piece?: string; taught?: boolean }
/** A note learned and kept on the device, sent with a question it may help with. */
export interface KnDeviceNote { kind: string; said: string; means: string; level: 'sure' | 'fairly' | 'unsure'; how: string }
export interface KnDeviceTable { sheet: string; file: string; name: string; rows: number; columns: KnColumn[] }
export interface KnDeviceKnowledge { hits: KnDeviceHit[]; tables: KnDeviceTable[]; numbers: boolean; learned: KnDeviceNote[] }

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, max) : '');
const SHEET_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** Checks what the browser sent with a question. Anything malformed is dropped rather than trusted; the text itself is
 *  still only ever shown to the AI as untrusted content from the person's files. */
export function cleanDeviceKnowledge(raw: unknown): KnDeviceKnowledge | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as { hits?: unknown; tables?: unknown; numbers?: unknown; learned?: unknown };
  const hits: KnDeviceHit[] = (Array.isArray(o.hits) ? o.hits : []).slice(0, KN_DEVICE_HITS_MAX).flatMap((h) => {
    const x = (h && typeof h === 'object' ? h : {}) as Record<string, unknown>;
    const text = str(x.text, KN_DEVICE_TEXT_CHARS), file = str(x.file, 200);
    const sim = typeof x.similarity === 'number' && Number.isFinite(x.similarity) ? Math.max(0, Math.min(1, x.similarity)) : 0;
    const fileId = typeof x.fileId === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(x.fileId) ? x.fileId : undefined;
    const piece = typeof x.piece === 'string' && /^[A-Za-z0-9:-]{1,100}$/.test(x.piece) ? x.piece : undefined;
    return text && file ? [{ file, heading: str(x.heading, 200) || null, text, collection: str(x.collection, 80) || 'General', similarity: sim, ...(fileId && piece ? { fileId, piece } : {}), ...(x.taught === true ? { taught: true } : {}) }] : [];
  });
  const tables: KnDeviceTable[] = (Array.isArray(o.tables) ? o.tables : []).slice(0, KN_DEVICE_TABLES_MAX).flatMap((t) => {
    const x = (t && typeof t === 'object' ? t : {}) as Record<string, unknown>;
    const sheet = typeof x.sheet === 'string' && SHEET_ID.test(x.sheet) ? x.sheet : '';
    const columns = (Array.isArray(x.columns) ? x.columns : []).slice(0, 60).flatMap((c) => {
      const y = (c && typeof c === 'object' ? c : {}) as Record<string, unknown>;
      const name = str(y.name, 80);
      return name ? [{ name, type: (['text', 'number', 'date', 'yesno'] as const).find((k) => k === y.type) ?? 'text' }] : [];
    });
    const rows = typeof x.rows === 'number' && Number.isInteger(x.rows) && x.rows >= 0 ? Math.min(x.rows, 1_000_000) : 0;
    const file = str(x.file, 200), name = str(x.name, 120) || 'Sheet';
    return sheet && file && columns.length ? [{ sheet, file, name, rows, columns }] : [];
  });
  const learned: KnDeviceNote[] = (Array.isArray(o.learned) ? o.learned : []).slice(0, 8).flatMap((n) => {
    const x = (n && typeof n === 'object' ? n : {}) as Record<string, unknown>;
    const said = str(x.said, 300), means = str(x.means, 300);
    const kind = ['person', 'correction', 'remembered'].includes(x.kind as string) ? (x.kind as string) : '';
    return said && means && kind ? [{ kind, said, means, level: x.level === 'fairly' || x.level === 'unsure' ? x.level : 'sure', how: str(x.how, 60) || 'You told Niko' }] : [];
  });
  return { hits, tables, numbers: o.numbers === true, learned };
}
/** Results of look-ups the browser ran for the AI: plain text, at most three, each kept short. */
export function cleanTableResults(raw: unknown): string[] {
  return (Array.isArray(raw) ? raw : []).slice(0, 3).map((r) => str(r, KN_TABLE_RESULT_CHARS)).filter(Boolean);
}

/** The look-ups the server hands back to the browser (they came from the AI's reply), checked the same way as tags. */
export function cleanTableAsks(raw: unknown): (KnTableAsk & { sheet: string })[] {
  return (Array.isArray(raw) ? raw : []).slice(0, 3).flatMap((a) => {
    const x = (a && typeof a === 'object' ? a : {}) as Record<string, unknown>;
    if (typeof x.sheet !== 'string' || !SHEET_ID.test(x.sheet)) return [];
    const filters = (Array.isArray(x.filters) ? x.filters : []).map((f) => { const y = (f && typeof f === 'object' ? f : {}) as Record<string, unknown>; return `${String(y.column ?? '')}${String(y.cmp ?? '')}${String(y.value ?? '')}`; });
    const parsed = tableTags(`[[table:T1|${String(x.op ?? '')}|${String(x.column ?? '')}|${filters.join(';')}]]`)[0];
    return parsed ? [{ ...parsed, sheet: x.sheet }] : [];
  });
}

// ---------------------------------------------------------------- look-ups on rows kept here
// The same operations, filters and wording as the server's look-up (apps/api/src/knowledge.ts lookupSheet).
const NUM = /^\s*[-+]?[$€£¥]?\s*[0-9][0-9,]*(\.[0-9]+)?\s*%?\s*$/;
const num = (s: string | undefined): number | null => (s != null && NUM.test(s) ? Number(s.replace(/[^0-9.\-]/g, '')) : null);
const pgTrim = (s: string) => s.replace(/^ +| +$/g, '');
const cmp = (a: number | string, op: string, b: number | string) =>
  op === '>' ? a > b : op === '<' ? a < b : op === '>=' ? a >= b : op === '<=' ? a <= b : op === '=' ? a === b : a !== b;
/** Runs one look-up on a sheet's rows: count, sum, average, smallest, largest, or list up to 20 rows, with filters. */
export function lookupRows(sheet: { file: string; name: string; columns: KnColumn[] }, rows: string[][], ask: KnTableAsk): string {
  const cols = sheet.columns;
  const find = (name: string) => cols.findIndex((c) => c.name.toLowerCase() === name.trim().toLowerCase());
  const tests: ((r: string[]) => boolean)[] = [];
  for (const f of ask.filters) {
    const i = find(f.column);
    if (i < 0) return `There is no column called “${f.column}”. The columns are: ${cols.map((c) => c.name).join(', ')}.`;
    const numeric = cols[i]!.type === 'number' && ['>', '<', '>=', '<=', '=', '!='].includes(f.cmp) && /^-?[\d,]*\.?\d+$/.test(f.value.replace(/[$€£¥%\s]/g, ''));
    if (numeric) { const v = Number(f.value.replace(/[^0-9.\-]/g, '')); tests.push((r) => { const c = num(r[i]); return c != null && cmp(c, f.cmp, v); }); }
    else if (f.cmp === '~') { const v = f.value.toLowerCase(); tests.push((r) => (r[i] ?? '').toLowerCase().includes(v)); }
    else if (f.cmp === '=' || f.cmp === '!=') { const v = pgTrim(f.value).toLowerCase(); tests.push((r) => (pgTrim(r[i] ?? '').toLowerCase() === v) === (f.cmp === '=')); }
    else tests.push((r) => cmp(r[i] ?? '', f.cmp, f.value));
  }
  const kept = rows.filter((r) => tests.every((t) => t(r)));
  const label = `${sheet.file} › ${sheet.name}`;
  const said = ask.filters.length ? ` where ${ask.filters.map((f) => `${f.column} ${f.cmp === '~' ? 'contains' : f.cmp} ${f.value}`).join(' and ')}` : '';
  if (ask.op === 'list') {
    if (!kept.length) return `${label}: no rows${said}.`;
    const shown = kept.slice(0, 20);
    return `${label}: ${kept.length} ${kept.length === 1 ? 'row' : 'rows'}${said}${kept.length > shown.length ? ` (first ${shown.length} shown)` : ''}:\n${shown.map((r) => cols.map((col, i) => (r[i] ? `${col.name}: ${r[i]}` : '')).filter(Boolean).join('; ')).join('\n')}`;
  }
  if (ask.op === 'count' && (ask.column === '*' || find(ask.column) < 0)) return `${label}: ${kept.length} ${kept.length === 1 ? 'row' : 'rows'}${said}.`;
  const i = find(ask.column);
  if (i < 0) return `There is no column called “${ask.column}”. The columns are: ${cols.map((c) => c.name).join(', ')}.`;
  if (ask.op === 'count') {
    const n = kept.filter((r) => pgTrim(r[i] ?? '') !== '').length;
    return `${label}: ${n} ${n === 1 ? 'row has' : 'rows have'} a ${cols[i]!.name}${said}.`;
  }
  const asNumber = cols[i]!.type === 'number' || ask.op === 'sum' || ask.op === 'avg';
  const vals: (number | string)[] = kept.map((r) => (asNumber ? num(r[i]) : pgTrim(r[i] ?? '') || null)).filter((v): v is number | string => v != null);
  if (!vals.length) return `${label}: no ${cols[i]!.name} values to ${ask.op === 'avg' ? 'average' : ask.op === 'sum' ? 'add up' : 'compare'}${said}.`;
  let v: number | string;
  if (ask.op === 'sum' || ask.op === 'avg') { const t = (vals as number[]).reduce((a, b) => a + b, 0); v = ask.op === 'sum' ? t : t / vals.length; }
  else v = vals.reduce((a, b) => (ask.op === 'min' ? (b < a ? b : a) : (b > a ? b : a)));
  if (typeof v === 'number') v = Math.round(v * 100) / 100;
  else if (/^-?\d+(\.\d+)?$/.test(v)) v = Math.round(Number(v) * 100) / 100;
  return `${label}: the ${({ sum: 'total', avg: 'average', min: 'smallest', max: 'largest' } as Record<string, string>)[ask.op]} ${cols[i]!.name} is ${typeof v === 'number' ? v.toLocaleString('en') : v}, from ${vals.length} ${vals.length === 1 ? 'row' : 'rows'}${said}.`;
}
