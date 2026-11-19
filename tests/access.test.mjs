// Admin control of AI options: the default for everyone with one account's changes on top, admins with everything,
// whole sections switched off, and brains, pictures and speech in skipping what is off (keys go by their service).
import assert from 'node:assert/strict';
import { aiAllowed, aiHasBrain, aiOff, brainOption, cleanAiAccess, defaultOn, hearOption, imageOption, voiceOption, AI_OPTION_KEYS } from '../packages/shared/src/index.ts';
import { think } from '../apps/api/src/brains.ts';
import { paint } from '../apps/api/src/images.ts';
import { hear } from '../apps/api/src/hears.ts';
import { store, fakeDb } from './brains-stubs.mjs';

let pass = 0;
const ok = async (name, fn) => { try { await fn(); pass++; console.log('PASS', name); } catch (e) { console.log('FAIL', name, e?.stack ?? e?.message); process.exitCode = 1; } };
const calls = [];
globalThis.fetch = async (url, init = {}) => { calls.push(String(url)); return reply(String(url), init); };
let reply = () => Response.json({});

await ok('the default, then one account’s changes on top; missing means on; admins have everything', () => {
  const defaults = { 'ai:anthropic': false, 'img:fal': false };
  const startOff = ['h:only-me', 'kn:files', 'kn:learning']; // options that start off until the admin turns them on
  assert.deepEqual(aiOff(defaults, {}), ['ai:anthropic', 'img:fal', ...startOff]);
  assert.deepEqual(aiOff(defaults, { 'ai:anthropic': true, 'v:kokoro': false }), ['img:fal', 'v:kokoro', ...startOff]);
  assert.deepEqual(aiOff(defaults, { 'v:kokoro': false }, true), []);
  assert.deepEqual(aiOff({}, {}), ['h:only-me', 'kn:files', 'kn:learning']);
});
await ok('options that start off stay off until the admin turns them on, for everyone or one person', () => {
  assert.equal(defaultOn({}, 'kn:files'), false);
  assert.equal(defaultOn({}, 'kn:cf-search'), true);
  assert.equal(defaultOn({ 'kn:files': true }, 'kn:files'), true);
  assert.ok(!aiOff({ 'kn:files': true }, {}).includes('kn:files'));
  assert.ok(aiOff({ 'kn:files': true }, { 'kn:files': false }).includes('kn:files'));
  assert.ok(!aiOff({}, { 'h:only-me': true }).includes('h:only-me'));
  assert.deepEqual(aiOff({}, {}, true), []);
});
await ok('only known options with true/false are kept', () => {
  assert.deepEqual(cleanAiAccess({ 'ai:openai': false, nope: false, 'v:kokoro': 'no', 'sec:images': true }), { 'ai:openai': false, 'sec:images': true });
  assert.ok(AI_OPTION_KEYS.includes('sec:voices') && AI_OPTION_KEYS.includes('h:self-hosted') && AI_OPTION_KEYS.includes('img:recraft'));
});
await ok('a section that is off turns off everything in it; brains have no section', () => {
  assert.equal(aiAllowed(['sec:images'], 'img:workers'), false);
  assert.equal(aiAllowed(['sec:images'], 'v:workers'), true);
  assert.equal(aiAllowed(['ai:groq'], 'ai:openai'), true);
  assert.equal(aiHasBrain(['workers-ai', 'self-hosted-ai']), true);
  assert.equal(aiHasBrain(AI_OPTION_KEYS.filter((k) => k === 'workers-ai' || k === 'self-hosted-ai' || k.startsWith('ai:'))), false);
});
await ok('keys belong to the service they were saved for', () => {
  assert.equal(brainOption('key:a', 'https://api.anthropic.com/v1'), 'ai:anthropic');
  assert.equal(brainOption('key:a', 'https://llm.example.com/v1'), 'ai:other');
  assert.equal(brainOption('workers-ai'), 'workers-ai');
  assert.equal(imageOption('ikey:a', { provider: 'openai', baseUrl: 'https://api.x.ai/v1' }), 'img:xai');
  assert.equal(imageOption('ikey:a', { provider: 'fal', baseUrl: '' }), 'img:fal');
  assert.equal(voiceOption('vkey:a', { provider: 'elevenlabs', baseUrl: '' }), 'v:elevenlabs');
  assert.equal(voiceOption('kokoro'), 'v:kokoro');
  assert.equal(hearOption('skey:a', { provider: 'openai', baseUrl: 'https://api.groq.com/openai/v1' }), 'h:groq');
});

