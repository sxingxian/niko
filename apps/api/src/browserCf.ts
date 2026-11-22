// Cloudflare Browser Run: the built-in browser service. The admin connects it in Admin portal › Browser with an API
// token that has only the Browser Rendering Edit permission, plus the account ID. Both are kept sealed with
// ENCRYPTION_KEY in app_settings, never sent to any browser, and can only be replaced, never shown again.
//
// Niko's server only starts and closes sessions and hands out short-lived passes (Live View links). The live picture
// and the person's taps go straight between their device and Cloudflare; the token never leaves the server.
import { eq } from 'drizzle-orm';
import { appSettings, type Db } from '@niko/db';
import type { Env } from './env';
import { seal, unseal } from './lib/crypto';

export const CF_KEY = 'browser-cloudflare';
const API = 'https://api.cloudflare.com/client/v4/accounts';

/** What is stored: the account ID and the sealed token. `tail` and `at` are what the admin portal may show. */
interface Stored { account: string; token: string; tail: string; at: string; by?: string }
export interface CfConn { account: string; token: string }
export interface CfInfo { connected: boolean; tail?: string; at?: string }

export async function cfInfo(db: Db): Promise<CfInfo> {
  const row = (await db.select().from(appSettings).where(eq(appSettings.key, CF_KEY)).limit(1))[0];
  const v = row?.value as Partial<Stored> | undefined;
  return v?.account && v.token ? { connected: true, tail: v.tail, at: v.at } : { connected: false };
}

/** The connection, or null when none is saved (or it can't be opened with this ENCRYPTION_KEY). */
export async function cfConnection(env: Env, db: Db): Promise<CfConn | null> {
  const row = (await db.select().from(appSettings).where(eq(appSettings.key, CF_KEY)).limit(1))[0];
  const v = row?.value as Partial<Stored> | undefined;
  if (!v?.account || !v.token) return null;
  const token = await unseal<string>(env.ENCRYPTION_KEY, v.token).catch(() => null);
  return token ? { account: v.account, token } : null;
}

export async function saveCf(env: Env, db: Db, account: string, token: string, by: string): Promise<CfInfo> {
  const value: Stored = { account, token: await seal(env.ENCRYPTION_KEY, token), tail: account.slice(-4), at: new Date().toISOString(), by };
  await db.insert(appSettings).values({ key: CF_KEY, value }).onConflictDoUpdate({ target: appSettings.key, set: { value } });
  return { connected: true, tail: value.tail, at: value.at };
}
export async function forgetCf(db: Db): Promise<void> { await db.delete(appSettings).where(eq(appSettings.key, CF_KEY)); }

/** A problem with Cloudflare, worded for the admin. `status` is Cloudflare's answer. */
export class CfError extends Error { constructor(message: string, readonly status: number, readonly code: 'token' | 'account' | 'limit' | 'busy' | 'down' | 'other' = 'other') { super(message); } }

function explain(status: number, body: string): CfError {
  const t = body.toLowerCase();
  if (status === 401 || /authentication error|invalid api token|10000/.test(t)) return new CfError('Cloudflare didn’t accept the token. Make a new one with the Browser Rendering Edit permission and paste it again.', status, 'token');
  if (status === 403) return new CfError('The token doesn’t have the Browser Rendering Edit permission for this account. Edit the token in Cloudflare, or make a new one.', status, 'token');
  if (status === 404 || /could not route|account not found|7003/.test(t)) return new CfError('Cloudflare couldn’t find that account ID. Copy it again from your account’s overview page.', status, 'account');
  if (status === 429 && /time limit|browser time/.test(t)) return new CfError('Cloudflare’s free browser minutes for today are used up. They refill at midnight UTC.', status, 'limit');
  if (status === 429) return new CfError('Cloudflare is busy: too many browsers are open or were opened just now. Try again in a minute.', status, 'busy');
  if (status >= 500) return new CfError('Cloudflare isn’t answering just now. Try again in a few minutes.', status, 'down');
  return new CfError(`Cloudflare answered ${status}.`, status);
}

