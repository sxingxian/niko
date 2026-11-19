// Data sources: addresses (https, public names only, private addresses refused at every redirect), actions and the
// values the AI fills in (checked, encoded, nothing unlisted), OpenAPI files (read-only actions only), tags, short
// results, who may use what, and running an action (keys in a header or the address, never sent to another site,
// answers shared only when they hold nothing personal, the monthly limit).
import assert from 'node:assert/strict';
import {
  actionUrl, checkValues, cleanAction, cleanActions, cleanBaseUrl, cleanDataAccess, cleanDataPrefs, dataAllowed, dataBlock, dataTags, hostProblem,
  openApiActions, privateIp, resultText, sampleValues, stripDataTags, cleanWeatherPrefs, weatherOrder, cleanDataDefaults, cleanLivePrefs, liveOrder, placesBlock, datasetTable, actionLine, noteSeen, liveSuggestions, LIVE_SUGGEST_AT,
} from '../packages/shared/src/dataSources.ts';
import { fromExampleLink, fromCurl, actionBody, cleanHeaders, cleanToken, parseXml, xmlText, xmlRecords } from '../packages/shared/src/dataSources.ts';
import { cleanInput, infoOf } from '../apps/api/src/datasources.ts';
import { testActions } from '../apps/api/src/routes/data.ts';
import { dns, forgetDns, safeGet } from '../apps/api/src/safefetch.ts';
import { DataProblem, runAction } from '../apps/api/src/datasources.ts';

let pass = 0;
const ok = async (name, fn) => { try { await fn(); pass++; console.log('PASS', name); } catch (e) { console.log('FAIL', name, e?.stack ?? e?.message); process.exitCode = 1; } };

await ok('private and reserved addresses are recognised', () => {
  for (const ip of ['10.0.0.1', '127.0.0.1', '172.16.5.4', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255', '::1', '::', 'fc00::1', 'fd12::3', 'fe80::1', '::ffff:10.0.0.1', '::ffff:127.0.0.1', '64:ff9b::a00:1', '2001:db8::1', '198.18.0.1'])
    assert.equal(privateIp(ip), true, ip);
  for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '203.0.114.5', '2606:4700::1111', '2001:4860:4860::8888'])
    assert.equal(privateIp(ip), false, ip);
});

await ok('addresses: https, public names, no sign-in, port, query or #part', () => {
  assert.deepEqual(cleanBaseUrl('https://API.Example.com/v2/'), { url: 'https://api.example.com/v2' });
  for (const bad of ['http://api.example.com', 'https://10.0.0.1', 'https://[::1]', 'https://localhost', 'https://printer.local', 'https://intranet', 'https://user:pw@api.example.com', 'https://api.example.com:8443', 'https://api.example.com/x?key=1', 'ftp://a.example.com', 'https://svc.internal', 'not a url'])
    assert.ok('problem' in cleanBaseUrl(bad), bad);
  assert.equal(hostProblem('api.data.gov.sg'), null);
  assert.ok(hostProblem('2130706433'));
});

const order = { id: 'order-status', name: 'Order status', path: '/orders/{number}', live: true, example: '', on: true, params: [
  { name: 'number', in: 'path', type: 'integer', required: true, min: 1, max: 999999 },
  { name: 'region', in: 'query', type: 'enum', required: false, values: ['north', 'South'] },
  { name: 'note', in: 'query', type: 'text', required: false, max: 10 },
  { name: 'format', in: 'query', type: 'text', required: false, fixed: 'json' },
] };

await ok('actions are checked as saved', () => {
  const a = cleanAction(order);
  assert.ok(!('problem' in a));
  assert.equal(a.params[3].fixed, 'json');
  assert.ok('problem' in cleanAction({ name: 'x', path: '/a/{id}', params: [] }), 'path value not listed');
  assert.ok('problem' in cleanAction({ name: 'x', path: '/a', params: [{ name: 'id', in: 'path', type: 'text' }] }), 'path value not in path');
  for (const p of ['/a/../b', '/a?b=1', '/a#b', '//evil.example.com/x', '/a b'])
    assert.ok('problem' in cleanAction({ name: 'x', path: p, params: [] }), p);
  assert.ok('problem' in cleanAction({ name: 'x', path: '/a', params: [{ name: 'r', type: 'enum', values: [] }] }) === false, 'an enum with no values is dropped');
  const two = cleanActions([{ name: 'Same' , path: '/a' }, { name: 'Same', path: '/b' }]);
  assert.deepEqual(two.map((x) => x.id), ['same', 'same-2']);
});

await ok('values the AI gives are checked: type, limits, allowed values, nothing unlisted', () => {
  const a = cleanAction(order);
  assert.deepEqual(checkValues(a, { number: '482910', region: 'south' }), { values: { number: '482910', region: 'South', format: 'json' } });
  for (const bad of [{}, { number: '0' }, { number: '1.5' }, { number: 'x' }, { number: '5', region: 'west' }, { number: '5', note: 'far too long here' }, { number: '5', extra: '1' }, { number: '..' }])
    assert.ok('problem' in checkValues(a, bad), JSON.stringify(bad));
  assert.equal(checkValues(a, { number: '5', format: 'xml' }).values.format, 'json', 'a fixed value can’t be changed');
});

