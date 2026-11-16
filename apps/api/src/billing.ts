// Payments on the server: the admin's prices, each account's access, and applying what Stripe confirms.
import { and, eq, inArray, isNotNull, isNull, lt, sql } from 'drizzle-orm';
import { appSettings, invites, signups, stripeEvents, users, type Db, type User } from '@niko/db';
import {
  accessState, addMonths, CODE_ALPHABET, cleanPayments, lengthLabel, money, plansOffered, UNPAID_SIGNUP_DAYS,
  type AccessInfo, type PaymentSettings, type Plan,
} from '@niko/shared';
import type { Env } from './env';
import { randomChars, seal, sha256, unseal } from './lib/crypto';
import { esc, sendEmail } from './lib/email';
import { idOf, invoiceSubscription, isMode, keysFor, periodEnd, planOf, stripe, StripeError, stripeReady, type StripeEnv, type StripeMode, type StripeSecrets } from './stripe';

export const PAYMENTS_KEY = 'payments';
let cache: { at: number; v: PaymentSettings } | null = null;
/** The admin's prices, read at most every 30 seconds per Worker instance. */
export async function paymentSettings(db: Db, fresh = false): Promise<PaymentSettings> {
  if (!fresh && cache && Date.now() - cache.at < 30_000) return cache.v;
  const row = (await db.select().from(appSettings).where(eq(appSettings.key, PAYMENTS_KEY)).limit(1).catch(() => []))[0];
  cache = { at: Date.now(), v: cleanPayments(row?.value) };
  return cache.v;
}
export const forgetPayments = () => { cache = null; };

// ---------------------------------------------------------------- test or live
export const STRIPE_MODE_KEY = 'stripe-mode';
let modeCache: { at: number; v: StripeMode } | null = null;
/** Which Stripe mode new payments use, chosen in Admin → Payments. Test until switched. */
export async function stripeMode(db: Db, fresh = false): Promise<StripeMode> {
  if (!fresh && modeCache && Date.now() - modeCache.at < 30_000) return modeCache.v;
  const row = (await db.select().from(appSettings).where(eq(appSettings.key, STRIPE_MODE_KEY)).limit(1).catch(() => []))[0];
  modeCache = { at: Date.now(), v: row?.value === 'live' ? 'live' : 'test' };
  return modeCache.v;
}
export const forgetStripeMode = () => { modeCache = null; };
// ---------------------------------------------------------------- what Niko set up in Stripe
// Nothing is set up by hand in Stripe. With a mode's secret key in place, Admin → Payments → Connect has Niko create, in
// that Stripe mode: the webhook endpoint (its signing secret is kept here, encrypted), the billing page settings, and,
// as payments need them, one product per kind of purchase. Prices always come from Niko with each payment.
export const STRIPE_CONNECT_KEY = 'stripe-connect';
interface ModeConnect { hook?: string; endpoint?: string; portal?: string; products?: Record<string, string>; at?: string; account?: string }
type Connect = Partial<Record<StripeMode, ModeConnect>>;
let connCache: { at: number; v: Connect } | null = null;
export async function connectInfo(db: Db, fresh = false): Promise<Connect> {
  if (!fresh && connCache && Date.now() - connCache.at < 30_000) return connCache.v;
  const row = (await db.select().from(appSettings).where(eq(appSettings.key, STRIPE_CONNECT_KEY)).limit(1).catch(() => []))[0];
  const v = (row?.value && typeof row.value === 'object' ? row.value : {}) as Connect;
  connCache = { at: Date.now(), v };
  return v;
}
async function saveConnect(db: Db, mode: StripeMode, patch: ModeConnect) {
  const all = await connectInfo(db, true);
  const next = { ...all, [mode]: { ...all[mode], ...patch } };
  await db.insert(appSettings).values({ key: STRIPE_CONNECT_KEY, value: next }).onConflictDoUpdate({ target: appSettings.key, set: { value: next } });
  connCache = null;
}
/** The Worker secrets, with the webhook signing secrets Niko made filled in where none is set by hand. */
export async function secretsFor(env: Env, db: Db): Promise<StripeSecrets> {
  const info = await connectInfo(db);
  const open = async (m: StripeMode) => (info[m]?.hook ? await unseal<string>(env.ENCRYPTION_KEY, info[m]!.hook!).catch(() => null) : null) ?? undefined;
  return {
    ...env,
    STRIPE_TEST_WEBHOOK_SECRET: env.STRIPE_TEST_WEBHOOK_SECRET ?? await open('test'),
    STRIPE_LIVE_WEBHOOK_SECRET: env.STRIPE_LIVE_WEBHOOK_SECRET ?? await open('live'),
  };
}
/** The mode and keys new payments use now. */
export async function payNow(env: Env, db: Db): Promise<{ mode: StripeMode; keys: StripeEnv; ready: boolean }> {
  const mode = await stripeMode(db);
  const keys = keysFor(await secretsFor(env, db), mode);
  return { mode, keys, ready: stripeReady(keys) };
}
/** The secret key for something made in a given mode (an invite's payment, a plan); test when unknown. */
export const keysOf = (env: Env, mode: string | null | undefined) => keysFor(env, isMode(mode) ? mode : 'test');

