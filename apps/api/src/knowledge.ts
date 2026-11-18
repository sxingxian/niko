// Knowledge: each person's own files, kept in Knowledge's own Neon database (KNOWLEDGE_DATABASE_URL), and searched
// when Niko answers. The browser reads and splits files into pieces (the free Workers plan has little CPU per request),
// so the server only checks pieces, adds search numbers and stores them. Cloudflare reads PDF and Word files and makes
// search numbers only when the account is allowed it, and keeps nothing afterwards.
//
// Every query filters by the account. Nothing here trusts what a file says: file text is only ever shown to the AI as
// untrusted content (see the chat route).
import { neon } from '@neondatabase/serverless';
import { eq } from 'drizzle-orm';
import { appSettings, type Db } from '@niko/db';
import {
  cleanKnowledgeLimits, cleanKnowledgeSettings, knowledgeLimits, knKindOf, knNeedsCloudflare,
  KN_CLOUDFLARE_DIMS, KN_DEVICE_DIMS, KN_PIECE_CHARS, KN_PIECES_PER_CALL, KN_READ_MAX_BYTES,
  KN_COL_TYPES, KN_SHEET_CELL_CHARS, KN_SHEET_MAX_COLS, KN_SHEET_MAX_ROWS, KN_SHEET_ROWS_PER_CALL,
  type KnColType, type KnColumn, type KnKind, type KnowledgeLimits, type KnowledgeSettings,
} from '@niko/shared';
import type { Env } from './env';

/** The Knowledge database: plain SQL with parameters, nothing else. Tests stand in a local PostgreSQL. */
export interface Kdb { q<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]> }
export function knowledgeDb(env: Pick<Env, 'KNOWLEDGE_DATABASE_URL'>): Kdb | null {
  const url = env.KNOWLEDGE_DATABASE_URL?.trim();
  if (!url) return null;
  const sql = neon(url);
  return { q: async <T>(text: string, params: unknown[] = []) => (await sql.query(text, params)) as T[] };
}

/** A problem to show the person as it is. */
export class KnError extends Error {
  constructor(message: string, readonly status: 400 | 403 | 404 | 409 | 413 | 502 = 400, readonly extra: Record<string, unknown> = {}) { super(message); }
}

// ---------------------------------------------------------------- settings and limits (main database)
export const KN_SETTINGS_KEY = 'knowledge';
export async function knowledgeSettings(db: Db): Promise<KnowledgeSettings> {
  const row = (await db.select().from(appSettings).where(eq(appSettings.key, KN_SETTINGS_KEY)).limit(1).catch(() => []))[0];
  return cleanKnowledgeSettings(row?.value);
}
export async function limitsFor(db: Db, user: { knowledgeLimits?: unknown }): Promise<KnowledgeLimits> {
  return knowledgeLimits((await knowledgeSettings(db)).limits, cleanKnowledgeLimits(user.knowledgeLimits));
}

// ---------------------------------------------------------------- search numbers
const MB = 1024 * 1024;
const EMBED_BATCH = 16;
/** Search numbers from Cloudflare (bge-m3, 1,024 per text). Nothing is kept by Cloudflare. */
export async function embed(env: Pick<Env, 'AI'>, texts: string[]): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += EMBED_BATCH) {
    const batch = texts.slice(i, i + EMBED_BATCH);
    let r: { data?: number[][] };
    try { r = (await env.AI.run('@cf/baai/bge-m3', { text: batch, truncate_inputs: true })) as { data?: number[][] }; }
    catch (e) { throw new KnError(`Cloudflare couldn’t make search numbers just now (${String((e as Error)?.message ?? e).slice(0, 120)}). Try again in a moment.`, 502); }
    if (!Array.isArray(r?.data) || r.data.length !== batch.length) throw new KnError('Cloudflare gave back search numbers that don’t match. Try again in a moment.', 502);
    for (const v of r.data) out.push(checkVector(v, KN_CLOUDFLARE_DIMS));
  }
  return out;
}
function checkVector(v: unknown, dims: number): number[] {
  if (!Array.isArray(v) || v.length !== dims || !v.every((n) => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= 1e4)) {
    throw new KnError(`Search numbers must be ${dims} plain numbers.`);
  }
  return v as number[];
}
const vecText = (v: number[]) => `[${v.map((n) => (Math.round(n * 1e6) / 1e6).toString()).join(',')}]`;

