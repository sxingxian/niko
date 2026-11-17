// Designs on the server: the admin's offer, what each account owns, and applying what Stripe confirms.
// The server decides everything: what a design costs, who may use it, and when a payment counts.
import { and, eq, isNull, sql } from 'drizzle-orm';
import { appSettings, designCheckouts, designOwned, users, type Db, type User } from '@niko/db';
import {
  cleanDesignSettings, DEFAULT_DESIGN, designInfo, designsView, effectiveDesign, money,
  type DesignAccount, type DesignSettings, type OwnedDesign, type Plan,
} from '@niko/shared';
import type { Env } from './env';
import { connectInfo, priceLine, setCustomer } from './billing';
import { idOf, stripe, type StripeEnv, type StripeMode } from './stripe';

export const DESIGNS_KEY = 'designs';
let cache: { at: number; v: DesignSettings } | null = null;
/** The admin's design offer, read at most every 30 seconds per Worker instance. */
export async function designSettings(db: Db, fresh = false): Promise<DesignSettings> {
  if (!fresh && cache && Date.now() - cache.at < 30_000) return cache.v;
  const row = (await db.select().from(appSettings).where(eq(appSettings.key, DESIGNS_KEY)).limit(1).catch(() => []))[0];
  cache = { at: Date.now(), v: cleanDesignSettings(row?.value) };
  return cache.v;
}
export const forgetDesigns = () => { cache = null; };

const LIVE = ['active'];
/** A monthly or yearly plan that is active now. A plan chosen during pay-once time is 'trialing' until that time
 * ends, so Niko Pro isn't offered then. */
export const activePlan = (u: User): Plan | null => (u.subId && u.subStatus && LIVE.includes(u.subStatus) && (u.subPlan === 'monthly' || u.subPlan === 'yearly') ? u.subPlan : null);

export async function ownedBy(db: Db, userId: string): Promise<Record<string, OwnedDesign>> {
  const rows = await db.select({ design: designOwned.design, cents: designOwned.cents, source: designOwned.source }).from(designOwned).where(eq(designOwned.userId, userId));
  return Object.fromEntries(rows.map((r) => [r.design, { cents: r.cents, source: r.source }]));
}
export async function designAccount(db: Db, u: User): Promise<DesignAccount> {
  return { owned: await ownedBy(db, u.id), bundle: !!u.designBundleAt, pro: u.proOn && !!activePlan(u), admin: u.role === 'admin', activePlan: activePlan(u) };
}
/** The design this account's core draws now. */
export async function designFor(db: Db, u: User): Promise<string> {
  const chosen = (u.appearance as Record<string, unknown>)?.design;
  if (!chosen || chosen === DEFAULT_DESIGN) return DEFAULT_DESIGN;
  return effectiveDesign(await designSettings(db), await designAccount(db, u), chosen);
}
export async function viewFor(db: Db, u: User) {
  return designsView(await designSettings(db), await designAccount(db, u));
}

// ---------------------------------------------------------------- applying what Stripe confirms
/** A design Checkout Stripe says is paid. It counts only if it is one Niko made, for this account, for the amount Niko
 * fixed; each is applied once. Designs already owned keep how they were first owned. */
