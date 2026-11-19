// Knowledge kept in the person's Obsidian vault: a copy of each file, and of what Niko learned, as notes in a
// "Niko Knowledge" folder. Obsidian has no cloud API, so Niko reaches the vault one of two ways, their choice:
//   · synced through S3: the vault is synced to S3 storage they own by a plugin such as Remotely Save; Niko writes into
//     that bucket (signed like their own storage, knStorage.ts) and Obsidian syncs the notes in. Works while Obsidian is
//     closed. The plugin's encryption must be off, or Obsidian can't read what Niko writes.
//   · the Local REST API plugin, reached through their own Cloudflare Tunnel: works only while Obsidian is open. Its key
//     opens the whole vault, so every path is made here, always inside "Niko Knowledge/", never from a request.
// Either way the address must be https on a public host (checked through DNS), redirects are refused, keys are sealed
// with ENCRYPTION_KEY and never shown again, and a Cloudflare Access service token can go with each request.
import { and, eq } from 'drizzle-orm';
import { connections, type Db } from '@niko/db';
import { markdownTables, sheetMarkdown } from '@niko/shared';
import type { Env } from './env';
import { seal, unseal } from './lib/crypto';
import { PlaceError, safeName, type Remote } from './knPlaces';
import { getConnection, publicHttpsUrl } from './providers';
import { publicHost } from './safefetch';
import { cleanStorage, storageOps, type StorageConfig } from './knStorage';

export const OBSIDIAN_PROVIDER = 'kn-obsidian';
export const OBSIDIAN_FOLDER = 'Niko Knowledge';
interface Common { vault?: string }
export type ObsidianConfig = Common & (({ mode: 's3'; prefix: string } & StorageConfig) | { mode: 'rest'; address: string; apiKey: string; accessId?: string; accessSecret?: string });
/** What the screen may see again: never the keys. */
export interface ObsidianShown { mode: 's3' | 'rest'; address: string; bucket?: string; prefix?: string; vault?: string; access: boolean }

const API_KEY = /^[\x21-\x7e]{16,256}$/;
const KEY_ID = /^[\x21-\x7e]{3,128}$/;
const SECRET = /^[\x21-\x7e]{8,256}$/;
const MAX_READ = 12 * 1024 * 1024;

