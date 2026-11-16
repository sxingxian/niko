import { and, desc, eq, gt, isNotNull, isNull, lt, sql } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import { appSettings, auditLog, invites, recoveryCodes, sessions, signups, users } from '@niko/db';
import { accessState, accountLimits, addMonths, aiHasBrain, aiOff, cleanAccountLimits, cleanAiAccess, cleanGlanceLimits, cleanMonths, cleanPayments, glanceLimits, INVITE_DAYS, isEmail, lengthLabel, MAX_CENTS, MAX_MONTHS, MIN_CENTS, money, showCode, UNPAID_SIGNUP_DAYS, unlockPlan } from '@niko/shared';
import { dateLabel, forgetPayments, inviteCodeHash, makeInviteCode, paymentSettings, PAYMENTS_KEY, plansLine } from '../billing';
import { stripe, stripeReady } from '../stripe';
import { forgetGlanceDefaults, GLANCE_DEFAULT_KEY, glanceDefaults } from '../glance';
import { accountDefaults, ACCOUNT_LIMITS_KEY, forgetAccountDefaults } from '../limits';
import { AI_DEFAULT_KEY, aiDefaults, forgetAiDefaults } from '../access';
import type { AppEnv } from '../env';
import { hashRecoveryCode, makeRecoveryCodes, newTotpSecret, randomToken, seal, sha256, totpStep, totpUri, unseal } from '../lib/crypto';
import { verifyPassword } from '../lib/password';
import { clearThrottle, lockedMessage, recordFailure, throttleMinutes } from '../lib/throttle';
import { codeBlock, esc, rowsBlock, sendEmail } from '../lib/email';
import { audit, clientIp, endSession, requireAdmin, requireAdminPassword, startSession, tooMany } from '../lib/session';
import { findUser, registrationMode } from './auth';

export const admin = new Hono<AppEnv>();
type Ctx = Context<AppEnv>;

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
  const pay = await paymentSettings(db);
  const rows = await db.select({ u: users, su: signups }).from(users).leftJoin(signups, eq(signups.userId, users.id)).orderBy(users.createdAt);
  const list = rows.map(({ u, su }) => ({
    id: u.id, name: u.name, email: u.email, role: u.role, status: u.status, isOwner: u.isOwner, lastActiveAt: u.lastActiveAt,
    access: accessState(u, pay.graceDays),
    lifetime: u.lifetime, accessUntil: u.accessUntil, accessKind: u.accessKind, accessPaidUntil: u.accessPaidUntil, accessStartMonths: u.accessStartMonths,
    sub: u.subId ? { plan: u.subPlan, status: u.subStatus, periodEnd: u.subPeriodEnd, cancelAtEnd: u.subCancelAtEnd } : null,
    signup: su ? { state: su.state, paid: !!su.paidAt, priceCents: su.priceCents, months: su.months, removeAt: su.paidAt ? null : new Date(su.createdAt.getTime() + UNPAID_SIGNUP_DAYS * 86400_000) } : null,
  }));
  const pending = await db.select({
    id: invites.id, email: invites.email, role: invites.role, expiresAt: invites.expiresAt, access: invites.access, priceCents: invites.priceCents, months: invites.months,
    paidAt: invites.paidAt, codeTries: invites.codeTries, hasCode: sql<boolean>`${invites.codeHash} is not null`,
  }).from(invites).where(and(isNull(invites.usedAt), isNull(invites.revokedAt), gt(invites.expiresAt, new Date()))).orderBy(invites.createdAt);
  return c.json({ users: list, invites: pending, registration: await registrationMode(c), payments: pay, stripe: stripeReady(c.env) });
});

