// Maps: each service is asked the way it expects, keys never come back to the browser, a country's own list comes
// first (from the location or from what was said), countries without a list use Everywhere, the built-in skip rules
// hold (Google routes in Korea, non-Chinese services in China), failures rest and hand over, and China's coordinates
// line up with the map.
import assert from 'node:assert/strict';
import { countryOf, decodeFlexible, decodePolyline, findRoute, findWith, mapKeyProblem, pickTransit, placeName, rideText, routeWith } from '../apps/api/src/maps.ts';
import { mapsOn } from '../packages/shared/src/index.ts';
import { greatCircle, greatCircleMeters, flightSeconds, countryNamed, isCountryName } from '../packages/shared/src/maps.ts';
import { fullscreenCommand } from '../apps/app/src/speech.ts';
import { bdToGcj, gcjToBd, gcjToWgs, mapChain, mapHandoff, mapSkipped, wgsToGcj } from '../packages/shared/src/maps.ts';
import { countryCommand, countryFromName, mapCommand, stepsCommand, takeMapTag, takeStepsTag } from '../apps/app/src/speech.ts';
import { store, fakeDb } from './brains-stubs.mjs';

const ok = async (name, fn) => { try { await fn(); console.log('PASS', name); } catch (e) { console.log('FAIL', name, e?.stack ?? e?.message); process.exitCode = 1; } };
let calls = [], reply = () => Response.json({});
globalThis.fetch = async (url, init = {}) => { calls.push({ url: String(url), init }); return reply(String(url), init); };
const env = { ENCRYPTION_KEY: 'x' };
const key = (id, provider, extra = {}) => ({ id, provider, label: '', baseUrl: '', email: '', apiKey: `SECRET-${id}`, secret: '', password: '', ...extra });
const user = (engine) => ({ id: 'u1', engine });
const SEOUL = { lat: 37.5547, lng: 126.9707 }, SG = { lat: 1.3521, lng: 103.8198 }, TOKYO = { lat: 35.6595, lng: 139.7005 }, SHANGHAI = { lat: 31.2304, lng: 121.4737 };

