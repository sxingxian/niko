// Data sources: addresses (https, public names only, private addresses refused at every redirect), actions and the
// values the AI fills in (checked, encoded, nothing unlisted), OpenAPI files (read-only actions only), tags, short
// results, who may use what, and running an action (keys in a header or the address, never sent to another site,
// answers shared only when they hold nothing personal, the monthly limit).
import assert from 'node:assert/strict';
import {
  actionUrl, checkValues, cleanAction, cleanActions, cleanBaseUrl, cleanDataAccess, cleanDataPrefs, dataAllowed, dataBlock, dataTags, hostProblem,
  openApiActions, privateIp, resultText, sampleValues, stripDataTags, cleanWeatherPrefs, weatherOrder, cleanDataDefaults, cleanLivePrefs, liveOrder, placesBlock, datasetTable, actionLine, noteSeen, liveSuggestions, LIVE_SUGGEST_AT,
} from '../packages/shared/src/dataSources.ts';
import { fromExampleLink } from '../packages/shared/src/dataSources.ts';
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
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url));
  seen.push({ url: u.toString(), headers: { ...(init.headers ?? {}) } });
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
  await assert.rejects(safeGet('https://api.example.com/html'), /JSON or CSV/);
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
