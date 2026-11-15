// The brain order: a brain that reaches its usage limit is skipped for a while and the next one answers.
import assert from 'node:assert/strict';
import { think, testEntry, listModels, providerMessage, customAi } from '../apps/api/src/brains.ts';
import { store, fakeDb } from './brains-stubs.mjs';

let pass = 0;
const ok = async (name, fn) => { try { await fn(); pass++; console.log('PASS', name); } catch (e) { console.log('FAIL', name, e?.message); process.exitCode = 1; } };
const msgs = [{ role: 'system', content: 's' }, { role: 'user', content: 'hi' }];
const keyA = { id: 'aaaa', baseUrl: 'https://api.openai.com/v1', model: 'm1', apiKey: 'sk-A' };
const keyB = { id: 'bbbb', baseUrl: 'https://api.anthropic.com/v1', model: 'm2', apiKey: 'sk-B' };
store.creds['custom-ai'] = { keys: [keyA, keyB] };
let calls = [];
let behaviour = {};
globalThis.fetch = async (url, init) => {
  const auth = init.headers.authorization ?? init.headers['x-api-key'];
  calls.push(String(auth));
  const b = behaviour[String(auth).replace('Bearer ', '')] ?? 'ok';
  if (b === 'quota') return new Response(JSON.stringify({ error: { code: 'insufficient_quota', message: 'You exceeded your current quota' } }), { status: 429 });
  if (b === 'rate') return new Response('slow down', { status: 429, headers: { 'retry-after': '20' } });
  if (b === 'refused') return new Response('bad key', { status: 401 });
  if (b === 'down') throw new TypeError('fetch failed');
  const anth = String(url).includes('/v1/messages');
  return new Response(JSON.stringify(anth ? { content: [{ text: 'from B' }] } : { choices: [{ message: { content: 'from A' } }] }), { status: 200 });
};
const workersOk = { AI: { run: async () => ({ response: 'from workers' }) }, AI_MODEL: 'm' };
const workersOut = { AI: { run: async () => { throw new Error('4006: you have used up your daily free allocation of 10,000 neurons'); } }, AI_MODEL: 'm' };
const user = (engine) => ({ id: 'u1', engine });

