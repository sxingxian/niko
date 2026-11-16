// A signed-in person's own plan: see it, choose a monthly or yearly plan when paid time ends (or ahead of time), and
// open Stripe's billing page to change the card or cancel. Reachable without access, so someone whose time has ended
// can choose a plan.
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { users } from '@niko/db';
import { CURRENCY, plansOffered, type Plan } from '@niko/shared';
import { accessFor, customerIn, keysOf, paymentSettings, payNow, syncCheckout } from '../billing';
import type { AppEnv } from '../env';
import { audit, requireUser, tooMany } from '../lib/session';
import { isMode, keysFor, NOT_READY, stripe, stripeReady, type StripeMode } from '../stripe';

export const billing = new Hono<AppEnv>();
billing.use('*', requireUser);

const LIVE = ['active', 'trialing', 'past_due', 'unpaid', 'incomplete'];

billing.get('/', async (c) => c.json(await accessFor(c.env, c.get('db'), c.get('user'))));

billing.post('/checkout', async (c) => {
  const b = await c.req.json<{ plan?: string; from?: string }>().catch(() => ({} as { plan?: string; from?: string }));
  const u = c.get('user');
  const db = c.get('db');
  const now = await payNow(c.env, db);
  if (!now.ready) return c.json({ error: NOT_READY }, 503);
  if (u.role === 'admin' || u.lifetime) return c.json({ error: 'Your account doesn’t need a plan.' }, 400);
  if (u.subId && u.subStatus && LIVE.includes(u.subStatus)) return c.json({ error: 'You already have a plan. Change it from Stripe’s billing page in Account.' }, 409);
  const offer = plansOffered(await paymentSettings(db)).find((p) => p.plan === b.plan);
  if (!offer) return c.json({ error: 'That plan isn’t offered right now.' }, 400);
  if (await tooMany(c, 'checkout:' + u.id, 10, 15)) return c.json({ error: 'Too many attempts. Try again later.' }, 429);
  const plan = offer.plan as Plan;
  // Chosen while time is left: billing starts when that time ends (Stripe needs that to be at least 2 days away).
  const trialEnd = u.accessUntil && u.accessUntil.getTime() > Date.now() + 2 * 86400_000 + 3600_000 ? Math.floor(u.accessUntil.getTime() / 1000) : undefined;
  const app = c.get('site').appUrl;
  const customer = customerIn(u, now.mode);
  const s = await stripe(now.keys, 'POST', '/checkout/sessions', {
    mode: 'subscription', client_reference_id: u.id,
    ...(customer ? { customer } : { customer_email: u.email }),
    line_items: [{ quantity: 1, price_data: { currency: CURRENCY, unit_amount: offer.cents, recurring: { interval: plan === 'monthly' ? 'month' : 'year' }, product_data: { name: plan === 'monthly' ? 'Niko · monthly plan' : 'Niko · yearly plan' } } }],
    subscription_data: { metadata: { user_id: u.id, plan }, ...(trialEnd ? { trial_end: trialEnd } : {}) },
    metadata: { kind: 'plan', user_id: u.id, plan },
    success_url: `${app}${b.from === 'account' ? '/account' : '/'}?plan={CHECKOUT_SESSION_ID}`, cancel_url: `${app}${b.from === 'account' ? '/account' : '/'}?plan=cancelled`,
  });
  await audit(c, 'plan.checkout', { plan }, u.id);
  return c.json({ url: s.url });
});

// After returning from Stripe: Niko asks Stripe about that Checkout (only if it is this account's) and applies it.
billing.get('/status', async (c) => {
  const u = c.get('user');
  const db = c.get('db');
  const id = c.req.query('session') ?? '';
  if (/^cs_(test|live)_[A-Za-z0-9_]{3,250}$/.test(id)) {
    // A Checkout id says which mode it belongs to.
    const mode: StripeMode = id.startsWith('cs_live_') ? 'live' : 'test';
    try {
      const s = await stripe(keysFor(c.env, mode), 'GET', `/checkout/sessions/${id}`);
      if (s?.metadata?.user_id === u.id) await syncCheckout(c.env, db, id, mode);
    } catch { /* the webhook will still arrive */ }
  }
  const fresh = (await db.select().from(users).where(eq(users.id, u.id)).limit(1))[0] ?? u;
  return c.json(await accessFor(c.env, db, fresh));
});

billing.post('/portal', async (c) => {
  const u = c.get('user');
  // The billing page of the mode the plan is in (or, without a plan, the mode payments use now).
  const mode: StripeMode = isMode(u.subMode) ? u.subMode : (await payNow(c.env, c.get('db'))).mode;
  const keys = keysOf(c.env, mode);
  const customer = customerIn(u, mode);
  if (!stripeReady(keys)) return c.json({ error: NOT_READY }, 503);
  if (!customer) return c.json({ error: 'There’s nothing to manage yet.' }, 400);
  const s = await stripe(keys, 'POST', '/billing_portal/sessions', { customer, return_url: `${c.get('site').appUrl}/account` });
  return c.json({ url: s.url });
});