const HOOK_EVENTS = ['checkout.session.completed', 'checkout.session.async_payment_succeeded', 'customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted', 'invoice.paid', 'invoice.payment_failed'];
/** Sets up a Stripe mode for Niko: checks the key, then (re)creates Niko's webhook endpoint and billing page settings.
 * Safe to run again; an older Niko endpoint at the same address is replaced. */
export async function connectStripe(env: Env, db: Db, mode: StripeMode, origin: string): Promise<{ account: string; chargesEnabled: boolean | null }> {
  const keys = keysFor(env, mode);
  if (!keys.STRIPE_SECRET_KEY) throw new StripeError(`Add the ${mode} secret key to the server first (docs/DEPLOYMENT.md, section 1c).`, 400);
  let account = '', chargesEnabled: boolean | null = null;
  try {
    const a = await stripe(keys, 'GET', '/account');
    account = String(a.business_profile?.name || a.settings?.dashboard?.display_name || a.email || a.id || '');
    chargesEnabled = typeof a.charges_enabled === 'boolean' ? a.charges_enabled : null;
  } catch (e) { if ((e as StripeError).status === 401) throw new StripeError(`Stripe didn’t accept the ${mode} secret key. Copy it again from Stripe → Developers → API keys.`, 400); }
  const url = `${origin}/api/hooks/stripe`;
  const list = await stripe(keys, 'GET', '/webhook_endpoints', { limit: 100 });
  for (const ep of list.data ?? []) if (ep.url === url) await stripe(keys, 'DELETE', `/webhook_endpoints/${ep.id}`);
  const ep = await stripe(keys, 'POST', '/webhook_endpoints', { url, enabled_events: HOOK_EVENTS, description: 'Niko (made by Niko; do not edit)', metadata: { niko: 'true' } });
  const portal = await stripe(keys, 'POST', '/billing_portal/configurations', {
    business_profile: { headline: 'Niko · manage your plan' },
    features: {
      payment_method_update: { enabled: true }, invoice_history: { enabled: true },
      subscription_cancel: { enabled: true, mode: 'at_period_end' }, customer_update: { enabled: false },
    },
    metadata: { niko: 'true' },
  });
  await saveConnect(db, mode, { hook: await seal(env.ENCRYPTION_KEY, ep.secret), endpoint: ep.id, portal: portal.id, at: new Date().toISOString(), account });
  return { account, chargesEnabled };
}

/** A Checkout line item with the price from Niko. The product is Niko's own, made in Stripe the first time it is needed,
 * so Stripe's product list stays short; if it can't be made, the name is sent with the price instead. */
