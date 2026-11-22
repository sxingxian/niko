// Admin portal › Browser: connecting Cloudflare Browser Run, and a test the admin can run from the portal.
// Saving or removing the connection asks for a fresh code from the admin's authenticator app, so an admin session
// left open somewhere can't swap the token. Every change is written to the audit log (never the token).
import { and, eq, lt } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import { users } from '@niko/db';
import { isCfAccountId, isCfToken, openableHost } from '@niko/shared';
import type { AppEnv } from '../env';
import { totpStep, unseal } from '../lib/crypto';
import { audit, clientIp, requireAdmin } from '../lib/session';
import { clearThrottle, lockedMessage, recordFailure, throttleMinutes } from '../lib/throttle';
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

adminBrowser.get('/', async (c) => c.json({ cloudflare: await cfInfo(c.get('db')) }));

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
