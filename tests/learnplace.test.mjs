// Where Niko keeps what it learns, end to end: the real Worker routes against a temporary PostgreSQL with both the
// main and the Knowledge database (Neon's driver stood in for by tests/eval/neon-shim.mjs, so row-level security and
// the restricted role apply as on Neon). A member with learning but no Knowledge files.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import worker from '../apps/api/src/index.ts';
import { closePools } from './db-node.mjs';
import { closeNeonShim } from './eval/neon-shim.mjs';

let pass = 0;
const ok = async (name, fn) => { try { await fn(); pass++; console.log('PASS', name); } catch (e) { console.log('FAIL', name, e?.stack ?? e?.message); process.exitCode = 1; } };
function pgBin() {
  if (process.env.PG_BIN && existsSync(join(process.env.PG_BIN, 'initdb'))) return process.env.PG_BIN;
  const root = '/usr/lib/postgresql';
  if (!existsSync(root)) return null;
  for (const v of readdirSync(root).sort((a, b) => Number(b) - Number(a))) if (existsSync(join(root, v, 'bin', 'initdb'))) return join(root, v, 'bin');
  return null;
}
const bin = pgBin();
if (!bin) { console.log('SKIP learning place test: PostgreSQL not installed'); console.log('0 learning place checks passed'); process.exit(0); }
const asRoot = process.getuid?.() === 0;
const dir = mkdtempSync(join(tmpdir(), 'niko-lp-'));
if (asRoot) execFileSync('chown', ['-R', 'postgres', dir]);
const run = (tool, args) => execFileSync(asRoot ? 'runuser' : join(bin, tool), asRoot ? ['-u', 'postgres', '--', join(bin, tool), ...args] : args, { stdio: 'pipe' });
const port = 20000 + Math.floor(Math.random() * 20000);
run('initdb', ['-D', join(dir, 'data'), '-A', 'trust', '-U', 'niko', '--no-sync']);
run('pg_ctl', ['-D', join(dir, 'data'), '-o', `-p ${port} -k ${dir} -c listen_addresses=127.0.0.1 -c fsync=off`, '-w', '-l', join(dir, 'log'), 'start']);
const stop = () => { try { run('pg_ctl', ['-D', join(dir, 'data'), '-m', 'immediate', 'stop']); } catch { /* stopping */ } rmSync(dir, { recursive: true, force: true }); };
const url = `postgresql://niko@127.0.0.1:${port}/postgres`, knUrl = `postgresql://niko@127.0.0.1:${port}/kn`;
const main = new pg.Client({ connectionString: url }); await main.connect();
const vx = (await main.query(`select default_version from pg_available_extensions where name = 'vector'`)).rows[0];
if (!vx || vx.default_version < '0.7') { console.log('SKIP learning place test: pgvector 0.7+ not installed'); await main.end(); stop(); console.log('0 learning place checks passed'); process.exit(0); }
await main.query('create database kn');
for (const [u, folder] of [[url, 'migrations'], [knUrl, 'knowledge']]) {
  const c = new pg.Client({ connectionString: u }); await c.connect();
  const d = new URL(`../packages/db/${folder}/`, import.meta.url).pathname;
  for (const f of readdirSync(d).filter((f) => f.endsWith('.sql')).sort()) await c.query(readFileSync(join(d, f), 'utf8'));
  await c.end();
}
const kn = new pg.Client({ connectionString: knUrl }); await kn.connect();