/** The invite email: the link, the code, and what they will pay (or that it is free). */
async function sendInviteEmail(c: Ctx, inv: { email: string; access: string; priceCents: number | null; months: number | null }, token: string, code: string) {
  const pay = await paymentSettings(c.get('db'));
  const by = esc(c.get('user').name || 'Your admin');
  const later = plansLine(pay);
  const months = inv.months ?? pay.months;
  const rows: [string, string][] = inv.access === 'paid' ? [[`Pay once for ${lengthLabel(months)} of Niko`, money(inv.priceCents)]]
    : inv.access === 'free' ? [[`Free for ${lengthLabel(months)}`, 'SGD 0.00']] : [];
  if (rows.length && later) rows.push(['After that, if you want to keep going', later]);
  const url = `${c.get('site').appUrl}/invite?token=${token}`;
  return sendEmail(c.env, inv.email, `${c.get('user').name || 'Your admin'} invited you to Niko`, `${c.get('user').name || 'Your admin'} invited you to Niko.`,
    `${by} invited you. Open your invite and enter this code when asked. The link works once and expires in 7 days.${inv.access === 'paid' ? ' You pay on Stripe’s secure page. Nothing renews by itself.' : ''}`,
    { label: 'Open your invite', url }, codeBlock('Your invite code', showCode(code)) + (rows.length ? rowsBlock(rows) : ''));
}

admin.post('/invites', requireAdmin, async (c) => {
  const b = await c.req.json<{ email?: string; role?: string; access?: string; priceCents?: number; months?: number }>();
  if (!isEmail(b.email)) return c.json({ error: 'Enter a valid email.' }, 400);
  const db = c.get('db');
  if (await findUser(db, b.email)) return c.json({ error: 'That person already has an account.' }, 409);
  const access = b.access === 'free' || b.access === 'life' ? b.access : 'paid';
  const pay = await paymentSettings(db);
  let priceCents: number | null = null;
  let months: number | null = null;
  if (access === 'paid') {
    if (!stripeReady(c.env)) return c.json({ error: 'Payments aren’t set up yet: add the Stripe keys to the server (see docs/DEPLOYMENT.md), or send a free or lifetime invite.' }, 400);
    priceCents = b.priceCents === undefined || b.priceCents === null ? pay.onceCents : (Number.isInteger(b.priceCents) && b.priceCents >= MIN_CENTS && b.priceCents <= MAX_CENTS ? b.priceCents : null);
    if (!priceCents) return c.json({ error: 'Enter a price of at least SGD 0.50, or set a default in Payments.' }, 400);
    months = cleanMonths(b.months ?? pay.months, pay.months);
  } else if (access === 'free') months = cleanMonths(b.months ?? 3, 3);
  const token = randomToken();
  const code = makeInviteCode();
  const id = crypto.randomUUID();
  // One live invite per email: older ones are revoked (a paid one is refunded first, below, by the admin).
  const older = await db.select({ id: invites.id }).from(invites).where(and(eq(sql`lower(${invites.email})`, b.email.toLowerCase()), isNull(invites.usedAt), isNull(invites.revokedAt), isNotNull(invites.paidAt)));
  if (older.length) return c.json({ error: 'This person has a paid invite already. Revoke it (which refunds them) before sending a new one.' }, 409);
  await db.update(invites).set({ revokedAt: new Date() }).where(and(eq(sql`lower(${invites.email})`, b.email.toLowerCase()), isNull(invites.usedAt), isNull(invites.revokedAt)));
  await db.insert(invites).values({
    id, email: b.email, tokenHash: await sha256(token), role: b.role === 'admin' ? 'admin' : 'member', invitedBy: c.get('user').id,
    expiresAt: new Date(Date.now() + INVITE_DAYS * 86400_000), access, priceCents, months, codeHash: await inviteCodeHash(id, code),
  });
  const sent = await sendInviteEmail(c, { email: b.email, access, priceCents, months }, token, code);
  await audit(c, 'invite.sent', { email: b.email, access, price: priceCents ? money(priceCents) : 'none', length: months ? lengthLabel(months) : access === 'life' ? 'lifetime' : '', emailed: sent }, c.get('user').id);
  // The code is shown to the admin once, so it can also be passed on another way.
  return c.json({ ok: true, emailed: sent, code, access, priceCents, months });
});

// A new code (and link) for an invite, e.g. after five wrong codes locked it. The old code and link stop working.
admin.post('/invites/:id/code', requireAdmin, async (c) => {
  const db = c.get('db');
  const inv = (await db.select().from(invites).where(and(eq(invites.id, c.req.param('id')), isNull(invites.usedAt), isNull(invites.revokedAt))).limit(1))[0];
  if (!inv) return c.json({ error: 'That invite is no longer open.' }, 404);
  const token = randomToken();
  const code = makeInviteCode();
  await db.update(invites).set({
    tokenHash: await sha256(token), codeHash: await inviteCodeHash(inv.id, code), codeTries: 0, passHash: null,
    expiresAt: inv.paidAt ? inv.expiresAt : new Date(Date.now() + INVITE_DAYS * 86400_000),
  }).where(eq(invites.id, inv.id));
  const sent = await sendInviteEmail(c, inv, token, code);
  await audit(c, 'invite.new_code', { email: inv.email, emailed: sent }, c.get('user').id);
  return c.json({ ok: true, emailed: sent, code });
});

