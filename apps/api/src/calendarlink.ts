// Calendars read from iCal addresses: private ones (Google's "Secret address in iCal format", an Outlook published
// calendar, iCloud) and public ones (holidays, a club, a school). Read-only by nature. Repeating events and time zones
// come from the file itself. An account keeps a list of them, each with its own name, and can switch one off.
import ICAL from 'ical.js';
import { CALENDAR_LIMIT_MAX, type CalendarLink, type EventDetail, type EventItem } from '@niko/shared';
import { publicHttpsUrl } from './providers';

const MAX_BYTES = 5 * 1024 * 1024;
const hex = async (s: string) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, '0')).join('');

// Microsoft's published-calendar links refuse requests that don't look like a web browser (HTTP 400 or 500, or a
// redirect to an error page), and a Worker sends no User-Agent at all. So Microsoft is asked as a browser.
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
// Everyone else gets an honest calendar-client name: a browser name from a data-centre address is more likely to be
// treated as a bot (Google answers those with 429 and a CAPTCHA page).
const CLIENT_UA = 'Niko-Calendar/1.0 (+https://niko.sxingxian.com)';
const MS_HOSTS = /(^|\.)(outlook\.live\.com|outlook\.office365\.com|outlook\.office\.com)$/i;
const isGoogle = (u: URL) => /(^|\.)calendar\.google\.com$/i.test(u.hostname);

/** One pasted address made readable: webcal:// is https://, and Outlook's "HTML" link becomes its ICS twin. */
export function normalizeLink(raw: string): string {
  let v = String(raw ?? '').trim().replace(/^webcal:\/\//i, 'https://');
  const u = publicHttpsUrl(v);
  if (u && MS_HOSTS.test(u.hostname) && /\/calendar\.html\/?$/i.test(u.pathname)) {
    u.pathname = u.pathname.replace(/\/calendar\.html\/?$/i, '/calendar.ics');
    v = u.toString();
  }
  return v;
}

// ---- The saved list
// Stored inside the connection's encrypted secret as JSON under `cals`. Older connections held up to three addresses
// in url, url2 and url3: those are read as calendars "0", "1" and "2", so their event ids (and what Home has already
// shown) stay the same.
export interface Cal { id: string; name: string; url: string; kind: 'private' | 'public'; on: boolean }
const ID_RE = /^[a-z0-9]{1,12}$/;
/** A calendar's name: plain, short, and safe to say in a sentence. */
export const cleanCalName = (v: unknown) => String(v ?? '').replace(/[\u0000-\u001f\u007f“”"<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 40);
/** Google says which kind an address is; anything else is treated as private (its address is a secret). */
export function kindOf(url: string): 'private' | 'public' {
  const u = publicHttpsUrl(url);
  return u && isGoogle(u) && /\/public\/[^/]*$/i.test(u.pathname) ? 'public' : 'private';
}
export function calendarsOf(s: Record<string, string> | null | undefined): Cal[] {
  if (!s) return [];
  if (typeof s.cals === 'string') {
    let raw: unknown;
    try { raw = JSON.parse(s.cals); } catch { return []; }
    if (!Array.isArray(raw)) return [];
    return raw.flatMap((c: any) => {
      const url = normalizeLink(c?.url ?? '');
      if (!c || !ID_RE.test(String(c.id)) || !publicHttpsUrl(url)) return [];
      return [{ id: String(c.id), name: cleanCalName(c.name) || 'Calendar', url, kind: c.kind === 'public' ? 'public' : 'private', on: c.on !== false } as Cal];
    }).slice(0, CALENDAR_LIMIT_MAX);
  }
  return ['url', 'url2', 'url3'].map((k) => normalizeLink(s[k] ?? '')).filter((u) => !!publicHttpsUrl(u))
    .map((url, i) => ({ id: String(i), name: `Calendar ${i + 1}`, url, kind: kindOf(url), on: true }));
}
/** The secret to store for a list. */
export const calendarsSecret = (list: Cal[]): Record<string, string> => ({ cals: JSON.stringify(list.map(({ id, name, url, kind, on }) => ({ id, name, url, kind, on }))) });
export const newCalId = () => [...crypto.getRandomValues(new Uint8Array(8))].map((b) => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join('');
/** A private address is a secret: only its server and file name are ever shown back. A public one is shown in full. */
export function shownAddress(c: Pick<Cal, 'url' | 'kind'>): string {
  const u = publicHttpsUrl(c.url);
  if (!u) return '';
  if (c.kind === 'public') return c.url.slice(0, 300);
  const last = u.pathname.split('/').filter(Boolean).pop() ?? '';
  return `${u.hostname}/…${last && last.length <= 40 ? '/' + last : ''}`;
}
export const shownCalendars = (list: Cal[]): CalendarLink[] => list.map((c) => ({ id: c.id, name: c.name, kind: c.kind, on: c.on, address: shownAddress(c) }));
/** The addresses that are switched on (older callers and tests). */
export const icalLinks = (s: Record<string, string>): string[] => calendarsOf(s).filter((c) => c.on).map((c) => c.url);
/** Runs at most `n` at a time: a Worker may hold only a few outgoing connections open at once. */
async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<PromiseSettledResult<R>[]> {
  const out: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      try { out[i] = { status: 'fulfilled', value: await fn(items[i]!) }; } catch (e) { out[i] = { status: 'rejected', reason: e }; }
    }
  }));
  return out;
}
const quoted = (c: Cal) => `“${c.name}”`;

