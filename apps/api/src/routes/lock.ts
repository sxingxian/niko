// /api/lock: the screen lock's settings and unlocking. Mounted inside the app router, after requireUser (which keeps
// every other route shut while this sign-in is locked).
import { and, eq, lt, or, isNull, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { generateAuthenticationOptions, verifyAuthenticationResponse } from '@simplewebauthn/server';
import { authAttempts, passkeys, sessions, users, webauthnChallenges } from '@niko/db';
import { LOCK_MINUTES, weakLockCode, type LockShowNew } from '@niko/shared';
import type { AppEnv } from '../env';
import { unb64 } from '../lib/crypto';
import { audit, endSession, tooMany } from '../lib/session';
import { verifyPassword } from '../lib/password';
import { hashLockCode, lockCodeOk, lockInfo, lockOf, MAX_LOCK_FAILS } from '../lock';

export const lock = new Hono<AppEnv>();

const passkeyCount = async (c: import('hono').Context<AppEnv>) =>
  (await c.get('db').select({ id: passkeys.id }).from(passkeys).where(and(eq(passkeys.userId, c.get('user').id), eq(passkeys.rpId, c.get('site').rpId)))).length;

lock.get('/', async (c) => c.json({ ...lockInfo(c.get('user')), locked: !!c.get('locked'), passkeys: await passkeyCount(c) }));

// Settings. A new code, or turning the lock off, needs the account password; the time and what new items show don't.
lock.put('/', async (c) => {
  const u = c.get('user'), db = c.get('db');
  const b = await c.req.json<{ password?: unknown; code?: unknown; on?: unknown; mins?: unknown; showNew?: unknown; passkey?: unknown }>().catch(() => ({} as Record<string, unknown>));
  const cur = (u.screenLock ?? {}) as Record<string, unknown>, now = lockOf(u);
  const code = typeof b.code === 'string' ? b.code.trim() : '';
  const wantsOff = b.on === false && !!now, needsPw = !!code || wantsOff;
  if (code && (!/^\d{6}$/.test(code) || weakLockCode(code))) return c.json({ error: /^\d{6}$/.test(code) ? 'That code is too easy to guess. Avoid one digit repeated or digits in a row.' : 'The code must be 6 digits.' }, 400);
  if (needsPw) {
    // Only wrong passwords count towards the limit.
    const key = 'lock-pw:' + u.id;
    if (await tooMany(c, key, 5, 15)) return c.json({ error: 'Too many tries. Wait 15 minutes and try again.' }, 429);
    if (typeof b.password !== 'string' || !(await verifyPassword(db, b.password, u.passwordHash ?? null))) {
      await audit(c, 'lock.password_failed', {}, u.id);
      return c.json({ error: u.passwordHash ? 'Your password is not correct.' : 'Set a password for your account first (Account → Change password).' }, 400);
    }
    await db.delete(authAttempts).where(eq(authAttempts.key, key));
  }
  if (b.on === true && !code && typeof cur.hash !== 'string') return c.json({ error: 'Choose a 6-digit code first.' }, 400);
  const next: Record<string, unknown> = { ...cur };
  if (code) { next.hash = await hashLockCode(c.env, db, u.id, code); next.setAt = new Date().toISOString(); }
  if (typeof b.on === 'boolean') next.on = b.on || !!code ? b.on : false;
  else if (code) next.on = true;
  if ((LOCK_MINUTES as readonly number[]).includes(Number(b.mins))) next.mins = Number(b.mins);
  if (b.showNew === 'off' || b.showNew === 'who' || b.showNew === 'full') next.showNew = b.showNew as LockShowNew;
  if (typeof b.passkey === 'boolean') next.passkey = b.passkey;
  if (wantsOff) { next.on = false; delete next.hash; delete next.setAt; }
  await db.update(users).set({ screenLock: next }).where(eq(users.id, u.id));
  // Starting (or changing) the lock begins counting from now, on this device and unlocked.
  await db.update(sessions).set({ seenAt: new Date(), locked: false, lockFails: 0 }).where(eq(sessions.id, c.get('sessionId')));
  const changed = Object.keys(b).filter((k) => k !== 'password' && k !== 'code').concat(code ? ['code'] : []);
  await audit(c, wantsOff ? 'lock.off' : code ? 'lock.code_set' : 'lock.changed', { changed }, u.id);
  return c.json({ ...lockInfo({ screenLock: next }), passkeys: await passkeyCount(c) });
});

/** "Lock now", the idle timer in the app, or "Niko, lock". */
// { idle: true } is the app's own timer: it locks only when no tab or window on this sign-in has reported use for
// about the lock's time, so a tab left in the background never locks the one being used.
lock.post('/now', async (c) => {
  const lk = lockOf(c.get('user'));
  if (!lk) return c.json({ error: 'The screen lock is off.' }, 400);
  if (c.get('locked')) return c.json({ ok: true, locked: true });
  const b = await c.req.json<{ idle?: unknown }>().catch(() => ({} as { idle?: unknown }));
  const where = b.idle === true
    ? and(eq(sessions.id, c.get('sessionId')), or(isNull(sessions.seenAt), lt(sessions.seenAt, new Date(Date.now() - Math.max(30_000, lk.mins * 60_000 - 30_000)))))
    : eq(sessions.id, c.get('sessionId'));
  const done = await c.get('db').update(sessions).set({ locked: true }).where(where).returning({ id: sessions.id });
  return c.json({ ok: true, locked: done.length > 0 });
});

/** The app says someone is using it (sent at most every half minute while they are). */
lock.post('/seen', async (c) => {
  if (lockOf(c.get('user')) && !c.get('locked')) {
    await c.get('db').update(sessions).set({ seenAt: new Date() })
      .where(and(eq(sessions.id, c.get('sessionId')), eq(sessions.locked, false), or(isNull(sessions.seenAt), lt(sessions.seenAt, new Date(Date.now() - 15_000)))));
  }
  return c.json({ ok: true });
});

const unlocked = async (c: import('hono').Context<AppEnv>, how: string) => {
  await c.get('db').update(sessions).set({ locked: false, lockFails: 0, seenAt: new Date() }).where(eq(sessions.id, c.get('sessionId')));
  await audit(c, 'lock.unlocked', { how }, c.get('user').id);
  return c.json({ ok: true, locked: false });
};

lock.post('/unlock', async (c) => {
  const u = c.get('user'), db = c.get('db'), lk = lockOf(u);
  if (!lk || !c.get('locked')) return c.json({ ok: true, locked: false });
  const b = await c.req.json<{ code?: unknown }>().catch(() => ({} as { code?: unknown }));
  const code = typeof b.code === 'string' ? b.code : '';
  if (await lockCodeOk(c.env, db, u.id, code, lk.hash)) return unlocked(c, 'code');
  const [row] = await db.update(sessions).set({ lockFails: sql`${sessions.lockFails} + 1` }).where(eq(sessions.id, c.get('sessionId'))).returning({ fails: sessions.lockFails });
  const fails = row?.fails ?? MAX_LOCK_FAILS;
  if (fails >= MAX_LOCK_FAILS) {
    await audit(c, 'lock.signed_out', { fails }, u.id);
    await endSession(c, 'app');
    return c.json({ error: 'Five wrong codes. This device is signed out; sign in again with your password or passkey.', signedOut: true }, 401);
  }
  return c.json({ error: 'Wrong code.', left: MAX_LOCK_FAILS - fails }, 400);
});

// Unlocking with one of this account's passkeys (when the person allowed it).
lock.post('/passkey/options', async (c) => {
  const u = c.get('user'), lk = lockOf(u), site = c.get('site');
  if (!lk?.passkey) return c.json({ error: 'Unlocking with a passkey is off.' }, 400);
  if (!c.get('locked')) return c.json({ error: 'Niko isn’t locked.' }, 400);
  const mine = await c.get('db').select({ id: passkeys.credentialId }).from(passkeys).where(and(eq(passkeys.userId, u.id), eq(passkeys.rpId, site.rpId)));
  if (!mine.length) return c.json({ error: 'No passkey is saved for this account here.' }, 400);
  const options = await generateAuthenticationOptions({ rpID: site.rpId, userVerification: 'required', allowCredentials: mine.map((m) => ({ id: m.id })) });
  const [row] = await c.get('db').insert(webauthnChallenges).values({ userId: u.id, challenge: options.challenge, rpId: site.rpId, kind: 'unlock', expiresAt: new Date(Date.now() + 5 * 60_000) }).returning();
  return c.json({ options, challengeId: row!.id });
});
lock.post('/passkey/verify', async (c) => {
  const u = c.get('user'), db = c.get('db'), lk = lockOf(u);
  if (!lk?.passkey) return c.json({ error: 'Unlocking with a passkey is off.' }, 400);
  if (await tooMany(c, 'lock-passkey:' + u.id, 20, 15)) return c.json({ error: 'Too many tries. Try again later.' }, 429);
  const b = await c.req.json<{ challengeId?: string; response?: any }>().catch(() => ({} as { challengeId?: string; response?: any }));
  const ch = b.challengeId ? (await db.select().from(webauthnChallenges).where(and(eq(webauthnChallenges.id, b.challengeId), eq(webauthnChallenges.userId, u.id), eq(webauthnChallenges.kind, 'unlock'))).limit(1))[0] : undefined;
  const cred = b.response?.id ? (await db.select().from(passkeys).where(and(eq(passkeys.credentialId, String(b.response.id)), eq(passkeys.userId, u.id))).limit(1))[0] : undefined;
  if (!ch || !cred || ch.expiresAt.getTime() < Date.now()) return c.json({ error: 'That passkey is not recognised.' }, 401);
  await db.delete(webauthnChallenges).where(eq(webauthnChallenges.id, ch.id));
  try {
    const result = await verifyAuthenticationResponse({
      response: b.response, expectedChallenge: ch.challenge, expectedOrigin: new URL(c.req.url).origin, expectedRPID: ch.rpId, requireUserVerification: true,
      credential: { id: cred.credentialId, publicKey: unb64(cred.publicKey) as Uint8Array<ArrayBuffer>, counter: cred.counter },
    });
    if (!result.verified) throw new Error('not verified');
    await db.update(passkeys).set({ counter: result.authenticationInfo.newCounter }).where(eq(passkeys.id, cred.id));
  } catch {
    return c.json({ error: 'That passkey could not be verified.' }, 401);
  }
  return unlocked(c, 'passkey');
});
