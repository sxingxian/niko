// Design rules: the admin's settings, who may use which design, prices (bundle credit, pro-rated new designs), what a
// purchase covers, and the Niko Pro add-on's offer.
import assert from 'node:assert/strict';
import {
  bundleOwnerOff, bundleSaving, canUseDesign, cleanDesignSettings, designQuote, designSettingsProblem, designsView, DESIGNS, effectiveDesign, nextDesignSettings, proRated,
} from '../packages/shared/src/index.ts';

let pass = 0;
const ok = async (name, fn) => { try { await fn(); pass++; console.log('PASS', name); } catch (e) { console.log('FAIL', name, e?.stack ?? e?.message); process.exitCode = 1; } };
const S = (over = {}) => cleanDesignSettings({
  bundleCents: 800, credit: true, rate: 'saving', pro: { on: true, monthly: 300, yearly: null }, ...over,
  designs: { prism: { on: true, paid: true, cents: 400 }, ribbon: { on: true, paid: true, cents: 600 }, aurora: { on: true, paid: false }, hologram: { on: false, paid: true, cents: 500 }, ...(over.designs ?? {}) },
});
const A = (over = {}) => ({ owned: {}, bundle: false, pro: false, admin: false, activePlan: null, ...over });

await ok('catalogue: 20 designs, Nebula first, unique ids', () => {
  assert.equal(DESIGNS.length, 20); assert.equal(DESIGNS[0].id, 'nebula');
  assert.equal(new Set(DESIGNS.map((d) => d.id)).size, 20);
});

await ok('settings: unknown designs dropped, new ones start off and unpriced, bad prices refused', () => {
  const s = cleanDesignSettings({ designs: { bogus: { on: true }, prism: { on: true, cents: 10 } }, percent: 120, rate: 'x' });
  assert.equal(s.designs.bogus, undefined); assert.equal(s.designs.nebula, undefined, 'Nebula is never a setting');
  assert.equal(s.designs.prism.cents, null, 'below SGD 0.50');
  assert.equal(s.designs.iris.on, false); assert.equal(s.designs.iris.paid, true);
  assert.equal(s.percent, 30); assert.equal(s.rate, 'saving');
  assert.match(designSettingsProblem(s), /Prism a price/);
  assert.match(designSettingsProblem(cleanDesignSettings({ pro: { on: true } })), /Niko Pro a price/);
  assert.equal(designSettingsProblem(S()), null);
});

await ok('switching off and on: the server remembers, the admin can’t set it', () => {
  let prev = S();
  let next = nextDesignSettings(prev, { ...prev, designs: { ...prev.designs, prism: { ...prev.designs.prism, on: false, wasOff: false } } });
  assert.equal(next.designs.prism.wasOff, true); assert.equal(next.designs.prism.everOn, true);
  next = nextDesignSettings(next, { ...next, designs: { ...next.designs, prism: { ...next.designs.prism, on: true, wasOff: false } } });
  assert.equal(next.designs.prism.wasOff, true, 'stays: it came back');
  const fresh = nextDesignSettings(S(), { ...S(), designs: { ...S().designs, iris: { on: false, paid: true, wasOff: true, everOn: true } } });
  assert.equal(fresh.designs.iris.wasOff, false); assert.equal(fresh.designs.iris.everOn, false);
});

await ok('who may use what: Nebula always, included while offered, owned forever, Pro while offered, admins everything', () => {
  const s = S();
  assert.ok(canUseDesign(s, A(), 'nebula'));
  assert.ok(canUseDesign(s, A(), 'aurora'));
  assert.ok(!canUseDesign(s, A(), 'prism'));
  assert.ok(canUseDesign(s, A({ owned: { hologram: { cents: 500, source: 'single' } } }), 'hologram'), 'retired but bought');
  assert.ok(!canUseDesign(s, A({ pro: true }), 'hologram'), 'Pro covers designs that are offered');
  assert.ok(canUseDesign(s, A({ pro: true }), 'ribbon'));
  assert.ok(canUseDesign(s, A({ admin: true }), 'iris'));
  assert.ok(!canUseDesign(s, A(), 'bogus'));
  assert.equal(effectiveDesign(s, A(), 'prism'), 'nebula');
  assert.equal(effectiveDesign(s, A(), 'aurora'), 'aurora');
});

