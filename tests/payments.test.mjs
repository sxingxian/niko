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
const mapCalls = [];
const aiCalls = [];
const slowCal = { on: false };
globalThis.fetch = async (input, init = {}) => {
  // Like Cloudflare Workers: redirect must be 'follow' or 'manual'.
  if (init.redirect && !['follow', 'manual'].includes(init.redirect)) throw new TypeError(`Invalid redirect value, must be one of "follow" or "manual"`);
  const u = new URL(String(input));
  if (u.hostname === 'api.resend.com') { const b = JSON.parse(init.body); emails.push({ to: b.to[0], subject: b.subject, html: b.html }); return Response.json({ id: 'em_' + emails.length }); }
  if (u.hostname === 'cal.example.com') {
    if (slowCal.on) await new Promise((r) => setTimeout(r, 3000));
    const at = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
    const st = new Date(Date.now() + 3600_000);
    return new Response(`BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//t//t//EN\r\nBEGIN:VEVENT\r\nUID:d1@t\r\nDTSTAMP:${at(new Date())}\r\nDTSTART:${at(st)}\r\nDTEND:${at(new Date(st.getTime() + 1800_000))}\r\nSUMMARY:Dentist visit\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`, { headers: { 'content-type': 'text/calendar' } });
  }
  if (u.hostname === 'api.mapbox.com') {
    mapCalls.push(String(input));
    if (u.pathname.startsWith('/search/geocode/v6/')) return Response.json({ features: [{ properties: { name: 'Marina Bay Sands' }, geometry: { coordinates: [103.8607, 1.2834] } }] });
    return Response.json({ code: 'Ok', routes: [{ duration: 900, distance: 7000, geometry: { coordinates: [[103.82, 1.35], [103.8607, 1.2834]] }, legs: [{ steps: [{ maneuver: { instruction: 'Head south' }, distance: 7000 }] }] }] });
  }
  // An AI service for included keys (Groq) and one for a person's own key (OpenRouter), which also reports usage.
  // An AI service whose daily free requests are used up (as Gemini answers: "retry in 31s", though not until tomorrow).
  if (u.hostname === 'api.mistral.ai') {
    aiCalls.push({ host: u.hostname, path: u.pathname, auth: init.headers?.authorization ?? '' });
    return new Response(JSON.stringify({ error: { code: 429, message: 'Quota exceeded. Please retry in 31s.', details: [{ quotaId: 'RequestsPerDay' }] } }), { status: 429 });
  }
  if (u.hostname === 'api.groq.com' || u.hostname === 'openrouter.ai') {
    const auth = init.headers?.authorization ?? init.headers?.Authorization ?? '';
    aiCalls.push({ host: u.hostname, path: u.pathname, auth, body: typeof init.body === 'string' ? init.body : '' });
    if (u.pathname === '/api/v1/key') return Response.json({ data: { usage_monthly: 25.5, limit: 100, limit_remaining: 74.5, limit_reset: 'monthly' } });
    return Response.json({ choices: [{ message: { content: u.hostname === 'api.groq.com' ? 'From the included key.' : 'From my own key.' } }] });
  }
  if (u.hostname !== 'api.stripe.com') throw new Error('unexpected fetch ' + u);
  const method = init.method ?? 'GET';
  const params = new URLSearchParams(method !== 'POST' ? u.search.slice(1) : init.body ?? '');
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
  // Niko Pro: an item added to (or taken off) the plan's subscription. A sub marked declines refuses, as Stripe does
  // with payment_behavior=error_if_incomplete when the card can't pay.
  if (method === 'POST' && path === '/subscription_items') {
    const sub = subs.get(call.p.subscription);
    if (!sub) return Response.json({ error: { message: 'No such subscription' } }, { status: 404 });
    if (sub.declines) return Response.json({ error: { message: 'Your card was declined.', code: 'card_declined' } }, { status: 402 });
    const item = { id: `si_pro_${++seq}`, metadata: { niko: call.p['metadata[niko]'] }, price: { unit_amount: Number(call.p['price_data[unit_amount]']), product: call.p['price_data[product]'], recurring: { interval: call.p['price_data[recurring][interval]'] } } };
    sub.items.data.unshift(item);
    return Response.json(item);
  }
  if (method === 'DELETE' && (m = path.match(/^\/subscription_items\/(si_\w+)$/))) {
    for (const sub of subs.values()) if (sub.items?.data) sub.items.data = sub.items.data.filter((i) => i.id !== m[1]);
    return Response.json({ id: m[1], deleted: true });
  }
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
  const list = await admin.get('/admin/users?per=100');
  assert.equal(list.data.items.filter((i) => i.kind === 'invite').find((i) => i.email === 'jun@example.com').codeTries, 5);
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
  const row = (await admin.get('/admin/users?per=100')).data.items.filter((i) => i.kind === 'user').find((x) => x.email === 'lee@example.com');
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
  const list = (await admin.get('/admin/users?per=100')).data;
  assert.equal(list.stripeMode, 'live');
  assert.equal(list.items.filter((i) => i.kind === 'user').find((x) => x.email === 'jun@example.com').sub.mode, 'test');
  assert.equal(list.items.filter((i) => i.kind === 'user').find((x) => x.email === 'liv@example.com').paidMode, 'live');
});

await ok('the admin list shows each account’s payment state', async () => {
  const r = await admin.get('/admin/users?per=100');
  const by = Object.fromEntries(r.data.items.filter((i) => i.kind === 'user').map((x) => [x.email, x]));
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
  assert.equal(r.status, 400); assert.match(r.data.error, /who moves to the new default prices/);
  // Only new people: Kim keeps today's prices, and is charged them.
  r = await admin.put('/admin/payments', { settings: { ...cur, monthly: { on: true, cents: 1200 }, yearly: { on: true, cents: 12000 } }, pricesFor: 'new' });
  assert.equal(r.status, 200); assert.equal(r.data.changed, true); assert.ok(r.data.accounts >= 1);
  assert.equal(await plansOf(kim), 'monthly:900,yearly:9000', 'an existing account keeps its plan prices');
  r = await kim.post('/billing/checkout', { plan: 'monthly' });
  assert.equal(r.status, 200); assert.equal(stripeCalls.at(-1).p['line_items[0][price_data][unit_amount]'], '900', 'and is charged them');
  const row = (await admin.get('/admin/users?per=100')).data.items.filter((i) => i.kind === 'user').find((x) => x.email === 'kim@example.com');
  assert.deepEqual(row.keptPrices, [{ plan: 'monthly', cents: 900 }, { plan: 'yearly', cents: 9000 }], 'the admin sees the kept prices');
  assert.equal((await admin.get('/admin/users?per=100')).data.items.filter((i) => i.kind === 'user').find((x) => x.email === 'alex@example.com').keptPrices, null, 'admins keep nothing');
  // A second change for new people only: Kim still keeps the first prices.
  r = await admin.put('/admin/payments', { settings: { ...cur, monthly: { on: true, cents: 1500 }, yearly: { on: false, cents: 12000 } }, pricesFor: 'new' });
  assert.equal(r.status, 200);
  assert.equal(await plansOf(kim), 'monthly:900,yearly:9000');
  // Saving without changing plan prices needs no choice and changes nobody.
  r = await admin.put('/admin/payments', { settings: { ...cur, monthly: { on: true, cents: 1500 }, yearly: { on: false, cents: 12000 }, remind: false } });
  assert.equal(r.status, 200); assert.equal(r.data.changed, false);
  // Everyone on the default: Kim, with her own (kept) prices, keeps them...
  r = await admin.put('/admin/payments', { settings: { ...cur, monthly: { on: true, cents: 1100 }, yearly: { on: true, cents: 11000 } }, pricesFor: 'everyone' });
  assert.equal(r.status, 200);
  assert.equal(await plansOf(kim), 'monthly:900,yearly:9000', 'own prices are not moved by a change of the default');
  // ...unless the admin also puts accounts with own prices back on the default.
  r = await admin.put('/admin/payments', { settings: { ...cur, monthly: { on: true, cents: 1100 }, yearly: { on: true, cents: 12000 } }, pricesFor: 'everyone', alsoOwn: true });
  assert.equal(r.status, 200); assert.ok(r.data.ownMoved >= 1);
  assert.equal(await plansOf(kim), 'monthly:1100,yearly:12000', 'everyone moves to the new prices');
  assert.equal((await user('kim@example.com')).plan_prices, null);
  const log = (await q("select detail from audit_log where action = 'payments.default' order by created_at desc limit 1"))[0].detail;
  assert.equal(log.newPlanPrices, 'everyone on the default at their next plan'); assert.ok(log.ownPutBackOnDefault >= 1);
  await admin.put('/admin/payments', { settings: cur, pricesFor: 'everyone', alsoOwn: true });
});

