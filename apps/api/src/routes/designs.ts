// A signed-in person's designs: what they can see and use, buying one, all of them, or new ones (bundle owners), and
// the Niko Pro add-on on a monthly or yearly plan. Mounted inside the app router, so it needs a signed-in account with
// access. Every price and permission is worked out here; nothing a screen sends is trusted.
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { designCheckouts, users } from '@niko/db';
import { designInfo, designQuote, isDesign, money, type DesignBuy } from '@niko/shared';
import { customerIn, keysOf, payNow, priceLine, syncCheckout } from '../billing';
import { backgroundSettings } from '../backgrounds';
import { activePlan, addPro, designAccount, designFor, designSettings, removePro, viewFor } from '../designs';
import type { AppEnv } from '../env';
import { audit, tooMany } from '../lib/session';
import { isMode, keysFor, NOT_READY, stripe, StripeError, type StripeMode } from '../stripe';

export const designs = new Hono<AppEnv>();

const BUYS: DesignBuy[] = ['one', 'all', 'topup', 'topupall'];

async function viewJson(c: any, fresh?: any) {
  const db = c.get('db');
  const u = fresh ?? c.get('user');
  const now = await payNow(c.env, db);
  // Niko Pro is one add-on: its wording says whether it covers backgrounds too.
  return { ...(await viewFor(db, u)), current: await designFor(db, u), payments: now.ready, testMode: now.mode === 'test', proBackgrounds: (await backgroundSettings(db)).pro };
}

designs.get('/', async (c) => c.json(await viewJson(c)));

designs.post('/use', async (c) => {
  const b = await c.req.json<{ design?: string }>().catch(() => ({} as { design?: string }));
  const u = c.get('user');
  const db = c.get('db');
  if (!isDesign(b.design)) return c.json({ error: 'There’s no design by that name.' }, 400);
  const v = await viewFor(db, u);
  const d = v.designs.find((x) => x.id === b.design);
  if (!d || d.state === 'locked') return c.json({ error: 'Unlock this design first.' }, 403);
  const appearance = { ...(u.appearance as Record<string, unknown>), design: b.design };
  await db.update(users).set({ appearance }).where(eq(users.id, u.id));
  return c.json({ ok: true, design: b.design });
});

designs.post('/checkout', async (c) => {
  const b = await c.req.json<{ what?: string; design?: string }>().catch(() => ({} as { what?: string; design?: string }));
  const u = c.get('user');
  const db = c.get('db');
  const now = await payNow(c.env, db);
  if (!now.ready) return c.json({ error: NOT_READY }, 503);
  if (!BUYS.includes(b.what as DesignBuy)) return c.json({ error: 'Choose what to unlock.' }, 400);
  const q = designQuote(await designSettings(db, true), await designAccount(db, u), b.what as DesignBuy, b.design);
  if ('error' in q) return c.json({ error: q.error }, 400);
  if (await tooMany(c, 'design-checkout:' + u.id, 10, 15)) return c.json({ error: 'Too many attempts. Try again later.' }, 429);
  const name = b.what === 'one' || b.what === 'topup' ? `Niko · ${designInfo(q.designs[0]!).name} design` : b.what === 'all' ? 'Niko · all designs' : 'Niko · new designs';
  const item = b.what === 'one' || b.what === 'topup' ? `design-${q.designs[0]}` : `designs-${b.what}`;
  const app = c.get('site').appUrl;
  const customer = customerIn(u, now.mode);
  const s = await stripe(now.keys, 'POST', '/checkout/sessions', {
    mode: 'payment', client_reference_id: u.id,
    ...(customer ? { customer } : { customer_email: u.email, customer_creation: 'always' }),
    line_items: [await priceLine(c.env, db, now.mode, now.keys, q.cents, { item, name })],
    metadata: { kind: 'design', user_id: u.id, what: String(b.what) },
    payment_intent_data: { metadata: { kind: 'design', user_id: u.id } },
    success_url: `${app}/niko?design={CHECKOUT_SESSION_ID}`, cancel_url: `${app}/niko?design=cancelled`,
  });
  await db.insert(designCheckouts).values({ id: s.id, userId: u.id, kind: String(b.what), designs: q.designs, cents: q.cents, mode: now.mode });
  await audit(c, 'design.checkout', { what: b.what, designs: q.designs.map((d) => designInfo(d).name), amount: money(q.cents) }, u.id);
  return c.json({ url: s.url });
});