export async function applyDesignSession(db: Db, s: any, mode: StripeMode): Promise<boolean> {
  if (s?.mode !== 'payment' || s?.payment_status !== 'paid' || s?.metadata?.kind !== 'design' || typeof s.id !== 'string') return false;
  const co = (await db.select().from(designCheckouts).where(eq(designCheckouts.id, s.id)).limit(1))[0];
  if (!co || co.userId !== s.metadata?.user_id || co.mode !== mode) return false;
  if (co.paidAt) return true;
  if (s.amount_total !== co.cents || String(s.currency).toLowerCase() !== 'sgd') { console.error('stripe: design payment amount does not match', co.id); return false; }
  const customer = idOf(s.customer);
  if (customer) await db.update(users).set(setCustomer(mode, customer)).where(and(eq(users.id, co.userId), mode === 'live' ? isNull(users.stripeCustomerLive) : isNull(users.stripeCustomerTest)));
  const claimed = await db.update(designCheckouts).set({ paidAt: new Date() }).where(and(eq(designCheckouts.id, co.id), isNull(designCheckouts.paidAt))).returning({ id: designCheckouts.id });
  if (!claimed.length) return true;
  const source = co.kind === 'one' ? 'single' : co.kind === 'all' ? 'bundle' : 'topup';
  for (const d of co.designs) {
    await db.insert(designOwned).values({ userId: co.userId, design: d, source, cents: co.kind === 'one' ? co.cents : null, checkoutId: co.id, mode }).onConflictDoNothing();
  }
  if (co.kind === 'all') await db.update(users).set({ designBundleAt: new Date() }).where(and(eq(users.id, co.userId), isNull(users.designBundleAt)));
  await db.execute(sql`insert into audit_log (user_id, action, detail) values (${co.userId}, ${'payment.design'}, ${JSON.stringify({ kind: co.kind, designs: co.designs.map((d) => designInfo(d).name), amount: money(co.cents), mode })}::jsonb)`).catch(() => undefined);
  return true;
}

/** Niko Pro's item on a subscription: the one Niko marked when it added the add-on. */
export const proItemOf = (sub: any): any | null => (sub?.items?.data ?? []).find((i: any) => i?.metadata?.niko === 'pro') ?? null;
/** The plan's own item (not the add-on). */
export const planItemOf = (sub: any): any | null => (sub?.items?.data ?? []).find((i: any) => i?.metadata?.niko !== 'pro') ?? null;

/** Keeps the account's Niko Pro flag in step with its subscription. */
export async function applyPro(db: Db, userId: string, sub: any): Promise<void> {
  const item = proItemOf(sub);
  const live = !!item && ['active', 'trialing', 'past_due'].includes(String(sub?.status ?? ''));
  await db.update(users).set({ proOn: live, proItem: live ? String(item.id) : null }).where(eq(users.id, userId));
}

/** Adds Niko Pro to the account's plan. The rest of the current period is charged now, to the card on the plan; if
 * the card can't pay, nothing is added. */
export async function addPro(env: Env, db: Db, u: User, keys: StripeEnv, mode: StripeMode, cents: number, plan: Plan): Promise<void> {
  const line = await priceLine(env, db, mode, keys, cents, { proPlan: plan });
  const price_data = { ...line.price_data, product: line.price_data.product ?? await ensureProduct(env, db, mode, keys) };
  delete (price_data as any).product_data;
  const item = await stripe(keys, 'POST', '/subscription_items', {
    subscription: u.subId, quantity: 1, price_data, metadata: { niko: 'pro' },
    proration_behavior: 'always_invoice', payment_behavior: 'error_if_incomplete',
  }, `niko-pro-${u.id}-${u.subId}-${cents}-${Math.floor(Date.now() / 60_000)}`);
  await db.update(users).set({ proOn: true, proItem: String(item.id) }).where(eq(users.id, u.id));
}
/** Removes Niko Pro. Unused time is credited to the plan's next invoice. */
export async function removePro(db: Db, u: User, keys: StripeEnv): Promise<void> {
  if (u.proItem) {
    try { await stripe(keys, 'DELETE', `/subscription_items/${u.proItem}`, { proration_behavior: 'create_prorations' }); }
    catch (e: any) { if (e?.status !== 404) throw e; }
  }
  await db.update(users).set({ proOn: false, proItem: null }).where(eq(users.id, u.id));
}
/** Subscription items need a product (no product_data), so the add-on's product is always made. */
async function ensureProduct(env: Env, db: Db, mode: StripeMode, keys: StripeEnv): Promise<string> {
  const known = (await connectInfo(db, true))[mode]?.products?.['design-pro'];
  if (known) return known;
  const p = await stripe(keys, 'POST', '/products', { name: 'Niko Pro · every design', metadata: { niko: 'design-pro' } }, `niko-product-${mode}-design-pro`);
  return p.id as string;
}

export { idOf };
