// Niko's browser: the settings shared by the server, the app and the admin portal.
// The admin sets a default for everyone and changes for any one person on top of it (the same pattern as AI options
// and data sources). People choose a few things for themselves on Settings › Browser.
import { hostProblem } from './dataSources';

// ---------------------------------------------------------------- the Cloudflare connection
/** A Cloudflare account ID: 32 hex characters. */
export const isCfAccountId = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{32}$/.test(v.trim().toLowerCase());
/** A Cloudflare API token, as pasted: letters, digits, - and _, nothing else. Anything else is refused before it is sent. */
export const isCfToken = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{30,200}$/.test(v.trim());

// ---------------------------------------------------------------- the admin's settings
export interface BrowserDefaults {
  /** People may let Niko use a browser. */
  on: boolean;
  /** Built-in (Cloudflare) browser time per person per day, in minutes. */
  mins: number;
  /** People may add their own browser service (own server or hosted service with their key). */
  ownService: boolean;
  /** Daily minutes on a person's own browser service; 0 = no limit. */
  ownMins: number;
  /** Daily minutes on the account's hosted service; 0 = no limit. */
  hostMins: number;
  /** Browsers open at once on the account's own server (for everyone). */
  atOnce: number;
  /** When daily minutes refill: the hour, in UTC (0 = 8:00 am in Singapore, when Cloudflare refills its free minutes). */
  refillHourUtc: number;
  /** People may choose "Stay signed in" for a site. */
  staySignedIn: boolean;
  /** The longest anyone keeps "What Niko did" (days). */
  historyDays: number;
  /** Sites Niko can't open (host names; each also covers its subdomains). For everyone. */
  blocked: string[];
}
/** The admin's changes for one person. Missing = follows the default. */
export interface BrowserAccess { on?: boolean; ownService?: boolean; mins?: number; ownMins?: number; hostMins?: number }
export type BrowserAccessKey = keyof BrowserAccess;

export const BROWSER_MIN_STEPS = [5, 10, 15, 20, 30, 45, 60, 90, 120, 180, 240] as const;
/** Daily limits that can also be "no limit" (0). */
export const BROWSER_OPEN_STEPS = [0, 30, 60, 120, 240] as const;
export const BROWSER_AT_ONCE_MAX = 10;
export const BROWSER_HISTORY_DAYS = [7, 30, 90] as const;
export const BROWSER_BLOCKED_MAX = 200;

export const DEFAULT_BROWSER: BrowserDefaults = {
  on: true, mins: 10, ownService: false, ownMins: 0, hostMins: 0, atOnce: 2, refillHourUtc: 0, staySignedIn: true, historyDays: 90, blocked: [],
};

const pick = <T extends number>(v: unknown, steps: readonly T[], fallback: T): T => (steps.includes(v as T) ? (v as T) : fallback);
const int = (v: unknown, lo: number, hi: number, fallback: number) => (typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi ? v : fallback);
const bool = (v: unknown, fallback: boolean) => (typeof v === 'boolean' ? v : fallback);

/** A site the admin blocks, cleaned to its host name: "https://www.Bank.example/login", "bank.example/*" and
 * "*.bank.example" all become "bank.example" (which also covers its subdomains). Null when it isn't a site. */
