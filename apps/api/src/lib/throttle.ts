// Sign-in throttle per (email, IP), the same rule as sxingxian.com:
// after 5 consecutive failures the pair locks for 1 minute, doubling (1, 2, 4 ... 32) up to 60 minutes.
// While locked, even the right password is refused for that pair.
import { sql } from 'drizzle-orm';
import type { Db } from '@niko/db';

const LOCK_AFTER = 5;
const MAX_EXPONENT = 6;
const MAX_LOCK_MINUTES = 60;

export async function throttleMinutes(db: Db, email: string, ip: string): Promise<number> {
  const r = await db.execute(sql`
    select ceil(extract(epoch from (locked_until - now())) / 60) as lock_minutes
    from login_throttle where email = ${email.toLowerCase()} and ip = ${ip} and locked_until > now()`);
  return Number((r.rows[0] as { lock_minutes?: number } | undefined)?.lock_minutes ?? 0);
}

/** Records one failure and returns how many minutes the pair is now locked for (0 if not locked). */
export async function recordFailure(db: Db, email: string, ip: string): Promise<number> {
  const r = await db.execute(sql`
    insert into login_throttle (email, ip, failed, locked_until, updated_at)
    values (${email.toLowerCase()}, ${ip}, 1, null, now())
    on conflict (email, ip) do update set
      failed = login_throttle.failed + 1,
      locked_until = case when login_throttle.failed + 1 >= ${LOCK_AFTER}
        then now() + make_interval(mins => least(power(2, least(login_throttle.failed + 1 - ${LOCK_AFTER}, ${MAX_EXPONENT}))::int, ${MAX_LOCK_MINUTES}))
        else login_throttle.locked_until end,
      updated_at = now()
    returning case when locked_until > now() then ceil(extract(epoch from (locked_until - now())) / 60) else 0 end as lock_minutes`);
  return Number((r.rows[0] as { lock_minutes?: number } | undefined)?.lock_minutes ?? 0);
}

export async function clearThrottle(db: Db, email: string, ip: string): Promise<void> {
  await db.execute(sql`delete from login_throttle where email = ${email.toLowerCase()} and ip = ${ip}`);
}

export const lockedMessage = (minutes: number) => `Too many attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`;
