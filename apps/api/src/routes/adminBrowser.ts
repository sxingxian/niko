// Admin portal › Browser: connecting Cloudflare Browser Run, and a test the admin can run from the portal.
// Saving or removing the connection asks for a fresh code from the admin's authenticator app, so an admin session
// left open somewhere can't swap the token. Every change is written to the audit log (never the token).
import { and, eq, isNull, lt } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import { browserSessions, browserSignins, users } from '@niko/db';
import { browserFor, cleanBrowserAccess, keyParamFor, cleanBrowserDefaults, isCfAccountId, isCfToken, openableHost } from '@niko/shared';
import type { AppEnv } from '../env';
import { totpStep, unseal } from '../lib/crypto';
import { audit, clientIp, requireAdmin } from '../lib/session';
import { clearThrottle, lockedMessage, recordFailure, throttleMinutes } from '../lib/throttle';
import { browserDefaults, keeper, saveBrowserDefaults } from '../browser';
import { accountConn, accountServices, cleanServiceInput, removeService, saveService, ServiceError, testService, type ServiceKind } from '../browserServices';
import { cfClose, CfError, cfConnection, cfInfo, cfOpen, cfPass, cfTab, cfTest, forgetCf, saveCf } from '../browserCf';

export const adminBrowser = new Hono<AppEnv>();
adminBrowser.use('*', requireAdmin);
type Ctx = Context<AppEnv>;

/** Checks a fresh code from the admin's authenticator app. Each code works once (the same rule as signing in), and wrong
 * codes count towards the sign-in lockout. Returns an error answer, or null when the code is right. */
export async function confirmAdminCode(c: Ctx, code: unknown): Promise<Response | null> {
  const u = c.get('user'), db = c.get('db'), ip = clientIp(c);
  const locked = await throttleMinutes(db, u.email, ip);
  if (locked > 0) return c.json({ error: lockedMessage(locked) }, 429);
  const wrong = async () => {
    const m = await recordFailure(db, u.email, ip);
    return m > 0 ? c.json({ error: lockedMessage(m) }, 429) : c.json({ error: 'That code is not correct. Use a new code from your authenticator app.', field: 'code' }, 401);
  };
  const secret = await unseal<string>(c.env.ENCRYPTION_KEY, u.totpSecretEnc);
  const step = secret ? await totpStep(secret, String(code ?? '').replace(/\s/g, '')) : null;
  if (step === null) return wrong();
  const fresh = await db.update(users).set({ totpLastStep: step }).where(and(eq(users.id, u.id), lt(users.totpLastStep, step))).returning({ id: users.id });
  if (fresh.length === 0) return wrong();
  await clearThrottle(db, u.email, ip);
  return null;
}

adminBrowser.get('/', async (c) => {
  const db = c.get('db');
  const people = await db.select({ id: users.id, name: users.name, email: users.email, role: users.role, browserAccess: users.browserAccess }).from(users).orderBy(users.createdAt);
  return c.json({ cloudflare: await cfInfo(db), services: await accountServices(db), defaults: await browserDefaults(db, true), users: people.map((p) => ({ ...p, browserAccess: cleanBrowserAccess(p.browserAccess) })) });
});

/** Closes the open browsers of people who may no longer use one (after the default or their own setting changed). */
async function closeForbidden(c: Ctx, only?: string): Promise<void> {
  const db = c.get('db');
  const d = await browserDefaults(db, true);
  const open = await db.select({ id: browserSessions.id, userId: browserSessions.userId, role: users.role, access: users.browserAccess })
    .from(browserSessions).innerJoin(users, eq(users.id, browserSessions.userId))
    .where(only ? and(isNull(browserSessions.endedAt), eq(browserSessions.userId, only)) : isNull(browserSessions.endedAt));
  for (const o of open) if (!browserFor(d, (o.access ?? {}) as Record<string, unknown>, o.role === 'admin').on) await keeper(c.env, o.userId, '/end', { sessionId: o.id, why: 'removed' }).catch(() => undefined);
}