await ok('the admin gives one person their own plan prices, or puts them back on the default', async () => {
  const kim = new Browser();
  assert.equal((await kim.post('/auth/sign-in', { email: 'kim@example.com', password: 'a brand new long passphrase 42' })).status, 200);
  const k = await user('kim@example.com');
  const plansOf = async () => (await kim.get('/billing')).data.plans.map((p) => `${p.plan}:${p.cents}`).join();
  const def = await plansOf();
  let r = await admin.put(`/admin/users/${k.id}/plan-prices`, { mode: 'own', monthly: 650, yearly: null });
  assert.equal(r.status, 200);
  assert.equal(await plansOf(), 'monthly:650', 'only the plans given are offered, at their price');
  r = await kim.post('/billing/checkout', { plan: 'monthly' });
  assert.equal(stripeCalls.at(-1).p['line_items[0][price_data][unit_amount]'], '650', 'and charged');
  const row = (await admin.get('/admin/users?per=100')).data.items.filter((i) => i.kind === 'user').find((x) => x.email === 'kim@example.com');
  assert.equal(row.pricesFrom, 'admin');
  assert.equal((await admin.put(`/admin/users/${k.id}/plan-prices`, { mode: 'own', monthly: null, yearly: null })).status, 400, 'at least one plan');
  assert.equal((await admin.put(`/admin/users/${k.id}/plan-prices`, { mode: 'own', monthly: 10, yearly: null })).status, 400, 'at least SGD 0.50');
  const alex = await user('alex@example.com');
  assert.equal((await admin.put(`/admin/users/${alex.id}/plan-prices`, { mode: 'own', monthly: 900 })).status, 400, 'admins choose no plan');
  assert.equal((await kim.put(`/admin/users/${k.id}/plan-prices`, { mode: 'own', monthly: 100 })).status !== 200, true, 'members can’t set prices');
  // The running plan changes too, from its next renewal, only when asked.
  subs.set('sub_kim', { id: 'sub_kim', status: 'active', items: { data: [{ id: 'si_kim', price: { product: 'prod_test_plan-monthly' } }] } });
  await q("update users set sub_id = 'sub_kim', sub_status = 'active', sub_plan = 'monthly', sub_mode = 'test', sub_cancel_at_end = false where id = $1", [k.id]);
  const before = stripeCalls.length;
  r = await admin.put(`/admin/users/${k.id}/plan-prices`, { mode: 'own', monthly: 700, yearly: 7000 });
  assert.equal(r.status, 200); assert.equal(stripeCalls.length, before, 'no Stripe call unless the running plan is to change');
  r = await admin.put(`/admin/users/${k.id}/plan-prices`, { mode: 'own', monthly: 750, yearly: 7000, renew: true });
  assert.equal(r.status, 200); assert.equal(r.data.renewed, 'SGD 7.50');
  const up = stripeCalls.at(-1);
  assert.equal(up.method, 'POST'); assert.equal(up.path, '/subscriptions/sub_kim');
  assert.equal(up.p['items[0][id]'], 'si_kim'); assert.equal(up.p['items[0][price_data][unit_amount]'], '750');
  assert.equal(up.p['items[0][price_data][recurring][interval]'], 'month'); assert.equal(up.p.proration_behavior, 'none', 'no charge or refund today');
  r = await admin.put(`/admin/users/${k.id}/plan-prices`, { mode: 'own', monthly: null, yearly: 7000, renew: true });
  assert.equal(r.status, 400, 'a monthly plan needs a monthly price to change');
  // Back on the default.
  r = await admin.put(`/admin/users/${k.id}/plan-prices`, { mode: 'default' });
  assert.equal(r.status, 200);
  assert.equal(await plansOf(), def);
  assert.equal((await user('kim@example.com')).plan_prices, null);
  const counts = (await admin.get('/admin/payments')).data;
  assert.ok(counts.onDefault >= 1 && typeof counts.ownPrices === 'number');
  const audits = await q("select detail from audit_log where action = 'plan_prices.user' order by created_at");
  assert.ok(audits.some((a) => a.detail.runningPlanFromNextRenewal === 'SGD 7.50') && audits.at(-1).detail.prices === 'default');
  await q("update users set sub_id = null, sub_status = null, sub_plan = null where id = $1", [k.id]);
});

await ok('the Users list is searched, filtered and paged on the server', async () => {
  for (let i = 0; i < 30; i++) await q("insert into users (email, name, password_hash, status, role) values ($1, $2, 'x', $3, 'member')", [`page${String(i).padStart(2, '0')}@example.com`, `Pager ${i}`, i % 3 ? 'active' : 'off']);
  let r = await admin.get('/admin/users?per=10');
  assert.equal(r.status, 200); assert.equal(r.data.items.length, 10); assert.equal(r.data.page, 1); assert.ok(r.data.total > 30 && r.data.pages >= 4);
  assert.equal(r.data.items[0].isOwner, true, 'the owner comes first');
  const p2 = await admin.get('/admin/users?per=10&page=2');
  assert.equal(new Set([...r.data.items, ...p2.data.items].map((i) => i.id)).size, 20, 'pages don’t overlap');
  assert.equal((await admin.get('/admin/users?per=10&page=999')).data.page, r.data.pages, 'a page past the end shows the last page');
  assert.equal((await admin.get('/admin/users?per=7')).data.per, 25, 'only the offered page sizes');
  r = await admin.get('/admin/users?q=PAGER%201&per=100');
  assert.ok(r.data.items.length >= 11 && r.data.items.every((i) => /pager 1/i.test(i.name)), 'search matches name or email, any case');
  assert.equal((await admin.get('/admin/users?q=page05@example')).data.total, 1);
  r = await admin.get('/admin/users?q=pager&show=off&per=100');
  assert.equal(r.data.total, 10); assert.ok(r.data.items.every((i) => i.status === 'off'));
  assert.equal(r.data.counts.all, 30, 'counts follow the search'); assert.equal(r.data.counts.off, 10); assert.equal(r.data.counts.active, 0, 'members with no paid time are not Active');
  assert.equal(r.data.counts.ended, 20, 'they need a plan');
  r = await admin.get('/admin/users?show=invited&per=100');
  assert.ok(r.data.items.every((i) => i.kind === 'invite'));
  r = await admin.get('/admin/users?show=own&per=100');
  assert.ok(r.data.items.every((i) => i.keptPrices));
  assert.notEqual((await new Browser().get('/admin/users')).status, 200, 'signed out: refused');
  await q("delete from users where email like 'page%@example.com'");
});

await ok('the audit log is paged, searched, and narrowed to one person', async () => {
  let r = await admin.get('/admin/audit?per=25');
  assert.equal(r.status, 200); assert.equal(r.data.entries.length, Math.min(25, r.data.total)); assert.ok(r.data.total > 25, 'enough entries to page');
  const p2 = await admin.get('/admin/audit?per=25&page=2');
  assert.ok(Date.parse(p2.data.entries[0].createdAt) <= Date.parse(r.data.entries.at(-1).createdAt), 'newest first, page after page');
  assert.equal((await admin.get('/admin/audit?per=3')).data.per, 50, 'only the offered page sizes');
  r = await admin.get('/admin/audit?q=PLAN_PRICES&per=100');
  assert.ok(r.data.total >= 1 && r.data.entries.every((e) => /plan_prices/.test(e.action) || /plan_prices/i.test(JSON.stringify(e.detail))));
  r = await admin.get('/admin/audit?q=' + encodeURIComponent('%_') + '&per=100');
  assert.equal(r.status, 200, 'wildcards in the search are taken literally');
  const k = await user('kim@example.com');
  r = await admin.get(`/admin/audit?user=${k.id}&per=100`);
  assert.equal(r.data.person.label, 'Kim');
  assert.ok(r.data.entries.length >= 1 && r.data.entries.every((e) => e.detail?.target === 'kim@example.com' || e.detail?.email === 'kim@example.com' || e.by === 'kim@example.com'), 'only what Kim did or was done to Kim');
  assert.ok(r.data.entries.some((e) => e.action === 'plan_prices.user' && e.by === 'alex@example.com'), 'with who did it');
  assert.equal((await admin.get('/admin/audit?user=not-an-id')).data.person, null);
});

await ok('maps: a key is saved encrypted and never shown again; routes come back without it; lists only name saved services', async () => {
  const b = new Browser();
  assert.equal((await b.post('/auth/sign-in', { email: 'jun@example.com', password: 'a brand new long passphrase 42' })).status, 200);
  let r = await b.post('/map/keys', { provider: 'mapbox', apiKey: 'pk.MAPBOX-SECRET-123' });
  assert.equal(r.status, 200); assert.equal(r.data.key.label, 'Mapbox'); assert.ok(!JSON.stringify(r.data).includes('MAPBOX-SECRET'));
  const id = r.data.key.id;
  const row = (await q("select secret_enc from connections where provider = 'map-keys'"))[0];
  assert.ok(row && !String(row.secret_enc).includes('MAPBOX-SECRET'), 'stored encrypted');
  let me = await b.get('/me');
  assert.deepEqual(me.data.engine.maps, [`mkey:${id}`, 'osm'], 'a new service goes into the Everywhere list');
  r = await b.get('/map/keys');
  assert.ok(!JSON.stringify(r.data).includes('MAPBOX-SECRET'));
  // Lists may only name saved services and the built-in map.
  r = await b.patch('/me', { engine: { maps: ['mkey:nothere', `mkey:${id}`, 'osm'], mapCountries: { SG: [`mkey:${id}`, 'mkey:zz'], sg: ['osm'], XYZ: ['osm'] } } });
  me = await b.get('/me');
  assert.deepEqual(me.data.engine.maps, [`mkey:${id}`, 'osm']); assert.deepEqual(me.data.engine.mapCountries, { SG: [`mkey:${id}`] });
  // A saved key is only reused for the same service.
  r = await b.post('/map/keys', { id, provider: 'google' });
  assert.equal(r.status, 400, 'changing the service needs the key again');
  r = await b.post('/maps/route', { to: 'Marina Bay Sands', mode: 'drive', here: { lat: 1.35, lng: 103.82 }, country: 'auto' });
  assert.equal(r.status, 200); assert.equal(r.data.route.seconds, 900); assert.equal(r.data.country.code, 'SG');
  assert.ok(!JSON.stringify(r.data).includes('MAPBOX-SECRET'));
  assert.ok(mapCalls.every((c) => c.includes('access_token=pk.MAPBOX-SECRET-123')), 'the key went only to Mapbox');
  const log = await q("select detail from audit_log where action like 'map-key.%'");
  assert.ok(log.length >= 1 && !JSON.stringify(log).includes('MAPBOX-SECRET'), 'audited without the key');
  assert.ok(!JSON.stringify(await q('select detail from audit_log')).includes('103.82'), 'the location is not logged');
  assert.equal((await b.post('/maps/route', { to: 'x' })).status, 400);
  assert.equal((await new Browser().post('/maps/route', { to: 'Marina Bay' })).status, 401, 'signed out: refused');
  r = await b.del(`/map/keys/${id}`);
  me = await b.get('/me');
  assert.deepEqual(me.data.engine.maps, ['osm']); assert.deepEqual(me.data.engine.mapCountries, { SG: [] });
});

