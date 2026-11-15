// Calendars read from a private iCal address (Google's "Secret address in iCal format", an Outlook published
// calendar, iCloud, and so on). Read-only by nature. Repeating events and time zones come from the file itself.
import ICAL from 'ical.js';
import type { EventDetail, EventItem } from '@niko/shared';
import { publicHttpsUrl } from './providers';

const MAX_BYTES = 5 * 1024 * 1024;
const CACHE_SECONDS = 300;
const hex = async (s: string) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, '0')).join('');

/** The calendar links saved on a connection, as https addresses ("webcal://" is the same thing). */
export function icalLinks(s: Record<string, string>): string[] {
  return ['url', 'url2', 'url3'].map((k) => String(s[k] ?? '').trim().replace(/^webcal:\/\//i, 'https://')).filter((u) => !!publicHttpsUrl(u));
}

/** Fetches one calendar file, kept for five minutes in Cloudflare's cache under a hash of its address, never the address itself. */
async function fetchIcs(url: string): Promise<string> {
  const key = new Request(`https://niko-cache.invalid/ical/${await hex(url)}`);
  const cache = (globalThis as any).caches?.default as Cache | undefined;
  const hit = await cache?.match(key);
  if (hit) return hit.text();
  const res = await fetch(url, { headers: { accept: 'text/calendar, text/plain' }, signal: AbortSignal.timeout(12_000) });
  if (res.status === 404 || res.status === 410) throw new Error('That calendar link no longer works. It may have been reset: copy it again.');
  if (!res.ok) throw new Error(`The calendar link answered ${res.status}.`);
  if (Number(res.headers.get('content-length')) > MAX_BYTES) throw new Error('That calendar is too large to read.');
  const text = await res.text();
  if (text.length > MAX_BYTES) throw new Error('That calendar is too large to read.');
  if (!/BEGIN:VCALENDAR/i.test(text.slice(0, 2000))) throw new Error('That link is not an iCal calendar. Copy the address that ends in .ics.');
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
  const lists = await Promise.all(links.map(async (url, i) => {
    const occ = occurrences(parse(await fetchIcs(url)), from.getTime(), to.getTime(), tzOffsetMin);
    return occ.map((o) => ({ id: idOf(i, o), provider: 'ical', title: String(o.ev.summary || '(no title)'), source: 'Calendar', start: o.start, time: '', allDay: o.allDay } as EventItem));
  }));
  return lists.flat().sort((a, b) => a.start - b.start).slice(0, 20);
}

export async function icalDetail(s: Record<string, string>, id: string, tzOffsetMin = 0): Promise<EventDetail> {
  const m = /^(\d)~(-?\d{1,15})~([\s\S]+)$/.exec(id);
  const url = m ? icalLinks(s)[Number(m[1])] : undefined;
  if (!m || !url) throw new Error('That event is not in your calendar links.');
  const start = Number(m[2]);
  const o = occurrences(parse(await fetchIcs(url)), start - 86_400_000, start + 86_400_000, tzOffsetMin).find((x) => x.uid === m[3] && x.start === start);
  if (!o) throw new Error('That event is no longer in the calendar.');
  const attendees = (o.ev.attendees ?? []).map((p: any) => String(p.getParameter?.('cn') || String(p.getFirstValue?.() ?? '').replace(/^mailto:/i, ''))).filter(Boolean).slice(0, 30);
  const desc = String(o.ev.description ?? '').trim();
  return { title: String(o.ev.summary || '(no title)'), source: 'Calendar', start: o.start, end: o.end, allDay: o.allDay, location: String(o.ev.location ?? '') || undefined, description: desc ? desc.slice(0, 8000) : undefined, attendees };
}

/** Reads the links once to check them before they are saved. */
export async function icalCheck(s: Record<string, string>): Promise<void> {
  const links = icalLinks(s);
  if (!links.length) throw new Error('Paste the private iCal address of your calendar (it ends in .ics).');
  for (const url of links) parse(await fetchIcs(url));
}
