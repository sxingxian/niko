// Niko designs: how the core looks. Nebula is everyone's; the admin chooses which others are offered and what they
// cost (Admin → Designs). These rules are shared by the server (which enforces them) and the screens (which show them).
//
// - A paid design is a one-time unlock, kept on every device, and kept even after the design stops being offered.
// - "All designs" covers the paid designs offered on the day it is bought. Designs offered later, or switched off then
//   on again, are new for bundle owners who don't have them: they add them for a pro-rated amount.
// - Niko Pro is an add-on to a monthly or yearly plan (never during pay-once time): every design offered, while it's on.
import { MIN_CENTS, MAX_CENTS, type Plan } from './billing';

export interface DesignInfo { id: string; name: string; mood: string; trait: string }

/** Every design Niko can draw, in the order they're shown. Nebula is the original core and always included. */
export const DESIGNS: readonly DesignInfo[] = [
  { id: 'nebula', name: 'Nebula', mood: 'Current', trait: 'Today’s Niko. Breathes when standing by, ripples in as it listens, wrings and sparks as it thinks.' },
  { id: 'prism', name: 'Prism', mood: 'Precise', trait: 'A crystal lattice. The inner crystal spins up as it reasons.' },
  { id: 'ribbon', name: 'Ribbon', mood: 'Voice-first', trait: 'Strands of light. Every word moves through them.' },
  { id: 'flux', name: 'Flux', mood: 'Fluid', trait: 'A living drop. It reshapes as it listens and speaks.' },
  { id: 'constellation', name: 'Constellation', mood: 'Connected', trait: 'Drifting stars. More links form the harder it thinks.' },
  { id: 'vortex', name: 'Vortex', mood: 'Cosmic', trait: 'A spiral galaxy. The arms whirl as it thinks and pulse as it speaks.' },
  { id: 'hologram', name: 'Hologram', mood: 'Technical', trait: 'A dotted globe. A scan line sweeps it, faster when thinking.' },
  { id: 'helix', name: 'Helix', mood: 'Scientific', trait: 'A turning double strand. Signals climb the rungs as it reasons.' },
  { id: 'bloom', name: 'Bloom', mood: 'Gentle', trait: 'Layered petals. They close to listen and open to speak.' },
  { id: 'swarm', name: 'Swarm', mood: 'Alive', trait: 'Fireflies. They gather when it listens and split up to think.' },
  { id: 'aurora', name: 'Aurora', mood: 'Serene', trait: 'Curtains of light. They sway, and brighten with every word.' },
  { id: 'pulsar', name: 'Pulsar', mood: 'Powerful', trait: 'A beating core with two sweeping jets. The beat quickens as it thinks.' },
  { id: 'tesseract', name: 'Tesseract', mood: 'Mind-bending', trait: 'A four-dimensional cube turning through itself.' },
  { id: 'knot', name: 'Knot', mood: 'Flowing', trait: 'Light running round an endless knot. The tube swells as it speaks.' },
  { id: 'ember', name: 'Ember', mood: 'Warm', trait: 'A glowing core that throws up sparks. More sparks when it speaks.' },
  { id: 'tide', name: 'Tide', mood: 'Calm', trait: 'A field of light. Waves roll out as it speaks and in as it listens.' },
  { id: 'echo', name: 'Echo', mood: 'Resonant', trait: 'Shells of light. They travel out as it speaks and in as it listens.' },
  { id: 'shard', name: 'Shard', mood: 'Sharp', trait: 'Glass fragments orbiting a light. They scatter as it speaks.' },
  { id: 'comet', name: 'Comet', mood: 'Swift', trait: 'Comets with long tails circling a small star.' },
  { id: 'iris', name: 'Iris', mood: 'Watchful', trait: 'A living aperture. It opens to listen and narrows to speak.' },
];
export const DEFAULT_DESIGN = 'nebula';
export const DESIGN_IDS = DESIGNS.map((d) => d.id);
export const isDesign = (v: unknown): v is string => typeof v === 'string' && DESIGN_IDS.includes(v);
export const designInfo = (id: string) => DESIGNS.find((d) => d.id === id) ?? DESIGNS[0]!;

// ---------------------------------------------------------------- the admin's settings
export interface DesignEntry {
  /** Offered to people now. */
  on: boolean;
  /** A one-time unlock (true) or included for everyone while offered (false). */
  paid: boolean;
  cents: number | null;
  /** Kept by the server: has been offered at some point, and has been switched off after being offered. */
  everOn: boolean;
  wasOff: boolean;
}
export type DesignRate = 'saving' | 'percent';
export interface DesignSettings {
  designs: Record<string, DesignEntry>;
  /** The "All designs" price. */
  bundleCents: number | null;
  /** Someone who already bought designs pays the bundle price minus what they paid for them. */
  credit: boolean;
  /** How bundle owners' price for a new design is worked out: the bundle's own saving, or a set percentage off. */
  rate: DesignRate;
  percent: number;
  /** Niko Pro: an add-on to a monthly or yearly plan, priced for each. */
  pro: { on: boolean; monthly: number | null; yearly: number | null };
}