/** A folder inside the bucket ("My vault/"), or nothing: path parts without "." or "..", no control characters. */
function cleanPrefix(v: string): string | null {
  const parts = v.replace(/\\/g, '/').split('/').map((p) => p.trim()).filter(Boolean);
  if (parts.some((p) => p === '.' || p === '..' || /[\u0000-\u001f\u007f]/.test(p) || p.length > 100) || parts.length > 8) return null;
  return parts.length ? `${parts.join('/')}/` : '';
}
/** Checks what was typed. Keys left empty keep the saved ones, but only while the address (and way in) stays the same. */
export function cleanObsidian(raw: unknown, saved: ObsidianConfig | null): ObsidianConfig | { problem: string } {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const str = (k: string) => (typeof o[k] === 'string' ? (o[k] as string).trim() : '');
  const vault = str('vault').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 100);
  const extra = vault ? { vault } : {};
  if (o.mode !== 'rest') {
    const st = cleanStorage(raw, saved?.mode === 's3' ? saved : null);
    if ('problem' in st) return st;
    const prefix = cleanPrefix(str('prefix'));
    if (prefix === null) return { problem: 'That folder in the bucket isn’t valid. Use the folder names only, such as My vault.' };
    return { mode: 's3', ...st, prefix, ...extra };
  }
  const url = publicHttpsUrl(str('address'));
  if (!url || url.search || url.hash || (url.port && url.port !== '443')) return { problem: 'Use the https address of your tunnel, such as https://obsidian.example.com (no port, ? or #).' };
  const address = `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  const same = saved?.mode === 'rest' && saved.address === address ? saved : null;
  const apiKey = str('apiKey') || (same?.apiKey ?? '');
  if (!API_KEY.test(apiKey)) return { problem: 'Paste the API key from Obsidian’s Settings › Local REST API.' };
  const accessId = str('accessId') || (same && o.accessId === undefined ? same.accessId ?? '' : '');
  const accessSecret = str('accessSecret') || (same && o.accessSecret === undefined ? same.accessSecret ?? '' : '');
  if (!!accessId !== !!accessSecret) return { problem: 'Cloudflare Access needs both the client ID and the client secret.' };
  if (accessId && (!KEY_ID.test(accessId) || !SECRET.test(accessSecret))) return { problem: 'That Cloudflare Access token isn’t valid.' };
  return { mode: 'rest', address, apiKey, ...(accessId ? { accessId, accessSecret } : {}), ...extra };
}
export const shownObsidian = (c: ObsidianConfig): ObsidianShown => c.mode === 's3'
  ? { mode: 's3', address: c.endpoint, bucket: c.bucket, prefix: c.prefix.replace(/\/$/, ''), ...(c.vault ? { vault: c.vault } : {}), access: !!c.accessId }
  : { mode: 'rest', address: c.address, ...(c.vault ? { vault: c.vault } : {}), access: !!c.accessId };
const labelOf = (c: ObsidianConfig) => (c.mode === 's3' ? `Synced through S3 · ${c.bucket}${c.prefix ? `/${c.prefix.replace(/\/$/, '')}` : ''}` : `Local REST API · ${new URL(c.address).hostname}`);

export async function loadObsidian(env: Pick<Env, 'ENCRYPTION_KEY'>, db: Db, userId: string): Promise<ObsidianConfig | null> {
  const c = await getConnection(db, userId, OBSIDIAN_PROVIDER).catch(() => null);
  return c ? await unseal<ObsidianConfig>(env.ENCRYPTION_KEY, c.secretEnc).catch(() => null) : null;
}
export async function saveObsidian(env: Pick<Env, 'ENCRYPTION_KEY'>, db: Db, userId: string, cfg: ObsidianConfig | null): Promise<void> {
  await db.delete(connections).where(and(eq(connections.userId, userId), eq(connections.provider, OBSIDIAN_PROVIDER)));
  if (cfg) await db.insert(connections).values({ id: crypto.randomUUID(), userId, provider: OBSIDIAN_PROVIDER, secretEnc: await seal(env.ENCRYPTION_KEY, cfg), meta: { label: labelOf(cfg) } });
}

// ---------------------------------------------------------------- the vault, either way
interface Vault { put(path: string, body: string): Promise<string>; get(path: string): Promise<string | null>; stat(path: string): Promise<string | null>; del(path: string): Promise<void> }

/** Each part of a vault path, encoded for the Local REST API's /vault/ address. */
const vaultUrl = (address: string, path: string) => `${address}/vault/${path.split('/').map(encodeURIComponent).join('/')}`;
function restVault(c: Extract<ObsidianConfig, { mode: 'rest' }>): Vault {
  const call = async (method: 'GET' | 'PUT' | 'DELETE', path: string, init: { body?: string; accept?: string } = {}): Promise<Response | null> => {
    if (!(await publicHost(new URL(c.address).hostname))) throw new PlaceError('That address isn’t on the public internet, so Niko can’t reach it. Use your tunnel’s public name.', 400);
    const headers: Record<string, string> = { authorization: `Bearer ${c.apiKey}`, ...(init.accept ? { accept: init.accept } : {}), ...(init.body !== undefined ? { 'content-type': 'text/markdown; charset=utf-8' } : {}) };
    if (c.accessId) { headers['cf-access-client-id'] = c.accessId; headers['cf-access-client-secret'] = c.accessSecret!; }
    let res: Response;
    try { res = await fetch(vaultUrl(c.address, path), { method, headers, ...(init.body !== undefined ? { body: init.body } : {}), redirect: 'manual', signal: AbortSignal.timeout(25_000) }); }
    catch { throw new PlaceError('Niko couldn’t reach Obsidian. Obsidian needs to be open on that computer, with the Local REST API plugin on and your tunnel running.'); }
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location') ?? '';
      throw new PlaceError(/cloudflareaccess\.com/i.test(loc) ? 'Cloudflare Access stopped Niko. Add the service token under “Behind Cloudflare Access”.' : 'Your tunnel sent Niko somewhere else. Use the address it answers on directly.', 403);
    }
    if (res.status === 401 || res.status === 403) {
      const t = await res.text().catch(() => '');
      throw new PlaceError(/cloudflareaccess|cf-access|<html/i.test(t) ? 'Cloudflare Access stopped Niko. Check the service token under “Behind Cloudflare Access”.' : 'Obsidian refused the API key. Copy it again from Settings › Local REST API.', 403);
    }
    if (res.status === 404) return null;
    if (res.status === 405) throw new PlaceError('That path in your vault is a folder, not a note.');
    if ([502, 503, 504, 520, 521, 522, 523, 524, 530].includes(res.status)) throw new PlaceError('Niko couldn’t reach Obsidian. Obsidian needs to be open on that computer, with the Local REST API plugin on and your tunnel running.');
    if (res.status >= 400) throw new PlaceError(`Obsidian answered ${res.status}.`);
    return res;
  };
  const text = async (res: Response) => {
    if (Number(res.headers.get('content-length') ?? 0) > MAX_READ) throw new PlaceError('That note is too big to read back.', 413);
    const t = await res.text();
    if (t.length > MAX_READ) throw new PlaceError('That note is too big to read back.', 413);
    return t;
  };
  const stat = async (path: string) => {
    const res = await call('GET', path, { accept: 'application/vnd.olrapi.note+json' });
    if (!res) return null;
    const j = await res.json().catch(() => null) as { stat?: { mtime?: unknown; size?: unknown } } | null;
    return `${Number(j?.stat?.mtime ?? 0)}:${Number(j?.stat?.size ?? 0)}`;
  };
  return {
    async put(path, body) { await call('PUT', path, { body }); return (await stat(path)) ?? ''; },
    async get(path) { const res = await call('GET', path, { accept: 'text/markdown' }); return res ? text(res) : null; },
    stat,
    async del(path) { await call('DELETE', path); },
  };
}
function s3Vault(c: Extract<ObsidianConfig, { mode: 's3' }>): Vault {
  const ops = storageOps(c);
  return {
    put: (path, body) => ops.put(c.prefix + path, body, 'text/markdown; charset=utf-8'),
    get: (path) => ops.get(c.prefix + path),
    stat: (path) => ops.stat(c.prefix + path),
    del: (path) => ops.del(c.prefix + path),
  };
}
const vaultOf = (c: ObsidianConfig): Vault => (c.mode === 's3' ? s3Vault(c) : restVault(c));

/** A note name Obsidian is happy with: no slashes, no characters links can't hold ([ ] # ^ | : and the like), no
 *  leading dot (hidden), not too long. */
export const noteName = (title: string) => safeName(title).replace(/[[\]#^|]/g, ' ').replace(/^[.\s]+/, '').replace(/\s+/g, ' ').trim().slice(0, 100) || 'Note';
/** Front matter people add in Obsidian isn't part of the file's text. */
const withoutFrontMatter = (t: string) => t.replace(/^﻿?---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');

/** Tries the vault: writes a small hidden note in Niko Knowledge, reads it back, and removes it. */
export async function testObsidian(cfg: ObsidianConfig): Promise<void> {
  const v = vaultOf(cfg);
  const path = `${OBSIDIAN_FOLDER}/.niko-test-${crypto.randomUUID().slice(0, 8)}.md`;
  await v.put(path, 'Niko checked it can keep notes here.');
  const back = await v.get(path);
  await v.del(path).catch(() => undefined);
  if (!back?.startsWith('Niko checked')) throw new PlaceError(cfg.mode === 's3' ? 'Your storage gave back something else than Niko wrote.' : 'Obsidian gave back something else than Niko wrote.');
}

export function obsidianRemoteOf(cfg: ObsidianConfig): Remote {
  const v = vaultOf(cfg);
  const link = (path: string) => (cfg.vault ? `obsidian://open?vault=${encodeURIComponent(cfg.vault)}&file=${encodeURIComponent(path.replace(/\.md$/, ''))}` : null);
  /** "Team handbook.md", or "Team handbook (2).md" when another note has that name. */
  const free = async (root: string, title: string) => {
    const base = `${root || OBSIDIAN_FOLDER}/${noteName(title)}`;
    for (let n = 1; n <= 20; n++) { const path = `${base}${n === 1 ? '' : ` (${n})`}.md`; if ((await v.stat(path)) === null) return path; }
    return `${base} ${crypto.randomUUID().slice(0, 8)}.md`;
  };
  return {
    place: 'obsidian',
    async makeRoot(name) { const folder = (name ?? OBSIDIAN_FOLDER).replace(/\/+$/, ''); return { id: folder, name: folder }; },
    async writeDoc(root, title, markdown) { const path = await free(root, title); return { id: path, url: link(path), version: await v.put(path, markdown) }; },
    async replaceDoc(id, _title, markdown) { return { id, url: link(id), version: await v.put(id, markdown) }; },
    async writeSheet(root, sheet) {
      const path = await free(root, sheet.title);
      return { id: path, url: link(path), version: await v.put(path, sheetMarkdown(sheet.title, sheet.columns.map((name) => ({ name })), sheet.rows)), done: sheet.rows.length };
    },
    version: (id) => v.stat(id),
    async readDoc(id) { const t = await v.get(id); if (t === null) throw new PlaceError('That note isn’t in your vault any more.', 404, true); return withoutFrontMatter(t); },
    async readSheet(id) {
      const t = await v.get(id);
      if (t === null) throw new PlaceError('That note isn’t in your vault any more.', 404, true);
      return markdownTables(withoutFrontMatter(t))[0]?.rows ?? [];
    },
    // Neither way in has a bin Niko can use, so removing a copy deletes the note (Obsidian's File recovery may keep it).
    async trash(id) { await v.del(id); },
  };
}
export async function obsidianRemote(env: Pick<Env, 'ENCRYPTION_KEY'>, db: Db, userId: string): Promise<Remote | null> {
  const cfg = await loadObsidian(env, db, userId);
  return cfg ? obsidianRemoteOf(cfg) : null;
}
