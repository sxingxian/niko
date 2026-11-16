import { and, eq, gt, isNull, lt, sql } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse } from '@simplewebauthn/server';
import { appSettings, invites, passkeys, passwordResets, sessions, signups, users, webauthnChallenges, type Invite } from '@niko/db';
import { addMonths, CODE_TRIES, CURRENCY, isCodeShape, isEmail, lengthLabel, normalizeCode, passwordProblem, plansOffered } from '@niko/shared';
import { emailCodeHash, inviteCodeHash, makeEmailCode, paymentSettings, payNow, setCustomer, syncCheckout, tellAdmins } from '../billing';
import { isMode, NOT_READY, stripe } from '../stripe';
import type { AppEnv } from '../env';
import { b64url, randomToken, safeEqual, sha256, unb64 } from '../lib/crypto';
import { hashPassword, verifyPassword } from '../lib/password';
import { clearThrottle, lockedMessage, recordFailure, throttleMinutes } from '../lib/throttle';
import { codeBlock, esc, sendEmail } from '../lib/email';
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
  const registration = await registrationMode(c);
  // With open registration, what a sign-up will pay (shown before they start).
  let signup: { priceCents: number; months: number; plans: { plan: string; cents: number }[]; testMode: boolean } | null = null;
  if (registration === 'open') {
    const s = await paymentSettings(c.get('db'));
    const now = await payNow(c.env, c.get('db'));
    if (s.openPay && s.onceCents && now.ready) signup = { priceCents: s.onceCents, months: s.months, plans: plansOffered(s), testMode: now.mode === 'test' };
  }
  return c.json({ registration, needsSetup: (await userCount(c)) === 0, rpId: c.get('site').rpId, signup });
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
  const db = c.get('db');
  const ip = clientIp(c);
  if (await tooMany(c, 'signin-ip:' + ip, 40, 15)) return c.json({ error: 'Too many attempts. Try again in 15 minutes.' }, 429);
  const locked = await throttleMinutes(db, b.email, ip);
  if (locked > 0) return c.json({ error: lockedMessage(locked) }, 429);
  const u = await findUser(db, b.email);
  const ok = await verifyPassword(db, b.password, u?.passwordHash ?? null);
  if (!u || !ok) {
    // Unknown emails are throttled exactly like real ones, so a lock says nothing about which accounts exist.
    const m = await recordFailure(db, b.email, ip);
    await audit(c, 'signin.failed', { email: b.email });
    return m > 0 ? c.json({ error: lockedMessage(m) }, 429) : c.json({ error: 'Email or password is not correct.' }, 401);
  }
  await clearThrottle(db, b.email, ip);
  if (u.status !== 'active') return c.json({ error: 'This account is not switched on yet. Ask your admin.' }, 403);
  await startSession(c, u.id, 'app');
  await audit(c, 'signin.ok', {}, u.id);
  return c.json({ ok: true });
});

auth.post('/sign-out', async (c) => {
  await endSession(c, 'app');
  return c.json({ ok: true });
});

// ---------------------------------------------------------------- open sign-up
// 1. name, email, password → the account is made switched off, and a 6-digit code is emailed.
// 2. the code confirms the email.  3. pay once (when the admin asks open sign-ups to pay).
// 4. wait for an admin to switch the account on; the paid months start then.
// The browser keeps its place with a random token in an HttpOnly cookie; only its hash is stored.
const SIGNUP_COOKIE = '__Host-niko_signup';
const INVITE_COOKIE = '__Host-niko_invite';
const COOKIE_DAYS = 7;
const setPass = (c: Ctx, name: string, value: string) => setCookie(c, name, value, { httpOnly: true, secure: true, sameSite: 'Lax', path: '/', maxAge: COOKIE_DAYS * 86400 });
type Ctx = Context<AppEnv>;