// ---------------------------------------------------------------- reading PDF and Word with Cloudflare
/** Turns a PDF, Word or spreadsheet file into text with Cloudflare. Pictures inside are not read (that would use AI
 *  models). Nothing is stored: the text goes back to the browser, which splits it like any other file. */
export async function readWithCloudflare(env: Pick<Env, 'AI'>, name: string, bytes: ArrayBuffer, maxBytes: number): Promise<{ kind: KnKind; text: string }> {
  const kind = knKindOf(name);
  if (!kind) throw new KnError('Knowledge can’t read that kind of file.');
  if (!knNeedsCloudflare(kind)) throw new KnError('Your browser reads this kind of file itself.');
  if (bytes.byteLength === 0) throw new KnError('That file is empty.');
  if (bytes.byteLength > Math.min(maxBytes, KN_READ_MAX_BYTES)) throw new KnError(`That file is over ${Math.round(Math.min(maxBytes, KN_READ_MAX_BYTES) / MB)} MB.`, 413);
  let r: { format: string; data?: string; error?: string };
  try {
    r = (await env.AI.toMarkdown({ name: name.slice(0, 200), blob: new Blob([bytes]) }, {
      conversionOptions: { pdf: { images: { convert: false }, metadata: false }, docx: { images: { convert: false } } },
    })) as typeof r;
  } catch (e) { throw new KnError(`Cloudflare couldn’t read that file just now (${String((e as Error)?.message ?? e).slice(0, 120)}).`, 502); }
  if (r.format === 'error' || typeof r.data !== 'string') throw new KnError(`Cloudflare couldn’t read that file${r.error ? `: ${String(r.error).slice(0, 160)}` : '.'}`, 502);
  const text = r.data.replace(/\u0000/g, '').trim();
  if (!text) throw new KnError('No text was found in that file. If it’s a scanned page, it holds only pictures, which Knowledge doesn’t read.');
  return { kind, text };
}

// ---------------------------------------------------------------- files
export interface KnFile { id: string; name: string; kind: KnKind; collection: string; bytes: number; status: 'reading' | 'ready' | 'failed'; error: string | null; pieces: number; flagged: boolean; sheets: number; rows: number; addedAt: string }
const cleanText = (v: unknown, n: number) => (typeof v === 'string' ? v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, n) : '');
const cleanName = (v: unknown) => cleanText(v, 255).replace(/[\\/]/g, '-');

export async function usage(k: Kdb, account: string): Promise<{ files: number; bytes: number }> {
  const [r] = await k.q<{ files: number; bytes: string }>(`select count(*)::int as files, coalesce(sum(bytes), 0)::bigint as bytes from kn_documents where account_id = $1`, [account]);
  return { files: r?.files ?? 0, bytes: Number(r?.bytes ?? 0) };
}

/** Starts a file: checks it fits the account's limits and isn't already there, and keeps a row while it is read. */
export async function startFile(k: Kdb, account: string, limits: KnowledgeLimits, meta: { name?: unknown; bytes?: unknown; sha256?: unknown; collection?: unknown; flagged?: unknown }): Promise<{ id: string }> {
  const name = cleanName(meta.name), kind = knKindOf(name);
  if (!name || !kind) throw new KnError('Knowledge takes MD, TXT, CSV, TSV, JSON, XML, HTML, PDF, Word (DOCX), Excel (XLSX, XLS) and OpenDocument files.');
  const bytes = typeof meta.bytes === 'number' && Number.isInteger(meta.bytes) && meta.bytes >= 0 ? meta.bytes : -1;
  if (bytes < 0) throw new KnError('The file size is missing.');
  const sha256 = typeof meta.sha256 === 'string' && /^[0-9a-f]{64}$/.test(meta.sha256) ? meta.sha256 : '';
  if (!sha256) throw new KnError('The file’s fingerprint is missing.');
  const collection = cleanText(meta.collection, 80) || 'General';
  if (bytes > limits.mbPerFile * MB) throw new KnError(`Each file can be up to ${limits.mbPerFile} MB.`, 413);
  const [same] = await k.q<{ id: string; status: string }>(`select id, status from kn_documents where account_id = $1 and sha256 = $2`, [account, sha256]);
  if (same?.status === 'ready') throw new KnError('You’ve already added this file.', 409, { id: same.id });
  // A file left half-read (the page was closed) starts again from the beginning.
  if (same) await k.q(`delete from kn_documents where id = $1 and account_id = $2`, [same.id, account]);
  const used = await usage(k, account);
  if (used.files >= limits.files) throw new KnError(`You can keep up to ${limits.files} files. Remove one to add another.`, 413);
  if (used.bytes + bytes > limits.mbTotal * MB) throw new KnError(`Your files can take up to ${limits.mbTotal} MB in all. Remove some to add this one.`, 413);
  const [row] = await k.q<{ id: string }>(
    `insert into kn_documents (account_id, collection, name, kind, bytes, sha256, status, flagged) values ($1, $2, $3, $4, $5, $6, 'reading', $7) returning id`,
    [account, collection, name, kind, bytes, sha256, meta.flagged === true]);
  return { id: row!.id };
}

