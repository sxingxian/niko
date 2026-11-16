// Payments end to end, through the real Worker routes against a real (temporary, local) PostgreSQL with all migrations.
// Stripe and Resend are stood in for; webhooks are signed exactly as Stripe signs them.
// Needs PostgreSQL's initdb and pg_ctl (installed on GitHub's Ubuntu runners). Without them the test is skipped.
import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import worker from '../apps/api/src/index.ts';
import { maybeDaily } from '../apps/api/src/billing.ts';
import { createDb } from '@niko/db';
import { closePools } from './db-node.mjs';

// ---------------------------------------------------------------- a temporary PostgreSQL
function pgBin() {
  if (process.env.PG_BIN && existsSync(join(process.env.PG_BIN, 'initdb'))) return process.env.PG_BIN;
  const root = '/usr/lib/postgresql';
  if (!existsSync(root)) return null;
  for (const v of readdirSync(root).sort((a, b) => Number(b) - Number(a))) if (existsSync(join(root, v, 'bin', 'initdb'))) return join(root, v, 'bin');
  return null;
}
const bin = pgBin();
if (!bin) { console.log('SKIP payments test: PostgreSQL (initdb) is not installed here'); process.exit(0); }
const asRoot = process.getuid?.() === 0;
const dir = mkdtempSync(join(tmpdir(), 'niko-pg-'));
if (asRoot) execFileSync('chown', ['-R', 'postgres', dir]);
const run = (tool, args) => execFileSync(asRoot ? 'runuser' : join(bin, tool), asRoot ? ['-u', 'postgres', '--', join(bin, tool), ...args] : args, { stdio: 'pipe' });
const port = 20000 + Math.floor(Math.random() * 20000);
run('initdb', ['-D', join(dir, 'data'), '-A', 'trust', '-U', 'niko', '--no-sync']);
run('pg_ctl', ['-D', join(dir, 'data'), '-o', `-p ${port} -k ${dir} -c listen_addresses=127.0.0.1 -c fsync=off`, '-w', '-l', join(dir, 'log'), 'start']);
const url = `postgresql://niko@127.0.0.1:${port}/postgres`;
const sqlc = new pg.Client({ connectionString: url });
await sqlc.connect();
const q = async (text, params) => (await sqlc.query(text, params)).rows;
const migDir = new URL('../packages/db/migrations/', import.meta.url).pathname;
for (const f of readdirSync(migDir).filter((f) => f.endsWith('.sql')).sort()) await sqlc.query(readFileSync(join(migDir, f), 'utf8'));

// ---------------------------------------------------------------- stand-ins for Stripe and Resend
const emails = [];
const stripeCalls = [];
const sessions = new Map();
const subs = new Map();
const endpoints = new Map();
const made = {};
let seq = 0;
const unflat = (params) => {
  const out = {};
  for (const [k, v] of params) {
    const m = k.match(/^metadata\[(.+)\]$/); if (m) (out.metadata ??= {})[m[1]] = v;
    const sm = k.match(/^subscription_data\[metadata\]\[(.+)\]$/); if (sm) (out.subMeta ??= {})[sm[1]] = v;
  }
  return out;
};
globalThis.fetch = async (input, init = {}) => {
  // Like Cloudflare Workers: redirect must be 'follow' or 'manual'.
  if (init.redirect && !['follow', 'manual'].includes(init.redirect)) throw new TypeError(`Invalid redirect value, must be one of "follow" or "manual"`);
  const u = new URL(String(input));
  if (u.hostname === 'api.resend.com') { const b = JSON.parse(init.body); emails.push({ to: b.to[0], subject: b.subject, html: b.html }); return Response.json({ id: 'em_' + emails.length }); }
  if (u.hostname !== 'api.stripe.com') throw new Error('unexpected fetch ' + u);
  const method = init.method ?? 'GET';
  const params = new URLSearchParams(method === 'GET' ? u.search.slice(1) : init.body ?? '');
  const path = u.pathname.replace(/^\/v1/, '');
  const call = { method, path, p: Object.fromEntries(params), auth: init.headers?.authorization };
  stripeCalls.push(call);
  assert.ok(['Bearer sk_test_niko', 'Bearer sk_live_niko'].includes(call.auth), 'only the configured keys are used');
  call.mode = call.auth.includes('sk_live_') ? 'live' : 'test';
  if (method === 'POST' && path === '/checkout/sessions') {
    const id = `cs_${call.mode}_${++seq}`;
    const { metadata, subMeta } = unflat(params);
    const s = { id, url: `https://checkout.stripe.com/c/pay/${id}`, mode: call.p.mode, metadata, subMeta, amount_total: Number(call.p['line_items[0][price_data][unit_amount]']), currency: call.p['line_items[0][price_data][currency]'], payment_status: 'unpaid', status: 'open' };
    sessions.set(id, s);
    return Response.json(s);
  }
  let m;
  if (method === 'GET' && (m = path.match(/^\/checkout\/sessions\/(cs_[\w]+)$/))) return sessions.has(m[1]) ? Response.json(sessions.get(m[1])) : Response.json({ error: { message: 'No such checkout session' } }, { status: 404 });
  if (method === 'POST' && path === '/refunds') return Response.json({ id: 're_' + seq, status: 'succeeded' });
  if ((m = path.match(/^\/subscriptions\/(sub_\w+)$/))) {
    const sub = subs.get(m[1]);
    if (!sub) return Response.json({ error: { message: 'No such subscription' } }, { status: 404 });
    if (method === 'POST') sub.cancel_at_period_end = call.p.cancel_at_period_end === 'true';
    if (method === 'DELETE') sub.status = 'canceled';
    return Response.json(sub);
  }
  if (method === 'POST' && path === '/billing_portal/sessions') return Response.json({ url: 'https://billing.stripe.com/p/session/test' });
  if (method === 'GET' && path === '/account') return Response.json({ id: 'acct_1', charges_enabled: call.mode === 'test', business_profile: { name: 'Midnight Poetry' } });
  if (method === 'GET' && path === '/webhook_endpoints') return Response.json({ data: [...endpoints.values()].filter((e) => e.mode === call.mode) });
  if (method === 'DELETE' && (m = path.match(/^\/webhook_endpoints\/(we_\w+)$/))) { endpoints.delete(m[1]); return Response.json({ id: m[1], deleted: true }); }
  if (method === 'POST' && path === '/webhook_endpoints') {
    const id = `we_${call.mode}_${++seq}`;
    const secret = `whsec_made_${call.mode}_${seq}`;
    made[call.mode] = secret;
    endpoints.set(id, { id, url: call.p.url, mode: call.mode, metadata: { niko: call.p['metadata[niko]'] }, events: Object.entries(call.p).filter(([k]) => k.startsWith('enabled_events')).map(([, v]) => v) });
    return Response.json({ id, secret, url: call.p.url });
  }
  if (method === 'POST' && path === '/billing_portal/configurations') return Response.json({ id: `bpc_${call.mode}` });
  if (method === 'POST' && path === '/products') return Response.json({ id: `prod_${call.mode}_${call.p['metadata[niko]']}` });
  throw new Error(`unexpected Stripe call ${method} ${path}`);
};