// The default for everyone (the limits, "Stay signed in", the longest history and blocked sites apply to everyone).
adminBrowser.put('/default', async (c) => {
  const db = c.get('db');
  const b = await c.req.json<{ defaults?: unknown }>().catch(() => ({} as { defaults?: unknown }));
  const before = await browserDefaults(db, true);
  const next = cleanBrowserDefaults({ ...before, ...(b.defaults && typeof b.defaults === 'object' ? b.defaults : {}) });
  await saveBrowserDefaults(db, next);
  // "Stay signed in" switched off: every kept sign-in is deleted now.
  let forgot = 0;
  if (before.staySignedIn && !next.staySignedIn) forgot = (await db.delete(browserSignins).returning({ u: browserSignins.userId })).length;
  if (before.on && !next.on) await closeForbidden(c);
  const changed = (Object.keys(next) as (keyof typeof next)[]).filter((k) => JSON.stringify(next[k]) !== JSON.stringify(before[k]));
  await audit(c, 'admin.browser.default', { changed, ...(forgot ? { forgotSignins: forgot } : {}) });
  return c.json({ defaults: next, forgot });
});

// One person's changes (only what differs is kept; an empty set means they follow the default).
adminBrowser.put('/users/:id', async (c) => {
  const db = c.get('db'), id = c.req.param('id');
  if (!/^[0-9a-f-]{36}$/i.test(id)) return c.json({ error: 'Not found.' }, 404);
  const b = await c.req.json<{ access?: unknown }>().catch(() => ({} as { access?: unknown }));
  const access = cleanBrowserAccess(b.access);
  const r = await db.update(users).set({ browserAccess: access as unknown as Record<string, unknown> }).where(eq(users.id, id)).returning({ id: users.id });
  if (!r.length) return c.json({ error: 'Not found.' }, 404);
  await closeForbidden(c, id);
  await audit(c, 'admin.browser.user', { user: id, changed: Object.keys(access) });
  return c.json({ access });
});

// Connect (or replace) Cloudflare Browser Run. Tested before it is saved.
adminBrowser.put('/cloudflare', async (c) => {
  const b = await c.req.json<{ account?: string; token?: string; code?: string }>().catch(() => ({} as Record<string, string>));
  const account = String(b.account ?? '').trim().toLowerCase(), token = String(b.token ?? '').trim();
  if (!isCfAccountId(account)) return c.json({ error: 'The account ID is 32 letters and numbers. Copy it from your Cloudflare account’s overview page.', field: 'account' }, 400);
  if (!isCfToken(token)) return c.json({ error: 'That doesn’t look like a Cloudflare API token. Copy the whole token again.', field: 'token' }, 400);
  const bad = await confirmAdminCode(c, b.code);
  if (bad) return bad;
  try { await cfTest(account, token); }
  catch (e) {
    if (e instanceof CfError) {
      await audit(c, 'admin.browser.cloudflare.test_failed', { why: e.code, status: e.status });
      // A busy account or used-up minutes still proves the token works: save it, and say so.
      if (e.code !== 'limit' && e.code !== 'busy') return c.json({ error: e.message, field: e.code === 'account' ? 'account' : e.code === 'token' ? 'token' : undefined }, 400);
    } else throw e;
  }
  const info = await saveCf(c.env, c.get('db'), account, token, c.get('user').id);
  await audit(c, 'admin.browser.cloudflare.connected', { account: '…' + info.tail });
  return c.json({ cloudflare: info });
});

adminBrowser.delete('/cloudflare', async (c) => {
  const b = await c.req.json<{ code?: string }>().catch(() => ({} as Record<string, string>));
  const bad = await confirmAdminCode(c, b.code);
  if (bad) return bad;
  await forgetCf(c.get('db'));
  await audit(c, 'admin.browser.cloudflare.removed');
  return c.json({ cloudflare: { connected: false } });
});

