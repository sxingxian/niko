import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse } from '@simplewebauthn/server';
import { appSettings, invites, passkeys, passwordResets, sessions, users, webauthnChallenges } from '@niko/db';
import { isEmail, passwordProblem } from '@niko/shared';
import type { AppEnv } from '../env';
import { b64url, randomToken, safeEqual, sha256, unb64 } from '../lib/crypto';
import { hashPassword, verifyPassword } from '../lib/password';
import { esc, sendEmail } from '../lib/email';
import { audit, clientIp, endSession, requireUser, startSession, tooMany } from '../lib/session';

export const auth = new Hono<AppEnv>();

async function registrationMode(c: { get: (k: 'db') => AppEnv['Variables']['db'] }): Promise<'invite' | 'open'> {
  const rows = await c.get('db').select().from(appSettings).where(eq(appSettings.key, 'registration')).limit(1);
  return rows[0]?.value === 'open' ? 'open' : 'invite';
}
async function userCount(c: { get: (k: 'db') => AppEnv['Variables']['db'] }): Promise<number> {
  const rows = await c.get('db').select({ n: sql<number>`count(*)::int` }).from(users);
  return rows[0]?.n ?? 0;
}
const findUser = async (db: AppEnv['Variables']['db'], email: string) =>
  (await db.select().from(users).where(eq(sql`lower(${users.email})`, email.toLowerCase())).limit(1))[0];

auth.get('/config', async (c) => {
  return c.json({ registration: await registrationMode(c), needsSetup: (await userCount(c)) === 0, rpId: c.get('site').rpId });
});

// First-run setup: creates the owner. Works only while there are no users and needs the BOOTSTRAP_TOKEN secret.
auth.post('/setup', async (c) => {
  const b = await c.req.json<{ token?: string; email?: string; name?: string; password?: string }>();
  if (await tooMany(c, 'setup:' + clientIp(c), 10, 15)) return c.json({ error: 'Too many attempts. Try again later.' }, 429);
  if ((await userCount(c)) > 0) return c.json({ error: 'Niko is already set up.' }, 409);
  if (!c.env.BOOTSTRAP_TOKEN || !b.token || !safeEqual(b.token, c.env.BOOTSTRAP_TOKEN)) return c.json({ error: 'Setup token is not correct.' }, 403);
  if (!isEmail(b.email)) return c.json({ error: 'Enter a valid email.' }, 400);
  const bad = passwordProblem(b.password, b.email);
  if (bad) return c.json({ error: bad }, 400);
  const [u] = await c.get('db').insert(users).values({
    email: b.email, name: (b.name ?? '').slice(0, 80), passwordHash: await hashPassword(c.get('db'), b.password!), role: 'admin', isOwner: true,
  }).returning();
  await audit(c, 'setup.owner_created', { email: b.email }, u!.id);
  await startSession(c, u!.id, 'app');
  return c.json({ ok: true });
});

auth.post('/sign-in', async (c) => {
  const b = await c.req.json<{ email?: string; password?: string }>();
  if (!isEmail(b.email) || typeof b.password !== 'string') return c.json({ error: 'Enter your email and password.' }, 400);
  if (await tooMany(c, 'signin:' + b.email.toLowerCase(), 8, 15) || await tooMany(c, 'signin-ip:' + clientIp(c), 40, 15)) {
    return c.json({ error: 'Too many attempts. Try again in 15 minutes.' }, 429);
  }
  const u = await findUser(c.get('db'), b.email);
  const ok = await verifyPassword(c.get('db'), b.password, u?.passwordHash ?? null);
  if (!u || !ok) {
    await audit(c, 'signin.failed', { email: b.email });
    return c.json({ error: 'Email or password is not correct.' }, 401);
  }
  if (u.status !== 'active') return c.json({ error: 'This account is not switched on yet. Ask your admin.' }, 403);
  await startSession(c, u.id, 'app');
  await audit(c, 'signin.ok', {}, u.id);
  return c.json({ ok: true });
});

auth.post('/sign-out', async (c) => {
  await endSession(c, 'app');
  return c.json({ ok: true });
});

auth.post('/sign-up', async (c) => {
  if ((await registrationMode(c)) !== 'open') return c.json({ error: 'Niko is invite only.' }, 403);
  const b = await c.req.json<{ email?: string; name?: string; password?: string }>();
  if (await tooMany(c, 'signup-ip:' + clientIp(c), 6, 60)) return c.json({ error: 'Too many attempts. Try again later.' }, 429);
  if (!isEmail(b.email)) return c.json({ error: 'Enter a valid email.' }, 400);
  const bad = passwordProblem(b.password, b.email);
  if (bad) return c.json({ error: bad }, 400);
  if (!(await findUser(c.get('db'), b.email))) {
    // New accounts stay switched off until an admin enables them.
    const [u] = await c.get('db').insert(users).values({
      email: b.email, name: (b.name ?? '').slice(0, 80), passwordHash: await hashPassword(c.get('db'), b.password!), status: 'off',
    }).returning();
    await audit(c, 'signup.requested', { email: b.email }, u!.id);
  }
  // Same answer whether or not the email already exists.
  return c.json({ ok: true });
});

