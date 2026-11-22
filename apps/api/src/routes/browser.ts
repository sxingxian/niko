// The app's browser routes: open a browser, get a pass for its live picture, open tabs, check in, close.
// Messages never mention the admin: limits read as Niko's own.
import { and, eq, isNull } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import { browserSessions } from '@niko/db';
import { hostBlocked, lastRefill, openableHost, toAddress } from '@niko/shared';
import type { AppEnv } from '../env';
import { browserState, keeper, minutesFor, openSessionOf, type BrowserState } from '../browser';
import { CfError, cfCloseTab, cfConnection, cfOpen, cfPass, cfTab } from '../browserCf';
import { audit } from '../lib/session';

export const browser = new Hono<AppEnv>();
type Ctx = Context<AppEnv>;

const NOT_INCLUDED = 'Using a browser isn’t included in your plan.';
const UNAVAILABLE = 'Niko’s browser isn’t available right now. Try again later.';
const BUSY = 'All of Niko’s browsers are busy. Try again in a minute.';
const BLOCKED = 'Niko can’t open this site.';
const isId = (v: string) => /^[0-9a-f-]{36}$/i.test(v);
/** Idle: the device stopped checking in for this long (closed, asleep or offline). */
const DEVICE_GONE_MS = 90_000;

function cfProblem(c: Ctx, e: unknown) {
  if (e instanceof CfError) {
    console.warn(`browser service: ${e.code} ${e.status}`);
    return c.json({ error: e.code === 'busy' ? BUSY : UNAVAILABLE, code: e.code === 'busy' ? 'busy' : 'unavailable' }, 503);
  }
  throw e;
}

/** The address to open, checked: a public http(s) site that isn't blocked. */
function addressFor(raw: unknown, s: BrowserState): { url: string; host: string } | { error: string } | null {
  if (raw === undefined || raw === null || raw === '') return null;
  const url = typeof raw === 'string' ? toAddress(raw) : null;
  const host = url ? openableHost(url) : null;
  if (!url || !host) return { error: 'That isn’t a website Niko can open.' };
  if (hostBlocked(host, s.defaults.blocked)) return { error: BLOCKED };
  return { url, host };
}

browser.get('/', async (c) => {
  const u = c.get('user'), db = c.get('db');
  const s = await browserState(db, u);
  const [info, minutes, open] = await Promise.all([cfConnection(c.env, db), minutesFor(db, u.id, s), openSessionOf(db, u.id)]);
  return c.json({
    offered: s.allowance.on, allowed: s.allowance.on && s.prefs.on, ready: !!info,
    prefs: s.prefs, minutes, blocked: s.defaults.blocked, staySignedIn: s.defaults.staySignedIn, maxHistoryDays: s.defaults.historyDays,
    open: open ? { id: open.id, site: open.site } : null,
  });
});

browser.post('/open', async (c) => {
  const u = c.get('user'), db = c.get('db');
  const b = await c.req.json<{ url?: string }>().catch(() => ({} as { url?: string }));
  const s = await browserState(db, u);
  if (!s.allowance.on) return c.json({ error: NOT_INCLUDED, code: 'not_included' }, 403);
  if (!s.prefs.on) return c.json({ error: 'Browsing is switched off in Settings › Browser.', code: 'off' }, 403);
  const to = addressFor(b.url, s);
  if (to && 'error' in to) return c.json({ error: to.error, code: 'blocked' }, 403);
  const minutes = await minutesFor(db, u.id, s);
  if (minutes.left !== null && minutes.left < 15) return c.json({ error: 'Today’s browser time is used up.', code: 'minutes', refillAt: minutes.refillAt }, 429);
  const conn = await cfConnection(c.env, db);
  if (!conn) return c.json({ error: UNAVAILABLE, code: 'unavailable' }, 503);
  try {
    // Keep-alive: how long Cloudflare keeps it open if nothing is connected (Niko's keeper closes it sooner).
    const { sessionId: remoteId } = await cfOpen(conn, 120_000);
    const tab = await cfTab(conn, remoteId, to?.url ?? 'about:blank');
    const row = (await db.insert(browserSessions).values({ userId: u.id, service: 'cloudflare', remoteId, site: to?.host ?? '' }).returning({ id: browserSessions.id, startedAt: browserSessions.startedAt }))[0]!;
    const now = Date.now();
    await keeper(c.env, u.id, '/start', {
      sessionId: row.id, userId: u.id, service: 'cloudflare', remoteId, startedAt: now,
      capAt: minutes.left === null ? null : now + minutes.left * 1000, refillAt: lastRefill(new Date(now), s.defaults.refillHourUtc).getTime(), idleMs: DEVICE_GONE_MS,
    });
    const pass = await cfPass(conn, remoteId, tab.id, false);
    await audit(c, 'browser.opened', { site: to?.host ?? '' }, u.id);
    return c.json({ id: row.id, targetId: tab.id, ws: pass.ws, minutes });
  } catch (e) { return cfProblem(c, e); }
});

