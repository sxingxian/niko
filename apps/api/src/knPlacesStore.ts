// Keeping copies of Knowledge files in the person's own place (Notion, Google Drive, OneDrive or their S3 storage),
// and reading a copy again when it was changed there. The search pieces and rows stay in Niko's Knowledge database
// either way; these functions only make, check, re-read and remove the copies. Everything is filtered by account.
import {
  KN_PIECE_CHARS, KN_SHEET_MAX_ROWS, KN_SHEET_ROW_PIECES_MAX, looksLikeInstructions, piecesMarkdown, rowPieces, sheetSummary, splitText, toSheet,
  type KnColumn, type KnRemotePlace,
} from '@niko/shared';
import type { Env } from './env';
import { embed, KnError, vecText, type Kdb } from './knowledge';
import { PlaceError, type Remote } from './knPlaces';

const isId = (id: string) => /^[0-9a-f-]{36}$/.test(id);
/** How long a copy's version is trusted before it's checked again. */
export const KN_CHECK_EVERY_MS = 10 * 60_000;
/** Pieces given search numbers again when a changed copy is read back (the rest are found by words until re-read). */
const KN_REREAD_NUMBERED = 480;

// ---------------------------------------------------------------- the folder or page in each place
export async function placeRoot(k: Kdb, remote: Remote, account: string): Promise<{ id: string; name: string }> {
  const [have] = await k.q<{ root_id: string; root_name: string }>(`select root_id, root_name from kn_places where account_id = $1 and place = $2`, [account, remote.place]);
  if (have) return { id: have.root_id, name: have.root_name };
  const made = await remote.makeRoot();
  await k.q(`insert into kn_places (account_id, place, root_id, root_name) values ($1, $2, $3, $4)
             on conflict (account_id, place) do update set root_id = excluded.root_id, root_name = excluded.root_name, created_at = now()`,
    [account, remote.place, made.id, made.name.slice(0, 200)]);
  return { id: made.id, name: made.name };
}
/** A Notion page they picked for the copies (or null: Niko makes its own page next time). */
export async function setRoot(k: Kdb, account: string, place: KnRemotePlace, root: { id: string; name: string } | null): Promise<void> {
  if (!root) { await k.q(`delete from kn_places where account_id = $1 and place = $2`, [account, place]); return; }
  await k.q(`insert into kn_places (account_id, place, root_id, root_name, made) values ($1, $2, $3, $4, false)
             on conflict (account_id, place) do update set root_id = excluded.root_id, root_name = excluded.root_name, made = false, created_at = now()`, [account, place, root.id, root.name.slice(0, 200)]);
}

/** They chose another page or folder in a place: copies already made stay where they are, and everything is copied to the
 *  new one (files when the app next copies, what Niko learned on its next sync). Niko's own page or folder for the old
 *  choice is forgotten, so the next copy makes the new one. */
export async function relocate(k: Kdb, account: string, place: KnRemotePlace): Promise<{ files: number; learned: boolean }> {
  await k.q(`delete from kn_places where account_id = $1 and place = $2 and made`, [account, place]);
  const files = await k.q(`update kn_documents set remote_id = null, remote_url = null, remote_version = null, remote_checked_at = null, remote_error = null
     where account_id = $1 and place = $2 returning id`, [account, place]);
  if (files.length) await k.q(`update kn_sheets s set remote_id = null, remote_url = null, remote_version = null, remote_rows = 0 from kn_documents d
     where d.id = s.document_id and s.account_id = $1 and d.place = $2`, [account, place]);
  const learned = await k.q(`update kn_learned_copy set remote_id = null, remote_url = null, written = null, picked = null, dirty = true, synced_at = null, error = null
     where account_id = $1 and place = $2 returning account_id`, [account, place]);
  return { files: files.length, learned: learned.length > 0 };
}
/** A copy of what Niko learned in this place that was never written, or failed last time: choosing the same page or
 *  folder again writes it, instead of doing nothing. */