await ok('countries come from built-in borders, with Hong Kong on its own', async () => {
  assert.equal(await countryOf(126.98, 37.57), 'KR'); assert.equal(await countryOf(103.85, 1.29), 'SG');
  assert.equal(await countryOf(114.17, 22.32), 'HK'); assert.equal(await countryOf(121.47, 31.23), 'CN');
  assert.equal(await countryOf(0, 0), null); assert.equal(await countryOf(999, 0), null);
});
await ok('skip rules: Google routes in Korea, non-Chinese services in China, country-only services elsewhere', () => {
  assert.ok(mapSkipped('google', 'KR', 'walk')); assert.ok(mapSkipped('google', 'KR', 'drive'));
  assert.equal(mapSkipped('google', 'KR', 'place'), null); assert.equal(mapSkipped('google', 'KR', 'transit'), null);
  assert.ok(mapSkipped('google', 'CN', 'place')); assert.ok(mapSkipped('mapbox', 'CN', 'drive'));
  assert.equal(mapSkipped('amap', 'CN', 'drive'), null); assert.equal(mapSkipped('osm', 'CN', 'place'), null);
  assert.ok(mapSkipped('onemap', 'MY', 'drive')); assert.ok(mapSkipped('naver', null, 'place')); assert.equal(mapSkipped('google', 'HK', 'drive'), null);
});
await ok('the chain: the country’s list, then Everywhere, then the built-in map', () => {
  const e = { maps: ['mkey:g'], mapCountries: { SG: ['mkey:o'], XX: ['bad'], kr: ['mkey:n'] } };
  assert.deepEqual(mapChain(e, 'SG'), { chain: ['mkey:o', 'mkey:g', 'osm'], listed: true });
  assert.deepEqual(mapChain(e, 'JP'), { chain: ['mkey:g', 'osm'], listed: false });
  assert.deepEqual(mapChain({}, null).chain, ['osm']);
});
await ok('China’s coordinates: to GCJ-02 and back within a couple of metres; elsewhere unchanged', () => {
  const [gl, ga] = wgsToGcj(121.4737, 31.2304);
  assert.ok(Math.abs(gl - 121.4737) > 0.003);
  const [wl, wa] = gcjToWgs(gl, ga);
  assert.ok(Math.abs(wl - 121.4737) < 0.00002 && Math.abs(wa - 31.2304) < 0.00002);
  const [bl, ba] = gcjToBd(gl, ga), [g2l, g2a] = bdToGcj(bl, ba);
  assert.ok(Math.abs(g2l - gl) < 0.00002 && Math.abs(g2a - ga) < 0.00002);
  assert.deepEqual(wgsToGcj(2.29, 48.85), [2.29, 48.85]);
});
await ok('polylines: Google’s and HERE’s flexible format decode to [lng, lat]', () => {
  const g = decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@');
  assert.deepEqual(g.map(([x, y]) => [+x.toFixed(3), +y.toFixed(3)]), [[-120.2, 38.5], [-120.95, 40.7], [-126.453, 43.252]]);
  const h = decodeFlexible('BFoz5xJ67i1B1B7PzIhaxL7Y');
  assert.deepEqual(h.map(([x, y]) => [+x.toFixed(5), +y.toFixed(5)]), [[8.69821, 50.10228], [8.69567, 50.10201], [8.6915, 50.10063], [8.68752, 50.09878]]);
});
await ok('key settings are checked', () => {
  assert.equal(mapKeyProblem({ provider: 'google', apiKey: 'k', secret: '', email: '', password: '', baseUrl: '' }), null);
  assert.ok(mapKeyProblem({ provider: 'google', apiKey: '', secret: '', email: '', password: '', baseUrl: '' }));
  assert.ok(mapKeyProblem({ provider: 'naver', apiKey: 'id', secret: '', email: '', password: '', baseUrl: '' }));
  assert.ok(mapKeyProblem({ provider: 'self-hosted', apiKey: '', secret: '', email: '', password: '', baseUrl: 'https://127.0.0.1' }));
  assert.equal(mapKeyProblem({ provider: 'self-hosted', apiKey: '', secret: '', email: '', password: '', baseUrl: 'https://osrm.example.com' }), null);
  assert.ok(mapKeyProblem({ provider: 'onemap', apiKey: '', secret: '', email: 'nope', password: 'p', baseUrl: '' }));
  assert.ok(mapKeyProblem({ provider: 'nope', apiKey: 'k', secret: '', email: '', password: '', baseUrl: '' }));
});
await ok('Google: Places and Routes with the key in a header, never in the address; no redirects followed', async () => {
  calls = [];
  reply = (url) => url.includes('places') ? Response.json({ places: [{ displayName: { text: 'Changi Airport' }, formattedAddress: 'Airport Blvd', location: { latitude: 1.3644, longitude: 103.9915 } }] })
    : Response.json({ routes: [{ duration: '1500s', distanceMeters: 21000, polyline: { encodedPolyline: '_p~iF~ps|U_ulLnnqC' }, legs: [{ steps: [{ navigationInstruction: { instructions: 'Head east' }, distanceMeters: 100 }, { transitDetails: { transitLine: { nameShort: 'EW' }, stopDetails: { arrivalStop: { name: 'Changi Airport' } } } }] }] }] });
  const k = key('g', 'google');
  const p = await findWith(k, 'Changi Airport', SG);
  assert.equal(p.name, 'Changi Airport'); assert.equal(calls[0].init.headers['x-goog-api-key'], 'SECRET-g'); assert.ok(!calls[0].url.includes('SECRET'));
  assert.equal(calls[0].init.redirect, 'manual');
  const r = await routeWith(k, { name: 'You', ...SG }, p, 'transit');
  assert.equal(r.seconds, 1500); assert.equal(r.meters, 21000); assert.equal(r.coords.length, 2);
  assert.equal(JSON.parse(calls[1].init.body).travelMode, 'TRANSIT'); assert.equal(r.steps[1].text, 'Take EW to Changi Airport');
});
await ok('public transport: the MRT is chosen over a bus ride when it’s about as quick, and stations and lines are named', async () => {
  // Choosing: the quickest, unless a route with the MRT is at most about 10 minutes (or a fifth) slower.
  assert.equal(pickTransit([{ seconds: 1800, rail: false, n: 'bus' }, { seconds: 2100, rail: true, n: 'mrt' }]).n, 'mrt');
  assert.equal(pickTransit([{ seconds: 1800, rail: false, n: 'bus' }, { seconds: 3000, rail: true, n: 'mrt' }]).n, 'bus', 'not when it’s much slower');
  assert.equal(pickTransit([{ seconds: 1500, rail: true, n: 'mrt' }, { seconds: 1400, rail: false, n: 'bus' }]).n, 'mrt');
  assert.equal(pickTransit([]), undefined);
  assert.equal(placeName('TANJONG PAGAR MRT STATION'), 'Tanjong Pagar MRT Station'); assert.equal(placeName('OPP TG PAGAR STN ew15'), 'Opp Tg Pagar Stn EW15');
  assert.equal(rideText('rail', 'EW', 'Tanjong Pagar', 'Raffles Place', 1, true), 'Take the MRT East–West Line from Tanjong Pagar to Raffles Place, 1 stop');
  assert.equal(rideText('bus', '75', 'Opp Blk 123', 'Tanjong Pagar Stn', 4), 'Take bus 75 from Opp Blk 123 to Tanjong Pagar Stn, 4 stops');
  // OneMap: three itineraries asked for; the bus-only one is quickest, the bus + MRT one 5 minutes slower is chosen.
  calls = [];
  const leg = (mode, extra) => ({ mode, distance: 1000, legGeometry: { points: '_p~iF~ps|U_ulLnnqC' }, ...extra });
  reply = (url) => url.includes('getToken') ? Response.json({ access_token: 'TOKEN-2', expiry_timestamp: String(Math.floor(Date.now() / 1000) + 3600) })
    : url.includes('routeType=pt') ? Response.json({ plan: { itineraries: [
      { duration: 1800, legs: [leg('WALK', { to: { name: 'OPP BLK 123' } }), leg('BUS', { route: '75', from: { name: 'OPP BLK 123' }, to: { name: 'RAFFLES PL STN EXIT B' }, intermediateStops: [1, 2, 3, 4, 5, 6, 7, 8] }), leg('WALK', { to: { name: 'Destination' } })] },
      { duration: 2100, legs: [leg('WALK', { to: { name: 'OPP BLK 123', stopCode: '52189' } }), leg('BUS', { route: '75', from: { name: 'OPP BLK 123' }, to: { name: 'TANJONG PAGAR STN' }, intermediateStops: [1, 2, 3] }), leg('SUBWAY', { route: 'EW', from: { name: 'TANJONG PAGAR MRT STATION' }, to: { name: 'RAFFLES PLACE MRT STATION' }, intermediateStops: [] }), leg('WALK', { to: { name: 'Destination' } })] },
    ] } })
    : new Response('no', { status: 500 });
  const r = await routeWith(key('o2', 'onemap', { email: 'me@example.com', password: 'PASSWORD-2', apiKey: '' }), { name: 'You', ...SG }, { name: 'Raffles Place', lat: 1.284, lng: 103.851 }, 'transit');
  assert.ok(calls.some((c) => c.url.includes('numItineraries=3')));
  assert.equal(r.seconds, 2100);
  assert.deepEqual(r.steps.map((x) => x.text), ['Walk to Opp Blk 123 (stop 52189)', 'Take bus 75 from Opp Blk 123 to Tanjong Pagar Stn, 4 stops', 'Take the MRT East–West Line from Tanjong Pagar MRT Station to Raffles Place MRT Station, 1 stop', 'Walk to your destination']);
  // Google: alternatives asked for with every kind of vehicle; the one with the subway chosen.
  calls = [];
  const gstep = (type, line, dep, arr, stops) => ({ distanceMeters: 1000, transitDetails: { transitLine: { nameShort: line, vehicle: { type } }, stopDetails: { departureStop: { name: dep }, arrivalStop: { name: arr } }, stopCount: stops } });
  reply = () => Response.json({ routes: [
    { duration: '1700s', distanceMeters: 9000, polyline: { encodedPolyline: '_p~iF~ps|U_ulLnnqC' }, legs: [{ steps: [gstep('BUS', '75', 'A', 'B', 12)] }] },
    { duration: '1900s', distanceMeters: 8000, polyline: { encodedPolyline: '_p~iF~ps|U_ulLnnqC' }, legs: [{ steps: [gstep('BUS', '75', 'A', 'Tanjong Pagar Stn', 4), gstep('SUBWAY', 'EW', 'Tanjong Pagar', 'Raffles Place', 1)] }] },
  ] });
  const g = await routeWith(key('g2', 'google'), { name: 'You', ...SG }, { name: 'Raffles Place', lat: 1.284, lng: 103.851 }, 'transit');
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.computeAlternativeRoutes, true); assert.ok(body.transitPreferences.allowedTravelModes.includes('SUBWAY'));
  assert.ok(calls[0].init.headers['x-goog-fieldmask'].includes('vehicle.type'));
  assert.equal(g.seconds, 1900); assert.equal(g.steps[1].text, 'Take the MRT East–West Line from Tanjong Pagar to Raffles Place, 1 stop', 'in Singapore, said the Singapore way');
  // Driving is asked for as before: no alternatives.
  calls = []; await routeWith(key('g2', 'google'), { name: 'You', ...SG }, { name: 'Raffles Place', lat: 1.284, lng: 103.851 }, 'drive');
  assert.equal(JSON.parse(calls[0].init.body).computeAlternativeRoutes, undefined);
});
await ok('Singapore by GPS: OneMap first (token renewed by Niko), and the answer carries no key', async () => {
  calls = []; store.engineWrites = [];
  store.creds['map-keys'] = { keys: [key('o', 'onemap', { email: 'me@example.com', password: 'PASSWORD-1', apiKey: '' }), key('g', 'google')] };
  reply = (url) => url.includes('getToken') ? Response.json({ access_token: 'TOKEN-1', expiry_timestamp: String(Math.floor(Date.now() / 1000) + 3600) })
    : url.includes('elastic/search') ? Response.json({ results: [{ SEARCHVAL: 'CHANGI AIRPORT', ADDRESS: '60 AIRPORT BOULEVARD', LATITUDE: '1.3644', LONGITUDE: '103.9915' }] })
    : url.includes('routingsvc') ? Response.json({ route_geometry: '_p~iF~ps|U_ulLnnqC', route_summary: { total_time: 1500, total_distance: 21000 }, route_instructions: [['Head', 'PIE', 100, '1,103', 10, '100m', 'East', 'east', 'driving', 'Head East On Pan Island Expressway']] })
    : new Response('no', { status: 500 });
  const r = await findRoute(env, fakeDb, user({ maps: ['mkey:g', 'osm'], mapCountries: { SG: ['mkey:o'] } }), { to: 'Changi Airport', mode: 'drive', here: SG, country: 'auto' });
  assert.equal(r.source.label, 'OneMap (Singapore)'); assert.deepEqual(r.country, { code: 'SG', name: 'Singapore', how: 'gps', listed: true });
  assert.equal(r.to.name, 'Changi Airport'); assert.equal(r.route.seconds, 1500); assert.equal(r.route.steps[0].text, 'Head East On Pan Island Expressway');
  assert.equal(calls.find((c) => c.url.includes('elastic')).init.headers.authorization, 'TOKEN-1');
  const out = JSON.stringify(r);
  for (const s of ['SECRET', 'PASSWORD', 'TOKEN-1']) assert.ok(!out.includes(s), `answer contains ${s}`);
  assert.ok(!calls.some((c) => c.url.includes('google')), 'Google was not needed');
  assert.deepEqual(r.handoff.map((h) => h.app), ['Google Maps', 'Apple Maps']);
});
await ok('Korea: Naver and Kakao first; Google is skipped for walking, and Niko says so', async () => {
  calls = [];
  store.creds['map-keys'] = { keys: [key('n', 'naver', { secret: 'SECRET-ns' }), key('k', 'kakao'), key('g', 'google')] };
  reply = (url) => url.includes('map-geocode') ? Response.json({ status: 'OK', addresses: [] })
    : url.includes('dapi.kakao.com') ? Response.json({ documents: [{ place_name: '강남역', road_address_name: '서울 강남구 강남대로 396', x: '127.0276', y: '37.4979' }] })
    : new Response('no', { status: 500 });
  const r = await findRoute(env, fakeDb, user({ maps: ['mkey:g'], mapCountries: { KR: ['mkey:n', 'mkey:k'] } }), { to: 'Gangnam Station', mode: 'walk', here: SEOUL, country: 'auto' });
  assert.equal(r.to.name, '강남역'); assert.equal(r.route, undefined);
  assert.ok(r.skipped.some((s) => s.startsWith('Google Maps Platform') && /South Korea/.test(s)));
  assert.match(r.noRoute, /walking/);
  assert.equal(calls.find((c) => c.url.includes('map-geocode')).init.headers['x-ncp-apigw-api-key'], 'SECRET-ns');
  assert.equal(calls.find((c) => c.url.includes('kakao')).init.headers.authorization, 'KakaoAK SECRET-k');
  assert.ok(!calls.some((c) => c.url.includes('routes.googleapis')), 'no Google route was asked for');
  assert.deepEqual(r.handoff.map((h) => h.app), ['Naver Map', 'KakaoMap']);
});
await ok('a service at its limit rests and the next one answers', async () => {
  calls = []; store.engineWrites = [];
  store.creds['map-keys'] = { keys: [key('g', 'google'), key('m', 'mapbox')] };
  reply = (url) => url.includes('googleapis') ? new Response(JSON.stringify({ error: { message: 'Quota exceeded' } }), { status: 429 })
    : url.includes('geocode/v6') ? Response.json({ features: [{ properties: { name: 'Shibuya Crossing', full_address: 'Tokyo' }, geometry: { coordinates: [139.7005, 35.6595] } }] })
    : url.includes('directions/v5') ? Response.json({ code: 'Ok', routes: [{ duration: 600, distance: 800, geometry: { coordinates: [[139.70, 35.66], [139.7005, 35.6595]] }, legs: [{ steps: [{ maneuver: { instruction: 'Walk north' }, distance: 800 }] }] }] })
    : new Response('no', { status: 500 });
  const r = await findRoute(env, fakeDb, user({ maps: ['mkey:g', 'mkey:m'] }), { to: 'Shibuya Crossing', mode: 'walk', here: TOKYO, country: 'auto' });
  assert.equal(r.source.label, 'Mapbox'); assert.equal(r.route.seconds, 600);
  assert.deepEqual(r.country, { code: 'JP', name: 'Japan', how: 'gps', listed: false });
  const rest = store.engineWrites.at(-1).mapRest['mkey:g'];
  assert.equal(rest.why, 'limit'); assert.ok(rest.until > Date.now());
  assert.ok(calls.find((c) => c.url.includes('directions/v5')).url.includes('/mapbox/walking/'));
});
await ok('a country said aloud with no list uses Everywhere; a trip across a border uses Everywhere too', async () => {
  calls = [];
  store.creds['map-keys'] = { keys: [key('o', 'onemap', { email: 'me@example.com', password: 'p' }), key('m', 'mapbox')] };
  reply = (url) => url.includes('geocode/v6') ? Response.json({ features: [{ properties: { name: 'Johor Bahru' }, geometry: { coordinates: [103.7414, 1.4927] } }] })
    : url.includes('directions/v5') ? Response.json({ code: 'Ok', routes: [{ duration: 1800, distance: 25000, geometry: { coordinates: [[103.82, 1.35], [103.74, 1.49]] }, legs: [] }] })
    : new Response('no', { status: 500 });
  const said = await findRoute(env, fakeDb, user({ maps: ['mkey:m'], mapCountries: { SG: ['mkey:o'] } }), { to: 'Johor Bahru', mode: 'drive', here: null, country: 'JP' });
  assert.deepEqual(said.country, { code: 'JP', name: 'Japan', how: 'said', listed: false }); assert.equal(said.noRoute.startsWith('Allow your location'), true);
  calls = [];
  const cross = await findRoute(env, fakeDb, user({ maps: ['mkey:m'], mapCountries: { SG: ['mkey:o'] } }), { to: 'Johor Bahru', mode: 'drive', here: SG, country: 'auto' });
  assert.equal(cross.source.label, 'Mapbox'); assert.ok(!calls.some((c) => c.url.includes('onemap') && c.url.includes('routingsvc')), 'OneMap was not asked for a route into Malaysia');
});
await ok('China: Amap places and routes are moved back to the map’s coordinates', async () => {
  store.creds['map-keys'] = { keys: [key('a', 'amap'), key('g', 'google')] };
  const [gl, ga] = wgsToGcj(121.4990, 31.2397);
  reply = (url) => url.includes('place/text') ? Response.json({ status: '1', pois: [{ name: '东方明珠', address: '世纪大道1号', location: `${gl.toFixed(6)},${ga.toFixed(6)}` }] })
    : url.includes('direction/driving') ? Response.json({ status: '1', route: { paths: [{ distance: '3000', cost: { duration: '900' }, steps: [{ instruction: '向东行驶', step_distance: '3000', polyline: `121.47,31.23;${gl.toFixed(6)},${ga.toFixed(6)}` }] }] } })
    : new Response('no', { status: 500 });
  calls = [];
  const r = await findRoute(env, fakeDb, user({ maps: ['mkey:g'], mapCountries: { CN: ['mkey:a'] } }), { to: '东方明珠', mode: 'drive', here: SHANGHAI, country: 'auto' });
  assert.ok(Math.abs(r.to.lng - 121.4990) < 0.0001 && Math.abs(r.to.lat - 31.2397) < 0.0001, 'the pin lines up');
  assert.equal(r.route.seconds, 900); assert.ok(r.skipped.some((s) => s.startsWith('Google')));
  const sent = new URL(calls.find((c) => c.url.includes('direction/driving')).url).searchParams.get('origin').split(',').map(Number);
  const [ol, oa] = wgsToGcj(SHANGHAI.lng, SHANGHAI.lat);
  assert.ok(Math.abs(sent[0] - ol) < 0.00001 && Math.abs(sent[1] - oa) < 0.00001, 'the start was sent in China’s coordinates');
  assert.equal(r.handoff[0].app, 'Amap');
});
await ok('no keys: the built-in OpenStreetMap search finds the place, and the trip opens in an app', async () => {
  store.creds['map-keys'] = null; calls = [];
  reply = (url) => url.startsWith('https://photon.komoot.io/') ? Response.json({ features: [{ properties: { name: 'Eiffel Tower', city: 'Paris', country: 'France' }, geometry: { coordinates: [2.2945, 48.8584] } }] }) : new Response('no', { status: 500 });
  const r = await findRoute(env, fakeDb, user({}), { to: 'Eiffel Tower', mode: 'transit', here: { lat: 48.86, lng: 2.35 }, country: 'auto' });
  assert.equal(r.to.name, 'Eiffel Tower'); assert.equal(r.source.label, 'OpenStreetMap'); assert.match(r.noRoute, /public transport/);
  assert.ok(calls[0].init.headers['user-agent'].startsWith('Niko'));
  assert.equal(r.handoff[0].url, 'https://www.google.com/maps/dir/?api=1&destination=48.858400,2.294500&travelmode=transit');
});
await ok('the administrator’s choices: maps off for the account, or one service off', async () => {
  await assert.rejects(findRoute(env, fakeDb, user({}), { to: 'x', mode: 'drive', here: null, country: 'auto' }, ['sec:maps']), /not on account/);
  store.creds['map-keys'] = { keys: [key('g', 'google')] }; calls = [];
  reply = (url) => url.startsWith('https://photon') ? Response.json({ features: [{ properties: { name: 'Louvre' }, geometry: { coordinates: [2.3376, 48.8606] } }] }) : new Response('no', { status: 500 });
  const r = await findRoute(env, fakeDb, user({ maps: ['mkey:g'] }), { to: 'Louvre', mode: 'drive', here: null, country: 'auto' }, ['map:google']);
  assert.ok(!calls.some((c) => c.url.includes('google')));
  assert.deepEqual(r.chain, ['OpenStreetMap']);
});
await ok('every map service off for the account means no maps; the built-in map off with no services means none set up', async () => {
  const all = ['map:osm', 'map:google', 'map:mapbox', 'map:onemap', 'map:openrouteservice', 'map:naver', 'map:kakao', 'map:amap', 'map:baidu', 'map:here', 'map:tomtom', 'map:geoapify', 'map:maptiler', 'map:self-hosted'];
  assert.equal(mapsOn(all), false); assert.equal(mapsOn(['sec:maps']), false); assert.equal(mapsOn(['map:osm']), true); assert.equal(mapsOn([]), true);
  await assert.rejects(findRoute(env, fakeDb, user({}), { to: 'x', mode: 'drive', here: null, country: 'auto' }, all), /not on account/);
  store.creds['map-keys'] = null;
  await assert.rejects(findRoute(env, fakeDb, user({}), { to: 'Louvre', mode: 'drive', here: null, country: 'auto' }, ['map:osm']), /no services/);
});
await ok('nothing found: not the service’s fault, so nothing rests', async () => {
  store.creds['map-keys'] = { keys: [key('m', 'mapbox')] }; store.engineWrites = [];
  reply = () => Response.json({ features: [] });
  await assert.rejects(findRoute(env, fakeDb, user({ maps: ['mkey:m'] }), { to: 'zzzz', mode: 'drive', here: null, country: 'auto' }), /not found/);
  assert.equal(store.engineWrites.length, 0);
});
await ok('a route server of your own: the key goes only to its address, and redirects are refused', async () => {
  calls = [];
  reply = () => new Response('', { status: 302, headers: { location: 'https://evil.example.com/' } });
  await assert.rejects(routeWith(key('s', 'self-hosted', { baseUrl: 'https://osrm.example.com/', apiKey: 'K' }), { name: 'a', lat: 1, lng: 1 }, { name: 'b', lat: 1.1, lng: 1.1 }, 'cycle'), /redirect/);
  assert.equal(calls[0].url, 'https://osrm.example.com/route/v1/cycling/1,1;1.1,1.1?overview=full&geometries=geojson&steps=true');
  assert.equal(calls[0].init.headers.authorization, 'Bearer K');
});
await ok('handoff links open the app people use there', () => {
  const to = { name: 'Gangnam Station', lat: 37.4979, lng: 127.0276 };
  assert.equal(mapHandoff('KR', to, 'drive')[1].url, 'https://map.kakao.com/link/to/Gangnam%20Station,37.497900,127.027600');
  assert.ok(mapHandoff('CN', { name: 'x', lat: 31.2, lng: 121.5 }, 'walk')[0].url.startsWith('https://uri.amap.com/navigation?to='));
  assert.ok(mapHandoff('US', to, 'place')[1].url.startsWith('https://maps.apple.com/?q='));
});
await ok('the brain’s map tag, and what can be said on a map', () => {
  assert.deepEqual(takeMapTag('Here’s the way. [[map:transit|Changi Airport, Singapore]]'), { text: 'Here’s the way.', map: { how: 'transit', to: 'Changi Airport, Singapore' } });
  assert.deepEqual(takeMapTag('Ok [[map:any|Gangnam Station|Seoul Station]]').map, { how: 'any', to: 'Gangnam Station', from: 'Seoul Station' });
  assert.equal(takeMapTag('[[map:train|Tokyo Tower]]').map.how, 'transit');
  assert.equal(takeMapTag('No map here.').map, null);
  assert.deepEqual(mapCommand('by train'), { mode: 'transit' }); assert.deepEqual(mapCommand('show me walking instead'), { mode: 'walk' });
  assert.deepEqual(mapCommand('drive me there'), { mode: 'drive' }); assert.deepEqual(mapCommand('Niko, by bike please'), { mode: 'cycle' });
  assert.deepEqual(mapCommand('close the map'), { close: true });
  assert.deepEqual(mapCommand('How about opening the steps?'), { steps: true }); assert.deepEqual(mapCommand('show me the directions'), { steps: true });
  assert.deepEqual(mapCommand('hide the steps'), { steps: false });
  assert.equal(mapCommand('how do I get to the zoo by train'), null);
  assert.equal(countryCommand("I'm in Korea"), 'KR'); assert.equal(countryCommand('I am in Japan now'), 'JP'); assert.equal(countryCommand('use worldwide'), 'ww');
  assert.equal(countryCommand('switch the country to the UK'), 'GB'); assert.equal(countryCommand("I'm in a meeting"), null); assert.equal(countryCommand("I'm in Paris"), null);
  assert.equal(countryFromName('South Korea'), 'KR'); assert.equal(countryFromName('France'), 'FR');
});