export function cleanSitePattern(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let t = raw.trim().toLowerCase().slice(0, 300);
  if (!t) return null;
  t = t.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/^\*\./, '').replace(/^www\./, '');
  t = t.split(/[/?#]/)[0]!.replace(/:\d+$/, '').replace(/\.$/, '');
  return hostProblem(t) ? null : t;
}

export function cleanBrowserDefaults(v: unknown): BrowserDefaults {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const d = DEFAULT_BROWSER;
  const blocked = Array.isArray(o.blocked) ? [...new Set(o.blocked.map(cleanSitePattern).filter((x): x is string => !!x))].slice(0, BROWSER_BLOCKED_MAX) : d.blocked;
  return {
    on: bool(o.on, d.on),
    mins: pick(o.mins, BROWSER_MIN_STEPS, d.mins as (typeof BROWSER_MIN_STEPS)[number]),
    ownService: bool(o.ownService, d.ownService),
    ownMins: pick(o.ownMins, BROWSER_OPEN_STEPS, d.ownMins as (typeof BROWSER_OPEN_STEPS)[number]),
    hostMins: pick(o.hostMins, BROWSER_OPEN_STEPS, d.hostMins as (typeof BROWSER_OPEN_STEPS)[number]),
    atOnce: int(o.atOnce, 1, BROWSER_AT_ONCE_MAX, d.atOnce),
    refillHourUtc: int(o.refillHourUtc, 0, 23, d.refillHourUtc),
    staySignedIn: bool(o.staySignedIn, d.staySignedIn),
    historyDays: pick(o.historyDays, BROWSER_HISTORY_DAYS, d.historyDays as (typeof BROWSER_HISTORY_DAYS)[number]),
    blocked,
  };
}

/** One person's changes, kept only where valid. A value equal to the default is still kept: the default may change later. */
export function cleanBrowserAccess(v: unknown): BrowserAccess {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const out: BrowserAccess = {};
  if (typeof o.on === 'boolean') out.on = o.on;
  if (typeof o.ownService === 'boolean') out.ownService = o.ownService;
  if ((BROWSER_MIN_STEPS as readonly unknown[]).includes(o.mins)) out.mins = o.mins as number;
  if ((BROWSER_OPEN_STEPS as readonly unknown[]).includes(o.ownMins)) out.ownMins = o.ownMins as number;
  if ((BROWSER_OPEN_STEPS as readonly unknown[]).includes(o.hostMins)) out.hostMins = o.hostMins as number;
  return out;
}

/** What one person gets: the default with their changes on top. Admins always have the browser. */
export interface BrowserAllowance { on: boolean; ownService: boolean; mins: number; ownMins: number; hostMins: number }
export function browserFor(defaults: BrowserDefaults, access: BrowserAccess, isAdmin = false): BrowserAllowance {
  const a = cleanBrowserAccess(access);
  return {
    on: isAdmin ? true : a.on ?? defaults.on,
    ownService: a.ownService ?? defaults.ownService,
    mins: a.mins ?? defaults.mins,
    ownMins: a.ownMins ?? defaults.ownMins,
    hostMins: a.hostMins ?? defaults.hostMins,
  };
}

// ---------------------------------------------------------------- sites
/** The host of an address Niko may open, or null: only http(s), only public names (no number addresses, no local names). */
export function openableHost(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let u: URL;
  try { u = new URL(raw.trim()); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (u.username || u.password) return null;
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  return hostProblem(host) ? null : host;
}
/** Whether a host is one the admin blocked (a blocked site covers its subdomains too). */
export function hostBlocked(host: string, blocked: readonly string[]): boolean {
  const h = host.toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
  return blocked.some((b) => h === b || h.endsWith('.' + b));
}
/** The site part people recognise: "accounts.pebbleandpeak.example" → "pebbleandpeak.example". */
export function siteOf(host: string): string {
  const parts = host.toLowerCase().replace(/^www\./, '').split('.');
  // Two-part public suffixes such as co.uk, com.sg, com.au keep three parts.
  const two = parts.length >= 3 && /^(co|com|net|org|gov|edu|ac)$/.test(parts[parts.length - 2]!) && parts[parts.length - 1]!.length === 2;
  return parts.slice(two ? -3 : -2).join('.');
}
/** Something a person or Niko typed, made into an address: "pebbleandpeak.example" → "https://pebbleandpeak.example/". */
export function toAddress(raw: string): string | null {
  const t = raw.trim();
  if (!t || /\s/.test(t)) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(t) ? t : 'https://' + t;
  return openableHost(withScheme) ? new URL(withScheme).toString() : null;
}

// ---------------------------------------------------------------- daily minutes
/** The moment minutes last refilled (at or before `now`). */
export function lastRefill(now: Date, hourUtc: number): Date {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hourUtc));
  if (d.getTime() > now.getTime()) d.setUTCDate(d.getUTCDate() - 1);
  return d;
}
export const nextRefill = (now: Date, hourUtc: number) => new Date(lastRefill(now, hourUtc).getTime() + 86_400_000);

// ---------------------------------------------------------------- what each person chooses (Settings › Browser)
export interface BrowserPrefs {
  /** Let Niko use a browser. */
  on: boolean;
  /** Ask before Niko downloads a file. */
  askDownloads: boolean;
  /** Ask before Niko goes to a site the person didn't name. */
  askNewSite: boolean;
  /** Offer sign-in codes found in the Inbox. */
  inboxCodes: boolean;
  /** How long "What Niko did" is kept (days); never more than the admin allows. */
  keepDays: number;
}
export const DEFAULT_BROWSER_PREFS: BrowserPrefs = { on: true, askDownloads: true, askNewSite: true, inboxCodes: true, keepDays: 30 };
export function cleanBrowserPrefs(v: unknown, maxDays = 90): BrowserPrefs {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const d = DEFAULT_BROWSER_PREFS;
  const keep = pick(o.keepDays, BROWSER_HISTORY_DAYS, d.keepDays as (typeof BROWSER_HISTORY_DAYS)[number]);
  return {
    on: bool(o.on, d.on), askDownloads: bool(o.askDownloads, d.askDownloads), askNewSite: bool(o.askNewSite, d.askNewSite),
    inboxCodes: bool(o.inboxCodes, d.inboxCodes), keepDays: Math.min(keep, maxDays),
  };
}

// ---------------------------------------------------------------- browser services
/** Where a session runs. 'cloudflare' is built in; 'server' and 'hosted' are the account's; 'own' is the person's. */
export type BrowserServiceKind = 'cloudflare' | 'server' | 'hosted' | 'own';
/** A browser service's address: https or wss, a public host name, no sign-in in the address. */
export function cleanServiceUrl(raw: unknown): { url: string } | { problem: string } {
  const t = typeof raw === 'string' ? raw.trim().slice(0, 500) : '';
  let u: URL;
  try { u = new URL(t); } catch { return { problem: 'Enter the full address, starting with https:// or wss://.' }; }
  if (u.protocol !== 'https:' && u.protocol !== 'wss:') return { problem: 'The address must start with https:// or wss://.' };
  if (u.username || u.password) return { problem: 'Put the token in its own box, not in the address.' };
  const p = hostProblem(u.hostname);
  if (p) return { problem: p === 'Only public internet addresses can be used.' ? 'Home network addresses can’t be used. Make it reachable over HTTPS, for example through a Cloudflare Tunnel.' : p };
  u.hash = '';
  return { url: u.toString() };
}