export async function learnedPending(k: Kdb, account: string, place: KnRemotePlace): Promise<boolean> {
  return (await k.q(`select 1 from kn_learned_copy where account_id = $1 and place = $2 and (remote_id is null or dirty or error is not null)`, [account, place])).length > 0;
}
export async function roots(k: Kdb, account: string): Promise<Partial<Record<KnRemotePlace, string>>> {
  return Object.fromEntries(Object.entries(await rootsMade(k, account)).map(([p, r]) => [p, r!.name]));
}
/** Niko's page or folder in each place, and whether Niko made it (false: a page they picked). */
export async function rootsMade(k: Kdb, account: string): Promise<Partial<Record<KnRemotePlace, { name: string; made: boolean }>>> {
  const rows = await k.q<{ place: KnRemotePlace; root_name: string; made: boolean }>(`select place, root_name, made from kn_places where account_id = $1`, [account]);
  return Object.fromEntries(rows.map((r) => [r.place, { name: r.root_name, made: r.made !== false }]));
}

// ---------------------------------------------------------------- copying a file there
type DocRow = { id: string; name: string; status: string; place: string; remote_id: string | null };
type SheetRow = { id: string; name: string; columns: KnColumn[]; row_count: number; remote_id: string | null; remote_version: string | null; remote_rows: number };
const baseName = (name: string) => name.replace(/\.[^.]+$/, '') || name;
async function docOf(k: Kdb, account: string, id: string): Promise<DocRow> {
  if (!isId(id)) throw new KnError('No such file.', 404);
  const [d] = await k.q<DocRow>(`select id, name, status, place, remote_id from kn_documents where id = $1 and account_id = $2`, [id, account]);
  if (!d) throw new KnError('No such file.', 404);
  if (d.status !== 'ready') throw new KnError('That file is still being added.', 409);
  return d;
}
const sheetsOf = (k: Kdb, account: string, id: string) => k.q<SheetRow>(
  `select id, name, columns, row_count, remote_id, remote_version, remote_rows from kn_sheets where document_id = $1 and account_id = $2 order by name`, [id, account]);

/**
 * One step of copying a file to their place: a whole document, or one sheet (Notion: the next rows of it). Call it
 * until `done`. A file that was in another place starts again here; the copies left there stay where they are.
 */
