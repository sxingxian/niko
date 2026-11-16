// Account limits set by the admin: a default for everyone (app_settings 'account-limits') and changes for any one
// account (users.account_limits). Today: how many calendar links an account may keep.
import { eq } from 'drizzle-orm';
import { appSettings, type Db } from '@niko/db';
import { accountLimits, cleanAccountLimits, type AccountLimits } from '@niko/shared';

export const ACCOUNT_LIMITS_KEY = 'account-limits';
let cache: { at: number; v: Partial<AccountLimits> } | null = null;
/** The admin's default, read at most every 30 seconds per Worker instance. */
export async function accountDefaults(db: Db, fresh = false): Promise<Partial<AccountLimits>> {
  if (!fresh && cache && Date.now() - cache.at < 30_000) return cache.v;
  const row = (await db.select().from(appSettings).where(eq(appSettings.key, ACCOUNT_LIMITS_KEY)).limit(1).catch(() => []))[0];
  cache = { at: Date.now(), v: cleanAccountLimits(row?.value) };
  return cache.v;
}
export const forgetAccountDefaults = () => { cache = null; };
export async function accountLimitsFor(db: Db, user: { accountLimits?: unknown }): Promise<AccountLimits> {
  return accountLimits(await accountDefaults(db), cleanAccountLimits(user.accountLimits));
}