async function mySignup(c: Ctx) {
  const token = getCookie(c, SIGNUP_COOKIE);
  if (!token) return null;
  const db = c.get('db');
  const row = (await db.select({ su: signups, u: users }).from(signups).innerJoin(users, eq(users.id, signups.userId)).where(eq(signups.tokenHash, await sha256(token))).limit(1))[0];
  return row ?? null;
}
async function signupView(c: Ctx, row: Awaited<ReturnType<typeof mySignup>>) {
  if (!row) return { state: null };
  const s = await paymentSettings(c.get('db'));
  const now = await payNow(c.env, c.get('db'));
  return { state: row.su.state, email: row.u.email, name: row.u.name, priceCents: row.su.priceCents, months: row.su.months, paid: !!row.su.paidAt, plans: plansOffered(s), testMode: (row.su.paidAt ? row.su.stripeMode : now.mode) === 'test' };
}
async function sendSignupCode(c: Ctx, userId: string, email: string) {
  const code = makeEmailCode();
  await c.get('db').update(signups).set({ codeHash: await emailCodeHash(userId, code), codeExpiresAt: new Date(Date.now() + 15 * 60_000), codeTries: 0 }).where(eq(signups.userId, userId));
  await sendEmail(c.env, email, `Your Niko code: ${code}`, 'Confirm your email', 'Enter this code on the Niko sign-up page. It works for 15 minutes.', undefined, codeBlock('Email code', code));
}

auth.post('/sign-up', async (c) => {
  if ((await registrationMode(c)) !== 'open') return c.json({ error: 'Niko is invite only.' }, 403);
  const b = await c.req.json<{ email?: string; name?: string; password?: string }>();
  if (await tooMany(c, 'signup-ip:' + clientIp(c), 6, 60)) return c.json({ error: 'Too many attempts. Try again later.' }, 429);
  if (!isEmail(b.email)) return c.json({ error: 'Enter a valid email.' }, 400);
  const bad = passwordProblem(b.password, b.email);
  if (bad) return c.json({ error: bad }, 400);
  const db = c.get('db');
  const token = randomToken();
  const existing = await findUser(db, b.email);
  const pending = existing ? (await db.select().from(signups).where(eq(signups.userId, existing.id)).limit(1))[0] : undefined;
  // An unfinished sign-up (email not confirmed, or confirmed but not paid) may be started again; anything further may not.
  if (existing && !(pending && !pending.paidAt && pending.state !== 'waiting' && existing.status === 'off')) {
    // The email already has an account (or a paid sign-up). Answer as if it worked, so this can't be used to find out
    // which emails have accounts; the code that never arrives can't be guessed, and the owner gets a note.
    setPass(c, SIGNUP_COOKIE, token);
    await sendEmail(c.env, existing.email, 'Someone tried to sign up with your email', 'Already have a Niko account?',
      'Someone tried to create a Niko account with this email. If it was you, sign in instead, or reset your password from the sign-in page. If it wasn’t, you can ignore this.');
    return c.json({ ok: true, state: 'verify', email: b.email });
  }
  const s = await paymentSettings(db);
  const pays = s.openPay && (await payNow(c.env, db)).ready && !!s.onceCents;
  const price = { priceCents: pays ? s.onceCents : null, months: pays ? s.months : null };
  const hash = await hashPassword(db, b.password!);
  let userId: string;
  if (existing && pending) {
    // An unpaid sign-up started again: the email is confirmed again before anything else.
    userId = existing.id;
    await db.update(users).set({ name: (b.name ?? '').slice(0, 80), passwordHash: hash }).where(eq(users.id, userId));
    await db.update(signups).set({ tokenHash: await sha256(token), state: 'verify', ...price, checkoutId: null, createdAt: new Date() }).where(eq(signups.userId, userId));
  } else {
    const [u] = await db.insert(users).values({ email: b.email, name: (b.name ?? '').slice(0, 80), passwordHash: hash, status: 'off', lifetime: false }).returning();
    userId = u!.id;
    await db.insert(signups).values({ userId, tokenHash: await sha256(token), state: 'verify', ...price });
    await audit(c, 'signup.requested', { email: b.email }, userId);
  }
  await sendSignupCode(c, userId, b.email);
  setPass(c, SIGNUP_COOKIE, token);
  return c.json({ ok: true, state: 'verify', email: b.email });
});

auth.get('/sign-up/state', async (c) => c.json(await signupView(c, await mySignup(c))));