await ok('the first brain answers when it works', async () => {
  calls = []; behaviour = {};
  const r = await think(workersOk, fakeDb, user({ brains: ['key:aaaa', 'key:bbbb', 'workers-ai'] }), msgs);
  assert.equal(r.reply, 'from A'); assert.equal(r.used, 'key:aaaa'); assert.deepEqual(calls, ['Bearer sk-A']);
});
await ok('a key out of quota hands over to the next, and rests about an hour', async () => {
  calls = []; behaviour = { 'sk-A': 'quota' }; store.engineWrites = [];
  const t0 = Date.now();
  const r = await think(workersOk, fakeDb, user({ brains: ['key:aaaa', 'key:bbbb', 'workers-ai'] }), msgs);
  assert.equal(r.reply, 'from B'); assert.equal(r.used, 'key:bbbb');
  const rest = store.engineWrites.at(-1).rest['key:aaaa'];
  assert.equal(rest.why, 'limit'); assert.ok(rest.until - t0 > 55 * 60_000 && rest.until - t0 < 65 * 60_000);
});
await ok('a resting key is skipped while another can answer', async () => {
  calls = []; behaviour = {};
  const r = await think(workersOk, fakeDb, user({ brains: ['key:aaaa', 'key:bbbb'], rest: { 'key:aaaa': { until: Date.now() + 60_000, why: 'limit' } } }), msgs);
  assert.equal(r.used, 'key:bbbb'); assert.deepEqual(calls, ['sk-B']);
});
await ok('a rest that is over is ignored, and an answer clears it', async () => {
  calls = []; behaviour = {}; store.engineWrites = [];
  const r = await think(workersOk, fakeDb, user({ brains: ['key:aaaa', 'key:bbbb'], rest: { 'key:aaaa': { until: Date.now() - 1, why: 'limit' } } }), msgs);
  assert.equal(r.used, 'key:aaaa'); assert.deepEqual(store.engineWrites.at(-1).rest, {});
});
await ok('when every brain is resting, they are still tried, soonest-back first', async () => {
  calls = []; behaviour = {};
  const now = Date.now();
  const r = await think(workersOk, fakeDb, user({ brains: ['key:aaaa', 'key:bbbb'], rest: { 'key:aaaa': { until: now + 90_000, why: 'limit' }, 'key:bbbb': { until: now + 30_000, why: 'limit' } } }), msgs);
  assert.equal(r.used, 'key:bbbb');
});
await ok('a rate limit rests for the time the provider asks', async () => {
  calls = []; behaviour = { 'sk-A': 'rate' }; store.engineWrites = [];
  const t0 = Date.now();
  await think(workersOk, fakeDb, user({ brains: ['key:aaaa', 'workers-ai'] }), msgs);
  const rest = store.engineWrites.at(-1).rest['key:aaaa'];
  assert.ok(rest.until - t0 >= 19_000 && rest.until - t0 < 25_000);
});
await ok('a refused key rests longer and is reported as refused', async () => {
  behaviour = { 'sk-A': 'refused' }; store.engineWrites = [];
  await think(workersOk, fakeDb, user({ brains: ['key:aaaa', 'workers-ai'] }), msgs);
  assert.equal(store.engineWrites.at(-1).rest['key:aaaa'].why, 'refused');
});
await ok('Workers AI out of its daily allowance rests until after midnight UTC', async () => {
  behaviour = {}; store.engineWrites = [];
  const r = await think(workersOut, fakeDb, user({ brains: ['workers-ai', 'key:aaaa'] }), msgs);
  assert.equal(r.used, 'key:aaaa');
  const until = new Date(store.engineWrites.at(-1).rest['workers-ai'].until);
  assert.equal(until.getUTCHours(), 0); assert.ok(until > new Date());
});
await ok('an unreachable server hands over too', async () => {
  behaviour = { 'sk-A': 'down' };
  const r = await think(workersOk, fakeDb, user({ brains: ['key:aaaa', 'workers-ai'] }), msgs);
  assert.equal(r.used, 'workers-ai');
});
await ok('when nothing answers, it fails', async () => {
  behaviour = { 'sk-A': 'quota', 'sk-B': 'down' };
  await assert.rejects(() => think(workersOut, fakeDb, user({ brains: ['key:aaaa', 'key:bbbb', 'workers-ai'] }), msgs));
});
await ok('an account saved before the order uses its one key, then Workers AI', async () => {
  store.creds['custom-ai'] = { baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-OLD', model: 'x' };
  behaviour = { 'sk-OLD': 'quota' }; calls = [];
  const r = await think(workersOk, fakeDb, user({ brain: 'custom-ai' }), msgs);
  assert.deepEqual(calls, ['Bearer sk-OLD']); assert.equal(r.used, 'workers-ai');
  store.creds['custom-ai'] = { keys: [keyA, keyB] };
});
await ok('a key from another account cannot be named', async () => {
  behaviour = {}; calls = [];
  const r = await think(workersOk, fakeDb, user({ brains: ['key:zzzz', 'workers-ai'] }), msgs);
  assert.equal(r.used, 'workers-ai'); assert.deepEqual(calls, []);
});
await ok('a successful test clears that brain’s rest', async () => {
  behaviour = {}; store.engineWrites = [];
  await testEntry(workersOk, fakeDb, user({ brains: ['key:aaaa'], rest: { 'key:aaaa': { until: Date.now() + 60_000, why: 'limit' } } }), 'key:aaaa', 'fast');
  assert.deepEqual(store.engineWrites.at(-1).rest, {});
});
await ok('a model the provider rejects is a setting to fix, and its own message is kept for the owner', async () => {
  const saved = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: 'The model `meta-llama/llama-prompt-guard-2-22m` does not support chat completions', type: 'invalid_request_error' } }), { status: 400 });
  await assert.rejects(() => customAi({ baseUrl: 'https://api.groq.com/openai/v1', apiKey: 'gsk_x', model: 'meta-llama/llama-prompt-guard-2-22m' }, msgs), (e) => e.why === 'refused' && /does not support chat/.test(e.detail));
  globalThis.fetch = saved;
});
await ok('keys are removed from provider messages', () => {
  const m = providerMessage(JSON.stringify({ error: { message: 'Incorrect API key provided: gsk_abcdefghijklmnop1234. You can find your key at https://console.groq.com' } }));
  assert.ok(!m.includes('gsk_abcdefghijklmnop1234') && m.includes('[key]'));
  assert.ok(!providerMessage('x'.repeat(10) + ' ' + 'A'.repeat(40)).includes('A'.repeat(40)));
});
await ok('the model list keeps chat models and leaves out safety, speech and embedding models', async () => {
  const saved = globalThis.fetch; let asked = '';
  globalThis.fetch = async (url, init) => { asked = String(url) + ' ' + init.headers.authorization; return Response.json({ data: [
    { id: 'llama-3.3-70b-versatile' }, { id: 'meta-llama/llama-prompt-guard-2-22m' }, { id: 'whisper-large-v3' }, { id: 'playai-tts' }, { id: 'openai/gpt-oss-120b' }, { id: 'openai/gpt-oss-safeguard-20b' }] }); };
  const list = await listModels({ baseUrl: 'https://api.groq.com/openai/v1', apiKey: 'gsk_x' });
  assert.deepEqual(list, ['llama-3.3-70b-versatile', 'openai/gpt-oss-120b']);
  assert.equal(asked, 'https://api.groq.com/openai/v1/models Bearer gsk_x');
  globalThis.fetch = saved;
});
await ok('Google model names lose their "models/" prefix', async () => {
  const saved = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ data: [{ id: 'models/gemini-2.5-flash' }, { id: 'models/text-embedding-004' }] });
  assert.deepEqual(await listModels({ baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', apiKey: 'k' }), ['gemini-2.5-flash']);
  globalThis.fetch = saved;
});
console.log(`${pass} brain checks passed`);
