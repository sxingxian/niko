// Speech in: each service is called the way it expects, uploads are checked, and the order switches on failure.
import assert from 'node:assert/strict';
import { transcribeWithKey, audioProblem, hear, workersStt } from '../apps/api/src/hears.ts';
import { store, fakeDb } from './brains-stubs.mjs';

let pass = 0;
const ok = async (name, fn) => { try { await fn(); pass++; console.log('PASS', name); } catch (e) { console.log('FAIL', name, e?.message); process.exitCode = 1; } };
// A tiny valid WAV header plus some silence.
const wav = new Uint8Array(2000); new TextEncoder().encodeInto('RIFF', wav); new TextEncoder().encodeInto('WAVE', wav.subarray(8));
let last = null, reply = () => Response.json({ text: 'hello there' });
globalThis.fetch = async (url, init = {}) => { last = { url: String(url), init }; return reply(String(url)); };
const base = { id: 'a', label: '', model: '', baseUrl: '', region: '', apiKey: 'KEY' };

await ok('uploads must be a WAV of sensible size', () => {
  assert.equal(audioProblem(wav), null);
  assert.ok(audioProblem(new Uint8Array(10)));
  assert.ok(audioProblem(new Uint8Array(3000)));
  assert.ok(audioProblem(new Uint8Array(3 * 1024 * 1024)));
});
await ok('OpenAI-compatible (Groq): multipart file, model and short language', async () => {
  const t = await transcribeWithKey({ ...base, provider: 'openai', baseUrl: 'https://api.groq.com/openai/v1', model: 'whisper-large-v3-turbo' }, wav, 'en-SG');
  assert.equal(t, 'hello there'); assert.equal(last.url, 'https://api.groq.com/openai/v1/audio/transcriptions');
  assert.equal(last.init.body.get('model'), 'whisper-large-v3-turbo'); assert.equal(last.init.body.get('language'), 'en'); assert.equal(last.init.body.get('file').type, 'audio/wav');
  assert.equal(last.init.redirect, 'manual');
});
await ok('Deepgram: WAV body, Token key, model and language in the query', async () => {
  reply = () => Response.json({ results: { channels: [{ alternatives: [{ transcript: 'open my notes' }] }] } });
  assert.equal(await transcribeWithKey({ ...base, provider: 'deepgram', model: 'nova-3' }, wav, 'en'), 'open my notes');
  assert.ok(last.url.startsWith('https://api.deepgram.com/v1/listen?model=nova-3') && last.url.includes('language=en'));
  assert.equal(last.init.headers.authorization, 'Token KEY'); assert.equal(last.init.headers['content-type'], 'audio/wav');
});
await ok('ElevenLabs Scribe and Fish Audio ASR: multipart with their own field names', async () => {
  reply = () => Response.json({ text: 'x' });
  await transcribeWithKey({ ...base, provider: 'elevenlabs', model: 'scribe_v1' }, wav, 'en');
  assert.equal(last.url, 'https://api.elevenlabs.io/v1/speech-to-text'); assert.equal(last.init.body.get('model_id'), 'scribe_v1'); assert.equal(last.init.headers['xi-api-key'], 'KEY');
  await transcribeWithKey({ ...base, provider: 'fishaudio' }, wav, 'en');
  assert.equal(last.url, 'https://api.fish.audio/v1/asr'); assert.ok(last.init.body.get('audio')); assert.equal(last.init.headers.authorization, 'Bearer KEY');
});
await ok('Google: LINEAR16 at 16 kHz, full language code, results joined', async () => {
  reply = () => Response.json({ results: [{ alternatives: [{ transcript: 'what is' }] }, { alternatives: [{ transcript: 'the weather' }] }] });
  assert.equal(await transcribeWithKey({ ...base, provider: 'google' }, wav, 'en-GB'), 'what is the weather');
  const b = JSON.parse(last.init.body);
  assert.equal(b.config.encoding, 'LINEAR16'); assert.equal(b.config.sampleRateHertz, 16000); assert.equal(b.config.languageCode, 'en-GB');
});
await ok('Azure: regional host, PCM WAV content type, DisplayText', async () => {
  reply = () => Response.json({ RecognitionStatus: 'Success', DisplayText: 'Send it.' });
  assert.equal(await transcribeWithKey({ ...base, provider: 'azure', region: 'eastus' }, wav, 'en-US'), 'Send it.');
  assert.ok(last.url.startsWith('https://eastus.stt.speech.microsoft.com/') && last.url.includes('language=en-US'));
  await assert.rejects(() => transcribeWithKey({ ...base, provider: 'azure', region: 'x.evil' }, wav, 'en'));
});
await ok('Cloudflare Whisper: base64 audio; the daily allowance rests it until midnight UTC', async () => {
  let got = null;
  const env = { AI: { run: async (m, i) => { got = { m, i }; return { text: ' hi ' }; } } };
  assert.equal(await workersStt(env, wav, 'en'), 'hi'); assert.equal(got.m, '@cf/openai/whisper-large-v3-turbo'); assert.equal(typeof got.i.audio, 'string'); assert.equal(got.i.language, 'en');
  const out = { AI: { run: async () => { throw new Error('4006: daily free allocation'); } } };
  await assert.rejects(() => workersStt(out, wav, 'en'), (e) => e.why === 'limit' && new Date(Date.now() + e.restMs).getUTCHours() === 0);
});
await ok('the order: a key out of quota hands over to the next, and rests', async () => {
  store.creds = { 'hear-keys': { keys: [{ id: 'k1', provider: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: 'A' }, { id: 'k2', provider: 'deepgram', apiKey: 'B' }] } };
  reply = (url) => url.includes('openai.com') ? new Response(JSON.stringify({ error: { message: 'You exceeded your current quota' } }), { status: 429 }) : Response.json({ results: { channels: [{ alternatives: [{ transcript: 'from deepgram' }] }] } });
  store.engineWrites = [];
  const r = await hear({}, fakeDb, { id: 'u', engine: { hears: ['skey:k1', 'skey:k2'] } }, wav, 'en');
  assert.equal(r.text, 'from deepgram'); assert.equal(r.used, 'skey:k2'); assert.equal(store.engineWrites.at(-1).hearRest['skey:k1'].why, 'limit');
});
await ok('a resting key is skipped while another can hear', async () => {
  reply = (url) => (url.includes('openai.com') ? Response.json({ text: 'openai' }) : Response.json({ results: { channels: [{ alternatives: [{ transcript: 'deepgram' }] }] } }));
  const r = await hear({}, fakeDb, { id: 'u', engine: { hears: ['skey:k1', 'skey:k2'], hearRest: { 'skey:k1': { until: Date.now() + 60_000, why: 'limit' } } } }, wav, 'en');
  assert.equal(r.used, 'skey:k2');
});
await ok('nothing switched on, or everything failing, is an error (the app then uses the device)', async () => {
  await assert.rejects(() => hear({}, fakeDb, { id: 'u', engine: {} }, wav, 'en'));
  reply = () => new Response('down', { status: 503 });
  await assert.rejects(() => hear({}, fakeDb, { id: 'u', engine: { hears: ['skey:k1', 'skey:k2'] } }, wav, 'en'));
});
await ok('your own speech-to-text server: the saved address with /v1, whisper-1 by default, no key header without a key', async () => {
  store.creds = { 'self-hosted-hear': { baseUrl: 'https://whisper.example.com' } };
  reply = () => Response.json({ text: 'from my server' });
  const r = await hear({}, fakeDb, { id: 'u', engine: { hears: ['self-hosted'] } }, wav, 'en');
  assert.equal(r.text, 'from my server'); assert.equal(last.url, 'https://whisper.example.com/v1/audio/transcriptions');
  assert.equal(last.init.body.get('model'), 'whisper-1'); assert.equal(last.init.headers.authorization, undefined);
  store.creds = { 'self-hosted-hear': { baseUrl: 'https://whisper.example.com/v1', apiKey: 'S', model: 'Systran/faster-whisper-small' } };
  await hear({}, fakeDb, { id: 'u', engine: { hears: ['self-hosted'] } }, wav, 'en');
  assert.equal(last.url, 'https://whisper.example.com/v1/audio/transcriptions'); assert.equal(last.init.headers.authorization, 'Bearer S'); assert.equal(last.init.body.get('model'), 'Systran/faster-whisper-small');
});
console.log(`${pass} speech-in checks passed`);
