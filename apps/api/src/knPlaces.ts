// Knowledge kept in the person's own Notion, Google Drive or OneDrive (and, in knStorage.ts, their own S3 storage).
// Each place gets a copy of every file, made by Niko in its own folder or page there: documents as a page / Google Doc /
// .md file, spreadsheets one sheet at a time as a database / Google Sheet / .csv file. Niko still keeps the search
// pieces and rows itself, so search and totals work the same; when a copy is edited there, it is read again the next
// time it's used. Every call uses the person's own connection, with the narrowest access each app offers: Drive's
// "only files this app made", OneDrive's own app folder, and in Notion only the pages Niko makes or they pick.
// Text from these places is the person's own file text: it's searched and quoted as data, never followed.
import type { Db } from '@niko/db';
import { parseDelimited, sheetCsv, type KnRemotePlace } from '@niko/shared';
import type { Env } from './env';
import { credentials, getConnection } from './providers';

export class PlaceError extends Error {
  constructor(message: string, readonly status = 502, readonly gone = false) { super(message); }
}
export interface Written { id: string; url: string | null; version: string | null }
export interface SheetOut { title: string; columns: string[]; rows: string[][] }
/** One place, signed in as one person. */
export interface Remote {
  place: KnRemotePlace;
  /** Makes Niko's own folder or page there ("Niko Knowledge"), the first time. */
  makeRoot(): Promise<{ id: string; name: string; url?: string | null }>;
  writeDoc(root: string, title: string, markdown: string): Promise<Written>;
  /** Writes a sheet, or (for places that take rows a few at a time) the next rows of it. `done` counts rows written. */
  writeSheet(root: string, sheet: SheetOut, state: { id: string | null; done: number }): Promise<Written & { done: number }>;
  /** The copy's current version, or null when it's gone (deleted or in the bin). */
  version(id: string, kind: 'doc' | 'sheet'): Promise<string | null>;
  readDoc(id: string): Promise<string>;
  /** The sheet's rows, its column names first. */
  readSheet(id: string): Promise<string[][]>;
  /** Moves the copy to the bin there (recoverable in Notion, Drive and OneDrive). */
  trash(id: string, kind: 'doc' | 'sheet'): Promise<void>;
}

