// The monthly included amounts. Niko counts what its included services do (the admin's provided keys and the
// built-in Workers AI and OpenStreetMap), one number per person, month, kind and service, and never what was said.
// A person's own keys are counted too, for them to see, but never limited. Months run in UTC.
import { and, eq, sql } from 'drizzle-orm';
import { usageCounts, type Db } from '@niko/db';
import { includedEntry, type UsageKind } from '@niko/shared';
import { accountLimitsFor } from './limits';

export const monthOf = (d = new Date()) => d.toISOString().slice(0, 7);
/** When the counts start again: the first of next month, UTC. */
export function nextReset(d = new Date()): Date { return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)); }
export const resetText = (d = new Date()) => nextReset(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });

export async function countUse(db: Db, userId: string, kind: UsageKind, entry: string, n = 1): Promise<void> {
  if (!(n > 0)) return;
  await db.execute(sql`insert into usage_counts (user_id, month, kind, entry, n) values (${userId}, ${monthOf()}, ${kind}, ${entry.slice(0, 40)}, ${Math.round(n)})
    on conflict (user_id, month, kind, entry) do update set n = usage_counts.n + excluded.n`).catch((e) => console.warn('usage count failed', String(e).slice(0, 120)));
}

/** This month's counts for one person: per service, and totals per kind (included and their own). */
export async function monthUsage(db: Db, userId: string, month = monthOf()) {
  const rows = await db.select().from(usageCounts).where(and(eq(usageCounts.userId, userId), eq(usageCounts.month, month))).catch(() => []);
  const kinds = { brain: { included: 0, own: 0 }, voice: { included: 0, own: 0 }, hear: { included: 0, own: 0 }, image: { included: 0, own: 0 }, map: { included: 0, own: 0 } } as Record<UsageKind, { included: number; own: number }>;
  const entries: Record<string, number> = {};
  for (const r of rows) {
    const k = r.kind as UsageKind;
    if (!kinds[k]) continue;
    kinds[k][includedEntry(k, r.entry) ? 'included' : 'own'] += r.n;
    entries[`${k}|${r.entry}`] = r.n;
  }
  return { kinds, entries };
}

/** Included use this month for many people at once (the admin's Limits page). */
export async function includedByUser(db: Db, month = monthOf()): Promise<Record<string, Record<UsageKind, number>>> {
  const rows = await db.select().from(usageCounts).where(eq(usageCounts.month, month)).catch(() => []);
  const out: Record<string, Record<UsageKind, number>> = {};
  for (const r of rows) {
    const k = r.kind as UsageKind;
    if (!includedEntry(k, r.entry)) continue;
    (out[r.userId] ??= { brain: 0, voice: 0, hear: 0, image: 0, map: 0 })[k] += r.n;
  }
  return out;
}

/** The month's amount in the units counted (listening is limited in minutes and counted in seconds). */
export const limitUnits = (kind: UsageKind, limit: number) => (kind === 'hear' ? limit * 60 : limit);

export interface Gate { limit: number; blocked: (entry: string) => boolean; count: (entry: string, n?: number) => Promise<void>; anyBlocked: () => boolean; message: string }
/** For one request: whether an included service may still be used this month, and counting what was used. */
export async function usageGate(db: Db, user: { id: string; accountLimits?: unknown }, kind: UsageKind): Promise<Gate> {
  const limit = (await accountLimitsFor(db, user))[kind];
  let used = 0, hit = false;
  if (limit > 0) {
    const r = await db.select().from(usageCounts).where(and(eq(usageCounts.userId, user.id), eq(usageCounts.month, monthOf()), eq(usageCounts.kind, kind))).catch(() => []);
    used = r.filter((x) => includedEntry(kind, x.entry)).reduce((a, x) => a + x.n, 0);
  }
  const cap = limitUnits(kind, limit);
  const unit = { brain: 'answers', voice: 'spoken replies', hear: 'minutes of listening', image: 'pictures', map: 'map searches' }[kind];
  return {
    limit,
    blocked: (entry) => { const b = limit > 0 && includedEntry(kind, entry) && used >= cap; if (b) hit = true; return b; },
    count: async (entry, n = 1) => { if (includedEntry(kind, entry)) used += n; await countUse(db, user.id, kind, entry, n); },
    anyBlocked: () => hit,
    message: `You’ve used this month’s ${limit.toLocaleString('en')} included ${unit}. They come back on ${resetText()}${kind === 'voice' || kind === 'hear' ? '' : '; add your own key to keep going now'}.`,
  };
}