const NEW_ENTRY: DesignEntry = { on: false, paid: true, cents: null, everOn: false, wasOff: false };
export const DEFAULT_DESIGN_SETTINGS: DesignSettings = {
  designs: Object.fromEntries(DESIGN_IDS.filter((id) => id !== DEFAULT_DESIGN).map((id) => [id, { ...NEW_ENTRY }])),
  bundleCents: null, credit: true, rate: 'saving', percent: 30,
  pro: { on: false, monthly: null, yearly: null },
};

const cents = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  return Number.isInteger(n) && n >= MIN_CENTS && n <= MAX_CENTS ? n : null;
};
const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);

/** Only known designs and sensible values are kept. Designs Niko learns later start as new: not offered, paid, no price. */
export function cleanDesignSettings(v: unknown): DesignSettings {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, any>;
  const src = (o.designs && typeof o.designs === 'object' ? o.designs : {}) as Record<string, any>;
  const designs: Record<string, DesignEntry> = {};
  for (const id of DESIGN_IDS) {
    if (id === DEFAULT_DESIGN) continue;
    const e = src[id] ?? {};
    designs[id] = { on: bool(e.on, false), paid: bool(e.paid, true), cents: cents(e.cents), everOn: bool(e.everOn, false) || bool(e.on, false), wasOff: bool(e.wasOff, false) };
  }
  const pct = Math.round(Number(o.percent));
  return {
    designs,
    bundleCents: cents(o.bundleCents),
    credit: bool(o.credit, true),
    rate: o.rate === 'percent' ? 'percent' : 'saving',
    percent: Number.isFinite(pct) && pct >= 0 && pct <= 90 ? pct : 30,
    pro: { on: bool(o.pro?.on, false), monthly: cents(o.pro?.monthly), yearly: cents(o.pro?.yearly) },
  };
}

/** The admin's new settings, with the server's own record of what has been offered and switched off carried forward.
 * The admin can't set those two flags: they follow from switching designs off and on. */
export function nextDesignSettings(prev: DesignSettings, incoming: unknown): DesignSettings {
  const next = cleanDesignSettings(incoming);
  for (const id of Object.keys(next.designs)) {
    const was = prev.designs[id] ?? NEW_ENTRY, now = next.designs[id]!;
    now.everOn = was.everOn || was.on || now.on;
    now.wasOff = was.wasOff || (was.on && !now.on);
  }
  return next;
}

/** Why the admin's settings can't be saved, or null. */
export function designSettingsProblem(s: DesignSettings): string | null {
  const unpriced = Object.entries(s.designs).filter(([, e]) => e.on && e.paid && !e.cents).map(([id]) => designInfo(id).name);
  if (unpriced.length) return `Give ${unpriced.join(', ')} a price, or make ${unpriced.length === 1 ? 'it' : 'them'} included.`;
  const sum = offeredPaid(s).reduce((n, d) => n + d.cents, 0);
  if (s.bundleCents && sum && s.bundleCents >= sum) return 'The bundle should cost less than the paid designs bought one by one.';
  if (s.pro.on && !s.pro.monthly && !s.pro.yearly) return 'Give Niko Pro a price for monthly plans, yearly plans or both, or switch it off.';
  return null;
}

/** Paid designs offered now, with their prices. */
export function offeredPaid(s: DesignSettings): { id: string; cents: number }[] {
  return DESIGN_IDS.flatMap((id) => { const e = s.designs[id]; return e && e.on && e.paid && e.cents ? [{ id, cents: e.cents }] : []; });
}
export const isOffered = (s: DesignSettings, id: string) => id === DEFAULT_DESIGN || !!s.designs[id]?.on;
export const isIncluded = (s: DesignSettings, id: string) => id === DEFAULT_DESIGN || (!!s.designs[id]?.on && !s.designs[id]!.paid);

/** The bundle's saving as a fraction (0.3 = 30% off), when it has a price that saves anything. */
export function bundleSaving(s: DesignSettings): number | null {
  const sum = offeredPaid(s).reduce((n, d) => n + d.cents, 0);
  return s.bundleCents && sum > s.bundleCents ? 1 - s.bundleCents / sum : null;
}
/** How much bundle owners save on a new design: the bundle's saving, or the admin's percentage. */
export function bundleOwnerOff(s: DesignSettings): number {
  return s.rate === 'percent' ? s.percent / 100 : bundleSaving(s) ?? 0;
}
/** A bundle owner's price for a design: the full price less their saving, never below Stripe's smallest charge. */
export const proRated = (full: number, off: number) => Math.max(MIN_CENTS, Math.round(full * (1 - off)));

// ---------------------------------------------------------------- one account
export interface OwnedDesign { cents: number | null; source: string }
export interface DesignAccount {
  /** Designs this account owns (bought once, in a bundle, added later, or given by the admin). */
  owned: Record<string, OwnedDesign>;
  /** Has bought "All designs". */
  bundle: boolean;
  /** The Niko Pro add-on is on. */
  pro: boolean;
  admin: boolean;
  /** A monthly or yearly plan that is active now (not in pay-once time), or null. */
  activePlan: Plan | null;
}