export const ROOT_NAME = 'Niko Knowledge';
const ROOT_NOTE = 'Files Niko keeps for you. Edit them here: Niko reads the changes the next time it uses a file.';
const MB = 1024 * 1024;
const PLACE_NAMES: Record<KnRemotePlace, string> = { notion: 'Notion', gdrive: 'Google Drive', onedrive: 'OneDrive', s3: 'your storage' };
/** A file name that's safe in every place: no slashes or control characters, not too long. */
export const safeName = (s: string) => s.replace(/[\u0000-\u001f\u007f/\\:*?"<>|#%]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) || 'File';
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** One request with the person's token. Problems are said plainly and never include the token. */
async function call(place: KnRemotePlace, url: string, token: string, init: RequestInit & { json?: unknown } = {}): Promise<Response> {
  const headers: Record<string, string> = { authorization: `Bearer ${token}`, ...(init.headers as Record<string, string> | undefined) };
  let body = init.body;
  if (init.json !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(init.json); }
  let res: Response;
  try { res = await fetch(url, { ...init, headers, body, redirect: 'manual', signal: AbortSignal.timeout(25_000) }); }
  catch { throw new PlaceError(`${PLACE_NAMES[place]} didn’t answer in time. Try again in a moment.`); }
  if (res.status === 401) throw new PlaceError(`Your ${PLACE_NAMES[place]} connection has expired. Connect it again under Connections.`, 401);
  if (res.status === 403) throw new PlaceError(place === 'notion'
    ? 'Notion didn’t let Niko add or change pages. In your Notion integration, tick Insert content and Update content, then connect Notion again.'
    : `${PLACE_NAMES[place]} didn’t allow that. Connect it again under Connections.`, 403);
  if (res.status === 404) throw new PlaceError(`That copy isn’t in ${PLACE_NAMES[place]} any more.`, 404, true);
  if (res.status === 429) throw new PlaceError(`${PLACE_NAMES[place]} asked Niko to slow down. Try again in a minute.`, 429);
  if (res.status >= 400) throw new PlaceError(`${PLACE_NAMES[place]} answered ${res.status}.`);
  return res;
}
const json = async <T>(res: Response) => (await res.json().catch(() => ({}))) as T;

// ---------------------------------------------------------------- Notion
const NOTION = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';
/** Notion takes about three requests a second. */
const NOTION_GAP = 340;
/** Rows a database gets per request to Niko (each row is one request to Notion). */
export const NOTION_ROWS_PER_CALL = 20;
type Rich = { type: 'text'; text: { content: string } }[];
const rich = (s: string): Rich => (s.match(/[\s\S]{1,1900}/g) ?? ['']).slice(0, 100).map((content) => ({ type: 'text', text: { content } }));
const plain = (r: unknown) => (Array.isArray(r) ? r.map((x) => String((x as { plain_text?: unknown }).plain_text ?? '')).join('') : '');
/** Markdown into Notion blocks: headings, list items, quotes and paragraphs. */
export function notionBlocks(md: string): unknown[] {
  const out: unknown[] = [];
  for (const para of md.split(/\n\s*\n/)) {
    for (const line of para.split('\n').length > 1 && para.split('\n').every((l) => /^\s*([-*]|\d+\.)\s/.test(l)) ? para.split('\n') : [para]) {
      const t = line.trim();
      if (!t) continue;
      const h = /^(#{1,6})\s+(.+)$/.exec(t);
      const block = (type: string, text: string) => ({ object: 'block', type, [type]: { rich_text: rich(text) } });
      if (h) out.push(block(`heading_${Math.min(3, h[1]!.length)}`, h[2]!));
      else if (/^[-*]\s/.test(t)) out.push(block('bulleted_list_item', t.slice(2)));
      else if (/^\d+\.\s/.test(t)) out.push(block('numbered_list_item', t.replace(/^\d+\.\s/, '')));
      else if (/^>\s?/.test(t)) out.push(block('quote', t.replace(/^>\s?/, '')));
      else out.push(block('paragraph', t));
    }
  }
  return out;
}
/** Notion blocks back into Markdown (the top level of the page). */
export function notionMarkdown(blocks: { type?: string; [k: string]: unknown }[]): string {
  const out: string[] = [];
  for (const b of blocks) {
    const t = String(b.type ?? '');
    const text = plain((b[t] as { rich_text?: unknown } | undefined)?.rich_text);
    if (!text.trim()) continue;
    if (t.startsWith('heading_')) out.push(`${'#'.repeat(Number(t.slice(8)) || 1)} ${text}`, '');
    else if (t === 'bulleted_list_item' || t === 'to_do') out.push(`- ${text}`);
    else if (t === 'numbered_list_item') out.push(`1. ${text}`);
    else if (t === 'quote' || t === 'callout') out.push(`> ${text}`, '');
    else out.push(text, '');
  }
  return out.join('\n');
}
function notion(token: string): Remote {
  const h = { 'notion-version': NOTION_VERSION };
  const req = (path: string, init: RequestInit & { json?: unknown } = {}) => call('notion', `${NOTION}${path}`, token, { ...init, headers: { ...h, ...(init.headers as Record<string, string> | undefined) } });
  const title = (s: string) => ({ title: { title: rich(s.slice(0, 200)) } });
  const lastRowEdit = async (id: string) => {
    const j = await json<{ results?: { last_edited_time?: string }[] }>(await req(`/databases/${id}/query`, { method: 'POST', json: { page_size: 1, sorts: [{ timestamp: 'last_edited_time', direction: 'descending' }] } }));
    return j.results?.[0]?.last_edited_time ?? '';
  };
  const columnNames = (cols: string[]) => {
    const seen = new Set<string>();
    return cols.map((c, i) => { let n = (c.trim() || `Column ${i + 1}`).slice(0, 90); while (seen.has(n.toLowerCase())) n = `${n} (${i + 1})`; seen.add(n.toLowerCase()); return n; });
  };
  return {
    place: 'notion',
    async makeRoot() {
      // A private page in their workspace (public integrations may make one there).
      const p = await json<{ id: string; url?: string }>(await req('/pages', { method: 'POST', json: { parent: { type: 'workspace', workspace: true }, properties: title(ROOT_NAME), children: notionBlocks(ROOT_NOTE) } }));
      return { id: p.id, name: ROOT_NAME, url: p.url ?? null };
    },
    async writeDoc(root, name, markdown) {
      const blocks = notionBlocks(markdown);
      const page = await json<{ id: string; url?: string }>(await req('/pages', { method: 'POST', json: { parent: { type: 'page_id', page_id: root }, properties: title(name), children: blocks.slice(0, 100) } }));
      for (let i = 100; i < blocks.length; i += 100) { await wait(NOTION_GAP); await req(`/blocks/${page.id}/children`, { method: 'PATCH', json: { children: blocks.slice(i, i + 100) } }); }
      return { id: page.id, url: page.url ?? null, version: await this.version(page.id, 'doc') };
    },
    async writeSheet(root, sheet, state) {
      const names = columnNames(sheet.columns);
      let id = state.id, url: string | null = null;
      if (!id) {
        const properties = Object.fromEntries(names.map((n, i) => [n, i === 0 ? { title: {} } : { rich_text: {} }]));
        const d = await json<{ id: string; url?: string }>(await req('/databases', { method: 'POST', json: { parent: { type: 'page_id', page_id: root }, title: rich(sheet.title.slice(0, 200)), properties } }));
        id = d.id; url = d.url ?? null;
      }
      let done = state.done;
      for (const row of sheet.rows.slice(done, done + NOTION_ROWS_PER_CALL)) {
        await wait(NOTION_GAP);
        const properties = Object.fromEntries(names.map((n, i) => [n, i === 0 ? { title: rich(row[i] ?? '') } : { rich_text: rich(row[i] ?? '') }]));
        await req('/pages', { method: 'POST', json: { parent: { database_id: id }, properties } });
        done++;
      }
      return { id, url, done, version: done >= sheet.rows.length ? await this.version(id, 'sheet') : null };
    },
    async version(id, kind) {
      try {
        if (kind === 'doc') {
          const p = await json<{ last_edited_time?: string; archived?: boolean; in_trash?: boolean }>(await req(`/pages/${id}`));
          return p.archived || p.in_trash ? null : p.last_edited_time ?? '';
        }
        const d = await json<{ last_edited_time?: string; archived?: boolean; in_trash?: boolean }>(await req(`/databases/${id}`));
        if (d.archived || d.in_trash) return null;
        return `${d.last_edited_time ?? ''}|${await lastRowEdit(id)}`;
      } catch (e) { if (e instanceof PlaceError && e.gone) return null; throw e; }
    },
    async readDoc(id) {
      const blocks: { type?: string }[] = [];
      for (let cursor: string | undefined, n = 0; n < 20; n++) {
        const j = await json<{ results?: { type?: string }[]; has_more?: boolean; next_cursor?: string }>(await req(`/blocks/${id}/children?page_size=100${cursor ? `&start_cursor=${encodeURIComponent(cursor)}` : ''}`));
        blocks.push(...(j.results ?? []));
        if (!j.has_more || !j.next_cursor) break;
        cursor = j.next_cursor;
      }
      return notionMarkdown(blocks as { type?: string; [k: string]: unknown }[]);
    },
    async readSheet(id) {
      const d = await json<{ properties?: Record<string, { type?: string }> }>(await req(`/databases/${id}`));
      const props = Object.entries(d.properties ?? {});
      // The title column first, then the rest in the order Notion gives.
      const cols = [...props.filter(([, p]) => p.type === 'title'), ...props.filter(([, p]) => p.type !== 'title')].map(([n]) => n);
      const rows: string[][] = [cols];
      // At most 40 pages of 100 rows are read back in one go (each is a request); bigger databases aren't re-read.
      for (let cursor: string | undefined, n = 0; n < 40; n++) {
        const j = await json<{ results?: { properties?: Record<string, Record<string, unknown>> }[]; has_more?: boolean; next_cursor?: string }>(await req(`/databases/${id}/query`, { method: 'POST', json: { page_size: 100, sorts: [{ timestamp: 'created_time', direction: 'ascending' }], ...(cursor ? { start_cursor: cursor } : {}) } }));
        for (const r of j.results ?? []) rows.push(cols.map((c) => { const v = r.properties?.[c]; const t = String(v?.type ?? ''); const x = v?.[t]; return Array.isArray(x) ? plain(x) : x == null ? '' : typeof x === 'object' ? String((x as { name?: unknown }).name ?? '') : String(x); }));
        if (!j.has_more || !j.next_cursor) return rows;
        if (n === 39) throw new PlaceError('That Notion database is too big to read back (over 4,000 rows). Changes made in Notion aren’t picked up for it.', 413);
        cursor = j.next_cursor;
      }
      return rows;
    },
    async trash(id, kind) {
      await req(kind === 'doc' ? `/pages/${id}` : `/databases/${id}`, { method: 'PATCH', json: { archived: true } });
    },
  };
}
/** Pages Niko can see in their Notion (the ones they shared when connecting), to pick where copies go. */
export async function notionPages(token: string): Promise<{ id: string; title: string }[]> {
  const j = await json<{ results?: { id: string; properties?: Record<string, { type?: string; title?: unknown }>; archived?: boolean; in_trash?: boolean; parent?: { type?: string } }[] }>(await call('notion', `${NOTION}/search`, token, {
    method: 'POST', headers: { 'notion-version': NOTION_VERSION }, json: { page_size: 50, filter: { property: 'object', value: 'page' }, sort: { direction: 'descending', timestamp: 'last_edited_time' } },
  }));
  return (j.results ?? []).filter((p) => !p.archived && !p.in_trash && p.parent?.type !== 'database_id')
    .map((p) => ({ id: p.id, title: plain(Object.values(p.properties ?? {}).find((x) => x.type === 'title')?.title).slice(0, 120) || 'Untitled' }));
}
/** Checks Niko can see a page they picked, and gives its title. */
export async function notionPage(token: string, id: string): Promise<{ id: string; title: string; url: string | null }> {
  if (!/^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i.test(id)) throw new PlaceError('That isn’t a Notion page.', 400);
  const p = await json<{ id: string; url?: string; archived?: boolean; in_trash?: boolean; properties?: Record<string, { type?: string; title?: unknown }> }>(await call('notion', `${NOTION}/pages/${id}`, token, { headers: { 'notion-version': NOTION_VERSION } }));
  if (p.archived || p.in_trash) throw new PlaceError('That Notion page is in the trash.', 400);
  return { id: p.id, url: p.url ?? null, title: plain(Object.values(p.properties ?? {}).find((x) => x.type === 'title')?.title).slice(0, 120) || 'Untitled' };
}

// ---------------------------------------------------------------- Google Drive
const DRIVE = 'https://www.googleapis.com/drive/v3';
const DRIVE_UP = 'https://www.googleapis.com/upload/drive/v3';
const G_DOC = 'application/vnd.google-apps.document', G_SHEET = 'application/vnd.google-apps.spreadsheet', G_FOLDER = 'application/vnd.google-apps.folder';
function gdrive(token: string): Remote {
  const FIELDS = 'id,webViewLink,version,trashed';
  /** Uploads a file Google turns into a Doc or Sheet: in one request when small, otherwise in a resumable upload. */
  const upload = async (meta: Record<string, unknown>, body: string, type: string): Promise<{ id: string; webViewLink?: string; version?: string }> => {
    const bytes = new TextEncoder().encode(body);
    if (bytes.length <= 4 * MB) {
      const boundary = `niko${crypto.randomUUID().replace(/-/g, '')}`;
      const parts = `--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\ncontent-type: ${type}; charset=UTF-8\r\n\r\n${body}\r\n--${boundary}--`;
      return json(await call('gdrive', `${DRIVE_UP}/files?uploadType=multipart&fields=${FIELDS}`, token, { method: 'POST', headers: { 'content-type': `multipart/related; boundary=${boundary}` }, body: parts }));
    }
    const start = await call('gdrive', `${DRIVE_UP}/files?uploadType=resumable&fields=${FIELDS}`, token, { method: 'POST', headers: { 'x-upload-content-type': type }, json: meta });
    const at = start.headers.get('location') ?? '';
    if (!at.startsWith('https://www.googleapis.com/upload/drive/')) throw new PlaceError('Google Drive didn’t start the upload.');
    return json(await call('gdrive', at, token, { method: 'PUT', headers: { 'content-type': type }, body: bytes }));
  };
  const exportAs = async (id: string, type: string) => (await call('gdrive', `${DRIVE}/files/${id}/export?mimeType=${encodeURIComponent(type)}`, token)).text();
  return {
    place: 'gdrive',
    async makeRoot() {
      const f = await json<{ id: string; webViewLink?: string }>(await call('gdrive', `${DRIVE}/files?fields=id,webViewLink`, token, { method: 'POST', json: { name: ROOT_NAME, mimeType: G_FOLDER, description: ROOT_NOTE } }));
      return { id: f.id, name: ROOT_NAME, url: f.webViewLink ?? null };
    },
    async writeDoc(root, title, markdown) {
      // Google turns Markdown into a Doc with real headings; older behaviour (plain text) is the fallback.
      const meta = { name: title, parents: [root], mimeType: G_DOC };
      const f = await upload(meta, markdown, 'text/markdown').catch((e) => (e instanceof PlaceError && e.status === 502 ? upload(meta, markdown, 'text/plain') : Promise.reject(e)));
      return { id: f.id, url: f.webViewLink ?? null, version: f.version ?? null };
    },
    async writeSheet(root, sheet) {
      const f = await upload({ name: sheet.title, parents: [root], mimeType: G_SHEET }, sheetCsv(sheet.columns.map((name) => ({ name })), sheet.rows), 'text/csv');
      return { id: f.id, url: f.webViewLink ?? null, version: f.version ?? null, done: sheet.rows.length };
    },
    async version(id) {
      try {
        const f = await json<{ version?: string; trashed?: boolean }>(await call('gdrive', `${DRIVE}/files/${id}?fields=version,trashed`, token));
        return f.trashed ? null : f.version ?? '';
      } catch (e) { if (e instanceof PlaceError && e.gone) return null; throw e; }
    },
    async readDoc(id) { return exportAs(id, 'text/markdown').catch(() => exportAs(id, 'text/plain')); },
    async readSheet(id) { return parseDelimited(await exportAs(id, 'text/csv'), ','); },
    async trash(id) { await call('gdrive', `${DRIVE}/files/${id}`, token, { method: 'PATCH', json: { trashed: true } }); },
  };
}

// ---------------------------------------------------------------- OneDrive
const GRAPH = 'https://graph.microsoft.com/v1.0/me/drive';
/** Where OneDrive sends a file's content: only Microsoft's own download hosts are followed (without the token). */
const MS_DOWNLOAD = /(^|\.)(sharepoint\.com|1drv\.com|onedrive\.com|live\.net|svc\.ms|files\.1drv\.com)$/i;
function onedrive(token: string): Remote {
  const put = async (root: string, name: string, body: string, type: string): Promise<{ id: string; webUrl?: string; cTag?: string }> => {
    const path = `${GRAPH}/items/${encodeURIComponent(root)}:/${encodeURIComponent(name)}:`;
    const bytes = new TextEncoder().encode(body);
    if (bytes.length <= 4 * MB) return json(await call('onedrive', `${path}/content?@microsoft.graph.conflictBehavior=rename`, token, { method: 'PUT', headers: { 'content-type': type }, body: bytes }));
    // Bigger files go in an upload session, in one piece (sessions take up to 60 MB at once).
    const s = await json<{ uploadUrl?: string }>(await call('onedrive', `${path}/createUploadSession`, token, { method: 'POST', json: { item: { '@microsoft.graph.conflictBehavior': 'rename' } } }));
    const at = (() => { try { return new URL(s.uploadUrl ?? ''); } catch { return null; } })();
    if (!at || at.protocol !== 'https:' || !MS_DOWNLOAD.test(at.hostname) && !at.hostname.endsWith('.microsoft.com')) throw new PlaceError('OneDrive didn’t start the upload.');
    let res: Response;
    try { res = await fetch(at, { method: 'PUT', headers: { 'content-range': `bytes 0-${bytes.length - 1}/${bytes.length}` }, body: bytes, redirect: 'manual', signal: AbortSignal.timeout(60_000) }); }
    catch { throw new PlaceError('OneDrive didn’t answer in time. Try again in a moment.'); }
    if (!res.ok) throw new PlaceError(`OneDrive answered ${res.status}.`);
    return json(res);
  };
  const content = async (id: string) => {
    const res = await call('onedrive', `${GRAPH}/items/${encodeURIComponent(id)}/content`, token);
    if (res.status !== 302 && res.status !== 301) return res.text();
    const at = (() => { try { return new URL(res.headers.get('location') ?? ''); } catch { return null; } })();
    if (!at || at.protocol !== 'https:' || !MS_DOWNLOAD.test(at.hostname)) throw new PlaceError('OneDrive sent the file from an address Niko doesn’t know.');
    const r = await fetch(at, { redirect: 'error', signal: AbortSignal.timeout(25_000) }).catch(() => null);
    if (!r?.ok) throw new PlaceError('OneDrive didn’t send the file.');
    return r.text();
  };
  return {
    place: 'onedrive',
    async makeRoot() {
      const app = await json<{ id: string }>(await call('onedrive', `${GRAPH}/special/approot`, token));
      const made = await call('onedrive', `${GRAPH}/items/${encodeURIComponent(app.id)}/children`, token, { method: 'POST', json: { name: ROOT_NAME, folder: {}, '@microsoft.graph.conflictBehavior': 'fail' } }).catch(async (e) => {
        if (e instanceof PlaceError && e.status === 502) return call('onedrive', `${GRAPH}/special/approot:/${encodeURIComponent(ROOT_NAME)}`, token);
        throw e;
      });
      const f = await json<{ id: string; webUrl?: string }>(made);
      return { id: f.id, name: ROOT_NAME, url: f.webUrl ?? null };
    },
    async writeDoc(root, title, markdown) {
      const f = await put(root, `${safeName(title)}.md`, markdown, 'text/markdown');
      return { id: f.id, url: f.webUrl ?? null, version: f.cTag ?? null };
    },
    async writeSheet(root, sheet) {
      const f = await put(root, `${safeName(sheet.title)}.csv`, sheetCsv(sheet.columns.map((name) => ({ name })), sheet.rows), 'text/csv');
      return { id: f.id, url: f.webUrl ?? null, version: f.cTag ?? null, done: sheet.rows.length };
    },
    async version(id) {
      try { return (await json<{ cTag?: string }>(await call('onedrive', `${GRAPH}/items/${encodeURIComponent(id)}?$select=cTag`, token))).cTag ?? ''; }
      catch (e) { if (e instanceof PlaceError && e.gone) return null; throw e; }
    },
    readDoc: content,
    async readSheet(id) { return parseDelimited(await content(id), ','); },
    async trash(id) { await call('onedrive', `${GRAPH}/items/${encodeURIComponent(id)}`, token, { method: 'DELETE' }); },
  };
}

// ---------------------------------------------------------------- which place
/** The person's place, signed in with their own connection; null when it isn't connected. */
export async function remoteFor(env: Env, db: Db, userId: string, place: KnRemotePlace): Promise<Remote | null> {
  if (place === 's3') return null; // their own storage comes with stage 4g
  const provider = place === 'gdrive' ? 'google-drive' : place;
  const s = await credentials(env, db, userId, provider).catch(() => null);
  if (!s?.accessToken) return null;
  return place === 'notion' ? notion(s.accessToken) : place === 'gdrive' ? gdrive(s.accessToken) : onedrive(s.accessToken);
}
/** Whether each place is connected, and the account name shown with it. */
export async function placeConnections(db: Db, userId: string): Promise<Record<'notion' | 'gdrive' | 'onedrive', { connected: boolean; label: string | null }>> {
  const one = async (provider: string) => {
    const c = await getConnection(db, userId, provider).catch(() => null);
    const m = (c?.meta ?? {}) as Record<string, unknown>;
    return { connected: !!c, label: c ? String(m.workspace ?? m.label ?? m.teamName ?? '') || null : null };
  };
  const [notionC, gdriveC, onedriveC] = await Promise.all([one('notion'), one('google-drive'), one('onedrive')]);
  return { notion: notionC, gdrive: gdriveC, onedrive: onedriveC };
}
