// Screen lock codes: six digits, and not the ones people guess first.
import assert from 'node:assert/strict';
import { weakLockCode } from '../packages/shared/src/index.ts';
const ok = async (name, fn) => { try { await fn(); console.log('PASS', name); } catch (e) { console.log('FAIL', name, e?.stack ?? e?.message); process.exitCode = 1; } };
await ok('easy codes are refused, ordinary ones pass', () => {
  for (const c of ['000000', '999999', '123456', '234567', '654321', '890123', '098765', '121212', '112233', '12345', '1234567', 'abcdef', '12 456', '']) assert.equal(weakLockCode(c), true, c);
  for (const c of ['482916', '305718', '120934', '777123', '900417']) assert.equal(weakLockCode(c), false, c);
});
console.log('lock code checks done');
