// Backgrounds on the server: the admin's offer, what each account owns, and applying what Stripe confirms.
// The server decides everything: what a background costs, who may use it, and when a payment counts. Niko Pro is the
// same add-on as for designs (designs.ts adds and removes it); backgrounds only read whether it's on.
import { and, eq, isNull, sql } from 'drizzle-orm';
import { appSettings, backgroundCheckouts, backgroundOwned, users, type Db, type User } from '@niko/db';
import {
  backgroundInfo, backgroundsView, cleanBackgroundSettings, DEFAULT_BACKGROUND, effectiveBackground, money,
  type BackgroundAccount, type BackgroundSettings, type OwnedBackground,
} from '@niko/shared';
import { setCustomer } from './billing';
import { activePlan, designSettings } from './designs';
import { idOf, type StripeMode } from './stripe';

export const BACKGROUNDS_KEY = 'backgrounds';
let cache: { at: number; v: BackgroundSettings } | null = null;
/** The admin's background offer, read at most every 30 seconds per Worker instance. */
export async function backgroundSettings(db: Db, fresh = false): Promise<BackgroundSettings> {
  if (!fresh && cache && Date.now() - cache.at < 30_000) return cache.v;
  const row = (await db.select().from(appSettings).where(eq(appSettings.key, BACKGROUNDS_KEY)).limit(1).catch(() => []))[0];
  cache = { at: Date.now(), v: cleanBackgroundSettings(row?.value) };
  return cache.v;
}
export const forgetBackgrounds = () => { cache = null; };

export async function backgroundsOwnedBy(db: Db, userId: string): Promise<Record<string, OwnedBackground>> {
  const rows = await db.select({ background: backgroundOwned.background, cents: backgroundOwned.cents, source: backgroundOwned.source }).from(backgroundOwned).where(eq(backgroundOwned.userId, userId));
  return Object.fromEntries(rows.map((r) => [r.background, { cents: r.cents, source: r.source }]));
}
export async function backgroundAccount(db: Db, u: User): Promise<BackgroundAccount> {
  return { owned: await backgroundsOwnedBy(db, u.id), bundle: !!u.bgBundleAt, pro: u.proOn && !!activePlan(u), admin: u.role === 'admin', activePlan: activePlan(u) };
}
/** The background this account's Home draws now. */
export async function backgroundFor(db: Db, u: User): Promise<string> {
  const chosen = (u.appearance as Record<string, unknown>)?.background;
  if (!chosen || chosen === DEFAULT_BACKGROUND) return DEFAULT_BACKGROUND;
  return effectiveBackground(await backgroundSettings(db), await backgroundAccount(db, u), chosen);
}
export async function backgroundsViewFor(db: Db, u: User) {
  return backgroundsView(await backgroundSettings(db), await backgroundAccount(db, u), (await designSettings(db)).pro);
}

/** A background Checkout Stripe says is paid. It counts only if it is one Niko made, for this account, for the amount
 * Niko fixed; each is applied once. Backgrounds already owned keep how they were first owned. */
export async function applyBackgroundSession(db: Db, s: any, mode: StripeMode): Promise<boolean> {
  if (s?.mode !== 'payment' || s?.payment_status !== 'paid' || s?.metadata?.kind !== 'background' || typeof s.id !== 'string') return false;
  const co = (await db.select().from(backgroundCheckouts).where(eq(backgroundCheckouts.id, s.id)).limit(1))[0];
  if (!co || co.userId !== s.metadata?.user_id || co.mode !== mode) return false;
  if (co.paidAt) return true;
  if (s.amount_total !== co.cents || String(s.currency).toLowerCase() !== 'sgd') { console.error('stripe: background payment amount does not match', co.id); return false; }
  const customer = idOf(s.customer);
  if (customer) await db.update(users).set(setCustomer(mode, customer)).where(and(eq(users.id, co.userId), mode === 'live' ? isNull(users.stripeCustomerLive) : isNull(users.stripeCustomerTest)));
  const claimed = await db.update(backgroundCheckouts).set({ paidAt: new Date() }).where(and(eq(backgroundCheckouts.id, co.id), isNull(backgroundCheckouts.paidAt))).returning({ id: backgroundCheckouts.id });
  if (!claimed.length) return true;
  const source = co.kind === 'one' ? 'single' : co.kind === 'all' ? 'bundle' : 'topup';
  for (const b of co.backgrounds) {
    await db.insert(backgroundOwned).values({ userId: co.userId, background: b, source, cents: co.kind === 'one' ? co.cents : null, checkoutId: co.id, mode }).onConflictDoNothing();
  }
  if (co.kind === 'all') await db.update(users).set({ bgBundleAt: new Date() }).where(and(eq(users.id, co.userId), isNull(users.bgBundleAt)));
  await db.execute(sql`insert into audit_log (user_id, action, detail) values (${co.userId}, ${'payment.background'}, ${JSON.stringify({ kind: co.kind, backgrounds: co.backgrounds.map((b) => backgroundInfo(b).name), amount: money(co.cents), mode })}::jsonb)`).catch(() => undefined);
  return true;
}