async function readingFile(k: Kdb, account: string, id: string) {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new KnError('No such file.', 404);
  const [doc] = await k.q<{ id: string; status: string; kind: KnKind }>(`select id, status, kind from kn_documents where id = $1 and account_id = $2`, [id, account]);
  if (!doc) throw new KnError('No such file.', 404);
  if (doc.status !== 'reading') throw new KnError('That file is already finished. Remove it and add it again to change it.', 409);
  return doc;
}

/** Adds up to KN_PIECES_PER_CALL pieces, numbered from `start`, with search numbers from Cloudflare or the device. */
export async function addPieces(k: Kdb, env: Pick<Env, 'AI'>, account: string, id: string, b: { start?: unknown; pieces?: unknown; vectors?: unknown }, how: { cloudflare: boolean }): Promise<{ added: number }> {
  await readingFile(k, account, id);
  const start = typeof b.start === 'number' && Number.isInteger(b.start) && b.start >= 0 && b.start < 1_000_000 ? b.start : -1;
  if (start < 0) throw new KnError('Where these pieces start is missing.');
  const raw = Array.isArray(b.pieces) ? b.pieces : [];
  if (!raw.length || raw.length > KN_PIECES_PER_CALL) throw new KnError(`Send between 1 and ${KN_PIECES_PER_CALL} pieces at a time.`);
  const pieces = raw.map((p) => {
    const o = (p && typeof p === 'object' ? p : {}) as { heading?: unknown; body?: unknown };
    const body = cleanText(o.body, KN_PIECE_CHARS + 1);
    if (!body) throw new KnError('A piece has no text.');
    if (body.length > KN_PIECE_CHARS) throw new KnError(`A piece can hold up to ${KN_PIECE_CHARS} characters.`);
    return { heading: cleanText(o.heading, 200) || null, body };
  });
  let cf: (string | null)[] = pieces.map(() => null), dev: (string | null)[] = pieces.map(() => null);
  if (how.cloudflare) {
    cf = (await embed(env, pieces.map((p) => (p.heading ? `${p.heading}\n${p.body}` : p.body)))).map(vecText);
  } else if (b.vectors !== undefined) {
    // Search numbers made on the device. Without any, the pieces are found by their words only.
    const vs = Array.isArray(b.vectors) ? b.vectors : [];
    if (vs.length !== pieces.length) throw new KnError('Each piece needs its search numbers from this device.');
    dev = vs.map((v) => vecText(checkVector(v, KN_DEVICE_DIMS)));
  }
  await k.q(
    `insert into kn_chunks (account_id, document_id, ord, heading, body, embedding, embedding_device)
     select $1, $2, t.o, t.h, t.b, t.e::halfvec, t.d::halfvec
     from unnest($3::int[], $4::text[], $5::text[], $6::text[], $7::text[]) as t(o, h, b, e, d)
     on conflict (document_id, ord) do nothing`,
    [account, id, pieces.map((_, i) => start + i), pieces.map((p) => p.heading), pieces.map((p) => p.body), cf, dev]);
  return { added: pieces.length };
}

/** Keeps a spreadsheet's rows as a table, for the look-up tool. The first KN_SHEET_ROWS_PER_CALL rows come with it;
 *  the rest follow with addSheetRows. */
