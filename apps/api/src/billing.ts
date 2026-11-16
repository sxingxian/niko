// Payments on the server: the admin's prices, each account's access, and applying what Stripe confirms.
import { and, eq, inArray, isNotNull, isNull, lt, sql } from 'drizzle-orm';
import { appSettings, invites, signups, stripeEvents, users, type Db, type User } from '@niko/db';
import {
  accessState, addMonths, CODE_ALPHABET, cleanPayments, lengthLabel, money, plansOffered, UNPAID_SIGNUP_DAYS,
  type AccessInfo, type PaymentSettings, type Plan,
} from '@niko/shared';
import type { Env } from './env';
import { randomChars, sha256 } from './lib/crypto';
import { esc, sendEmail } from './lib/email';
import { idOf, invoiceSubscription, periodEnd, planOf, stripe, stripeReady } from './stripe';

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

/** What an account sees about its own access, and the plans it can choose. */
export async function accessFor(env: Env, db: Db, u: User): Promise<AccessInfo> {
  const s = await paymentSettings(db);
  const st = accessState(u, s.graceDays);
  return {
    ...st,
    lifetime: u.lifetime,
    sub: u.subId ? { plan: (u.subPlan as Plan | null) ?? null, status: u.subStatus ?? '', periodEnd: u.subPeriodEnd ? u.subPeriodEnd.toISOString() : null, cancelAtEnd: u.subCancelAtEnd } : null,
    plans: plansOffered(s),
    payments: stripeReady(env),
    portal: !!u.stripeCustomerId && stripeReady(env),
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
export async function applyPaidSession(env: Env, db: Db, s: any): Promise<boolean> {
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
    const done = await db.update(invites).set({ paidAt: new Date(), paymentIntent: pi, stripeCustomerId: customer, expiresAt: sql`greatest(${invites.expiresAt}, now() + interval '365 days')` })
      .where(and(eq(invites.id, inv.id), isNull(invites.paidAt))).returning({ id: invites.id });
    if (done.length) await logAudit(db, null, 'payment.invite', { email: inv.email, amount: money(inv.priceCents) });
    return true;
  }
  if (kind === 'signup' && typeof s.metadata?.user_id === 'string') {
    const su = (await db.select().from(signups).where(eq(signups.userId, s.metadata.user_id)).limit(1))[0];
    if (!su) return false;
    if (su.paidAt) return true;
    if (!amountOk(su.priceCents)) { console.error('stripe: sign-up payment amount does not match', su.userId); return false; }
    const done = await db.update(signups).set({ paidAt: new Date(), paymentIntent: pi, state: 'waiting' }).where(and(eq(signups.userId, su.userId), isNull(signups.paidAt))).returning({ id: signups.userId });
    if (!done.length) return true;
    // The paid months start when an admin switches the account on.
    await db.update(users).set({ accessStartMonths: su.months ?? 0, ...(customer ? { stripeCustomerId: customer } : {}) }).where(eq(users.id, su.userId));
    const u = (await db.select({ email: users.email, name: users.name }).from(users).where(eq(users.id, su.userId)).limit(1))[0];
    await logAudit(db, su.userId, 'payment.signup', { email: u?.email, amount: money(su.priceCents) });
    if (u) await tellAdmins(env, db, 'A paid sign-up is waiting for you', 'A paid sign-up is waiting',
      `${esc(u.name || u.email)} (${esc(u.email)}) confirmed their email and paid. Switch their account on in Admin → Users when you’re ready; their paid time starts then.`);
    return true;
  }
  return false;
}

/** A subscription's latest state from Stripe, written to its account. */
export async function applySubscription(db: Db, sub: any): Promise<string | null> {
  if (!sub?.id) return null;
  const byMeta = typeof sub.metadata?.user_id === 'string' ? sub.metadata.user_id : null;
  const u = (await db.select().from(users).where(byMeta ? eq(users.id, byMeta) : eq(users.subId, sub.id)).limit(1))[0];
  if (!u) return null;
  // An older subscription finishing must not overwrite a newer one.
  if (u.subId && u.subId !== sub.id && ['canceled', 'incomplete_expired'].includes(sub.status)) return u.id;
  await db.update(users).set({
    subId: sub.id, subStatus: String(sub.status ?? ''), subPlan: planOf(sub), subPeriodEnd: periodEnd(sub), subCancelAtEnd: !!sub.cancel_at_period_end,
    ...(idOf(sub.customer) ? { stripeCustomerId: idOf(sub.customer) } : {}),
  }).where(eq(users.id, u.id));
  return u.id;
}

/** Asks Stripe about a Checkout it made, and applies it if it is paid. Used when someone returns, in case the
 * webhook is slow; this is Niko asking Stripe, not trusting the returning page. */
export async function syncCheckout(env: Env, db: Db, id: string): Promise<any | null> {
  if (!/^cs_[A-Za-z0-9_]{3,250}$/.test(id) || !stripeReady(env)) return null;
  const s = await stripe(env, 'GET', `/checkout/sessions/${id}`, { expand: ['subscription'] });
  if (s.mode === 'payment') await applyPaidSession(env, db, s);
  else if (s.mode === 'subscription' && s.status === 'complete' && s.subscription) {
    const sub = typeof s.subscription === 'string' ? await stripe(env, 'GET', `/subscriptions/${s.subscription}`) : s.subscription;
    await applySubscription(db, sub);
  }
  return s;
}

/** One webhook event, at most once. */
export async function handleStripeEvent(env: Env, db: Db, event: any): Promise<void> {
  if (typeof event?.id !== 'string') return;
  const fresh = await db.insert(stripeEvents).values({ id: event.id, type: String(event.type ?? '') }).onConflictDoNothing().returning({ id: stripeEvents.id });
  if (!fresh.length) return;
  try {
    const o = event.data?.object;
    switch (event.type) {
      case 'checkout.session.completed':
      case 'checkout.session.async_payment_succeeded':
        if (o?.mode === 'payment') await applyPaidSession(env, db, o);
        else if (o?.mode === 'subscription' && o.subscription) await applySubscription(db, await stripe(env, 'GET', `/subscriptions/${idOf(o.subscription)}`));
        break;
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted':
        await applySubscription(db, o);
        break;
      case 'invoice.paid':
      case 'invoice.payment_failed': {
        const id = invoiceSubscription(o);
        if (id) await applySubscription(db, await stripe(env, 'GET', `/subscriptions/${id}`));
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