export async function priceLine(env: Env, db: Db, mode: StripeMode, keys: StripeEnv, cents: number, what: { months: number } | { plan: Plan }) {
  const key = 'plan' in what ? `plan-${what.plan}` : `access-${what.months}`;
  const name = 'plan' in what ? (what.plan === 'monthly' ? 'Niko · monthly plan' : 'Niko · yearly plan') : `Niko · ${lengthLabel(what.months)} of access`;
  const recurring = 'plan' in what ? { recurring: { interval: what.plan === 'monthly' ? 'month' : 'year' } } : {};
  let product = (await connectInfo(db))[mode]?.products?.[key];
  if (!product) {
    try {
      const p = await stripe(keys, 'POST', '/products', { name, metadata: { niko: key } }, `niko-product-${mode}-${key}`);
      product = p.id as string;
      const info = await connectInfo(db, true);
      await saveConnect(db, mode, { products: { ...info[mode]?.products, [key]: product } });
    } catch { product = undefined; }
  }
  return { quantity: 1, price_data: { currency: 'sgd', unit_amount: cents, ...recurring, ...(product ? { product } : { product_data: { name } }) } };
}
/** An account's Stripe customer in a mode, and the update that sets it. */
export const customerIn = (u: { stripeCustomerTest: string | null; stripeCustomerLive: string | null }, mode: StripeMode) => (mode === 'live' ? u.stripeCustomerLive : u.stripeCustomerTest);
export const setCustomer = (mode: StripeMode, id: string | null) => (!id ? {} : mode === 'live' ? { stripeCustomerLive: id } : { stripeCustomerTest: id });

/** What an account sees about its own access, and the plans it can choose. */
export async function accessFor(env: Env, db: Db, u: User): Promise<AccessInfo> {
  const s = await paymentSettings(db);
  const st = accessState(u, s.graceDays);
  const now = await payNow(env, db);
  const portalMode: StripeMode = isMode(u.subMode) ? u.subMode : now.mode;
  return {
    ...st,
    lifetime: u.lifetime,
    sub: u.subId ? { plan: (u.subPlan as Plan | null) ?? null, status: u.subStatus ?? '', periodEnd: u.subPeriodEnd ? u.subPeriodEnd.toISOString() : null, cancelAtEnd: u.subCancelAtEnd } : null,
    plans: plansOffered(s),
    payments: now.ready,
    testMode: now.mode === 'test',
    portal: !!customerIn(u, portalMode) && !!keysFor(env, portalMode).STRIPE_SECRET_KEY,
    endedAt: !st.has ? (latest(u.accessUntil, u.subPeriodEnd)?.toISOString() ?? null) : null,
    since: u.createdAt.toISOString(),
  };
}
const latest = (a: Date | null, b: Date | null) => (a && b ? (a > b ? a : b) : a ?? b);

// ---------------------------------------------------------------- codes
export const makeInviteCode = () => randomChars(CODE_ALPHABET, 6);
export const makeEmailCode = () => randomChars('0123456789', 6);
/** Codes are stored only as hashes, tied to the invite or sign-up they belong to. */
export const inviteCodeHash = (inviteId: string, code: string) => sha256(`niko/invite-code/v1\u0000${inviteId}\u0000${code}`);
export const emailCodeHash = (userId: string, code: string) => sha256(`niko/email-code/v1\u0000${userId}\u0000${code}`);

// ---------------------------------------------------------------- applying what Stripe confirms
/** A one-time payment Stripe says is paid: an invite's or a sign-up's. Checked against the price fixed earlier. */
export async function applyPaidSession(env: Env, db: Db, s: any, mode: StripeMode): Promise<boolean> {
  if (s?.mode !== 'payment' || s?.payment_status !== 'paid') return false;
  const kind = s.metadata?.kind;
  const amountOk = (cents: number | null) => typeof cents === 'number' && s.amount_total === cents && String(s.currency).toLowerCase() === 'sgd';
  const pi = idOf(s.payment_intent);
  const customer = idOf(s.customer);
  if (kind === 'invite' && typeof s.metadata?.invite_id === 'string') {
    const inv = (await db.select().from(invites).where(eq(invites.id, s.metadata.invite_id)).limit(1))[0];
    if (!inv || inv.access !== 'paid') return false;
    if (inv.paidAt) return true;
    if (!amountOk(inv.priceCents)) { console.error('stripe: invite payment amount does not match', inv.id); return false; }
    // Paid: the link stays open until the account is made (a year at most).
    const done = await db.update(invites).set({ paidAt: new Date(), paymentIntent: pi, stripeCustomerId: customer, stripeMode: mode, expiresAt: sql`greatest(${invites.expiresAt}, now() + interval '365 days')` })
      .where(and(eq(invites.id, inv.id), isNull(invites.paidAt))).returning({ id: invites.id });
    if (done.length) await logAudit(db, null, 'payment.invite', { email: inv.email, amount: money(inv.priceCents), mode });
    return true;
  }
  if (kind === 'signup' && typeof s.metadata?.user_id === 'string') {
    const su = (await db.select().from(signups).where(eq(signups.userId, s.metadata.user_id)).limit(1))[0];
    if (!su) return false;
    if (su.paidAt) return true;
    if (!amountOk(su.priceCents)) { console.error('stripe: sign-up payment amount does not match', su.userId); return false; }
    const done = await db.update(signups).set({ paidAt: new Date(), paymentIntent: pi, state: 'waiting', stripeMode: mode }).where(and(eq(signups.userId, su.userId), isNull(signups.paidAt))).returning({ id: signups.userId });
    if (!done.length) return true;
    // The paid months start when an admin switches the account on.
    await db.update(users).set({ accessStartMonths: su.months ?? 0, paidMode: mode, ...setCustomer(mode, customer) }).where(eq(users.id, su.userId));
    const u = (await db.select({ email: users.email, name: users.name }).from(users).where(eq(users.id, su.userId)).limit(1))[0];
    await logAudit(db, su.userId, 'payment.signup', { email: u?.email, amount: money(su.priceCents), mode });
    if (u) await tellAdmins(env, db, 'A paid sign-up is waiting for you', 'A paid sign-up is waiting',
      `${esc(u.name || u.email)} (${esc(u.email)}) confirmed their email and paid. Switch their account on in Admin → Users when you’re ready; their paid time starts then.`);
    return true;
  }
  return false;
}