// Revoking an invite that was paid for refunds it first; if the refund fails, the invite stays as it was.
admin.delete('/invites/:id', requireAdmin, async (c) => {
  const db = c.get('db');
  const inv = (await db.select().from(invites).where(eq(invites.id, c.req.param('id'))).limit(1))[0];
  if (!inv) return c.json({ error: 'No such invite.' }, 404);
  let refunded = false;
  if (inv.paidAt && !inv.usedAt && !inv.refundedAt && inv.paymentIntent) {
    try { await stripe(c.env, 'POST', '/refunds', { payment_intent: inv.paymentIntent, metadata: { invite_id: inv.id } }, `refund-invite-${inv.id}`); }
    catch (e) { return c.json({ error: `The refund didn’t go through, so the invite was kept: ${(e as Error).message}` }, 502); }
    refunded = true;
  }
  await db.update(invites).set({ revokedAt: new Date(), ...(refunded ? { refundedAt: new Date() } : {}) }).where(eq(invites.id, inv.id));
  await audit(c, refunded ? 'invite.revoked_refunded' : 'invite.revoked', { email: inv.email, ...(refunded ? { amount: money(inv.priceCents) } : {}) }, c.get('user').id);
  return c.json({ ok: true, refunded });
});

admin.patch('/users/:id', requireAdmin, async (c) => {
  const b = await c.req.json<{ status?: string }>();
  const db = c.get('db');
  const target = (await db.select().from(users).where(eq(users.id, c.req.param('id'))).limit(1))[0];
  if (!target) return c.json({ error: 'No such user.' }, 404);
  if (target.isOwner) return c.json({ error: 'The owner cannot be switched off.' }, 403);
  const status = b.status === 'active' ? 'active' : 'off';
  const su = (await db.select().from(signups).where(eq(signups.userId, target.id)).limit(1))[0];
  if (status === 'active' && su && su.state !== 'waiting') return c.json({ error: 'They haven’t finished signing up yet (email or payment). Unlock them instead if you want to let them in.' }, 400);
  const set: Partial<typeof users.$inferInsert> = { status };
  // A paid sign-up's months start now.
  if (status === 'active' && target.accessStartMonths > 0) Object.assign(set, { accessUntil: addMonths(new Date(), target.accessStartMonths), accessKind: 'paid', accessStartMonths: 0 });
  await db.update(users).set(set).where(eq(users.id, target.id));
  if (status === 'active' && su) {
    await db.delete(signups).where(eq(signups.userId, target.id));
    const until = set.accessUntil as Date | undefined;
    await sendEmail(c.env, target.email, 'Your Niko account is on', 'Your Niko account is on',
      until ? `You can sign in now. Your paid time runs until ${esc(dateLabel(until))}.` : 'You can sign in now.', { label: 'Open Niko', url: c.get('site').appUrl });
  }
  // Switching an account off signs it out everywhere.
  if (status === 'off') await db.delete(sessions).where(eq(sessions.userId, target.id));
  await audit(c, 'user.status', { target: target.email, status }, c.get('user').id);
  return c.json({ ok: true });
});