// ---------------------------------------------------------------- the Worker, a browser, and Stripe's webhook
const env = {
  DATABASE_URL: url, ENCRYPTION_KEY: randomBytes(32).toString('base64'), BOOTSTRAP_TOKEN: 'boot-' + randomBytes(12).toString('hex'),
  RESEND_API_KEY: 're_test', EMAIL_FROM: 'Niko <niko-noreply@app.midnightpoetry.studio>', AI_MODEL: '@cf/x',
  // Only the secret keys are set by hand; Connect has Niko make the webhooks (and their signing secrets) in Stripe.
  STRIPE_TEST_SECRET_KEY: 'sk_test_niko', STRIPE_LIVE_SECRET_KEY: 'sk_live_niko',
  ASSETS: { fetch: async () => new Response('page') }, AI: { run: async () => ({ response: 'ok' }) },
};
const waits = [];
const ctx = { waitUntil: (p) => waits.push(p), passThroughOnException() {} };
const ORIGIN = 'https://niko.test';
class Browser {
  constructor() { this.jar = new Map(); }
  async call(method, path, body) {
    const headers = { origin: ORIGIN };
    if (this.jar.size) headers.cookie = [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await worker.fetch(new Request(ORIGIN + '/api' + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env, ctx);
    for (const sc of res.headers.getSetCookie()) {
      const [pair, ...attrs] = sc.split(';');
      const i = pair.indexOf('=');
      const k = pair.slice(0, i).trim(), v = pair.slice(i + 1).trim();
      if (!v || attrs.some((a) => /max-age=0\b/i.test(a.trim()) || /expires=thu, 01 jan 1970/i.test(a.trim()))) this.jar.delete(k); else this.jar.set(k, v);
    }
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data };
  }
  get(p) { return this.call('GET', p); }
  post(p, b = {}) { return this.call('POST', p, b); }
  put(p, b) { return this.call('PUT', p, b); }
  patch(p, b) { return this.call('PATCH', p, b); }
  del(p) { return this.call('DELETE', p); }
}
let evt = 0;
async function webhook(type, object, { secret = made.test, id, livemode } = {}) {
  const raw = JSON.stringify({ id: id ?? `evt_${++evt}`, type, livemode: livemode ?? secret === made.live, data: { object } });
  const t = Math.floor(Date.now() / 1000);
  const sig = createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex');
  const res = await worker.fetch(new Request(ORIGIN + '/api/hooks/stripe', { method: 'POST', headers: { 'stripe-signature': `t=${t},v1=${sig}`, 'content-type': 'application/json' }, body: raw }), env, ctx);
  return res.status;
}
const lastEmail = (to) => [...emails].reverse().find((e) => e.to === to);
const inviteCode = (html) => html.match(/letter-spacing:\.3em">([A-Z0-9]{3}) ([A-Z0-9]{3})</).slice(1).join('');
const inviteToken = (html) => html.match(/\/invite\?token=([\w-]+)/)[1];
const emailCode = (html) => html.match(/letter-spacing:\.3em">(\d{6})</)[1];
const user = async (email) => (await q('select * from users where lower(email) = lower($1)', [email]))[0];
const days = (a, b) => Math.round((new Date(a) - new Date(b)) / 86400_000);
const monthsLater = (n, from = new Date()) => { const d = new Date(from); const day = d.getUTCDate(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + n); d.setUTCDate(Math.min(day, new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate())); return d; };
const sameDay = (a, b) => assert.equal(new Date(a).toISOString().slice(0, 10), new Date(b).toISOString().slice(0, 10));

let pass = 0;
const ok = async (name, fn) => { try { await fn(); pass++; console.log('PASS', name); } catch (e) { console.log('FAIL', name, e?.stack ?? e?.message); process.exitCode = 1; } };
const PW = 'correct horse battery staple';

// ---------------------------------------------------------------- the owner and an admin session
const owner = new Browser();
const admin = new Browser();
let ownerId;
await ok('first owner is set up; existing accounts never need to pay', async () => {
  const r = await owner.post('/auth/setup', { token: env.BOOTSTRAP_TOKEN, email: 'alex@example.com', name: 'Alex Tan', password: PW });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  ownerId = (await user('alex@example.com')).id;
  const token = randomBytes(24).toString('hex');
  await q(`insert into sessions (user_id, token_hash, kind, mfa_ok, expires_at) values ($1, $2, 'admin', true, now() + interval '1 hour')`, [ownerId, createHash('sha256').update(token).digest('hex')]);
  admin.jar.set('__Host-niko_admin', token);
  const me = await owner.get('/me');
  assert.equal(me.data.access.has, true); assert.equal(me.data.access.kind, 'admin');
});

await ok('nothing set up in Stripe: Connect has Niko make the webhook and billing page in each mode', async () => {
  let r = await admin.get('/admin/payments');
  assert.equal(r.data.modes.test.ready, false); assert.match(r.data.modes.test.problem, /Press Connect/);
  assert.equal((await admin.put('/admin/payments/mode', { mode: 'live' })).status, 400);
  r = await admin.post('/admin/payments/connect', { mode: 'test' });
  assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(r.data.account, 'Midnight Poetry');
  const ep = [...endpoints.values()].find((e) => e.mode === 'test');
  assert.equal(ep.url, `${ORIGIN}/api/hooks/stripe`);
  assert.deepEqual(ep.events.sort(), ['checkout.session.async_payment_succeeded', 'checkout.session.completed', 'customer.subscription.created', 'customer.subscription.deleted', 'customer.subscription.updated', 'invoice.paid', 'invoice.payment_failed']);
  // Pressed again (also after one made on the other domain): Niko's old endpoints are replaced, not doubled.
  endpoints.set('we_other', { id: 'we_other', url: 'https://niko.midnightpoetry.studio/api/hooks/stripe', mode: 'test', metadata: { niko: 'true' }, events: [] });
  endpoints.set('we_theirs', { id: 'we_theirs', url: 'https://example.com/hook', mode: 'test', metadata: {}, events: [] });
  r = await admin.post('/admin/payments/connect', { mode: 'test' });
  assert.equal(r.status, 200);
  assert.deepEqual([...endpoints.values()].filter((e) => e.mode === 'test').map((e) => e.id).filter((id) => id !== 'we_theirs').length, 1);
  assert.ok(endpoints.has('we_theirs'), 'endpoints Niko didn’t make are left alone');
  r = await admin.post('/admin/payments/connect', { mode: 'live' });
  assert.equal(r.status, 200); assert.equal(r.data.chargesEnabled, false, 'live account not yet activated is reported');
  const row = (await q(`select value from app_settings where key = 'stripe-connect'`))[0].value;
  assert.ok(row.test.hook.startsWith('v1.') && !JSON.stringify(row).includes('whsec_'), 'the signing secret is stored encrypted');
  assert.equal(row.test.portal, 'bpc_test'); assert.equal(row.live.portal, 'bpc_live');
  r = await admin.get('/admin/payments');
  assert.equal(r.data.modes.test.ready, true); assert.equal(r.data.modes.live.ready, true); assert.ok(r.data.modes.live.connectedAt);
  assert.ok(!JSON.stringify(r.data).includes('whsec_') && !JSON.stringify(r.data).includes('sk_'), 'no secret reaches the browser');
  const keep = env.STRIPE_LIVE_SECRET_KEY; env.STRIPE_LIVE_SECRET_KEY = 'sk_live_bad';
  try { assert.equal((await admin.post('/admin/payments/connect', { mode: 'sandbox' })).status, 400); } finally { env.STRIPE_LIVE_SECRET_KEY = keep; }
});
await ok('a paid invite needs a price; the Payments page saves prices and refuses both plans off', async () => {
  let r = await admin.post('/admin/invites', { email: 'early@example.com', access: 'paid' });
  assert.equal(r.status, 400); assert.match(r.data.error, /price/);
  r = await admin.put('/admin/payments', { settings: { monthly: { on: false }, yearly: { on: false } } });
  assert.equal(r.status, 400);
  r = await admin.put('/admin/payments', { settings: { onceCents: 4900, months: 12, unit: 'years', monthly: { on: true, cents: 900 }, yearly: { on: true, cents: 9000 }, openPay: true, graceDays: 7, remind: true } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  r = await admin.get('/admin/payments');
  assert.equal(r.data.settings.onceCents, 4900); assert.equal(r.data.stripe, true); assert.equal(r.data.settings.unit, 'years');
});

// ---------------------------------------------------------------- a paid invite
const priya = new Browser();
let pToken, pCode, pInviteId;
await ok('a paid invite emails the link, the code and both prices; the code is shown to the admin once', async () => {
  const r = await admin.post('/admin/invites', { email: 'priya@example.com', access: 'paid' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.priceCents, 4900); assert.equal(r.data.months, 12); assert.match(r.data.code, /^[A-HJKMNP-Z2-9]{6}$/);
  const e = lastEmail('priya@example.com');
  assert.match(e.subject, /Alex Tan invited you to Niko/);
  pToken = inviteToken(e.html); pCode = inviteCode(e.html);
  assert.equal(pCode, r.data.code);
  assert.match(e.html, /SGD 49\.00/); assert.match(e.html, /SGD 9\.00 a month or SGD 90\.00 a year/); assert.match(e.html, /1 year of Niko/);
  pInviteId = (await q('select id, code_hash from invites where email = $1', ['priya@example.com']))[0].id;
  const row = (await q('select code_hash from invites where id = $1', [pInviteId]))[0];
  assert.ok(row.code_hash && !row.code_hash.includes(pCode), 'only a hash of the code is stored');
});
await ok('before the code: no email shown, no paying, no account', async () => {
  let r = await priya.get(`/auth/invite/${pToken}`);
  assert.equal(r.status, 200); assert.equal(r.data.needsCode, true); assert.equal(r.data.email, undefined); assert.equal(r.data.invitedBy, 'Alex Tan');
  r = await priya.post(`/auth/invite/${pToken}/checkout`); assert.equal(r.status, 403);
  r = await priya.post(`/auth/invite/${pToken}`, { name: 'Priya', password: PW }); assert.equal(r.status, 403);
  r = await priya.post(`/auth/invite/${pToken}/code`, { code: 'AAAAAA' }); assert.equal(r.status, 400); assert.equal(r.data.left, 4);
});
await ok('the right code (any case, with spaces) opens the invite; account waits for payment', async () => {
  let r = await priya.post(`/auth/invite/${pToken}/code`, { code: ` ${pCode.slice(0, 3).toLowerCase()} ${pCode.slice(3)} ` });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.needsCode, false); assert.equal(r.data.email, 'priya@example.com'); assert.equal(r.data.priceCents, 4900); assert.equal(r.data.paid, false);
  assert.ok(priya.jar.has('__Host-niko_invite'));
  r = await priya.post(`/auth/invite/${pToken}`, { name: 'Priya', password: PW }); assert.equal(r.status, 402);
  const other = new Browser();
  r = await other.post(`/auth/invite/${pToken}/checkout`); assert.equal(r.status, 403, 'the pass belongs to the browser that entered the code');
});
let pSession;
await ok('Checkout is made on Stripe with the fixed price and the invite’s email', async () => {
  const r = await priya.post(`/auth/invite/${pToken}/checkout`);
  assert.equal(r.status, 200); assert.match(r.data.url, /^https:\/\/checkout\.stripe\.com\//);
  const c = stripeCalls.at(-1);
  assert.equal(c.p.mode, 'payment'); assert.equal(c.p.customer_email, 'priya@example.com'); assert.equal(c.p['line_items[0][price_data][unit_amount]'], '4900');
  assert.equal(c.p['line_items[0][price_data][currency]'], 'sgd'); assert.equal(c.p['metadata[kind]'], 'invite'); assert.match(c.p.success_url, /paid=\{CHECKOUT_SESSION_ID\}/);
  assert.equal(c.p['line_items[0][price_data][product]'], 'prod_test_access-12', 'Niko’s own product, made in Stripe when first needed');
  assert.equal(c.p['line_items[0][price_data][product_data][name]'], undefined);
  pSession = r.data.url.split('/').at(-1);
  const s = await priya.get(`/auth/invite/${pToken}/status?session=${pSession}`);
  assert.equal(s.data.paid, false, 'returning from Stripe proves nothing while Stripe says unpaid');
});
await ok('webhooks: a bad signature is refused, and a wrong amount is not taken as paid', async () => {
  assert.equal(await webhook('checkout.session.completed', { ...sessions.get(pSession), payment_status: 'paid' }, { secret: 'whsec_wrong' }), 400);
  assert.equal(await webhook('checkout.session.completed', { ...sessions.get(pSession), payment_status: 'paid', amount_total: 100 }), 200);
  assert.equal((await q('select paid_at from invites where id = $1', [pInviteId]))[0].paid_at, null);
});
await ok('when Stripe says paid, the status check (asking Stripe) marks it, and the link stays open', async () => {
  Object.assign(sessions.get(pSession), { payment_status: 'paid', status: 'complete', payment_intent: 'pi_priya', customer: 'cus_priya' });
  const s = await priya.get(`/auth/invite/${pToken}/status?session=${pSession}`);
  assert.equal(s.data.paid, true);
  const row = (await q('select paid_at, payment_intent, expires_at from invites where id = $1', [pInviteId]))[0];
  assert.ok(row.paid_at); assert.equal(row.payment_intent, 'pi_priya'); assert.ok(days(row.expires_at, new Date()) >= 364);
  // The webhook for the same payment arrives later: nothing changes, and a resent event is applied once.
  assert.equal(await webhook('checkout.session.completed', sessions.get(pSession), { id: 'evt_same' }), 200);
  assert.equal(await webhook('checkout.session.completed', sessions.get(pSession), { id: 'evt_same' }), 200);
  assert.equal((await q(`select count(*)::int as n from stripe_events where id = 'evt_same'`))[0].n, 1);
});
await ok('after paying, the account is made with 12 months of access and the Stripe customer kept', async () => {
  const r = await priya.post(`/auth/invite/${pToken}`, { name: 'Priya', password: PW });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const u = await user('priya@example.com');
  assert.equal(u.lifetime, false); assert.equal(u.access_kind, 'paid'); assert.equal(u.stripe_customer_test, 'cus_priya'); assert.equal(u.paid_mode, 'test');
  sameDay(u.access_until, monthsLater(12));
  const me = await priya.get('/me');
  assert.equal(me.data.access.has, true); assert.equal(me.data.access.kind, 'paid'); assert.equal(me.data.access.plans.length, 2);
  assert.equal((await priya.get(`/auth/invite/${pToken}`)).status, 404, 'the link works once');
});

// ---------------------------------------------------------------- locking, a new code, free and lifetime invites
const jun = new Browser();
let jToken, jCode, jId;
await ok('five wrong codes lock the invite, even for the right code', async () => {
  const r = await admin.post('/admin/invites', { email: 'jun@example.com', access: 'free', months: 3 });
  assert.equal(r.status, 200);
  const e = lastEmail('jun@example.com');
  assert.match(e.html, /Free for 3 months/);
  jToken = inviteToken(e.html); jCode = inviteCode(e.html);
  jId = (await q('select id from invites where email = $1', ['jun@example.com']))[0].id;
  for (let i = 1; i <= 4; i++) assert.equal((await jun.post(`/auth/invite/${jToken}/code`, { code: 'ZZZZZZ' })).data.left, 5 - i);
  let x = await jun.post(`/auth/invite/${jToken}/code`, { code: 'ZZZZZZ' });
  assert.equal(x.status, 423); assert.equal(x.data.locked, true);
  x = await jun.post(`/auth/invite/${jToken}/code`, { code: jCode }); assert.equal(x.status, 423);
  assert.equal((await jun.get(`/auth/invite/${jToken}`)).data.locked, true);
  const list = await admin.get('/admin/users');
  assert.equal(list.data.invites.find((i) => i.email === 'jun@example.com').codeTries, 5);
});
await ok('the admin sends a new code: the old link stops, the new code works, free time starts', async () => {
  const r = await admin.post(`/admin/invites/${jId}/code`);
  assert.equal(r.status, 200);
  const e = lastEmail('jun@example.com');
  const t2 = inviteToken(e.html), c2 = inviteCode(e.html);
  assert.equal(c2, r.data.code); assert.notEqual(t2, jToken);
  assert.equal((await jun.get(`/auth/invite/${jToken}`)).status, 404);
  assert.equal((await jun.post(`/auth/invite/${t2}/code`, { code: c2 })).status, 200);
  assert.equal((await jun.post(`/auth/invite/${t2}`, { name: 'Jun Koh', password: PW })).status, 200);
  const u = await user('jun@example.com');
  assert.equal(u.access_kind, 'free'); sameDay(u.access_until, monthsLater(3));
});
await ok('a lifetime invite needs only the code; never pays', async () => {
  await admin.post('/admin/invites', { email: 'nur@example.com', access: 'life' });
  const e = lastEmail('nur@example.com');
  assert.doesNotMatch(e.html, /SGD/);
  const b = new Browser();
  assert.equal((await b.post(`/auth/invite/${inviteToken(e.html)}/code`, { code: inviteCode(e.html) })).status, 200);
  assert.equal((await b.post(`/auth/invite/${inviteToken(e.html)}`, { name: 'Nur', password: PW })).status, 200);
  assert.equal((await user('nur@example.com')).lifetime, true);
});
await ok('revoking a paid invite refunds it on Stripe first', async () => {
  await admin.post('/admin/invites', { email: 'sam@example.com', access: 'paid', priceCents: 2500, months: 6 });
  const e = lastEmail('sam@example.com');
  assert.match(e.html, /SGD 25\.00/); assert.match(e.html, /6 months/);
  const b = new Browser();
  const tk = inviteToken(e.html);
  await b.post(`/auth/invite/${tk}/code`, { code: inviteCode(e.html) });
  const co = await b.post(`/auth/invite/${tk}/checkout`);
  const sid = co.data.url.split('/').at(-1);
  Object.assign(sessions.get(sid), { payment_status: 'paid', payment_intent: 'pi_sam', customer: 'cus_sam' });
  assert.equal(await webhook('checkout.session.completed', sessions.get(sid)), 200);
  const inv = (await q('select id from invites where email = $1', ['sam@example.com']))[0];
  let r = await admin.post('/admin/invites', { email: 'sam@example.com', access: 'paid' });
  assert.equal(r.status, 409, 'a new invite is refused while a paid one is open');
  r = await admin.del(`/admin/invites/${inv.id}`);
  assert.equal(r.status, 200); assert.equal(r.data.refunded, true);
  const call = stripeCalls.at(-1);
  assert.equal(call.path, '/refunds'); assert.equal(call.p.payment_intent, 'pi_sam');
  const row = (await q('select revoked_at, refunded_at from invites where id = $1', [inv.id]))[0];
  assert.ok(row.revoked_at && row.refunded_at);
});

// ---------------------------------------------------------------- open sign-up
const lee = new Browser();
await ok('open sign-up: the price is shown first; an email code confirms the address', async () => {
  await admin.put('/admin/registration', { mode: 'open' });
  const cfg = await lee.get('/auth/config');
  assert.equal(cfg.data.signup.priceCents, 4900); assert.equal(cfg.data.signup.months, 12);
  let r = await lee.post('/auth/sign-up', { name: 'Lee Wen', email: 'lee@example.com', password: PW });
  assert.equal(r.status, 200); assert.equal(r.data.state, 'verify'); assert.ok(lee.jar.has('__Host-niko_signup'));
  assert.equal((await user('lee@example.com')).status, 'off');
  assert.equal((await lee.get('/auth/sign-up/state')).data.state, 'verify');
  assert.equal((await lee.post('/auth/sign-up/checkout')).status, 400, 'no paying before the email is confirmed');
  assert.equal((await lee.post('/auth/sign-up/verify', { code: '000000' })).status, 400);
  r = await lee.post('/auth/sign-up/verify', { code: emailCode(lastEmail('lee@example.com').html) });
  assert.equal(r.status, 200); assert.equal(r.data.state, 'pay'); assert.equal(r.data.priceCents, 4900);
});
await ok('a sign-up pays, then waits for the admin; sign-in is refused until then', async () => {
  const co = await lee.post('/auth/sign-up/checkout');
  assert.equal(co.status, 200);
  assert.equal(stripeCalls.at(-1).p['metadata[kind]'], 'signup');
  const sid = co.data.url.split('/').at(-1);
  Object.assign(sessions.get(sid), { payment_status: 'paid', payment_intent: 'pi_lee', customer: 'cus_lee' });
  const before = emails.length;
  assert.equal(await webhook('checkout.session.completed', sessions.get(sid)), 200);
  const st = await lee.get(`/auth/sign-up/status?session=${sid}`);
  assert.equal(st.data.state, 'waiting'); assert.equal(st.data.paid, true);
  const u = await user('lee@example.com');
  assert.equal(u.access_start_months, 12); assert.equal(u.access_until, null, 'the paid months haven’t started'); assert.equal(u.stripe_customer_test, 'cus_lee');
  assert.ok(emails.slice(before).some((e) => e.to === 'alex@example.com' && /paid sign-up is waiting/.test(e.subject)));
  const signin = await new Browser().post('/auth/sign-in', { email: 'lee@example.com', password: PW });
  assert.equal(signin.status, 403);
  const row = (await admin.get('/admin/users')).data.users.find((x) => x.email === 'lee@example.com');
  assert.equal(row.signup.state, 'waiting'); assert.equal(row.signup.paid, true);
});
await ok('switching a paid sign-up on starts their 12 months and emails them', async () => {
  const id = (await user('lee@example.com')).id;
  assert.equal((await admin.patch(`/admin/users/${id}`, { status: 'active' })).status, 200);
  const u = await user('lee@example.com');
  assert.equal(u.status, 'active'); assert.equal(u.access_kind, 'paid'); assert.equal(u.access_start_months, 0);
  sameDay(u.access_until, monthsLater(12));
  assert.equal((await q('select count(*)::int as n from signups where user_id = $1', [id]))[0].n, 0);
  assert.match(lastEmail('lee@example.com').subject, /account is on/);
  assert.equal((await lee.post('/auth/sign-in', { email: 'lee@example.com', password: PW })).status, 200);
});
await ok('signing up with an email that has an account looks the same, but goes nowhere; the owner is told', async () => {
  const b = new Browser();
  const r = await b.post('/auth/sign-up', { name: 'X', email: 'priya@example.com', password: PW });
  assert.equal(r.status, 200); assert.equal(r.data.state, 'verify');
  assert.match(lastEmail('priya@example.com').subject, /Someone tried to sign up/);
  assert.equal((await b.post('/auth/sign-up/verify', { code: '123456' })).status, 400);
});
// The daily job runs from traffic (no cron). A clock that moves on past the 10-minute and 1-hour gates.
let clock = Date.now() + 86400_000;
const runDaily = async () => {
  await Promise.all(waits.splice(0));
  await q(`update app_settings set value = to_jsonb(now() - interval '2 hours') where key = 'daily-ran'`);
  clock += 60 * 60_000;
  assert.equal(await maybeDaily(env, createDb(env.DATABASE_URL), clock), true);
};
await ok('the daily job runs from ordinary requests, at most once an hour, and only one of many requests runs it', async () => {
  await Promise.all(waits.splice(0));
  // Nothing but maybeDaily writes this row, and so far the tests have only sent requests.
  assert.equal((await q(`select count(*)::int as n from app_settings where key = 'daily-ran'`))[0].n, 1, 'the requests so far ran it');
  const db = createDb(env.DATABASE_URL);
  clock += 11 * 60_000;
  assert.equal(await maybeDaily(env, db, clock), false, 'not again within the hour');
  await q(`update app_settings set value = to_jsonb(now() - interval '2 hours') where key = 'daily-ran'`);
  clock += 11 * 60_000;
  const a = maybeDaily(env, db, clock);
  const b = maybeDaily(env, createDb(env.DATABASE_URL), clock + 11 * 60_000);
  assert.deepEqual((await Promise.all([a, b])).sort(), [false, true], 'two at once: one runs');
});
await ok('unpaid sign-ups can’t be switched on, can be removed, and go by themselves after 7 days', async () => {
  const ken = new Browser();
  await ken.post('/auth/sign-up', { name: 'Ken', email: 'ken@example.com', password: PW });
  const kid = (await user('ken@example.com')).id;
  assert.equal((await admin.patch(`/admin/users/${kid}`, { status: 'active' })).status, 400);
  assert.equal((await admin.del(`/admin/users/${kid}`)).status, 200);
  assert.equal(await user('ken@example.com'), undefined);
  assert.equal((await admin.del(`/admin/users/${(await user('lee@example.com')).id}`)).status, 400, 'only unpaid sign-ups');
  const old = new Browser();
  await old.post('/auth/sign-up', { name: 'Old', email: 'old@example.com', password: PW });
  await q(`update signups set created_at = now() - interval '8 days' where user_id = (select id from users where email = 'old@example.com')`);
  await runDaily();
  assert.equal(await user('old@example.com'), undefined);
});
await ok('the “Wrong email?” restart removes an unpaid sign-up', async () => {
  const b = new Browser();
  await b.post('/auth/sign-up', { name: 'Typo', email: 'typo@exmaple.com', password: PW });
  assert.equal((await b.post('/auth/sign-up/restart')).status, 200);
  assert.equal(await user('typo@exmaple.com'), undefined);
  assert.equal((await b.get('/auth/sign-up/state')).data.state, null);
});

// ---------------------------------------------------------------- reminders
await ok('a reminder goes out once, 7 days before paid time ends', async () => {
  await q(`update users set access_until = now() + interval '5 days' where email = 'jun@example.com'`);
  const before = emails.length;
  await runDaily();
  const sent = emails.slice(before).filter((e) => e.to === 'jun@example.com');
  assert.equal(sent.length, 1); assert.match(sent[0].subject, /time ends soon/); assert.match(sent[0].html, /SGD 9\.00 a month or SGD 90\.00 a year/);
  await runDaily();
  assert.equal(emails.slice(before).filter((e) => e.to === 'jun@example.com').length, 1);
});

// ---------------------------------------------------------------- time ends, then a plan
await ok('when paid time ends, Niko answers only with a request to choose a plan', async () => {
  await q(`update users set access_until = now() - interval '1 day' where email = 'priya@example.com'`);
  const r = await priya.get('/brief?tz=0');
  assert.equal(r.status, 402); assert.equal(r.data.code, 'plan_needed');
  const me = await priya.get('/me');
  assert.equal(me.status, 200); assert.equal(me.data.access.has, false); assert.deepEqual(me.data.access.plans.map((p) => p.plan), ['monthly', 'yearly']);
  assert.ok(me.data.access.endedAt);
});
await ok('choosing a plan makes a Stripe subscription Checkout; the webhook turns access back on', async () => {
  let r = await priya.post('/billing/checkout', { plan: 'weekly' });
  assert.equal(r.status, 400);
  r = await priya.post('/billing/checkout', { plan: 'monthly' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const c = stripeCalls.at(-1);
  assert.equal(c.p.mode, 'subscription'); assert.equal(c.p.customer, 'cus_priya'); assert.equal(c.p['line_items[0][price_data][recurring][interval]'], 'month');
  assert.equal(c.p['line_items[0][price_data][unit_amount]'], '900'); assert.equal(c.p['subscription_data[metadata][user_id]'], (await user('priya@example.com')).id);
  assert.equal(c.p['line_items[0][price_data][product]'], 'prod_test_plan-monthly');
  assert.equal(stripeCalls.filter((x) => x.path === '/products' && x.p['metadata[niko]'] === 'access-12' && x.mode === 'test').length, 1, 'a product is made once and reused');
  assert.equal(c.p['subscription_data[trial_end]'], undefined, 'no time left, so billing starts now');
  const end = Math.floor(Date.now() / 1000) + 30 * 86400;
  const sub = { id: 'sub_priya', status: 'active', customer: 'cus_priya', cancel_at_period_end: false, metadata: { user_id: (await user('priya@example.com')).id, plan: 'monthly' }, items: { data: [{ current_period_end: end, price: { recurring: { interval: 'month' } } }] } };
  subs.set(sub.id, sub);
  assert.equal(await webhook('customer.subscription.created', sub), 200);
  const me = await priya.get('/me');
  assert.equal(me.data.access.has, true); assert.equal(me.data.access.kind, 'sub'); assert.equal(me.data.access.sub.plan, 'monthly');
  assert.notEqual((await priya.get('/brief?tz=0')).status, 402);
  assert.equal((await priya.post('/billing/checkout', { plan: 'yearly' })).status, 409, 'one plan at a time');
  assert.match((await priya.post('/billing/portal')).data.url, /billing\.stripe\.com/);
});
await ok('a failed renewal keeps access for the grace days, then ends it', async () => {
  const sub = subs.get('sub_priya');
  sub.status = 'past_due'; sub.items.data[0].current_period_end = Math.floor(Date.now() / 1000) - 2 * 86400;
  await webhook('invoice.payment_failed', { subscription: 'sub_priya' });
  assert.match(lastEmail('priya@example.com').subject, /didn’t go through/);
  assert.match(lastEmail('priya@example.com').html, /7 days/);
  assert.equal((await priya.get('/me')).data.access.kind, 'grace');
  sub.items.data[0].current_period_end = Math.floor(Date.now() / 1000) - 8 * 86400;
  await webhook('customer.subscription.updated', sub);
  assert.equal((await priya.get('/me')).data.access.has, false);
  sub.status = 'active'; sub.items.data[0].current_period_end = Math.floor(Date.now() / 1000) + 30 * 86400;
  await webhook('invoice.paid', { subscription: 'sub_priya' });
  assert.equal((await priya.get('/me')).data.access.kind, 'sub');
});
await ok('choosing a plan ahead of time starts billing when the paid time ends', async () => {
  const r = await lee.post('/billing/checkout', { plan: 'yearly', from: 'account' });
  assert.equal(r.status, 200);
  const c = stripeCalls.at(-1);
  const until = Math.floor(new Date((await user('lee@example.com')).access_until).getTime() / 1000);
  assert.equal(c.p['subscription_data[trial_end]'], String(until)); assert.match(c.p.success_url, /\/account\?plan=/);
  assert.equal(c.p.customer, 'cus_lee');
});

// ---------------------------------------------------------------- unlocking
await ok('unlock for a set time on a live plan: the plan stops renewing and the time follows its period', async () => {
  const id = (await user('priya@example.com')).id;
  const periodEnd = new Date((await user('priya@example.com')).sub_period_end);
  const r = await admin.post(`/admin/users/${id}/unlock`, { kind: 'set', months: 6 });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const c = stripeCalls.at(-1);
  assert.equal(c.method, 'POST'); assert.equal(c.path, '/subscriptions/sub_priya'); assert.equal(c.p.cancel_at_period_end, 'true');
  const u = await user('priya@example.com');
  assert.equal(u.access_kind, 'unlocked'); assert.equal(new Date(u.access_paid_until).getTime(), periodEnd.getTime());
  assert.equal(new Date(u.access_until).toISOString(), monthsLater(6, periodEnd).toISOString());
  assert.match(lastEmail('priya@example.com').subject, /unlocked/);
  // When the plan reaches its end, the unlocked time carries on.
  const sub = subs.get('sub_priya'); sub.status = 'canceled'; sub.items.data[0].current_period_end = Math.floor(Date.now() / 1000) - 60;
  await webhook('customer.subscription.deleted', sub);
  assert.equal((await priya.get('/me')).data.access.kind, 'unlocked');
});
await ok('unlock for a set time after paid time: it starts when the paid time ends', async () => {
  const before = new Date((await user('lee@example.com')).access_until);
  const id = (await user('lee@example.com')).id;
  assert.equal((await admin.post(`/admin/users/${id}/unlock`, { kind: 'set', months: 1 })).status, 200);
  const u = await user('lee@example.com');
  assert.equal(new Date(u.access_paid_until).getTime(), before.getTime());
  assert.equal(new Date(u.access_until).toISOString(), monthsLater(1, before).toISOString());
});
await ok('unlock with no time left starts today; lifetime cancels a live plan now', async () => {
  await q(`update users set access_until = now() - interval '1 day' where email = 'jun@example.com'`);
  const jid = (await user('jun@example.com')).id;
  await admin.post(`/admin/users/${jid}/unlock`, { kind: 'set', months: 2 });
  let u = await user('jun@example.com');
  assert.equal(u.access_paid_until, null); sameDay(u.access_until, monthsLater(2));
  const lid = (await user('lee@example.com')).id;
  const sub = { id: 'sub_lee', status: 'trialing', customer: 'cus_lee', cancel_at_period_end: false, metadata: { user_id: lid, plan: 'yearly' }, items: { data: [{ current_period_end: Math.floor(Date.now() / 1000) + 400 * 86400 }] } };
  subs.set(sub.id, sub);
  await webhook('customer.subscription.created', sub);
  assert.equal((await admin.post(`/admin/users/${lid}/unlock`, { kind: 'life' })).status, 200);
  assert.equal(stripeCalls.at(-1).method, 'DELETE'); assert.equal(stripeCalls.at(-1).path, '/subscriptions/sub_lee');
  u = await user('lee@example.com');
  assert.equal(u.lifetime, true);
  assert.equal((await admin.post(`/admin/users/${lid}/unlock`, { kind: 'set', months: 500 })).status, 400);
});
// ---------------------------------------------------------------- test and live
let testPaidInvite;
await ok('payments start in test mode; both modes’ keys are reported without the keys themselves', async () => {
  const r = await admin.get('/admin/payments');
  assert.equal(r.data.mode, 'test'); assert.equal(r.data.modes.test.ready, true); assert.equal(r.data.modes.live.ready, true);
  assert.ok(!JSON.stringify(r.data).includes('sk_'), 'no key is sent to the browser');
  assert.equal((await jun.get('/me')).data.access.testMode, true);
  // An invite paid in test mode, left open, to refund after switching.
  await admin.post('/admin/invites', { email: 'tess@example.com', access: 'paid' });
  const e = lastEmail('tess@example.com');
  const b = new Browser();
  await b.post(`/auth/invite/${inviteToken(e.html)}/code`, { code: inviteCode(e.html) });
  const co = await b.post(`/auth/invite/${inviteToken(e.html)}/checkout`);
  const sid = co.data.url.split('/').at(-1);
  assert.match(sid, /^cs_test_/);
  Object.assign(sessions.get(sid), { payment_status: 'paid', payment_intent: 'pi_tess', customer: 'cus_tess' });
  await webhook('checkout.session.completed', sessions.get(sid));
  testPaidInvite = (await q('select id, stripe_mode from invites where email = $1 and revoked_at is null', ['tess@example.com']))[0];
  assert.equal(testPaidInvite.stripe_mode, 'test');
  // A test-mode plan on another account.
  const jid = (await user('jun@example.com')).id;
  const sub = { id: 'sub_jun', status: 'active', customer: 'cus_jun_test', cancel_at_period_end: false, metadata: { user_id: jid, plan: 'monthly' }, items: { data: [{ current_period_end: Math.floor(Date.now() / 1000) + 20 * 86400 }] } };
  subs.set(sub.id, sub);
  await webhook('customer.subscription.created', sub);
  const u = await user('jun@example.com');
  assert.equal(u.sub_mode, 'test'); assert.equal(u.stripe_customer_test, 'cus_jun_test'); assert.equal(u.stripe_customer_live, null);
});
await ok('switching is refused when that mode’s key is missing or is the other mode’s key', async () => {
  const keep = env.STRIPE_LIVE_SECRET_KEY;
  env.STRIPE_LIVE_SECRET_KEY = 'sk_test_oops';
  let r = await admin.put('/admin/payments/mode', { mode: 'live' });
  assert.equal(r.status, 400); assert.match(r.data.error, /live secret key is a test key/);
  assert.equal((await admin.get('/admin/payments')).data.modes.live.ready, false);
  env.STRIPE_LIVE_SECRET_KEY = undefined;
  r = await admin.put('/admin/payments/mode', { mode: 'live' });
  assert.equal(r.status, 400);
  assert.equal((await admin.post('/admin/payments/connect', { mode: 'live' })).status, 400, 'no key, nothing to connect');
  env.STRIPE_LIVE_SECRET_KEY = keep;
  assert.equal((await admin.put('/admin/payments/mode', { mode: 'sandbox' })).status, 400);
});
await ok('switched to live: new payments use the live key and live webhooks', async () => {
  let r = await admin.put('/admin/payments/mode', { mode: 'live' });
  assert.equal(r.status, 200);
  assert.equal((await q(`select value from app_settings where key = 'stripe-mode'`))[0].value, 'live');
  assert.equal((await jun.get('/me')).data.access.testMode, false);
  await admin.post('/admin/invites', { email: 'liv@example.com', access: 'paid' });
  const e = lastEmail('liv@example.com');
  const b = new Browser();
  const tk = inviteToken(e.html);
  await b.post(`/auth/invite/${tk}/code`, { code: inviteCode(e.html) });
  assert.equal((await b.get(`/auth/invite/${tk}`)).data.testMode, false);
  const co = await b.post(`/auth/invite/${tk}/checkout`);
  assert.equal(stripeCalls.at(-1).auth, 'Bearer sk_live_niko');
  const sid = co.data.url.split('/').at(-1);
  assert.match(sid, /^cs_live_/);
  Object.assign(sessions.get(sid), { payment_status: 'paid', payment_intent: 'pi_liv', customer: 'cus_liv' });
  // Signed with the test secret, or claiming the wrong mode: refused.
  assert.equal(await webhook('checkout.session.completed', sessions.get(sid), { secret: made.test, livemode: true }), 400);
  assert.equal(await webhook('checkout.session.completed', sessions.get(sid), { secret: made.live, livemode: false }), 400);
  assert.equal(await webhook('checkout.session.completed', sessions.get(sid), { secret: made.live }), 200);
  assert.equal((await b.get(`/auth/invite/${tk}/status`)).data.paid, true);
  assert.equal((await b.post(`/auth/invite/${tk}`, { name: 'Liv', password: PW })).status, 200);
  const u = await user('liv@example.com');
  assert.equal(u.paid_mode, 'live'); assert.equal(u.stripe_customer_live, 'cus_liv'); assert.equal(u.stripe_customer_test, null);
  assert.equal((await q(`select mode from stripe_events order by created_at desc limit 1`))[0].mode, 'live');
});
await ok('after switching, a test payment is refunded and a test plan changed with the test key', async () => {
  let r = await admin.del(`/admin/invites/${testPaidInvite.id}`);
  assert.equal(r.status, 200); assert.equal(r.data.refunded, true);
  assert.equal(stripeCalls.at(-1).path, '/refunds'); assert.equal(stripeCalls.at(-1).auth, 'Bearer sk_test_niko');
  // The test plan still renews through test webhooks while new payments are live.
  const sub = subs.get('sub_jun'); sub.items.data[0].current_period_end = Math.floor(Date.now() / 1000) + 50 * 86400;
  assert.equal(await webhook('customer.subscription.updated', sub, { secret: made.test }), 200);
  const jid = (await user('jun@example.com')).id;
  r = await admin.post(`/admin/users/${jid}/unlock`, { kind: 'set', months: 1 });
  assert.equal(r.status, 200);
  assert.equal(stripeCalls.at(-1).path, '/subscriptions/sub_jun'); assert.equal(stripeCalls.at(-1).auth, 'Bearer sk_test_niko');
  // Its billing page opens in test mode too; a plan chosen now is a live one.
  const jb = new Browser();
  assert.equal((await jb.post('/auth/sign-in', { email: 'jun@example.com', password: PW })).status, 200);
  r = await jb.post('/billing/portal');
  assert.equal(r.status, 200); assert.equal(stripeCalls.at(-1).auth, 'Bearer sk_test_niko'); assert.equal(stripeCalls.at(-1).p.customer, 'cus_jun_test');
  assert.equal(stripeCalls.at(-1).p.configuration, 'bpc_test', 'the billing page settings Niko made');
  const list = (await admin.get('/admin/users')).data;
  assert.equal(list.stripeMode, 'live');
  assert.equal(list.users.find((x) => x.email === 'jun@example.com').sub.mode, 'test');
  assert.equal(list.users.find((x) => x.email === 'liv@example.com').paidMode, 'live');
});

await ok('the admin list shows each account’s payment state', async () => {
  const r = await admin.get('/admin/users');
  const by = Object.fromEntries(r.data.users.map((x) => [x.email, x]));
  assert.equal(by['lee@example.com'].lifetime, true);
  assert.equal(by['priya@example.com'].accessKind, 'unlocked'); assert.ok(by['priya@example.com'].accessPaidUntil);
  assert.equal(by['nur@example.com'].access.kind, 'life');
  assert.equal(by['alex@example.com'].access.kind, 'admin');
});

await ok('a signed-in person changes their password; other devices are signed out and they are told', async () => {
  const here = new Browser(), there = new Browser();
  assert.equal((await here.post('/auth/sign-in', { email: 'jun@example.com', password: PW })).status, 200);
  assert.equal((await there.post('/auth/sign-in', { email: 'jun@example.com', password: PW })).status, 200);
  let r = await here.post('/me/password', { current: 'not-my-password', password: 'a brand new long passphrase 42' });
  assert.equal(r.status, 400); assert.match(r.data.error, /current password is not correct/);
  r = await here.post('/me/password', { current: PW, password: PW });
  assert.equal(r.status, 400, 'the same password again is refused');
  r = await here.post('/me/password', { current: PW, password: 'short' });
  assert.equal(r.status, 400, 'a weak new password is refused');
  const before = emails.length;
  r = await here.post('/me/password', { current: PW, password: 'a brand new long passphrase 42' });
  assert.equal(r.status, 200);
  await new Promise((res) => setTimeout(res, 50));
  assert.equal((await here.get('/me')).status, 200, 'this device stays signed in');
  assert.equal((await there.get('/me')).status, 401, 'other devices are signed out');
  assert.ok(emails.slice(before).some((m) => m.to === 'jun@example.com' && /password was changed/i.test(m.subject)), 'an email tells them');
  assert.equal((await new Browser().post('/auth/sign-in', { email: 'jun@example.com', password: PW })).status, 401, 'the old password no longer works');
  assert.equal((await new Browser().post('/auth/sign-in', { email: 'jun@example.com', password: 'a brand new long passphrase 42' })).status, 200, 'the new one does');
  const log = await q("select action from audit_log where action like 'password.%' order by created_at");
  assert.deepEqual(log.map((x) => x.action).filter((a) => a !== 'password.reset'), ['password.change_failed', 'password.changed']);
  assert.equal((await new Browser().post('/me/password', { current: 'x', password: 'y' })).status, 401, 'signed out: refused');
});

await ok('changing plan prices: the admin chooses whether existing accounts keep theirs or move at their next plan', async () => {
  const NEWPW = 'a brand new long passphrase 42';
  const jun = await user('jun@example.com');
  await q("insert into users (email, name, password_hash, status, role, lifetime, access_until, access_kind) values ('kim@example.com', 'Kim', $1, 'active', 'member', false, now() - interval '1 day', 'paid')", [jun.password_hash]);
  const kim = new Browser();
  assert.equal((await kim.post('/auth/sign-in', { email: 'kim@example.com', password: NEWPW })).status, 200);
  const cur = (await admin.get('/admin/payments')).data.settings;
  const plansOf = async (b) => (await b.get('/billing')).data.plans.map((p) => `${p.plan}:${p.cents}`).join();
  assert.equal(await plansOf(kim), 'monthly:900,yearly:9000');
  // Changing plan prices needs a choice.
  let r = await admin.put('/admin/payments', { settings: { ...cur, monthly: { on: true, cents: 1200 }, yearly: { on: true, cents: 12000 } } });
  assert.equal(r.status, 400); assert.match(r.data.error, /who gets the new plan prices/);
  // Only new people: Kim keeps today's prices, and is charged them.
  r = await admin.put('/admin/payments', { settings: { ...cur, monthly: { on: true, cents: 1200 }, yearly: { on: true, cents: 12000 } }, pricesFor: 'new' });
  assert.equal(r.status, 200); assert.equal(r.data.changed, true); assert.ok(r.data.accounts >= 1);
  assert.equal(await plansOf(kim), 'monthly:900,yearly:9000', 'an existing account keeps its plan prices');
  r = await kim.post('/billing/checkout', { plan: 'monthly' });
  assert.equal(r.status, 200); assert.equal(stripeCalls.at(-1).p['line_items[0][price_data][unit_amount]'], '900', 'and is charged them');
  const row = (await admin.get('/admin/users')).data.users.find((x) => x.email === 'kim@example.com');
  assert.deepEqual(row.keptPrices, [{ plan: 'monthly', cents: 900 }, { plan: 'yearly', cents: 9000 }], 'the admin sees the kept prices');
  assert.equal((await admin.get('/admin/users')).data.users.find((x) => x.email === 'alex@example.com').keptPrices, null, 'admins keep nothing');
  // A second change for new people only: Kim still keeps the first prices.
  r = await admin.put('/admin/payments', { settings: { ...cur, monthly: { on: true, cents: 1500 }, yearly: { on: false, cents: 12000 } }, pricesFor: 'new' });
  assert.equal(r.status, 200);
  assert.equal(await plansOf(kim), 'monthly:900,yearly:9000');
  // Saving without changing plan prices needs no choice and changes nobody.
  r = await admin.put('/admin/payments', { settings: { ...cur, monthly: { on: true, cents: 1500 }, yearly: { on: false, cents: 12000 }, remind: false } });
  assert.equal(r.status, 200); assert.equal(r.data.changed, false);
  // Everyone: Kim moves to the current prices at the next plan.
  r = await admin.put('/admin/payments', { settings: { ...cur, monthly: { on: true, cents: 1100 }, yearly: { on: true, cents: 11000 } }, pricesFor: 'everyone' });
  assert.equal(r.status, 200);
  assert.equal(await plansOf(kim), 'monthly:1100,yearly:11000', 'everyone moves to the new prices');
  assert.equal((await user('kim@example.com')).plan_prices, null);
  const log = (await q("select detail from audit_log where action = 'payments.default' order by created_at desc limit 1"))[0].detail;
  assert.equal(log.newPlanPrices, 'everyone at their next plan');
  await admin.put('/admin/payments', { settings: cur, pricesFor: 'everyone' });
});

await sqlc.end();
await closePools();
try { run('pg_ctl', ['-D', join(dir, 'data'), '-m', 'immediate', 'stop']); } catch { /* already stopping */ }
rmSync(dir, { recursive: true, force: true });
console.log(`${pass} payments checks passed`);