/** A subscription's latest state from Stripe, written to its account. */
export async function applySubscription(db: Db, sub: any, mode: StripeMode): Promise<string | null> {
  if (!sub?.id) return null;
  const byMeta = typeof sub.metadata?.user_id === 'string' ? sub.metadata.user_id : null;
  const u = (await db.select().from(users).where(byMeta ? eq(users.id, byMeta) : eq(users.subId, sub.id)).limit(1))[0];
  if (!u) return null;
  // An older subscription finishing must not overwrite a newer one.
  if (u.subId && u.subId !== sub.id && ['canceled', 'incomplete_expired'].includes(sub.status)) return u.id;
  await db.update(users).set({
    subId: sub.id, subStatus: String(sub.status ?? ''), subPlan: planOf(sub), subPeriodEnd: periodEnd(sub), subCancelAtEnd: !!sub.cancel_at_period_end, subMode: mode,
    ...setCustomer(mode, idOf(sub.customer)),
  }).where(eq(users.id, u.id));
  return u.id;
}

/** Asks Stripe about a Checkout it made, and applies it if it is paid. Used when someone returns, in case the
 * webhook is slow; this is Niko asking Stripe, not trusting the returning page. */
export async function syncCheckout(env: Env, db: Db, id: string, mode: StripeMode): Promise<any | null> {
  const keys = keysFor(env, mode);
  if (!/^cs_[A-Za-z0-9_]{3,250}$/.test(id) || !keys.STRIPE_SECRET_KEY) return null;
  const s = await stripe(keys, 'GET', `/checkout/sessions/${id}`, { expand: ['subscription'] });
  if (s.mode === 'payment') await applyPaidSession(env, db, s, mode);
  else if (s.mode === 'subscription' && s.status === 'complete' && s.subscription) {
    const sub = typeof s.subscription === 'string' ? await stripe(keys, 'GET', `/subscriptions/${s.subscription}`) : s.subscription;
    await applySubscription(db, sub, mode);
  }
  return s;
}