auth.post('/sign-up/verify', async (c) => {
  const b = await c.req.json<{ code?: string }>().catch(() => ({} as { code?: string }));
  if (await tooMany(c, 'signup-code-ip:' + clientIp(c), 30, 15)) return c.json({ error: 'Too many attempts. Try again later.' }, 429);
  const row = await mySignup(c);
  const wrong = 'That code isn’t right. Check the email, or send a new code.';
  if (!row || row.su.state !== 'verify' || !row.su.codeHash) return c.json({ error: wrong }, 400);
  if (!row.su.codeExpiresAt || row.su.codeExpiresAt < new Date() || row.su.codeTries >= CODE_TRIES) return c.json({ error: 'That code has expired. Send a new one.' }, 400);
  const db = c.get('db');
  const code = String(b.code ?? '').replace(/\D/g, '');
  if (code.length !== 6 || !safeEqual(await emailCodeHash(row.u.id, code), row.su.codeHash)) {
    await db.update(signups).set({ codeTries: sql`${signups.codeTries} + 1` }).where(eq(signups.userId, row.u.id));
    return c.json({ error: wrong }, 400);
  }
  const next = row.su.priceCents ? 'pay' : 'waiting';
  await db.update(signups).set({ state: next, codeHash: null, codeExpiresAt: null, codeTries: 0 }).where(eq(signups.userId, row.u.id));
  await audit(c, 'signup.email_confirmed', { email: row.u.email }, row.u.id);
  if (next === 'waiting') await tellAdmins(c.env, db, 'A sign-up is waiting for you', 'A sign-up is waiting', `${esc(row.u.name || row.u.email)} (${esc(row.u.email)}) confirmed their email. Switch their account on in Admin → Users when you’re ready.`);
  return c.json(await signupView(c, await mySignup(c)));
});

auth.post('/sign-up/resend', async (c) => {
  const row = await mySignup(c);
  if (!row || row.su.state !== 'verify') return c.json({ ok: true });
  if (await tooMany(c, 'signup-resend:' + row.u.id, 3, 15)) return c.json({ error: 'Wait a few minutes before asking for another code.' }, 429);
  await sendSignupCode(c, row.u.id, row.u.email);
  return c.json({ ok: true });
});

// "Wrong email?": an unpaid sign-up is removed, so the person can start again.
auth.post('/sign-up/restart', async (c) => {
  const row = await mySignup(c);
  if (row && !row.su.paidAt && row.u.status === 'off') await c.get('db').delete(users).where(eq(users.id, row.u.id));
  deleteCookie(c, SIGNUP_COOKIE, { path: '/', secure: true });
  return c.json({ ok: true });
});

auth.post('/sign-up/checkout', async (c) => {
  const row = await mySignup(c);
  if (!row || row.su.state !== 'pay' || row.su.paidAt || !row.su.priceCents) return c.json({ error: 'Confirm your email first.' }, 400);
  const now = await payNow(c.env, c.get('db'));
  if (!now.ready) return c.json({ error: NOT_READY }, 503);
  if (await tooMany(c, 'checkout:' + row.u.id, 10, 15)) return c.json({ error: 'Too many attempts. Try again later.' }, 429);
  const app = c.get('site').appUrl;
  const months = row.su.months ?? 12;
  const s = await stripe(now.keys, 'POST', '/checkout/sessions', {
    mode: 'payment', customer_email: row.u.email, customer_creation: 'always', client_reference_id: row.u.id,
    line_items: [{ quantity: 1, price_data: { currency: CURRENCY, unit_amount: row.su.priceCents, product_data: { name: `Niko · ${lengthLabel(months)} of access` } } }],
    metadata: { kind: 'signup', user_id: row.u.id }, payment_intent_data: { metadata: { kind: 'signup', user_id: row.u.id } },
    success_url: `${app}/sign-up?paid={CHECKOUT_SESSION_ID}`, cancel_url: `${app}/sign-up?cancelled=1`,
  });
  await c.get('db').update(signups).set({ checkoutId: s.id, stripeMode: now.mode }).where(eq(signups.userId, row.u.id));
  return c.json({ url: s.url });
});

auth.get('/sign-up/status', async (c) => {
  const row = await mySignup(c);
  if (!row) return c.json({ state: null });
  if (!row.su.paidAt) {
    for (const id of new Set([c.req.query('session'), row.su.checkoutId].filter((x): x is string => !!x))) {
      try { await syncCheckout(c.env, c.get('db'), id, isMode(row.su.stripeMode) ? row.su.stripeMode : (await payNow(c.env, c.get('db'))).mode); } catch { /* the webhook will still arrive */ }
    }
  }
  return c.json(await signupView(c, await mySignup(c)));
});

