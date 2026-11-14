import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { appSettings, auditLog, invites, sessions, users } from '@niko/db';
import { isEmail } from '@niko/shared';
import type { AppEnv } from '../env';
import { newTotpSecret, randomToken, seal, sha256, totpUri, unseal, verifyTotp } from '../lib/crypto';
import { verifyPassword } from '../lib/password';
import { sendEmail } from '../lib/email';
import { audit, clientIp, endSession, requireAdmin, requireAdminPassword, startSession, tooMany } from '../lib/session';
import { findUser, registrationMode } from './auth';

export const admin = new Hono<AppEnv>();

// Step 1: password. The session it creates is useless until the second factor passes.
admin.post('/sign-in', async (c) => {
  const b = await c.req.json<{ email?: string; password?: string }>();
  if (!isEmail(b.email) || typeof b.password !== 'string') return c.json({ error: 'Enter your email and password.' }, 400);
  if (await tooMany(c, 'admin-signin:' + b.email.toLowerCase(), 5, 15) || await tooMany(c, 'admin-ip:' + clientIp(c), 20, 15)) {
    return c.json({ error: 'Too many attempts. Try again in 15 minutes.' }, 429);
  }
  const u = await findUser(c.get('db'), b.email);
  const ok = await verifyPassword(c.get('db'), b.password, u?.passwordHash ?? null);
  if (!u || !ok || u.role !== 'admin' || u.status !== 'active') {
    await audit(c, 'admin.signin.failed', { email: b.email });
    return c.json({ error: 'Email or password is not correct.' }, 401);
  }
  await startSession(c, u.id, 'admin', false);
  return c.json({ ok: true, step: u.totpEnabled ? 'verify' : 'setup' });
});

admin.post('/sign-out', async (c) => {
  await endSession(c, 'admin');
  return c.json({ ok: true });
});

// Step 2a: first time only, show the secret to add to an authenticator app.
admin.post('/totp/setup', requireAdminPassword, async (c) => {
  const u = c.get('user');
  if (u.totpEnabled) return c.json({ error: 'A second factor is already set up.' }, 409);
  const secret = newTotpSecret();
  await c.get('db').update(users).set({ totpSecretEnc: await seal(c.env.ENCRYPTION_KEY, secret) }).where(eq(users.id, u.id));
  return c.json({ secret, uri: totpUri(secret, u.email) });
});

// Step 2b: check a 6-digit code; marks the admin session as fully signed in.
admin.post('/totp/verify', requireAdminPassword, async (c) => {
  const b = await c.req.json<{ code?: string }>();
  const u = c.get('user');
  if (await tooMany(c, 'totp:' + u.id, 6, 10)) return c.json({ error: 'Too many attempts. Try again in 10 minutes.' }, 429);
  const secret = await unseal<string>(c.env.ENCRYPTION_KEY, u.totpSecretEnc);
  if (!secret || !(await verifyTotp(secret, String(b.code ?? '')))) return c.json({ error: 'That code is not correct.' }, 401);
  const db = c.get('db');
  if (!u.totpEnabled) await db.update(users).set({ totpEnabled: true }).where(eq(users.id, u.id));
  await db.update(sessions).set({ mfaOk: true }).where(eq(sessions.id, c.get('sessionId')));
  await audit(c, 'admin.signin.ok', {}, u.id);
  return c.json({ ok: true });
});

admin.get('/me', requireAdmin, (c) => {
  const u = c.get('user');
  return c.json({ name: u.name, email: u.email });
});

admin.get('/users', requireAdmin, async (c) => {
  const db = c.get('db');
  const list = await db.select({
    id: users.id, name: users.name, email: users.email, role: users.role, status: users.status, isOwner: users.isOwner, lastActiveAt: users.lastActiveAt,
  }).from(users).orderBy(users.createdAt);
  const pending = await db.select({ id: invites.id, email: invites.email, role: invites.role, expiresAt: invites.expiresAt })
    .from(invites).where(and(isNull(invites.usedAt), isNull(invites.revokedAt), gt(invites.expiresAt, new Date()))).orderBy(invites.createdAt);
  return c.json({ users: list, invites: pending, registration: await registrationMode(c) });
});

admin.post('/invites', requireAdmin, async (c) => {
  const b = await c.req.json<{ email?: string; role?: string }>();
  if (!isEmail(b.email)) return c.json({ error: 'Enter a valid email.' }, 400);
  const db = c.get('db');
  if (await findUser(db, b.email)) return c.json({ error: 'That person already has an account.' }, 409);
  const token = randomToken();
  // One live invite per email: older ones are revoked.
  await db.update(invites).set({ revokedAt: new Date() }).where(and(eq(sql`lower(${invites.email})`, b.email.toLowerCase()), isNull(invites.usedAt), isNull(invites.revokedAt)));
  await db.insert(invites).values({
    email: b.email, tokenHash: await sha256(token), role: b.role === 'admin' ? 'admin' : 'member', invitedBy: c.get('user').id,
    expiresAt: new Date(Date.now() + 7 * 86400_000),
  });
  const url = `${c.get('site').appUrl}/invite?token=${token}`;
  const sent = await sendEmail(c.env, b.email, 'You are invited to Niko', 'You’re invited to Niko',
    `${c.get('user').name || 'Your admin'} invited you. This link works once and expires in 7 days.`, { label: 'Accept invite', url });
  await audit(c, 'invite.sent', { email: b.email, emailed: sent }, c.get('user').id);
  return c.json({ ok: true, emailed: sent });
});

admin.delete('/invites/:id', requireAdmin, async (c) => {
  await c.get('db').update(invites).set({ revokedAt: new Date() }).where(eq(invites.id, c.req.param('id')));
  await audit(c, 'invite.revoked', { id: c.req.param('id') }, c.get('user').id);
  return c.json({ ok: true });
});

admin.patch('/users/:id', requireAdmin, async (c) => {
  const b = await c.req.json<{ status?: string }>();
  const db = c.get('db');
  const target = (await db.select().from(users).where(eq(users.id, c.req.param('id'))).limit(1))[0];
  if (!target) return c.json({ error: 'No such user.' }, 404);
  if (target.isOwner) return c.json({ error: 'The owner cannot be switched off.' }, 403);
  const status = b.status === 'active' ? 'active' : 'off';
  await db.update(users).set({ status }).where(eq(users.id, target.id));
  // Switching an account off signs it out everywhere.
  if (status === 'off') await db.delete(sessions).where(eq(sessions.userId, target.id));
  await audit(c, 'user.status', { target: target.email, status }, c.get('user').id);
  return c.json({ ok: true });
});

admin.put('/registration', requireAdmin, async (c) => {
  const b = await c.req.json<{ mode?: string }>();
  const mode = b.mode === 'open' ? 'open' : 'invite';
  await c.get('db').insert(appSettings).values({ key: 'registration', value: mode })
    .onConflictDoUpdate({ target: appSettings.key, set: { value: mode } });
  await audit(c, 'registration.mode', { mode }, c.get('user').id);
  return c.json({ ok: true, mode });
});

admin.get('/audit', requireAdmin, async (c) => {
  const rows = await c.get('db').select().from(auditLog).orderBy(desc(auditLog.createdAt)).limit(200);
  return c.json({ entries: rows });
});