await ok('prices: the bundle’s saving pro-rates new designs; a set percentage too; never below SGD 0.50', () => {
  const s = S();
  const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≈ ${b}`);
  near(bundleSaving(s), 0.2);
  near(bundleOwnerOff(s), 0.2);
  near(bundleOwnerOff(S({ rate: 'percent', percent: 40 })), 0.4);
  assert.equal(proRated(400, 0.2), 320); assert.equal(proRated(60, 0.5), 50);
  assert.equal(bundleSaving(S({ bundleCents: 5000 })), null, 'no saving, no pro-rating');
});

await ok('view: retired designs only for owners; bundle credit; fresh and back designs for bundle owners', () => {
  const s = S();
  let v = designsView(s, A());
  assert.deepEqual(v.designs.map((d) => d.id), ['nebula', 'prism', 'ribbon', 'aurora']);
  assert.deepEqual(v.bundle, { count: 2, cents: 800 });
  v = designsView(s, A({ owned: { prism: { cents: 400, source: 'single' } } }));
  assert.equal(v.bundle, null, 'one design left: no bundle');
  const s2 = S({ designs: { flux: { on: true, paid: true, cents: 500 } } });
  v = designsView(s2, A({ owned: { prism: { cents: 400, source: 'single' } } }));
  assert.deepEqual(v.bundle, { count: 2, cents: 400 }, 'SGD 8 less SGD 4 paid');
  assert.deepEqual(designsView(S({ credit: false, designs: { flux: { on: true, paid: true, cents: 500 } } }), A({ owned: { prism: { cents: 400, source: 'single' } } })).bundle, { count: 2, cents: 800 });
  // Bundle owner: Flux arrived after, Hologram came back after being off.
  const s3 = nextDesignSettings(nextDesignSettings(S(), { ...S(), designs: { ...S().designs, hologram: { on: true, paid: true, cents: 500 } } }), {
    ...S(), designs: { ...S().designs, hologram: { on: false, paid: true, cents: 500 } } });
  const s4 = nextDesignSettings(s3, { ...s3, designs: { ...s3.designs, hologram: { on: true, paid: true, cents: 500 }, flux: { on: true, paid: true, cents: 500 } } });
  v = designsView(s4, A({ bundle: true, owned: { prism: { cents: null, source: 'bundle' }, ribbon: { cents: null, source: 'bundle' } } }));
  const h = v.designs.find((d) => d.id === 'hologram'), f = v.designs.find((d) => d.id === 'flux');
  assert.equal(h.fresh, true); assert.equal(h.back, true); assert.equal(f.fresh, true); assert.equal(f.back, false);
  const off = bundleOwnerOff(s4);
  assert.equal(h.cents, proRated(500, off)); assert.equal(v.topupAll.count, 2); assert.equal(v.topupAll.cents, h.cents + f.cents);
  assert.equal(v.bundle, null);
});

await ok('quotes: worked out from settings; refused when not offered to this account', () => {
  const s = S();
  assert.deepEqual(designQuote(s, A(), 'one', 'prism'), { designs: ['prism'], cents: 400, bundle: false });
  assert.match(designQuote(s, A(), 'one', 'aurora').error, /isn’t available/, 'included');
  assert.match(designQuote(s, A(), 'one', 'hologram').error, /isn’t available/, 'retired');
  assert.match(designQuote(s, A(), 'topup', 'prism').error, /isn’t offered/);
  assert.deepEqual(designQuote(s, A(), 'all'), { designs: ['prism', 'ribbon'], cents: 800, bundle: true });
  assert.match(designQuote(s, A({ bundle: true }), 'all').error, /isn’t offered/);
  assert.match(designQuote(s, A({ admin: true }), 'one', 'prism').error, /Admins/);
});

await ok('Niko Pro: offered only on an active plan with a price for it; never to admins', () => {
  const s = S();
  assert.equal(designsView(s, A()).pro.offered, false);
  assert.deepEqual(designsView(s, A({ activePlan: 'monthly' })).pro, { offered: true, active: false, cents: 300, plan: 'monthly' });
  assert.equal(designsView(s, A({ activePlan: 'yearly' })).pro.offered, false, 'no yearly price');
  assert.equal(designsView(S({ pro: { on: false, monthly: 300 } }), A({ activePlan: 'monthly' })).pro.offered, false);
  assert.equal(designsView(s, A({ admin: true, activePlan: 'monthly' })).pro.offered, false);
  const v = designsView(s, A({ pro: true, activePlan: 'monthly' }));
  assert.equal(v.designs.find((d) => d.id === 'prism').state, 'pro');
});

console.log(`${pass} design checks passed`);
