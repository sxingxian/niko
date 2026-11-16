// Payments: pay once for a set time, then a monthly or yearly plan. Prices are in Singapore dollars, kept as cents.
// These rules are shared by the server (which enforces them) and the screens (which explain them).

export const CURRENCY = 'sgd';
/** Stripe's smallest charge in Singapore dollars. */
export const MIN_CENTS = 50;
export const MAX_CENTS = 10_000_00;
export const MAX_MONTHS = 120;
/** Unpaid open sign-ups are removed after this many days. */
export const UNPAID_SIGNUP_DAYS = 7;
export const INVITE_DAYS = 7;
export const CODE_TRIES = 5;
export const GRACE_STEPS = [3, 7, 14] as const;
export type Plan = 'monthly' | 'yearly';

export interface PaymentSettings {
  /** The pay-once price, and how many months it lasts. */
  onceCents: number | null;
  months: number;
  /** Show the length in years on screens (the months are stored either way). */
  unit: 'months' | 'years';
  /** The plans offered when paid time ends. At least one stays on. */
  monthly: { on: boolean; cents: number | null };
  yearly: { on: boolean; cents: number | null };
  /** Open sign-ups pay the pay-once price after confirming their email. */
  openPay: boolean;
  /** Days of access kept after a renewal payment fails, while Stripe retries. */
  graceDays: number;
  /** Email a reminder 7 days before someone's paid time ends. */
  remind: boolean;
}

export const DEFAULT_PAYMENTS: PaymentSettings = {
  onceCents: null, months: 12, unit: 'months',
  monthly: { on: true, cents: null }, yearly: { on: true, cents: null },
  openPay: true, graceDays: 7, remind: true,
};

const cents = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  return Number.isInteger(n) && n >= MIN_CENTS && n <= MAX_CENTS ? n : null;
};
export const cleanMonths = (v: unknown, d = 12): number => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= 1 && n <= MAX_MONTHS ? n : d;
};

/** Only known settings with sensible values are kept; anything else falls back to the default. */
export function cleanPayments(v: unknown): PaymentSettings {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, any>;
  const plan = (p: any, d: { on: boolean; cents: number | null }) => ({ on: typeof p?.on === 'boolean' ? p.on : d.on, cents: p && 'cents' in p ? cents(p.cents) : d.cents });
  const out: PaymentSettings = {
    onceCents: 'onceCents' in o ? cents(o.onceCents) : DEFAULT_PAYMENTS.onceCents,
    months: cleanMonths(o.months, DEFAULT_PAYMENTS.months),
    unit: o.unit === 'years' ? 'years' : 'months',
    monthly: plan(o.monthly, DEFAULT_PAYMENTS.monthly),
    yearly: plan(o.yearly, DEFAULT_PAYMENTS.yearly),
    openPay: typeof o.openPay === 'boolean' ? o.openPay : DEFAULT_PAYMENTS.openPay,
    graceDays: (GRACE_STEPS as readonly number[]).includes(Number(o.graceDays)) ? Number(o.graceDays) : DEFAULT_PAYMENTS.graceDays,
    remind: typeof o.remind === 'boolean' ? o.remind : DEFAULT_PAYMENTS.remind,
  };
  if (!out.monthly.on && !out.yearly.on) out.monthly.on = true;
  if (out.unit === 'years' && out.months % 12) out.unit = 'months';
  return out;
}

/** The plans someone can choose when their paid time ends: on, and with a price. */
export function plansOffered(s: PaymentSettings): { plan: Plan; cents: number }[] {
  const out: { plan: Plan; cents: number }[] = [];
  if (s.monthly.on && s.monthly.cents) out.push({ plan: 'monthly', cents: s.monthly.cents });
  if (s.yearly.on && s.yearly.cents) out.push({ plan: 'yearly', cents: s.yearly.cents });
  return out;
}

export const money = (c: number | null | undefined) => (typeof c === 'number' ? `SGD ${(c / 100).toFixed(2)}` : 'SGD —');
/** "12 months", "2 years", "1 month". */
export function lengthLabel(months: number): string {
  if (months >= 12 && months % 12 === 0) { const y = months / 12; return `${y} year${y === 1 ? '' : 's'}`; }
  return `${months} month${months === 1 ? '' : 's'}`;
}
/** Parses "12.50" or "SGD 12" typed by an admin into cents. */
export function toCents(v: string): number | null {
  const t = String(v).replace(/[^0-9.]/g, '');
  if (!t || !/^\d+(\.\d{0,2})?$/.test(t)) return null;
  return cents(Math.round(Number(t) * 100));
}

/** Calendar months later, clamped to the end of a shorter month (31 Jan + 1 month = 28/29 Feb). */
export function addMonths(from: Date, months: number): Date {
  const d = new Date(from.getTime());
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d;
}