export async function addSheet(k: Kdb, account: string, id: string, b: { name?: unknown; columns?: unknown; rows?: unknown; header?: unknown }): Promise<{ id: string; rows: number }> {
  const doc = await readingFile(k, account, id);
  if (!['csv', 'tsv', 'xlsx', 'xls', 'ods'].includes(doc.kind)) throw new KnError('Only spreadsheets and CSV or TSV files have sheets.');
  const columns = cleanColumns(b.columns);
  const cells = rowCells(b.rows, columns.length);
  const [sh] = await k.q<{ id: string }>(`insert into kn_sheets (account_id, document_id, name, columns, row_count, header) values ($1, $2, $3, $4::jsonb, $5, $6) returning id`,
    [account, id, cleanText(b.name, 120) || 'Sheet', JSON.stringify(columns), cells.length, b.header !== false]);
  if (cells.length) await k.q(`insert into kn_sheet_rows (sheet_id, ord, cells) select $1, t.o, t.c::jsonb from unnest($2::int[], $3::text[]) as t(o, c)`,
    [sh!.id, cells.map((_, j) => j), cells]);
  return { id: sh!.id, rows: cells.length };
}
function rowCells(v: unknown, width: number): string[] {
  const rows = Array.isArray(v) ? v : [];
  if (rows.length > KN_SHEET_ROWS_PER_CALL) throw new KnError(`Send up to ${KN_SHEET_ROWS_PER_CALL} rows at a time.`, 413);
  return rows.map((r) => {
    if (!Array.isArray(r)) throw new KnError('Each row must be a list of cells.');
    return JSON.stringify(Array.from({ length: width }, (_, i) => cleanText(typeof r[i] === 'number' ? String(r[i]) : r[i], KN_SHEET_CELL_CHARS)));
  });
}
/** More rows for a sheet, numbered from `start`, while its file is still being added. */
export async function addSheetRows(k: Kdb, account: string, fileId: string, sheetId: string, b: { start?: unknown; rows?: unknown }): Promise<{ rows: number }> {
  await readingFile(k, account, fileId);
  if (!/^[0-9a-f-]{36}$/.test(sheetId)) throw new KnError('No such sheet.', 404);
  const [sh] = await k.q<{ columns: unknown[] }>(`select columns from kn_sheets where id = $1 and document_id = $2 and account_id = $3`, [sheetId, fileId, account]);
  if (!sh) throw new KnError('No such sheet.', 404);
  const start = typeof b.start === 'number' && Number.isInteger(b.start) && b.start >= 0 ? b.start : -1;
  if (start < 0) throw new KnError('Where these rows start is missing.');
  const cells = rowCells(b.rows, sh.columns.length);
  if (start + cells.length > KN_SHEET_MAX_ROWS) throw new KnError(`A sheet can keep up to ${KN_SHEET_MAX_ROWS.toLocaleString('en')} rows.`, 413);
  if (cells.length) await k.q(`insert into kn_sheet_rows (sheet_id, ord, cells) select $1, t.o, t.c::jsonb from unnest($2::int[], $3::text[]) as t(o, c) on conflict (sheet_id, ord) do nothing`,
    [sheetId, cells.map((_, j) => start + j), cells]);
  const [n] = await k.q<{ n: number }>(`update kn_sheets set row_count = (select count(*) from kn_sheet_rows where sheet_id = $1) where id = $1 returning row_count as n`, [sheetId]);
  return { rows: n?.n ?? 0 };
}

/** Column names and what each holds. A plain name is text. Names are made unique and never empty. */
function cleanColumns(v: unknown): KnColumn[] {
  const raw = Array.isArray(v) ? v : [];
  if (!raw.length || raw.length > KN_SHEET_MAX_COLS) throw new KnError(`A sheet needs between 1 and ${KN_SHEET_MAX_COLS} columns.`);
  const seen = new Set<string>();
  return raw.map((c, i) => {
    const o = (typeof c === 'string' ? { name: c } : c && typeof c === 'object' ? c : {}) as { name?: unknown; type?: unknown };
    let name = cleanText(o.name, 120) || `Column ${i + 1}`;
    for (let n = 2; seen.has(name.toLowerCase()); n++) name = `${cleanText(o.name, 110) || 'Column'} (${n})`;
    seen.add(name.toLowerCase());
    return { name, type: (KN_COL_TYPES as string[]).includes(o.type as string) ? (o.type as KnColType) : 'text' };
  });
}

export interface KnSheet { id: string; name: string; columns: KnColumn[]; rows: number; header: boolean; example: string[] }
export async function listSheets(k: Kdb, account: string, fileId: string): Promise<KnSheet[]> {
  if (!/^[0-9a-f-]{36}$/.test(fileId)) throw new KnError('No such file.', 404);
  const rows = await k.q<{ id: string; name: string; columns: unknown; row_count: number; header: boolean; cells: string[] | null }>(
    `select s.id, s.name, s.columns, s.row_count, s.header, r.cells from kn_sheets s left join kn_sheet_rows r on r.sheet_id = s.id and r.ord = 0
     where s.document_id = $1 and s.account_id = $2 order by s.name`, [fileId, account]);
  if (!rows.length) {
    const [doc] = await k.q(`select id from kn_documents where id = $1 and account_id = $2`, [fileId, account]);
    if (!doc) throw new KnError('No such file.', 404);
  }
  return rows.map((r) => ({ id: r.id, name: r.name, columns: cleanColumns(r.columns), rows: r.row_count, header: r.header, example: Array.isArray(r.cells) ? r.cells.map(String) : [] }));
}