const realFetch = globalThis.fetch;
globalThis.fetch = async (input) => { const u = new URL(String(input instanceof Request ? input.url : input)); if (u.hostname === 'api.resend.com') return Response.json({ id: 'em' }); throw new Error(`no network in tests: ${u.hostname}`); };
const env = {
  DATABASE_URL: url, KNOWLEDGE_DATABASE_URL: knUrl, ENCRYPTION_KEY: randomBytes(32).toString('base64'), BOOTSTRAP_TOKEN: 'boot-' + randomBytes(12).toString('hex'),
  RESEND_API_KEY: 're_test', EMAIL_FROM: 'Niko <t@example.com>', AI_MODEL: '@cf/x', ASSETS: { fetch: async () => new Response('page') },
  AI: { run: async (_m, input) => (input.text ? { data: input.text.map(() => new Array(1024).fill(0.01)) } : { response: 'ok' }) },
};
const ctx = { waitUntil: () => {}, passThroughOnException() {} };
class Browser {
  jar = new Map();
  async call(method, path, body) {
    const headers = { origin: 'https://niko.test' };
    if (this.jar.size) headers.cookie = [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await worker.fetch(new Request('https://niko.test/api' + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env, ctx);
    for (const sc of res.headers.getSetCookie()) { const [pair] = sc.split(';'); const i = pair.indexOf('='); this.jar.set(pair.slice(0, i), pair.slice(i + 1)); }
    return { status: res.status, data: await res.json().catch(() => ({})) };
  }
  get(p) { return this.call('GET', p); } put(p, b) { return this.call('PUT', p, b); } post(p, b) { return this.call('POST', p, b ?? {}); } del(p) { return this.call('DELETE', p); }
}
const PW = 'correct horse battery staple ' + randomBytes(4).toString('hex');
const owner = new Browser();
assert.equal((await owner.post('/auth/setup', { token: env.BOOTSTRAP_TOKEN, email: 'owner@example.com', name: 'Owner', password: PW })).status, 200);
// An admin session for the owner (second factor passed), for Admin · Knowledge saves.
const adm = new Browser();
{ const ownerId = (await main.query(`select id from users where email = 'owner@example.com'`)).rows[0].id, token = randomBytes(24).toString('hex');
  await main.query(`insert into sessions (user_id, token_hash, kind, mfa_ok, expires_at) values ($1, $2, 'admin', true, now() + interval '1 hour')`, [ownerId, createHash('sha256').update(token).digest('hex')]);
  adm.jar.set('__Host-niko_admin', token); }
// A member with a plan for life, learning on and Knowledge files off (the default).
await main.query(`insert into users (email, name, password_hash, role, status, lifetime, ai_access) select 'jason@example.com', 'Jason', password_hash, 'member', 'active', true, '{"kn:learning": true}'::jsonb from users where email = 'owner@example.com'`);
const jasonId = (await main.query(`select id from users where email = 'jason@example.com'`)).rows[0].id;
const access = async (a) => main.query(`update users set ai_access = $2::jsonb where id = $1`, [jasonId, JSON.stringify(a)]);
const jason = new Browser();
assert.equal((await jason.post('/auth/sign-in', { email: 'jason@example.com', password: PW })).status, 200);

await ok('learning without files: the learning switches can be saved, files settings can’t be changed', async () => {
  let r = await jason.put('/knowledge/prefs', { learn: false, mode: 'only', place: 'device' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.prefs.learn, false); assert.equal(r.data.prefs.mode, 'files'); assert.equal(r.data.prefs.place, 'niko');
  r = await jason.put('/knowledge/prefs', { learn: true, situations: false });
  assert.equal(r.data.prefs.learn, true); assert.equal(r.data.prefs.situations, false);
  r = await jason.get('/knowledge');
  assert.equal(r.data.available, true); assert.equal(r.data.access.files, false); assert.equal(r.data.access.learnPlaces.device, true);
  assert.equal((await jason.get('/me')).data.knowledge.learnPlace, 'niko');
});

await ok('moving what Niko learned to the device and back; habits said yes to come along; the plan decides', async () => {
  for (const n of [{ kind: 'person', said: 'the team', means: 'Design team' }, { kind: 'remembered', said: 'My desk is on level 12', means: 'My desk is on level 12' }]) assert.equal((await jason.post('/knowledge/learned', n)).status, 200);
  assert.equal((await jason.post('/knowledge/learned', { kind: 'habit', habit: 'walk-short' })).status, 200);
  assert.equal((await jason.post('/knowledge/learned', { kind: 'habit', habit: 'fly-everywhere' })).status, 400);
  let items = (await jason.get('/knowledge/learned')).data.items;
  assert.equal(items.length, 3); assert.ok(items.some((n) => n.kind === 'habit' && n.confirmed));
  assert.equal((await jason.get('/knowledge/device-key')).status, 200, 'the device key, for notes kept there');
  // The app copies them to the device first; saving the choice then removes them from Niko.
  assert.equal((await jason.put('/knowledge/prefs', { learnPlace: 'device' })).status, 200);
  assert.equal((await jason.get('/knowledge/learned')).data.items.length, 0);
  assert.equal((await jason.get('/me')).data.knowledge.learnPlace, 'device');
  // Back to Niko: the app sends them, then saves the choice.
  await jason.post('/knowledge/learned', { kind: 'person', said: 'the team', means: 'Design team' });
  assert.equal((await jason.put('/knowledge/prefs', { learnPlace: 'niko' })).status, 200);
  assert.equal((await jason.get('/knowledge/learned')).data.items.length, 1);
  // Without the device option in the plan: not offered, and refused.
  await access({ 'kn:learning': true, 'kn:learn:device': false });
  assert.equal((await jason.put('/knowledge/prefs', { learnPlace: 'device' })).status, 403);
  assert.equal((await jason.get('/knowledge/device-key')).status, 403);
  // A copy in an app that isn't connected: asked to connect first.
  const r = await jason.put('/knowledge/prefs', { learnPlace: 'notion' });
  assert.equal(r.status, 409); assert.equal(r.data.connect, 'notion'); assert.match(r.data.error, /Connect Notion first/);
  assert.equal((await jason.post('/knowledge/learned/copy')).status, 409, 'nothing is copied anywhere');
  await access({ 'kn:learning': true });
});

await ok('where in each app: a folder name is cleaned and kept; a Notion page Niko makes gets the chosen name', async () => {
  let r = await jason.put('/knowledge/places/gdrive/folder', { name: '  Work / Niko  ' });
  assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(r.data.folder, 'Work Niko'); assert.deepEqual(r.data.relocated, { files: 0, learned: false });
  assert.equal((await jason.get('/knowledge')).data.prefs.folders.gdrive, 'Work Niko');
  assert.equal((await jason.put('/knowledge/places/gdrive/folder', { name: '...' })).status, 400);
  assert.equal((await jason.put('/knowledge/places/evil/folder', { name: 'x' })).status, 404);
  r = await jason.put('/knowledge/places/notion', { page: null, name: 'My Niko notes' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal((await jason.get('/knowledge')).data.prefs.folders.notion, 'My Niko notes');
  await jason.put('/knowledge/prefs', { learn: true, folders: { notion: 'Sneaky' } });
  assert.equal((await jason.get('/knowledge')).data.prefs.folders.notion, 'My Niko notes', 'not changed through the settings save');
  // Choosing what's already in use changes nothing, so nothing is copied there again (no second "What Niko learned").
  await kn.query(`insert into kn_places (account_id, place, root_id, root_name, made) values ($1, 'notion', 'root-page-1', 'My Niko notes', true) on conflict (account_id, place) do update set root_id = excluded.root_id, root_name = excluded.root_name, made = true`, [jasonId]);
  await kn.query(`insert into kn_learned_copy (account_id, place, remote_id, dirty) values ($1, 'notion', 'copy-1', false) on conflict (account_id) do update set place = 'notion', remote_id = 'copy-1'`, [jasonId]);
  r = await jason.put('/knowledge/places/notion', { page: null, name: 'My Niko notes' });
  assert.equal(r.status, 200); assert.deepEqual(r.data.relocated, { files: 0, learned: false });
  assert.equal((await kn.query(`select remote_id from kn_learned_copy where account_id = $1`, [jasonId])).rows[0].remote_id, 'copy-1', 'the copy is kept');
  assert.equal((await kn.query(`select count(*)::int as n from kn_places where account_id = $1 and place = 'notion'`, [jasonId])).rows[0].n, 1, 'Niko’s page is kept');
  await kn.query(`delete from kn_learned_copy where account_id = $1`, [jasonId]); await kn.query(`delete from kn_places where account_id = $1`, [jasonId]);
  // The default name isn't stored; a place the plan doesn't allow is refused.
  await jason.put('/knowledge/places/gdrive/folder', { name: 'Niko Knowledge' });
  assert.equal((await jason.get('/knowledge')).data.prefs.folders.gdrive, undefined);
  await access({ 'kn:learning': true, 'kn:learn:onedrive': false });
  assert.equal((await jason.put('/knowledge/places/onedrive/folder', { name: 'X' })).status, 403);
  await access({ 'kn:learning': true });
});

await ok('Kept in Niko off for what Niko learns: saving deletes what Niko kept; nothing is read or kept there again', async () => {
  const count = async () => (await kn.query(`select count(*)::int as n from kn_learned where account_id = $1`, [jasonId])).rows[0].n;
  await jason.post('/knowledge/learned', { kind: 'remembered', said: 'Parking is on B2', means: 'Parking is on B2' });
  await jason.post('/knowledge/learned', { kind: 'habit', habit: 'walk-short' });
  await kn.query(`insert into kn_learned_copy (account_id, place) values ($1, 'notion') on conflict do nothing`, [jasonId]);
  assert.ok((await count()) >= 2);
  // The admin turns it off for Jason: everything learned in Niko goes, with the record of a copy in his own app.
  let r = await adm.put(`/admin/ai/users/${jasonId}`, { access: { 'kn:learning': true, 'kn:learn:niko': false } });
  assert.equal(r.status, 200, JSON.stringify(r.data)); assert.ok(r.data.forgot >= 2, 'says how many went');
  assert.equal(await count(), 0);
  assert.equal((await kn.query(`select count(*)::int as n from kn_learned_copy where account_id = $1`, [jasonId])).rows[0].n, 0);
  const prefs = (await main.query(`select knowledge from users where id = $1`, [jasonId])).rows[0].knowledge;
  assert.equal(prefs.notes, 0); assert.deepEqual(prefs.habits, []);
  // From now on: kept on his device; Niko and copies in his apps aren't offered, and Niko's notes can't be read or added.
  r = await jason.get('/knowledge');
  assert.equal(r.data.access.learnPlaces.niko, false); assert.equal(r.data.access.learnPlaces.notion, false); assert.equal(r.data.access.learnPlaces.device, true);
  assert.equal((await jason.get('/me')).data.knowledge.learnPlace, 'device');
  assert.equal((await jason.get('/knowledge/learned')).status, 403);
  assert.equal((await jason.post('/knowledge/learned', { kind: 'person', said: 'Mum', means: 'Siew Hoon' })).status, 403);
  assert.equal((await jason.post('/knowledge/taught', { question: 'refunds?', target: { file: 'a', heading: 'b' } })).status, 403);
  assert.equal((await jason.put('/knowledge/prefs', { learnPlace: 'notion' })).status, 403);
  await jason.put('/knowledge/prefs', { learnPlace: 'niko' });
  assert.equal((await jason.get('/me')).data.knowledge.learnPlace, 'device', 'an earlier choice of Niko changes nothing');
  assert.equal((await jason.put('/knowledge/prefs', { learn: true })).status, 200, 'other settings still save');
  assert.equal(await count(), 0);
  // Anything still kept there (a save that couldn't finish) goes the next time he opens Niko.
  await kn.query(`insert into kn_learned (account_id, kind, subject, body, source, sure, confirmed) values ($1, 'remembered', 'x', 'x', 'told', 1, true)`, [jasonId]);
  await main.query(`update users set knowledge = knowledge || '{"notes": 1}'::jsonb where id = $1`, [jasonId]);
  await jason.get('/me');
  assert.equal(await count(), 0);
  // With the device off too, learning has nowhere to keep notes, so it's off.
  await access({ 'kn:learning': true, 'kn:learn:niko': false, 'kn:learn:device': false });
  assert.equal((await jason.get('/knowledge')).data.access.learning, false);
  // The default for everyone: people who follow it lose what Niko kept; admins keep theirs.
  await access({ 'kn:learning': true });
  await jason.post('/knowledge/learned', { kind: 'remembered', said: 'Parking is on B2', means: 'Parking is on B2' });
  assert.equal(await count(), 1);
  const defaults = (await adm.get('/admin/ai')).data.defaults;
  r = await adm.put('/admin/ai/default', { access: { ...defaults, 'kn:learn:niko': false } });
  assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(r.data.forgot, 1);
  assert.equal(await count(), 0);
  assert.equal((await owner.get('/knowledge')).data.access.learnPlaces.niko, true, 'an admin always has every option');
  assert.equal((await adm.put('/admin/ai/default', { access: defaults })).status, 200);
  assert.equal((await jason.get('/knowledge')).data.access.learnPlaces.niko, true);
});

await ok('notes are only ever this person’s: row security applies to the copy record too', async () => {
  const other = '00000000-0000-4000-8000-00000000ffff';
  await kn.query(`insert into kn_learned_copy (account_id, place) values ($1, 'notion')`, [other]);
  const c = new pg.Client({ connectionString: knUrl }); await c.connect();
  await c.query('begin'); await c.query('set local role niko_kn_app'); await c.query(`select set_config('niko.account', $1, true)`, [jasonId]);
  assert.equal((await c.query('select count(*)::int as n from kn_learned_copy')).rows[0].n, 0, 'another account’s copy record isn’t visible');
  await c.query('rollback'); await c.end();
  await kn.query(`delete from kn_learned_copy where account_id = $1`, [other]);
});

await kn.end(); await main.end();
await closePools(); await closeNeonShim();
globalThis.fetch = realFetch;
stop();
console.log(`${pass} learning place checks passed`);
