// Obsidian as a place: what people type is checked for both ways in (synced through S3, or the Local REST API through
// their tunnel); notes get readable names in Niko's folder (never outside it); sheets are Markdown tables that read back
// exactly; changes are seen through the version; problems are plain and never carry the keys; private addresses are
// refused before anything is sent. Also: other places name Niko's folder as the person chose.
import assert from 'node:assert/strict';
import { cleanObsidian, noteName, obsidianRemoteOf, shownObsidian, testObsidian } from '../apps/api/src/knObsidian.ts';
import { storageRemoteOf, cleanStorage } from '../apps/api/src/knStorage.ts';
import { cleanFolder, cleanKnowledgePrefs, knFolder } from '../packages/shared/src/knowledge.ts';
import { dns, forgetDns } from '../apps/api/src/safefetch.ts';

let pass = 0;
const ok = async (name, fn) => { try { await fn(); pass++; console.log('PASS', name); } catch (e) { console.log('FAIL', name, e?.stack ?? e?.message); process.exitCode = 1; } };
const KEY = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8';

await ok('what they type: the S3 way like their own storage plus a folder; the REST way an https tunnel and the API key', () => {
  const s3 = cleanObsidian({ mode: 's3', endpoint: 'https://abc.r2.cloudflarestorage.com', bucket: 'obsidian', accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret-key-123456', prefix: '/My vault/', vault: 'My vault' }, null);
  assert.equal(s3.mode, 's3'); assert.equal(s3.prefix, 'My vault/'); assert.equal(s3.vault, 'My vault');
  assert.match(cleanObsidian({ mode: 's3', endpoint: 'https://abc.r2.cloudflarestorage.com', bucket: 'obsidian', accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret-key-123456', prefix: 'a/../b' }, null).problem, /folder in the bucket/);
  const rest = cleanObsidian({ mode: 'rest', address: 'https://obsidian.example.com/', apiKey: KEY }, null);
  assert.deepEqual(rest, { mode: 'rest', address: 'https://obsidian.example.com', apiKey: KEY });
  for (const address of ['http://obsidian.example.com', 'https://127.0.0.1:27124', 'https://localhost', 'https://obsidian.example.com:27124']) assert.ok('problem' in cleanObsidian({ mode: 'rest', address, apiKey: KEY }, null), address);
  assert.match(cleanObsidian({ mode: 'rest', address: 'https://obsidian.example.com', apiKey: 'short' }, null).problem, /API key/);
  // The key stays only for the same address; it's never shown again.
  assert.equal(cleanObsidian({ mode: 'rest', address: 'https://obsidian.example.com' }, rest).apiKey, KEY);
  assert.ok('problem' in cleanObsidian({ mode: 'rest', address: 'https://evil.example.net' }, rest));
  assert.ok(!JSON.stringify(shownObsidian(rest)).includes(KEY)); assert.ok(!JSON.stringify(shownObsidian(s3)).includes('secret-key'));
});

await ok('note names are readable and safe; folders people choose are cleaned', () => {
  assert.equal(noteName('Team handbook'), 'Team handbook');
  assert.equal(noteName('Q1 [draft] #2 | final^'), 'Q1 draft 2 final');
  assert.equal(noteName('../../.secret'), 'secret');
  assert.equal(cleanFolder('obsidian', ' Areas / Niko Knowledge '), 'Areas/Niko Knowledge');
  assert.equal(cleanFolder('obsidian', '../x'), 'x');
  assert.equal(cleanFolder('gdrive', 'Work/Niko'), 'Work Niko', 'Drive and OneDrive take one name');
  assert.equal(cleanFolder('s3', '...'), null);
  assert.equal(knFolder(cleanKnowledgePrefs({}), 'gdrive'), 'Niko Knowledge');
  assert.equal(knFolder(cleanKnowledgePrefs({ folders: { s3: 'notes/niko', evil: 'x', gdrive: '' } }), 's3'), 'notes/niko');
  assert.deepEqual(cleanKnowledgePrefs({ folders: { evil: 'x', gdrive: '' } }).folders, {});
});

const realFetch = globalThis.fetch, realLookup = dns.lookup;
const serve = (fn) => { const calls = []; globalThis.fetch = async (url, init = {}) => { calls.push({ url: String(url), init }); return fn(String(url), init); }; return calls; };
const restCfg = cleanObsidian({ mode: 'rest', address: 'https://obsidian.example.com', apiKey: KEY, accessId: 'svc.access', accessSecret: 'svc-secret-1', vault: 'My vault' }, null);

await ok('a tunnel name that points at a private address is refused before anything is sent', async () => {
  forgetDns(); dns.lookup = async (_h, type) => (type === 'A' ? ['192.168.1.20'] : []);
  const calls = serve(() => new Response('x'));
  await assert.rejects(testObsidian(restCfg), /isn’t on the public internet/);
  assert.equal(calls.length, 0);
});
forgetDns(); dns.lookup = async (_h, type) => (type === 'A' ? ['203.0.114.10'] : []);

/** A stand-in Local REST API: notes in memory, mtime that moves on each write. */
function fakeVault() {
  const notes = new Map(); let t = 1000;
  const calls = serve((url, init) => {
    const u = new URL(url); const path = decodeURIComponent(u.pathname.replace(/^\/vault\//, ''));
    if (init.headers.authorization !== `Bearer ${KEY}`) return new Response('{}', { status: 401 });
    if (init.method === 'PUT') { notes.set(path, { text: init.body, mtime: ++t }); return new Response(null, { status: 204 }); }
    if (init.method === 'DELETE') { if (!notes.has(path)) return new Response('{}', { status: 404 }); notes.delete(path); return new Response(null, { status: 204 }); }
    const n = notes.get(path); if (!n) return new Response('{}', { status: 404 });
    if (init.headers.accept === 'application/vnd.olrapi.note+json') return Response.json({ path, content: n.text, stat: { mtime: n.mtime, size: n.text.length, ctime: 1 }, tags: [], frontmatter: {} });
    return new Response(n.text);
  });
  return { notes, calls };
}

await ok('the Local REST API: Test writes, reads back and removes a hidden note; Access headers and the key go with it', async () => {
  const v = fakeVault();
  await testObsidian(restCfg);
  assert.deepEqual(v.calls.map((c) => c.init.method), ['PUT', 'GET', 'GET', 'DELETE']);
  assert.match(v.calls[0].url, /^https:\/\/obsidian\.example\.com\/vault\/Niko%20Knowledge\/\.niko-test-[0-9a-f]{8}\.md$/);
  assert.equal(v.calls[0].init.headers['cf-access-client-id'], 'svc.access');
  assert.ok(v.calls.every((c) => c.init.redirect === 'manual'));
  assert.equal(v.notes.size, 0);
});

await ok('notes: readable names in Niko’s folder, (2) for a second one, tables that read back, versions that move, gone when deleted', async () => {
  const v = fakeVault();
  const r = obsidianRemoteOf(restCfg);
  const root = await r.makeRoot('Areas/Niko Knowledge');
  assert.equal(root.id, 'Areas/Niko Knowledge');
  const a = await r.writeDoc(root.id, 'Team handbook', '# Returns\n\nSwap within 30 days.\n');
  const b = await r.writeDoc(root.id, 'Team handbook', '# Other\n');
  assert.equal(a.id, 'Areas/Niko Knowledge/Team handbook.md'); assert.equal(b.id, 'Areas/Niko Knowledge/Team handbook (2).md');
  assert.equal(a.url, 'obsidian://open?vault=My%20vault&file=Areas%2FNiko%20Knowledge%2FTeam%20handbook');
  const s = await r.writeSheet(root.id, { title: 'Clients', columns: ['Client', 'Note'], rows: [['Acme | Co', 'two\nlines']] }, { id: null, done: 0 });
  assert.equal(s.done, 1);
  assert.deepEqual(await r.readSheet(s.id), [['Client', 'Note'], ['Acme | Co', 'two lines']]);
  // Edited in Obsidian (front matter added): the version moves, and the text read back leaves the front matter out.
  const before = await r.version(a.id);
  v.notes.set(a.id, { text: '---\ntags: [work]\n---\n# Returns\n\nSwap within 60 days.\n', mtime: 9999 });
  assert.notEqual(await r.version(a.id), before);
  assert.equal(await r.readDoc(a.id), '# Returns\n\nSwap within 60 days.\n');
  // What Niko learned is rewritten in place.
  const lc = await r.writeDoc(root.id, 'What Niko learned', 'v1');
  assert.equal((await r.replaceDoc(lc.id, 'What Niko learned', 'v2')).id, lc.id); assert.equal(v.notes.get(lc.id).text, 'v2');
  await r.trash(a.id);
  assert.equal(await r.version(a.id), null);
  await assert.rejects(r.readDoc(a.id), (e) => e.gone === true);
  assert.ok([...v.notes.keys()].every((p) => p.startsWith('Areas/Niko Knowledge/')), 'nothing written outside Niko’s folder');
});

await ok('the Local REST API: problems are plain and never carry the key', async () => {
  const r = obsidianRemoteOf(restCfg);
  const cases = [
    [new Response('{"message":"bad key"}', { status: 401 }), /refused the API key/],
    [new Response('<html>cloudflareaccess.com</html>', { status: 403 }), /Cloudflare Access stopped Niko/],
    [new Response(null, { status: 302, headers: { location: 'https://team.cloudflareaccess.com/login' } }), /Cloudflare Access stopped Niko/],
    [new Response('Bad gateway', { status: 502 }), /Obsidian needs to be open/],
    [new Response('', { status: 530 }), /Obsidian needs to be open/],
  ];
  for (const [res, re] of cases) { serve(() => res); await assert.rejects(r.readDoc('Niko Knowledge/x.md'), (e) => re.test(e.message) && !e.message.includes(KEY)); }
  globalThis.fetch = async () => { throw new TypeError('fetch failed'); };
  await assert.rejects(r.readDoc('Niko Knowledge/x.md'), /Obsidian needs to be open/);
});

await ok('synced through S3: notes go under the vault’s folder in the bucket, as Markdown', async () => {
  const cfg = cleanObsidian({ mode: 's3', endpoint: 'https://abc.r2.cloudflarestorage.com', bucket: 'obsidian', accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret-key-123456', prefix: 'My vault' }, null);
  const objects = new Map();
  const calls = serve((url, init) => {
    const key = decodeURIComponent(new URL(url).pathname.replace(/^\/obsidian\//, ''));
    if (init.method === 'PUT') { objects.set(key, new TextDecoder().decode(init.body)); return new Response(null, { status: 200, headers: { etag: `"${objects.size}"` } }); }
    if (!objects.has(key)) return new Response('<Error><Code>NoSuchKey</Code></Error>', { status: 404 });
    if (init.method === 'HEAD') return new Response(null, { status: 200, headers: { etag: '"x"' } });
    return new Response(objects.get(key));
  });
  const r = obsidianRemoteOf(cfg);
  const w = await r.writeDoc((await r.makeRoot()).id, 'Team handbook', '# Hi\n');
  assert.equal(w.id, 'Niko Knowledge/Team handbook.md');
  assert.ok(objects.has('My vault/Niko Knowledge/Team handbook.md'));
  assert.equal(calls.find((c) => c.init.method === 'PUT').init.headers['content-type'], 'text/markdown; charset=utf-8');
  assert.equal(await r.readDoc(w.id), '# Hi\n');
});

await ok('their own storage: Niko’s folder is the one they chose', async () => {
  serve((_url, init) => new Response(null, { status: 200, headers: { etag: '"e"' } }));
  const r = storageRemoteOf(cleanStorage({ endpoint: 'https://s3.example.com', bucket: 'knowledge', accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret-key-123456' }, null));
  const root = await r.makeRoot('notes/niko');
  assert.equal(root.id, 'notes/niko/');
  assert.match((await r.writeDoc(root.id, 'Handbook', '# x')).id, /^notes\/niko\/Handbook-[0-9a-f]{8}\.md$/);
  assert.equal((await r.makeRoot()).id, 'niko-knowledge/', 'the default');
});

globalThis.fetch = realFetch; dns.lookup = realLookup;
console.log(`${pass} knowledge Obsidian checks passed`);
