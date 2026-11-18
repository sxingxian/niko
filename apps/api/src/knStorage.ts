// Knowledge kept in the person's own storage: anything that speaks S3 (a NAS running versitygw or MinIO behind their
// own Cloudflare Tunnel, Cloudflare R2, Backblaze B2, AWS…). Files go in a niko-knowledge/ folder of their bucket as
// .md and .csv; Niko still keeps the search pieces and rows. The address must be https on a public host (checked
// through DNS before requests, like data sources), requests never follow a redirect, and the keys are sealed with
// ENCRYPTION_KEY and never shown again. Requests are signed with AWS Signature Version 4, path-style
// (https://host/bucket/key), which every S3-compatible server takes. Behind Cloudflare Access, a service token goes
// in the CF-Access-Client-Id and CF-Access-Client-Secret headers.
import { and, eq } from 'drizzle-orm';
import { connections, type Db } from '@niko/db';
import { parseDelimited, sheetCsv } from '@niko/shared';
import type { Env } from './env';
import { seal, unseal } from './lib/crypto';
import { PlaceError, safeName, type Remote } from './knPlaces';
import { getConnection, publicHttpsUrl } from './providers';
import { publicHost } from './safefetch';

export const STORAGE_PROVIDER = 'kn-storage';
export const STORAGE_FOLDER = 'niko-knowledge/';
export interface StorageConfig { endpoint: string; bucket: string; region: string; accessKeyId: string; secretAccessKey: string; accessId?: string; accessSecret?: string }
/** What the screen may see again: never the keys. */
export interface StorageShown { endpoint: string; bucket: string; region: string; access: boolean }

const BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const KEY_ID = /^[\x21-\x7e]{3,128}$/;
const SECRET = /^[\x21-\x7e]{8,256}$/;
const REGION = /^[a-z0-9-]{1,40}$/;

/** The signing region: from the address for AWS, Backblaze and Wasabi (s3.<region>.…), otherwise us-east-1, which
 *  R2, MinIO and versitygw take by default. */