await ok('addresses are built with every value encoded and can’t leave the source', () => {
  const a = cleanAction({ name: 'Find', path: '/find/{q}', params: [{ name: 'q', in: 'path', type: 'text', max: 100 }, { name: 'x', in: 'query', type: 'text' }] });
  const u = actionUrl('https://api.example.com/v1', a, { q: 'a/b?c#d', x: 'k=1&y=2' });
  assert.equal(u, 'https://api.example.com/v1/find/a%2Fb%3Fc%23d?x=k%3D1%26y%3D2');
  assert.throws(() => actionUrl('https://api.example.com/v1', cleanAction({ name: 'Up', path: '/{q}', params: [{ name: 'q', in: 'path', type: 'text' }] }), { q: '..' }));
});

await ok('OpenAPI: GET actions kept, anything that changes data left out', () => {
  const spec = { openapi: '3.0.0', servers: [{ url: 'https://api.acme.example.com' }], components: { parameters: { Num: { name: 'number', in: 'path', required: true, schema: { type: 'string', maxLength: 6 }, example: '482910' } } }, paths: {
    '/orders/{number}': { get: { summary: 'Order status', parameters: [{ $ref: '#/components/parameters/Num' }] } },
    '/orders/{number}/cancel': { post: { summary: 'Cancel order' } },
    '/customers/{id}/orders': { get: { operationId: 'byCustomer', summary: 'Orders by customer', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }, { name: 'status', in: 'query', schema: { type: 'string', enum: ['open', 'shipped'] } }] } },
    '/me': { get: { summary: 'Who am I', parameters: [{ name: 'X-Session', in: 'header', required: true }] } },
  } };
  const r = openApiActions(spec);
  assert.ok(!('problem' in r));
  assert.equal(r.base, 'https://api.acme.example.com');
  assert.deepEqual(r.kept.map((a) => a.name), ['Order status', 'Orders by customer']);
  assert.equal(r.kept[0].params[0].max, 6);
  assert.equal(r.kept[0].params[0].sample, '482910');
  assert.deepEqual(r.kept[1].params[1].values, ['open', 'shipped']);
  assert.deepEqual(r.left.map((l) => l.name), ['Cancel order', 'Who am I']);
  assert.match(r.left[0].why, /changes data/);
  assert.deepEqual(sampleValues(r.kept[0]), { number: '482910' });
  assert.ok('problem' in openApiActions({ swagger: 'x' }));
});

await ok('tags: up to three asks; the block lists only actions that are on', () => {
  assert.deepEqual(dataTags('Let me check. [[data:D1.air-now|region=north]]'), [{ source: 'D1', action: 'air-now', values: { region: 'north' } }]);
  assert.equal(dataTags('[[data:D1.a]][[data:D1.b]][[data:D2.c|x=1]][[data:D3.d]]').length, 3);
  assert.equal(stripDataTags('Air: [[data:D1.air-now|region=north]] ok'), 'Air: ok');
  const block = dataBlock([{ tag: 'D1', name: 'data.gov.sg', actions: [cleanAction({ name: 'Air now', path: '/air', params: [{ name: 'region', type: 'enum', values: ['north', 'south'] }] }), { ...cleanAction({ name: 'Hidden', path: '/h' }), on: false }] }]);
  assert.match(block, /D1\.air-now: Air now from data\.gov\.sg \(live\) · values: region\?=north\/south/);
  assert.doesNotMatch(block, /Hidden/);
});

await ok('results are cut short for the prompt', () => {
  const big = JSON.stringify({ items: Array.from({ length: 500 }, (_, i) => ({ i, text: 'x'.repeat(400) })) });
  const t = resultText(big, 'json');
  assert.ok(t.length <= 4001);
  assert.match(resultText(JSON.stringify({ items: Array.from({ length: 40 }, (_, i) => i) }), 'json'), /… 10 more/);
  const csv = ['a,b', ...Array.from({ length: 100 }, (_, i) => `${i},${i}`)].join('\n');
  assert.match(resultText(csv, 'csv'), /… 70 more rows$/);
});

await ok('who may use what: offered sources, terms, own sources, calls', () => {
  const srcs = [{ id: 'a'.repeat(8) + '-0000-4000-8000-' + 'a'.repeat(12), offer: 'everyone', termsOk: true }, { id: 'b'.repeat(8) + '-0000-4000-8000-' + 'b'.repeat(12), offer: 'chosen', termsOk: true }, { id: 'c'.repeat(8) + '-0000-4000-8000-' + 'c'.repeat(12), offer: 'everyone', termsOk: false }];
  const d = { own: false, calls: 1000 };
  const base = dataAllowed(d, {}, srcs);
  assert.deepEqual(Object.values(base.src), [true, false, false]);
  assert.equal(base.own, false); assert.equal(base.calls, 1000);
  const p = dataAllowed(d, cleanDataAccess({ [`src:${srcs[1].id}`]: true, [`src:${srcs[2].id}`]: true, own: true, calls: 2000, junk: true }), srcs);
  assert.deepEqual(Object.values(p.src), [true, true, false], 'terms not confirmed: off even when turned on for a person');
  assert.equal(p.own, true); assert.equal(p.calls, 2000);
  assert.equal(dataAllowed(d, {}, srcs, true).calls, 0);
  const pr = cleanDataPrefs({ on: ['x', srcs[0].id], actionsOff: [`${srcs[0].id}:air-now`, 'bad'] });
  assert.deepEqual([pr.on, pr.actionsOff], [[srcs[0].id], [`${srcs[0].id}:air-now`]]);
});