/** Whether this account may use a design now. */
export function canUseDesign(s: DesignSettings, a: DesignAccount, id: string): boolean {
  if (!isDesign(id)) return false;
  if (id === DEFAULT_DESIGN || a.admin || a.owned[id]) return true;
  if (!isOffered(s, id)) return false;
  return isIncluded(s, id) || a.pro;
}
/** The design to draw: the chosen one, or Nebula if this account can no longer use it. */
export const effectiveDesign = (s: DesignSettings, a: DesignAccount, chosen: unknown) => (isDesign(chosen) && canUseDesign(s, a, chosen) ? chosen : DEFAULT_DESIGN);

export type DesignState = 'included' | 'owned' | 'pro' | 'locked';
export interface DesignOffer extends DesignInfo {
  state: DesignState;
  /** No longer offered (shown only to people who own it). */
  retired: boolean;
  /** New for a bundle owner: offered since they bought, or back after being switched off. */
  fresh: boolean;
  back: boolean;
  /** This account's price (pro-rated for bundle owners) and the full price. */
  cents: number | null;
  full: number | null;
}
export interface DesignsView {
  designs: DesignOffer[];
  /** "All designs" for someone who hasn't bought it: how many it covers now, and their price. */
  bundle: { count: number; cents: number } | null;
  /** All new designs at once, for a bundle owner. */
  topupAll: { count: number; cents: number } | null;
  /** The Niko Pro add-on: offered only on an active monthly or yearly plan. */
  pro: { offered: boolean; active: boolean; cents: number | null; plan: Plan | null };
  bundleOwner: boolean;
}

/** What this account sees: the designs it can see (offered, or owned and retired) with prices, and the offers. */
export function designsView(s: DesignSettings, a: DesignAccount): DesignsView {
  const off = bundleOwnerOff(s);
  const designs: DesignOffer[] = [];
  for (const d of DESIGNS) {
    const e = s.designs[d.id];
    const offered = isOffered(s, d.id), owned = !!a.owned[d.id];
    // Admins see every design, so they can try ones that aren't offered yet.
    if (!offered && !owned && !a.admin) continue;
    const included = isIncluded(s, d.id);
    const state: DesignState = included ? 'included' : owned || a.admin ? 'owned' : a.pro && offered ? 'pro' : 'locked';
    const full = offered && e?.paid ? e.cents : null;
    const fresh = a.bundle && state === 'locked';
    designs.push({ ...d, state, retired: !offered, fresh, back: fresh && !!e?.wasOff, full, cents: state === 'locked' && full ? (a.bundle ? proRated(full, off) : full) : null });
  }
  const locked = designs.filter((d) => d.state === 'locked' && d.cents);
  let bundle: DesignsView['bundle'] = null, topupAll: DesignsView['topupAll'] = null;
  if (!a.bundle && s.bundleCents && locked.length >= 2) {
    const paid = s.credit ? Object.values(a.owned).reduce((n, o) => n + (o.cents ?? 0), 0) : 0;
    const price = Math.max(MIN_CENTS, s.bundleCents - paid);
    // Only offered when it still saves money over buying the remaining designs one by one.
    if (price < locked.reduce((n, d) => n + d.cents!, 0)) bundle = { count: locked.length, cents: price };
  }
  if (a.bundle && locked.length >= 2) topupAll = { count: locked.length, cents: locked.reduce((n, d) => n + d.cents!, 0) };
  const proCents = a.activePlan === 'monthly' ? s.pro.monthly : a.activePlan === 'yearly' ? s.pro.yearly : null;
  return {
    designs, bundle, topupAll, bundleOwner: a.bundle,
    pro: { offered: s.pro.on && !!a.activePlan && !!proCents && !a.admin, active: a.pro, cents: proCents, plan: a.activePlan },
  };
}

export type DesignBuy = 'one' | 'all' | 'topup' | 'topupall';
/** What a purchase covers and costs, worked out from the settings (never from what a screen sent). */
export function designQuote(s: DesignSettings, a: DesignAccount, what: DesignBuy, id?: string): { designs: string[]; cents: number; bundle: boolean } | { error: string } {
  if (a.admin) return { error: 'Admins already have every design.' };
  const v = designsView(s, a);
  if (what === 'one' || what === 'topup') {
    const d = v.designs.find((x) => x.id === id);
    if (!d || d.state !== 'locked' || !d.cents) return { error: 'That design isn’t available to unlock.' };
    if ((what === 'topup') !== a.bundle) return { error: 'That price isn’t offered on your account.' };
    return { designs: [d.id], cents: d.cents, bundle: false };
  }
  const offer = what === 'all' ? (a.bundle ? null : v.bundle) : (a.bundle ? v.topupAll : null);
  if (!offer) return { error: 'That isn’t offered on your account right now.' };
  return { designs: v.designs.filter((d) => d.state === 'locked' && d.cents).map((d) => d.id), cents: offer.cents, bundle: what === 'all' };
}
