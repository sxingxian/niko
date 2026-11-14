// Password hashing runs inside Postgres (pgcrypto bcrypt), not in the Worker,
// so it does not use any of the Worker's CPU allowance.
import { sql } from 'drizzle-orm';
import type { Db } from '@niko/db';

const COST = 12;
// A real bcrypt hash of a random value: lets a missing account take as long to check as a real one.
const DUMMY = '$2a$12$0Z9E.JGj2EqdQRxSCpca3OOipYm0RNzAk0m71b5ue.qduhZBTGSfi';

export async function hashPassword(db: Db, password: string): Promise<string> {
  const r = await db.execute(sql`select crypt(${password}, gen_salt('bf', ${COST})) as h`);
  return String((r.rows[0] as { h: string }).h);
}

export async function verifyPassword(db: Db, password: string, stored: string | null): Promise<boolean> {
  const hash = stored && stored.startsWith('$2') ? stored : DUMMY;
  const r = await db.execute(sql`select (crypt(${password}, ${hash}) = ${hash}) as ok`);
  return !!stored && hash === stored && (r.rows[0] as { ok: boolean }).ok === true;
}