await ok('flights: a great-circle line that never jumps the 180° meridian, its length, a rough time, and Google Flights', async () => {
  const sin = { lat: 1.3644, lng: 103.9915 }, lax = { lat: 33.9416, lng: -118.4085 };
  const m = greatCircleMeters(sin, lax); assert.ok(m > 14_000_000 && m < 14_200_000, String(m));
  const line = greatCircle(sin, lax);
  assert.equal(line.length, 129);
  for (let i = 1; i < line.length; i++) assert.ok(Math.abs(line[i][0] - line[i - 1][0]) < 20, 'no jump');
  assert.ok(line.at(-1)[0] > 180, 'continues east past 180°');
  const mid = line[64]; assert.ok(mid[1] > 30, 'arcs north of the straight line on a flat map');
  assert.ok(Math.abs(flightSeconds(m) / 3600 - 17.5) < 0.6);
  store.creds['map-keys'] = null;
  reply = (url) => url.startsWith('https://photon') ? Response.json({ features: [{ properties: { name: url.includes('Haneda') ? 'Haneda Airport' : 'Changi Airport' }, geometry: { coordinates: url.includes('Haneda') ? [139.7798, 35.5494] : [103.9915, 1.3644] } }] }) : new Response('no', { status: 500 });
  const r = await findRoute(env, fakeDb, user({}), { to: 'Haneda Airport, Tokyo', from: 'Changi Airport', mode: 'fly', here: null, country: 'auto' });
  assert.equal(r.route.mode, 'fly'); assert.equal(r.from.name, 'Changi Airport'); assert.ok(r.route.meters > 5_200_000 && r.route.meters < 5_500_000);
  assert.equal(r.handoff[0].app, 'Google Flights'); assert.ok(r.handoff[0].url.includes('Flights%20from%20Changi%20Airport%20to%20Haneda%20Airport'));
  const none = await findRoute(env, fakeDb, user({}), { to: 'Haneda Airport', mode: 'fly', here: null, country: 'auto' });
  assert.match(none.noRoute, /where the flight is from/);
  assert.equal(takeMapTag('Here it is. [[map:fly|Haneda Airport, Tokyo|Changi Airport]]').map.how, 'fly');
  assert.deepEqual(mapCommand('by plane'), { mode: 'fly' }); assert.deepEqual(mapCommand('show me the flight path'), { mode: 'fly' });
});
await ok('a flight to a country, from Singapore with OneMap first: found anywhere, never as a shop in Singapore', async () => {
  calls = []; store.engineWrites = [];
  store.creds['map-keys'] = { keys: [key('o', 'onemap', { email: 'me@example.com', password: 'PASSWORD-1', apiKey: '' }), key('g', 'google')] };
  // OneMap matches any word against Singapore's buildings ("Japan Home", "Singapore Chinese Girls' School").
  reply = (url, init) => url.includes('getToken') ? Response.json({ access_token: 'TOKEN-1', expiry_timestamp: String(Math.floor(Date.now() / 1000) + 3600) })
    : url.includes('elastic/search') ? Response.json({ results: [{ SEARCHVAL: 'JAPAN HOME BUANGKOK SQUARE MALL', ADDRESS: '991 BUANGKOK LINK', LATITUDE: '1.3832', LONGITUDE: '103.8794' }] })
    : url.includes('places') ? Response.json({ places: [JSON.parse(init.body).textQuery === 'Japan' ? { displayName: { text: 'Japan' }, formattedAddress: 'Japan', location: { latitude: 36.2, longitude: 138.25 } } : { displayName: { text: 'Singapore' }, formattedAddress: 'Singapore', location: { latitude: 1.3521, longitude: 103.8198 } }] })
    : new Response('no', { status: 500 });
  const u = user({ maps: ['mkey:g', 'osm'], mapCountries: { SG: ['mkey:o'] } });
  const r = await findRoute(env, fakeDb, u, { to: 'Japan', from: 'Singapore', mode: 'fly', here: SG, country: 'auto' });
  assert.equal(r.to.name, 'Japan'); assert.equal(r.from.name, 'Singapore'); assert.equal(r.route?.mode, 'fly', JSON.stringify(r.noRoute));
  assert.ok(r.route.meters > 4_500_000, 'Singapore to Japan is thousands of kilometres');
  assert.ok(!calls.some((c) => c.url.includes('elastic/search')), 'OneMap (Singapore only) is not asked about a flight');
  const places = calls.filter((c) => c.url.includes('places'));
  assert.ok(places.every((c) => !JSON.parse(c.init.body).locationBias), 'a flight is not nudged towards where you are');
  // Driving to "Tokyo, Japan" from Singapore: OneMap is skipped for a place in another country.
  calls = [];
  reply = (url, init) => url.includes('places') ? Response.json({ places: [{ displayName: { text: 'Tokyo' }, formattedAddress: 'Tokyo, Japan', location: { latitude: 35.68, longitude: 139.69 } }] })
    : url.includes('routes') ? Response.json({ routes: [] }) : new Response('no', { status: 500 });
  const d = await findRoute(env, fakeDb, u, { to: 'Tokyo, Japan', mode: 'drive', here: SG, country: 'auto' });
  assert.equal(d.to.name, 'Tokyo'); assert.ok(!calls.some((c) => c.url.includes('elastic/search')));
  assert.ok(d.skipped.some((x) => /OneMap/.test(x)));
  // A result outside the country named is not taken: the next service is asked.
  calls = [];
  reply = (url, init) => url.includes('places') ? Response.json({ places: [{ displayName: { text: 'Japan Home' }, formattedAddress: 'Singapore', location: { latitude: 1.38, longitude: 103.88 } }] })
    : url.startsWith('https://photon') ? Response.json({ features: [{ properties: { name: 'Japan', type: 'country' }, geometry: { coordinates: [139.0, 36.0] } }] }) : new Response('no', { status: 500 });
  const c2 = await findRoute(env, fakeDb, u, { to: 'Japan', mode: 'place', here: SG, country: 'auto' });
  assert.equal(c2.to.name, 'Japan'); assert.equal(c2.source.label.includes('OpenStreetMap') || c2.source.id === 'osm', true);
  assert.ok(calls.find((c) => c.url.startsWith('https://photon')).url.includes('layer=country') && !calls.find((c) => c.url.startsWith('https://photon')).url.includes('lat='));
  store.creds['map-keys'] = null;
});
await ok('a place named by its country', () => {
  assert.equal(countryNamed('Japan'), 'JP'); assert.equal(countryNamed('Tokyo, Japan'), 'JP'); assert.equal(countryNamed('Osaka Japan'), 'JP');
  assert.equal(countryNamed('South Korea'), 'KR'); assert.equal(countryNamed('the UK'), null); assert.equal(countryNamed('UK'), 'GB'); assert.equal(countryNamed('Singapore'), 'SG');
  assert.equal(countryNamed('Changi Airport'), null); assert.equal(countryNamed('Japan Home'), null); assert.equal(countryNamed('Marina Bay Sands'), null);
  assert.equal(isCountryName('Japan'), true); assert.equal(isCountryName('Tokyo, Japan'), false);
});
await ok('full screen by voice', () => {
  assert.equal(fullscreenCommand('Niko, go full screen'), 'enter'); assert.equal(fullscreenCommand('fullscreen please'), 'enter');
  assert.equal(fullscreenCommand('exit full screen'), 'exit'); assert.equal(fullscreenCommand('back to normal'), 'exit');
  assert.equal(fullscreenCommand('what is a full screen monitor'), null);
});
await ok('the steps of the route on screen: many ways of asking, and new routes left alone', async () => {
  for (const t of ['Niko, open the steps to show the direction', 'show me the steps for the direction', 'can you open the steps please', 'show the step by step', 'open step-by-step directions',
    'display the route steps', 'expand the directions', 'let me see the steps', 'can I see the transit breakdown', 'steps', 'the directions please', 'show me the directions'])
    assert.deepEqual(stepsCommand(t), { steps: true }, t);
  for (const t of ['read me the steps', 'tell me the directions', 'what are the steps', 'walk me through the steps', 'how do I get there step by step', 'read the directions out loud'])
    assert.deepEqual(stepsCommand(t), { steps: true, read: true }, t);
  for (const t of ['hide the steps', 'close the directions', 'collapse the steps']) assert.deepEqual(stepsCommand(t), { steps: false }, t);
  for (const t of ['directions to Changi Airport', 'show me directions to the zoo', 'steps to get to Orchard', 'how do I get to the zoo by train', 'directions from Bishan to Tampines'])
    assert.equal(stepsCommand(t), null, t);
  assert.deepEqual(mapCommand('show me the steps for the direction'), { steps: true });
  assert.deepEqual(takeStepsTag('Here are the steps. [[steps]]'), { text: 'Here are the steps.', open: true });
  assert.deepEqual(takeStepsTag('Take the TE line.'), { text: 'Take the TE line.', open: false });
});