/** Why an address can't be read, in words that say what to copy instead. Never repeats the address (it is a secret). */
function linkProblem(url: URL, status: number | 'html' | 'signin' | 'page', which: string): string {
  const name = `The ${which} calendar address`;
  if (status === 'page') return isGoogle(url)
    ? `${name} is Google Calendar’s web page, not its calendar file. In Google Calendar → Settings → your calendar → Integrate calendar, copy “Secret address in iCal format”.`
    : `${name} is a web page, not a calendar file. Copy the iCal address (it usually ends in .ics).`;
  if (status === 'signin') return `${name} asks for a sign-in, so Niko can’t read it. Use a published or secret iCal address instead.`;
  if (status === 'html') return MS_HOSTS.test(url.hostname)
    ? `Outlook didn’t hand over the ${which} calendar. Check it is still published (Settings → Calendar → Shared calendars) and copy its ICS link again.`
    : `${name} opens a web page, not a calendar file. Copy the iCal address (it usually ends in .ics).`;
  if (isGoogle(url) && (status === 404 || status === 410)) return /\/public\/[^/]*$/i.test(url.pathname)
    ? `${name} is Google’s public address, and that calendar isn’t public. Copy “Secret address in iCal format” instead (Settings → your calendar → Integrate calendar).`
    : `Google says the ${which} calendar address no longer exists. It may have been reset: copy “Secret address in iCal format” again.`;
  if (MS_HOSTS.test(url.hostname) && [400, 404, 410, 500, 503].includes(status as number)) return `Outlook didn’t hand over the ${which} calendar (it answered ${status}). Check it is still published (Settings → Calendar → Shared calendars, “Can view all details”) and copy its ICS link again.`;
  if (status === 401 || status === 403) return `${name} needs a sign-in, so Niko can’t read it. Use a published or secret iCal address instead.`;
  if (status === 404 || status === 410) return `${name} no longer works. It may have been reset: copy it again.`;
  return `${name} couldn’t be read (the calendar server answered ${status}). Try again in a few minutes.`;
}

// ---- How often a calendar is fetched
// Calendar servers limit how often a feed may be read, and Workers share Cloudflare's addresses with many others, so
// each feed is read at most every 10 minutes. The last good copy is kept for a day: if the server says "too many
// requests" (429) or fails, that copy is used quietly and the server is left alone for as long as it asks (Retry-After).
const FRESH_MS = 10 * 60_000;
const KEEP_MS = 24 * 3600_000;
const BACKOFF_MS = { 429: 15 * 60_000, other: 5 * 60_000, max: 3600_000 };
interface Kept { text: string; at: number; until: number } // until = don't ask the server again before this time

