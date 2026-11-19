// When the admin turns off Kept in Niko for what Niko learns, nothing Niko learned is stored in Niko for those people:
// their notes, playbooks, habits and the matches they taught for files are deleted from the Knowledge database, with the
// record of a copy in their own app (the copy itself stays there and stops being updated). From then on what Niko learns
// for them is kept on their device, or nowhere if that's off too. Answering never reads Niko's notes for them either.
import { eq, inArray } from 'drizzle-orm';
import { aiAllowed, aiOff, cleanAiAccess, cleanKnowledgePrefs } from '@niko/shared';
import { users, type Db } from '@niko/db';
import type { Env } from './env';
import { knowledgeDb } from './knowledge';

/** Whether this account may keep what Niko learns in Niko, from the default and the account's own changes. */
export const learnsInNiko = (defaults: Record<string, boolean>, u: { role: string; aiAccess?: unknown }) =>
  aiAllowed(aiOff(defaults, cleanAiAccess(u.aiAccess), u.role === 'admin'), 'kn:learn:niko');

/** Deletes what Niko learned that's kept in Niko for these accounts; returns how many notes went. The Knowledge database
 *  goes first, so if it fails the counts stay and the next sign-in tries again. */
export async function forgetLearnedInNiko(env: Pick<Env, 'KNOWLEDGE_DATABASE_URL'>, db: Db, ids: string[]): Promise<number> {
  if (!ids.length) return 0;
  const k = knowledgeDb(env);
  let n = 0;
  if (k) {
    const [r] = await k.q<{ n: number }>(`with d as (delete from kn_learned where account_id = any($1::uuid[]) returning 1) select count(*)::int as n from d`, [ids]);
    await k.q(`delete from kn_learned_copy where account_id = any($1::uuid[])`, [ids]);
    n = r?.n ?? 0;
  }
  const rows = await db.select({ id: users.id, knowledge: users.knowledge }).from(users).where(inArray(users.id, ids));
  for (const r of rows) {
    const p = cleanKnowledgePrefs(r.knowledge);
    if (p.notes || p.habits.length) await db.update(users).set({ knowledge: { ...p, notes: 0, habits: [] } as unknown as Record<string, unknown> }).where(eq(users.id, r.id));
  }
  return n;
}
