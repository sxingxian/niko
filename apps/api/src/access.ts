// Which AI options an account may use: the admin's default for everyone, with that account's own changes on top.
// Options that are off are hidden by the app and refused here, wherever a brain, voice, speech-in service or image
// service is used, tested or given a key. Admins always have every option.
import { eq } from 'drizzle-orm';
import { appSettings, type Db } from '@niko/db';
import { aiOff, cleanAiAccess } from '@niko/shared';

export const AI_DEFAULT_KEY = 'ai-access';
// The default is read at most every 30 seconds per Worker instance; a change shows everywhere within that time.
let cache: { at: number; v: Record<string, boolean> } | null = null;
export async function aiDefaults(db: Db, fresh = false): Promise<Record<string, boolean>> {
  if (!fresh && cache && Date.now() - cache.at < 30_000) return cache.v;
  const row = (await db.select().from(appSettings).where(eq(appSettings.key, AI_DEFAULT_KEY)).limit(1).catch(() => []))[0];
  const v = cleanAiAccess(row?.value);
  cache = { at: Date.now(), v };
  return v;
}
export const forgetAiDefaults = () => { cache = null; };
/** The options that are off for this account. */
export async function offFor(db: Db, user: { role: string; aiAccess?: unknown }): Promise<string[]> {
  return aiOff(await aiDefaults(db), cleanAiAccess(user.aiAccess), user.role === 'admin');
}
export const NOT_ON_ACCOUNT = 'That isn’t included in your plan.';