const env = { AI: { run: async () => ({ response: 'from cloudflare' }) } };
await ok('brains: a key for a service that is off is skipped, and the next brain answers', async () => {
  store.creds = { 'custom-ai': { keys: [{ id: 'a1', baseUrl: 'https://api.anthropic.com/v1', model: 'claude-haiku-4-5', apiKey: 'K' }] } };
  calls.length = 0; store.engineWrites = [];
  const r = await think(env, fakeDb, { id: 'u', engine: { brains: ['key:a1', 'workers-ai'] } }, [{ role: 'user', content: 'hi' }], ['ai:anthropic']);
  assert.equal(r.used, 'workers-ai'); assert.equal(r.reply, 'from cloudflare'); assert.equal(calls.length, 0);
});
await ok('brains: with everything in the order off, Cloudflare answers if allowed; otherwise a clear refusal', async () => {
  const r = await think(env, fakeDb, { id: 'u', engine: { brains: ['key:a1'] } }, [{ role: 'user', content: 'hi' }], ['ai:anthropic']);
  assert.equal(r.used, 'workers-ai');
  await assert.rejects(() => think(env, fakeDb, { id: 'u', engine: { brains: ['key:a1'] } }, [{ role: 'user', content: 'hi' }], ['ai:anthropic', 'workers-ai']), (e) => e.why === 'refused');
});
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 1, 0, 0, 1]).toString('base64');
const ienv = { AI: { run: async () => ({ image: JPEG }) } };
await ok('pictures: off altogether refuses at once; a service that is off is skipped', async () => {
  await assert.rejects(() => paint(ienv, fakeDb, { id: 'u', engine: {} }, 'x', 'square', undefined, ['sec:images']), (e) => e.message === 'not on account');
  store.creds = { 'image-keys': { keys: [{ id: 'f1', provider: 'fal', apiKey: 'K' }] } };
  calls.length = 0;
  const r = await paint(ienv, fakeDb, { id: 'u', engine: { images: ['ikey:f1', 'workers'] } }, 'x', 'square', undefined, ['img:fal']);
  assert.equal(r.used, 'workers'); assert.equal(calls.length, 0);
  await assert.rejects(() => paint(ienv, fakeDb, { id: 'u', engine: {} }, 'x', 'square', { entry: 'workers' }, ['img:workers']), (e) => e.message === 'not on account');
});
await ok('speech in: a service that is off is skipped (the device then listens)', async () => {
  const wav = new Uint8Array(2000); new TextEncoder().encodeInto('RIFF', wav); new TextEncoder().encodeInto('WAVE', wav.subarray(8));
  store.creds = { 'hear-keys': { keys: [{ id: 'g1', provider: 'openai', baseUrl: 'https://api.groq.com/openai/v1', apiKey: 'K' }] } };
  const henv = { AI: { run: async () => ({ text: 'cloudflare heard' }) } };
  calls.length = 0;
  const r = await hear(henv, fakeDb, { id: 'u', engine: { hears: ['skey:g1', 'workers'] } }, wav, 'en', undefined, ['h:groq']);
  assert.equal(r.used, 'workers'); assert.equal(calls.length, 0);
  await assert.rejects(() => hear(henv, fakeDb, { id: 'u', engine: { hears: ['skey:g1', 'workers'] } }, wav, 'en', undefined, ['sec:hears']));
});
console.log(`${pass} access checks passed`);
