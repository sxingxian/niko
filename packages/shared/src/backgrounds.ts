// Backgrounds behind Niko. Glow is everyone's (the app's own soft glow); the admin chooses which others are offered and
// what they cost (Admin → Backgrounds). The same rules as designs, shared by the server (which enforces them) and the
// screens (which show them):
//
// - A paid background is a one-time unlock, kept on every device, and kept even after it stops being offered.
// - "All backgrounds" covers the paid backgrounds offered on the day it is bought. Backgrounds offered later, or
//   switched off then on again, are new for bundle owners who don't have them: they add them for a pro-rated amount.
// - Niko Pro (one add-on, priced under Designs) covers every background offered too, unless the admin leaves
//   backgrounds out of it. Never offered during pay-once time.
import { MIN_CENTS, MAX_CENTS, type Plan } from './billing';
import { proRated, type DesignSettings } from './designs';

export interface BackgroundInfo { id: string; name: string; note: string }

/** Every background Niko can draw, in the order they're shown. Glow is today's background and always included. */
export const BACKGROUNDS: readonly BackgroundInfo[] = [
  { id: 'glow', name: 'Glow', note: 'Today’s background. Barely moves, easiest on the battery' },
  { id: 'aurora', name: 'Aurora', note: 'Curtains of light drift overhead' },
  { id: 'stars', name: 'Stars', note: 'A slow drift through deep space' },
  { id: 'horizon', name: 'Horizon', note: 'A holographic floor runs toward you' },
  { id: 'clouds', name: 'Clouds', note: 'Soft colour clouds slowly turn' },
  { id: 'dust', name: 'Dust', note: 'Motes of light float upward' },
  { id: 'hex', name: 'Lattice', note: 'A light wave runs across a hex grid' },
  { id: 'streams', name: 'Streams', note: 'Quiet threads of data fall past' },
  { id: 'contours', name: 'Contours', note: 'Gentle waves of light below' },
  { id: 'silk', name: 'Silk', note: 'Ribbons of light flow slowly across' },
  { id: 'bokeh', name: 'Bokeh', note: 'Soft lights drift out of focus' },
  { id: 'plasma', name: 'Plasma', note: 'Colours melt slowly into each other' },
  { id: 'cosmos', name: 'Cosmos', note: 'A galaxy’s band of stars across the sky' },
  { id: 'circuit', name: 'Circuit', note: 'Signals race along glowing traces' },
  { id: 'peaks', name: 'Peaks', note: 'Wireframe mountains roll toward you' },
  { id: 'beams', name: 'Beams', note: 'Light pours down from above' },
  { id: 'smoke', name: 'Smoke', note: 'Wisps of light rise and fade' },
  { id: 'caustics', name: 'Caustics', note: 'Light dances like sun under water' },
  { id: 'flow', name: 'Flow', note: 'Threads of light follow an unseen current' },
  { id: 'equalizer', name: 'Equalizer', note: 'Bars of light move with Niko’s voice' },
];
export const DEFAULT_BACKGROUND = 'glow';
export const BACKGROUND_IDS = BACKGROUNDS.map((d) => d.id);
export const isBackground = (v: unknown): v is string => typeof v === 'string' && BACKGROUND_IDS.includes(v);
export const backgroundInfo = (id: string) => BACKGROUNDS.find((d) => d.id === id) ?? BACKGROUNDS[0]!;

// ---------------------------------------------------------------- the admin's settings
export interface BackgroundEntry { on: boolean; paid: boolean; cents: number | null; everOn: boolean; wasOff: boolean }
export interface BackgroundSettings {
  backgrounds: Record<string, BackgroundEntry>;
  bundleCents: number | null;
  credit: boolean;
  rate: 'saving' | 'percent';
  percent: number;
  /** Niko Pro covers backgrounds too (its price is set with designs). */
  pro: boolean;
}

const NEW_ENTRY: BackgroundEntry = { on: false, paid: true, cents: null, everOn: false, wasOff: false };
export const DEFAULT_BACKGROUND_SETTINGS: BackgroundSettings = {
  backgrounds: Object.fromEntries(BACKGROUND_IDS.filter((id) => id !== DEFAULT_BACKGROUND).map((id) => [id, { ...NEW_ENTRY }])),
  bundleCents: null, credit: true, rate: 'saving', percent: 30, pro: true,
};

const cents = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  return Number.isInteger(n) && n >= MIN_CENTS && n <= MAX_CENTS ? n : null;
};
const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);

