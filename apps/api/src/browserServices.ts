// Browser services besides the built-in Cloudflare Browser Run: the account's own browser server (such as Chrome on a
// NAS behind a Cloudflare Tunnel) and a hosted service with a key (the account's), and a person's own service.
// They speak the Chrome DevTools protocol over a WebSocket. Their addresses and keys stay on Niko's server: the
// person's BrowserKeeper connects to the service and relays the live picture to the person's device.
import { and, eq, isNull } from 'drizzle-orm';
import { browserServices, type Db } from '@niko/db';
import { cleanServiceUrl, isServiceKey, keyParamFor, type BrowserServiceInfo } from '@niko/shared';
import type { Env } from './env';
import { seal, unseal } from './lib/crypto';

export type ServiceKind = 'server' | 'hosted';
type Row = typeof browserServices.$inferSelect;
export interface ServiceConn { id: string; kind: ServiceKind; /** The address to connect to, with the key in it. Server side only. */ wsUrl: string }

const info = (r: Row): BrowserServiceInfo => ({ id: r.id, kind: r.kind as ServiceKind, name: r.name, host: (() => { try { return new URL(r.url).host; } catch { return ''; } })(), hasKey: !!r.keyEnc, at: r.createdAt.toISOString(), testedAt: r.testedAt?.toISOString() ?? null });

/** The account's services (own server, hosted service), as shown in the admin portal. */
export async function accountServices(db: Db): Promise<BrowserServiceInfo[]> {
  return (await db.select().from(browserServices).where(isNull(browserServices.userId))).map(info);
}
/** A person's own service, if they added one. */
export async function personService(db: Db, userId: string): Promise<BrowserServiceInfo | null> {
  const r = (await db.select().from(browserServices).where(eq(browserServices.userId, userId)).limit(1))[0];
  return r ? info(r) : null;
}

/** The address to connect to (the key added as the service expects), for the keeper. Never sent to a device. */
async function connOf(env: Env, r: Row): Promise<ServiceConn | null> {
  const u = new URL(r.url);
  if (r.keyEnc) {
    const key = await unseal<string>(env.ENCRYPTION_KEY, r.keyEnc).catch(() => null);
    if (!key) return null;
    u.searchParams.set(r.keyParam || 'token', key);
  }
  if (u.protocol === 'https:') u.protocol = 'wss:';
  return { id: r.id, kind: r.kind as ServiceKind, wsUrl: u.toString() };
}
export async function accountConn(env: Env, db: Db, kind: ServiceKind): Promise<ServiceConn | null> {
  const r = (await db.select().from(browserServices).where(and(isNull(browserServices.userId), eq(browserServices.kind, kind))).limit(1))[0];
  return r ? connOf(env, r) : null;
}
export async function personConn(env: Env, db: Db, userId: string): Promise<ServiceConn | null> {
  const r = (await db.select().from(browserServices).where(eq(browserServices.userId, userId)).limit(1))[0];
  return r ? connOf(env, r) : null;
}
/** The connection for a session's service (by id), when it reconnects or opens a tab. */
export async function connById(env: Env, db: Db, id: string | null): Promise<ServiceConn | null> {
  if (!id) return null;
  const r = (await db.select().from(browserServices).where(eq(browserServices.id, id)).limit(1))[0];
  return r ? connOf(env, r) : null;
}

