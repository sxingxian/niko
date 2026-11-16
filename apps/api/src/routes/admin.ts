import { and, desc, eq, gt, isNull, lt, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { appSettings, auditLog, invites, recoveryCodes, sessions, users } from '@niko/db';
import { accountLimits, aiHasBrain, aiOff, cleanAccountLimits, cleanAiAccess, cleanGlanceLimits, glanceLimits, isEmail } from '@niko/shared';
import { forgetGlanceDefaults, GLANCE_DEFAULT_KEY, glanceDefaults } from '../glance';
import { accountDefaults, ACCOUNT_LIMITS_KEY, forgetAccountDefaults } from '../limits';
import { AI_DEFAULT_KEY, aiDefaults, forgetAiDefaults } from '../access';
import type { AppEnv } from '../env';
import { hashRecoveryCode, makeRecoveryCodes, newTotpSecret, randomToken, seal, sha256, totpStep, totpUri, unseal } from '../lib/crypto';
import { verifyPassword } from '../lib/password';
import { clearThrottle, lockedMessage, recordFailure, throttleMinutes } from '../lib/throttle';
import { sendEmail } from '../lib/email';
import { audit, clientIp, endSession, requireAdmin, requireAdminPassword, startSession, tooMany } from '../lib/session';
import { findUser, registrationMode } from './auth';

export const admin = new Hono<AppEnv>();

// Step 1: password. The session it creates is useless until the second factor passes.
admin.post('/sign-in', async (c) => {
  const b = await c.req.json<{ email?: string; password?: string }>();
  if (!isEmail(b.email) || typeof b.password !== 'string') return c.json({ error: 'Enter your email and password.' }, 400);
  const db = c.get('db');
  const ip = clientIp(c);
  if (await tooMany(c, 'admin-ip:' + ip, 20, 15)) return c.json({ error: 'Too many attempts. Try again in 15 minutes.' }, 429);
  const locked = await throttleMinutes(db, b.email, ip);
  if (locked > 0) return c.json({ error: lockedMessage(locked) }, 429);
  const u = await findUser(db, b.email);
  const ok = await verifyPassword(db, b.password, u?.passwordHash ?? null);
  if (!u || !ok || u.role !== 'admin' || u.status !== 'active') {
    const m = await recordFailure(db, b.email, ip);
    await audit(c, 'admin.signin.failed', { email: b.email });
    return m > 0 ? c.json({ error: lockedMessage(m) }, 429) : c.json({ error: 'Email or password is not correct.' }, 401);
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

async function replaceRecoveryCodes(db: AppEnv['Variables']['db'], userId: string): Promise<string[]> {
  const codes = makeRecoveryCodes();
  await db.delete(recoveryCodes).where(eq(recoveryCodes.userId, userId));
  await db.insert(recoveryCodes).values(await Promise.all(codes.map(async (code) => ({ userId, codeHash: await hashRecoveryCode(code) }))));
  return codes;
}

// Step 2b: check a 6-digit code; marks the admin session as fully signed in.
admin.post('/totp/verify', requireAdminPassword, async (c) => {
  const b = await c.req.json<{ code?: string }>();
  const u = c.get('user');
  const db = c.get('db');
  const ip = clientIp(c);
  const locked = await throttleMinutes(db, u.email, ip);
  if (locked > 0) return c.json({ error: lockedMessage(locked) }, 429);
  const wrong = async () => {
    const m = await recordFailure(db, u.email, ip);
    return m > 0 ? c.json({ error: lockedMessage(m) }, 429) : c.json({ error: 'That code is not correct. Check your authenticator app and try again.' }, 401);
  };
  const secret = await unseal<string>(c.env.ENCRYPTION_KEY, u.totpSecretEnc);
  const step = secret ? await totpStep(secret, String(b.code ?? '')) : null;
  if (step === null) return wrong();
  // Each time step is accepted once, so a code that was seen or intercepted cannot be replayed.
  const fresh = await db.update(users).set({ totpLastStep: step }).where(and(eq(users.id, u.id), lt(users.totpLastStep, step))).returning({ id: users.id });
  if (fresh.length === 0) return wrong();
  let codes: string[] | undefined;
  if (!u.totpEnabled) {
    await db.update(users).set({ totpEnabled: true }).where(eq(users.id, u.id));
    codes = await replaceRecoveryCodes(db, u.id); // shown once, right now
  }
  await db.update(sessions).set({ mfaOk: true }).where(eq(sessions.id, c.get('sessionId')));
  await clearThrottle(db, u.email, ip);
  await audit(c, 'admin.signin.ok', {}, u.id);
  return c.json({ ok: true, recoveryCodes: codes });
});

// Step 2c: a single-use recovery code stands in for the authenticator app.
admin.post('/totp/recovery', requireAdminPassword, async (c) => {
  const b = await c.req.json<{ code?: string }>();
  const u = c.get('user');
  const db = c.get('db');
  const ip = clientIp(c);
  const locked = await throttleMinutes(db, u.email, ip);
  if (locked > 0) return c.json({ error: lockedMessage(locked) }, 429);
  const used = u.totpEnabled
    ? await db.update(recoveryCodes).set({ usedAt: new Date() })
        .where(and(eq(recoveryCodes.userId, u.id), eq(recoveryCodes.codeHash, await hashRecoveryCode(String(b.code ?? ''))), isNull(recoveryCodes.usedAt))).returning({ id: recoveryCodes.id })
    : [];
  if (used.length === 0) {
    const m = await recordFailure(db, u.email, ip);
    return m > 0 ? c.json({ error: lockedMessage(m) }, 429) : c.json({ error: 'That recovery code is not valid or was already used.' }, 401);
  }
  await db.update(sessions).set({ mfaOk: true }).where(eq(sessions.id, c.get('sessionId')));
  await clearThrottle(db, u.email, ip);
  const left = await db.select({ n: sql<number>`count(*)::int` }).from(recoveryCodes).where(and(eq(recoveryCodes.userId, u.id), isNull(recoveryCodes.usedAt)));
  await audit(c, 'admin.signin.recovery_code', { left: left[0]?.n ?? 0 }, u.id);
  return c.json({ ok: true, left: left[0]?.n ?? 0 });
});

// Replaces all recovery codes with ten new ones (shown once).
admin.post('/recovery-codes', requireAdmin, async (c) => {
  const u = c.get('user');
  const codes = await replaceRecoveryCodes(c.get('db'), u.id);
  await audit(c, 'admin.recovery_codes.replaced', {}, u.id);
  return c.json({ recoveryCodes: codes });
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

// ---------------------------------------------------------------- AI options (Engine and Voice screens)
// The default for everyone, and each account's changes to it. Options that are off are hidden from that account and
// refused by the server. At least one brain must stay on for every account, or Niko could not answer.
admin.get('/ai', requireAdmin, async (c) => {
  const db = c.get('db');
  const list = await db.select({ id: users.id, name: users.name, email: users.email, role: users.role, status: users.status, aiAccess: users.aiAccess }).from(users).orderBy(users.createdAt);
  return c.json({ defaults: await aiDefaults(db, true), users: list.map((u) => ({ ...u, aiAccess: cleanAiAccess(u.aiAccess) })) });
});
admin.put('/ai/default', requireAdmin, async (c) => {
  const b = await c.req.json<{ access?: unknown }>().catch(() => ({} as { access?: unknown }));
  const access = cleanAiAccess(b.access);
  // Only what is off needs keeping: anything not listed is on.
  const stored = Object.fromEntries(Object.entries(access).filter(([, v]) => v === false));
  const db = c.get('db');
  const members = await db.select({ email: users.email, role: users.role, aiAccess: users.aiAccess }).from(users);
  if (!aiHasBrain(aiOff(stored, {}))) return c.json({ error: 'At least one brain must stay on.' }, 400);
  const stuck = members.find((m) => m.role !== 'admin' && !aiHasBrain(aiOff(stored, cleanAiAccess(m.aiAccess))));
  if (stuck) return c.json({ error: `That would leave ${stuck.email} with no brain. Change their own settings first.` }, 400);
  const before = await aiDefaults(db, true);
  await db.insert(appSettings).values({ key: AI_DEFAULT_KEY, value: stored }).onConflictDoUpdate({ target: appSettings.key, set: { value: stored } });
  forgetAiDefaults();
  await audit(c, 'ai.default', { off: Object.keys(stored).join(', ') || 'none', changed: changedKeys(before, stored).join(', ') }, c.get('user').id);
  return c.json({ ok: true, defaults: stored });
});
admin.put('/ai/users/:id', requireAdmin, async (c) => {
  const b = await c.req.json<{ access?: unknown }>().catch(() => ({} as { access?: unknown }));
  const db = c.get('db');
  const target = (await db.select().from(users).where(eq(users.id, c.req.param('id'))).limit(1))[0];
  if (!target) return c.json({ error: 'No such user.' }, 404);
  const defaults = await aiDefaults(db, true);
  // A change that matches the default is not a change: only real differences are kept.
  const own = Object.fromEntries(Object.entries(cleanAiAccess(b.access)).filter(([k, v]) => v !== (defaults[k] ?? true)));
  if (!aiHasBrain(aiOff(defaults, own))) return c.json({ error: 'At least one brain must stay on.' }, 400);
  await db.update(users).set({ aiAccess: own }).where(eq(users.id, target.id));
  await audit(c, 'ai.user', { target: target.email, changes: Object.entries(own).map(([k, v]) => `${k} ${v ? 'on' : 'off'}`).join(', ') || 'follows the default' }, c.get('user').id);
  return c.json({ ok: true, access: own });
});
// ---------------------------------------------------------------- new items on Home
// Whether people can turn it on, and the most often each kind may be checked: a default for everyone, and changes for
// any one account. The server never reads a source more often than this, whatever a person chooses.
admin.get('/glance', requireAdmin, async (c) => {
  const db = c.get('db');
  const list = await db.select({ id: users.id, name: users.name, email: users.email, role: users.role, status: users.status, glanceLimits: users.glanceLimits }).from(users).orderBy(users.createdAt);
  return c.json({ defaults: glanceLimits(await glanceDefaults(db, true), {}), users: list.map((u) => ({ ...u, glanceLimits: cleanGlanceLimits(u.glanceLimits) })) });
});
admin.put('/glance/default', requireAdmin, async (c) => {
  const b = await c.req.json<{ limits?: unknown }>().catch(() => ({} as { limits?: unknown }));
  const limits = glanceLimits(cleanGlanceLimits(b.limits), {});
  const db = c.get('db');
  await db.insert(appSettings).values({ key: GLANCE_DEFAULT_KEY, value: limits }).onConflictDoUpdate({ target: appSettings.key, set: { value: limits } });
  forgetGlanceDefaults();
  await audit(c, 'glance.default', { allowed: limits.allowed, mail: limits.mail, chats: limits.chats, events: limits.events, notes: limits.notes }, c.get('user').id);
  return c.json({ ok: true, defaults: limits });
});
admin.put('/glance/users/:id', requireAdmin, async (c) => {
  const b = await c.req.json<{ limits?: unknown }>().catch(() => ({} as { limits?: unknown }));
  const db = c.get('db');
  const target = (await db.select().from(users).where(eq(users.id, c.req.param('id'))).limit(1))[0];
  if (!target) return c.json({ error: 'No such user.' }, 404);
  const defaults = glanceLimits(await glanceDefaults(db, true), {});
  // A change that matches the default is not a change: only real differences are kept.
  const own = Object.fromEntries(Object.entries(cleanGlanceLimits(b.limits)).filter(([k, v]) => v !== (defaults as unknown as Record<string, unknown>)[k]));
  await db.update(users).set({ glanceLimits: own }).where(eq(users.id, target.id));
  await audit(c, 'glance.user', { target: target.email, changes: Object.entries(own).map(([k, v]) => `${k} ${v}`).join(', ') || 'follows the default' }, c.get('user').id);
  return c.json({ ok: true, limits: own });
});

// ---------------------------------------------------------------- account limits (how many calendar links)
admin.get('/limits', requireAdmin, async (c) => {
  const db = c.get('db');
  const list = await db.select({ id: users.id, name: users.name, email: users.email, role: users.role, status: users.status, accountLimits: users.accountLimits }).from(users).orderBy(users.createdAt);
  return c.json({ defaults: accountLimits(await accountDefaults(db, true), {}), users: list.map((u) => ({ ...u, accountLimits: cleanAccountLimits(u.accountLimits) })) });
});
admin.put('/limits/default', requireAdmin, async (c) => {
  const b = await c.req.json<{ limits?: unknown }>().catch(() => ({} as { limits?: unknown }));
  const limits = accountLimits(cleanAccountLimits(b.limits), {});
  const db = c.get('db');
  await db.insert(appSettings).values({ key: ACCOUNT_LIMITS_KEY, value: limits }).onConflictDoUpdate({ target: appSettings.key, set: { value: limits } });
  forgetAccountDefaults();
  await audit(c, 'limits.default', { calendars: limits.calendars }, c.get('user').id);
  return c.json({ ok: true, defaults: limits });
});
admin.put('/limits/users/:id', requireAdmin, async (c) => {
  const b = await c.req.json<{ limits?: unknown }>().catch(() => ({} as { limits?: unknown }));
  const db = c.get('db');
  const target = (await db.select().from(users).where(eq(users.id, c.req.param('id'))).limit(1))[0];
  if (!target) return c.json({ error: 'No such user.' }, 404);
  const defaults = accountLimits(await accountDefaults(db, true), {});
  const own = Object.fromEntries(Object.entries(cleanAccountLimits(b.limits)).filter(([k, v]) => v !== (defaults as unknown as Record<string, unknown>)[k]));
  await db.update(users).set({ accountLimits: own }).where(eq(users.id, target.id));
  await audit(c, 'limits.user', { target: target.email, changes: Object.entries(own).map(([k, v]) => `${k} ${v}`).join(', ') || 'follows the default' }, c.get('user').id);
  return c.json({ ok: true, limits: own });
});

const changedKeys = (a: Record<string, boolean>, b: Record<string, boolean>) => [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => (a[k] ?? true) !== (b[k] ?? true));

admin.get('/audit', requireAdmin, async (c) => {
  const rows = await c.get('db').select().from(auditLog).orderBy(desc(auditLog.createdAt)).limit(200);
  return c.json({ entries: rows });
});