/** Only known backgrounds and sensible values are kept. Backgrounds Niko learns later start not offered, paid, unpriced. */
export function cleanBackgroundSettings(v: unknown): BackgroundSettings {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, any>;
  const src = (o.backgrounds && typeof o.backgrounds === 'object' ? o.backgrounds : {}) as Record<string, any>;
  const backgrounds: Record<string, BackgroundEntry> = {};
  for (const id of BACKGROUND_IDS) {
    if (id === DEFAULT_BACKGROUND) continue;
    const e = src[id] ?? {};
    backgrounds[id] = { on: bool(e.on, false), paid: bool(e.paid, true), cents: cents(e.cents), everOn: bool(e.everOn, false) || bool(e.on, false), wasOff: bool(e.wasOff, false) };
  }
  const pct = Math.round(Number(o.percent));
  return {
    backgrounds,
    bundleCents: cents(o.bundleCents),
    credit: bool(o.credit, true),
    rate: o.rate === 'percent' ? 'percent' : 'saving',
    percent: Number.isFinite(pct) && pct >= 0 && pct <= 90 ? pct : 30,
    pro: bool(o.pro, true),
  };
}

/** The admin's new settings, with the server's own record of what has been offered and switched off carried forward. */
export function nextBackgroundSettings(prev: BackgroundSettings, incoming: unknown): BackgroundSettings {
  const next = cleanBackgroundSettings(incoming);
  for (const id of Object.keys(next.backgrounds)) {
    const was = prev.backgrounds[id] ?? NEW_ENTRY, now = next.backgrounds[id]!;
    now.everOn = was.everOn || was.on || now.on;
    now.wasOff = was.wasOff || (was.on && !now.on);
  }
  return next;
}

/** Why the admin's settings can't be saved, or null. */
export function backgroundSettingsProblem(s: BackgroundSettings): string | null {
  const unpriced = Object.entries(s.backgrounds).filter(([, e]) => e.on && e.paid && !e.cents).map(([id]) => backgroundInfo(id).name);
  if (unpriced.length) return `Give ${unpriced.join(', ')} a price, or make ${unpriced.length === 1 ? 'it' : 'them'} included.`;
  const sum = offeredPaidBackgrounds(s).reduce((n, d) => n + d.cents, 0);
  if (s.bundleCents && sum && s.bundleCents >= sum) return 'The bundle should cost less than the paid backgrounds bought one by one.';
  return null;
}

export function offeredPaidBackgrounds(s: BackgroundSettings): { id: string; cents: number }[] {
  return BACKGROUND_IDS.flatMap((id) => { const e = s.backgrounds[id]; return e && e.on && e.paid && e.cents ? [{ id, cents: e.cents }] : []; });
}
export const isBackgroundOffered = (s: BackgroundSettings, id: string) => id === DEFAULT_BACKGROUND || !!s.backgrounds[id]?.on;
export const isBackgroundIncluded = (s: BackgroundSettings, id: string) => id === DEFAULT_BACKGROUND || (!!s.backgrounds[id]?.on && !s.backgrounds[id]!.paid);

export function backgroundBundleSaving(s: BackgroundSettings): number | null {
  const sum = offeredPaidBackgrounds(s).reduce((n, d) => n + d.cents, 0);
  return s.bundleCents && sum > s.bundleCents ? 1 - s.bundleCents / sum : null;
}
export function backgroundOwnerOff(s: BackgroundSettings): number {
  return s.rate === 'percent' ? s.percent / 100 : backgroundBundleSaving(s) ?? 0;
}

// ---------------------------------------------------------------- one account
export interface OwnedBackground { cents: number | null; source: string }
export interface BackgroundAccount {
  owned: Record<string, OwnedBackground>;
  /** Has bought "All backgrounds". */
  bundle: boolean;
  /** The Niko Pro add-on is on (and the plan is active). */
  pro: boolean;
  admin: boolean;
  activePlan: Plan | null;
}

export function canUseBackground(s: BackgroundSettings, a: BackgroundAccount, id: string): boolean {
  if (!isBackground(id)) return false;
  if (id === DEFAULT_BACKGROUND || a.admin || a.owned[id]) return true;
  if (!isBackgroundOffered(s, id)) return false;
  return isBackgroundIncluded(s, id) || (a.pro && s.pro);
}
export const effectiveBackground = (s: BackgroundSettings, a: BackgroundAccount, chosen: unknown) => (isBackground(chosen) && canUseBackground(s, a, chosen) ? chosen : DEFAULT_BACKGROUND);