// Two layers: this Worker instance's memory (instant, survives between requests on the same instance) and
// Cloudflare's cache in this data centre (shared by instances; may be evicted, so it is only a helper).
const mem = new Map<string, Kept>();
const cacheKey = (h: string) => new Request(`https://niko-cache.invalid/ical/${h}`);
const edge = () => (globalThis as any).caches?.default as Cache | undefined;
async function readKept(h: string): Promise<Kept | null> {
  const m = mem.get(h);
  if (m) return m;
  const hit = await edge()?.match(cacheKey(h)).catch(() => undefined);
  if (!hit) return null;
  const k = { text: await hit.text(), at: Number(hit.headers.get('x-at')) || 0, until: Number(hit.headers.get('x-until')) || 0 };
  mem.set(h, k);
  return k;
}
async function keep(h: string, k: Kept): Promise<void> {
  if (mem.size > 200) mem.delete(mem.keys().next().value!);
  mem.set(h, k);
  await edge()?.put(cacheKey(h), new Response(k.text, { headers: { 'cache-control': `max-age=${KEEP_MS / 1000}`, 'x-at': String(k.at), 'x-until': String(k.until) } })).catch(() => undefined);
}
/** Seconds or an HTTP date, as Retry-After allows; within sensible bounds. */
function retryAfterMs(v: string | null, fallback: number): number {
  if (!v) return fallback;
  const n = /^\d+$/.test(v.trim()) ? Number(v) * 1000 : Date.parse(v) - Date.now();
  return Number.isFinite(n) && n > 0 ? Math.min(Math.max(n, 60_000), BACKOFF_MS.max) : fallback;
}
class Busy extends Error { constructor(message: string, readonly waitMs: number) { super(message); } }
const serverName = (u: URL) => (isGoogle(u) ? 'Google' : MS_HOSTS.test(u.hostname) ? 'Outlook' : 'The calendar server');
const minutes = (ms: number) => Math.max(1, Math.round(ms / 60_000));