/** The fields of an account that decide whether it may use Niko. */
export interface AccessFields {
  role: string;
  status?: string;
  lifetime: boolean;
  accessUntil: Date | string | null;
  accessKind: string | null;
  accessStartMonths?: number;
  subStatus: string | null;
  subPeriodEnd: Date | string | null;
}
export type AccessKind = 'admin' | 'life' | 'paid' | 'free' | 'unlocked' | 'sub' | 'grace' | 'none';
export interface AccessState { has: boolean; kind: AccessKind; until: string | null }

const at = (v: Date | string | null | undefined): Date | null => (v ? new Date(v) : null);
const LIVE_SUB = ['active', 'trialing'];
const RETRYING_SUB = ['past_due', 'unpaid', 'incomplete'];

/** Whether an account may use Niko now, why, and until when. */
export function accessState(u: AccessFields, graceDays: number, now = new Date()): AccessState {
  if (u.role === 'admin') return { has: true, kind: 'admin', until: null };
  if (u.lifetime) return { has: true, kind: 'life', until: null };
  const end = at(u.subPeriodEnd);
  if (u.subStatus && end) {
    if (LIVE_SUB.includes(u.subStatus) && end > now) return { has: true, kind: 'sub', until: end.toISOString() };
    if (RETRYING_SUB.includes(u.subStatus)) {
      const grace = new Date(end.getTime() + graceDays * 86400_000);
      if (grace > now) return { has: true, kind: 'grace', until: grace.toISOString() };
    }
  }
  const until = at(u.accessUntil);
  if (until && until > now) {
    const kind = u.accessKind === 'free' || u.accessKind === 'unlocked' ? u.accessKind : 'paid';
    return { has: true, kind, until: until.toISOString() };
  }
  return { has: false, kind: 'none', until: until ? until.toISOString() : null };
}

/** When the time someone already has ends: paid or unlocked time, a live plan's current period, or months that start
 * when an admin switches them on. Null if they have none left. */
export function paidEnd(u: AccessFields, now = new Date()): Date | null {
  let end: Date | null = null;
  const until = at(u.accessUntil);
  if (until && until > now) end = until;
  const sub = at(u.subPeriodEnd);
  if (u.subStatus && LIVE_SUB.includes(u.subStatus) && sub && sub > now && (!end || sub > end)) end = sub;
  if (!end && (u.accessStartMonths ?? 0) > 0) end = addMonths(now, u.accessStartMonths!);
  return end;
}

export interface UnlockResult {
  lifetime: boolean;
  accessUntil: Date | null;
  /** The end of the time already paid for, when the unlock follows it. */
  paidUntil: Date | null;
  /** A live plan stops renewing (set time) or is cancelled now (lifetime). */
  sub: 'keep' | 'end-at-period' | 'cancel-now';
}

/** An admin unlock. Lifetime starts now. A set time starts after any time already paid for, so nothing is lost. */
export function unlockPlan(u: AccessFields, req: { kind: 'life' } | { kind: 'set'; months: number }, now = new Date()): UnlockResult {
  const liveSub = !!u.subStatus && (LIVE_SUB.includes(u.subStatus) || RETRYING_SUB.includes(u.subStatus));
  if (req.kind === 'life') return { lifetime: true, accessUntil: null, paidUntil: null, sub: liveSub ? 'cancel-now' : 'keep' };
  const start = paidEnd(u, now);
  return { lifetime: false, accessUntil: addMonths(start ?? now, cleanMonths(req.months, 1)), paidUntil: start, sub: liveSub ? 'end-at-period' : 'keep' };
}

// ---- invite codes: 6 characters, no look-alikes (no 0, O, 1, I or L)
export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
/** Upper case, with spaces and dashes taken out. */
export const normalizeCode = (v: unknown) => String(v ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
export const isCodeShape = (v: string) => v.length === 6 && [...v].every((ch) => CODE_ALPHABET.includes(ch));
/** "7KX M4P" */
export const showCode = (c: string) => `${c.slice(0, 3)} ${c.slice(3)}`;

/** What an account sees about its own access. */
export interface AccessInfo extends AccessState {
  lifetime: boolean;
  sub: { plan: Plan | null; status: string; periodEnd: string | null; cancelAtEnd: boolean } | null;
  /** Plans offered when paid time ends (with prices), and whether payments are set up. */
  plans: { plan: Plan; cents: number }[];
  payments: boolean;
  /** Payments are in Stripe's test mode: no real money is charged. */
  testMode: boolean;
  /** Can open Stripe's billing page (has a Stripe customer). */
  portal: boolean;
  /** When the time they had ended (shown when they need a plan). */
  endedAt: string | null;
  since: string;
}