// ---------------------------------------------------------------- invites
// The link and a 6-character code come in one email. The right code sets a pass (a random value in an HttpOnly cookie,
// stored only as a hash) that the next steps on that browser need. Five wrong codes lock the invite until the admin
// sends a new code. Invites sent before codes existed have no code and skip this.
async function liveInvite(db: AppEnv['Variables']['db'], token: string) {
  const rows = await db.select().from(invites)
    .where(and(eq(invites.tokenHash, await sha256(token)), isNull(invites.usedAt), isNull(invites.revokedAt), gt(invites.expiresAt, new Date()))).limit(1);
  return rows[0];
}
async function passOk(c: Ctx, inv: Invite): Promise<boolean> {
  if (!inv.codeHash) return true;
  const v = getCookie(c, INVITE_COOKIE) ?? '';
  const i = v.indexOf('.');
  if (i < 0 || v.slice(0, i) !== inv.id || !inv.passHash) return false;
  return safeEqual(await sha256(v.slice(i + 1)), inv.passHash);
}
async function inviteView(c: Ctx, inv: Invite, ok: boolean) {
  const db = c.get('db');
  const by = inv.invitedBy ? (await db.select({ name: users.name }).from(users).where(eq(users.id, inv.invitedBy)).limit(1))[0] : undefined;
  const base = { invitedBy: by?.name || 'Your admin', needsCode: !ok, locked: !ok && inv.codeTries >= CODE_TRIES, access: inv.access };
  if (!ok) return base;
  const s = await paymentSettings(db);
  const now = await payNow(c.env, db);
  return { ...base, email: inv.email, priceCents: inv.priceCents, months: inv.months, paid: !!inv.paidAt, plans: plansOffered(s), payments: now.ready, testMode: (inv.paidAt ? inv.stripeMode : now.mode) === 'test' };
}
const GONE = 'This invite link has expired or was already used.';

auth.get('/invite/:token', async (c) => {
  const inv = await liveInvite(c.get('db'), c.req.param('token'));
  if (!inv) return c.json({ error: GONE }, 404);
  return c.json(await inviteView(c, inv, await passOk(c, inv)));
});

auth.post('/invite/:token/code', async (c) => {
  const b = await c.req.json<{ code?: string }>().catch(() => ({} as { code?: string }));
  if (await tooMany(c, 'invite-code-ip:' + clientIp(c), 30, 15)) return c.json({ error: 'Too many attempts. Try again later.' }, 429);
  const db = c.get('db');
  const inv = await liveInvite(db, c.req.param('token'));
  if (!inv) return c.json({ error: GONE }, 404);
  if (!inv.codeHash) return c.json(await inviteView(c, inv, true));
  const locked = () => c.json({ error: 'This invite is locked: the code was entered wrong 5 times. Ask the person who invited you for a new code. Nothing has been charged.', locked: true }, 423);
  if (inv.codeTries >= CODE_TRIES) return locked();
  const code = normalizeCode(b.code);
  if (!isCodeShape(code) || !safeEqual(await inviteCodeHash(inv.id, code), inv.codeHash)) {
    const r = await db.update(invites).set({ codeTries: sql`${invites.codeTries} + 1` }).where(and(eq(invites.id, inv.id), lt(invites.codeTries, CODE_TRIES))).returning({ tries: invites.codeTries });
    const left = CODE_TRIES - (r[0]?.tries ?? CODE_TRIES);
    if (left <= 0) { await audit(c, 'invite.locked', { email: inv.email }); return locked(); }
    return c.json({ error: `That code doesn’t match. ${left} ${left === 1 ? 'try' : 'tries'} left.`, left }, 400);
  }
  const pass = randomToken();
  await db.update(invites).set({ passHash: await sha256(pass), codeTries: 0 }).where(eq(invites.id, inv.id));
  setPass(c, INVITE_COOKIE, `${inv.id}.${pass}`);
  return c.json(await inviteView(c, { ...inv, codeTries: 0 }, true));
});

