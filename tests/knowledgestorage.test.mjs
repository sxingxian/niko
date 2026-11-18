// Knowledge in the person's own S3 storage: what they type is checked (https on a public name, a valid bucket, keys
// kept only for the same address), requests are signed exactly as AWS Signature Version 4 says (compared with
// botocore's signatures for the same requests), private addresses are refused before anything is sent, redirects are
// refused, a Cloudflare Access token goes in its headers, and problems are plain without the keys.
import assert from 'node:assert/strict';
import { cleanStorage, regionOf, shownStorage, signS3, storageRemoteOf, testStorage } from '../apps/api/src/knStorage.ts';
import { dns, forgetDns } from '../apps/api/src/safefetch.ts';

let pass = 0;
const ok = async (name, fn) => { try { await fn(); pass++; console.log('PASS', name); } catch (e) { console.log('FAIL', name, e?.stack ?? e?.message); process.exitCode = 1; } };
const base = { endpoint: 'https://s3.example.com', bucket: 'knowledge', accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY' };

await ok('what they type: https on a public name, a valid bucket, the region from the address', () => {
  const c = cleanStorage({ ...base, endpoint: 'https://S3.Example.com/' }, null);
  assert.deepEqual(c, { endpoint: 'https://s3.example.com', bucket: 'knowledge', region: 'us-east-1', accessKeyId: 'AKIDEXAMPLE', secretAccessKey: base.secretAccessKey });
  for (const endpoint of ['http://s3.example.com', 'https://192.168.1.10', 'https://nas.local', 'https://localhost', 'https://s3.example.com:9000', 'https://s3.example.com/?x=1', 'https://user:pw@s3.example.com'])
    assert.ok('problem' in cleanStorage({ ...base, endpoint }, null), endpoint);
  for (const bucket of ['ab', 'Has_Upper', 'a..b', '-dash', 'x'.repeat(64)]) assert.ok('problem' in cleanStorage({ ...base, bucket }, null), bucket);
  assert.equal(regionOf('s3.ap-southeast-1.amazonaws.com'), 'ap-southeast-1');
  assert.equal(regionOf('my-bucket.s3.eu-west-2.amazonaws.com'), 'eu-west-2');
  assert.equal(regionOf('s3.us-west-004.backblazeb2.com'), 'us-west-004');
  assert.equal(regionOf('abc.r2.cloudflarestorage.com'), 'us-east-1');
  assert.ok('problem' in cleanStorage({ ...base, accessId: 'id-only' }, null), 'Access needs both parts');
});

await ok('saved keys stay only for the same address, and are never shown again', () => {
  const saved = cleanStorage({ ...base, accessId: 'abc.access', accessSecret: 'secret-access-1' }, null);
  const same = cleanStorage({ endpoint: base.endpoint, bucket: 'other-bucket' }, saved);
  assert.equal(same.secretAccessKey, base.secretAccessKey); assert.equal(same.accessId, 'abc.access');
  assert.match(cleanStorage({ endpoint: 'https://evil.example.net', bucket: 'knowledge' }, saved).problem, /access key ID/);
  assert.deepEqual(shownStorage(saved), { endpoint: base.endpoint, bucket: 'knowledge', region: 'us-east-1', access: true });
  assert.ok(!JSON.stringify(shownStorage(saved)).includes('EXAMPLEKEY'));
});

await ok('signing matches AWS Signature Version 4 (botocore, for the same encoded path) for a PUT under a path and a GET', async () => {
  const when = new Date(Date.UTC(2026, 10, 19, 1, 2, 3));
  const put = await signS3({ ...base, endpoint: 'https://s3.example.com/base', bucket: 'my-bucket', region: 'us-east-1' }, 'PUT', 'niko-knowledge/Team-handbook (1)-ab12cd34.md', new TextEncoder().encode('# Hello\n\nNiko'), 'text/markdown; charset=utf-8', when);
  assert.equal(put.url, 'https://s3.example.com/base/my-bucket/niko-knowledge/Team-handbook%20%281%29-ab12cd34.md');
  assert.equal(put.headers.authorization, 'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20261119/us-east-1/s3/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=f9c78844aa68010497e437afbbda1896b1882b6a7f7b26e48b2d444ad7a92fa1');
  const get = await signS3({ ...base, endpoint: 'https://nas.example.com', bucket: 'knowledge', region: 'us-east-1' }, 'GET', 'niko-knowledge/a.csv', new Uint8Array(), null, when);
  assert.equal(get.headers.authorization, 'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20261119/us-east-1/s3/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=f758fd78df2eb6aa2f68cfe206782ad95cdb2601dad38cef14be9d215da82725');
  const tok = await signS3({ ...base, region: 'us-east-1', accessId: 'a.access', accessSecret: 'b-secret-x' }, 'GET', 'k', new Uint8Array(), null, when);
  assert.equal(tok.headers['cf-access-client-id'], 'a.access'); assert.equal(tok.headers['cf-access-client-secret'], 'b-secret-x');
});

const realFetch = globalThis.fetch, realLookup = dns.lookup;
const cfg = { ...cleanStorage(base, null) };
const serve = (fn) => { const calls = []; globalThis.fetch = async (url, init = {}) => { calls.push({ url: String(url), init }); return fn(String(url), init); }; return calls; };

await ok('a name that points at a private address is refused before anything is sent', async () => {
  forgetDns(); dns.lookup = async (_h, type) => (type === 'A' ? ['10.0.0.5'] : []);
  const calls = serve(() => new Response('x'));
  await assert.rejects(testStorage(cfg), /isn’t on the public internet/);
  assert.equal(calls.length, 0);
});

forgetDns(); dns.lookup = async (_h, type) => (type === 'A' ? ['203.0.114.10'] : []);
await ok('Test writes, reads back and removes a small file in niko-knowledge/', async () => {
  let stored = '';
  const calls = serve((url, init) => {
    if (init.method === 'PUT') { stored = new TextDecoder().decode(init.body); return new Response(null, { status: 200, headers: { etag: '"e1"' } }); }
    if (init.method === 'GET') return new Response(stored);
    return new Response(null, { status: 204 });
  });
  await testStorage(cfg);
  assert.deepEqual(calls.map((c) => c.init.method), ['PUT', 'GET', 'DELETE']);
  assert.match(calls[0].url, /^https:\/\/s3\.example\.com\/knowledge\/niko-knowledge\/\.niko-test-/);
  assert.ok(calls.every((c) => c.init.redirect === 'manual'));
});

await ok('copies: .md and .csv in niko-knowledge/, ETag as the version, gone on 404, removed on remove', async () => {
  const r = storageRemoteOf(cfg);
  const calls = serve((url, init) => (init.method === 'HEAD' && url.includes('gone') ? new Response(null, { status: 404 }) : new Response(init.method === 'GET' ? 'Name,Spend\r\nAcme,5\r\n' : null, { status: 200, headers: { etag: 'W/"abc"' } })));
  const w = await r.writeDoc('niko-knowledge/', 'Team handbook', '# Hi');
  assert.match(w.id, /^niko-knowledge\/Team-handbook-[0-9a-f]{8}\.md$/); assert.equal(w.version, 'abc'); assert.equal(w.url, null);
  assert.equal(calls[0].init.headers['content-type'], 'text/markdown; charset=utf-8');
  const s = await r.writeSheet('niko-knowledge/', { title: 'Clients', columns: ['Name', 'Spend'], rows: [['Acme', '=1+1']] }, { id: null, done: 0 });
  assert.match(s.id, /\.csv$/); assert.equal(new TextDecoder().decode(calls[1].init.body), 'Name,Spend\r\nAcme,\'=1+1\r\n');
  assert.equal(await r.version('niko-knowledge/gone.md'), null);
  assert.deepEqual(await r.readSheet('x.csv'), [['Name', 'Spend'], ['Acme', '5']]);
  await r.trash('niko-knowledge/x.md');
  assert.equal(calls.at(-1).init.method, 'DELETE');
});

await ok('problems are plain and never carry the keys; redirects are refused', async () => {
  const r = storageRemoteOf(cfg);
  const cases = [
    [new Response('<Error><Code>SignatureDoesNotMatch</Code></Error>', { status: 403 }), /refused the keys/],
    [new Response('<html>Cloudflare Access</html>', { status: 403 }), /Cloudflare Access stopped Niko/],
    [new Response('<Error><Code>NoSuchBucket</Code></Error>', { status: 404 }), /no bucket called “knowledge”/],
    [new Response(null, { status: 301, headers: { location: 'https://elsewhere.example.com' } }), /somewhere else/],
    [new Response('busy', { status: 503 }), /answered 503/],
  ];
  for (const [res, re] of cases) {
    serve(() => res);
    await assert.rejects(r.readDoc('k.md'), (e) => re.test(e.message) && !e.message.includes('EXAMPLEKEY') && !e.message.includes('AKID'));
  }
});

globalThis.fetch = realFetch; dns.lookup = realLookup;
console.log(`${pass} knowledge storage checks passed`);