await ok('weather order: Open-Meteo where the plan puts it until the person chooses; new sources join; settings cleaned', () => {
  const A = 'a'.repeat(8) + '-0000-4000-8000-' + 'a'.repeat(12), B = 'b'.repeat(8) + '-0000-4000-8000-' + 'b'.repeat(12);
  const fresh = cleanWeatherPrefs({});
  assert.deepEqual(fresh, { order: [], off: [], home: '', units: 'C', location: true, saved: false });
  assert.deepEqual(weatherOrder(fresh, ['open-meteo', A], 'om'), ['open-meteo', A]);
  assert.deepEqual(weatherOrder(fresh, ['open-meteo', A], 'others'), [A, 'open-meteo']);
  const mine = cleanWeatherPrefs({ order: [A, 'open-meteo', 'junk'], off: ['open-meteo'], units: 'F', location: false, saved: true, home: 'Paris' });
  assert.deepEqual(mine.order, [A, 'open-meteo']);
  assert.deepEqual(weatherOrder(mine, ['open-meteo', A, B], 'om'), [A, 'open-meteo', B], 'a new source joins after their order');
  assert.deepEqual(weatherOrder(mine, [A], 'om'), [A], 'Open-Meteo switched off by the admin disappears');
  assert.equal(dataAllowed(cleanDataDefaults({}), {}, []).om, true);
  assert.equal(dataAllowed(cleanDataDefaults({ om: false }), {}, []).om, false);
  assert.equal(dataAllowed(cleanDataDefaults({ om: false }), cleanDataAccess({ om: true }), []).om, true);
  assert.equal(cleanDataDefaults({ wxFirst: 'others' }).wxFirst, 'others');
});

await ok('live info: the country’s own list, else Everywhere, else the only country set up; places kept short', () => {
  const A = 'a'.repeat(8) + '-0000-4000-8000-' + 'a'.repeat(12), B = 'b'.repeat(8) + '-0000-4000-8000-' + 'b'.repeat(12);
  const p = cleanLivePrefs({ everywhere: [B], countries: { SG: [A, B], sg: [B], XX1: [A] }, places: [{ name: 'Usual stop', value: 'Example Rd stop · 83139' }, { name: '', value: 'x' }] });
  assert.deepEqual(Object.keys(p.countries), ['SG']);
  assert.equal(p.places.length, 1);
  assert.deepEqual(liveOrder(p, 'SG', [A, B]), { list: [A, B], from: 'SG' });
  assert.deepEqual(liveOrder(p, 'MY', [A, B]), { list: [B], from: null });
  assert.deepEqual(liveOrder({ ...p, everywhere: [] }, null, [A, B]), { list: [A, B], from: 'SG' }, 'only one country set up: used anywhere');
  assert.deepEqual(liveOrder(p, 'SG', [B]), { list: [B], from: 'SG' }, 'a service they can no longer use drops out');
  assert.match(placesBlock(p.places), /Usual stop: Example Rd stop · 83139/);
  assert.equal(placesBlock([]), '');
});

await ok('datasets: kept as tables (CSV, TSV, records in JSON), never asked live, fetched without a question', () => {
  const csv = datasetTable('town,price,date,ok\n"Tampines, East",450000,2026-01-02,yes\n"Say ""hi""",1.5,2026-02-01,no\n', 'csv');
  assert.deepEqual(csv.columns, [{ name: 'town', type: 'text' }, { name: 'price', type: 'number' }, { name: 'date', type: 'date' }, { name: 'ok', type: 'yesno' }]);
  assert.deepEqual(csv.rows[0], ['Tampines, East', '450000', '2026-01-02', 'yes']);
  assert.equal(csv.rows[1][0], 'Say "hi"');
  assert.equal(datasetTable('a\tb\n1\t2', 'csv').columns.length, 2);
  const js = datasetTable(JSON.stringify({ result: { records: [{ month: '2026-01', n: 3 }, { month: '2026-02', n: 4, extra: { x: 1 } }] } }), 'json');
  assert.deepEqual(js.columns.map((c) => c.name), ['month', 'n', 'extra']);
  assert.equal(js.rows[1][2], '{"x":1}');
  assert.ok('problem' in datasetTable('{"a":1}', 'json'));
  assert.ok('problem' in datasetTable('only,a,header', 'csv'));
  const a = cleanAction({ name: 'Resale prices', path: '/prices', dataset: 'week', params: [{ name: 'year', type: 'integer', required: true, sample: '2025' }] });
  assert.equal(a.dataset, 'week'); assert.equal(a.live, false);
  assert.match(actionLine(a), /dataset in Knowledge · refreshed weekly when used/);
  assert.ok('problem' in cleanAction({ name: 'X', path: '/x', dataset: 'day', params: [{ name: 'q', type: 'text', required: true }] }), 'a needed value with nothing to fill it');
  assert.doesNotMatch(dataBlock([{ tag: 'D1', name: 'S', actions: [a] }]), /resale/i, 'datasets aren’t offered as live actions');
});