auth.post('/invite/:token/checkout', async (c) => {
  const db = c.get('db');
  const inv = await liveInvite(db, c.req.param('token'));
  if (!inv) return c.json({ error: GONE }, 404);
  if (!(await passOk(c, inv))) return c.json({ error: 'Enter your invite code first.' }, 403);
  if (inv.access !== 'paid' || !inv.priceCents) return c.json({ error: 'This invite has nothing to pay.' }, 400);
  if (inv.paidAt) return c.json({ error: 'This invite is already paid.' }, 409);
  const now = await payNow(c.env, db);
  if (!now.ready) return c.json({ error: NOT_READY }, 503);
  if (await tooMany(c, 'checkout:' + inv.id, 10, 15)) return c.json({ error: 'Too many attempts. Try again later.' }, 429);
  const app = c.get('site').appUrl;
  const token = encodeURIComponent(c.req.param('token'));
  const months = inv.months ?? 12;
  const s = await stripe(now.keys, 'POST', '/checkout/sessions', {
    mode: 'payment', customer_email: inv.email, customer_creation: 'always', client_reference_id: inv.id,
    line_items: [{ quantity: 1, price_data: { currency: CURRENCY, unit_amount: inv.priceCents, product_data: { name: `Niko · ${lengthLabel(months)} of access` } } }],
    metadata: { kind: 'invite', invite_id: inv.id }, payment_intent_data: { metadata: { kind: 'invite', invite_id: inv.id } },
    success_url: `${app}/invite?token=${token}&paid={CHECKOUT_SESSION_ID}`, cancel_url: `${app}/invite?token=${token}&cancelled=1`,
  });
  await db.update(invites).set({ checkoutId: s.id, stripeMode: now.mode }).where(eq(invites.id, inv.id));
  return c.json({ url: s.url });
});

auth.get('/invite/:token/status', async (c) => {
  const db = c.get('db');
  const inv = await liveInvite(db, c.req.param('token'));
  if (!inv) return c.json({ error: GONE }, 404);
  if (!(await passOk(c, inv))) return c.json({ error: 'Enter your invite code first.' }, 403);
  if (!inv.paidAt) {
    for (const id of new Set([c.req.query('session'), inv.checkoutId].filter((x): x is string => !!x))) {
      try { await syncCheckout(c.env, db, id, isMode(inv.stripeMode) ? inv.stripeMode : (await payNow(c.env, db)).mode); } catch { /* the webhook will still arrive */ }
    }
  }
  const now = (await db.select({ paidAt: invites.paidAt }).from(invites).where(eq(invites.id, inv.id)).limit(1))[0];
  return c.json({ paid: !!now?.paidAt });
});

auth.post('/invite/:token', async (c) => {
  const b = await c.req.json<{ name?: string; password?: string }>();
  if (await tooMany(c, 'invite-ip:' + clientIp(c), 20, 15)) return c.json({ error: 'Too many attempts. Try again later.' }, 429);
  const db = c.get('db');
  const inv = await liveInvite(db, c.req.param('token'));
  if (!inv) return c.json({ error: GONE }, 404);
  if (!(await passOk(c, inv))) return c.json({ error: 'Enter your invite code first.' }, 403);
  if (inv.access === 'paid' && !inv.paidAt) return c.json({ error: 'Pay first, then create your account.' }, 402);
  const bad = passwordProblem(b.password, inv.email);
  if (bad) return c.json({ error: bad }, 400);
  if (await findUser(db, inv.email)) return c.json({ error: 'An account with this email already exists. Sign in instead.' }, 409);
  // The used-at mark is claimed first, so the same invite can't make two accounts.
  const claimed = await db.update(invites).set({ usedAt: new Date() }).where(and(eq(invites.id, inv.id), isNull(invites.usedAt))).returning({ id: invites.id });
  if (!claimed.length) return c.json({ error: GONE }, 404);
  const months = inv.months ?? 12;
  const access = inv.access === 'life' ? { lifetime: true } : { lifetime: false, accessUntil: addMonths(new Date(), months), accessKind: inv.access === 'free' ? 'free' : 'paid' };
  const [u] = await db.insert(users).values({
    email: inv.email, name: (b.name ?? '').slice(0, 80), passwordHash: await hashPassword(c.get('db'), b.password!), role: inv.role === 'admin' ? 'admin' : 'member',
    ...access, ...(inv.access === 'paid' && isMode(inv.stripeMode) ? { paidMode: inv.stripeMode, ...setCustomer(inv.stripeMode, inv.stripeCustomerId) } : {}),
  }).returning();
  deleteCookie(c, INVITE_COOKIE, { path: '/', secure: true });
  await audit(c, 'invite.accepted', { email: inv.email, access: inv.access }, u!.id);
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
    // ES256 first: every phone and password manager supports it. Ed25519 is left out, as some Android
    // credential providers fail on requests that offer it rather than skipping it.
    supportedAlgorithmIDs: [-7, -257],
    timeout: 120_000,
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
