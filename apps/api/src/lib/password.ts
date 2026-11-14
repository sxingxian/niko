// Password storage, the same scheme as the sxingxian.com admin accounts:
// the Worker pre-hashes with SHA-256 (domain-separated, NFKC-normalised) and Neon stores bcrypt(prehash)
// at cost 12 via pgcrypto. The plaintext never leaves the Worker, bcrypt's 72-byte limit cannot truncate
// a long passphrase, and the expensive hashing runs on the database instead of the Worker's CPU budget.
import { sql } from 'drizzle-orm';
import type { Db } from '@niko/db';

const COST = 12;
// A real bcrypt hash of a random value: an unknown email takes as long to check as a real one.
const DUMMY = '$2a$12$0Z9E.JGj2EqdQRxSCpca3OOipYm0RNzAk0m71b5ue.qduhZBTGSfi';

/** What is sent to bcrypt: base64(SHA-256("niko/password/v1\0" + NFKC(password))). 44 characters. */
export async function prehashPassword(password: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`niko/password/v1\u0000${password.normalize('NFKC')}`));
  let s = '';
  for (const x of new Uint8Array(digest)) s += String.fromCharCode(x);
  return btoa(s);
}

export async function hashPassword(db: Db, password: string): Promise<string> {
  const pre = await prehashPassword(password);
  const r = await db.execute(sql`select crypt(${pre}, gen_salt('bf', ${COST})) as h`);
  return String((r.rows[0] as { h: string }).h);
}

export async function verifyPassword(db: Db, password: string, stored: string | null): Promise<boolean> {
  const pre = await prehashPassword(password);
  const hash = stored ?? DUMMY;
  const r = await db.execute(sql`select (crypt(${pre}, ${hash}) = ${hash}) as ok`);
  return stored !== null && (r.rows[0] as { ok: boolean }).ok === true;
}