// ---------------------------------------------------------------- the server side, with the network stood in for
const PUBLIC = { 'api.example.com': '93.184.216.34', 'other.example.org': '93.184.216.35', 'evil.example.org': '10.0.0.5', 'rebind.example.org': '169.254.169.254' };
dns.lookup = async (host, type) => (type === 'A' && PUBLIC[host] ? [PUBLIC[host]] : []);
const seen = [];
let tokenAsks = 0; const revoked = new Set();
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url));
  seen.push({ url: u.toString(), headers: { ...(init.headers ?? {}) }, method: init.method ?? 'GET', body: init.body });
  if (u.pathname === '/xml') return new Response('<?xml version="1.0"?><!DOCTYPE r [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;"><!ENTITY s SYSTEM "file:///etc/passwd">]><forecasts><item area="Ang Mo Kio"><text>Showers &amp; wind</text><b>&b;&s;</b></item><item area="Bedok"><text>Fair</text><b>x</b></item></forecasts>', { headers: { 'content-type': 'application/xml' } });
  if (u.pathname === '/oauth/token') {
    tokenAsks++;
    const f = new URLSearchParams(String(init.body ?? ''));
    const basic = (init.headers ?? {}).authorization;
    const ok = (f.get('client_id') === 'id-1' && f.get('client_secret') === 'sec-1') || basic === `Basic ${btoa('id-1:sec-1')}`;
    return ok ? Response.json({ access_token: `tok-${tokenAsks}`, expires_in: 3600 }) : new Response('{"error":"invalid_client"}', { status: 401, headers: { 'content-type': 'application/json' } });
  }
  if (u.pathname === '/login') { tokenAsks++; const b = JSON.parse(String(init.body ?? '{}')); return b.email === 'me@x.com' && b.password === 'pw' ? Response.json({ data: { token: `tok-${tokenAsks}` } }) : new Response('no', { status: 401 }); }
  if (u.pathname === '/v1/needs-token') { const a = (init.headers ?? {}).Authorization; return a === `Bearer tok-${tokenAsks}` && !revoked.has(a) ? Response.json({ ok: true, who: a }) : new Response('no', { status: 401 }); }
  if (u.pathname === '/v1/search') return init.method === 'POST' ? Response.json({ got: JSON.parse(String(init.body)), type: (init.headers ?? {})['content-type'] }) : new Response('no', { status: 405 });
  if (u.pathname === '/v1/post-away') return new Response(null, { status: 307, headers: { location: 'https://other.example.org/x' } });
  if (u.pathname === '/to-evil') return new Response(null, { status: 302, headers: { location: 'https://evil.example.org/x' } });
  if (u.pathname === '/to-other') return new Response(null, { status: 302, headers: { location: 'https://other.example.org/data' } });
  if (u.pathname === '/big') return new Response('x'.repeat(1024 * 1024 + 10), { headers: { 'content-type': 'application/json' } });
  if (u.pathname === '/html') return new Response('<html></html>', { headers: { 'content-type': 'text/html' } });
  if (u.pathname === '/csv') return new Response('a,b\n1,2', { headers: { 'content-type': 'text/csv' } });
  if (u.pathname === '/denied') return new Response('no', { status: 401 });
  return new Response(JSON.stringify({ ok: true, path: u.pathname, q: u.search }), { headers: { 'content-type': 'application/json' } });
};
const store = new Map();
globalThis.caches = { default: { match: async (r) => store.get(r.url)?.clone(), put: async (r, res) => { store.set(r.url, res); } } };

await ok('fetching: public hosts only, at every redirect; keys never follow to another site; size and type limits', async () => {
  forgetDns();
  assert.equal((await safeGet('https://api.example.com/x')).kind, 'json');
  await assert.rejects(safeGet('https://evil.example.org/x'), /public internet/);
  await assert.rejects(safeGet('https://rebind.example.org/x'), /public internet/);
  await assert.rejects(safeGet('https://api.example.com/to-evil'), /public internet/);
  seen.length = 0;
  await safeGet('https://api.example.com/to-other', { 'X-Api-Key': 'secret' });
  assert.equal(seen[0].headers['X-Api-Key'], 'secret');
  assert.equal(seen[1].headers['X-Api-Key'], undefined, 'the key isn’t sent on to another site');
  await assert.rejects(safeGet('https://api.example.com/big'), /1 MB/);
  await assert.rejects(safeGet('https://api.example.com/html'), /JSON, CSV or XML/);
  assert.equal((await safeGet('https://api.example.com/csv')).kind, 'csv');
  await assert.rejects(safeGet('https://api.example.com/denied'), /refused the key/);
  await assert.rejects(safeGet('http://api.example.com/x'), /https/);
});

// A stand-in database: usage counts and keys, enough for runAction.
const env = { ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64') };
const { seal } = await import('../apps/api/src/lib/crypto.ts');
let used = 0; const counted = [];
const db = {
  select: () => ({ from: () => ({ where: () => Object.assign(Promise.resolve([{ n: used }]), { limit: async () => [] }) }) }),
  execute: async (q) => { counted.push(q); used++; },
};
const row = async (over = {}) => ({ id: '11111111-1111-4111-8111-111111111111', ownerId: null, name: 'Acme', useAs: 'general', baseUrl: 'https://api.example.com/v1', auth: 'header', authName: 'X-Api-Key', keyMode: 'one', keyEnc: await seal(env.ENCRYPTION_KEY, 'k-123'), actions: [], termsOk: true, termsNote: '', attribution: 'Source: Acme', offer: 'everyone', createdAt: new Date(), updatedAt: new Date(0), ...over });
const act = cleanAction(order);

await ok('running an action: key in a header or the address, shared cache only without a personal key, monthly limit', async () => {
  store.clear(); seen.length = 0; used = 0;
  const r1 = await runAction(env, db, 'u1', await row(), act, { number: '42' }, 0);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].headers['X-Api-Key'], 'k-123');
  assert.equal(new URL(seen[0].url).pathname, '/v1/orders/42');
  assert.match(r1.text, /"ok":true/); assert.equal(r1.cached, false); assert.equal(r1.attribution, 'Source: Acme');
  const r2 = await runAction(env, db, 'u2', await row(), act, { number: '42' }, 0);
  assert.equal(r2.cached, true, 'the admin’s key holds nothing personal: shared briefly');
  assert.equal(seen.length, 1);
  // A person's own source: their key, never shared with another account.
  const own = await row({ id: '22222222-2222-4222-8222-222222222222', ownerId: 'u1', auth: 'query', authName: 'api_key' });
  await runAction(env, db, 'u1', own, act, { number: '7' }, 0);
  assert.equal(new URL(seen.at(-1).url).searchParams.get('api_key'), 'k-123');
  const before = seen.length;
  await runAction(env, db, 'u2', own, act, { number: '7' }, 0);
  assert.equal(seen.length, before + 1, 'not served from another account’s answer');
  // Bad values never reach the network; the limit is checked before a call.
  await assert.rejects(runAction(env, db, 'u1', await row(), act, { number: 'drop table' }, 0), (e) => e instanceof DataProblem && /whole number/.test(e.message));
  used = 5;
  await assert.rejects(runAction(env, db, 'u3', await row(), act, { number: '99' }, 5), (e) => e instanceof DataProblem && e.status === 429);
  // Each person's own key for an admin source: none saved, so it asks for it.
  await assert.rejects(runAction(env, db, 'u3', await row({ keyMode: 'own', keyEnc: null }), act, { number: '1' }, 0), /needs your key/);
});

