// Services Niko skips for a while (a usage limit, a refused key, no answer), kept per account in users.engine under
// rest / voiceRest / hearRest / imageRest / mapRest.
// - Read fresh at the start of each request, so a request never acts on an old copy (a weather answer asks twice; two
//   requests can overlap).
// - Saved as that one field, merged with what is there now, so it never overwrites the rest of the settings (an order
//   changed meanwhile, another kind's skips).
// - A service that fails again soon after its skip ends is skipped for longer each time (1, 2, 4… minutes for a passing
//   fault, up to an hour; up to 6 hours for usage limits), so it isn't asked again on every request.
import { eq, sql } from 'drizzle-orm';
import { users } from '@niko/db';
import type { BrainRest } from '@niko/shared';

export const MIN = 60_000, HOUR = 60 * MIN;
export type RestKey = 'rest' | 'voiceRest' | 'hearRest' | 'imageRest' | 'mapRest';
type Rest = BrainRest & { n?: number };
type Fail = { why: BrainRest['why']; restMs: number };
/** How long an ended skip is remembered, so failing again soon after waits longer. */
const MEMORY = 6 * HOUR;
const CAP: Record<BrainRest['why'], number> = { down: HOUR, limit: 6 * HOUR, refused: 6 * HOUR };

/** The next skip for a service that failed: its own wait, doubled each time it fails again soon after the last one. */
export function nextRest(prev: Rest | undefined, f: Fail, now = Date.now()): Rest {
  const again = !!prev && prev.why === f.why && now - prev.until < MEMORY;
  const n = again ? Math.min((prev!.n ?? 1) + 1, 12) : 1;
  const ms = Math.max(f.restMs, Math.min(f.restMs * 2 ** (n - 1), CAP[f.why]));
  return { until: now + ms, why: f.why, n };
}

/**
 * How long to wait, from a provider's answer: until tomorrow's reset when a daily quota is used up (Google says "retry in
 * 30s" even then), else its Retry-After header, else a "retry in Ns" / retryDelay it wrote in the body. 0 when none.
 */
export function waitFrom(body: string, retryAfter: string | null, now = Date.now()): number {
  const t = body.toLowerCase();
  if (/per ?day|perday|per_day|daily (limit|quota)|requests per day|tokens per day/.test(t)) return untilDailyReset(/generativelanguage|googleapis|gemini/.test(t), now) - now;
  const clamp = (ms: number) => Math.min(Math.max(ms, 15_000), HOUR);
  const after = Number(retryAfter);
  if (retryAfter && Number.isFinite(after) && after > 0) return clamp(after * 1000);
  const m = /"retrydelay"\s*:\s*"(\d+(?:\.\d+)?)s"|retry (?:in|after) (\d+(?:\.\d+)?)\s*s/.exec(t);
  return m ? clamp(Number(m[1] ?? m[2]) * 1000) : 0;
}
/** Google's daily quotas reset at midnight Pacific time; others at midnight UTC. (30 s after, to be safe.) */
export function untilDailyReset(google: boolean, now = Date.now()): number {
  if (!google) { const d = new Date(now); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) + 30_000; }
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' })
    .formatToParts(new Date(now)).map((p) => [p.type, Number(p.value)]));
  const asUtc = Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour!, parts.minute!, parts.second!);
  const offset = asUtc - Math.floor(now / 1000) * 1000;
  return Date.UTC(parts.year!, parts.month! - 1, parts.day! + 1) - offset + 30_000;
}

async function freshRest(db: any, user: { id: string; engine?: unknown }, key: RestKey): Promise<Record<string, Rest>> {
  try {
    const rows = await db.select({ r: sql<unknown>`${users.engine} -> ${sql.raw(`'${key}'`)}` }).from(users).where(eq(users.id, user.id)).limit(1);
    if (rows?.length) return (rows[0].r && typeof rows[0].r === 'object' ? rows[0].r : {}) as Record<string, Rest>;
  } catch { /* fall back to the copy the request has */ }
  return { ...(((user.engine ?? {}) as Record<string, unknown>)[key] as Record<string, Rest> | undefined ?? {}) };
}

/** One request's view of which services to skip, and what it learnt, saved at the end as that one field. */
export class RestBook {
  /** Skips still running: entry → until when, and why. */
  readonly active: Record<string, Rest> = {};
  private changes = new Map<string, Rest | null>();
  private constructor(private db: any, private userId: string, private key: RestKey, private known: Record<string, Rest>) {
    const now = Date.now();
    for (const [k, v] of Object.entries(known)) if (v && v.until > now) this.active[k] = v;
  }
  static async open(db: any, user: { id: string; engine?: unknown }, key: RestKey): Promise<RestBook> {
    return new RestBook(db, user.id, key, await freshRest(db, user, key));
  }
  resting(entry: string) { return !!this.active[entry]; }
  /** Entries in order: those ready first, then those resting, soonest back first. */
  order<T>(list: T[], entryOf: (x: T) => string = (x) => x as unknown as string): T[] {
    return [...list.filter((x) => !this.active[entryOf(x)]), ...list.filter((x) => this.active[entryOf(x)]).sort((a, b) => this.active[entryOf(a)]!.until - this.active[entryOf(b)]!.until)];
  }
  failed(entry: string, f: Fail): Rest | null {
    if (f.restMs <= 0) return null;
    const r = nextRest(this.known[entry], f);
    this.active[entry] = r; this.known[entry] = r; this.changes.set(entry, r);
    return r;
  }
  worked(entry: string) {
    if (!this.known[entry]) return;
    delete this.active[entry]; delete this.known[entry]; this.changes.set(entry, null);
  }
  /** Merges what this request learnt into what is saved now, and saves only that field. */
  async save(): Promise<void> {
    if (!this.changes.size) return;
    const now = Date.now();
    const merged = await freshRest(this.db, { id: this.userId, engine: { [this.key]: this.known } }, this.key);
    for (const [k, v] of this.changes) { if (v) merged[k] = v; else delete merged[k]; }
    for (const [k, v] of Object.entries(merged)) if (!v || now - v.until > MEMORY) delete merged[k];
    const value = Object.assign(sql`jsonb_set(coalesce(${users.engine}, '{}'::jsonb), ${sql.raw(`'{${this.key}}'`)}, ${JSON.stringify(merged)}::jsonb)`, { restKey: this.key, rest: merged });
    await this.db.update(users).set({ engine: value }).where(eq(users.id, this.userId)).catch(() => undefined);
    this.changes.clear();
  }
}