export async function copyStep(k: Kdb, remote: Remote, account: string, id: string): Promise<{ done: boolean; rows?: { done: number; total: number } }> {
  const doc = await docOf(k, account, id);
  if (doc.place !== remote.place) {
    await k.q(`update kn_documents set place = $3, remote_id = null, remote_url = null, remote_version = null, remote_checked_at = null, remote_error = null where id = $1 and account_id = $2`, [id, account, remote.place]);
    await k.q(`update kn_sheets set remote_id = null, remote_url = null, remote_version = null, remote_rows = 0 where document_id = $1 and account_id = $2`, [id, account]);
    doc.remote_id = null;
  }
  const fail = async (e: unknown) => {
    // A folder or page they deleted there is made again next time.
    if (e instanceof PlaceError && e.gone) await k.q(`delete from kn_places where account_id = $1 and place = $2`, [account, remote.place]);
    const msg = e instanceof PlaceError || e instanceof KnError ? e.message : 'The copy couldn’t be made.';
    await k.q(`update kn_documents set remote_error = $3 where id = $1 and account_id = $2`, [id, account, msg.slice(0, 300)]);
    throw e instanceof PlaceError ? new KnError(msg, e.status === 401 || e.status === 403 ? 409 : 502) : e;
  };
  try {
    const root = await placeRoot(k, remote, account);
    const sheets = await sheetsOf(k, account, id);
    if (!sheets.length) {
      if (!doc.remote_id) {
        const pieces = await k.q<{ heading: string | null; body: string }>(`select heading, body from kn_chunks where document_id = $1 and account_id = $2 order by ord`, [id, account]);
        const w = await remote.writeDoc(root.id, baseName(doc.name), piecesMarkdown(pieces));
        await k.q(`update kn_documents set remote_id = $3, remote_url = $4, remote_version = $5, remote_checked_at = now(), remote_error = null where id = $1 and account_id = $2`,
          [id, account, w.id, w.url, w.version ?? '']);
      }
      return { done: true };
    }
    const sh = sheets.find((s) => s.remote_version === null);
    if (!sh) { await k.q(`update kn_documents set remote_error = null, remote_checked_at = now() where id = $1 and account_id = $2`, [id, account]); return { done: true }; }
    const rows = (await k.q<{ cells: string[] }>(`select cells from kn_sheet_rows where sheet_id = $1 order by ord`, [sh.id])).map((r) => r.cells.map(String));
    const title = sheets.length > 1 ? `${baseName(doc.name)} › ${sh.name}` : baseName(doc.name);
    const w = await remote.writeSheet(root.id, { title, columns: sh.columns.map((c) => c.name), rows }, { id: sh.remote_id, done: sh.remote_rows });
    const finished = w.done >= rows.length;
    await k.q(`update kn_sheets set remote_id = $2, remote_url = coalesce($3, remote_url), remote_rows = $4, remote_version = $5 where id = $1`,
      [sh.id, w.id, w.url, w.done, finished ? w.version ?? '' : null]);
    const left = sheets.some((s) => s.id !== sh.id && s.remote_version === null);
    if (finished && !left) await k.q(`update kn_documents set remote_error = null, remote_checked_at = now() where id = $1 and account_id = $2`, [id, account]);
    return { done: finished && !left, rows: { done: w.done, total: rows.length } };
  } catch (e) { return fail(e); }
}

/** Files in Niko not yet copied to this place (or whose copy failed), in the order they were added. */
export async function notCopied(k: Kdb, account: string, place: KnRemotePlace): Promise<string[]> {
  const rows = await k.q<{ id: string }>(
    // Datasets from data sources are fetched again by Niko on their own schedule, so they aren't copied.
    `select d.id from kn_documents d where d.account_id = $1 and d.status = 'ready' and d.collection <> 'Data sources' and (
       d.place <> $2
       or (not exists (select 1 from kn_sheets s where s.document_id = d.id) and d.remote_id is null)
       or exists (select 1 from kn_sheets s where s.document_id = d.id and s.remote_version is null))
     order by d.created_at`, [account, place]);
  return rows.map((r) => r.id);
}
/** Moving back to Niko: Niko stops using the copies (they stay in that place). */
export async function leavePlaces(k: Kdb, account: string): Promise<void> {
  await k.q(`update kn_documents set place = 'niko', remote_id = null, remote_url = null, remote_version = null, remote_checked_at = null, remote_error = null where account_id = $1 and place <> 'niko'`, [account]);
  await k.q(`update kn_sheets set remote_id = null, remote_url = null, remote_version = null, remote_rows = 0 where account_id = $1 and remote_id is not null`, [account]);
}

/** The copies of one file, for moving them to the bin when the file is removed from Knowledge. */
export async function copiesOf(k: Kdb, account: string, id: string): Promise<{ place: KnRemotePlace; items: { id: string; kind: 'doc' | 'sheet' }[] } | null> {
  if (!isId(id)) return null;
  const [d] = await k.q<{ place: string; remote_id: string | null }>(`select place, remote_id from kn_documents where id = $1 and account_id = $2`, [id, account]);
  if (!d || d.place === 'niko') return null;
  const sheets = await k.q<{ remote_id: string }>(`select remote_id from kn_sheets where document_id = $1 and account_id = $2 and remote_id is not null`, [id, account]);
  const items = [...(d.remote_id ? [{ id: d.remote_id, kind: 'doc' as const }] : []), ...sheets.map((s) => ({ id: s.remote_id, kind: 'sheet' as const }))];
  return items.length ? { place: d.place as KnRemotePlace, items } : null;
}