/** One calendar file: from the kept copy when it is recent, otherwise from the server. Never echoes the address. */
async function fetchIcs(url: string, which = '“Calendar”'): Promise<string> {
  const u = new URL(url);
  // Google's "embed" and app links are pages for people, not files: say so before fetching.
  if (isGoogle(u) && !/\/ical\//i.test(u.pathname)) throw new Error(linkProblem(u, 'page', which));
  const h = await hex(url);
  const now = Date.now();
  const kept = await readKept(h);
  if (kept?.text && now - kept.at < FRESH_MS) return kept.text;
  if (kept && now < kept.until) {
    if (kept.text && now - kept.at < KEEP_MS) return kept.text;
    throw new Error(`${serverName(u)} asked Niko to wait before reading the ${which} calendar again. It will try in about ${minutes(kept.until - now)} min.`);
  }
  try {
    const text = await download(u, url, which);
    await keep(h, { text, at: now, until: 0 });
    return text;
  } catch (e) {
    if (!(e instanceof Busy)) throw e;
    // Too many requests, or the server is having trouble: back off, and use the last good copy if there is one.
    await keep(h, { text: kept?.text ?? '', at: kept?.at ?? 0, until: now + e.waitMs });
    if (kept?.text && now - kept.at < KEEP_MS) { console.warn(`ical: ${e.message} (showing the copy from ${minutes(now - kept.at)} min ago)`); return kept.text; }
    throw new Error(e.message);
  }
}

async function download(u: URL, url: string, which: string): Promise<string> {
  let res: Response;
  try {
    res = await fetch(url, { headers: { 'user-agent': MS_HOSTS.test(u.hostname) ? BROWSER_UA : CLIENT_UA, accept: 'text/calendar, text/plain;q=0.9, */*;q=0.8' }, redirect: 'follow', signal: AbortSignal.timeout(12_000) });
  } catch {
    throw new Busy(`The ${which} calendar address didn’t answer in time. Niko will try again in a few minutes.`, BACKOFF_MS.other);
  }
  // Redirected to a sign-in page: the link is private to an account, not published.
  if (/(^|\.)(login\.live\.com|login\.microsoftonline\.com|accounts\.google\.com)$/i.test(new URL(res.url || url).hostname)) throw new Error(linkProblem(u, 'signin', which));
  if (res.status === 429) {
    const wait = retryAfterMs(res.headers.get('retry-after'), BACKOFF_MS[429]);
    throw new Busy(`${serverName(u)} is limiting how often the ${which} calendar can be read. Niko will try again in about ${minutes(wait)} min.`, wait);
  }
  // Outlook's 500 means "not published / not a browser"; other servers' 5xx is a passing fault.
  if (res.status >= 500 && !MS_HOSTS.test(u.hostname)) throw new Busy(`${serverName(u)} had a problem reading the ${which} calendar (it answered ${res.status}). Niko will try again in a few minutes.`, retryAfterMs(res.headers.get('retry-after'), BACKOFF_MS.other));
  if (!res.ok) throw new Error(linkProblem(u, res.status, which));
  if (Number(res.headers.get('content-length')) > MAX_BYTES) throw new Error(`The ${which} calendar is too large to read.`);
  const text = await res.text();
  if (text.length > MAX_BYTES) throw new Error(`The ${which} calendar is too large to read.`);
  if (!/BEGIN:VCALENDAR/i.test(text.slice(0, 2000))) throw new Error(linkProblem(u, 'html', which));
  return text;
}

/** For tests: forget kept copies. */
export function forgetIcsCopies() { mem.clear(); }

interface Occ { uid: string; start: number; end: number; allDay: boolean; ev: any }
function parse(text: string): any {
  const comp = new ICAL.Component(ICAL.parse(text));
  for (const tz of comp.getAllSubcomponents('vtimezone')) { try { ICAL.TimezoneService.register(tz); } catch { /* already known */ } }
  return comp;
}
/** Start of a date-only (all-day) value in the user's own day, in UTC milliseconds. */
const dayMs = (t: any, tzOffsetMin: number) => Date.UTC(t.year, t.month - 1, t.day) + tzOffsetMin * 60_000;
const ms = (t: any, tzOffsetMin: number) => (t.isDate ? dayMs(t, tzOffsetMin) : t.toJSDate().getTime());

function occurrences(comp: any, from: number, to: number, tzOffsetMin: number): Occ[] {
  const out: Occ[] = [];
  const vevents = comp.getAllSubcomponents('vevent');
  // Changed instances of a repeating event (RECURRENCE-ID) are attached to their series, so a moved week shows its new time.
  const masters = new Map<string, any>();
  for (const v of vevents) if (!v.getFirstPropertyValue('recurrence-id')) masters.set(String(v.getFirstPropertyValue('uid')), new ICAL.Event(v));
  const orphans: any[] = [];
  for (const v of vevents) {
    if (!v.getFirstPropertyValue('recurrence-id')) continue;
    const m = masters.get(String(v.getFirstPropertyValue('uid')));
    if (m) m.relateException(new ICAL.Event(v)); else orphans.push(new ICAL.Event(v));
  }
  const cancelled = (e: any) => String(e.component?.getFirstPropertyValue('status') ?? '').toUpperCase() === 'CANCELLED';
  const push = (ev: any, item: any, startT: any, endT: any) => {
    if (!startT || cancelled(item)) return;
    const s = ms(startT, tzOffsetMin), e = endT ? ms(endT, tzOffsetMin) : s;
    if (e > from && s < to || s === from) out.push({ uid: String(ev.uid), start: s, end: e, allDay: !!startT.isDate, ev: item });
  };
  for (const ev of [...masters.values(), ...orphans]) {
    if (!ev.startDate) continue;
    if (!ev.isRecurring()) { push(ev, ev, ev.startDate, ev.endDate); continue; }
    if (cancelled(ev)) continue;
    // A week's margin past the window catches an instance moved into this day from a later one.
    const it = ev.iterator();
    for (let n = 0, next = it.next(); next && n < 2000; n++, next = it.next()) {
      if (ms(next, tzOffsetMin) >= to + 7 * 86_400_000) break;
      const d = ev.getOccurrenceDetails(next);
      push(ev, d.item, d.startDate, d.endDate);
    }
  }
  return out;
}
const idOf = (cal: string, o: Occ) => `${cal}~${o.start}~${o.uid}`.slice(0, 1000);

export async function icalList(s: Record<string, string>, from: Date, to: Date, tzOffsetMin: number, max = CALENDAR_LIMIT_MAX): Promise<EventItem[]> {
  // Only as many as the account may keep are read, even if its limit was lowered after they were added.
  const links = calendarsOf(s).filter((c) => c.on).slice(0, max);
  // One address failing (reset, unpublished, a slow server) must not hide the events of the others.
  const lists = await pool(links, 6, async (cal) => {
    const occ = occurrences(parse(await fetchIcs(cal.url, quoted(cal))), from.getTime(), to.getTime(), tzOffsetMin);
    return occ.map((o) => ({ id: idOf(cal.id, o), provider: 'ical', title: String(o.ev.summary || '(no title)'), source: cal.name, start: o.start, time: '', allDay: o.allDay } as EventItem));
  });
  const failed = lists.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
  for (const f of failed) console.warn(`ical: ${String(f.reason?.message ?? f.reason).slice(0, 200)}`);
  if (links.length && failed.length === links.length) throw failed[0]!.reason;
  return lists.flatMap((r) => (r.status === 'fulfilled' ? r.value : [])).sort((a, b) => a.start - b.start).slice(0, 100);
}

export async function icalDetail(s: Record<string, string>, id: string, tzOffsetMin = 0): Promise<EventDetail> {
  const m = /^([a-z0-9]{1,12})~(-?\d{1,15})~([\s\S]+)$/.exec(id);
  const cal = m ? calendarsOf(s).find((c) => c.id === m[1] && c.on) : undefined;
  if (!m || !cal) throw new Error('That event is not in your calendar links.');
  const start = Number(m[2]);
  const o = occurrences(parse(await fetchIcs(cal.url, quoted(cal))), start - 86_400_000, start + 86_400_000, tzOffsetMin).find((x) => x.uid === m[3] && x.start === start);
  if (!o) throw new Error('That event is no longer in the calendar.');
  const attendees = (o.ev.attendees ?? []).map((p: any) => String(p.getParameter?.('cn') || String(p.getFirstValue?.() ?? '').replace(/^mailto:/i, ''))).filter(Boolean).slice(0, 30);
  const desc = String(o.ev.description ?? '').trim();
  return { title: String(o.ev.summary || '(no title)'), source: cal.name, start: o.start, end: o.end, allDay: o.allDay, location: String(o.ev.location ?? '') || undefined, description: desc ? desc.slice(0, 8000) : undefined, attendees };
}

/** Reads one address once, to check it before it is saved. */
export async function icalCheckOne(url: string, name: string): Promise<void> {
  const text = await fetchIcs(url, `“${name}”`);
  try { parse(text); } catch { throw new Error(`The “${name}” calendar address gave a file Niko can’t read as a calendar.`); }
}
/** Reads every saved address once (older callers and tests). */
export async function icalCheck(s: Record<string, string>): Promise<void> {
  const list = calendarsOf(s);
  if (!list.length) throw new Error('Paste the iCal address of your calendar (it usually ends in .ics).');
  for (const c of list) await icalCheckOne(c.url, c.name);
}