await ok('other headers, token sign-in, POST and XML: secrets sent only where they belong', async () => {
  store.clear();
  const sealed = async (o) => seal(env.ENCRYPTION_KEY, o);
  // Other headers: plain ones as written, secret ones from the sealed values, with the key.
  const hdr = await row({ headers: [{ name: 'Notion-Version', secret: false, value: '2022-06-28' }, { name: 'X-Client', secret: true }], secretsEnc: await sealed({ h: { 'X-Client': 'c-9' } }) });
  seen.length = 0; await runAction(env, db, 'u1', hdr, act, { number: '1' }, 0, { test: true });
  assert.deepEqual([seen[0].headers['Notion-Version'], seen[0].headers['X-Client'], seen[0].headers['X-Api-Key']], ['2022-06-28', 'c-9', 'k-123']);
  assert.equal(infoOf(hdr).headers[1].value, undefined, 'a secret value is never sent back'); assert.equal(infoOf(hdr).headers[1].saved, true);
  // Token sign-in (client credentials): asked once, reused, asked again when refused; the secret only goes to the token address.
  const tokenRow = await row({ id: '33333333-3333-4333-8333-333333333333', auth: 'token', authName: '', keyEnc: null, token: { url: 'https://api.example.com/oauth/token', style: 'client', idName: 'client_id', secretName: 'client_secret', scope: '', basic: false, tokenPath: 'access_token', header: 'Authorization', prefix: 'Bearer ' }, secretsEnc: await sealed({ id: 'id-1', secret: 'sec-1' }) });
  const tAct = cleanAction({ name: 'Mine', path: '/needs-token', params: [] });
  tokenAsks = 0; seen.length = 0;
  let r = await runAction(env, db, 'u1', tokenRow, tAct, {}, 0, { test: true });
  assert.match(r.text, /tok-1/); assert.equal(tokenAsks, 1);
  await runAction(env, db, 'u1', tokenRow, tAct, {}, 0, { test: true });
  assert.equal(tokenAsks, 1, 'the token is reused until it runs out');
  assert.ok(seen.filter((x) => x.url.includes('/needs-token')).every((x) => !String(x.body ?? '').includes('sec-1') && !JSON.stringify(x.headers).includes('sec-1')), 'the secret never goes to the data address');
  revoked.add('Bearer tok-1');
  r = await runAction(env, db, 'u1', tokenRow, tAct, {}, 0, { test: true });
  assert.match(r.text, /tok-2/, 'refused: a new token, tried once more');
  // Basic, and email and password with the token deeper in the answer; a wrong secret says so plainly.
  const basicRow = { ...tokenRow, id: '44444444-4444-4444-8444-444444444444', token: { ...tokenRow.token, basic: true } };
  assert.match((await runAction(env, db, 'u1', basicRow, tAct, {}, 0, { test: true })).text, /tok-/);
  const loginRow = { ...tokenRow, id: '55555555-5555-4555-8555-555555555555', token: { ...tokenRow.token, url: 'https://api.example.com/login', style: 'login', idName: 'email', secretName: 'password', tokenPath: 'data.token' }, secretsEnc: await sealed({ id: 'me@x.com', secret: 'pw' }) };
  assert.match((await runAction(env, db, 'u1', loginRow, tAct, {}, 0, { test: true })).text, /tok-/);
  const wrong = { ...tokenRow, id: '66666666-6666-4666-8666-666666666666', secretsEnc: await sealed({ id: 'id-1', secret: 'nope' }) };
  await assert.rejects(runAction(env, db, 'u1', wrong, tAct, {}, 0, { test: true }), /refused the sign-in/);
  // POST: the body with checked values; no redirects followed; a GraphQL change refused before any call.
  const search = cleanAction({ name: 'Search', path: '/search', method: 'POST', readOnly: true, body: '{"query":"{{q}}","page_size":{{n}}}'.replace('{{n}}', '10'), params: [{ name: 'q', in: 'body', type: 'text', required: true, sample: 'plan' }] });
  assert.equal(search.method, 'POST');
  r = await runAction(env, db, 'u1', await row(), search, { q: 'Q3 "plan"' }, 0, { test: true });
  assert.deepEqual(JSON.parse(r.text).got, { query: 'Q3 "plan"', page_size: 10 }); assert.match(r.text, /application\/json/);
  const away = cleanAction({ name: 'Away', path: '/post-away', method: 'POST', readOnly: true, body: '{}', params: [] });
  await assert.rejects(runAction(env, db, 'u1', await row(), away, {}, 0, { test: true }), /doesn’t follow that for a POST/);
  const gql = cleanAction({ name: 'GraphQL', path: '/search', method: 'POST', readOnly: true, body: '{"query":"{{doc}}"}', params: [{ name: 'doc', in: 'body', type: 'text', required: true, max: 200 }] });
  const n0 = seen.length;
  await assert.rejects(runAction(env, db, 'u1', await row(), gql, { doc: 'mutation { deleteAll }' }, 0, { test: true }), /mutation/);
  assert.equal(seen.length, n0, 'nothing was sent');
  // XML: read safely (entities a DOCTYPE defines aren't expanded, nothing outside is loaded) and kept short.
  const xAct = cleanAction({ name: 'Forecast', path: '/../xml'.replace('/..', ''), params: [] });
  r = await runAction(env, db, 'u1', await row({ baseUrl: 'https://api.example.com' }), xAct, {}, 0, { test: true });
  assert.match(r.text, /item\.text: Showers & wind/); assert.match(r.text, /area=Ang Mo Kio/);
  assert.ok(!/aaaaaaaaaa|passwd/.test(r.text), 'no entity expanded, no file read');
});