// ---------------------------------------------------------------- reading a changed copy again
/** Used files kept elsewhere whose copies are due a check, from the files an answer used. */
export async function dueForCheck(k: Kdb, account: string, ids: string[]): Promise<{ id: string; place: KnRemotePlace }[]> {
  const list = [...new Set(ids)].filter(isId).slice(0, 20);
  if (!list.length) return [];
  return k.q<{ id: string; place: KnRemotePlace }>(
    `select id, place from kn_documents where account_id = $1 and id = any($2::uuid[]) and place <> 'niko' and status = 'ready'
       and (remote_checked_at is null or remote_checked_at < now() - interval '${KN_CHECK_EVERY_MS / 1000} seconds')
     order by remote_checked_at nulls first limit 2`, [account, list]);
}

export type Embedder = (texts: string[]) => Promise<number[][]>;
/** Puts new pieces in place of a file's old ones, with search numbers for the first few hundred. */
async function replacePieces(k: Kdb, env: Pick<Env, 'AI'>, account: string, id: string, pieces: { heading: string | null; body: string }[], how: { cloudflare: boolean; own?: Embedder }): Promise<void> {
  await k.q(`delete from kn_chunks where document_id = $1 and account_id = $2`, [id, account]);
  for (let i = 0; i < pieces.length; i += 48) {
    const batch = pieces.slice(i, i + 48).map((p) => ({ heading: p.heading?.slice(0, 200) ?? null, body: p.body.slice(0, KN_PIECE_CHARS) })).filter((p) => p.body.trim());
    if (!batch.length) continue;
    const texts = batch.map((p) => (p.heading ? `${p.heading}\n${p.body}` : p.body));
    const numbered = i < KN_REREAD_NUMBERED;
    const cf = numbered && how.cloudflare && !how.own ? (await embed(env, texts)).map(vecText) : batch.map(() => null);
    const own = numbered && how.own ? (await how.own(texts)).map(vecText) : batch.map(() => null);
    await k.q(
      `insert into kn_chunks (account_id, document_id, ord, heading, body, embedding, embedding_own)
       select $1, $2, t.o, t.h, t.b, t.e::halfvec, t.w::halfvec from unnest($3::int[], $4::text[], $5::text[], $6::text[], $7::text[]) as t(o, h, b, e, w)
       on conflict (document_id, ord) do nothing`,
      [account, id, batch.map((_, j) => i + j), batch.map((p) => p.heading), batch.map((p) => p.body), cf, own]);
  }
  await k.q(`update kn_documents set chunk_count = (select count(*) from kn_chunks where document_id = $1), updated_at = now() where id = $1 and account_id = $2`, [id, account]);
}

/**
 * Checks the copies of one file and, when one was changed there, reads it again: new pieces (and rows, for sheets),
 * kept columns' types where the names still match. A copy deleted there leaves the file in Niko with a note.
 */
