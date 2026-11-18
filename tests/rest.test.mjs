// Skips (services Niko leaves alone for a while): read fresh, saved as their own field merged with what's there now,
// longer each time a service fails again soon after, and until the real reset for daily quotas.
import assert from 'node:assert/strict';
import { RestBook, nextRest, waitFrom, untilDailyReset } from '../apps/api/src/rest.ts';

let pass = 0;
const ok = async (name, fn) => { try { await fn(); pass++; console.log('PASS', name); } catch (e) { console.log('FAIL', name, e?.message); process.exitCode = 1; } };
/** A database whose saved skips change between reading and saving (another request saved its own meanwhile). */
function db(sequence) {
  const reads = [...sequence]; const writes = [];
  const q = () => { const v = reads.length > 1 ? reads.shift() : reads[0]; const p = { from: () => p, where: () => p, limit: () => p, then: (a, b) => Promise.resolve([{ r: v }]).then(a, b) }; return p; };
  return { select: q, update: () => ({ set: (v) => ({ where: async () => { writes.push(v.engine); } }) }), writes };
}

await ok('reads the skips saved now, not the copy the request started with', async () => {
  const d = db([{ 'key:a': { until: Date.now() + 60_000, why: 'limit' } }]);
  const book = await RestBook.open(d, { id: 'u', engine: { rest: {} } }, 'rest');
  assert.ok(book.resting('key:a'));
});
await ok('saves only its own field, merged with another request’s skips saved meanwhile', async () => {
  const later = Date.now() + 60_000;
  const d = db([{}, { 'key:b': { until: later, why: 'down' } }]);
  const book = await RestBook.open(d, { id: 'u', engine: {} }, 'rest');
  book.failed('key:a', { why: 'limit', restMs: 60_000 });
  await book.save();
  const w = d.writes.at(-1);
  assert.equal(w.restKey, 'rest');
  assert.deepEqual(Object.keys(w.rest).sort(), ['key:a', 'key:b'], 'both kept');
  assert.match(JSON.stringify((w.queryChunks ?? []).map((x) => x?.value ?? null)), /jsonb_set/, 'only that field is set');
});
await ok('a service that worked is removed, others stay', async () => {
  const d = db([{ 'key:a': { until: Date.now() - 5, why: 'limit' }, 'key:b': { until: Date.now() + 9e5, why: 'down' } }]);
  const book = await RestBook.open(d, { id: 'u' }, 'voiceRest');
  book.worked('key:a'); await book.save();
  assert.deepEqual(Object.keys(d.writes.at(-1).rest), ['key:b']);
});
await ok('failing again soon after waits longer: 1, 2, 4… minutes, up to an hour for a passing fault', async () => {
  const seq = []; let p; let now = 0;
  for (let i = 0; i < 9; i++) { p = nextRest(p, { why: 'down', restMs: 60_000 }, now); seq.push((p.until - now) / 60_000); now = p.until + 1000; }
  assert.deepEqual(seq, [1, 2, 4, 8, 16, 32, 60, 60, 60]);
  // A long quiet since: back to the start.
  assert.equal((nextRest({ until: 0, why: 'down', n: 6 }, { why: 'down', restMs: 60_000 }, 7 * 3_600_000).until - 7 * 3_600_000) / 60_000, 1);
});
await ok('waits: Retry-After, Google’s retryDelay, and the daily reset', async () => {
  assert.equal(waitFrom('slow down', '20'), 20_000);
  assert.equal(waitFrom('{"error":{"details":[{"retryDelay":"42s"}]}}', null), 42_000);
  const now = Date.UTC(2026, 10, 18, 3, 0, 0); // 11:00 in Singapore, 19:00 the day before in California
  const g = waitFrom('{"quotaId":"GenerateRequestsPerDayPerProjectPerModel-FreeTier","quotaMetric":"generativelanguage.googleapis.com/x","retryDelay":"31s"}', null, now);
  assert.equal(now + g, Date.UTC(2026, 10, 18, 8, 0, 30), 'midnight in California (UTC−8), 4 pm in Singapore');
  assert.equal(untilDailyReset(false, now), Date.UTC(2026, 10, 19, 0, 0, 30), 'others: midnight UTC');
  assert.equal(waitFrom('internal error', null), 0);
});
console.log(`${pass} skip checks passed`);