export function regionOf(host: string): string {
  const m = /^(?:[a-z0-9.-]+\.)?s3[.-]([a-z0-9-]+)\.(?:amazonaws\.com|backblazeb2\.com|wasabisys\.com)$/.exec(host);
  return m && m[1] !== 'external-1' ? m[1]! : 'us-east-1';
}
/** Checks what was typed. Keys left empty keep the saved ones, but only while the address stays the same. */
export function cleanStorage(raw: unknown, saved: StorageConfig | null): StorageConfig | { problem: string } {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const str = (k: string) => (typeof o[k] === 'string' ? (o[k] as string).trim() : '');
  const url = publicHttpsUrl(str('endpoint'));
  if (!url || url.search || url.hash || url.port && url.port !== '443') return { problem: 'Use an https address on the internet, such as https://s3.example.com (no port, ? or #).' };
  const endpoint = `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  const bucket = str('bucket').toLowerCase();
  if (!BUCKET.test(bucket) || bucket.includes('..')) return { problem: 'That bucket name isn’t valid: 3 to 63 lower-case letters, numbers, dots or dashes.' };
  const region = (str('region') || regionOf(url.hostname)).toLowerCase();
  if (!REGION.test(region)) return { problem: 'That region isn’t valid. Leave it empty for “auto”.' };
  // A new address needs its keys again, so saved keys never go to an address they weren't typed for.
  const same = saved && saved.endpoint === endpoint;
  const accessKeyId = str('accessKeyId') || (same ? saved!.accessKeyId : '');
  const secretAccessKey = str('secretAccessKey') || (same ? saved!.secretAccessKey : '');
  if (!KEY_ID.test(accessKeyId)) return { problem: 'Enter the access key ID.' };
  if (!SECRET.test(secretAccessKey)) return { problem: 'Enter the secret key.' };
  const accessId = str('accessId') || (same && o.accessId === undefined ? saved!.accessId ?? '' : '');
  const accessSecret = str('accessSecret') || (same && o.accessSecret === undefined ? saved!.accessSecret ?? '' : '');
  if (!!accessId !== !!accessSecret) return { problem: 'Cloudflare Access needs both the client ID and the client secret.' };
  if (accessId && (!KEY_ID.test(accessId) || !SECRET.test(accessSecret))) return { problem: 'That Cloudflare Access token isn’t valid.' };
  return { endpoint, bucket, region, accessKeyId, secretAccessKey, ...(accessId ? { accessId, accessSecret } : {}) };
}
export const shownStorage = (c: StorageConfig): StorageShown => ({ endpoint: c.endpoint, bucket: c.bucket, region: c.region, access: !!c.accessId });

export async function loadStorage(env: Pick<Env, 'ENCRYPTION_KEY'>, db: Db, userId: string): Promise<StorageConfig | null> {
  const c = await getConnection(db, userId, STORAGE_PROVIDER).catch(() => null);
  return c ? await unseal<StorageConfig>(env.ENCRYPTION_KEY, c.secretEnc).catch(() => null) : null;
}
export async function saveStorage(env: Pick<Env, 'ENCRYPTION_KEY'>, db: Db, userId: string, cfg: StorageConfig | null): Promise<void> {
  await db.delete(connections).where(and(eq(connections.userId, userId), eq(connections.provider, STORAGE_PROVIDER)));
  if (cfg) await db.insert(connections).values({ id: crypto.randomUUID(), userId, provider: STORAGE_PROVIDER, secretEnc: await seal(env.ENCRYPTION_KEY, cfg), meta: { label: `${new URL(cfg.endpoint).hostname} · ${cfg.bucket}` } });
}

// ---------------------------------------------------------------- signing (AWS Signature Version 4)
const enc = new TextEncoder();
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
const sha256 = async (data: Uint8Array | string) => hex(await crypto.subtle.digest('SHA-256', typeof data === 'string' ? enc.encode(data) : data));
async function hmac(key: ArrayBuffer | Uint8Array, data: string): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', k, enc.encode(data));
}
/** Each part of an object's path, encoded the way S3 signs it (RFC 3986: only A-Z a-z 0-9 - _ . ~ left as they are). */
export const s3Path = (s: string) => s.split('/').map((p) => encodeURIComponent(p).replace(/[!'()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`)).join('/');
/** The headers for one signed request. `now` is only passed by tests. */
export async function signS3(cfg: StorageConfig, method: string, key: string, body: Uint8Array, contentType: string | null, now = new Date()): Promise<{ url: string; headers: Record<string, string> }> {
  const base = new URL(cfg.endpoint);
  const path = `${base.pathname.replace(/\/+$/, '')}/${s3Path(cfg.bucket)}${key ? `/${s3Path(key)}` : ''}`;
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const day = amzDate.slice(0, 8);
  const payload = await sha256(body);
  const headers: Record<string, string> = { host: base.host, 'x-amz-content-sha256': payload, 'x-amz-date': amzDate, ...(contentType ? { 'content-type': contentType } : {}) };
  const names = Object.keys(headers).sort();
  const canonical = [method, path, '', ...names.map((n) => `${n}:${headers[n]}`), '', names.join(';'), payload].join('\n');
  const scope = `${day}/${cfg.region}/s3/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, await sha256(canonical)].join('\n');
  let k = await hmac(enc.encode(`AWS4${cfg.secretAccessKey}`), day);
  for (const part of [cfg.region, 's3', 'aws4_request']) k = await hmac(k, part);
  const signature = hex(await hmac(k, toSign));
  const out: Record<string, string> = { ...headers, authorization: `AWS4-HMAC-SHA256 Credential=${cfg.accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}` };
  delete out.host;
  if (cfg.accessId) { out['cf-access-client-id'] = cfg.accessId; out['cf-access-client-secret'] = cfg.accessSecret!; }
  return { url: `${base.origin}${path}`, headers: out };
}

// ---------------------------------------------------------------- requests
const MAX_READ = 12 * 1024 * 1024;
/** One request to their storage. The host is checked through DNS first; redirects are refused; keys never appear in messages. */
async function s3(cfg: StorageConfig, method: 'GET' | 'PUT' | 'HEAD' | 'DELETE', key: string, body?: string, type?: string): Promise<Response> {
  const host = new URL(cfg.endpoint).hostname;
  if (!(await publicHost(host))) throw new PlaceError('That storage address isn’t on the public internet, so Niko can’t reach it. Use its public name, such as one behind a Cloudflare Tunnel.', 400);
  const bytes = body === undefined ? new Uint8Array() : enc.encode(body);
  const { url, headers } = await signS3(cfg, method, key, bytes, type ?? null);
  let res: Response;
  try { res = await fetch(url, { method, headers, ...(body !== undefined ? { body: bytes } : {}), redirect: 'manual', signal: AbortSignal.timeout(25_000) }); }
  catch { throw new PlaceError('Your storage didn’t answer in time. Check the address, or try again in a moment.'); }
  if (res.status >= 300 && res.status < 400) throw new PlaceError('Your storage sent Niko somewhere else. Use the address it answers on directly.');
  if (res.status === 401 || res.status === 403) {
    const t = method === 'HEAD' ? '' : await res.text().catch(() => '');
    throw new PlaceError(/cloudflareaccess|cf-access|<html/i.test(t) ? 'Cloudflare Access stopped Niko. Check the service token under “Behind Cloudflare Access”.' : /SignatureDoesNotMatch|InvalidAccessKeyId/i.test(t) ? 'Your storage refused the keys. Check the access key ID and secret key.' : 'Your storage didn’t allow that. Check the keys can read and write that bucket.', 403);
  }
  if (res.status === 404) {
    const t = method === 'HEAD' ? '' : await res.text().catch(() => '');
    throw new PlaceError(/NoSuchBucket/i.test(t) ? `There’s no bucket called “${cfg.bucket}” there.` : 'That copy isn’t in your storage any more.', 404, !/NoSuchBucket/i.test(t));
  }
  if (res.status >= 400) throw new PlaceError(`Your storage answered ${res.status}.`);
  return res;
}
const readText = async (res: Response) => {
  const len = Number(res.headers.get('content-length') ?? 0);
  if (len > MAX_READ) throw new PlaceError('That copy is too big to read back.', 413);
  const t = await res.text();
  if (t.length > MAX_READ) throw new PlaceError('That copy is too big to read back.', 413);
  return t;
};
const etag = (res: Response) => (res.headers.get('etag') ?? '').replace(/^W\//, '').replace(/"/g, '');
const objectKey = (title: string, ext: string) => `${STORAGE_FOLDER}${safeName(title).replace(/ /g, '-')}-${crypto.randomUUID().slice(0, 8)}.${ext}`;

/** Tries their storage: writes a small file in niko-knowledge/, reads it back, and removes it. */
export async function testStorage(cfg: StorageConfig): Promise<void> {
  const key = `${STORAGE_FOLDER}.niko-test-${crypto.randomUUID().slice(0, 8)}`;
  await s3(cfg, 'PUT', key, 'Niko checked it can keep files here.', 'text/plain; charset=utf-8');
  const back = await readText(await s3(cfg, 'GET', key));
  await s3(cfg, 'DELETE', key).catch(() => undefined);
  if (!back.startsWith('Niko checked')) throw new PlaceError('Your storage gave back something else than Niko wrote.');
}

export function storageRemoteOf(cfg: StorageConfig): Remote {
  const link = (key: string) => null as string | null; // buckets are private: no link to open
  return {
    place: 's3',
    async makeRoot() { return { id: STORAGE_FOLDER, name: STORAGE_FOLDER.replace(/\/$/, '') }; },
    async writeDoc(_root, title, markdown) {
      const key = objectKey(title, 'md');
      const res = await s3(cfg, 'PUT', key, markdown, 'text/markdown; charset=utf-8');
      return { id: key, url: link(key), version: etag(res) };
    },
    async writeSheet(_root, sheet) {
      const key = objectKey(sheet.title, 'csv');
      const res = await s3(cfg, 'PUT', key, sheetCsv(sheet.columns.map((name) => ({ name })), sheet.rows), 'text/csv; charset=utf-8');
      return { id: key, url: link(key), version: etag(res), done: sheet.rows.length };
    },
    async version(id) {
      try { return etag(await s3(cfg, 'HEAD', id)); }
      catch (e) { if (e instanceof PlaceError && e.gone) return null; throw e; }
    },
    async readDoc(id) { return readText(await s3(cfg, 'GET', id)); },
    async readSheet(id) { return parseDelimited(await readText(await s3(cfg, 'GET', id)), ','); },
    // Storage has no bin, so removing a file removes its copy.
    async trash(id) { await s3(cfg, 'DELETE', id); },
  };
}
export async function storageRemote(env: Pick<Env, 'ENCRYPTION_KEY'>, db: Db, userId: string): Promise<Remote | null> {
  const cfg = await loadStorage(env, db, userId);
  return cfg ? storageRemoteOf(cfg) : null;
}