export async function refreshFile(k: Kdb, env: Pick<Env, 'AI'>, remote: Remote, account: string, id: string, how: { cloudflare: boolean; own?: Embedder }): Promise<'same' | 'updated' | 'gone'> {
  const [d] = await k.q<{ name: string; place: string; remote_id: string | null; remote_version: string | null }>(
    `select name, place, remote_id, remote_version from kn_documents where id = $1 and account_id = $2 and status = 'ready'`, [id, account]);
  if (!d || d.place !== remote.place) return 'same';
  const checked = () => k.q(`update kn_documents set remote_checked_at = now() where id = $1 and account_id = $2`, [id, account]);
  const gone = async () => {
    await k.q(`update kn_documents set remote_checked_at = now(), remote_error = $3 where id = $1 and account_id = $2`, [id, account, `Not in your ${placeName(remote.place)} any more. Niko still has it; remove it, or copy it there again.`]);
    return 'gone' as const;
  };
  const sheets = await sheetsOf(k, account, id);
  try {
    if (!sheets.length) {
      if (!d.remote_id) return 'same';
      const v = await remote.version(d.remote_id, 'doc');
      if (v === null) return gone();
      if (v === d.remote_version) { await checked(); return 'same'; }
      const text = await remote.readDoc(d.remote_id);
      await replacePieces(k, env, account, id, splitText(text), how);
      await k.q(`update kn_documents set remote_version = $3, remote_checked_at = now(), remote_error = null, flagged = flagged or $4 where id = $1 and account_id = $2`, [id, account, v, looksLikeInstructions(text)]);
      return 'updated';
    }
    let changed = false, flagged = false;
    for (const sh of sheets) {
      if (!sh.remote_id || sh.remote_version === null) continue;
      const v = await remote.version(sh.remote_id, 'sheet');
      if (v === null) return gone();
      if (v === sh.remote_version) continue;
      const rows = (await remote.readSheet(sh.remote_id)).slice(0, KN_SHEET_MAX_ROWS + 1);
      const fresh = toSheet(sh.name, rows.length ? rows : [sh.columns.map((c) => c.name)], true);
      // Keep the types they chose for columns that are still there.
      const columns = fresh.columns.map((c) => ({ name: c.name, type: sh.columns.find((o) => o.name.toLowerCase() === c.name.toLowerCase())?.type ?? c.type }));
      await k.q(`delete from kn_sheet_rows where sheet_id = $1`, [sh.id]);
      for (let i = 0; i < fresh.rows.length; i += 1000) {
        const part = fresh.rows.slice(i, i + 1000);
        await k.q(`insert into kn_sheet_rows (sheet_id, ord, cells) select $1, t.o, t.c::jsonb from unnest($2::int[], $3::text[]) as t(o, c)`, [sh.id, part.map((_, j) => i + j), part.map((r) => JSON.stringify(r))]);
      }
      await k.q(`update kn_sheets set columns = $2::jsonb, row_count = $3, header = true, remote_version = $4, remote_rows = $3 where id = $1`, [sh.id, JSON.stringify(columns), fresh.rows.length, v]);
      flagged ||= fresh.rows.some((r) => looksLikeInstructions(r.join(' ')));
      changed = true;
    }
    if (!changed) { await checked(); return 'same'; }
    // The row pieces are made again from every sheet of the file.
    const all = await k.q<{ name: string; columns: KnColumn[]; id: string; row_count: number }>(`select id, name, columns, row_count from kn_sheets where document_id = $1 order by name`, [id]);
    const pieces = [];
    for (const s of all) {
      if (s.row_count > KN_SHEET_ROW_PIECES_MAX) { pieces.push(sheetSummary({ name: s.name, columns: s.columns, rows: new Array<string[]>(s.row_count), header: true })); continue; }
      const rows = (await k.q<{ cells: string[] }>(`select cells from kn_sheet_rows where sheet_id = $1 order by ord`, [s.id])).map((r) => r.cells.map(String));
      pieces.push(...rowPieces({ name: s.name, columns: s.columns, rows, header: true }));
    }
    await replacePieces(k, env, account, id, pieces, how);
    await k.q(`update kn_documents set remote_checked_at = now(), remote_error = null, flagged = flagged or $3 where id = $1 and account_id = $2`, [id, account, flagged]);
    return 'updated';
  } catch (e) {
    if (e instanceof PlaceError && e.gone) return gone();
    // A connection problem leaves the pieces as they are; it's tried again after the next wait.
    await checked();
    throw e;
  }
}
export const placeName = (p: KnRemotePlace) => ({ notion: 'Notion', gdrive: 'Google Drive', onedrive: 'OneDrive', s3: 'storage', obsidian: 'vault' } as Record<KnRemotePlace, string>)[p];