await ok('saving: secret headers and the sign-in are kept unless replaced, needed, and dropped when the site moves', async () => {
  const base = { name: 'Acme', baseUrl: 'https://api.example.com/v1', auth: 'header', authName: 'X-Api-Key', key: 'k-1', actions: [order], termsOk: true };
  const v1 = await cleanInput(env, { ...base, headers: [{ name: 'X-Client', secret: true, value: 'c-1' }, { name: 'Notion-Version', secret: false, value: '2022-06-28' }] }, { admin: false });
  assert.deepEqual(v1.headers, [{ name: 'X-Client', secret: true }, { name: 'Notion-Version', secret: false, value: '2022-06-28' }]);
  assert.ok(v1.secretsEnc && !JSON.stringify(v1.headers).includes('c-1'));
  const before = { ...(await row()), ...v1 };
  const v2 = await cleanInput(env, { ...base, key: '', headers: [{ name: 'X-Client', secret: true, value: '' }] }, { admin: false, before });
  assert.ok(v2.secretsEnc, 'kept when left empty');
  await assert.rejects(cleanInput(env, { ...base, baseUrl: 'https://other.example.org', headers: [{ name: 'X-Client', secret: true, value: '' }] }, { admin: false, before }), /Enter the value for X-Client/, 'dropped when the site moves');
  await assert.rejects(cleanInput(env, { ...base, headers: [{ name: 'Host', value: 'x' }] }, { admin: false }), /sets Host itself/);
  await assert.rejects(cleanInput(env, { ...base, headers: [{ name: 'X-Api-Key', value: 'x' }] }, { admin: false }), /listed twice/);
  const tok = { ...base, auth: 'token', token: { url: 'https://api.example.com/oauth/token', style: 'client' } };
  await assert.rejects(cleanInput(env, tok, { admin: true }), /client ID and secret/);
  const t1 = await cleanInput(env, { ...tok, tokenId: 'id-1', tokenSecret: 'sec-1', keyMode: 'own' }, { admin: true });
  assert.equal(t1.keyMode, 'one', 'one sign-in for everyone it’s offered to'); assert.equal(t1.keyEnc, null); assert.equal(t1.token.idName, 'client_id');
  const tBefore = { ...(await row()), ...t1 };
  assert.ok((await cleanInput(env, tok, { admin: true, before: tBefore })).secretsEnc, 'the sign-in is kept');
  await assert.rejects(cleanInput(env, { ...tok, token: { url: 'https://other.example.org/token', style: 'client' } }, { admin: true, before: tBefore }), /client ID and secret/, 'another token address: entered again');
  await assert.rejects(cleanInput(env, { ...tok, token: { url: 'https://10.0.0.1/token' }, tokenId: 'a', tokenSecret: 'b' }, { admin: true }), /./);
});