// After returning from Stripe: Niko asks Stripe about that Checkout (only if it is this account's) and applies it.
designs.get('/status', async (c) => {
  const u = c.get('user');
  const db = c.get('db');
  const id = c.req.query('session') ?? '';
  if (/^cs_(test|live)_[A-Za-z0-9_]{3,250}$/.test(id)) {
    const co = (await db.select().from(designCheckouts).where(eq(designCheckouts.id, id)).limit(1))[0];
    if (co && co.userId === u.id && isMode(co.mode)) {
      try { await syncCheckout(c.env, db, id, co.mode); } catch { /* the webhook will still arrive */ }
    }
  }
  const fresh = (await db.select().from(users).where(eq(users.id, u.id)).limit(1))[0] ?? u;
  const co = /^cs_(test|live)_/.test(id) ? (await db.select().from(designCheckouts).where(eq(designCheckouts.id, id)).limit(1))[0] : undefined;
  return c.json({ ...(await viewJson(c, fresh)), paid: !!(co && co.userId === u.id && co.paidAt), bought: co && co.userId === u.id ? { kind: co.kind, designs: co.designs } : null });
});

// ---- Niko Pro: an add-on to an active monthly or yearly plan (never during pay-once time)
designs.post('/pro', async (c) => {
  const u = c.get('user');
  const db = c.get('db');
  const s = await designSettings(db, true);
  const plan = activePlan(u);
  const cents = plan === 'monthly' ? s.pro.monthly : plan === 'yearly' ? s.pro.yearly : null;
  if (u.role === 'admin') return c.json({ error: 'Admins already have every design.' }, 400);
  if (!s.pro.on || !plan || !cents || !u.subId) return c.json({ error: 'Niko Pro is offered once you’re on a monthly or yearly plan.' }, 400);
  if (u.proOn) return c.json({ error: 'Niko Pro is already on.' }, 409);
  const mode: StripeMode = isMode(u.subMode) ? u.subMode : 'test';
  const keys = keysOf(c.env, mode);
  if (!keys.STRIPE_SECRET_KEY) return c.json({ error: NOT_READY }, 503);
  if (await tooMany(c, 'design-pro:' + u.id, 6, 15)) return c.json({ error: 'Too many attempts. Try again later.' }, 429);
  try { await addPro(c.env, db, u, keys, mode, cents, plan); }
  catch (e) {
    const err = e as StripeError;
    if (err.code === 'card_declined' || err.status === 402) return c.json({ error: 'Your card couldn’t pay for Niko Pro, so nothing was added. Update your card in Account → Billing, then try again.' }, 402);
    throw e;
  }
  await audit(c, 'design.pro_on', { plan, amount: money(cents) }, u.id);
  const fresh = (await db.select().from(users).where(eq(users.id, u.id)).limit(1))[0] ?? u;
  return c.json(await viewJson(c, fresh));
});

designs.delete('/pro', async (c) => {
  const u = c.get('user');
  const db = c.get('db');
  if (!u.proOn && !u.proItem) return c.json({ error: 'Niko Pro isn’t on.' }, 400);
  const keys = keysFor(c.env, isMode(u.subMode) ? u.subMode : 'test');
  if (!keys.STRIPE_SECRET_KEY) return c.json({ error: NOT_READY }, 503);
  await removePro(db, u, keys);
  await audit(c, 'design.pro_off', {}, u.id);
  const fresh = (await db.select().from(users).where(eq(users.id, u.id)).limit(1))[0] ?? u;
  return c.json(await viewJson(c, fresh));
});
