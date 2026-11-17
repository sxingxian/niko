// Pictures: each image service is called the way it expects, only real pictures come back, a service that declines a
// picture hands it to the next without resting, and the order switches and rests on failure like the brains and voices.
import assert from 'node:assert/strict';
import { Declined, imageKeyProblem, paint, paintWithKey, serverKey, sniffImage, workersImage } from '../apps/api/src/images.ts';
import { pictureCommand, takeImageTag } from '../apps/app/src/speech.ts';
import { store, fakeDb } from './brains-stubs.mjs';

let pass = 0;
const ok = async (name, fn) => { try { await fn(); pass++; console.log('PASS', name); } catch (e) { console.log('FAIL', name, e?.stack ?? e?.message); process.exitCode = 1; } };
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
const b64 = (u8) => Buffer.from(u8).toString('base64');
let calls = [], reply = () => Response.json({});
globalThis.fetch = async (url, init = {}) => { calls.push({ url: String(url), init }); return reply(String(url), init); };
const last = () => calls.at(-1);
const base = { id: 'a', label: '', model: '', baseUrl: '', apiKey: 'KEY' };
const jpegRes = (headers = {}) => new Response(JPEG, { headers: { 'content-type': 'image/jpeg', ...headers } });

await ok('only real pictures are accepted (JPEG, PNG, WebP), by their first bytes', () => {
  assert.equal(sniffImage(JPEG), 'image/jpeg'); assert.equal(sniffImage(PNG), 'image/png');
  const webp = new Uint8Array(16); new TextEncoder().encodeInto('RIFF', webp); new TextEncoder().encodeInto('WEBP', webp.subarray(8));
  assert.equal(sniffImage(webp), 'image/webp');
  assert.equal(sniffImage(new TextEncoder().encode('<svg onload=alert(1)></svg>')), null);
  assert.equal(sniffImage(new TextEncoder().encode('<html><script>x</script>')), null);
});
await ok('key settings are checked: addresses, and model names in each service’s own form', () => {
  assert.equal(imageKeyProblem({ provider: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-image-1' }), null);
  assert.ok(imageKeyProblem({ provider: 'openai', baseUrl: 'http://api.openai.com/v1', model: '' }));
  assert.ok(imageKeyProblem({ provider: 'openai', baseUrl: 'https://127.0.0.1/v1', model: '' }));
  assert.ok(imageKeyProblem({ provider: 'replicate', baseUrl: '', model: 'flux' }));
  assert.equal(imageKeyProblem({ provider: 'replicate', baseUrl: '', model: 'black-forest-labs/flux-schnell' }), null);
  assert.ok(imageKeyProblem({ provider: 'fal', baseUrl: '', model: '../../admin' }));
  assert.ok(imageKeyProblem({ provider: 'bfl', baseUrl: '', model: 'flux/../x' }));
  assert.ok(imageKeyProblem({ provider: 'ideogram', baseUrl: '', model: 'FAST' }));
  assert.ok(imageKeyProblem({ provider: 'nope', baseUrl: '', model: '' }));
});
await ok('OpenAI GPT Image: size by shape, no response_format (it always sends base64), no redirects', async () => {
  reply = () => Response.json({ data: [{ b64_json: b64(JPEG) }] });
  const p = await paintWithKey({ ...base, provider: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-image-1' }, 'a lighthouse', 'wide');
  assert.equal(p.type, 'image/jpeg'); assert.equal(last().url, 'https://api.openai.com/v1/images/generations');
  const b = JSON.parse(last().init.body);
  assert.equal(b.size, '1536x1024'); assert.equal(b.response_format, undefined); assert.equal(b.model, 'gpt-image-1');
  assert.equal(last().init.headers.authorization, 'Bearer KEY'); assert.equal(last().init.redirect, 'manual');
});
await ok('xAI and Together: asked for base64 in their own words', async () => {
  reply = () => Response.json({ data: [{ b64_json: b64(JPEG) }] });
  await paintWithKey({ ...base, provider: 'openai', baseUrl: 'https://api.x.ai/v1', model: 'grok-imagine-image' }, 'x', 'tall');
  let b = JSON.parse(last().init.body); assert.equal(b.response_format, 'b64_json'); assert.equal(b.aspect_ratio, '9:16');
  await paintWithKey({ ...base, provider: 'openai', baseUrl: 'https://api.together.xyz/v1', model: 'black-forest-labs/FLUX.1-schnell' }, 'x', 'square');
  b = JSON.parse(last().init.body); assert.equal(b.response_format, 'base64'); assert.equal(b.width, 1024);
});
await ok('a compatible service that doesn’t know an option is asked again with only the prompt', async () => {
  calls = [];
  reply = () => calls.length === 1 ? new Response(JSON.stringify({ error: { message: "Unknown parameter: 'response_format'" } }), { status: 400 }) : Response.json({ data: [{ b64_json: b64(PNG) }] });
  const p = await paintWithKey({ ...base, provider: 'openai', baseUrl: 'https://img.example.com/v1', model: 'm' }, 'x', 'square');
  assert.equal(p.type, 'image/png'); assert.equal(calls.length, 2); assert.equal(JSON.parse(calls[1].init.body).response_format, undefined);
});
await ok('a picture left at an address is downloaded without the key', async () => {
  calls = [];
  reply = (url) => url.includes('/images/generations') ? Response.json({ data: [{ url: 'https://cdn.example.com/p.jpg' }] }) : jpegRes();
  await paintWithKey({ ...base, provider: 'openai', baseUrl: 'https://img.example.com/v1', model: 'm' }, 'x', 'square');
  assert.equal(calls[1].url, 'https://cdn.example.com/p.jpg'); assert.equal(calls[1].init.headers, undefined);
});
await ok('something that is not a picture is refused, even with an image content type', async () => {
  reply = () => Response.json({ data: [{ b64_json: b64(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>')) }] });
  await assert.rejects(() => paintWithKey({ ...base, provider: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-image-1' }, 'x', 'square'), (e) => !(e instanceof Declined));
});
await ok('OpenAI declining under its safety rules is a decline, not a failure; a refused key is a failure', async () => {
  reply = () => new Response(JSON.stringify({ error: { code: 'moderation_blocked', message: 'Your request was rejected by the safety system.' } }), { status: 400 });
  await assert.rejects(() => paintWithKey({ ...base, provider: 'openai', baseUrl: 'https://api.openai.com/v1' }, 'x', 'square'), (e) => e instanceof Declined);
  reply = () => new Response(JSON.stringify({ error: { message: 'Incorrect API key provided' } }), { status: 401 });
  await assert.rejects(() => paintWithKey({ ...base, provider: 'openai', baseUrl: 'https://api.openai.com/v1' }, 'x', 'square'), (e) => e.why === 'refused');
});
await ok('Gemini: image modality and aspect ratio; the picture from inlineData; a blocked prompt is a decline', async () => {
  reply = () => Response.json({ candidates: [{ content: { parts: [{ text: 'here' }, { inlineData: { mimeType: 'image/png', data: b64(PNG) } }] } }] });
  const p = await paintWithKey({ ...base, provider: 'google', model: 'gemini-2.5-flash-image' }, 'x', 'wide');
  assert.equal(p.type, 'image/png'); assert.ok(last().url.endsWith('/models/gemini-2.5-flash-image:generateContent'));
  const b = JSON.parse(last().init.body); assert.deepEqual(b.generationConfig.responseModalities, ['IMAGE']); assert.equal(b.generationConfig.imageConfig.aspectRatio, '16:9');
  assert.equal(last().init.headers['x-goog-api-key'], 'KEY'); assert.ok(!last().url.includes('KEY'));
  reply = () => Response.json({ promptFeedback: { blockReason: 'PROHIBITED_CONTENT' } });
  await assert.rejects(() => paintWithKey({ ...base, provider: 'google' }, 'x', 'square'), (e) => e instanceof Declined);
  reply = () => Response.json({ candidates: [{ finishReason: 'IMAGE_SAFETY', content: { parts: [] } }] });
  await assert.rejects(() => paintWithKey({ ...base, provider: 'google' }, 'x', 'square'), (e) => e instanceof Declined);
});
await ok('Imagen: predict with an aspect ratio', async () => {
  reply = () => Response.json({ predictions: [{ bytesBase64Encoded: b64(JPEG) }] });
  await paintWithKey({ ...base, provider: 'google', model: 'imagen-4.0-generate-001' }, 'x', 'tall');
  assert.ok(last().url.endsWith(':predict')); assert.equal(JSON.parse(last().init.body).parameters.aspectRatio, '9:16');
});
await ok('Stability AI: multipart to the right endpoint, image back; its filter and its 403 are declines', async () => {
  reply = () => jpegRes({ 'finish-reason': 'SUCCESS' });
  await paintWithKey({ ...base, provider: 'stability', model: 'sd3.5-large' }, 'x', 'wide');
  assert.equal(last().url, 'https://api.stability.ai/v2beta/stable-image/generate/sd3'); assert.equal(last().init.body.get('model'), 'sd3.5-large');
  assert.equal(last().init.body.get('aspect_ratio'), '16:9'); assert.equal(last().init.headers.accept, 'image/*');
  await paintWithKey({ ...base, provider: 'stability', model: 'core' }, 'x', 'square');
  assert.equal(last().url, 'https://api.stability.ai/v2beta/stable-image/generate/core'); assert.equal(last().init.body.get('model'), null);
  reply = () => jpegRes({ 'finish-reason': 'CONTENT_FILTERED' });
  await assert.rejects(() => paintWithKey({ ...base, provider: 'stability' }, 'x', 'square'), (e) => e instanceof Declined);
  reply = () => new Response(JSON.stringify({ name: 'content_moderation', errors: ['Your request was flagged by our content moderation system'] }), { status: 403 });
  await assert.rejects(() => paintWithKey({ ...base, provider: 'stability' }, 'x', 'square'), (e) => e instanceof Declined);
});
await ok('fal: Key auth, safety checker on, picture in the answer; its safety flag is a decline; odd hosts refused', async () => {
  reply = () => Response.json({ images: [{ url: `data:image/jpeg;base64,${b64(JPEG)}` }], has_nsfw_concepts: [false] });
  await paintWithKey({ ...base, provider: 'fal', model: 'fal-ai/flux/schnell' }, 'x', 'wide');
  assert.equal(last().url, 'https://fal.run/fal-ai/flux/schnell'); assert.equal(last().init.headers.authorization, 'Key KEY');
  const b = JSON.parse(last().init.body); assert.equal(b.enable_safety_checker, true); assert.equal(b.sync_mode, true); assert.equal(b.image_size, 'landscape_16_9');
  reply = () => Response.json({ images: [{ url: `data:image/jpeg;base64,${b64(JPEG)}` }], has_nsfw_concepts: [true] });
  await assert.rejects(() => paintWithKey({ ...base, provider: 'fal' }, 'x', 'square'), (e) => e instanceof Declined);
  reply = () => Response.json({ images: [{ url: 'https://evil.example.com/p.jpg' }] });
  await assert.rejects(() => paintWithKey({ ...base, provider: 'fal' }, 'x', 'square'), (e) => !(e instanceof Declined));
});
await ok('Replicate: waits for the prediction, downloads from replicate.delivery; an NSFW failure is a decline', async () => {
  calls = [];
  reply = (url) => url.includes('api.replicate.com') ? Response.json({ status: 'succeeded', output: ['https://replicate.delivery/x/out-0.jpg'] }) : jpegRes();
  await paintWithKey({ ...base, provider: 'replicate', model: 'black-forest-labs/flux-schnell' }, 'x', 'square');
  assert.equal(calls[0].url, 'https://api.replicate.com/v1/models/black-forest-labs/flux-schnell/predictions');
  assert.match(calls[0].init.headers.prefer, /^wait=/); assert.equal(calls[1].url, 'https://replicate.delivery/x/out-0.jpg');
  reply = () => Response.json({ status: 'failed', error: 'NSFW content detected. Try running it again, or try a different prompt.' });
  await assert.rejects(() => paintWithKey({ ...base, provider: 'replicate', model: 'a/b' }, 'x', 'square'), (e) => e instanceof Declined);
});
await ok('Black Forest Labs: the key goes only to its own hosts; moderated is a decline', async () => {
  calls = [];
  reply = (url) => url === 'https://api.bfl.ai/v1/flux-pro-1.1' ? Response.json({ polling_url: 'https://api.bfl.ai/v1/get_result?id=1' })
    : url.startsWith('https://api.bfl.ai/v1/get_result') ? Response.json({ status: 'Ready', result: { sample: 'https://delivery-eu1.bfl.ai/r/p.jpg' } }) : jpegRes();
  await paintWithKey({ ...base, provider: 'bfl', model: 'flux-pro-1.1' }, 'x', 'wide');
  assert.equal(calls[1].init.headers['x-key'], 'KEY'); assert.equal(calls[2].url, 'https://delivery-eu1.bfl.ai/r/p.jpg'); assert.equal(calls[2].init.headers, undefined);
  reply = () => Response.json({ polling_url: 'https://collect.example.com/get_result?id=1' });
  await assert.rejects(() => paintWithKey({ ...base, provider: 'bfl' }, 'x', 'square'));
  assert.ok(!calls.some((c) => c.url.includes('collect.example.com')));
  reply = (url) => url.includes('get_result') ? Response.json({ status: 'Content Moderated' }) : Response.json({ polling_url: 'https://api.bfl.ai/v1/get_result?id=2' });
  await assert.rejects(() => paintWithKey({ ...base, provider: 'bfl' }, 'x', 'square'), (e) => e instanceof Declined);
});
await ok('Ideogram: Api-Key, speed and aspect ratio; an unsafe picture is a decline', async () => {
  reply = (url) => url.includes('api.ideogram.ai') ? Response.json({ data: [{ url: 'https://ideogram.ai/api/images/ephemeral/p.png', is_image_safe: true }] }) : jpegRes();
  calls = [];
  await paintWithKey({ ...base, provider: 'ideogram', model: 'TURBO' }, 'x', 'wide');
  assert.equal(calls[0].init.headers['Api-Key'], 'KEY'); assert.equal(calls[0].init.body.get('aspect_ratio'), '16x9'); assert.equal(calls[0].init.body.get('rendering_speed'), 'TURBO');
  reply = () => Response.json({ data: [{ is_image_safe: false }] });
  await assert.rejects(() => paintWithKey({ ...base, provider: 'ideogram' }, 'x', 'square'), (e) => e instanceof Declined);
});
await ok('Cloudflare FLUX: base64 picture back; the daily allowance rests it until midnight UTC', async () => {
  let got = null;
  const env = { AI: { run: async (m, i) => { got = { m, i }; return { image: b64(JPEG) }; } } };
  const p = await workersImage(env, 'a lighthouse'); assert.equal(p.type, 'image/jpeg'); assert.equal(got.m, '@cf/black-forest-labs/flux-1-schnell'); assert.equal(got.i.steps, 4); assert.equal('seed' in got.i, false, 'Cloudflare no longer takes a seed');
  const out = { AI: { run: async () => { throw new Error('4006: you have used up your daily free allocation of 10,000 neurons') } } };
  await assert.rejects(() => workersImage(out, 'x'), (e) => e.why === 'limit' && new Date(Date.now() + e.restMs).getUTCHours() === 0);
});

const env = { AI: { run: async () => ({ image: b64(JPEG) }) } };
await ok('the order: a service out of credit hands over to the next, and rests', async () => {
  store.creds = { 'image-keys': { keys: [{ id: 'k1', provider: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: 'A' }, { id: 'k2', provider: 'stability', apiKey: 'B' }] } };
  reply = (url) => url.includes('openai.com') ? new Response(JSON.stringify({ error: { message: 'Billing hard limit has been reached' } }), { status: 400 }) : jpegRes();
  store.engineWrites = [];
  const r = await paint(env, fakeDb, { id: 'u', engine: { images: ['ikey:k1', 'ikey:k2'] } }, 'x', 'square');
  assert.equal(r.used, 'ikey:k2'); assert.equal(r.label, 'Stability AI'); assert.equal(store.engineWrites.at(-1).imageRest['ikey:k1'].why, 'limit');
});
await ok('a service that declines the picture hands it to the next, and does not rest', async () => {
  reply = (url) => url.includes('openai.com') ? new Response(JSON.stringify({ error: { code: 'moderation_blocked', message: 'rejected by the safety system' } }), { status: 400 }) : jpegRes();
  store.engineWrites = [];
  const r = await paint(env, fakeDb, { id: 'u', engine: { images: ['ikey:k1', 'ikey:k2'] } }, 'x', 'square');
  assert.equal(r.used, 'ikey:k2'); assert.equal(store.engineWrites.length, 0);
});
await ok('when every service declines, the answer is that it was declined', async () => {
  reply = (url) => url.includes('openai.com') ? new Response(JSON.stringify({ error: { message: 'content policy violation' } }), { status: 400 }) : jpegRes({ 'finish-reason': 'CONTENT_FILTERED' });
  await assert.rejects(() => paint(env, fakeDb, { id: 'u', engine: { images: ['ikey:k1', 'ikey:k2'] } }, 'x', 'square'), (e) => e instanceof Declined && /OpenAI/.test(e.detail));
});
await ok('Cloudflare is used until the order is set; an empty order means pictures are off', async () => {
  const r = await paint(env, fakeDb, { id: 'u', engine: {} }, 'x', 'square'); assert.equal(r.used, 'workers');
  await assert.rejects(() => paint(env, fakeDb, { id: 'u', engine: { images: [] } }, 'x', 'square'), (e) => e.message === 'no services');
});
await ok('a resting service is tried last', async () => {
  reply = () => jpegRes();
  const r = await paint(env, fakeDb, { id: 'u', engine: { images: ['ikey:k2', 'workers'], imageRest: { 'ikey:k2': { until: Date.now() + 60_000, why: 'limit' } } } }, 'x', 'square');
  assert.equal(r.used, 'workers');
});

await ok('your own image server: the saved address (with /v1 added), no key header when it has no key', async () => {
  store.creds = { 'self-hosted-image': { baseUrl: 'https://nas.example.com', model: 'flux-dev' } };
  calls = []; reply = () => Response.json({ data: [{ b64_json: b64(JPEG) }] });
  const r = await paint(env, fakeDb, { id: 'u', engine: { images: ['self-hosted', 'workers'] } }, 'x', 'square');
  assert.equal(r.used, 'self-hosted'); assert.equal(r.label, 'Your image server');
  assert.equal(calls[0].url, 'https://nas.example.com/v1/images/generations'); assert.equal(calls[0].init.headers.authorization, undefined);
  assert.equal(JSON.parse(calls[0].init.body).model, 'flux-dev');
  assert.equal(serverKey({ baseUrl: 'https://x.example.com/api/v2/', apiKey: 'K' }, 'S').baseUrl, 'https://x.example.com/api/v2');
});
await ok('your own image server not set up: the next one paints', async () => {
  store.creds = {};
  const r = await paint(env, fakeDb, { id: 'u', engine: { images: ['self-hosted', 'workers'] } }, 'x', 'square');
  assert.equal(r.used, 'workers');
});

// ---- the app's side
await ok('the picture tag: prompt, shape, and the spoken text without it', () => {
  let t = takeImageTag('Painting a lighthouse at dusk. [[image:A watercolour lighthouse on a cliff at dusk]]');
  assert.equal(t.text, 'Painting a lighthouse at dusk.'); assert.equal(t.image.prompt, 'A watercolour lighthouse on a cliff at dusk'); assert.equal(t.image.shape, 'square');
  t = takeImageTag('Making a banner. [[image:wide: A mountain range at sunrise]]'); assert.equal(t.image.shape, 'wide'); assert.equal(t.image.prompt, 'A mountain range at sunrise');
  t = takeImageTag('[[image: portrait - a cat]]'); assert.equal(t.image.shape, 'tall');
  assert.equal(takeImageTag('Just an answer.').image, null);
});
await ok('what to do with the picture by voice', () => {
  for (const s of ['save it', 'Save the picture, please.', 'download it', 'okay Niko save this to my phone']) assert.equal(pictureCommand(s), 'save', s);
  for (const s of ['share it', 'Share the image.']) assert.equal(pictureCommand(s), 'share', s);
  for (const s of ['more like this', 'Make another one.', 'another version', 'one more', 'give me a different one']) assert.equal(pictureCommand(s), 'more', s);
  for (const s of ['close it', 'hide the picture']) assert.equal(pictureCommand(s), 'close', s);
  for (const s of ['make it night', 'add a dog', 'what is the weather', 'send it']) assert.equal(pictureCommand(s), null, s);
});
console.log(`${pass} picture checks passed`);

// Cloudflare's word filter: a refusal is followed by a plainer prompt, then the person's own words.
{
  const { workersImage, plainPrompt, clipPrompt } = await import('../apps/api/src/images.ts');
  const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const run = async (answers) => { const seen = []; const env = { AI: { run: async (_m, i) => { seen.push(i.prompt); const a = answers.shift(); if (a instanceof Error) throw a; return a; } } }; return { env, seen }; };
  const t = async (name, fn) => { try { await fn(); console.log('PASS', name); } catch (e) { console.log('FAIL', name, e?.stack ?? e); process.exitCode = 1; } };
  await t('a filtered prompt is tried again in plainer words, then in the person’s own words', async () => {
    const { env, seen } = await run([new Error('AiError: 3030: Input prompt contains NSFW content.'), new Error('AiError: 3030: Input prompt contains NSFW content.'), { image: PNG }]);
    const pic = await workersImage(env, 'A breathtaking wide-angle shot of a futuristic city, cinematic, dramatic smoky light', 'a futuristic city at night');
    assert.ok(pic.bytes.byteLength > 0);
    assert.equal(seen.length, 3); assert.ok(!/shot|cinematic|dramatic|smok/i.test(seen[1]), seen[1]); assert.equal(seen[2], 'a futuristic city at night');
  });
  await t('when every try is filtered, Niko says Cloudflare’s filter turned it down and why', async () => {
    const { env } = await run([1, 2, 3].map(() => new Error('AiError: 3030: Input prompt contains NSFW content.')));
    await assert.rejects(workersImage(env, 'a city at night, cinematic', 'a city'), (e) => e.message === 'declined' && /filter turned it down \(“Input prompt contains NSFW content\.”\)/.test(e.detail));
  });
  await t('other errors are not read as a refusal, and long prompts are cut to fit', async () => {
    const { env, seen } = await run([new Error('AiError: 3040: Capacity temporarily exceeded')]);
    await assert.rejects(workersImage(env, 'x'.repeat(10) + ' ' + 'word '.repeat(600), 'y'), (e) => e.why === 'down');
    assert.ok(seen[0].length <= 2000);
    assert.equal(clipPrompt('a b c', 3), 'a b');
    assert.equal(plainPrompt('A wide shot of a lake, stunning, captured at dawn'), 'A view of a lake, at dawn');
  });
}

{
  const { workersImage } = await import('../apps/api/src/images.ts');
  const t = async (name, fn) => { try { await fn(); console.log('PASS', name); } catch (e) { console.log('FAIL', name, e?.stack ?? e); process.exitCode = 1; } };
  const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  await t('a changed input format is not read as a refusal: the prompt alone is tried, then it rests briefly', async () => {
    const seen = [];
    const env = { AI: { run: async (_m, i) => { seen.push(Object.keys(i).sort().join(',')); if (i.steps) throw new Error("AiError: Error: Additional or unevaluated properties '/steps' at '/' not allowed"); return { image: PNG }; } } };
    const pic = await workersImage(env, 'a futuristic city', 'a city');
    assert.ok(pic.bytes.byteLength > 0); assert.deepEqual(seen, ['prompt,steps', 'prompt']);
    const bad = { AI: { run: async () => { throw new Error("AiError: Error: Additional or unevaluated properties '/seed' at '/' not allowed"); } } };
    await assert.rejects(workersImage(bad, 'a city'), (e) => e.why === 'down' && e.message !== 'declined');
  });
}
