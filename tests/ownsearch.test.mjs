// Search numbers from a person's own service (Settings · Knowledge): the saved choice is kept to a known key or
// their server and a plain model name, it's only used when the plan allows it, and the embedder sends the key only to
// a public https address, refuses redirects, says problems plainly and rejects numbers it can't use.
import assert from 'node:assert/strict';
import { cleanKnowledgePrefs, cleanOwnSearch, knowledgeAccess } from '../packages/shared/src/knowledge.ts';
import { knSearchOf } from '../packages/shared/src/knowledgeDevice.ts';
import { ownEmbedder } from '../apps/api/src/ownEmbed.ts';
import { store, fakeDb } from './brains-stubs.mjs';

let pass = 0;
const ok = async (name, fn) => { try { await fn(); pass++; console.log('PASS', name); } catch (e) { console.log('FAIL', name, e?.stack ?? e?.message); process.exitCode = 1; } };
const user = { id: 'u1' };

await ok('the choice is a known key or their server, with a plain model name', () => {
  assert.deepEqual(cleanOwnSearch({ ref: 'key:abc-1', model: ' text-embedding-3-small ' }), { ref: 'key:abc-1', model: 'text-embedding-3-small' });
  assert.deepEqual(cleanOwnSearch({ ref: 'self-hosted-ai', model: 'nomic-embed-text:latest' }), { ref: 'self-hosted-ai', model: 'nomic-embed-text:latest' });
  assert.equal(cleanOwnSearch({ ref: 'workers-ai', model: 'x' }), null);
  assert.equal(cleanOwnSearch({ ref: 'key:../x', model: 'x' }), null);
  assert.equal(cleanOwnSearch({ ref: 'key:a', model: '' }), null);
  assert.equal(cleanOwnSearch({ ref: 'key:a', model: '"; drop table' }).model, 'droptable');
  const p = cleanKnowledgePrefs({ search: 'own', own: { ref: 'self-hosted-ai', model: 'm' } });
  assert.equal(p.search, 'own'); assert.deepEqual(p.own, { ref: 'self-hosted-ai', model: 'm' });
  assert.equal(cleanKnowledgePrefs({ search: 'elsewhere' }).search === 'elsewhere', false);
});

await ok('their own service is used only when the plan allows that kind', () => {
  const prefs = { search: 'own', own: { ref: 'self-hosted-ai', model: 'm' } };
  const all = { cloudflareSearch: true, ownKey: true, ownServer: true };
  assert.equal(knSearchOf(prefs, all, 'niko'), 'own');
  assert.equal(knSearchOf(prefs, all, 'device'), 'device', 'files on the device are searched on the device');
  assert.notEqual(knSearchOf(prefs, { ...all, ownServer: false }, 'niko'), 'own');
  assert.equal(knSearchOf({ search: 'own', own: { ref: 'key:a', model: 'm' } }, { ...all, ownKey: false }, 'niko') === 'own', false);
  assert.notEqual(knSearchOf({ search: 'own', own: null }, all, 'niko'), 'own');
  const a = knowledgeAccess((id) => id !== 'kn:search-server');
  assert.equal(a.ownKey, a.files); assert.equal(a.ownServer, false);
});

const realFetch = globalThis.fetch;
const serve = (fn) => { const calls = []; globalThis.fetch = async (url, init) => { calls.push({ url: String(url), init }); return fn(JSON.parse(init.body), url, init); }; return calls; };
const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
const vecs = (input, dims = 4) => input.map((_, i) => ({ index: i, embedding: Array.from({ length: dims }, (_, j) => (i + 1) / (j + 2)) }));

await ok('their server: numbers in order, in batches of 32, key sent only as a bearer, no redirects', async () => {
  store.creds['self-hosted-ai'] = { baseUrl: 'https://models.example.com/v1/', apiKey: 'sk-own' };
  const calls = serve((b) => json({ data: vecs(b.input).reverse() }));
  const e = await ownEmbedder({}, fakeDb, user, { ref: 'self-hosted-ai', model: 'nomic-embed-text' });
  const out = await e(Array.from({ length: 40 }, (_, i) => `piece ${i}`));
  assert.equal(out.length, 40); assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'https://models.example.com/v1/embeddings');
  assert.equal(calls[0].init.headers.authorization, 'Bearer sk-own');
  assert.equal(calls[0].init.redirect, 'error');
  assert.equal(JSON.parse(calls[0].init.body).model, 'nomic-embed-text');
  assert.equal(JSON.parse(calls[1].init.body).input.length, 8);
  assert.equal(out[0][0], 1 / 2, 'answers are put back in order');
});

await ok('a server that is not public https is refused before anything is sent', async () => {
  for (const baseUrl of ['http://models.example.com/v1', 'https://127.0.0.1:11434/v1', 'https://192.168.1.5/v1']) {
    store.creds['self-hosted-ai'] = { baseUrl, apiKey: 'sk-own' };
    const calls = serve(() => json({ data: [] }));
    await assert.rejects(ownEmbedder({}, fakeDb, user, { ref: 'self-hosted-ai', model: 'm' }), /public https/);
    assert.equal(calls.length, 0, baseUrl);
  }
});

await ok('problems are said plainly, never with the key', async () => {
  store.creds['self-hosted-ai'] = { baseUrl: 'https://models.example.com/v1', apiKey: 'sk-secret' };
  const cases = [
    [() => json({ error: 'no' }, 401), /refused the key/],
    [() => json({ error: 'no' }, 404), /doesn’t know the model “m”/],
    [() => json({ error: 'busy' }, 503), /answered 503/],
    [(b) => json({ data: vecs(b.input).slice(1) }), /don’t match/],
    [(b) => json({ data: b.input.map((_, i) => ({ index: i, embedding: ['x'] })) }), /can’t use/],
    [(b) => json({ data: b.input.map((_, i) => ({ index: i, embedding: new Array(5000).fill(0.1) })) }), /can’t use/],
    [() => { throw new TypeError('network'); }, /didn’t answer in time/],
  ];
  for (const [fn, re] of cases) {
    serve(fn);
    const e = await ownEmbedder({}, fakeDb, user, { ref: 'self-hosted-ai', model: 'm' });
    await assert.rejects(e(['a']), (err) => re.test(err.message) && !err.message.includes('sk-secret'));
  }
  // Numbers that change size between calls can't be compared, so they're refused.
  let dims = 4;
  serve((b) => json({ data: vecs(b.input, dims) }));
  const e = await ownEmbedder({}, fakeDb, user, { ref: 'self-hosted-ai', model: 'm' });
  await e(['a']); dims = 8;
  await assert.rejects(e(['b']), /changed the size/);
});

await ok('a key that is not theirs, or a server not set up, is refused', async () => {
  delete store.creds['self-hosted-ai'];
  await assert.rejects(ownEmbedder({}, fakeDb, user, { ref: 'self-hosted-ai', model: 'm' }), /isn’t set up/);
  await assert.rejects(ownEmbedder({}, fakeDb, user, { ref: 'key:someone-else', model: 'm' }), /isn’t on your Engine page/);
});

globalThis.fetch = realFetch;
console.log(`own search: ${pass} passed`);