await ok('a slow calendar never holds up an answer: Niko answers within the wait, and the calendar joins the next answer', async () => {
  const b = new Browser();
  assert.equal((await b.post('/auth/sign-in', { email: 'jun@example.com', password: 'a brand new long passphrase 42' })).status, 200);
  let r = await b.post('/calendars', { name: 'Work', url: 'https://cal.example.com/work.ics', kind: 'private' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  // Eleven minutes on: the kept copy of the feed is old, so it is read from the (now slow) server again.
  const realNow = Date.now; Date.now = () => realNow() + 11 * 60_000;
  const seen = [], run = env.AI.run;
  env.AI.run = async (...args) => { seen.push(JSON.stringify(args)); return { response: 'ok' }; };
  try {
    slowCal.on = true;
    const t0 = Date.now();
    r = await b.post('/chat', { message: 'hello there', tz: 0 });
    const took = Date.now() - t0;
    assert.equal(r.status, 200); assert.ok(took < 2500, `answered in ${took} ms`);
    assert.ok(!seen.at(-1).includes('Dentist'), 'the slow calendar was left out of this answer');
    await Promise.all(waits.splice(0));
    slowCal.on = false;
    r = await b.post('/chat', { message: 'what is on today', tz: 0 });
    assert.ok(seen.at(-1).includes('Dentist visit'), 'it was read in the background and is in the next answer');
  } finally { env.AI.run = run; slowCal.on = false; Date.now = realNow; }
});

await ok('opening Inbox, Calendar or Notes starts a new conversation: the AI forgets what was said', async () => {
  const b = new Browser();
  assert.equal((await b.post('/auth/sign-in', { email: 'jun@example.com', password: 'a brand new long passphrase 42' })).status, 200);
  assert.equal((await b.post('/chat', { message: 'remember the word pineapple', tz: 0 })).status, 200);
  const id = (await user('jun@example.com')).id;
  assert.ok((await q('select count(*)::int as n from chat_turns where user_id = $1', [id]))[0].n >= 2);
  const other = (await q('select count(*)::int as n from chat_turns where user_id <> $1', [id]))[0].n;
  assert.equal((await b.del('/chat/history')).status, 200);
  assert.equal((await q('select count(*)::int as n from chat_turns where user_id = $1', [id]))[0].n, 0);
  assert.equal((await q('select count(*)::int as n from chat_turns where user_id <> $1', [id]))[0].n, other, 'only this account');
  const seen = [], run = env.AI.run;
  env.AI.run = async (...args) => { seen.push(JSON.stringify(args)); return { response: 'ok' }; };
  try { await b.post('/chat', { message: 'what was the word', tz: 0 }); } finally { env.AI.run = run; }
  assert.ok(!seen.at(-1).includes('pineapple'), 'not in the next question');
  assert.equal((await new Browser().del('/chat/history')).status, 401);
});

await ok('screen lock: set with the password, kept by the server, new items only as who, five wrong codes sign out', async () => {
  const PWJ = 'a brand new long passphrase 42';
  const b = new Browser();
  assert.equal((await b.post('/auth/sign-in', { email: 'jun@example.com', password: PWJ })).status, 200);
  let r = await b.get('/lock');
  assert.equal(r.status, 200); assert.equal(r.data.on, false); assert.equal(r.data.locked, false);
  assert.equal((await b.post('/lock/now')).status, 400, 'nothing to lock while it is off');
  r = await b.put('/lock', { code: '482916' });
  assert.equal(r.status, 400, 'a code needs the password');
  r = await b.put('/lock', { code: '482916', password: 'wrong password here' });
  assert.equal(r.status, 400); assert.match(r.data.error, /password/);
  r = await b.put('/lock', { code: '123456', password: PWJ });
  assert.equal(r.status, 400); assert.match(r.data.error, /easy to guess/);
  r = await b.put('/lock', { code: '12a456', password: PWJ });
  assert.equal(r.status, 400);
  r = await b.put('/lock', { code: '482916', password: PWJ, mins: 5, showNew: 'who' });
  assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(r.data.on, true); assert.equal(r.data.mins, 5);
  assert.ok(!('hash' in r.data), 'the hash never leaves the server');
  const row = await user('jun@example.com');
  assert.match(row.screen_lock.hash, /^\$2[aby]\$10\$/); assert.ok(!JSON.stringify(row.screen_lock).includes('482916'), 'the code is not stored');
  const log = JSON.stringify(await q("select action, detail from audit_log where action like 'lock.%'"));
  assert.ok(log.includes('lock.code_set') && !log.includes('482916'), 'audited without the code');
  // The time and what shows change without the password.
  r = await b.put('/lock', { mins: 10 }); assert.equal(r.status, 200); assert.equal(r.data.mins, 10);
  assert.equal((await b.get('/me')).data.lock.on, true);

  // New items on Home are on, so something arrives while locked.
  r = await b.patch('/me', { appearance: { glance: { on: true, events: 5, mail: 5, chats: 5, notes: 5, remind: 0 } } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  // Already checked ten minutes ago, so the calendar's event now counts as new.
  await q("insert into glance_state (user_id, checked, seen, upcoming) values ($1, $2, '{}', '[]') on conflict (user_id) do update set checked = excluded.checked, seen = '{}'", [(await user('jun@example.com')).id, JSON.stringify({ events: Date.now() - 600_000 })]);
  r = await b.post('/lock/now'); assert.equal(r.status, 200);
  r = await b.get('/me');
  assert.equal(r.status, 200); assert.equal(r.data.locked, true); assert.equal(r.data.email, '', 'who the account is stays hidden'); assert.equal(r.data.name, null);
  for (const [m, p, body] of [['POST', '/chat', { message: 'hi', tz: 0 }], ['GET', '/calendars'], ['GET', '/me/passkeys'], ['POST', '/glance/reveal', { sealed: [] }], ['PATCH', '/me', { name: 'x' }], ['GET', '/billing/status']]) {
    r = await b.call(m, p, body);
    assert.equal(r.status, 423, `${m} ${p} is shut while locked (${r.status})`); assert.equal(r.data.locked, true);
  }
  r = await b.post('/glance', { tz: 0 });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.ok(r.data.items.length >= 1, 'the calendar item arrived: ' + JSON.stringify(r.data));
  assert.ok(!JSON.stringify(r.data).includes('Dentist'), 'only who it is from, nothing of what it says');
  const sealed = r.data.items.map((i) => i.sealed);
  assert.ok(sealed.every(Boolean));
  // Its settings can't be changed while locked, not even with the password: unlock first.
  assert.equal((await b.put('/lock', { on: false, password: PWJ })).status, 423);

  // Wrong codes count down; the right one unlocks and resets the count.
  r = await b.post('/lock/unlock', { code: '000001' });
  assert.equal(r.status, 400); assert.equal(r.data.left, 4);
  r = await b.post('/lock/unlock', { code: '482916' });
  assert.equal(r.status, 200); assert.equal(r.data.locked, false);
  assert.equal((await b.get('/calendars')).status, 200, 'open again');
  r = await b.post('/glance/reveal', { sealed: [...sealed, 'v1.bad.bad'] });
  assert.equal(r.status, 200); assert.ok(r.data.items[0].title.includes('Dentist'), 'opened in full after unlocking'); assert.equal(r.data.items.at(-1), null);
  // Someone else's sealed items open to nothing.
  const other = new Browser();
  assert.equal((await other.post('/auth/sign-in', { email: 'lee@example.com', password: PW })).status, 200);
  r = await other.post('/glance/reveal', { sealed });
  assert.ok(r.status !== 200 || r.data.items.every((x) => x === null), 'not for another account');

  // Idle: no use reported for longer than the lock's time locks this sign-in on its next request.
  await q("update sessions set seen_at = now() - interval '11 minutes' where user_id = $1", [row.id]);
  assert.equal((await b.get('/calendars')).status, 423, 'locked after being left alone');
  assert.equal((await b.post('/lock/unlock', { code: '482916' })).status, 200);
  r = await b.post('/lock/seen'); assert.equal(r.status, 200);
  // The app's idle timer doesn't lock a sign-in that was just used (in another tab); it does once it has been left.
  r = await b.post('/lock/now', { idle: true }); assert.equal(r.data.locked, false);
  await q("update sessions set seen_at = now() - interval '9 minutes 50 seconds' where user_id = $1", [row.id]);
  r = await b.post('/lock/now', { idle: true }); assert.equal(r.data.locked, true);
  assert.equal((await b.post('/lock/unlock', { code: '482916' })).status, 200);

  // Unlocking with a passkey: a software authenticator signs the challenge exactly as a browser's passkey does.
  {
    const { generateKeyPairSync, sign: signData, createHash: hash } = await import('node:crypto');
    const kp = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const jwk = kp.publicKey.export({ format: 'jwk' });
    const bx = Buffer.from(jwk.x, 'base64url'), by = Buffer.from(jwk.y, 'base64url');
    const cose = Buffer.concat([Buffer.from([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20]), bx, Buffer.from([0x22, 0x58, 0x20]), by]);
    const credId = randomBytes(16).toString('base64url');
    await q('insert into passkeys (user_id, credential_id, public_key, counter, rp_id) values ($1, $2, $3, 0, $4)', [row.id, credId, cose.toString('base64'), 'niko.test']);
    const assertion = (challenge, counter = 1) => {
      const authData = Buffer.concat([hash('sha256').update('niko.test').digest(), Buffer.from([0x05]), Buffer.from([0, 0, 0, counter])]);
      const cdj = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge, origin: ORIGIN, crossOrigin: false }));
      const sig = signData('sha256', Buffer.concat([authData, hash('sha256').update(cdj).digest()]), kp.privateKey);
      return { id: credId, rawId: credId, type: 'public-key', clientExtensionResults: {}, response: { clientDataJSON: cdj.toString('base64url'), authenticatorData: authData.toString('base64url'), signature: sig.toString('base64url') } };
    };
    assert.equal((await b.post('/lock/passkey/options')).status, 400, 'not while unlocked: nothing to unlock');
    await b.post('/lock/now');
    r = await b.post('/lock/passkey/options');
    assert.equal(r.status, 200, 'options: ' + JSON.stringify(r.data));
    assert.deepEqual(r.data.options.allowCredentials.map((x) => x.id), [credId], 'only this account’s passkeys are offered');
    // Signed for another challenge: refused, still locked.
    const bad = await b.post('/lock/passkey/verify', { challengeId: r.data.challengeId, response: assertion(randomBytes(32).toString('base64url')) });
    assert.equal(bad.status, 401); assert.equal((await b.get('/calendars')).status, 423);
    r = await b.post('/lock/passkey/options');
    const good = await b.post('/lock/passkey/verify', { challengeId: r.data.challengeId, response: assertion(r.data.options.challenge, 2) });
    assert.equal(good.status, 200, 'verify: ' + JSON.stringify(good.data)); assert.equal(good.data.locked, false);
    assert.equal((await b.get('/calendars')).status, 200, 'unlocked with the passkey');
    // The same signed answer can't be used again (the challenge is gone).
    await b.post('/lock/now');
    assert.equal((await b.post('/lock/passkey/verify', { challengeId: r.data.challengeId, response: assertion(r.data.options.challenge, 3) })).status, 401);
    // Turned off in settings: refused.
    assert.equal((await b.post('/lock/unlock', { code: '482916' })).status, 200);
    assert.equal((await b.put('/lock', { passkey: false })).status, 200);
    await b.post('/lock/now');
    assert.equal((await b.post('/lock/passkey/options')).status, 400);
    assert.equal((await b.post('/lock/unlock', { code: '482916' })).status, 200);
  }

  // Five wrong codes end the sign-in.
  await b.post('/lock/now');
  for (let i = 1; i <= 4; i++) assert.equal((await b.post('/lock/unlock', { code: '111112' })).data.left, 5 - i);
  r = await b.post('/lock/unlock', { code: '111112' });
  assert.equal(r.status, 401); assert.equal(r.data.signedOut, true);
  assert.equal((await b.get('/me')).status, 401, 'signed out');
  assert.ok(JSON.stringify(await q("select action from audit_log where action = 'lock.signed_out'")).includes('signed_out'));

  // Signing in again starts unlocked; turning the lock off with the password clears the code.
  assert.equal((await b.post('/auth/sign-in', { email: 'jun@example.com', password: PWJ })).status, 200);
  assert.equal((await b.get('/calendars')).status, 200);
  r = await b.put('/lock', { on: false, password: PWJ });
  assert.equal(r.status, 200); assert.equal(r.data.on, false);
  assert.ok(!(await user('jun@example.com')).screen_lock.hash, 'the code is gone');
});

// ---------------------------------------------------------------- set up Niko per person: included keys and monthly amounts
await ok('included services: the admin’s key is kept sealed, given through an invite, counted, capped, and never shown', async () => {
  const ADMIN_KEY = 'gsk_admin_secret_key_1234';
  // Members can't reach any of it.
  const member = new Browser();
  assert.equal((await member.post('/auth/sign-in', { email: 'nur@example.com', password: PW })).status, 200);
  assert.ok([401, 403].includes((await member.get('/admin/setup/keys')).status));

  // Added once: checked with the service first, then kept sealed. Only the service, model and last 4 come back.
  aiCalls.length = 0;
  let r = await admin.post('/admin/setup/keys', { kind: 'brain', key: { baseUrl: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile', apiKey: ADMIN_KEY } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(aiCalls.at(-1).auth, `Bearer ${ADMIN_KEY}`, 'tested with the service it is for');
  const pid = r.data.key.id;
  assert.match(pid, /^px[a-z0-9]{10}$/);
  assert.ok(!JSON.stringify(r.data).includes(ADMIN_KEY));
  const row = (await q('select * from provided_keys where id = $1', [pid]))[0];
  assert.ok(!row.secret_enc.includes(ADMIN_KEY) && !JSON.stringify(row.info).includes(ADMIN_KEY), 'sealed in the database');
  assert.equal(row.info.hint, '1234');
  r = await admin.get('/admin/setup/keys');
  assert.ok(!JSON.stringify(r.data).includes(ADMIN_KEY) && r.data.keys.some((k) => k.id === pid));
  assert.equal((await admin.post('/admin/setup/keys', { kind: 'brain', key: { baseUrl: 'http://10.0.0.1/v1', model: 'm', apiKey: 'k' } })).status, 400, 'only public https');

  // Set up before they join: their key first and fixed, Workers AI removed, 100 answers a month.
  await admin.post('/admin/invites', { email: 'ivy@example.com', access: 'life' });
  const inv = (await admin.get('/admin/users?show=invited&q=ivy')).data.items[0];
  assert.equal((await admin.put(`/admin/setup/invite/${inv.id}`, { keys: { brain: [] }, builtins: { brain: false } })).status, 200, 'with nothing included, they bring their own key');
  r = await admin.put(`/admin/setup/invite/${inv.id}`, { keys: { brain: [pid, 'pxnotakeyxxx'] }, order: 'fixed', builtins: { brain: false }, limits: { brain: 100 } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  r = await admin.get(`/admin/setup/invite/${inv.id}`);
  assert.deepEqual(r.data.setup.keys.brain, [pid], 'only kept keys');
  assert.equal(r.data.builtins.brain, false); assert.equal(r.data.limits.brain, 100);
  const e = lastEmail('ivy@example.com');
  const ivy = new Browser();
  await ivy.post(`/auth/invite/${inviteToken(e.html)}/code`, { code: inviteCode(e.html) });
  assert.equal((await ivy.post(`/auth/invite/${inviteToken(e.html)}`, { name: 'Ivy', password: PW })).status, 200);
  const u = await user('ivy@example.com');
  assert.deepEqual(u.provided.keys.brain, [pid]); assert.equal(u.provided.order, 'fixed');
  assert.equal(u.account_limits.brain, 100); assert.equal(u.ai_access['workers-ai'], false);
  assert.equal(u.engine.brains[0], `key:${pid}`);

  // Ivy sees it as included, without the key, and can't change or remove it.
  r = await ivy.get('/engine/keys');
  const shownKey = r.data.keys.find((k) => k.id === pid);
  assert.equal(shownKey.provided, true); assert.ok(!JSON.stringify(r.data).includes(ADMIN_KEY) && !('apiKey' in shownKey));
  assert.equal((await ivy.post('/engine/keys', { id: pid, baseUrl: 'https://evil.example.com/v1', model: 'x', apiKey: '' })).status, 404, 'not one of her own keys');
  await ivy.del(`/engine/keys/${pid}`);
  assert.ok((await ivy.get('/engine/keys')).data.keys.some((k) => k.id === pid), 'still there');
  assert.ok(!(await q("select count(*)::int as n from connections where user_id = $1 and provider = 'custom-ai'", [u.id]))[0]?.n || !JSON.stringify(await q('select * from connections where user_id = $1', [u.id])).includes(pid), 'never saved into her own keys');

  // Answers come from the included key, sent only to its service, and are counted.
  aiCalls.length = 0;
  r = await ivy.post('/chat', { message: 'hello', tz: 0 });
  assert.equal(r.status, 200, JSON.stringify(r.data)); assert.match(r.data.reply, /included key/);
  assert.ok(aiCalls.every((c) => c.host === 'api.groq.com' && c.auth === `Bearer ${ADMIN_KEY}`));
  let counts = await q('select entry, n from usage_counts where user_id = $1 and kind = $2', [u.id, 'brain']);
  assert.deepEqual(counts, [{ entry: `key:${pid}`, n: 1 }]);
  r = await ivy.get('/usage');
  assert.equal(r.data.kinds.brain.limit, 100); assert.equal(r.data.kinds.brain.included, 1); assert.equal(r.data.kinds.brain.own, 0);
  assert.equal(r.data.plan.order, 'fixed'); assert.equal(r.data.plan.builtins.brain, false); assert.equal(r.data.plan.provided.brain.length, 1);
  assert.ok(!JSON.stringify(r.data).includes(ADMIN_KEY) && !/admin/i.test(JSON.stringify(r.data)), 'no key, and no mention of an admin');

  // At the month's amount: with no key of her own, Niko says when it comes back.
  await q('update usage_counts set n = 100 where user_id = $1', [u.id]);
  aiCalls.length = 0;
  r = await ivy.post('/chat', { message: 'hello again', tz: 0 });
  assert.equal(r.status, 429); assert.equal(r.data.usedUp, true); assert.match(r.data.error, /100 included answers/);
  assert.equal(aiCalls.length, 0, 'the included key is not used past the amount');

  // With her own key, Niko goes on with it. Her key is never counted towards what’s included, and is never capped.
  r = await ivy.post('/engine/keys', { baseUrl: 'https://openrouter.ai/api/v1', model: 'meta-llama/llama-3.3-70b-instruct', apiKey: 'sk-or-own-9999' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const own = r.data.key.id;
  // Fixed: the included key stays first even when she puts hers above it.
  r = await ivy.patch('/me', { engine: { brains: [`key:${own}`, `key:${pid}`] } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual((await user('ivy@example.com')).engine.brains, [`key:${pid}`, `key:${own}`]);
  aiCalls.length = 0;
  r = await ivy.post('/chat', { message: 'and now', tz: 0 });
  assert.equal(r.status, 200, JSON.stringify(r.data)); assert.match(r.data.reply, /own key/);
  assert.ok(aiCalls.every((c) => c.host === 'openrouter.ai' && c.auth === 'Bearer sk-or-own-9999'), 'the admin key went nowhere');
  counts = Object.fromEntries((await q('select entry, n from usage_counts where user_id = $1', [u.id])).map((x) => [x.entry, x.n]));
  assert.equal(counts[`key:${pid}`], 100); assert.equal(counts[`key:${own}`], 1);

  // What OpenRouter reports for her own key is shown, asked with her key only, at most every five minutes.
  aiCalls.length = 0;
  r = await ivy.get('/usage');
  assert.equal(r.data.kinds.brain.own, 1);
  assert.match(r.data.reports[`key:${own}`].head, /OpenRouter says: \$25\.50/);
  assert.deepEqual(aiCalls.map((c) => [c.path, c.auth]), [['/api/v1/key', 'Bearer sk-or-own-9999']]);
  aiCalls.length = 0; await ivy.get('/usage');
  assert.equal(aiCalls.length, 0, 'cached');
  assert.deepEqual(r.data.own.brain.map((k) => k.entry), [`key:${own}`]);

  // The Limits page shows this month's use and the invites' amounts.
  r = await admin.get('/admin/limits');
  assert.equal(r.data.users.find((x) => x.email === 'ivy@example.com').used.brain, 100);

  // Free order: she can put hers first. Removing the key takes it from everyone straight away.
  assert.equal((await admin.put(`/admin/setup/user/${u.id}`, { keys: { brain: [pid] }, order: 'free', builtins: { brain: false } })).status, 200);
  await ivy.patch('/me', { engine: { brains: [`key:${own}`, `key:${pid}`] } });
  assert.deepEqual((await user('ivy@example.com')).engine.brains, [`key:${own}`, `key:${pid}`]);
  // AI options decide: the setup never turns back on what they turn off.
  assert.equal((await admin.put('/admin/ai/default', { access: { 'workers-ai': false, 'img:workers': false } })).status, 200);
  r = await admin.get(`/admin/setup/user/${u.id}`);
  assert.equal(r.data.builtins.brain, false); assert.equal(r.data.builtins.image, false);
  r = await admin.put(`/admin/setup/user/${u.id}`, { keys: { brain: [pid] }, builtins: { brain: true } });
  assert.equal(r.status, 400); assert.match(r.data.error, /AI options/);
  // Off by default but on for her: the setup may use it.
  assert.equal((await admin.put(`/admin/ai/users/${u.id}`, { access: { 'workers-ai': true } })).status, 200);
  assert.equal((await admin.get(`/admin/setup/user/${u.id}`)).data.builtins.brain, true);
  // A key for a service AI options turn off for her isn't given, here or through "Also give it to".
  assert.equal((await admin.put(`/admin/ai/users/${u.id}`, { access: { 'workers-ai': true, 'ai:groq': false } })).status, 200);
  assert.equal((await admin.put(`/admin/setup/user/${u.id}`, { keys: { brain: ['builtin', pid] }, builtins: { brain: true } })).status, 200);
  assert.deepEqual((await user('ivy@example.com')).provided.keys.brain, ['builtin']);
  r = await admin.post('/admin/setup/keys', { kind: 'brain', key: { baseUrl: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile', apiKey: 'gsk_second_key_5678' }, give: { users: [u.id] } });
  assert.equal(r.status, 200); assert.equal(r.data.given, 0); assert.equal(r.data.skipped, 1);
  assert.equal((await admin.del(`/admin/setup/keys/${r.data.key.id}`)).status, 200);
  await admin.put(`/admin/ai/users/${u.id}`, { access: {} }); await admin.put('/admin/ai/default', { access: {} });

  // Workers AI can sit anywhere in the admin's list: here first, then the included key.
  assert.equal((await admin.put(`/admin/setup/user/${u.id}`, { keys: { brain: ['builtin', pid] }, order: 'fixed', builtins: { brain: true } })).status, 200);
  assert.deepEqual((await user('ivy@example.com')).engine.brains.slice(0, 2), ['workers-ai', `key:${pid}`]);
  assert.deepEqual((await user('ivy@example.com')).provided.keys.brain, ['builtin', pid]);
  assert.equal((await admin.get('/admin/users?q=ivy')).data.items[0].engineSetup.keys, 1, 'the built-in is not counted as a key');
  assert.equal((await admin.del(`/admin/setup/keys/${pid}`)).status, 200);
  assert.deepEqual((await user('ivy@example.com')).provided.keys, { brain: ['builtin'] }, 'the key is gone; Workers AI keeps its place');
  assert.ok(!(await user('ivy@example.com')).engine.brains.includes(`key:${pid}`));
  assert.ok(!(await ivy.get('/engine/keys')).data.keys.some((k) => k.id === pid));
  assert.equal((await q('select count(*)::int as n from provided_keys')).at(0).n, 0);
  const log = JSON.stringify(await q("select action, detail from audit_log where action like 'provided-key.%' or action like 'setup.%'"));
  assert.ok(log.includes('provided-key.added') && log.includes('setup.invite') && log.includes('provided-key.removed') && !log.includes(ADMIN_KEY), 'audited without the key');
});

// ---------------------------------------------------------------- designs
// Choose your Niko: the admin's offer, one-time unlocks, the bundle (with credit), pro-rated new designs for bundle
// owners (including designs switched off and on again), retired designs kept by owners, gifts, and the Niko Pro add-on.
const member = async (email, extra = {}) => {
  const [u] = await q(`insert into users (email, name, role, status, lifetime, access_until, access_kind) values ($1, $2, 'member', 'active', false, now() + interval '200 days', 'paid') returning id`, [email, email.split('@')[0]]);
  for (const [k, v] of Object.entries(extra)) await q(`update users set ${k} = $2 where id = $1`, [u.id, v]);
  const token = randomBytes(24).toString('hex');
  await q(`insert into sessions (user_id, token_hash, kind, expires_at) values ($1, $2, 'app', now() + interval '1 hour')`, [u.id, createHash('sha256').update(token).digest('hex')]);
  const b = new Browser(); b.jar.set('__Host-niko', token); b.id = u.id;
  return b;
};
let payMode = 'test';
const paidSession = (id, over = {}) => ({ ...sessions.get(id), payment_status: 'paid', status: 'complete', ...over });
const designPay = async (b, what, design) => {
  const r = await b.post('/designs/checkout', { what, design });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const id = r.data.url.split('/').pop();
  assert.equal(await webhook('checkout.session.completed', paidSession(id), { secret: made[payMode] }), 200);
  return id;
};
const owns = async (id) => (await q('select design, source, cents from design_owned where user_id = $1 order by design', [id])).map((r) => `${r.design}:${r.source}${r.cents ? ':' + r.cents : ''}`);
const view = async (b) => (await b.get('/designs')).data;
const find = (v, id) => v.designs.find((d) => d.id === id);
const designsBase = (over = {}) => ({
  designs: { prism: { on: true, paid: true, cents: 400 }, ribbon: { on: true, paid: true, cents: 600 }, flux: { on: true, paid: true, cents: 500 }, aurora: { on: true, paid: false }, ...over },
  bundleCents: 1000, credit: true, rate: 'saving', percent: 30, pro: { on: true, monthly: 300, yearly: 3000 },
});
let dana, eli, fay;

await ok('designs: nothing offered until the admin says; prices are checked before saving', async () => {
  payMode = (await admin.get('/admin/payments')).data.mode;
  dana = await member('dana@example.com');
  let v = await view(dana);
  assert.deepEqual(v.designs.map((d) => d.id), ['nebula']); assert.equal(v.current, 'nebula');
  assert.equal((await dana.get('/me')).data.design, 'nebula');
  let r = await admin.put('/admin/designs', { settings: { designs: { prism: { on: true, paid: true } } } });
  assert.equal(r.status, 400); assert.match(r.data.error, /Prism a price/);
  r = await admin.put('/admin/designs', { settings: { ...designsBase(), bundleCents: 2000 } });
  assert.equal(r.status, 400); assert.match(r.data.error, /bundle should cost less/);
  r = await admin.put('/admin/designs', { settings: { ...designsBase(), designs: { ...designsBase().designs, prism: { on: true, paid: true, cents: 400, everOn: false, wasOff: true } } } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.settings.designs.prism.wasOff, false, 'the admin can’t set the server’s own record');
  assert.equal(r.data.settings.designs.prism.everOn, true);
  r = await admin.get('/admin/designs');
  assert.equal(r.data.designs.length, 20);
});

await ok('designs: a person sees offered designs with prices; locked ones can’t be used; included ones can', async () => {
  const v = await view(dana);
  assert.deepEqual(v.designs.map((d) => d.id), ['nebula', 'prism', 'ribbon', 'flux', 'aurora']);
  assert.equal(find(v, 'prism').state, 'locked'); assert.equal(find(v, 'prism').cents, 400);
  assert.equal(find(v, 'aurora').state, 'included');
  assert.deepEqual(v.bundle, { count: 3, cents: 1000 });
  assert.equal(v.pro.offered, false, 'no Niko Pro during pay-once time');
  assert.equal((await dana.post('/designs/use', { design: 'prism' })).status, 403);
  assert.equal((await dana.post('/designs/use', { design: 'not-a-design' })).status, 400);
  assert.equal((await dana.post('/designs/use', { design: 'aurora' })).status, 200);
  assert.equal((await dana.get('/me')).data.design, 'aurora');
  // A settings save can't set the design (only /designs/use can, after its checks).
  const me = (await dana.get('/me')).data;
  await dana.patch('/me', { appearance: { ...me.appearance, design: 'prism' } });
  assert.equal((await user('dana@example.com')).appearance.design, 'aurora');
});

await ok('designs: one design unlocks once Stripe confirms the amount Niko asked for; resent events count once', async () => {
  const r = await dana.post('/designs/checkout', { what: 'one', design: 'prism' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const id = r.data.url.split('/').pop();
  const call = stripeCalls.filter((c) => c.path === '/checkout/sessions').at(-1);
  assert.equal(call.p['line_items[0][price_data][unit_amount]'], '400');
  assert.equal(call.p['metadata[kind]'], 'design');
  assert.match(call.p.success_url, /\/niko\?design=\{CHECKOUT_SESSION_ID\}$/);
  // Unpaid, a different amount, or another account's id: nothing unlocks.
  assert.equal(await webhook('checkout.session.completed', sessions.get(id), { secret: made[payMode] }), 200);
  assert.equal(await webhook('checkout.session.completed', paidSession(id, { amount_total: 1 }), { secret: made[payMode] }), 200);
  assert.equal(await webhook('checkout.session.completed', paidSession(id, { metadata: { ...sessions.get(id).metadata, user_id: ownerId } }), { secret: made[payMode] }), 200);
  assert.deepEqual(await owns(dana.id), []);
  assert.equal(await webhook('checkout.session.completed', paidSession(id), { secret: made[payMode] }), 200);
  assert.equal(await webhook('checkout.session.completed', paidSession(id), { secret: made[payMode] }), 200);
  assert.deepEqual(await owns(dana.id), ['prism:single:400']);
  const st = await dana.get(`/designs/status?session=${id}`);
  assert.equal(st.data.paid, true); assert.deepEqual(st.data.bought, { kind: 'one', designs: ['prism'] });
  assert.equal(find(st.data, 'prism').state, 'owned');
  assert.equal((await dana.post('/designs/use', { design: 'prism' })).status, 200);
  // Something a screen invents is refused: buying what's owned, an unknown design, or a price for bundle owners.
  assert.equal((await dana.post('/designs/checkout', { what: 'one', design: 'prism' })).status, 400);
  assert.equal((await dana.post('/designs/checkout', { what: 'topup', design: 'ribbon' })).status, 400);
  assert.equal((await dana.post('/designs/checkout', { what: 'free' })).status, 400);
});

await ok('designs: the bundle counts what was already paid, and covers what is offered that day', async () => {
  let v = await view(dana);
  assert.deepEqual(v.bundle, { count: 2, cents: 600 }, 'SGD 10 less the SGD 4 already paid');
  await designPay(dana, 'all');
  assert.deepEqual(await owns(dana.id), ['flux:bundle', 'prism:single:400', 'ribbon:bundle']);
  assert.ok((await user('dana@example.com')).design_bundle_at);
  v = await view(dana);
  assert.equal(v.bundleOwner, true); assert.equal(v.bundle, null);
});

await ok('designs: new designs are pro-rated for bundle owners; switched off, owners keep them; switched back on, they’re new', async () => {
  eli = await member('eli@example.com');
  // A new design (Vortex) and Flux switched off.
  let r = await admin.put('/admin/designs', { settings: designsBase({ vortex: { on: true, paid: true, cents: 800 }, flux: { on: false, paid: true, cents: 500 } }) });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.settings.designs.flux.wasOff, true);
  let v = await view(dana);
  assert.equal(find(v, 'flux').state, 'owned'); assert.equal(find(v, 'flux').retired, true, 'kept, marked retired');
  // Saving: 1 - 1000 / (400 + 600 + 800) = 44.4% off Vortex's SGD 8.
  assert.equal(find(v, 'vortex').fresh, true); assert.equal(find(v, 'vortex').cents, 444); assert.equal(find(v, 'vortex').full, 800);
  v = await view(eli);
  assert.equal(find(v, 'flux'), undefined, 'hidden from people who don’t own it');
  assert.equal(find(v, 'vortex').cents, 800, 'full price for everyone else');
  assert.deepEqual(v.bundle, { count: 3, cents: 1000 });
  // Fay buys the bundle while Flux is off: it isn't in her bundle.
  fay = await member('fay@example.com');
  await designPay(fay, 'all');
  assert.deepEqual(await owns(fay.id), ['prism:bundle', 'ribbon:bundle', 'vortex:bundle']);
  r = await admin.put('/admin/designs', { settings: designsBase({ vortex: { on: true, paid: true, cents: 800 }, flux: { on: true, paid: true, cents: 500 } }) });
  assert.equal(r.data.settings.designs.flux.wasOff, true, 'remembered: it came back');
  v = await view(fay);
  assert.equal(find(v, 'flux').fresh, true); assert.equal(find(v, 'flux').back, true);
  assert.equal(find(v, 'flux').cents, Math.round(500 * (1000 / 2300)), 'pro-rated with the bundle’s saving');
  assert.equal(find(await view(dana), 'flux').state, 'owned', 'Dana bought it before: still hers');
  // A set percentage off, and the top-up paid for.
  r = await admin.put('/admin/designs', { settings: { ...designsBase({ vortex: { on: true, paid: true, cents: 800 }, flux: { on: true, paid: true, cents: 500 } }), rate: 'percent', percent: 30 } });
  assert.equal(find(await view(fay), 'flux').cents, 350);
  await designPay(fay, 'topup', 'flux');
  assert.ok((await owns(fay.id)).includes('flux:topup'));
  const co = (await q(`select cents from design_checkouts where user_id = $1 and kind = 'topup'`, [fay.id]))[0];
  assert.equal(co.cents, 350);
});

await ok('designs: Niko Pro only on an active plan, charged to that plan; off again, designs not bought go back to Nebula', async () => {
  assert.equal((await dana.post('/designs/pro')).status, 400, 'pay-once time');
  // A plan chosen during pay-once time is trialing until that time ends: still no Niko Pro.
  await q(`update users set sub_id = 'sub_eli', sub_status = 'trialing', sub_plan = 'monthly', sub_mode = $2 where id = $1`, [eli.id, payMode]);
  assert.equal((await view(eli)).pro.offered, false);
  const end = Math.floor(Date.now() / 1000) + 20 * 86400;
  subs.set('sub_eli', { id: 'sub_eli', status: 'active', customer: 'cus_eli', metadata: { user_id: eli.id, plan: 'monthly' }, current_period_end: end, items: { data: [{ id: 'si_eli_plan', current_period_end: end, price: { recurring: { interval: 'month' } } }] } });
  assert.equal(await webhook('customer.subscription.updated', subs.get('sub_eli'), { secret: made[payMode] }), 200);
  let v = await view(eli);
  assert.equal(v.pro.offered, true); assert.equal(v.pro.cents, 300); assert.equal(v.pro.plan, 'monthly');
  // The card can't pay: nothing is added.
  subs.get('sub_eli').declines = true;
  let r = await eli.post('/designs/pro');
  assert.equal(r.status, 402); assert.match(r.data.error, /nothing was added/);
  assert.equal((await user('eli@example.com')).pro_on, false);
  subs.get('sub_eli').declines = false;
  r = await eli.post('/designs/pro');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const add = stripeCalls.filter((c) => c.path === '/subscription_items').at(-1);
  assert.equal(add.p.subscription, 'sub_eli'); assert.equal(add.p['price_data[unit_amount]'], '300'); assert.equal(add.p['price_data[recurring][interval]'], 'month');
  assert.equal(add.p.proration_behavior, 'always_invoice'); assert.equal(add.p.payment_behavior, 'error_if_incomplete');
  assert.equal(r.data.pro.active, true); assert.equal(find(r.data, 'vortex').state, 'pro');
  assert.equal((await eli.post('/designs/use', { design: 'vortex' })).status, 200);
  // Stripe's own updates keep it in step; the plan is still read from the plan's item, not the add-on's.
  assert.equal(await webhook('customer.subscription.updated', subs.get('sub_eli'), { secret: made[payMode] }), 200);
  let u = await user('eli@example.com');
  assert.equal(u.pro_on, true); assert.equal(u.sub_plan, 'monthly'); sameDay(u.sub_period_end, new Date(end * 1000));
  assert.equal((await eli.post('/designs/pro')).status, 409);
  // Removed: unused time is credited; Vortex wasn't bought, so Nebula comes back.
  r = await eli.del('/designs/pro');
  assert.equal(r.status, 200);
  const del = stripeCalls.filter((c) => c.method === 'DELETE' && c.path.startsWith('/subscription_items/')).at(-1);
  assert.equal(del.p.proration_behavior, 'create_prorations');
  assert.equal((await eli.get('/me')).data.design, 'nebula');
  assert.equal(await webhook('customer.subscription.updated', subs.get('sub_eli'), { secret: made[payMode] }), 200);
  assert.equal((await user('eli@example.com')).pro_on, false);
  // Ending the plan ends the add-on too.
  await eli.post('/designs/pro');
  assert.equal(await webhook('customer.subscription.deleted', { ...subs.get('sub_eli'), status: 'canceled' }, { secret: made[payMode] }), 200);
  u = await user('eli@example.com');
  assert.equal(u.pro_on, false);
});

await ok('designs: admins give a design (even one not offered) and can take back only gifts; admins have every design', async () => {
  let r = await admin.post(`/admin/users/${eli.id}/designs`, { design: 'swarm' });
  assert.equal(r.status, 200);
  assert.equal((await admin.post(`/admin/users/${eli.id}/designs`, { design: 'swarm' })).status, 409);
  let v = await view(eli);
  assert.equal(find(v, 'swarm').state, 'owned'); assert.equal(find(v, 'swarm').retired, true);
  assert.equal((await eli.post('/designs/use', { design: 'swarm' })).status, 200);
  assert.equal((await admin.del(`/admin/users/${dana.id}/designs/prism`)).status, 400, 'paid designs stay theirs');
  assert.equal((await admin.del(`/admin/users/${eli.id}/designs/swarm`)).status, 200);
  assert.equal((await eli.get('/me')).data.design, 'nebula');
  r = await admin.get(`/admin/users/${dana.id}/designs`);
  assert.equal(r.data.owned.length, 3); assert.ok(r.data.bundle);
  v = await view(owner);
  assert.equal(v.designs.length, 20); assert.ok(v.designs.every((d) => d.state !== 'locked'));
  assert.equal((await owner.post('/designs/use', { design: 'iris' })).status, 200);
  assert.equal((await owner.post('/designs/checkout', { what: 'one', design: 'prism' })).status, 400);
  const log = JSON.stringify(await q(`select action from audit_log where action like '%design%'`));
  assert.ok(['payment.design', 'design.checkout', 'design.pro_on', 'design.pro_off', 'admin.designs', 'admin.design_gift', 'admin.design_ungift'].every((a) => log.includes(a)));
});


// ---------------------------------------------------------------- backgrounds
// The same rules as designs, for the background behind Niko: the admin's offer, one-time unlocks, the bundle (with
// credit), pro-rated new backgrounds for bundle owners, retired backgrounds kept by owners, gifts, and Niko Pro (one
// add-on, priced with designs) covering backgrounds unless the admin leaves them out.
const bgPay = async (b, what, background) => {
  const r = await b.post('/backgrounds/checkout', { what, background });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const id = r.data.url.split('/').pop();
  assert.equal(await webhook('checkout.session.completed', paidSession(id), { secret: made[payMode] }), 200);
  return id;
};
const bgOwns = async (id) => (await q('select background, source, cents from background_owned where user_id = $1 order by background', [id])).map((r) => `${r.background}:${r.source}${r.cents ? ':' + r.cents : ''}`);
const bgView = async (b) => (await b.get('/backgrounds')).data;
const bgFind = (v, id) => v.backgrounds.find((d) => d.id === id);
const bgBase = (over = {}, extra = {}) => ({
  backgrounds: { aurora: { on: true, paid: true, cents: 300 }, stars: { on: true, paid: true, cents: 300 }, silk: { on: true, paid: true, cents: 400 }, dust: { on: true, paid: false }, ...over },
  bundleCents: 700, credit: true, rate: 'saving', percent: 30, pro: true, ...extra,
});
let gia, hal;

await ok('backgrounds: nothing offered until the admin says; prices are checked before saving', async () => {
  gia = await member('gia@example.com');
  let v = await bgView(gia);
  assert.deepEqual(v.backgrounds.map((d) => d.id), ['glow']); assert.equal(v.current, 'glow');
  assert.equal((await gia.get('/me')).data.background, 'glow');
  let r = await admin.put('/admin/backgrounds', { settings: { backgrounds: { aurora: { on: true, paid: true } } } });
  assert.equal(r.status, 400); assert.match(r.data.error, /Aurora a price/);
  r = await admin.put('/admin/backgrounds', { settings: bgBase({}, { bundleCents: 5000 }) });
  assert.equal(r.status, 400); assert.match(r.data.error, /bundle should cost less/);
  r = await admin.put('/admin/backgrounds', { settings: bgBase({ aurora: { on: true, paid: true, cents: 300, wasOff: true, everOn: false } }) });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.settings.backgrounds.aurora.wasOff, false, 'the admin can’t set the server’s own record');
  r = await admin.get('/admin/backgrounds');
  assert.equal(r.data.backgrounds.length, 20); assert.ok(r.data.proPrice);
});

await ok('backgrounds: locked ones can’t be used, included ones can, and a settings save can’t set one', async () => {
  const v = await bgView(gia);
  assert.deepEqual(v.backgrounds.map((d) => d.id), ['glow', 'aurora', 'stars', 'dust', 'silk']);
  assert.equal(bgFind(v, 'aurora').state, 'locked'); assert.equal(bgFind(v, 'aurora').cents, 300);
  assert.equal(bgFind(v, 'dust').state, 'included');
  assert.deepEqual(v.bundle, { count: 3, cents: 700 });
  assert.equal((await gia.post('/backgrounds/use', { background: 'aurora' })).status, 403);
  assert.equal((await gia.post('/backgrounds/use', { background: 'nope' })).status, 400);
  assert.equal((await gia.post('/backgrounds/use', { background: 'dust' })).status, 200);
  assert.equal((await gia.get('/me')).data.background, 'dust');
  const me = (await gia.get('/me')).data;
  await gia.patch('/me', { appearance: { ...me.appearance, background: 'aurora', bgMotion: false } });
  const a = (await user('gia@example.com')).appearance;
  assert.equal(a.background, 'dust'); assert.equal(a.bgMotion, false, 'Move with Niko is an ordinary setting');
});

await ok('backgrounds: one unlocks once Stripe confirms the amount Niko asked for; resent events count once', async () => {
  const r = await gia.post('/backgrounds/checkout', { what: 'one', background: 'aurora' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const id = r.data.url.split('/').pop();
  const call = stripeCalls.filter((c) => c.path === '/checkout/sessions').at(-1);
  assert.equal(call.p['line_items[0][price_data][unit_amount]'], '300');
  assert.equal(call.p['metadata[kind]'], 'background');
  assert.match(call.p.success_url, /\/backgrounds\?bought=\{CHECKOUT_SESSION_ID\}$/);
  assert.equal(await webhook('checkout.session.completed', sessions.get(id), { secret: made[payMode] }), 200);
  assert.equal(await webhook('checkout.session.completed', paidSession(id, { amount_total: 1 }), { secret: made[payMode] }), 200);
  assert.equal(await webhook('checkout.session.completed', paidSession(id, { metadata: { ...sessions.get(id).metadata, user_id: ownerId } }), { secret: made[payMode] }), 200);
  assert.deepEqual(await bgOwns(gia.id), []);
  assert.equal(await webhook('checkout.session.completed', paidSession(id), { secret: made[payMode] }), 200);
  assert.equal(await webhook('checkout.session.completed', paidSession(id), { secret: made[payMode] }), 200);
  assert.deepEqual(await bgOwns(gia.id), ['aurora:single:300']);
  assert.deepEqual(await owns(gia.id), [], 'a background is not a design');
  const st = await gia.get(`/backgrounds/status?session=${id}`);
  assert.equal(st.data.paid, true); assert.deepEqual(st.data.bought, { kind: 'one', backgrounds: ['aurora'] });
  assert.equal((await gia.post('/backgrounds/use', { background: 'aurora' })).status, 200);
  assert.equal((await gia.get('/me')).data.background, 'aurora');
  assert.equal((await gia.post('/backgrounds/checkout', { what: 'one', background: 'aurora' })).status, 400);
  assert.equal((await gia.post('/backgrounds/checkout', { what: 'topup', background: 'stars' })).status, 400);
  assert.equal((await gia.post('/backgrounds/checkout', { what: 'free' })).status, 400);
  // A design Checkout id isn't a background one.
  assert.equal((await gia.get('/backgrounds/status?session=cs_test_nothing')).data.paid, false);
});

await ok('backgrounds: bundle with credit; new ones pro-rated; switched off, owners keep them; back on, they’re new', async () => {
  let v = await bgView(gia);
  assert.deepEqual(v.bundle, { count: 2, cents: 400 }, 'SGD 7 less the SGD 3 already paid');
  await bgPay(gia, 'all');
  assert.deepEqual(await bgOwns(gia.id), ['aurora:single:300', 'silk:bundle', 'stars:bundle']);
  assert.ok((await user('gia@example.com')).bg_bundle_at);
  // Bokeh is new; Stars is switched off (Gia keeps it), then back on later.
  let r = await admin.put('/admin/backgrounds', { settings: bgBase({ bokeh: { on: true, paid: true, cents: 500 }, stars: { on: false, paid: true, cents: 300 } }) });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  v = await bgView(gia);
  assert.equal(bgFind(v, 'stars').retired, true); assert.equal(bgFind(v, 'stars').state, 'owned');
  assert.equal(bgFind(v, 'bokeh').fresh, true);
  assert.equal(bgFind(v, 'bokeh').cents, Math.round(500 * 700 / 1200), 'the bundle’s saving: SGD 7 for the SGD 12 offered now');
  assert.equal((await gia.post('/backgrounds/use', { background: 'stars' })).status, 200, 'retired but bought');
  // Someone else doesn't see Stars at all.
  hal = await member('hal@example.com');
  assert.equal(bgFind(await bgView(hal), 'stars'), undefined);
  r = await admin.put('/admin/backgrounds', { settings: { ...bgBase({ bokeh: { on: true, paid: true, cents: 500 }, stars: { on: true, paid: true, cents: 300 } }), rate: 'percent', percent: 40 } });
  assert.equal(r.data.settings.backgrounds.stars.wasOff, true, 'remembered: it came back');
  v = await bgView(gia);
  assert.equal(bgFind(v, 'bokeh').cents, 300, '40% off SGD 5');
  assert.equal(bgFind(v, 'stars').state, 'owned', 'Gia already had it');
  await bgPay(gia, 'topup', 'bokeh');
  const co = (await q(`select cents from background_checkouts where user_id = $1 and kind = 'topup'`, [gia.id]))[0];
  assert.equal(co.cents, 300);
  assert.ok((await bgOwns(gia.id)).includes('bokeh:topup'));
});

await ok('backgrounds: Niko Pro covers them while it’s on, unless the admin leaves backgrounds out', async () => {
  const end = Math.floor(Date.now() / 1000) + 20 * 86400;
  await q(`update users set sub_id = 'sub_hal', sub_status = 'active', sub_plan = 'monthly', sub_mode = $2 where id = $1`, [hal.id, payMode]);
  subs.set('sub_hal', { id: 'sub_hal', status: 'active', customer: 'cus_hal', metadata: { user_id: hal.id, plan: 'monthly' }, current_period_end: end, items: { data: [{ id: 'si_hal_plan', current_period_end: end, price: { recurring: { interval: 'month' } } }] } });
  let v = await bgView(hal);
  assert.equal(v.pro.offered, true); assert.equal(v.pro.cents, 300); assert.equal(v.pro.covers, true);
  assert.equal((await hal.post('/designs/pro')).status, 200);
  v = await bgView(hal);
  assert.equal(v.pro.active, true); assert.equal(v.pro.offered, false);
  assert.equal(bgFind(v, 'silk').state, 'pro');
  assert.equal((await hal.post('/backgrounds/use', { background: 'silk' })).status, 200);
  assert.equal((await hal.post('/backgrounds/checkout', { what: 'one', background: 'silk' })).status, 400, 'nothing to buy with Pro');
  // Left out of Pro: Silk goes back to Glow for Hal; paid backgrounds would stay.
  let r = await admin.put('/admin/backgrounds', { settings: { ...bgBase({ bokeh: { on: true, paid: true, cents: 500 } }), pro: false } });
  assert.equal(r.status, 200);
  assert.equal((await hal.get('/me')).data.background, 'glow');
  assert.equal(bgFind(await bgView(hal), 'silk').state, 'locked');
  r = await admin.put('/admin/backgrounds', { settings: bgBase({ bokeh: { on: true, paid: true, cents: 500 } }) });
  assert.equal((await hal.get('/me')).data.background, 'silk');
  // Removing Niko Pro: Glow again.
  assert.equal((await hal.del('/designs/pro')).status, 200);
  assert.equal((await hal.get('/me')).data.background, 'glow');
});

await ok('backgrounds: admins give one (even one not offered), take back only gifts, and have every background', async () => {
  let r = await admin.post(`/admin/users/${hal.id}/backgrounds`, { background: 'peaks' });
  assert.equal(r.status, 200);
  assert.equal((await admin.post(`/admin/users/${hal.id}/backgrounds`, { background: 'peaks' })).status, 409);
  assert.equal((await admin.post(`/admin/users/${hal.id}/backgrounds`, { background: 'glow' })).status, 400);
  const v = await bgView(hal);
  assert.equal(bgFind(v, 'peaks').state, 'owned'); assert.equal(bgFind(v, 'peaks').retired, true);
  assert.equal((await hal.post('/backgrounds/use', { background: 'peaks' })).status, 200);
  assert.equal((await admin.del(`/admin/users/${gia.id}/backgrounds/aurora`)).status, 400, 'paid backgrounds stay theirs');
  assert.equal((await admin.del(`/admin/users/${hal.id}/backgrounds/peaks`)).status, 200);
  assert.equal((await hal.get('/me')).data.background, 'glow');
  r = await admin.get(`/admin/users/${gia.id}/backgrounds`);
  assert.equal(r.data.owned.length, 4); assert.ok(r.data.bundle);
  const ov = await bgView(owner);
  assert.equal(ov.backgrounds.length, 20); assert.ok(ov.backgrounds.every((d) => d.state !== 'locked'));
  assert.equal((await owner.post('/backgrounds/use', { background: 'equalizer' })).status, 200);
  assert.equal((await owner.post('/backgrounds/checkout', { what: 'one', background: 'aurora' })).status, 400);
  const log = JSON.stringify(await q(`select action from audit_log where action like '%background%'`));
  assert.ok(['payment.background', 'background.checkout', 'admin.backgrounds', 'admin.background_gift', 'admin.background_ungift'].every((a) => log.includes(a)));
});

await ok('a service out of its daily quota is skipped until it resets; the skip is saved without touching other settings', async () => {
  const nur = new Browser();
  assert.equal((await nur.post('/auth/sign-in', { email: 'nur@example.com', password: PW })).status, 200);
  const k1 = (await nur.post('/engine/keys', { baseUrl: 'https://api.mistral.ai/v1', model: 'mistral-small-latest', apiKey: 'mis-key-1111' })).data.key.id;
  const k2 = (await nur.post('/engine/keys', { baseUrl: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile', apiKey: 'gsk-nur-2222' })).data.key.id;
  assert.equal((await nur.patch('/me', { engine: { brains: [`key:${k1}`, `key:${k2}`] } })).status, 200);
  const before = (await user('nur@example.com')).engine;
  aiCalls.length = 0;
  let r = await nur.post('/chat', { message: 'first', tz: 0 });
  assert.equal(r.status, 200, JSON.stringify(r.data)); assert.match(r.data.reply, /included key/); // the Groq stand-in's answer
  assert.deepEqual(aiCalls.map((c) => c.host), ['api.mistral.ai', 'api.groq.com'], 'one after the other');
  const e = (await user('nur@example.com')).engine;
  // Until the daily reset (UTC midnight, plus half a minute), not 31 seconds; just before midnight that's under an hour.
  const reset = (() => { const d = new Date(); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1); })();
  assert.ok(e.rest[`key:${k1}`].until >= reset, 'skipped until the daily reset, not 31 seconds');
  const { rest: _r, ...after } = e, { rest: _b, ...was } = before;
  assert.deepEqual(after, was, 'other settings untouched');
  aiCalls.length = 0;
  r = await nur.post('/chat', { message: 'second', tz: 0 });
  assert.equal(r.status, 200);
  assert.deepEqual(aiCalls.map((c) => c.host), ['api.groq.com'], 'the used-up service is not asked again');
});

await ok('release check: with Knowledge files on but nothing kept, everyday questions reach the AI exactly as with it off', async () => {
  const nur = new Browser();
  assert.equal((await nur.post('/auth/sign-in', { email: 'nur@example.com', password: PW })).status, 200);
  const nurU = await user('nur@example.com');
  // What the AI is told (the system prompt): the conversation so far is compared separately, below.
  const sent = async (message) => { aiCalls.length = 0; const r = await nur.post('/chat', { message, tz: 0 }); assert.equal(r.status, 200, JSON.stringify(r.data)); const last = aiCalls.filter((c) => c.host === 'api.groq.com').at(-1); assert.ok(last, 'the AI was asked'); const m = JSON.parse(last.body).messages; return { system: m[0].content.replace(/\d{1,2}:\d{2}(:\d{2})?\s?(am|pm)?/gi, 'T'), last: m.at(-1) }; };
  const everyday = ['What’s on my calendar today?', 'Write a short thank-you note to the team.', 'How far is the Moon?'];
  const before = [];
  for (const m of everyday) before.push(await sent(m));
  assert.equal((await admin.put(`/admin/ai/users/${nurU.id}`, { access: { ...(nurU.ai_access ?? {}), 'kn:files': true } })).status, 200);
  for (let i = 0; i < everyday.length; i++) {
    const now = await sent(everyday[i]);
    assert.equal(now.system, before[i].system, everyday[i]);
    assert.deepEqual(now.last, { role: 'user', content: everyday[i] }, 'the question goes as it was asked, with nothing added');
  }
  assert.equal((await admin.put(`/admin/ai/users/${nurU.id}`, { access: nurU.ai_access ?? {} })).status, 200);
});

await ok('notes sent from a device are used only when the plan includes learning', async () => {
  const nur = new Browser();
  assert.equal((await nur.post('/auth/sign-in', { email: 'nur@example.com', password: PW })).status, 200);
  const nurU = await user('nur@example.com');
  const base = nurU.ai_access ?? {};
  const prompt = async () => {
    aiCalls.length = 0;
    const r = await nur.post('/chat', { message: 'Email the team about Friday', tz: 0, knowledge: { hits: [], tables: [], numbers: false, learned: [{ kind: 'person', said: 'the team', means: 'Design team zq7', level: 'sure', how: 'You told Niko' }] } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    return JSON.parse(aiCalls.filter((c) => c.host === 'api.groq.com').at(-1).body).messages[0].content;
  };
  // Files on, kept on the device, learning not in the plan: the device's notes are ignored.
  assert.equal((await admin.put(`/admin/ai/users/${nurU.id}`, { access: { ...base, 'kn:files': true, 'kn:place:device': true, 'kn:learning': false } })).status, 200);
  assert.equal((await nur.put('/knowledge/prefs', { place: 'device' })).status, 200);
  assert.equal((await nur.put('/knowledge/prefs', { learnPlace: 'device' })).status, 403, 'can’t keep notes on the device without learning');
  assert.ok(!(await prompt()).includes('Design team zq7'), 'not used without learning');
  // With learning, they are.
  assert.equal((await admin.put(`/admin/ai/users/${nurU.id}`, { access: { ...base, 'kn:files': true, 'kn:place:device': true, 'kn:learning': true } })).status, 200);
  assert.equal((await nur.put('/knowledge/prefs', { learnPlace: 'device' })).status, 200);
  assert.ok((await prompt()).includes('Design team zq7'), 'used with learning, when notes are kept on the device');
  await nur.put('/knowledge/prefs', { place: 'niko', learnPlace: 'niko' });
  assert.equal((await admin.put(`/admin/ai/users/${nurU.id}`, { access: base })).status, 200);
});

await ok('the admin can add a person’s own key for a source; theirs replaces it, and turning the source off keeps the admin’s', async () => {
  const nur = new Browser();
  assert.equal((await nur.post('/auth/sign-in', { email: 'nur@example.com', password: PW })).status, 200);
  const nurId = (await user('nur@example.com')).id;
  const actions = [{ id: 'bus-arrivals', name: 'Bus arrivals', path: '/BusArrival', params: [{ name: 'BusStopCode', in: 'query', type: 'text', required: true, max: 5 }], live: true, example: '', on: true }];
  const [src] = await q(`insert into data_sources (name, use_as, base_url, auth, auth_name, key_mode, actions, terms_ok, offer) values ('LTA DataMall', 'live', 'https://datamall2.mytransport.sg', 'header', 'AccountKey', 'own', $1::jsonb, true, 'everyone') returning id`, [JSON.stringify(actions)]);
  let r = await admin.get(`/admin/data/users/${nurId}/keys`);
  assert.deepEqual(r.data.keys, [{ source: src.id, name: 'LTA DataMall', keyName: 'AccountKey', key: null }]);
  assert.equal((await admin.put(`/admin/data/users/${nurId}/keys/${src.id}`, { key: 'admin-set-key-1' })).status, 200);
  const [row] = await q(`select key_enc, by_admin from data_source_keys where user_id = $1`, [nurId]);
  assert.equal(row.by_admin, true); assert.ok(!row.key_enc.includes('admin-set-key-1'), 'sealed');
  r = await nur.get('/data');
  const seen = r.data.offered.find((x) => x.id === src.id);
  assert.equal(seen.hasKey, true, 'ready for them'); assert.ok(!JSON.stringify(r.data).includes('admin-set-key-1') && !/by_admin|byAdmin|admin/i.test(JSON.stringify(seen)), 'no key and no mention of an admin');
  // Turning it on and off again keeps the key the admin added.
  assert.equal((await nur.put(`/data/included/${src.id}`, { on: true })).status, 200);
  assert.equal((await nur.put(`/data/included/${src.id}`, { on: false })).status, 200);
  assert.equal((await q(`select count(*)::int as n from data_source_keys where user_id = $1`, [nurId]))[0].n, 1);
  // Their own key replaces it, and then the admin can't change it.
  assert.equal((await nur.put(`/data/included/${src.id}`, { on: true, key: 'nur-own-key-2' })).status, 200);
  assert.equal((await q(`select by_admin from data_source_keys where user_id = $1`, [nurId]))[0].by_admin, false);
  r = await admin.put(`/admin/data/users/${nurId}/keys/${src.id}`, { key: 'admin-set-key-3' });
  assert.equal(r.status, 409); assert.match(r.data.error, /their own key/);
  assert.equal((await admin.get(`/admin/data/users/${nurId}/keys`)).data.keys[0].key, 'theirs');
  await admin.del(`/admin/data/users/${nurId}/keys/${src.id}`);
  assert.equal((await q(`select count(*)::int as n from data_source_keys where user_id = $1`, [nurId]))[0].n, 1, 'the admin removes only keys the admin added');
  assert.equal((await nur.get(`/admin/data/users/${nurId}/keys`)).status === 200, false, 'members can’t reach it');
});

await sqlc.end();
await closePools();
try { run('pg_ctl', ['-D', join(dir, 'data'), '-m', 'immediate', 'stop']); } catch { /* already stopping */ }
rmSync(dir, { recursive: true, force: true });
console.log(`${pass} payments checks passed`);