// ---- The test (Admin portal › Browser › Test): opens a browser, then the portal itself connects straight to it with
// a short-lived pass, the same way people's devices will. Nothing about the pages opened is kept.
const TEST_START = 'https://example.com/';
adminBrowser.post('/test/open', async (c) => {
  const conn = await cfConnection(c.env, c.get('db'));
  if (!conn) return c.json({ error: 'Connect Cloudflare first.' }, 400);
  const t0 = Date.now();
  try {
    const { sessionId } = await cfOpen(conn, 120_000);
    const t1 = Date.now();
    const tab = await cfTab(conn, sessionId, TEST_START);
    const t2 = Date.now();
    const pass = await cfPass(conn, sessionId, tab.id, false, 60_000);
    await audit(c, 'admin.browser.test');
    return c.json({ sessionId, targetId: tab.id, ws: pass.ws, ms: { open: t1 - t0, tab: t2 - t1, pass: Date.now() - t2 } });
  } catch (e) {
    if (e instanceof CfError) return c.json({ error: e.message }, 400);
    throw e;
  }
});
// Another tab in the test browser, for checking whether a sign-in page lets an automated browser in.
adminBrowser.post('/test/tab', async (c) => {
  const b = await c.req.json<{ sessionId?: string; url?: string }>().catch(() => ({} as Record<string, string>));
  const conn = await cfConnection(c.env, c.get('db'));
  if (!conn) return c.json({ error: 'Connect Cloudflare first.' }, 400);
  if (!/^[A-Za-z0-9-]{8,80}$/.test(String(b.sessionId ?? ''))) return c.json({ error: 'Start the test again.' }, 400);
  if (!openableHost(b.url)) return c.json({ error: 'Enter a full https:// address of a public site.' }, 400);
  try {
    const tab = await cfTab(conn, String(b.sessionId), String(b.url));
    const pass = await cfPass(conn, String(b.sessionId), tab.id, false, 60_000);
    return c.json({ targetId: tab.id, ws: pass.ws });
  } catch (e) {
    if (e instanceof CfError) return c.json({ error: e.message }, 400);
    throw e;
  }
});
adminBrowser.post('/test/close', async (c) => {
  const b = await c.req.json<{ sessionId?: string }>().catch(() => ({} as Record<string, string>));
  const conn = await cfConnection(c.env, c.get('db'));
  if (conn && /^[A-Za-z0-9-]{8,80}$/.test(String(b.sessionId ?? ''))) await cfClose(conn, String(b.sessionId)).catch(() => undefined);
  return c.json({ ok: true });
});

// ---- The account's own browser server and hosted service (Browser services 2 and 3). Saved with a fresh code from
// the admin's authenticator app, tested first; the key is sealed and never shown again.
adminBrowser.put('/service', async (c) => {
  const b = await c.req.json<{ kind?: string; name?: string; url?: string; key?: string; code?: string }>().catch(() => ({} as Record<string, string>));
  const v = cleanServiceInput(b, false);
  if ('error' in v) return c.json(v, 400);
  const bad = await confirmAdminCode(c, b.code);
  if (bad) return bad;
  const probe = new URL(v.url);
  if (v.key) probe.searchParams.set(keyParamFor(v.url), v.key);
  if (probe.protocol === 'https:') probe.protocol = 'wss:';
  let product: string;
  try { product = await testService(probe.toString()); }
  catch (e) {
    await audit(c, 'admin.browser.service.test_failed', { kind: v.kind, why: e instanceof ServiceError ? e.code : 'other' });
    return c.json({ error: e instanceof ServiceError ? `${e.message} Check the address${v.key ? ' and key' : ''}.` : 'The browser service couldn’t be tested.', field: e instanceof ServiceError && e.code === 'refused' ? 'key' : 'url' }, 400);
  }
  const info = await saveService(c.env, c.get('db'), null, v);
  await audit(c, 'admin.browser.service.saved', { kind: v.kind, host: info.host, product });
  return c.json({ service: info, product });
});
adminBrowser.post('/service/:kind/test', async (c) => {
  const kind = c.req.param('kind') === 'hosted' ? 'hosted' : 'server';
  const conn = await accountConn(c.env, c.get('db'), kind);
  if (!conn) return c.json({ error: 'Set it up first.' }, 404);
  try { return c.json({ ok: true, product: await testService(conn.wsUrl) }); }
  catch (e) { return c.json({ error: e instanceof ServiceError ? e.message : 'The browser service couldn’t be tested.' }, 400); }
});
adminBrowser.delete('/service/:kind', async (c) => {
  const kind: ServiceKind = c.req.param('kind') === 'hosted' ? 'hosted' : 'server';
  const b = await c.req.json<{ code?: string }>().catch(() => ({} as Record<string, string>));
  const bad = await confirmAdminCode(c, b.code);
  if (bad) return bad;
  await removeService(c.get('db'), null, kind);
  await audit(c, 'admin.browser.service.removed', { kind });
  return c.json({ ok: true });
});