/** One webhook event, at most once. */
export async function handleStripeEvent(env: Env, db: Db, event: any, mode: StripeMode): Promise<void> {
  if (typeof event?.id !== 'string') return;
  const fresh = await db.insert(stripeEvents).values({ id: event.id, type: String(event.type ?? ''), mode }).onConflictDoNothing().returning({ id: stripeEvents.id });
  if (!fresh.length) return;
  const keys = keysFor(env, mode);
  try {
    const o = event.data?.object;
    switch (event.type) {
      case 'checkout.session.completed':
      case 'checkout.session.async_payment_succeeded':
        if (o?.mode === 'payment') await applyPaidSession(env, db, o, mode);
        else if (o?.mode === 'subscription' && o.subscription) await applySubscription(db, await stripe(keys, 'GET', `/subscriptions/${idOf(o.subscription)}`), mode);
        break;
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted':
        await applySubscription(db, o, mode);
        break;
      case 'invoice.paid':
      case 'invoice.payment_failed': {
        const id = invoiceSubscription(o);
        const userId = id ? await applySubscription(db, await stripe(keys, 'GET', `/subscriptions/${id}`), mode) : null;
        // Niko tells the person itself, so nothing needs switching on in Stripe's email settings.
        if (event.type === 'invoice.payment_failed' && userId) {
          const u = (await db.select({ email: users.email }).from(users).where(eq(users.id, userId)).limit(1))[0];
          const s = await paymentSettings(db);
          if (u) await sendEmail(env, u.email, 'Your Niko payment didn’t go through', 'Your Niko payment didn’t go through',
            `Stripe couldn’t take your plan’s payment. It will try again over the next few days, and Niko keeps working for ${s.graceDays} days. To fix it now, open Niko → Account → Billing → Manage, and update your card.`);
        }
        break;
      }
    }
  } catch (e) {
    // Let Stripe send it again later.
    await db.delete(stripeEvents).where(eq(stripeEvents.id, event.id));
    throw e;
  }
}

// ---------------------------------------------------------------- email and audit
async function logAudit(db: Db, userId: string | null, action: string, detail: Record<string, unknown>) {
  await db.execute(sql`insert into audit_log (user_id, action, detail) values (${userId}, ${action}, ${JSON.stringify(detail)}::jsonb)`).catch((e) => console.error('audit failed', action, e));
}
export async function tellAdmins(env: Env, db: Db, subject: string, heading: string, body: string) {
  const admins = await db.select({ email: users.email }).from(users).where(and(eq(users.role, 'admin'), eq(users.status, 'active')));
  for (const a of admins) await sendEmail(env, a.email, subject, heading, body).catch(() => false);
}
/** "SGD 9.00 a month or SGD 90.00 a year", from the plans that are on. */
export function plansLine(s: PaymentSettings): string {
  return plansOffered(s).map((p) => `${money(p.cents)} a ${p.plan === 'monthly' ? 'month' : 'year'}`).join(' or ');
}
export const dateLabel = (d: Date) => d.toLocaleDateString('en-SG', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Singapore' });

// ---------------------------------------------------------------- once a day
/** Removes unpaid sign-ups after 7 days, and reminds people 7 days before their paid time ends. */
export async function daily(env: Env, db: Db): Promise<void> {
  const cutoff = new Date(Date.now() - UNPAID_SIGNUP_DAYS * 86400_000);
  const stale = await db.select({ id: signups.userId }).from(signups).where(and(isNull(signups.paidAt), lt(signups.createdAt, cutoff)));
  if (stale.length) {
    await db.delete(users).where(and(inArray(users.id, stale.map((x) => x.id)), eq(users.status, 'off')));
    await logAudit(db, null, 'signup.removed_unpaid', { count: stale.length });
  }
  const s = await paymentSettings(db, true);
  if (!s.remind) return;
  const soon = await db.select().from(users).where(and(
    eq(users.status, 'active'), eq(users.lifetime, false), isNotNull(users.accessUntil),
    sql`${users.accessUntil} > now() and ${users.accessUntil} <= now() + interval '7 days'`,
    sql`(${users.remindedFor} is null or ${users.remindedFor} <> ${users.accessUntil})`,
    sql`(${users.subStatus} is null or ${users.subStatus} not in ('active','trialing'))`,
    sql`${users.role} <> 'admin'`,
  ));
  const line = plansLine(s);
  for (const u of soon) {
    await sendEmail(env, u.email, 'Your Niko time ends soon', 'Your Niko time ends soon',
      `Your time with Niko ends on ${esc(dateLabel(u.accessUntil!))}. Nothing renews by itself. To keep going, choose a plan in Niko under Account${line ? ` (${esc(line)})` : ''}. Choose it in the next few days and billing starts only when your time ends.`);
    // Copied in the database: a JavaScript date would drop the microseconds and never match again.
    await db.update(users).set({ remindedFor: sql`${users.accessUntil}` }).where(eq(users.id, u.id));
  }
}

export { addMonths, lengthLabel, money };