/** Fixes a sheet's columns after it was added: names, what each holds, and whether the first row is the header.
 *  Turning the header on makes the first row the names; turning it off puts the names back as the first row. */
export async function updateSheet(k: Kdb, account: string, fileId: string, sheetId: string, b: { columns?: unknown; header?: unknown }): Promise<KnSheet> {
  const sheets = await listSheets(k, account, fileId);
  const sh = sheets.find((s) => s.id === sheetId);
  if (!sh) throw new KnError('No such sheet.', 404);
  let columns = cleanColumns(b.columns ?? sh.columns);
  if (columns.length !== sh.columns.length) throw new KnError('Keep the same number of columns.');
  let rowCount = sh.rows;
  const header = typeof b.header === 'boolean' && b.header !== sh.header ? b.header : null;
  if (header === true && sh.rows > 0) {
    // The first row becomes the names (keeping the types chosen), and the rows move up by one.
    columns = cleanColumns(sh.example.map((name, i) => ({ name, type: columns[i]!.type })));
    await k.q(`delete from kn_sheet_rows where sheet_id = $1 and ord = 0`, [sheetId]);
    await k.q(`update kn_sheet_rows set ord = ord + 1000000 where sheet_id = $1`, [sheetId]);
    await k.q(`update kn_sheet_rows set ord = ord - 1000001 where sheet_id = $1`, [sheetId]);
    rowCount--;
  } else if (header === false) {
    // The names go back in as the first row, and the columns are numbered.
    await k.q(`update kn_sheet_rows set ord = ord + 1000001 where sheet_id = $1`, [sheetId]);
    await k.q(`update kn_sheet_rows set ord = ord - 1000000 where sheet_id = $1`, [sheetId]);
    await k.q(`insert into kn_sheet_rows (sheet_id, ord, cells) values ($1, 0, $2::jsonb)`, [sheetId, JSON.stringify(columns.map((c) => c.name))]);
    columns = columns.map((c, i) => ({ name: `Column ${i + 1}`, type: c.type }));
    rowCount++;
  }
  await k.q(`update kn_sheets set columns = $3::jsonb, row_count = $4, header = $5 where id = $1 and account_id = $2`, [sheetId, account, JSON.stringify(columns), rowCount, header ?? sh.header]);
  return (await listSheets(k, account, fileId)).find((s) => s.id === sheetId)!;
}

/** Keeps a flagged file as data: the person has seen the warning. */
export async function keepAsData(k: Kdb, account: string, id: string): Promise<boolean> {
  if (!/^[0-9a-f-]{36}$/.test(id)) return false;
  return (await k.q(`update kn_documents set flagged = false where id = $1 and account_id = $2 returning id`, [id, account])).length > 0;
}

export async function finishFile(k: Kdb, account: string, id: string): Promise<{ pieces: number }> {
  await readingFile(k, account, id);
  const [r] = await k.q<{ n: number }>(`select count(*)::int as n from kn_chunks where document_id = $1 and account_id = $2`, [id, account]);
  const [s] = await k.q<{ n: number }>(`select count(*)::int as n from kn_sheets where document_id = $1 and account_id = $2`, [id, account]);
  if (!r?.n && !s?.n) throw new KnError('No text was found in that file.');
  await k.q(`update kn_documents set status = 'ready', chunk_count = $3, updated_at = now() where id = $1 and account_id = $2`, [id, account, r?.n ?? 0]);
  return { pieces: r?.n ?? 0 };
}

export async function listFiles(k: Kdb, account: string): Promise<KnFile[]> {
  const rows = await k.q<{ id: string; name: string; kind: KnKind; collection: string; bytes: number; status: KnFile['status']; error: string | null; chunk_count: number; flagged: boolean; sheets: number; rows: string; created_at: string | Date }>(
    `select d.id, d.name, d.kind, d.collection, d.bytes, d.status, d.error, d.chunk_count, d.flagged, d.created_at,
            (select count(*)::int from kn_sheets s where s.document_id = d.id) as sheets,
            (select coalesce(sum(s.row_count), 0)::bigint from kn_sheets s where s.document_id = d.id) as rows
     from kn_documents d where d.account_id = $1 order by d.created_at desc limit 1000`, [account]);
  return rows.map((r) => ({ id: r.id, name: r.name, kind: r.kind, collection: r.collection, bytes: r.bytes, status: r.status, error: r.error, pieces: r.chunk_count, flagged: r.flagged, sheets: r.sheets, rows: Number(r.rows), addedAt: new Date(r.created_at).toISOString() }));
}