/** Checks what was entered. Returns the cleaned values, or the problem worded for the person. */
export function cleanServiceInput(b: { kind?: unknown; name?: unknown; url?: unknown; key?: unknown }, keyNeeded: boolean): { kind: ServiceKind; name: string; url: string; key: string | null } | { error: string; field: string } {
  const kind = b.kind === 'hosted' ? 'hosted' : b.kind === 'server' ? 'server' : null;
  if (!kind) return { error: 'Choose your own server or a hosted service.', field: 'kind' };
  const name = typeof b.name === 'string' ? b.name.replace(/\s+/g, ' ').trim().slice(0, 60) : '';
  const u = cleanServiceUrl(b.url);
  if ('problem' in u) return { error: u.problem, field: 'url' };
  const key = typeof b.key === 'string' && b.key.trim() ? b.key.trim() : null;
  if (key && !isServiceKey(key)) return { error: kind === 'hosted' ? 'That doesn’t look like an API key. Copy the whole key again.' : 'That doesn’t look like a token. Copy the whole token again.', field: 'key' };
  if (!key && (keyNeeded || kind === 'hosted')) return { error: kind === 'hosted' ? 'Enter the service’s API key.' : 'Enter the server’s token.', field: 'key' };
  return { kind, name: name || (kind === 'hosted' ? new URL(u.url).hostname.split('.').slice(-2, -1)[0]!.replace(/^./, (c) => c.toUpperCase()) : 'Own browser server'), url: u.url, key };
}

export class ServiceError extends Error {
  constructor(message: string, readonly code: 'refused' | 'down' | 'busy' | 'other') { super(message); }
}

/** Opens a DevTools WebSocket to a service from Niko's server. */
export async function openSocket(wsUrl: string, timeoutMs = 10_000): Promise<WebSocket> {
  const https = wsUrl.replace(/^wss:/, 'https:');
  let res: Response;
  try { res = await fetch(https, { headers: { Upgrade: 'websocket' }, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) }); }
  catch { throw new ServiceError('The browser service couldn’t be reached.', 'down'); }
  const ws = (res as Response & { webSocket?: WebSocket | null }).webSocket;
  if (!ws) {
    if (res.status === 401 || res.status === 403) throw new ServiceError('The browser service refused the key.', 'refused');
    if (res.status === 429) throw new ServiceError('The browser service is busy right now.', 'busy');
    throw new ServiceError(`The browser service answered ${res.status} instead of opening a browser.`, res.status >= 500 ? 'down' : 'other');
  }
  ws.accept();
  return ws;
}

/** Tests a service: connects, asks the browser for its version, and lets go. Returns the browser's name. */
export async function testService(wsUrl: string): Promise<string> {
  const ws = await openSocket(wsUrl);
  try {
    const v = await new Promise<{ product?: string }>((resolve, reject) => {
      const t = setTimeout(() => reject(new ServiceError('The browser service didn’t answer.', 'down')), 8000);
      ws.addEventListener('message', (e) => { try { const m = JSON.parse(String(e.data)); if (m.id === 1) { clearTimeout(t); m.error ? reject(new ServiceError('The browser service answered with an error.', 'other')) : resolve(m.result ?? {}); } } catch { /* not ours */ } });
      ws.addEventListener('close', () => { clearTimeout(t); reject(new ServiceError('The browser service closed the connection.', 'refused')); });
      ws.send(JSON.stringify({ id: 1, method: 'Browser.getVersion' }));
    });
    return String(v.product ?? 'A browser').slice(0, 80);
  } finally { try { ws.close(1000, 'test done'); } catch { /* closed */ } }
}

/** Saves a service (tested first by the caller). Replaces the account's service of that kind, or the person's own. */
export async function saveService(env: Env, db: Db, userId: string | null, v: { kind: ServiceKind; name: string; url: string; key: string | null }): Promise<BrowserServiceInfo> {
  const keyEnc = v.key ? await seal(env.ENCRYPTION_KEY, v.key) : null;
  const where = userId ? eq(browserServices.userId, userId) : and(isNull(browserServices.userId), eq(browserServices.kind, v.kind));
  await db.delete(browserServices).where(where);
  const r = (await db.insert(browserServices).values({ userId, kind: v.kind, name: v.name, url: v.url, keyEnc, keyParam: keyParamFor(v.url), testedAt: new Date() }).returning())[0]!;
  return info(r);
}
export async function removeService(db: Db, userId: string | null, kind?: ServiceKind): Promise<void> {
  await db.delete(browserServices).where(userId ? eq(browserServices.userId, userId) : and(isNull(browserServices.userId), eq(browserServices.kind, kind ?? 'server')));
}
