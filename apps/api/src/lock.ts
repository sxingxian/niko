// Screen lock. The lock is kept by the server, per sign-in: while a session is locked, every route answers 423 except
// the lock's own (unlock, passkey unlock, /me, and new items when the person chose to see them while locked), so a
// reload, another tab or a changed app shows nothing until the code is entered.
//
// The 6-digit code is never stored: an HMAC of it under a pepper derived from the server's encryption key is hashed
// with bcrypt (cost 10) in Postgres. A leaked database alone can't be worked through the million possible codes
// without the pepper. Five wrong codes in a row end that sign-in.
import { sql } from 'drizzle-orm';
import type { Db } from '@niko/db';
import { LOCK_MINUTES, type LockInfo, type LockShowNew } from '@niko/shared';
import type { Env } from './env';

export interface ScreenLock extends LockInfo { hash: string }
export const MAX_LOCK_FAILS = 5;

/** The account's lock, when it is switched on and has a code. */
export function lockOf(u: { screenLock?: unknown }): ScreenLock | null {
  const v = u.screenLock as Partial<ScreenLock> | null | undefined;
  if (!v || v.on !== true || typeof v.hash !== 'string' || !v.hash.startsWith('$2')) return null;
  const mins = (LOCK_MINUTES as readonly number[]).includes(Number(v.mins)) ? Number(v.mins) : 5;
  const showNew: LockShowNew = v.showNew === 'off' || v.showNew === 'full' ? v.showNew : 'who';
  return { on: true, hash: v.hash, mins, showNew, passkey: v.passkey !== false, setAt: typeof v.setAt === 'string' ? v.setAt : undefined };
}
/** What the app may know: no hash. */
export function lockInfo(u: { screenLock?: unknown }): LockInfo {
  const v = (u.screenLock ?? {}) as Partial<ScreenLock>, on = lockOf(u);
  return {
    on: !!on, mins: on?.mins ?? ((LOCK_MINUTES as readonly number[]).includes(Number(v.mins)) ? Number(v.mins) : 5),
    showNew: on?.showNew ?? (v.showNew === 'off' || v.showNew === 'full' ? v.showNew : 'who'), passkey: on?.passkey ?? v.passkey !== false,
    ...(typeof v.setAt === 'string' && typeof v.hash === 'string' ? { setAt: v.setAt } : {}),
  };
}

async function peppered(env: Env, userId: string, code: string): Promise<string> {
  const enc = new TextEncoder();
  const keyBytes = await crypto.subtle.digest('SHA-256', enc.encode(`niko/lock-pepper/v1\u0000${env.ENCRYPTION_KEY}`));
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(`${userId}\u0000${code}`)));
  let s = '';
  for (const x of mac) s += String.fromCharCode(x);
  return btoa(s);
}
export async function hashLockCode(env: Env, db: Db, userId: string, code: string): Promise<string> {
  const r = await db.execute(sql`select crypt(${await peppered(env, userId, code)}, gen_salt('bf', 10)) as h`);
  return String((r.rows[0] as { h: string }).h);
}
export async function lockCodeOk(env: Env, db: Db, userId: string, code: string, hash: string): Promise<boolean> {
  if (!/^\d{6}$/.test(code)) return false;
  const r = await db.execute(sql`select (crypt(${await peppered(env, userId, code)}, ${hash}) = ${hash}) as ok`);
  return (r.rows[0] as { ok: boolean }).ok === true;
}

/** Routes that answer while locked. Everything else gets 423. */
export function openWhileLocked(method: string, path: string): boolean {
  const p = path.replace(/\/+$/, '');
  if (method === 'GET' && (p.endsWith('/api/me') || p.endsWith('/api/lock'))) return true;
  if (method === 'POST' && (/\/api\/lock\/(unlock|now|passkey\/options|passkey\/verify)$/.test(p) || p.endsWith('/api/glance'))) return true;
  return false;
}
