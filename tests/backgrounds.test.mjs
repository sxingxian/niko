// Background rules: the admin's settings, who may use which background, prices (bundle credit, pro-rated new
// backgrounds), what a purchase covers, and Niko Pro (one add-on with designs) covering backgrounds.
import assert from 'node:assert/strict';
import {
  BACKGROUNDS, backgroundOwnerOff, backgroundQuote, backgroundSettingsProblem, backgroundsView, canUseBackground, cleanBackgroundSettings,
  effectiveBackground, nextBackgroundSettings, proRated,
} from '../packages/shared/src/index.ts';

let pass = 0;
const ok = async (name, fn) => { try { await fn(); pass++; console.log('PASS', name); } catch (e) { console.log('FAIL', name, e?.stack ?? e?.message); process.exitCode = 1; } };
const S = (over = {}) => cleanBackgroundSettings({
  bundleCents: 500, credit: true, rate: 'saving', pro: true, ...over,
  backgrounds: { aurora: { on: true, paid: true, cents: 300 }, stars: { on: true, paid: true, cents: 400 }, dust: { on: true, paid: false }, hex: { on: false, paid: true, cents: 300 }, ...(over.backgrounds ?? {}) },
});
const A = (over = {}) => ({ owned: {}, bundle: false, pro: false, admin: false, activePlan: null, ...over });
const PRO = { on: true, monthly: 300, yearly: null };
const NOPRO = { on: false, monthly: null, yearly: null };

await ok('catalogue: 20 backgrounds, Glow first, unique ids, Lattice keeps its id', () => {
  assert.equal(BACKGROUNDS.length, 20); assert.equal(BACKGROUNDS[0].id, 'glow');
  assert.equal(new Set(BACKGROUNDS.map((d) => d.id)).size, 20);
  assert.equal(BACKGROUNDS.find((d) => d.id === 'hex').name, 'Lattice');
});

await ok('settings: unknown dropped, new ones start off and unpriced, bad prices refused, Pro covers them by default', () => {
  const s = cleanBackgroundSettings({ backgrounds: { bogus: { on: true }, aurora: { on: true, cents: 10 } }, percent: 120, rate: 'x' });
  assert.equal(s.backgrounds.bogus, undefined); assert.equal(s.backgrounds.glow, undefined, 'Glow is never a setting');
  assert.equal(s.backgrounds.aurora.cents, null);
  assert.equal(s.backgrounds.equalizer.on, false); assert.equal(s.backgrounds.equalizer.paid, true);
  assert.equal(s.percent, 30); assert.equal(s.rate, 'saving'); assert.equal(s.pro, true);
  assert.match(backgroundSettingsProblem(s), /Aurora a price/);
  assert.match(backgroundSettingsProblem(S({ bundleCents: 900 })), /bundle should cost less/);
  assert.equal(backgroundSettingsProblem(S()), null);
});

await ok('switching off and on: the server remembers, the admin can’t set it', () => {
  const prev = S();
  let next = nextBackgroundSettings(prev, { ...prev, backgrounds: { ...prev.backgrounds, aurora: { ...prev.backgrounds.aurora, on: false } } });
  assert.equal(next.backgrounds.aurora.wasOff, true);
  next = nextBackgroundSettings(next, { ...next, backgrounds: { ...next.backgrounds, aurora: { ...next.backgrounds.aurora, on: true, wasOff: false } } });
  assert.equal(next.backgrounds.aurora.wasOff, true, 'stays: it came back');
  const fresh = nextBackgroundSettings(S(), { ...S(), backgrounds: { ...S().backgrounds, peaks: { on: false, wasOff: true, everOn: true } } });
  assert.equal(fresh.backgrounds.peaks.wasOff, false); assert.equal(fresh.backgrounds.peaks.everOn, false);
});

await ok('who may use what: Glow always, included while offered, owned forever, Pro while it covers them, admins everything', () => {
  const s = S();
  assert.ok(canUseBackground(s, A(), 'glow'));
  assert.ok(canUseBackground(s, A(), 'dust'));
  assert.ok(!canUseBackground(s, A(), 'aurora'));
  assert.ok(canUseBackground(s, A({ owned: { hex: { cents: 300, source: 'single' } } }), 'hex'), 'retired but bought');
  assert.ok(!canUseBackground(s, A({ pro: true }), 'hex'), 'Pro covers what is offered');
  assert.ok(canUseBackground(s, A({ pro: true }), 'stars'));
  assert.ok(!canUseBackground(S({ pro: false }), A({ pro: true }), 'stars'), 'left out of Pro');
  assert.ok(canUseBackground(s, A({ admin: true }), 'peaks'));
  assert.ok(!canUseBackground(s, A(), 'bogus'));
  assert.equal(effectiveBackground(s, A(), 'aurora'), 'glow');
  assert.equal(effectiveBackground(s, A(), 'dust'), 'dust');
});

