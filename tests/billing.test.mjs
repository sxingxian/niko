// Payment rules: prices, lengths, who has access, admin unlocks, invite codes, and checking Stripe's signatures.
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import {
  accessState, addMonths, cleanPayments, CODE_ALPHABET, isCodeShape, lengthLabel, money, normalizeCode, paidEnd, plansOffered, showCode, toCents, unlockPlan,
} from '../packages/shared/src/index.ts';
import { formEncode, invoiceSubscription, periodEnd, planOf, verifyStripeSignature } from '../apps/api/src/stripe.ts';
import { randomChars } from '../apps/api/src/lib/crypto.ts';

let pass = 0;
const ok = async (name, fn) => { try { await fn(); pass++; console.log('PASS', name); } catch (e) { console.log('FAIL', name, e?.stack ?? e?.message); process.exitCode = 1; } };
const D = (s) => new Date(s);
const base = { role: 'member', lifetime: false, accessUntil: null, accessKind: null, accessStartMonths: 0, subStatus: null, subPeriodEnd: null };
const now = D('2026-11-16T12:00:00Z');

await ok('settings: defaults, bad values dropped, at least one plan stays on', () => {
  const d = cleanPayments(undefined);
  assert.equal(d.months, 12); assert.equal(d.onceCents, null); assert.equal(d.graceDays, 7); assert.ok(d.monthly.on && d.yearly.on);
  const s = cleanPayments({ onceCents: 49, months: 500, graceDays: 5, monthly: { on: false, cents: 900 }, yearly: { on: false, cents: 'x' }, unit: 'years' });
  assert.equal(s.onceCents, null, 'below SGD 0.50 is refused');
  assert.equal(s.months, 12); assert.equal(s.graceDays, 7);
  assert.equal(s.monthly.on, true, 'both off is not allowed'); assert.equal(s.monthly.cents, 900); assert.equal(s.yearly.cents, null);
  assert.equal(s.unit, 'years');
  assert.equal(cleanPayments({ months: 18, unit: 'years' }).unit, 'months', '18 months cannot show as years');
  assert.deepEqual(plansOffered(cleanPayments({ monthly: { on: true, cents: 900 }, yearly: { on: true, cents: null } })), [{ plan: 'monthly', cents: 900 }]);
});
await ok('prices and lengths read and shown in plain words', () => {
  assert.equal(toCents('12'), 1200); assert.equal(toCents('SGD 12.5'), 1250); assert.equal(toCents('0.49'), null); assert.equal(toCents('1.234'), null); assert.equal(toCents(''), null);
  assert.equal(money(1250), 'SGD 12.50'); assert.equal(money(null), 'SGD —');
  assert.equal(lengthLabel(12), '1 year'); assert.equal(lengthLabel(24), '2 years'); assert.equal(lengthLabel(1), '1 month'); assert.equal(lengthLabel(18), '18 months');
});
await ok('months are calendar months, clamped at the end of short months', () => {
  assert.equal(addMonths(D('2026-01-31T00:00:00Z'), 1).toISOString().slice(0, 10), '2026-02-28');
  assert.equal(addMonths(D('2028-01-31T00:00:00Z'), 1).toISOString().slice(0, 10), '2028-02-29');
  assert.equal(addMonths(D('2026-11-16T12:00:00Z'), 12).toISOString(), '2027-11-16T12:00:00.000Z');
  assert.equal(addMonths(D('2026-11-30T00:00:00Z'), 3).toISOString().slice(0, 10), '2027-02-28');
});
await ok('access: admins and lifetime always; paid, free and unlocked time until it ends', () => {
  assert.deepEqual(accessState({ ...base, role: 'admin' }, 7, now), { has: true, kind: 'admin', until: null });
  assert.equal(accessState({ ...base, lifetime: true }, 7, now).kind, 'life');
  assert.deepEqual(accessState({ ...base, accessUntil: D('2027-01-01'), accessKind: 'paid' }, 7, now), { has: true, kind: 'paid', until: '2027-01-01T00:00:00.000Z' });
  assert.equal(accessState({ ...base, accessUntil: D('2027-01-01'), accessKind: 'free' }, 7, now).kind, 'free');
  assert.equal(accessState({ ...base, accessUntil: D('2027-01-01'), accessKind: 'unlocked' }, 7, now).kind, 'unlocked');
  const ended = accessState({ ...base, accessUntil: D('2026-11-01'), accessKind: 'paid' }, 7, now);
  assert.equal(ended.has, false); assert.equal(ended.until, '2026-11-01T00:00:00.000Z');
  assert.equal(accessState(base, 7, now).has, false, 'nothing paid, nothing unlocked');
});
await ok('access: a plan while it is live; a failed renewal keeps access for the grace days; cancelled ends it', () => {
  assert.equal(accessState({ ...base, subStatus: 'active', subPeriodEnd: D('2026-12-16') }, 7, now).kind, 'sub');
  assert.equal(accessState({ ...base, subStatus: 'trialing', subPeriodEnd: D('2026-12-16') }, 7, now).has, true);
  const g = accessState({ ...base, subStatus: 'past_due', subPeriodEnd: D('2026-11-12T12:00:00Z') }, 7, now);
  assert.equal(g.kind, 'grace'); assert.equal(g.until, '2026-11-19T12:00:00.000Z');
  assert.equal(accessState({ ...base, subStatus: 'past_due', subPeriodEnd: D('2026-11-12T12:00:00Z') }, 3, now).has, false);
  assert.equal(accessState({ ...base, subStatus: 'canceled', subPeriodEnd: D('2026-12-16') }, 7, now).has, false);
  assert.equal(accessState({ ...base, subStatus: 'canceled', subPeriodEnd: D('2026-11-10'), accessUntil: D('2027-05-10'), accessKind: 'unlocked' }, 7, now).kind, 'unlocked');
});
await ok('unlock for a set time starts after the time already paid for', () => {
  const r = unlockPlan({ ...base, accessUntil: D('2027-11-16T00:00:00Z'), accessKind: 'paid' }, { kind: 'set', months: 6 }, now);
  assert.equal(r.paidUntil.toISOString(), '2027-11-16T00:00:00.000Z');
  assert.equal(r.accessUntil.toISOString(), '2028-05-16T00:00:00.000Z');
  assert.equal(r.sub, 'keep'); assert.equal(r.lifetime, false);
});
await ok('unlock on a live plan: it stops renewing and the unlocked time follows its period', () => {
  const r = unlockPlan({ ...base, subStatus: 'active', subPeriodEnd: D('2026-12-16T00:00:00Z') }, { kind: 'set', months: 6 }, now);
  assert.equal(r.sub, 'end-at-period');
  assert.equal(r.paidUntil.toISOString(), '2026-12-16T00:00:00.000Z');
  assert.equal(r.accessUntil.toISOString(), '2027-06-16T00:00:00.000Z');
  assert.equal(unlockPlan({ ...base, subStatus: 'active', subPeriodEnd: D('2026-12-16') }, { kind: 'life' }, now).sub, 'cancel-now');
});
await ok('unlock with nothing left starts today; a paid sign-up’s months come first', () => {
  const r = unlockPlan({ ...base, accessUntil: D('2026-10-01'), accessKind: 'paid' }, { kind: 'set', months: 6 }, now);
  assert.equal(r.paidUntil, null); assert.equal(r.accessUntil.toISOString(), '2027-05-16T12:00:00.000Z');
  const p = unlockPlan({ ...base, accessStartMonths: 12 }, { kind: 'set', months: 1 }, now);
  assert.equal(p.paidUntil.toISOString(), '2027-11-16T12:00:00.000Z'); assert.equal(p.accessUntil.toISOString(), '2027-12-16T12:00:00.000Z');
  assert.equal(paidEnd(base, now), null);
  const l = unlockPlan({ ...base, accessUntil: D('2027-01-01') }, { kind: 'life' }, now);
  assert.equal(l.lifetime, true); assert.equal(l.accessUntil, null);
});
await ok('invite codes: 6 characters with no look-alikes; typing is forgiving', () => {
  for (const ch of '0O1IL') assert.ok(!CODE_ALPHABET.includes(ch));
  for (let i = 0; i < 200; i++) { const c = randomChars(CODE_ALPHABET, 6); assert.ok(isCodeShape(c), c); }
  assert.equal(normalizeCode(' 7kx-m4p '), '7KXM4P'); assert.ok(isCodeShape('7KXM4P')); assert.ok(!isCodeShape('7KXM40')); assert.ok(!isCodeShape('7KXM4'));
  assert.equal(showCode('7KXM4P'), '7KX M4P');
  const digits = randomChars('0123456789', 6); assert.match(digits, /^\d{6}$/);
});
await ok('Stripe signatures: right secret and time pass; anything else fails', async () => {
  const secret = 'whsec_test', raw = '{"id":"evt_1"}', t = 1_800_000_000;
  const sig = createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex');
  assert.equal(await verifyStripeSignature(secret, `t=${t},v1=${sig}`, raw, t), true);
  assert.equal(await verifyStripeSignature(secret, `t=${t},v1=deadbeef,v1=${sig}`, raw, t), true, 'any v1 may match');
  assert.equal(await verifyStripeSignature('whsec_other', `t=${t},v1=${sig}`, raw, t), false);
  assert.equal(await verifyStripeSignature(secret, `t=${t},v1=${sig}`, raw + ' ', t), false, 'changed body');
  assert.equal(await verifyStripeSignature(secret, `t=${t},v1=${sig}`, raw, t + 301), false, 'too old');
  assert.equal(await verifyStripeSignature(secret, undefined, raw, t), false);
  assert.equal(await verifyStripeSignature(secret, `v1=${sig}`, raw, t), false, 'no time');
});
await ok('Stripe form encoding and the fields that moved between API versions', () => {
  assert.equal(formEncode({ a: 1, b: { c: 'x y', d: [{ e: true }] }, n: null, u: undefined }), 'a=1&b%5Bc%5D=x%20y&b%5Bd%5D%5B0%5D%5Be%5D=true');
  assert.equal(periodEnd({ current_period_end: 1_800_000_000 }).toISOString(), new Date(1_800_000_000_000).toISOString());
  assert.equal(periodEnd({ items: { data: [{ current_period_end: 1_800_000_000 }] } }).getTime(), 1_800_000_000_000);
  assert.equal(periodEnd({}), null);
  assert.equal(planOf({ metadata: { plan: 'yearly' } }), 'yearly');
  assert.equal(planOf({ items: { data: [{ price: { recurring: { interval: 'month' } } }] } }), 'monthly');
  assert.equal(invoiceSubscription({ subscription: 'sub_1' }), 'sub_1');
  assert.equal(invoiceSubscription({ parent: { subscription_details: { subscription: 'sub_2' } } }), 'sub_2');
  assert.equal(invoiceSubscription({}), null);
});
console.log(`${pass} payment-rule checks passed`);
