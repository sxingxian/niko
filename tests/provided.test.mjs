// Included services and monthly amounts: which uses count, how a fixed order is kept, which amounts are accepted.
import assert from 'node:assert/strict';
import { accountLimits, arrangeOrder, cleanAccountLimits, cleanProvided, includedEntry, PROVIDED_ID } from '@niko/shared';

let pass = 0;
const ok = (name, fn) => { try { fn(); pass++; console.log('PASS', name); } catch (e) { console.log('FAIL', name, e?.message); process.exitCode = 1; } };

ok('only included services count: provided keys and the built-in ones, never the person’s own', () => {
  assert.equal(includedEntry('brain', 'key:pxabcdefghij'), true);
  assert.equal(includedEntry('brain', 'workers-ai'), true);
  assert.equal(includedEntry('brain', 'key:abcd1234'), false, 'an own key');
  assert.equal(includedEntry('brain', 'self-hosted-ai'), false);
  assert.equal(includedEntry('voice', 'vkey:pxabcdefghij'), true);
  assert.equal(includedEntry('voice', 'workers'), true);
  assert.equal(includedEntry('voice', 'kokoro'), false, 'the on-device voice');
  assert.equal(includedEntry('voice', 'device'), false);
  assert.equal(includedEntry('map', 'osm'), true, 'OpenStreetMap counts');
  assert.equal(includedEntry('map', 'mkey:pxabcdefghij'), true);
  assert.equal(includedEntry('map', 'mkey:ab12'), false);
  assert.equal(includedEntry('image', 'key:pxabcdefghij'), false, 'a key of another kind');
});
ok('a fixed order keeps included services first; switched off stays off; free leaves the order alone', () => {
  const p = ['key:px0000000001', 'key:px0000000002'];
  assert.deepEqual(arrangeOrder(['key:mine', 'key:px0000000002', 'workers-ai', 'key:px0000000001'], p, 'fixed'), ['key:px0000000001', 'key:px0000000002', 'key:mine', 'workers-ai']);
  assert.deepEqual(arrangeOrder(['key:mine', 'workers-ai'], p, 'fixed'), ['key:mine', 'workers-ai'], 'both switched off');
  assert.deepEqual(arrangeOrder(['key:mine', 'key:px0000000002'], p, 'free'), ['key:mine', 'key:px0000000002']);
});
ok('setups accept only provided ids, up to 6 a kind, and free unless fixed', () => {
  const s = cleanProvided({ keys: { brain: ['px0000000001', 'px0000000001', 'abc', '../x'], voice: 'nope', map: Array.from({ length: 9 }, (_, i) => `px00000000${10 + i}`) }, order: 'weird' });
  assert.deepEqual(s.keys.brain, ['px0000000001']);
  assert.equal(s.keys.voice, undefined);
  assert.equal(s.keys.map.length, 6);
  assert.equal(s.order, 'free');
  assert.ok(PROVIDED_ID.test('px0123456789') && !PROVIDED_ID.test('px012345678') && !PROVIDED_ID.test('PX0123456789'));
});
ok('the built-in’s place is kept in a setup, once, and never for maps', () => {
  const s = cleanProvided({ keys: { brain: ['builtin', 'px0000000001', 'builtin'], map: ['builtin', 'px0000000002'] } });
  assert.deepEqual(s.keys.brain, ['builtin', 'px0000000001']);
  assert.deepEqual(s.keys.map, ['px0000000002']);
  assert.deepEqual(arrangeOrder(['key:mine', 'key:px0000000001', 'workers-ai'], ['workers-ai', 'key:px0000000001'], 'fixed'), ['workers-ai', 'key:px0000000001', 'key:mine']);
});
ok('monthly amounts: only the offered steps are kept, and no limit until one is set', () => {
  assert.deepEqual(cleanAccountLimits({ brain: 1000, voice: 7, hear: 300, image: '50', map: 0 }), { brain: 1000, hear: 300, map: 0 });
  const l = accountLimits({}, {});
  assert.equal(l.brain, 0); assert.equal(l.voice, 0); assert.equal(l.map, 0);
  assert.equal(accountLimits({ brain: 500 }, { brain: 2000 }).brain, 2000, 'a person’s own amount wins');
});
console.log(`${pass} provided checks passed`);