async function liveInvite(db: AppEnv['Variables']['db'], token: string) {
  const rows = await db.select().from(invites)
    .where(and(eq(invites.tokenHash, await sha256(token)), isNull(invites.usedAt), isNull(invites.revokedAt), gt(invites.expiresAt, new Date()))).limit(1);
  return rows[0];
}

auth.get('/invite/:token', async (c) => {
  const inv = await liveInvite(c.get('db'), c.req.param('token'));
  if (!inv) return c.json({ error: 'This invite link has expired or was already used.' }, 404);
  const by = inv.invitedBy ? (await c.get('db').select({ name: users.name }).from(users).where(eq(users.id, inv.invitedBy)).limit(1))[0] : undefined;
  return c.json({ email: inv.email, invitedBy: by?.name || 'Your admin' });
});

auth.post('/invite/:token', async (c) => {
  const b = await c.req.json<{ name?: string; password?: string }>();
  if (await tooMany(c, 'invite-ip:' + clientIp(c), 20, 15)) return c.json({ error: 'Too many attempts. Try again later.' }, 429);
  const db = c.get('db');
  const inv = await liveInvite(db, c.req.param('token'));
  if (!inv) return c.json({ error: 'This invite link has expired or was already used.' }, 404);
  const bad = passwordProblem(b.password, inv.email);
  if (bad) return c.json({ error: bad }, 400);
  if (await findUser(db, inv.email)) return c.json({ error: 'An account with this email already exists. Sign in instead.' }, 409);
  const [u] = await db.insert(users).values({
    email: inv.email, name: (b.name ?? '').slice(0, 80), passwordHash: await hashPassword(c.get('db'), b.password!), role: inv.role === 'admin' ? 'admin' : 'member',
  }).returning();
  await db.update(invites).set({ usedAt: new Date() }).where(eq(invites.id, inv.id));
  await audit(c, 'invite.accepted', { email: inv.email }, u!.id);
  await startSession(c, u!.id, 'app');
  return c.json({ ok: true });
});

auth.post('/forgot', async (c) => {
  const b = await c.req.json<{ email?: string }>();
  if (isEmail(b.email) && !(await tooMany(c, 'forgot:' + b.email.toLowerCase(), 3, 60))) {
    const u = await findUser(c.get('db'), b.email);
    if (u && u.status === 'active') {
      const token = randomToken();
      await c.get('db').insert(passwordResets).values({ userId: u.id, tokenHash: await sha256(token), expiresAt: new Date(Date.now() + 30 * 60_000) });
      const url = `${c.get('site').appUrl}/reset?token=${token}`;
      await sendEmail(c.env, u.email, 'Reset your Niko password', 'Reset your password', 'This link works once and expires in 30 minutes.', { label: 'Choose a new password', url });
    }
  }
  return c.json({ ok: true });
});

auth.post('/reset', async (c) => {
  const b = await c.req.json<{ token?: string; password?: string }>();
  const bad = passwordProblem(b.password);
  if (bad || !b.token) return c.json({ error: bad ?? 'This reset link is not valid.' }, 400);
  const db = c.get('db');
  const rows = await db.select().from(passwordResets)
    .where(and(eq(passwordResets.tokenHash, await sha256(b.token)), isNull(passwordResets.usedAt), gt(passwordResets.expiresAt, new Date()))).limit(1);
  const r = rows[0];
  if (!r) return c.json({ error: 'This reset link has expired or was already used.' }, 400);
  await db.update(users).set({ passwordHash: await hashPassword(c.get('db'), b.password!) }).where(eq(users.id, r.userId));
  await db.update(passwordResets).set({ usedAt: new Date() }).where(eq(passwordResets.id, r.id));
  // Signing out everywhere after a reset.
  await db.delete(sessions).where(eq(sessions.userId, r.userId));
  await audit(c, 'password.reset', {}, r.userId);
  return c.json({ ok: true });
});

// ---- Passkeys: sign-in only. They are added from Account settings after signing in with a password.
const origin = (c: { req: { url: string } }) => new URL(c.req.url).origin;

auth.post('/passkey/login/options', async (c) => {
  const site = c.get('site');
  const options = await generateAuthenticationOptions({ rpID: site.rpId, userVerification: 'preferred' });
  const [row] = await c.get('db').insert(webauthnChallenges).values({ challenge: options.challenge, rpId: site.rpId, kind: 'login', expiresAt: new Date(Date.now() + 5 * 60_000) }).returning();
  return c.json({ options, challengeId: row!.id });
});

