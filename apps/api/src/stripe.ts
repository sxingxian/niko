// Stripe, called over its REST API with fetch (no SDK, so nothing extra runs in the Worker).
// Card and PayNow details are entered on Stripe's own Checkout page and never reach Niko. Niko trusts a payment only
// when Stripe says so: a signed webhook, or Niko asking Stripe's API itself. The page someone returns to proves nothing.
import { hmacSha256Hex, safeEqual } from './lib/crypto';

export interface StripeEnv { STRIPE_SECRET_KEY?: string; STRIPE_WEBHOOK_SECRET?: string }

export const stripeReady = (env: StripeEnv) => !!env.STRIPE_SECRET_KEY && !!env.STRIPE_WEBHOOK_SECRET;
export const NOT_READY = 'Payments aren’t set up on this server yet. Ask your admin.';

export class StripeError extends Error {
  constructor(message: string, public status: number, public code?: string) { super(message); }
}

/** Stripe's form encoding: nested objects and arrays become a[b][0][c]=v. Undefined and null are left out. */
export function formEncode(params: Record<string, unknown>): string {
  const out: string[] = [];
  const walk = (key: string, v: unknown) => {
    if (v === undefined || v === null) return;
    if (Array.isArray(v)) { v.forEach((x, i) => walk(`${key}[${i}]`, x)); return; }
    if (typeof v === 'object') { for (const [k, x] of Object.entries(v as Record<string, unknown>)) walk(`${key}[${k}]`, x); return; }
    out.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
  };
  for (const [k, v] of Object.entries(params)) walk(k, v);
  return out.join('&');
}

/** One call to Stripe. Errors carry Stripe's own short message, which never contains the key. */
export async function stripe<T = any>(env: StripeEnv, method: 'GET' | 'POST' | 'DELETE', path: string, params: Record<string, unknown> = {}, idempotencyKey?: string): Promise<T> {
  if (!env.STRIPE_SECRET_KEY) throw new StripeError(NOT_READY, 503);
  const body = formEncode(params);
  const url = 'https://api.stripe.com/v1' + path + (method === 'GET' && body ? `?${body}` : '');
  const res = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      ...(method === 'POST' ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
      ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
    },
    body: method === 'POST' ? body : undefined,
    redirect: 'error',
  });
  const data = await res.json().catch(() => ({})) as any;
  if (!res.ok) {
    console.error('stripe error', method, path.replace(/\/(cs|sub|pi|cus)_[A-Za-z0-9]+/g, '/$1_…'), res.status, data?.error?.code ?? '', data?.error?.message ?? '');
    throw new StripeError(data?.error?.message ?? 'Stripe did not accept that.', res.status, data?.error?.code);
  }
  return data as T;
}

/** Checks the Stripe-Signature header: t=<seconds>,v1=<hex>[,v1=<hex>]. Refuses anything older than 5 minutes. */
export async function verifyStripeSignature(secret: string, header: string | undefined, raw: string, nowSeconds = Math.floor(Date.now() / 1000), toleranceSeconds = 300): Promise<boolean> {
  if (!secret || !header) return false;
  let t = '';
  const sigs: string[] = [];
  for (const part of header.split(',')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim(), v = part.slice(i + 1).trim();
    if (k === 't') t = v; else if (k === 'v1') sigs.push(v);
  }
  if (!/^\d+$/.test(t) || !sigs.length || Math.abs(nowSeconds - Number(t)) > toleranceSeconds) return false;
  const expected = await hmacSha256Hex(secret, `${t}.${raw}`);
  return sigs.some((s) => safeEqual(s, expected));
}

/** The end of a subscription's current period. Newer Stripe versions keep it on the subscription's item. */
export function periodEnd(sub: any): Date | null {
  const s = Number(sub?.current_period_end ?? sub?.items?.data?.[0]?.current_period_end);
  return Number.isFinite(s) && s > 0 ? new Date(s * 1000) : null;
}
/** The plan a subscription is on, from the metadata Niko set, or from its price's interval. */
export function planOf(sub: any): 'monthly' | 'yearly' | null {
  const m = sub?.metadata?.plan;
  if (m === 'monthly' || m === 'yearly') return m;
  const i = sub?.items?.data?.[0]?.price?.recurring?.interval;
  return i === 'month' ? 'monthly' : i === 'year' ? 'yearly' : null;
}
/** Which subscription an invoice is for (the field moved in newer Stripe versions). */
export function invoiceSubscription(inv: any): string | null {
  const s = inv?.subscription ?? inv?.parent?.subscription_details?.subscription ?? inv?.lines?.data?.[0]?.subscription;
  return typeof s === 'string' ? s : typeof s?.id === 'string' ? s.id : null;
}
const idOf = (v: any): string | null => (typeof v === 'string' ? v : typeof v?.id === 'string' ? v.id : null);
export { idOf };