export async function deleteFile(k: Kdb, account: string, id: string): Promise<boolean> {
  if (!/^[0-9a-f-]{36}$/.test(id)) return false;
  return (await k.q(`delete from kn_documents where id = $1 and account_id = $2 returning id`, [id, account])).length > 0;
}

/** Everything one account kept in Knowledge: files, pieces, sheets and what Niko learned. */
export async function purgeAccount(k: Kdb, account: string): Promise<void> {
  await k.q(`delete from kn_documents where account_id = $1`, [account]);
  await k.q(`delete from kn_learned where account_id = $1`, [account]);
}

// ---------------------------------------------------------------- search
export interface KnHit { id: number; fileId: string; file: string; collection: string; heading: string | null; text: string; piece: number; similarity: number; score: number }
/** Finds the pieces that best answer a question: word search and search numbers together (each list's rank counts,
 *  so neither has to be calibrated against the other). `similarity` is how close the closest meaning was (0 to 1),
 *  which the answer uses to decide whether a file leads. Only this account's finished files are searched. */
export async function search(k: Kdb, env: Pick<Env, 'AI'>, account: string, query: string, how: { cloudflare: boolean; vector?: unknown; limit?: number }): Promise<KnHit[]> {
  const q = cleanText(query, 500);
  if (!q) return [];
  const limit = Math.min(Math.max(how.limit ?? 6, 1), 20);
  let vec: string | null = null, col: 'embedding' | 'embedding_device' = 'embedding';
  if (how.cloudflare) vec = vecText((await embed(env, [q]))[0]!);
  else if (how.vector !== undefined) { vec = vecText(checkVector(how.vector, KN_DEVICE_DIMS)); col = 'embedding_device'; }
  // `col` is one of two fixed names above, never from the request.
  const near = vec ? `near as (
      select id, row_number() over (order by dist) as r, 1 - dist as sim from (
        select id, ${col} <=> $3::halfvec as dist from kn_chunks where account_id = $1 and ${col} is not null order by dist limit 30) x),` : `near as (select null::bigint as id, null::bigint as r, null::float8 as sim where false),`;
  const rows = await k.q<{ id: string; document_id: string; name: string; collection: string; heading: string | null; body: string; ord: number; sim: number | null; score: number }>(
    `with ${near}
     words as (
       select id, row_number() over (order by rank desc) as r from (
         select c.id, ts_rank_cd(c.tsv, w) as rank from kn_chunks c, websearch_to_tsquery('simple', $2) w
         where c.account_id = $1 and c.tsv @@ w order by rank desc limit 30) y),
     ids as (select id from near union select id from words)
     select c.id, c.document_id, d.name, d.collection, c.heading, c.body, c.ord, near.sim,
            coalesce(1.0 / (60 + near.r), 0) + coalesce(1.0 / (60 + words.r), 0) as score
     from ids join kn_chunks c on c.id = ids.id
     join kn_documents d on d.id = c.document_id and d.account_id = $1 and d.status = 'ready'
     left join near on near.id = c.id left join words on words.id = c.id
     order by score desc, c.id limit ${limit}`,
    vec ? [account, q, vec] : [account, q]);
  return rows.map((r) => ({ id: Number(r.id), fileId: r.document_id, file: r.name, collection: r.collection, heading: r.heading, text: r.body, piece: r.ord, similarity: r.sim == null ? 0 : Math.max(0, Math.min(1, Number(r.sim))), score: Number(r.score) }));
}

/** Size of the Knowledge database and how many files and people it holds, for the admin. Never what is in them. */
export async function databaseUsage(k: Kdb): Promise<{ bytes: number; files: number; people: number }> {
  const [r] = await k.q<{ bytes: string; files: number; people: number }>(
    `select pg_database_size(current_database())::bigint as bytes, count(*)::int as files, count(distinct account_id)::int as people from kn_documents`);
  return { bytes: Number(r?.bytes ?? 0), files: r?.files ?? 0, people: r?.people ?? 0 };
}
