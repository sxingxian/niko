// Voice keys: each service is called the way it expects, failures are sorted into rests, and older keys still work.
import assert from 'node:assert/strict';
import { speakWithKey, listVoices, loadVoiceKeys, voiceKeyProblem, noteVoice } from '../apps/api/src/voices.ts';
import { voiceOrder } from '../packages/shared/src/index.ts';
import { store, fakeDb } from './brains-stubs.mjs';

let pass = 0;
const ok = async (name, fn) => { try { await fn(); pass++; console.log('PASS', name); } catch (e) { console.log('FAIL', name, e?.message); process.exitCode = 1; } };
let last = null, reply = () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'audio/mpeg' } });
globalThis.fetch = async (url, init = {}) => { last = { url: String(url), init, body: init.body ? String(init.body) : '' }; return reply(); };
const base = { label: '', model: '', baseUrl: '', region: '', apiKey: 'KEY' };

await ok('OpenAI: speech endpoint, bearer key, mp3', async () => {
  const a = await speakWithKey({ ...base, id: 'a', provider: 'openai', baseUrl: 'https://api.openai.com/v1', voice: 'nova', model: 'gpt-4o-mini-tts' }, 'Hello');
  assert.equal(last.url, 'https://api.openai.com/v1/audio/speech'); assert.equal(last.init.headers.authorization, 'Bearer KEY');
  assert.deepEqual(JSON.parse(last.body), { model: 'gpt-4o-mini-tts', voice: 'nova', input: 'Hello', response_format: 'mp3' });
  assert.equal(last.init.redirect, 'manual'); assert.equal(a.bytes.length, 3);
});
await ok('ElevenLabs: voice in the path, xi-api-key', async () => {
  await speakWithKey({ ...base, id: 'b', provider: 'elevenlabs', voice: 'abc123' }, 'Hi');
  assert.equal(last.url, 'https://api.elevenlabs.io/v1/text-to-speech/abc123/stream'); assert.equal(last.init.headers['xi-api-key'], 'KEY');
});
await ok('Google: language from the voice name, base64 audio decoded', async () => {
  reply = () => Response.json({ audioContent: btoa('\x01\x02\x03\x04') });
  const a = await speakWithKey({ ...base, id: 'c', provider: 'google', voice: 'en-GB-Neural2-A' }, 'Hi');
  assert.ok(last.url.startsWith('https://texttospeech.googleapis.com/v1/text:synthesize?key=KEY'));
  assert.equal(JSON.parse(last.body).voice.languageCode, 'en-GB'); assert.equal(a.bytes.length, 4); assert.equal(a.type, 'audio/mpeg');
  reply = () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'audio/mpeg' } });
});
await ok('Azure: regional host, SSML with the text escaped', async () => {
  await speakWithKey({ ...base, id: 'd', provider: 'azure', voice: 'en-US-AvaNeural', region: 'southeastasia' }, 'Tom & Jerry <3');
  assert.equal(last.url, 'https://southeastasia.tts.speech.microsoft.com/cognitiveservices/v1');
  assert.ok(last.body.includes('Tom &amp; Jerry &lt;3') && last.body.includes("name='en-US-AvaNeural'"));
});
await ok('Azure: a region that is not a plain name is refused before any request', async () => {
  last = null;
  await assert.rejects(() => speakWithKey({ ...base, id: 'd', provider: 'azure', voice: 'en-US-AvaNeural', region: 'evil.com/x' }, 'Hi'));
  assert.equal(last, null);
});
await ok('Deepgram: model as a query, Token key', async () => {
  await speakWithKey({ ...base, id: 'e', provider: 'deepgram', voice: 'aura-2-thalia-en' }, 'Hi');
  assert.equal(last.url, 'https://api.deepgram.com/v1/speak?model=aura-2-thalia-en&encoding=mp3'); assert.equal(last.init.headers.authorization, 'Token KEY');
});
await ok('Cartesia: version header, voice id, mp3 output', async () => {
  await speakWithKey({ ...base, id: 'f', provider: 'cartesia', voice: 'v-1', model: 'sonic-3.5' }, 'Hi');
  const b = JSON.parse(last.body);
  assert.equal(last.url, 'https://api.cartesia.ai/tts/bytes'); assert.ok(last.init.headers['cartesia-version']);
  assert.deepEqual(b.voice, { mode: 'id', id: 'v-1' }); assert.equal(b.output_format.container, 'mp3');
});
await ok('a usage limit, a refused key and a redirect are told apart', async () => {
  const k = { ...base, id: 'g', provider: 'openai', baseUrl: 'https://api.openai.com/v1', voice: 'nova' };
  reply = () => new Response(JSON.stringify({ error: { message: 'You exceeded your current quota' } }), { status: 429 });
  await assert.rejects(() => speakWithKey(k, 'x'), (e) => e.why === 'limit' && e.restMs >= 3_000_000);
  reply = () => new Response('nope', { status: 401 });
  await assert.rejects(() => speakWithKey(k, 'x'), (e) => e.why === 'refused');
  reply = () => new Response(null, { status: 302, headers: { location: 'https://evil.example' } });
  await assert.rejects(() => speakWithKey(k, 'x'), (e) => e.why === 'refused' && /redirect/.test(e.detail));
  reply = () => new Response('<html>hi</html>', { headers: { 'content-type': 'text/html' } });
  await assert.rejects(() => speakWithKey(k, 'x'), (e) => /did not send audio/.test(e.detail));
  reply = () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'audio/mpeg' } });
});
await ok('ElevenLabs free plan is reported as such', async () => {
  reply = () => new Response(JSON.stringify({ detail: { status: 'detected_unusual_activity', message: 'Unusual activity detected. Free Tier usage disabled.' } }), { status: 401 });
  await assert.rejects(() => speakWithKey({ ...base, id: 'b', provider: 'elevenlabs', voice: 'abc' }, 'x'), (e) => /free plan/.test(e.detail));
  reply = () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'audio/mpeg' } });
});
await ok('voice lists: ElevenLabs, Azure and Cartesia are read and tidied', async () => {
  reply = () => Response.json({ voices: [{ voice_id: 'v1', name: 'Me', category: 'cloned' }, { voice_id: 'bad id!', name: 'x' }] });
  assert.deepEqual(await listVoices({ ...base, id: 'b', provider: 'elevenlabs', voice: '' }), [{ id: 'v1', name: 'Me · your cloned voice' }]);
  reply = () => Response.json([{ ShortName: 'fr-FR-DeniseNeural', DisplayName: 'Denise', Locale: 'fr-FR' }, { ShortName: 'en-US-AvaNeural', DisplayName: 'Ava', Locale: 'en-US' }]);
  const az = await listVoices({ ...base, id: 'd', provider: 'azure', voice: '', region: 'eastus' });
  assert.equal(az[0].id, 'en-US-AvaNeural');
  reply = () => Response.json({ data: [{ id: 'c1', name: 'Kate', language: 'en' }] });
  assert.deepEqual(await listVoices({ ...base, id: 'f', provider: 'cartesia', voice: '' }), [{ id: 'c1', name: 'Kate · en' }]);
  reply = () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'audio/mpeg' } });
});
await ok('settings are checked: OpenAI needs a public https address, others need a voice', () => {
  assert.ok(voiceKeyProblem({ provider: 'openai', voice: '', baseUrl: 'http://10.0.0.1', region: '' }));
  assert.ok(voiceKeyProblem({ provider: 'deepgram', voice: '', baseUrl: '', region: '' }));
  assert.ok(voiceKeyProblem({ provider: 'google', voice: "en-US'><x>", baseUrl: '', region: '' }));
  assert.equal(voiceKeyProblem({ provider: 'openai', voice: '', baseUrl: 'https://api.groq.com/openai/v1', region: '' }), null);
});
await ok('an ElevenLabs key saved before is read as voice key el1, and the old order still finds it', async () => {
  store.creds = { elevenlabs: { apiKey: 'OLD', voiceId: 'v9' } };
  const keys = await loadVoiceKeys({}, fakeDb, 'u1');
  assert.equal(keys[0].id, 'el1'); assert.equal(keys[0].voice, 'v9'); assert.equal(keys[0].provider, 'elevenlabs');
  assert.deepEqual(voiceOrder({ voices: ['elevenlabs', 'workers'] }), ['vkey:el1', 'workers']);
  assert.deepEqual(voiceOrder({ voice: 'elevenlabs' }), ['vkey:el1', 'workers']);
  assert.deepEqual(voiceOrder({ voices: ['vkey:abc', 'nope', 'kokoro'] }), ['vkey:abc', 'kokoro']);
});
await ok('a failure sets a rest on the account, and speaking again clears it', async () => {
  store.engineWrites = [];
  const r = await noteVoice(fakeDb, { id: 'u1', engine: {} }, 'vkey:a', { why: 'limit', restMs: 60_000 });
  assert.equal(r.why, 'limit'); assert.ok(store.engineWrites.at(-1).voiceRest['vkey:a']);
  await noteVoice(fakeDb, { id: 'u1', engine: { voiceRest: { 'vkey:a': r } } }, 'vkey:a', null);
  assert.deepEqual(store.engineWrites.at(-1).voiceRest, {});
});
console.log(`${pass} voice checks passed`);
