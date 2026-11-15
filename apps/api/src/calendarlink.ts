// Calendars read from a private iCal address (Google's "Secret address in iCal format", an Outlook published
// calendar, iCloud, and so on). Read-only by nature. Repeating events and time zones come from the file itself.
import ICAL from 'ical.js';
import type { EventDetail, EventItem } from '@niko/shared';
import { publicHttpsUrl } from './providers';

const MAX_BYTES = 5 * 1024 * 1024;
const CACHE_SECONDS = 300;
const hex = async (s: string) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, '0')).join('');

// Microsoft's published-calendar links refuse requests that don't look like a web browser (HTTP 400 or 500, or a
// redirect to an error page), and a Worker sends no User-Agent at all. Google accepts either. So identify as a browser.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const MS_HOSTS = /(^|\.)(outlook\.live\.com|outlook\.office365\.com|outlook\.office\.com)$/i;
const isGoogle = (u: URL) => /(^|\.)calendar\.google\.com$/i.test(u.hostname);
const ORDINAL = ['first', 'second', 'third'];

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

/** The calendar links saved on a connection, as https addresses. */
export function icalLinks(s: Record<string, string>): string[] {
  return ['url', 'url2', 'url3'].map((k) => normalizeLink(s[k] ?? '')).filter((u) => !!publicHttpsUrl(u));
}

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

/** Fetches one calendar file, kept for five minutes in Cloudflare's cache under a hash of its address, never the address itself. */
async function fetchIcs(url: string, which = 'first'): Promise<string> {
  const u = new URL(url);
  // Google's "embed" and app links are pages for people, not files: say so before fetching.
  if (isGoogle(u) && !/\/ical\//i.test(u.pathname)) throw new Error(linkProblem(u, 'page', which));
  const key = new Request(`https://niko-cache.invalid/ical/${await hex(url)}`);
  const cache = (globalThis as any).caches?.default as Cache | undefined;
  const hit = await cache?.match(key);
  if (hit) return hit.text();
  let res: Response;
  try {
    res = await fetch(url, { headers: { 'user-agent': UA, accept: 'text/calendar, text/plain;q=0.9, */*;q=0.8' }, redirect: 'follow', signal: AbortSignal.timeout(12_000) });
  } catch {
    throw new Error(`The ${which} calendar address didn’t answer in time. Check it, or try again in a few minutes.`);
  }
  // Redirected to a sign-in page: the link is private to an account, not published.
  if (/(^|\.)(login\.live\.com|login\.microsoftonline\.com|accounts\.google\.com)$/i.test(new URL(res.url || url).hostname)) throw new Error(linkProblem(u, 'signin', which));
  if (!res.ok) throw new Error(linkProblem(u, res.status, which));
  if (Number(res.headers.get('content-length')) > MAX_BYTES) throw new Error(`The ${which} calendar is too large to read.`);
  const text = await res.text();
  if (text.length > MAX_BYTES) throw new Error(`The ${which} calendar is too large to read.`);
  if (!/BEGIN:VCALENDAR/i.test(text.slice(0, 2000))) throw new Error(linkProblem(u, 'html', which));
  await cache?.put(key, new Response(text, { headers: { 'cache-control': `max-age=${CACHE_SECONDS}` } })).catch(() => undefined);
  return text;
}

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
const idOf = (link: number, o: Occ) => `${link}~${o.start}~${o.uid}`.slice(0, 1000);

export async function icalList(s: Record<string, string>, from: Date, to: Date, tzOffsetMin: number): Promise<EventItem[]> {
  const links = icalLinks(s);
  // One address failing (reset, unpublished, a slow server) must not hide the events of the others.
  const lists = await Promise.allSettled(links.map(async (url, i) => {
    const occ = occurrences(parse(await fetchIcs(url, ORDINAL[i])), from.getTime(), to.getTime(), tzOffsetMin);
    return occ.map((o) => ({ id: idOf(i, o), provider: 'ical', title: String(o.ev.summary || '(no title)'), source: 'Calendar', start: o.start, time: '', allDay: o.allDay } as EventItem));
  }));
  const failed = lists.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
  for (const f of failed) console.warn(`ical: ${String(f.reason?.message ?? f.reason).slice(0, 200)}`);
  if (links.length && failed.length === links.length) throw failed[0]!.reason;
  return lists.flatMap((r) => (r.status === 'fulfilled' ? r.value : [])).sort((a, b) => a.start - b.start).slice(0, 20);
}

export async function icalDetail(s: Record<string, string>, id: string, tzOffsetMin = 0): Promise<EventDetail> {
  const m = /^(\d)~(-?\d{1,15})~([\s\S]+)$/.exec(id);
  const url = m ? icalLinks(s)[Number(m[1])] : undefined;
  if (!m || !url) throw new Error('That event is not in your calendar links.');
  const start = Number(m[2]);
  const o = occurrences(parse(await fetchIcs(url, ORDINAL[Number(m[1])])), start - 86_400_000, start + 86_400_000, tzOffsetMin).find((x) => x.uid === m[3] && x.start === start);
  if (!o) throw new Error('That event is no longer in the calendar.');
  const attendees = (o.ev.attendees ?? []).map((p: any) => String(p.getParameter?.('cn') || String(p.getFirstValue?.() ?? '').replace(/^mailto:/i, ''))).filter(Boolean).slice(0, 30);
  const desc = String(o.ev.description ?? '').trim();
  return { title: String(o.ev.summary || '(no title)'), source: 'Calendar', start: o.start, end: o.end, allDay: o.allDay, location: String(o.ev.location ?? '') || undefined, description: desc ? desc.slice(0, 8000) : undefined, attendees };
}

/** Reads the links once to check them before they are saved. */
export async function icalCheck(s: Record<string, string>): Promise<void> {
  const links = icalLinks(s);
  if (!links.length) throw new Error('Paste the private iCal address of your calendar (it ends in .ics).');
  for (const [i, url] of links.entries()) {
    const text = await fetchIcs(url, ORDINAL[i]);
    try { parse(text); } catch { throw new Error(`The ${ORDINAL[i]} calendar address gave a file Niko can’t read as a calendar.`); }
  }
}
