// New items on Home: what is new since an account was last checked, shown once only.
// "New" means: an unread email or a message that was not there before, an event that appeared on the calendar, a
// note changed by someone else, or an event about to start (a reminder). The first check of each kind only learns what
// is already there, so turning this on never floods Home with old things.
import { eq } from 'drizzle-orm';
import { appSettings, type Db } from '@niko/db';
import { cleanGlanceLimits, glanceLimits, type Brief, type GlanceItem, type GlanceLimits, type GlancePart } from '@niko/shared';

export const GLANCE_DEFAULT_KEY = 'glance-limits';
const SEEN_DAYS = 14, SEEN_MAX = 1500;

let cache: { at: number; v: Partial<GlanceLimits> } | null = null;
/** The admin's default limits, read at most every 30 seconds per Worker instance. */
export async function glanceDefaults(db: Db, fresh = false): Promise<Partial<GlanceLimits>> {
  if (!fresh && cache && Date.now() - cache.at < 30_000) return cache.v;
  const row = (await db.select().from(appSettings).where(eq(appSettings.key, GLANCE_DEFAULT_KEY)).limit(1).catch(() => []))[0];
  cache = { at: Date.now(), v: cleanGlanceLimits(row?.value) };
  return cache.v;
}
export const forgetGlanceDefaults = () => { cache = null; };
export async function limitsFor(db: Db, user: { glanceLimits?: unknown }): Promise<GlanceLimits> {
  return glanceLimits(await glanceDefaults(db), cleanGlanceLimits(user.glanceLimits));
}

export interface GlanceState { checked: Record<string, number>; seen: Record<string, number>; upcoming: { id: string; provider: string; title: string; start: number; source: string }[] }

const clock = (ms: number, tz: number) => { const d = new Date(ms - tz * 60_000); return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`; };

/**
 * Compares what was just read with what this account has already been shown, and returns the new items and the next
 * state. `parts` are the kinds read in this check; `remind` is the reminder lead time in minutes (0 = none).
 */
export function diffGlance(prev: GlanceState, brief: Brief, parts: GlancePart[], now: number, remind: number, tz: number): { items: GlanceItem[]; state: GlanceState } {
  const seen = { ...prev.seen }, checked = { ...prev.checked }, items: GlanceItem[] = [];
  let upcoming = prev.upcoming;
  for (const part of parts) {
    // The first check (or the first after two days without one) only learns what is already there, so nothing old floods Home.
    const first = !checked[part] || now - checked[part]! > 2 * 86400_000;
    const found: GlanceItem[] = [];
    if (part === 'mail') for (const m of brief.mail) found.push({ key: `mail:${m.provider}:${m.id}`, kind: 'mail', title: m.from, line: m.subject, source: m.source, at: now, view: 'inbox', open: `${m.from} ${m.subject}`, canReply: true });
    if (part === 'chats') for (const c of brief.chats) found.push({ key: `chat:${c.provider}:${c.chatId}:${c.lastAt ?? 0}`, kind: 'chat', title: c.title, line: c.last, source: c.source, at: c.lastAt ?? now, view: 'inbox', open: c.title, canReply: true });
    if (part === 'events') {
      for (const e of brief.events) if (e.start > now) found.push({ key: `event:${e.provider}:${e.id}`, kind: 'invite', title: e.title, line: e.time, source: e.source, at: now, view: 'calendar', open: e.title });
      // The next few hours of events, kept for reminders, so a reminder needs no extra call to the calendar.
      upcoming = brief.events.filter((e) => !e.allDay && e.start > now && e.start < now + 6 * 3600_000).slice(0, 20).map((e) => ({ id: e.id, provider: e.provider, title: e.title, start: e.start, source: e.source }));
    }
    if (part === 'notes') for (const n of brief.notes) if (!n.byMe) found.push({ key: `note:${n.provider}:${n.id}:${n.edited ?? 0}`, kind: 'note', title: n.title, line: 'Changed', source: n.source, at: n.edited ?? now, view: 'notes', open: n.title });
    for (const it of found) {
      if (seen[it.key]) continue;
      seen[it.key] = now;
      if (!first) items.push(it);
    }
    checked[part] = now;
  }
  // Reminders: an event starting within the lead time, said once.
  if (remind > 0) for (const e of upcoming) {
    const key = `remind:${e.provider}:${e.id}:${e.start}`;
    if (seen[key] || e.start <= now || e.start - now > remind * 60_000) continue;
    seen[key] = now;
    const mins = Math.max(1, Math.round((e.start - now) / 60_000));
    items.push({ key, kind: 'reminder', title: e.title, line: `Starts in ${mins} minute${mins === 1 ? '' : 's'}, at ${clock(e.start, tz)}`, source: e.source, at: now, view: 'calendar', open: e.title });
  }
  // What has been shown is remembered for two weeks (at most 1,500 entries).
  const cutoff = now - SEEN_DAYS * 86400_000;
  const kept = Object.entries(seen).filter(([, t]) => t > cutoff).sort((a, b) => b[1] - a[1]).slice(0, SEEN_MAX);
  return { items: items.slice(0, 10), state: { checked, seen: Object.fromEntries(kept), upcoming: upcoming.filter((e) => e.start > now) } };
}