await ok('rules: POST must be read-only, values in quotes, GraphQL changes refused; headers and token checked', () => {
  const p = (o) => cleanAction({ name: 'S', path: '/s', method: 'POST', readOnly: true, body: '{"q":"{{q}}"}', params: [{ name: 'q', in: 'body', type: 'text', required: true }], ...o });
  assert.equal(p({}).method, 'POST');
  assert.match(p({ readOnly: false }).problem, /only reads data/);
  assert.match(p({ body: '{"q":{{q}}}' }).problem, /in quotes/);
  assert.match(p({ body: '{"q":"{{other}}"}' }).problem, /isn’t one of its values/);
  assert.match(p({ body: '{"q":"x"}' }).problem, /isn’t in the body/);
  assert.match(p({ body: '{"query":"mutation { drop }"}', params: [] }).problem, /mutation/);
  assert.ok(!('problem' in p({ body: '{"query":"query { a { b } }","variables":{"x":"{{q}}"}}' })), 'a GraphQL query with variables');
  assert.ok(!('problem' in p({ body: '{"a":{"b":{"c":"{{q}}"}}}' })), 'nested JSON is fine');
  assert.match(cleanAction({ name: 'G', path: '/g', params: [{ name: 'q', in: 'body', type: 'text' }] }).problem, /need POST/);
  const form = p({ bodyType: 'form', body: 'query={{q}}&limit=5' });
  assert.deepEqual(actionBody(form, { q: 'a b&c' }), { body: 'query=a%20b%26c&limit=5', type: 'application/x-www-form-urlencoded' });
  assert.match(actionBody(form, { q: 'mutation { x }' }).problem, /mutation/);
  const typed = p({ body: '{"n":"{{n}}","on":"{{on}}","q":"{{q}}"}', params: [{ name: 'n', in: 'body', type: 'integer' }, { name: 'on', in: 'body', type: 'boolean' }, { name: 'q', in: 'body', type: 'text' }] });
  assert.deepEqual(JSON.parse(actionBody(typed, { n: '3', on: 'true' }).body), { n: 3, on: true, q: null });
  assert.equal(cleanHeaders([{ name: 'A' }, { name: 'B' }, { name: 'C' }, { name: 'D' }, { name: 'E' }, { name: 'F' }, { name: 'G' }]).problem?.includes('up to 6'), true);
  assert.match(cleanHeaders([{ name: 'X', value: 'a\nb' }]).problem, /one line/);
  assert.match(cleanHeaders([{ name: 'Content-Type', value: 'x' }]).problem, /sets Content-Type/);
  assert.match(cleanToken({ url: 'http://x.example.com/t' }).problem, /https/);
  assert.equal(cleanToken({ url: 'https://login.example.com/t', style: 'login' }).idName, 'email');
  assert.match(cleanToken({ url: 'https://login.example.com/t', tokenPath: '../x' }).problem, /where the token is/);
});

await ok('a curl command becomes a source: method, headers (secret or plain), body values, Basic sign-in', () => {
  let r = fromCurl(`curl -X POST https://api.notion.com/v1/search \\\n  -H "Authorization: Bearer secret_1" \\\n  -H 'Notion-Version: 2022-06-28' -H "Content-Type: application/json" \\\n  --data '{"query": "Q3 plan", "page_size": 10, "filter": {"value": "page"}}'`);
  assert.equal(r.baseUrl, 'https://api.notion.com'); assert.equal(r.action.method, 'POST'); assert.equal(r.action.path, '/v1/search');
  assert.deepEqual(r.auth, { mode: 'header', name: 'Authorization', value: 'Bearer secret_1' });
  assert.deepEqual(r.headers, [{ name: 'Notion-Version', value: '2022-06-28', secret: false }]);
  assert.deepEqual(r.action.params.map((p) => [p.name, p.in, p.sample]), [['query', 'body', 'Q3 plan'], ['value', 'body', 'page']]);
  assert.deepEqual(JSON.parse(r.action.body.replace(/"\{\{(\w+)\}\}"/g, '"<$1>"')), { query: '<query>', page_size: 10, filter: { value: '<value>' } });
  assert.ok(!('problem' in cleanAction({ ...r.action, readOnly: true })), 'it passes the saved check once confirmed');
  // GraphQL: the query stays as written; variables become values.
  r = fromCurl(`curl https://api.example.com/graphql --json '{"query":"query($id: ID!) { stop(id: $id) { name } }","variables":{"id":"83139"}}'`);
  assert.match(r.action.body, /query\(\$id: ID!\)/); assert.deepEqual(r.action.params.map((p) => p.name), ['id']);
  // GET with -G data, -u Basic, a key in a custom header, a cookie kept secret.
  r = fromCurl(`curl -G https://api.example.com/v2/stops -d stop=03229 -d lang=en -u user:pa55 -H "X-Trace: 1" -b "sid=abc"`);
  assert.equal(r.action.method, undefined); assert.deepEqual(r.action.params.map((p) => [p.name, p.fixed ?? p.sample]), [['stop', '03229'], ['lang', 'en']]);
  assert.deepEqual(r.auth, { mode: 'header', name: 'Authorization', value: `Basic ${btoa('user:pa55')}` });
  assert.deepEqual(r.headers.map((h) => [h.name, h.secret]), [['X-Trace', false], ['Cookie', true]]);
  // A form body; changes and uploads refused; a password in the body sent to the key field instead.
  r = fromCurl(`curl -d "q=bus+15&limit=5" https://api.example.com/find`);
  assert.equal(r.action.bodyType, 'form', 'curl sends -d as a form unless told otherwise'); assert.equal(r.action.body, 'q={{q}}&limit={{limit}}');
  for (const [bad, why] of [['curl -X DELETE https://api.example.com/x', /changes data/], ['curl -X PUT https://api.example.com/x -d a=1', /changes data/], ['curl -F f=@a.txt https://api.example.com/x', /uploads/], [`curl https://api.example.com/login --json '{"user":"a","password":"b"}'`, /key or password/], ['curl -H "A: b', /quotes/], ['curl -s', /find the link/]]) assert.match(fromCurl(bad).problem ?? '', why, bad);
});

await ok('XML: elements, attributes and text read; DOCTYPE dropped and entities left alone; lists cut; records for datasets', () => {
  const x = parseXml('<?xml version="1.0"?><!-- c --><a xmlns:n="u"><n:b id="1">one &lt;1&gt; &#65;</n:b><![CDATA[<raw>]]></a>');
  assert.equal(x.kids[0].name, 'a'); assert.equal(x.kids[0].kids[0].name, 'b'); assert.equal(x.kids[0].kids[0].text, 'one <1> A'); assert.equal(x.kids[0].text, '<raw>');
  assert.equal(parseXml('<a><b></a> < x'), null, 'not XML');
  const many = `<list>${Array.from({ length: 40 }, (_, i) => `<row><n>${i}</n></row>`).join('')}</list>`;
  assert.match(xmlText(many), /… more row/);
  assert.equal(xmlRecords(many).length, 40); assert.deepEqual(xmlRecords('<r><s c="1"><v>a</v></s><s c="2"><v>b</v></s></r>'), [{ '@c': '1', v: 'a' }, { '@c': '2', v: 'b' }]);
});