// Unlock: full access with no payment, for lifetime or a set number of months. A set time starts after any time the
// person already paid for; a plan they are on stops renewing (set time) or is cancelled now (lifetime). Nothing already
// paid is refunded. The account is switched on and they get an email.
admin.post('/users/:id/unlock', requireAdmin, async (c) => {
  const b = await c.req.json<{ kind?: string; months?: number }>().catch(() => ({} as { kind?: string; months?: number }));
  const db = c.get('db');
  const target = (await db.select().from(users).where(eq(users.id, c.req.param('id'))).limit(1))[0];
  if (!target) return c.json({ error: 'No such user.' }, 404);
  const su = (await db.select().from(signups).where(eq(signups.userId, target.id)).limit(1))[0];
  if (su && su.state !== 'waiting') return c.json({ error: 'They haven’t confirmed their email yet.' }, 400);
  if (b.kind === 'set' && !(Number(b.months) >= 1 && Number(b.months) <= MAX_MONTHS)) return c.json({ error: `Enter between 1 and ${MAX_MONTHS} months.` }, 400);
  const plan = unlockPlan(target, b.kind === 'set' ? { kind: 'set', months: Number(b.months) } : { kind: 'life' });
  if (plan.sub !== 'keep' && target.subId) {
    try {
      if (plan.sub === 'cancel-now') await stripe(c.env, 'DELETE', `/subscriptions/${target.subId}`);
      else await stripe(c.env, 'POST', `/subscriptions/${target.subId}`, { cancel_at_period_end: true });
    } catch (e) { return c.json({ error: `Stripe didn’t accept the change to their plan, so nothing was changed: ${(e as Error).message}` }, 502); }
  }
  await db.update(users).set(plan.lifetime
    ? { lifetime: true, status: 'active', accessStartMonths: 0, ...(plan.sub === 'cancel-now' ? { subStatus: 'canceled' } : {}) }
    : { accessUntil: plan.accessUntil, accessKind: 'unlocked', accessPaidUntil: plan.paidUntil, status: 'active', accessStartMonths: 0, ...(plan.sub === 'end-at-period' ? { subCancelAtEnd: true } : {}) },
  ).where(eq(users.id, target.id));
  if (su) await db.delete(signups).where(eq(signups.userId, target.id));
  await sendEmail(c.env, target.email, 'Your Niko account is unlocked', 'Your Niko account is unlocked',
    plan.lifetime ? 'Your admin unlocked Niko for you for good. There’s nothing to pay.' : `Your admin unlocked Niko for you until ${esc(dateLabel(plan.accessUntil!))}. There’s nothing to pay until then.`,
    { label: 'Open Niko', url: c.get('site').appUrl });
  await audit(c, 'user.unlocked', { target: target.email, kind: plan.lifetime ? 'lifetime' : 'set time', until: plan.accessUntil ? dateLabel(plan.accessUntil) : '', after: plan.paidUntil ? dateLabel(plan.paidUntil) : '' }, c.get('user').id);
  return c.json({ ok: true, lifetime: plan.lifetime, accessUntil: plan.accessUntil, paidUntil: plan.paidUntil });
});

// Only an unpaid sign-up can be removed here (they are also removed by themselves after 7 days).
admin.delete('/users/:id', requireAdmin, async (c) => {
  const db = c.get('db');
  const su = (await db.select().from(signups).where(eq(signups.userId, c.req.param('id'))).limit(1))[0];
  const target = (await db.select().from(users).where(eq(users.id, c.req.param('id'))).limit(1))[0];
  if (!su || !target || su.paidAt || target.status !== 'off') return c.json({ error: 'Only an unpaid sign-up can be removed.' }, 400);
  await db.delete(users).where(eq(users.id, target.id));
  await audit(c, 'signup.removed', { email: target.email }, c.get('user').id);
  return c.json({ ok: true });
});

// ---------------------------------------------------------------- payments (default prices)
admin.get('/payments', requireAdmin, async (c) => c.json({ settings: await paymentSettings(c.get('db'), true), stripe: stripeReady(c.env) }));
admin.put('/payments', requireAdmin, async (c) => {
  const b = await c.req.json<{ settings?: unknown }>().catch(() => ({} as { settings?: unknown }));
  const raw = (b.settings && typeof b.settings === 'object' ? b.settings : {}) as Record<string, any>;
  const s = cleanPayments(raw);
  if (raw.monthly?.on === false && raw.yearly?.on === false) return c.json({ error: 'Keep at least one plan on, or people can’t continue when their time ends.' }, 400);
  const db = c.get('db');
  await db.insert(appSettings).values({ key: PAYMENTS_KEY, value: s }).onConflictDoUpdate({ target: appSettings.key, set: { value: s } });
  forgetPayments();
  await audit(c, 'payments.default', { once: money(s.onceCents), length: lengthLabel(s.months), monthly: s.monthly.on ? money(s.monthly.cents) : 'off', yearly: s.yearly.on ? money(s.yearly.cents) : 'off', openPay: s.openPay, grace: s.graceDays, remind: s.remind }, c.get('user').id);
  return c.json({ ok: true, settings: s });
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