/** The person's open browser with this id, or an answer saying it's gone. */
async function mine(c: Ctx) {
  const id = c.req.param('id') ?? '';
  if (!isId(id)) return null;
  return (await c.get('db').select().from(browserSessions).where(and(eq(browserSessions.id, id), eq(browserSessions.userId, c.get('user').id), isNull(browserSessions.endedAt))).limit(1))[0] ?? null;
}
const GONE = { error: 'This browser has closed.', code: 'ended' };

// A fresh pass to one tab (passes are good for starting a connection for a minute; reconnecting needs a new one).
browser.post('/:id/pass', async (c) => {
  const row = await mine(c);
  if (!row) return c.json(GONE, 410);
  const b = await c.req.json<{ targetId?: string; readonly?: boolean }>().catch(() => ({} as { targetId?: string; readonly?: boolean }));
  const conn = await cfConnection(c.env, c.get('db'));
  if (!conn) return c.json({ error: UNAVAILABLE, code: 'unavailable' }, 503);
  const target = typeof b.targetId === 'string' && /^[A-Za-z0-9]{6,64}$/.test(b.targetId) ? b.targetId : undefined;
  try { const p = await cfPass(conn, row.remoteId, target, b.readonly === true); return c.json({ ws: p.ws, readonly: p.readonly }); }
  catch (e) { return cfProblem(c, e); }
});

browser.post('/:id/tab', async (c) => {
  const row = await mine(c);
  if (!row) return c.json(GONE, 410);
  const s = await browserState(c.get('db'), c.get('user'));
  const b = await c.req.json<{ url?: string }>().catch(() => ({} as { url?: string }));
  const to = addressFor(b.url, s);
  if (to && 'error' in to) return c.json({ error: to.error, code: 'blocked' }, 403);
  const conn = await cfConnection(c.env, c.get('db'));
  if (!conn) return c.json({ error: UNAVAILABLE, code: 'unavailable' }, 503);
  try {
    const tab = await cfTab(conn, row.remoteId, to?.url ?? 'about:blank');
    const p = await cfPass(conn, row.remoteId, tab.id, false);
    return c.json({ targetId: tab.id, ws: p.ws });
  } catch (e) { return cfProblem(c, e); }
});

browser.delete('/:id/tab/:target', async (c) => {
  const row = await mine(c);
  if (!row) return c.json(GONE, 410);
  const target = c.req.param('target');
  const conn = await cfConnection(c.env, c.get('db'));
  if (conn && /^[A-Za-z0-9]{6,64}$/.test(target)) await cfCloseTab(conn, row.remoteId, target).catch(() => undefined);
  return c.json({ ok: true });
});

// The device checks in every 30 seconds while the browser is open. The answer says how long is left, or that it closed.
browser.post('/:id/beat', async (c) => {
  const u = c.get('user'), db = c.get('db');
  const row = await mine(c);
  if (!row) return c.json({ ended: true, why: 'closed' });
  const s = await browserState(db, u);
  // The browser was switched off for this person (by them, or for their plan) while it was open: close it.
  if (!s.allowance.on || !s.prefs.on) { await keeper(c.env, u.id, '/end', { sessionId: row.id, why: 'removed' }); return c.json({ ended: true, why: 'removed' }); }
  const m = await minutesFor(db, u.id, s, row.service as 'cloudflare');
  const r = await keeper<{ ended?: boolean; why?: string }>(c.env, u.id, '/beat', { sessionId: row.id, capAt: m.left === null ? null : Date.now() + m.left * 1000 });
  return c.json(r.ended ? { ended: true, why: r.why } : { ok: true, minutes: m });
});

browser.post('/:id/close', async (c) => {
  const row = await mine(c);
  if (row) await keeper(c.env, c.get('user').id, '/end', { sessionId: row.id, why: 'closed' });
  return c.json({ ok: true });
});