await ok('view: retired only for owners; bundle credit; new and returning ones pro-rated for bundle owners', () => {
  const s = S();
  let v = backgroundsView(s, A(), NOPRO);
  assert.deepEqual(v.backgrounds.map((d) => d.id), ['glow', 'aurora', 'stars', 'dust']);
  assert.deepEqual(v.bundle, { count: 2, cents: 500 });
  assert.equal(backgroundsView(s, A({ owned: { aurora: { cents: 300, source: 'single' } } }), NOPRO).bundle, null, 'one left: no bundle');
  const s2 = S({ backgrounds: { silk: { on: true, paid: true, cents: 400 } } });
  assert.deepEqual(backgroundsView(s2, A({ owned: { aurora: { cents: 300, source: 'single' } } }), NOPRO).bundle, { count: 2, cents: 200 });
  const s3 = nextBackgroundSettings(nextBackgroundSettings(S(), { ...S(), backgrounds: { ...S().backgrounds, hex: { on: true, paid: true, cents: 300 } } }), { ...S() });
  const s4 = nextBackgroundSettings(s3, { ...s3, backgrounds: { ...s3.backgrounds, hex: { on: true, paid: true, cents: 300 }, bokeh: { on: true, paid: true, cents: 500 } } });
  v = backgroundsView(s4, A({ bundle: true, owned: { aurora: { cents: null, source: 'bundle' }, stars: { cents: null, source: 'bundle' } } }), NOPRO);
  const h = v.backgrounds.find((d) => d.id === 'hex'), b = v.backgrounds.find((d) => d.id === 'bokeh');
  assert.equal(h.fresh, true); assert.equal(h.back, true); assert.equal(b.fresh, true); assert.equal(b.back, false);
  const off = backgroundOwnerOff(s4);
  assert.equal(b.cents, proRated(500, off)); assert.equal(v.topupAll.cents, h.cents + b.cents); assert.equal(v.bundle, null);
});

await ok('quotes: worked out from settings; refused when not offered to this account', () => {
  const s = S();
  assert.deepEqual(backgroundQuote(s, A(), 'one', 'aurora'), { backgrounds: ['aurora'], cents: 300, bundle: false });
  assert.match(backgroundQuote(s, A(), 'one', 'dust').error, /isn’t available/, 'included');
  assert.match(backgroundQuote(s, A(), 'one', 'hex').error, /isn’t available/, 'retired');
  assert.match(backgroundQuote(s, A(), 'topup', 'aurora').error, /isn’t offered/);
  assert.deepEqual(backgroundQuote(s, A(), 'all'), { backgrounds: ['aurora', 'stars'], cents: 500, bundle: true });
  assert.match(backgroundQuote(s, A({ admin: true }), 'one', 'aurora').error, /Admins/);
  assert.match(backgroundQuote(s, A({ pro: true }), 'one', 'aurora').error, /isn’t available/, 'Pro already covers it');
});

await ok('Niko Pro: priced with designs, offered on an active plan, only while it covers backgrounds', () => {
  const s = S();
  assert.equal(backgroundsView(s, A(), PRO).pro.offered, false, 'no active plan');
  assert.deepEqual(backgroundsView(s, A({ activePlan: 'monthly' }), PRO).pro, { offered: true, active: false, covers: true, cents: 300, plan: 'monthly' });
  assert.equal(backgroundsView(s, A({ activePlan: 'yearly' }), PRO).pro.offered, false, 'no yearly price');
  assert.equal(backgroundsView(S({ pro: false }), A({ activePlan: 'monthly' }), PRO).pro.offered, false);
  assert.equal(backgroundsView(s, A({ activePlan: 'monthly' }), NOPRO).pro.offered, false);
  assert.equal(backgroundsView(s, A({ admin: true, activePlan: 'monthly' }), PRO).pro.offered, false);
  const v = backgroundsView(s, A({ pro: true, activePlan: 'monthly' }), PRO);
  assert.equal(v.pro.offered, false, 'already on'); assert.equal(v.backgrounds.find((d) => d.id === 'stars').state, 'pro');
});

console.log(`${pass} background checks passed`);
