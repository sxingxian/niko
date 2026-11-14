import { and, eq, gt, sql } from 'drizzle-orm';
import type { Context, MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { auditLog, authAttempts, sessions, users } from '@niko/db';
import type { AppEnv } from '../env';
import { randomToken, sha256 } from './crypto';

const APP_COOKIE = '__Host-niko';
const ADMIN_COOKIE = '__Host-niko_admin';
const APP_TTL_DAYS = 30;
const ADMIN_TTL_HOURS = 8;

type C = Context<AppEnv>;

export function clientIp(c: C): string {
  return c.req.header('cf-connecting-ip') ?? 'unknown';
}

export async function audit(c: C, action: string, detail: Record<string, unknown> = {}, userId?: string | null) {
  try {
    await c.get('db').insert(auditLog).values({ userId: userId ?? null, action, detail, ip: clientIp(c) });
  } catch (e) {
    console.error('audit failed', action, e);
  }
}

export async function startSession(c: C, userId: string, kind: 'app' | 'admin', mfaOk = false) {
  const token = randomToken();
  const ms = kind === 'admin' ? ADMIN_TTL_HOURS * 3600_000 : APP_TTL_DAYS * 86400_000;
  await c.get('db').insert(sessions).values({
    userId, tokenHash: await sha256(token), kind, mfaOk,
    expiresAt: new Date(Date.now() + ms), ip: clientIp(c), userAgent: (c.req.header('user-agent') ?? '').slice(0, 300),
  });
  setCookie(c, kind === 'admin' ? ADMIN_COOKIE : APP_COOKIE, token, {
    httpOnly: true, secure: true, sameSite: 'Lax', path: '/', maxAge: Math.floor(ms / 1000),
  });
}

export async function endSession(c: C, kind: 'app' | 'admin') {
  const name = kind === 'admin' ? ADMIN_COOKIE : APP_COOKIE;
  const token = getCookie(c, name);
  if (token) await c.get('db').delete(sessions).where(eq(sessions.tokenHash, await sha256(token)));
  deleteCookie(c, name, { path: '/', secure: true });
}

async function load(c: C, kind: 'app' | 'admin') {
  const token = getCookie(c, kind === 'admin' ? ADMIN_COOKIE : APP_COOKIE);
  if (!token) return null;
  const db = c.get('db');
  const rows = await db
    .select({ s: sessions, u: users })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.tokenHash, await sha256(token)), eq(sessions.kind, kind), gt(sessions.expiresAt, new Date())))
    .limit(1);
  const row = rows[0];
  if (!row || row.u.status !== 'active') return null;
  return row;
}

/** Blocks cross-site writes: any state-changing request must come from the same host. */
export const sameOrigin: MiddlewareHandler<AppEnv> = async (c, next) => {
  const m = c.req.method;
  if (m !== 'GET' && m !== 'HEAD' && m !== 'OPTIONS') {
    const origin = c.req.header('origin');
    const host = new URL(c.req.url).host;
    if (!origin || new URL(origin).host !== host) return c.json({ error: 'Cross-site request refused.' }, 403);
  }
  await next();
};

export const requireUser: MiddlewareHandler<AppEnv> = async (c, next) => {
  const row = await load(c, 'app');
  if (!row) return c.json({ error: 'Please sign in.' }, 401);
  c.set('user', row.u);
  c.set('sessionId', row.s.id);
  c.executionCtx.waitUntil(c.get('db').update(users).set({ lastActiveAt: new Date() }).where(eq(users.id, row.u.id)).then(() => undefined));
  await next();
};

/** Admin session that has passed the second factor. */
export const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  const row = await load(c, 'admin');
  if (!row || row.u.role !== 'admin') return c.json({ error: 'Admin sign-in needed.' }, 401);
  if (!row.s.mfaOk) return c.json({ error: 'Second factor needed.', mfa: true }, 401);
  c.set('user', row.u);
  c.set('sessionId', row.s.id);
  await next();
};

/** Admin session before the second factor (password accepted only). */
export const requireAdminPassword: MiddlewareHandler<AppEnv> = async (c, next) => {
  const row = await load(c, 'admin');
  if (!row || row.u.role !== 'admin') return c.json({ error: 'Admin sign-in needed.' }, 401);
  c.set('user', row.u);
  c.set('sessionId', row.s.id);
  await next();
};

/** Simple attempt limiter backed by Postgres: at most `max` attempts per `key` per window. */
export async function tooMany(c: C, key: string, max: number, windowMinutes: number): Promise<boolean> {
  const db = c.get('db');
  const since = new Date(Date.now() - windowMinutes * 60_000);
  const rows = await db.select({ n: sql<number>`count(*)::int` }).from(authAttempts).where(and(eq(authAttempts.key, key), gt(authAttempts.createdAt, since)));
  if ((rows[0]?.n ?? 0) >= max) return true;
  await db.insert(authAttempts).values({ key });
  return false;
}