globalThis.fetch = realFetch;
await ok('a link that works becomes a source: the site, the path, a value per part with its example, and the key', () => {
  let r = fromExampleLink('https://datamall2.mytransport.sg/ltaodataservice/v3/BusArrival?BusStopCode=03229&ServiceNo=15');
  assert.equal(r.baseUrl, 'https://datamall2.mytransport.sg');
  assert.equal(r.name, 'Bus arrival'); assert.equal(r.action.path, '/ltaodataservice/v3/BusArrival'); assert.equal(r.key, null);
  assert.deepEqual(r.action.params.map((p) => [p.name, p.in, p.type, p.sample, p.required]), [['BusStopCode', 'query', 'text', '03229', true], ['ServiceNo', 'query', 'text', '15', true]], 'codes keep their zeros as text');
  assert.ok(!('problem' in cleanAction(r.action, new Set())), 'it passes the same check as when saved');
  // A key in the link becomes the key, never an example; the answer's format stays as it is; ids in the path are values.
  r = fromExampleLink('https://api.example.com/v2/stops/83139/arrivals?api_key=SECRET-1&format=json&lat=1.3521&on=2026-11-19&all=true');
  assert.deepEqual(r.key, { name: 'api_key', value: 'SECRET-1' });
  assert.equal(r.action.path, '/v2/stops/{stop}/arrivals'); assert.equal(r.name, 'Arrivals');
  assert.deepEqual(r.action.params.map((p) => [p.name, p.in, p.type, p.fixed ?? p.sample]), [['stop', 'path', 'text', '83139'], ['format', 'query', 'text', 'json'], ['lat', 'query', 'number', '1.3521'], ['on', 'query', 'date', '2026-11-19'], ['all', 'query', 'boolean', 'true']]);
  assert.ok(!JSON.stringify(r.action).includes('SECRET-1'));
  assert.ok(!('problem' in cleanAction(r.action, new Set())));
  // Names already taken get a new id; plain problems for links that won't do.
  assert.equal(fromExampleLink('https://datamall2.mytransport.sg/ltaodataservice/v3/BusArrival', new Set(['bus-arrival'])).action.id, 'bus-arrival-2');
  for (const [bad, why] of [['', /Paste a link/], ['datamall', /whole link/], ['http://api.example.com/x', /https/], ['https://me:pw@api.example.com/x', /sign-in/], ['https://10.0.0.1/x', /./], ['https://localhost/x', /./]]) assert.match(fromExampleLink(bad).problem ?? '', why, bad);
});

await ok('a test shows the start of what came back only when asked (the person setting it up)', async () => {
  const acts = [{ id: 'a', name: 'A', path: '/a', params: [], live: true, example: '', on: true }];
  const run = async () => ({ text: 'x'.repeat(800) });
  const [withPeek] = await testActions(run, acts, { peek: true });
  assert.equal(withPeek.ok, true); assert.equal(withPeek.peek.length, 600);
  const [without] = await testActions(run, acts);
  assert.equal(without.peek, undefined);
  const [bad] = await testActions(async () => { throw new DataProblem('No such stop.'); }, acts, { peek: true });
  assert.equal(bad.ok, false); assert.equal(bad.problem, 'No such stop.'); assert.equal(bad.peek, undefined);
});

await ok('places from live questions: offered after a few times, not when already kept or turned down, forgotten after 60 days', () => {
  const day = 86_400_000, t0 = Date.UTC(2026, 10, 1);
  const item = { key: 'src:bus-arrivals:BusStopCode=83139', name: 'Bus arrivals', value: 'BusStopCode 83139' };
  let seen = [];
  for (let i = 0; i < LIVE_SUGGEST_AT - 1; i++) seen = noteSeen(seen, item, t0 + i * day);
  const prefs = (x = {}) => ({ live: { everywhere: [], countries: {}, places: [] }, liveSeen: seen, liveNo: [], ...x });
  assert.deepEqual(liveSuggestions(prefs(), t0 + 3 * day), [], 'not yet');
  seen = noteSeen(seen, item, t0 + 3 * day);
  assert.equal(liveSuggestions(prefs(), t0 + 3 * day)[0].count, LIVE_SUGGEST_AT);
  assert.deepEqual(liveSuggestions(prefs({ live: { everywhere: [], countries: {}, places: [{ name: 'Usual stop', value: 'busstopcode 83139' }] } }), t0 + 3 * day), [], 'already one of their places');
  assert.deepEqual(liveSuggestions(prefs({ liveNo: [item.key] }), t0 + 3 * day), [], 'turned down');
  assert.deepEqual(liveSuggestions(prefs(), t0 + 64 * day), [], 'faded after 60 days');
  assert.equal(noteSeen(seen, { key: 'other', name: 'x', value: 'y' }, t0 + 70 * day).length, 1, 'old ones are dropped');
  assert.ok(noteSeen(Array.from({ length: 40 }, (_, i) => ({ key: `k${i}`, name: 'n', value: 'v', count: 1, first: t0, last: t0 })), item, t0).length <= 30, 'capped');
});

console.log(`${pass} data source checks passed`);