export type BackgroundState = 'included' | 'owned' | 'pro' | 'locked';
export interface BackgroundOffer extends BackgroundInfo {
  state: BackgroundState;
  retired: boolean;
  fresh: boolean;
  back: boolean;
  cents: number | null;
  full: number | null;
}
export interface BackgroundsView {
  backgrounds: BackgroundOffer[];
  bundle: { count: number; cents: number } | null;
  topupAll: { count: number; cents: number } | null;
  /** Niko Pro: one add-on for designs and backgrounds, offered only on an active monthly or yearly plan. */
  pro: { offered: boolean; active: boolean; covers: boolean; cents: number | null; plan: Plan | null };
  bundleOwner: boolean;
}

/** What this account sees. Niko Pro's price and whether it's offered come from the design settings (one add-on). */
export function backgroundsView(s: BackgroundSettings, a: BackgroundAccount, pro: DesignSettings['pro']): BackgroundsView {
  const off = backgroundOwnerOff(s);
  const backgrounds: BackgroundOffer[] = [];
  for (const d of BACKGROUNDS) {
    const e = s.backgrounds[d.id];
    const offered = isBackgroundOffered(s, d.id), owned = !!a.owned[d.id];
    if (!offered && !owned && !a.admin) continue;
    const included = isBackgroundIncluded(s, d.id);
    const state: BackgroundState = included ? 'included' : owned || a.admin ? 'owned' : a.pro && s.pro && offered ? 'pro' : 'locked';
    const full = offered && e?.paid ? e.cents : null;
    const fresh = a.bundle && state === 'locked';
    backgrounds.push({ ...d, state, retired: !offered, fresh, back: fresh && !!e?.wasOff, full, cents: state === 'locked' && full ? (a.bundle ? proRated(full, off) : full) : null });
  }
  const locked = backgrounds.filter((d) => d.state === 'locked' && d.cents);
  let bundle: BackgroundsView['bundle'] = null, topupAll: BackgroundsView['topupAll'] = null;
  if (!a.bundle && s.bundleCents && locked.length >= 2) {
    const paid = s.credit ? Object.values(a.owned).reduce((n, o) => n + (o.cents ?? 0), 0) : 0;
    const price = Math.max(MIN_CENTS, s.bundleCents - paid);
    if (price < locked.reduce((n, d) => n + d.cents!, 0)) bundle = { count: locked.length, cents: price };
  }
  if (a.bundle && locked.length >= 2) topupAll = { count: locked.length, cents: locked.reduce((n, d) => n + d.cents!, 0) };
  const proCents = a.activePlan === 'monthly' ? pro.monthly : a.activePlan === 'yearly' ? pro.yearly : null;
  return {
    backgrounds, bundle, topupAll, bundleOwner: a.bundle,
    pro: { offered: pro.on && s.pro && !!a.activePlan && !!proCents && !a.admin && !a.pro, active: a.pro, covers: s.pro, cents: proCents, plan: a.activePlan },
  };
}

export type BackgroundBuy = 'one' | 'all' | 'topup' | 'topupall';
/** What a purchase covers and costs, worked out from the settings (never from what a screen sent). */
export function backgroundQuote(s: BackgroundSettings, a: BackgroundAccount, what: BackgroundBuy, id?: string): { backgrounds: string[]; cents: number; bundle: boolean } | { error: string } {
  if (a.admin) return { error: 'Admins already have every background.' };
  const v = backgroundsView(s, a, { on: false, monthly: null, yearly: null });
  if (what === 'one' || what === 'topup') {
    const d = v.backgrounds.find((x) => x.id === id);
    if (!d || d.state !== 'locked' || !d.cents) return { error: 'That background isn’t available to unlock.' };
    if ((what === 'topup') !== a.bundle) return { error: 'That price isn’t offered on your account.' };
    return { backgrounds: [d.id], cents: d.cents, bundle: false };
  }
  const offer = what === 'all' ? (a.bundle ? null : v.bundle) : (a.bundle ? v.topupAll : null);
  if (!offer) return { error: 'That isn’t offered on your account right now.' };
  return { backgrounds: v.backgrounds.filter((d) => d.state === 'locked' && d.cents).map((d) => d.id), cents: offer.cents, bundle: what === 'all' };
}
