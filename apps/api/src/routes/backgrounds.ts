// A signed-in person's backgrounds: what they can see and use, and buying one, all of them, or new ones (bundle
// owners). Niko Pro is one add-on for designs and backgrounds: it's added and removed at /api/designs/pro.
// Mounted inside the app router, so it needs a signed-in account with access. Every price and permission is worked
// out here; nothing a screen sends is trusted.
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { backgroundCheckouts, users } from '@niko/db';
import { backgroundInfo, backgroundQuote, isBackground, money, type BackgroundBuy } from '@niko/shared';
import { customerIn, payNow, priceLine, syncCheckout } from '../billing';
import { backgroundAccount, backgroundFor, backgroundSettings, backgroundsViewFor } from '../backgrounds';
import type { AppEnv } from '../env';
import { audit, tooMany } from '../lib/session';
import { isMode, NOT_READY, stripe } from '../stripe';

export const backgrounds = new Hono<AppEnv>();

const BUYS: BackgroundBuy[] = ['one', 'all', 'topup', 'topupall'];

async function viewJson(c: any, fresh?: any) {
  const db = c.get('db');
  const u = fresh ?? c.get('user');
  const now = await payNow(c.env, db);
  return { ...(await backgroundsViewFor(db, u)), current: await backgroundFor(db, u), payments: now.ready, testMode: now.mode === 'test' };
}

backgrounds.get('/', async (c) => c.json(await viewJson(c)));

backgrounds.post('/use', async (c) => {
  const b = await c.req.json<{ background?: string }>().catch(() => ({} as { background?: string }));
  const u = c.get('user');
  const db = c.get('db');
  if (!isBackground(b.background)) return c.json({ error: 'There’s no background by that name.' }, 400);
  const v = await backgroundsViewFor(db, u);
  const d = v.backgrounds.find((x) => x.id === b.background);
  if (!d || d.state === 'locked') return c.json({ error: 'Unlock this background first.' }, 403);
  const appearance = { ...(u.appearance as Record<string, unknown>), background: b.background };
  await db.update(users).set({ appearance }).where(eq(users.id, u.id));
  return c.json({ ok: true, background: b.background });
});

backgrounds.post('/checkout', async (c) => {
  const b = await c.req.json<{ what?: string; background?: string }>().catch(() => ({} as { what?: string; background?: string }));
  const u = c.get('user');
  const db = c.get('db');
  const now = await payNow(c.env, db);
  if (!now.ready) return c.json({ error: NOT_READY }, 503);
  if (!BUYS.includes(b.what as BackgroundBuy)) return c.json({ error: 'Choose what to unlock.' }, 400);
  const q = backgroundQuote(await backgroundSettings(db, true), await backgroundAccount(db, u), b.what as BackgroundBuy, b.background);
  if ('error' in q) return c.json({ error: q.error }, 400);
  if (await tooMany(c, 'background-checkout:' + u.id, 10, 15)) return c.json({ error: 'Too many attempts. Try again later.' }, 429);
  const single = b.what === 'one' || b.what === 'topup';
  const name = single ? `Niko · ${backgroundInfo(q.backgrounds[0]!).name} background` : b.what === 'all' ? 'Niko · all backgrounds' : 'Niko · new backgrounds';
  const item = single ? `background-${q.backgrounds[0]}` : `backgrounds-${b.what}`;
  const app = c.get('site').appUrl;
  const customer = customerIn(u, now.mode);
  const s = await stripe(now.keys, 'POST', '/checkout/sessions', {
    mode: 'payment', client_reference_id: u.id,
    ...(customer ? { customer } : { customer_email: u.email, customer_creation: 'always' }),
    line_items: [await priceLine(c.env, db, now.mode, now.keys, q.cents, { item, name })],
    metadata: { kind: 'background', user_id: u.id, what: String(b.what) },
    payment_intent_data: { metadata: { kind: 'background', user_id: u.id } },
    success_url: `${app}/backgrounds?bought={CHECKOUT_SESSION_ID}`, cancel_url: `${app}/backgrounds?bought=cancelled`,
  });
  await db.insert(backgroundCheckouts).values({ id: s.id, userId: u.id, kind: String(b.what), backgrounds: q.backgrounds, cents: q.cents, mode: now.mode });
  await audit(c, 'background.checkout', { what: b.what, backgrounds: q.backgrounds.map((d) => backgroundInfo(d).name), amount: money(q.cents) }, u.id);
  return c.json({ url: s.url });
});

// After returning from Stripe: Niko asks Stripe about that Checkout (only if it is this account's) and applies it.
backgrounds.get('/status', async (c) => {
  const u = c.get('user');
  const db = c.get('db');
  const id = c.req.query('session') ?? '';
  const valid = /^cs_(test|live)_[A-Za-z0-9_]{3,250}$/.test(id);
  if (valid) {
    const co = (await db.select().from(backgroundCheckouts).where(eq(backgroundCheckouts.id, id)).limit(1))[0];
    if (co && co.userId === u.id && isMode(co.mode)) {
      try { await syncCheckout(c.env, db, id, co.mode); } catch { /* the webhook will still arrive */ }
    }
  }
  const fresh = (await db.select().from(users).where(eq(users.id, u.id)).limit(1))[0] ?? u;
  const co = /^cs_(test|live)_/.test(id) ? (await db.select().from(backgroundCheckouts).where(eq(backgroundCheckouts.id, id)).limit(1))[0] : undefined;
  const mine = !!co && co.userId === u.id;
  return c.json({ ...(await viewJson(c, fresh)), paid: mine && !!co!.paidAt, bought: mine ? { kind: co!.kind, backgrounds: co!.backgrounds } : null });
});