auth.post('/passkey/login/verify', async (c) => {
  const b = await c.req.json<{ challengeId?: string; response?: any }>();
  const db = c.get('db');
  if (await tooMany(c, 'passkey-ip:' + clientIp(c), 30, 15)) return c.json({ error: 'Too many attempts. Try again later.' }, 429);
  const ch = b.challengeId ? (await db.select().from(webauthnChallenges).where(and(eq(webauthnChallenges.id, b.challengeId), eq(webauthnChallenges.kind, 'login'), gt(webauthnChallenges.expiresAt, new Date()))).limit(1))[0] : undefined;
  const cred = b.response?.id ? (await db.select().from(passkeys).where(eq(passkeys.credentialId, String(b.response.id))).limit(1))[0] : undefined;
  if (!ch || !cred) return c.json({ error: 'That passkey is not recognised.' }, 401);
  await db.delete(webauthnChallenges).where(eq(webauthnChallenges.id, ch.id));
  try {
    const result = await verifyAuthenticationResponse({
      response: b.response, expectedChallenge: ch.challenge, expectedOrigin: origin(c), expectedRPID: ch.rpId,
      credential: { id: cred.credentialId, publicKey: unb64(cred.publicKey) as Uint8Array<ArrayBuffer>, counter: cred.counter },
    });
    if (!result.verified) throw new Error('not verified');
    await db.update(passkeys).set({ counter: result.authenticationInfo.newCounter }).where(eq(passkeys.id, cred.id));
  } catch {
    return c.json({ error: 'That passkey could not be verified.' }, 401);
  }
  const u = (await db.select().from(users).where(eq(users.id, cred.userId)).limit(1))[0];
  if (!u || u.status !== 'active') return c.json({ error: 'This account is not switched on.' }, 403);
  await startSession(c, u.id, 'app');
  await audit(c, 'signin.passkey', {}, u.id);
  return c.json({ ok: true });
});

export const myPasskeys = new Hono<AppEnv>();
myPasskeys.use('*', requireUser);

myPasskeys.get('/', async (c) => {
  const rows = await c.get('db').select({ id: passkeys.id, label: passkeys.label, rpId: passkeys.rpId, createdAt: passkeys.createdAt }).from(passkeys).where(eq(passkeys.userId, c.get('user').id));
  return c.json({ passkeys: rows, rpId: c.get('site').rpId });
});

myPasskeys.post('/options', async (c) => {
  const u = c.get('user');
  const site = c.get('site');
  const existing = await c.get('db').select().from(passkeys).where(and(eq(passkeys.userId, u.id), eq(passkeys.rpId, site.rpId)));
  const options = await generateRegistrationOptions({
    rpName: 'Niko', rpID: site.rpId, userName: u.email, userDisplayName: u.name || u.email,
    userID: new TextEncoder().encode(u.id) as Uint8Array<ArrayBuffer>, attestationType: 'none',
    excludeCredentials: existing.map((p) => ({ id: p.credentialId })),
    authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
  });
  const [row] = await c.get('db').insert(webauthnChallenges).values({ userId: u.id, challenge: options.challenge, rpId: site.rpId, kind: 'register', expiresAt: new Date(Date.now() + 5 * 60_000) }).returning();
  return c.json({ options, challengeId: row!.id });
});

myPasskeys.post('/verify', async (c) => {
  const b = await c.req.json<{ challengeId?: string; response?: any }>();
  const u = c.get('user');
  const db = c.get('db');
  const ch = b.challengeId ? (await db.select().from(webauthnChallenges).where(and(eq(webauthnChallenges.id, b.challengeId), eq(webauthnChallenges.userId, u.id), eq(webauthnChallenges.kind, 'register'), gt(webauthnChallenges.expiresAt, new Date()))).limit(1))[0] : undefined;
  if (!ch) return c.json({ error: 'That request expired. Try again.' }, 400);
  await db.delete(webauthnChallenges).where(eq(webauthnChallenges.id, ch.id));
  try {
    const result = await verifyRegistrationResponse({ response: b.response, expectedChallenge: ch.challenge, expectedOrigin: origin(c), expectedRPID: ch.rpId });
    if (!result.verified || !result.registrationInfo) throw new Error('not verified');
    const cr = result.registrationInfo.credential;
    await db.insert(passkeys).values({
      userId: u.id, credentialId: cr.id, publicKey: btoa(String.fromCharCode(...cr.publicKey)), counter: cr.counter, rpId: ch.rpId,
      transports: (cr.transports ?? []).join(','), label: `Passkey for ${ch.rpId}`,
    });
  } catch {
    return c.json({ error: 'That passkey could not be saved.' }, 400);
  }
  await audit(c, 'passkey.added', { rpId: ch.rpId }, u.id);
  return c.json({ ok: true });
});

myPasskeys.delete('/:id', async (c) => {
  await c.get('db').delete(passkeys).where(and(eq(passkeys.id, c.req.param('id')), eq(passkeys.userId, c.get('user').id)));
  await audit(c, 'passkey.removed', {}, c.get('user').id);
  return c.json({ ok: true });
});

export { findUser, registrationMode, b64url, esc };