/** One call to Browser Run's DevTools API, under /accounts/{id}/browser-run/devtools/browser. */
export async function cf(conn: CfConn, method: string, path: string, body?: unknown, timeoutMs = 20_000): Promise<any> {
  const res = await fetch(`${API}/${conn.account}/browser-run/devtools/browser${path}`, {
    method,
    headers: { authorization: `Bearer ${conn.token}`, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  }).catch((e) => { throw new CfError(e?.name === 'TimeoutError' ? 'Cloudflare took too long to answer.' : 'Niko couldn’t reach Cloudflare.', 0, 'down'); });
  const text = await res.text();
  if (!res.ok) throw explain(res.status, text);
  if (!text) return null;
  let j: any;
  try { j = JSON.parse(text); } catch { return text; }
  // Some Cloudflare answers wrap the result; DevTools answers don't.
  return j && typeof j === 'object' && 'result' in j && 'success' in j ? j.result : j;
}

/** A page target, as Browser Run lists it. */
export interface CfTarget { id: string; type: string; url: string; title?: string; webSocketDebuggerUrl?: string; devtoolsFrontendUrl?: string }

/** Starts a browser. `keepAliveMs`: how long it stays open with nothing connected (Cloudflare allows up to 10 minutes). */
export async function cfOpen(conn: CfConn, keepAliveMs = 180_000): Promise<{ sessionId: string }> {
  const r = await cf(conn, 'POST', `?keep_alive=${Math.max(10_000, Math.min(600_000, keepAliveMs))}`);
  const sessionId = String(r?.sessionId ?? r?.id ?? '');
  if (!/^[A-Za-z0-9-]{8,80}$/.test(sessionId)) throw new CfError('Cloudflare started a browser but didn’t say which one.', 502);
  return { sessionId };
}
/** Opens a tab on an address and returns its target. */
export async function cfTab(conn: CfConn, sessionId: string, url: string): Promise<CfTarget> {
  const t = await cf(conn, 'PUT', `/${encodeURIComponent(sessionId)}/json/new?url=${encodeURIComponent(url)}`);
  if (!t?.id) throw new CfError('Cloudflare didn’t open the tab.', 502);
  return t as CfTarget;
}
export async function cfTargets(conn: CfConn, sessionId: string): Promise<CfTarget[]> {
  const t = await cf(conn, 'GET', `/${encodeURIComponent(sessionId)}/json/list`);
  return Array.isArray(t) ? (t as CfTarget[]).filter((x) => x?.type === 'page') : [];
}
/** A pass to one tab: a signed link (good for starting a connection within `expiresMs`) and the CDP socket it opens.
 * `readonly` lets the device watch but not click, type, navigate or run scripts. */
export interface CfPass { ws: string; viewer: string; expiresAt: number; readonly: boolean }
export async function cfPass(conn: CfConn, sessionId: string, targetId: string | undefined, readonly: boolean, expiresMs = 60_000): Promise<CfPass> {
  const ms = Math.max(60_000, Math.min(3_600_000, expiresMs));
  const r = await cf(conn, 'POST', `/${encodeURIComponent(sessionId)}/live_view`, { mode: 'tab', expiresInMs: ms, ...(targetId ? { targetId } : {}), ...(readonly ? { guardrails: { mode: 'readonly' } } : {}) });
  const ws = String(r?.webSocketDebuggerUrl ?? '');
  if (!passHost(ws)) throw new CfError('Cloudflare gave a pass Niko doesn’t recognise.', 502);
  return { ws, viewer: String(r?.devtoolsFrontendUrl ?? ''), expiresAt: Date.now() + ms, readonly };
}
/** Passes may only point at Cloudflare's live view service, over wss. */
export function passHost(ws: string): boolean {
  try { const u = new URL(ws); return u.protocol === 'wss:' && (u.hostname === 'live.browser.run' || u.hostname.endsWith('.browser.run')); } catch { return false; }
}
export async function cfClose(conn: CfConn, sessionId: string): Promise<void> {
  await cf(conn, 'DELETE', `/${encodeURIComponent(sessionId)}`).catch((e) => { if (!(e instanceof CfError) || e.status !== 404) throw e; });
}

/** Checks a token and account before saving: opens a browser for a moment and closes it again.
 * Uses a few seconds of the day's free minutes. */
export async function cfTest(account: string, token: string): Promise<void> {
  const conn = { account, token };
  const { sessionId } = await cfOpen(conn, 10_000);
  await cfClose(conn, sessionId).catch(() => undefined);
}
