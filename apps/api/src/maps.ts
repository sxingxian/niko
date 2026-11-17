// Maps: places and routes from the services in the account's order (a country's own list first, then Everywhere, then
// the built-in OpenStreetMap search). Like the brains and voices, a service that reaches its limit, refuses its key or
// doesn't answer rests for a while and the next one is used.
//
// Keys stay on the server: the browser only ever sees the place, the line to draw and the steps. The person's location
// is used for this one request (to find their country and to start the route) and is never stored or logged.
import { and, eq } from 'drizzle-orm';
import { connections, users, type Db } from '@niko/db';
import {
  aiAllowed, mapsOn, bdToGcj, gcjToBd, gcjToWgs, mapChain, mapCountryLists, mapHandoff, mapOption, mapPreset, mapSkipped, MAX_MAP_KEYS, wgsToGcj,
  type BrainRest, type EnginePrefs, type MapKeyInfo, type MapMode, type MapPlace, type MapProvider, type MapResult, type MapRoute, type MapSource, type MapStep,
} from '@niko/shared';
import type { Env } from './env';
import { BrainFail, providerMessage } from './brains';
import { seal } from './lib/crypto';
import { credentials, publicHttpsUrl } from './providers';

export interface MapKey extends MapKeyInfo { apiKey: string; secret: string; password: string }
export const MAP_PROVIDERS_LIST: MapProvider[] = ['google', 'mapbox', 'onemap', 'openrouteservice', 'naver', 'kakao', 'amap', 'baidu', 'here', 'tomtom', 'geoapify', 'maptiler', 'self-hosted'];
const MIN = 60_000, HOUR = 60 * MIN;
const UA = 'Niko/1.0 (+https://niko.sxingxian.com)';
const MAX_POINTS = 3000, MAX_STEPS = 40;

// ---------------------------------------------------------------- countries
const regionNames = (() => { try { return new Intl.DisplayNames(['en'], { type: 'region' }); } catch { return null; } })();
export const countryName = (cc: string | null) => (cc ? (regionNames?.of(cc) ?? cc) : null);
/** The country a point is in, from borders built into Niko (no outside service is asked). Null at sea. */
export async function countryOf(lng: number, lat: number): Promise<string | null> {
  if (!Number.isFinite(lng) || !Number.isFinite(lat) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  const cc = await import('@rapideditor/country-coder');
  // Hong Kong and Macau have their own codes; country-coder gives them as part of CN unless asked for the region.
  const code = cc.iso1A2Code([lng, lat], { level: 'territory' }) ?? cc.iso1A2Code([lng, lat]);
  return code && /^[A-Z]{2}$/.test(code) ? code : null;
}
export const cleanPoint = (v: any): { lat: number; lng: number } | null => {
  const lat = Number(v?.lat), lng = Number(v?.lng);
  return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { lat, lng } : null;
};

// ---------------------------------------------------------------- the saved keys
export async function loadMapKeys(env: Env, db: Db, userId: string): Promise<MapKey[]> {
  const s = (await credentials(env, db, userId, 'map-keys').catch(() => null)) as any;
  return (Array.isArray(s?.keys) ? s.keys : []).filter((k: any) => k && typeof k.id === 'string' && MAP_PROVIDERS_LIST.includes(k.provider)).slice(0, MAX_MAP_KEYS).map((k: any) => ({
    id: k.id, provider: k.provider, label: String(k.label ?? '') || mapPreset(k.provider)!.name, baseUrl: String(k.baseUrl ?? ''), email: String(k.email ?? ''),
    apiKey: String(k.apiKey ?? ''), secret: String(k.secret ?? ''), password: String(k.password ?? ''),
  }));
}
export async function saveMapKeys(env: Env, db: Db, userId: string, keys: MapKey[]): Promise<void> {
  await db.delete(connections).where(and(eq(connections.userId, userId), eq(connections.provider, 'map-keys')));
  if (!keys.length) return;
  const secret = { keys: keys.map(({ id, label, provider, baseUrl, email, apiKey, secret, password }) => ({ id, label, provider, baseUrl, email, apiKey, secret, password })) };
  await db.insert(connections).values({ id: crypto.randomUUID(), userId, provider: 'map-keys', secretEnc: await seal(env.ENCRYPTION_KEY, secret), meta: { label: `${keys.length} map service${keys.length === 1 ? '' : 's'}` } });
}
export const mapKeyInfo = (k: MapKey): MapKeyInfo => ({ id: k.id, label: k.label, provider: k.provider, baseUrl: k.baseUrl, email: k.email });
/** Checks a key's settings before it is saved or used. Returns a message for the person, or null. */
export function mapKeyProblem(k: Pick<MapKey, 'provider' | 'baseUrl' | 'apiKey' | 'secret' | 'email' | 'password'>, saved?: boolean): string | null {
  const p = mapPreset(k.provider);
  if (!p) return 'Choose a map service.';
  if (k.provider === 'self-hosted' && !publicHttpsUrl(k.baseUrl)) return 'The server address must be a public https address.';
  if (k.provider === 'onemap' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(k.email)) return 'Enter the email of your OneMap account.';
  if (!saved) for (const f of p.fields) if (!f.optional && f.key !== 'baseUrl' && f.key !== 'email' && !k[f.key]) return `Paste the ${f.label.toLowerCase()}.`;
  return null;
}

// ---------------------------------------------------------------- talking to services
async function fail(res: Response): Promise<BrainFail> {
  const body = (await res.text().catch(() => '')).slice(0, 2000), text = body.toLowerCase(), detail = providerMessage(body);
  const after = Number(res.headers.get('retry-after'));
  const wait = Number.isFinite(after) && after > 0 ? Math.min(Math.max(after * 1000, 15_000), HOUR) : 0;
  const quota = /quota|credit|limit|billing|exceeded|payment|balance/.test(text);
  if (res.status === 402 || (quota && [400, 403, 429].includes(res.status))) return new BrainFail(`limit ${res.status}`, 'limit', wait || HOUR, detail);
  if (res.status === 429) return new BrainFail(`rate ${res.status}`, 'limit', wait || MIN, detail);
  if (res.status === 401 || res.status === 403) return new BrainFail(`refused ${res.status}`, 'refused', 6 * HOUR, detail);
  return new BrainFail(`down ${res.status}`, 'down', wait || MIN, detail);
}
async function getJson(url: string, init: RequestInit = {}, seconds = 10): Promise<any> {
  let res: Response;
  try {
    // Redirects are not followed, so an address cannot bounce the request (and the key) somewhere else.
    res = await fetch(url, { ...init, headers: { accept: 'application/json', 'user-agent': UA, ...(init.headers as Record<string, string> | undefined) }, redirect: 'manual', signal: AbortSignal.timeout(seconds * 1000) });
  } catch (e) {
    throw new BrainFail('unreachable', 'down', MIN, (e as Error)?.name === 'TimeoutError' ? `It took longer than ${seconds} seconds to answer.` : 'It could not be reached.');
  }
  if (res.status >= 300 && res.status < 400) throw new BrainFail('redirect', 'refused', 30 * MIN, 'It tried to redirect the request.');
  if (!res.ok) throw await fail(res);
  return res.json().catch(() => { throw new BrainFail('not json', 'down', MIN, 'It answered with something other than map data.'); });
}
/** A service answered, but with an error of its own in the body (several Asian services answer 200 with a code). */
const said = (why: BrainRest['why'], detail: string, restMs = why === 'refused' ? 6 * HOUR : why === 'limit' ? HOUR : MIN) => new BrainFail(`said ${why}`, why, restMs, detail.slice(0, 200));
/** No result: not the service's fault, so it does not rest. */
export class NotFound extends Error { constructor() { super('not found'); } }

const enc = encodeURIComponent;
const str = (v: unknown, n = 200) => (typeof v === 'string' ? v.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().slice(0, n) : '');
const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
function place(name: unknown, address: unknown, lng: unknown, lat: unknown): MapPlace {
  const p = { name: str(name, 120), address: str(address, 200) || undefined, lng: Number(lng), lat: Number(lat) };
  if (!Number.isFinite(p.lat) || !Number.isFinite(p.lng) || Math.abs(p.lat) > 90 || Math.abs(p.lng) > 180) throw new NotFound();
  if (!p.name) p.name = p.address ?? 'Destination';
  return p;
}
/** Long lines are thinned so the card stays light. */
function thin(coords: [number, number][]): [number, number][] {
  const c = coords.filter((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]));
  if (c.length <= MAX_POINTS) return c;
  const step = c.length / MAX_POINTS, out: [number, number][] = [];
  for (let i = 0; i < MAX_POINTS - 1; i++) out.push(c[Math.floor(i * step)]!);
  out.push(c[c.length - 1]!);
  return out;
}
function route(mode: MapMode, coords: [number, number][], seconds: unknown, meters: unknown, steps: MapStep[]): MapRoute {
  const c = thin(coords);
  if (c.length < 2) throw new NotFound();
  return { mode, coords: c, seconds: Math.round(num(seconds)), meters: Math.round(num(meters)), steps: steps.filter((s) => s.text).slice(0, MAX_STEPS).map((s) => ({ text: str(s.text, 160), ...(s.meters ? { meters: Math.round(s.meters) } : {}) })) };
}

/** Google's encoded polyline ([lng, lat] out). */
export function decodePolyline(s: string, precision = 5): [number, number][] {
  const out: [number, number][] = [], f = 10 ** precision;
  let i = 0, lat = 0, lng = 0;
  while (i < s.length) {
    for (const which of [0, 1]) {
      let shift = 0, result = 0, b: number;
      do { b = s.charCodeAt(i++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
      const d = result & 1 ? ~(result >> 1) : result >> 1;
      if (which === 0) lat += d; else lng += d;
    }
    out.push([lng / f, lat / f]);
  }
  return out;
}
/** HERE's flexible polyline ([lng, lat] out). */
export function decodeFlexible(s: string): [number, number][] {
  const T = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const vals: number[] = [];
  let res = 0, mul = 1;
  for (const ch of s) {
    const v = T.indexOf(ch);
    if (v < 0) return [];
    res += (v & 0x1f) * mul;
    if (v & 0x20) mul *= 32; else { vals.push(res); res = 0; mul = 1; }
  }
  if (vals.length < 2 || vals[0] !== 1) return [];
  const header = vals[1]!, prec = header & 15, third = (header >> 4) & 7, f = 10 ** prec, signed = (v: number) => (v % 2 ? -(v + 1) / 2 : v / 2);
  const out: [number, number][] = [], per = third ? 3 : 2;
  let lat = 0, lng = 0;
  for (let i = 2; i + per - 1 < vals.length; i += per) { lat += signed(vals[i]!); lng += signed(vals[i + 1]!); out.push([lng / f, lat / f]); }
  return out;
}

// ---------------------------------------------------------------- OneMap's token (renewed by Niko, kept in memory only)
const oneMapTokens = new Map<string, { token: string; until: number }>();
async function oneMapToken(k: MapKey): Promise<string> {
  const id = `${k.email}|${k.id}`, t = oneMapTokens.get(id);
  if (t && t.until > Date.now() + MIN) return t.token;
  const d = await getJson('https://www.onemap.gov.sg/api/auth/post/getToken', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: k.email, password: k.password }) });
  const token = str(d?.access_token, 4000);
  if (!token) throw said('refused', str(d?.error) || 'OneMap did not accept the account email and password.');
  const exp = num(d?.expiry_timestamp) * 1000;
  oneMapTokens.set(id, { token, until: exp > Date.now() ? exp : Date.now() + 2 * HOUR });
  if (oneMapTokens.size > 500) oneMapTokens.delete(oneMapTokens.keys().next().value!);
  return token;
}

// ---------------------------------------------------------------- finding a place
type Near = { lat: number; lng: number } | null;
/** Photon (OpenStreetMap data, komoot's public server), used lightly: one search per request, near the person. */
async function osmFind(q: string, near: Near): Promise<MapPlace> {
  const d = await getJson(`https://photon.komoot.io/api/?q=${enc(q)}&limit=1&lang=en${near ? `&lat=${near.lat.toFixed(3)}&lon=${near.lng.toFixed(3)}` : ''}`);
  const f = d?.features?.[0];
  if (!f) throw new NotFound();
  const p = f.properties ?? {};
  return place(p.name ?? p.street, [p.housenumber && p.street ? `${p.housenumber} ${p.street}` : p.street, p.city ?? p.county, p.country].filter(Boolean).join(', '), f.geometry?.coordinates?.[0], f.geometry?.coordinates?.[1]);
}
export async function findWith(k: MapKey, q: string, near: Near): Promise<MapPlace> {
  switch (k.provider) {
    case 'google': {
      const body: any = { textQuery: q, maxResultCount: 1, languageCode: 'en' };
      if (near) body.locationBias = { circle: { center: { latitude: near.lat, longitude: near.lng }, radius: 50000 } };
      const d = await getJson('https://places.googleapis.com/v1/places:searchText', { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': k.apiKey, 'x-goog-fieldmask': 'places.displayName,places.formattedAddress,places.location' }, body: JSON.stringify(body) });
      const p = d?.places?.[0];
      if (!p) throw new NotFound();
      return place(p.displayName?.text, p.formattedAddress, p.location?.longitude, p.location?.latitude);
    }
    case 'mapbox': {
      const d = await getJson(`https://api.mapbox.com/search/geocode/v6/forward?q=${enc(q)}&limit=1${near ? `&proximity=${near.lng},${near.lat}` : ''}&access_token=${enc(k.apiKey)}`);
      const f = d?.features?.[0];
      if (!f) throw new NotFound();
      return place(f.properties?.name, f.properties?.full_address ?? f.properties?.place_formatted, f.geometry?.coordinates?.[0], f.geometry?.coordinates?.[1]);
    }
    case 'onemap': {
      const token = await oneMapToken(k);
      const d = await getJson(`https://www.onemap.gov.sg/api/common/elastic/search?searchVal=${enc(q)}&returnGeom=Y&getAddrDetails=Y&pageNum=1`, { headers: { authorization: token } });
      const r = d?.results?.[0];
      if (!r) throw new NotFound();
      const title = (s: string) => s.toLowerCase().replace(/\b\w/g, (m) => m.toUpperCase());
      return place(title(str(r.SEARCHVAL)), title(str(r.ADDRESS)), r.LONGITUDE, r.LATITUDE);
    }
    case 'openrouteservice': {
      const d = await getJson(`https://api.openrouteservice.org/geocode/search?text=${enc(q)}&size=1${near ? `&focus.point.lon=${near.lng}&focus.point.lat=${near.lat}` : ''}`, { headers: { authorization: k.apiKey } });
      const f = d?.features?.[0];
      if (!f) throw new NotFound();
      return place(f.properties?.name, f.properties?.label, f.geometry?.coordinates?.[0], f.geometry?.coordinates?.[1]);
    }
    case 'naver': {
      // Naver's geocoder finds addresses (not shop or station names); a name it can't find goes to the next service.
      const d = await getJson(`https://maps.apigw.ntruss.com/map-geocode/v2/geocode?query=${enc(q)}${near ? `&coordinate=${near.lng},${near.lat}` : ''}`, { headers: naverHeaders(k) });
      if (d?.status && d.status !== 'OK') throw said('refused', str(d.errorMessage) || 'Naver did not accept the request.');
      const a = d?.addresses?.[0];
      if (!a) throw new NotFound();
      return place(a.roadAddress || a.jibunAddress, a.englishAddress || a.jibunAddress, a.x, a.y);
    }
    case 'kakao': {
      const d = await getJson(`https://dapi.kakao.com/v2/local/search/keyword.json?query=${enc(q)}&size=1${near ? `&x=${near.lng}&y=${near.lat}` : ''}`, { headers: { authorization: `KakaoAK ${k.apiKey}` } });
      const p = d?.documents?.[0];
      if (!p) throw new NotFound();
      return place(p.place_name, p.road_address_name || p.address_name, p.x, p.y);
    }
    case 'amap': {
      const d = await getJson(`https://restapi.amap.com/v3/place/text?key=${enc(k.apiKey)}&keywords=${enc(q)}&offset=1&page=1`);
      amapOk(d);
      const p = d?.pois?.[0];
      if (!p) throw new NotFound();
      const [lng, lat] = String(p.location ?? '').split(',').map(Number);
      const [wl, wa] = gcjToWgs(lng!, lat!);
      return place(p.name, Array.isArray(p.address) ? '' : p.address, wl, wa);
    }
    case 'baidu': {
      const d = await getJson(`https://api.map.baidu.com/place/v2/search?query=${enc(q)}&region=${enc('全国')}&output=json&page_size=1&ret_coordtype=gcj02ll&ak=${enc(k.apiKey)}`);
      baiduOk(d);
      const p = d?.results?.[0];
      if (!p?.location) throw new NotFound();
      const [wl, wa] = gcjToWgs(num(p.location.lng), num(p.location.lat));
      return place(p.name, p.address, wl, wa);
    }
    case 'here': {
      const d = near
        ? await getJson(`https://discover.search.hereapi.com/v1/discover?q=${enc(q)}&at=${near.lat},${near.lng}&limit=1&lang=en&apiKey=${enc(k.apiKey)}`)
        : await getJson(`https://geocode.search.hereapi.com/v1/geocode?q=${enc(q)}&limit=1&lang=en&apiKey=${enc(k.apiKey)}`);
      const p = d?.items?.[0];
      if (!p) throw new NotFound();
      return place(p.title, p.address?.label, p.position?.lng, p.position?.lat);
    }
    case 'tomtom': {
      const d = await getJson(`https://api.tomtom.com/search/2/search/${enc(q)}.json?limit=1${near ? `&lat=${near.lat}&lon=${near.lng}` : ''}&key=${enc(k.apiKey)}`);
      const p = d?.results?.[0];
      if (!p) throw new NotFound();
      return place(p.poi?.name ?? p.address?.freeformAddress, p.address?.freeformAddress, p.position?.lon, p.position?.lat);
    }
    case 'geoapify': {
      const d = await getJson(`https://api.geoapify.com/v1/geocode/search?text=${enc(q)}&limit=1&format=json${near ? `&bias=proximity:${near.lng},${near.lat}` : ''}&apiKey=${enc(k.apiKey)}`);
      const p = d?.results?.[0];
      if (!p) throw new NotFound();
      return place(p.name ?? p.address_line1, p.formatted, p.lon, p.lat);
    }
    case 'maptiler': {
      const d = await getJson(`https://api.maptiler.com/geocoding/${enc(q)}.json?limit=1${near ? `&proximity=${near.lng},${near.lat}` : ''}&key=${enc(k.apiKey)}`);
      const f = d?.features?.[0];
      if (!f) throw new NotFound();
      return place(f.text, f.place_name, f.center?.[0], f.center?.[1]);
    }
    default: throw new BrainFail('no places', 'refused', 0, 'It does not find places.');
  }
}
const naverHeaders = (k: MapKey) => ({ 'x-ncp-apigw-api-key-id': k.apiKey, 'x-ncp-apigw-api-key': k.secret });
function amapOk(d: any) {
  if (d?.status === '1' || d?.status === 1) return;
  const info = str(d?.info) || 'Amap did not accept the request.', code = String(d?.infocode ?? '');
  throw said(/LIMIT|OVER|QUOTA/i.test(info) || ['10003', '10004', '10014', '10044'].includes(code) ? 'limit' : /KEY|SIGN|USERKEY|IP/i.test(info) ? 'refused' : 'down', info);
}
function baiduOk(d: any) {
  const s = num(d?.status);
  if (s === 0) return;
  const msg = str(d?.message) || 'Baidu did not accept the request.';
  throw said([4, 301, 302, 401, 402].includes(s) ? 'limit' : [200, 201, 202, 203, 210, 211, 220, 230, 240, 250, 251, 252, 260, 261].includes(s) ? 'refused' : 'down', msg);
}

// ---------------------------------------------------------------- routing
const LL = (p: MapPlace) => `${p.lng},${p.lat}`;
export async function routeWith(k: MapKey, from: MapPlace, to: MapPlace, mode: MapMode): Promise<MapRoute> {
  switch (k.provider) {
    case 'google': {
      const body = { origin: { location: { latLng: { latitude: from.lat, longitude: from.lng } } }, destination: { location: { latLng: { latitude: to.lat, longitude: to.lng } } }, travelMode: { drive: 'DRIVE', transit: 'TRANSIT', walk: 'WALK', cycle: 'BICYCLE' }[mode], languageCode: 'en' };
      const d = await getJson('https://routes.googleapis.com/directions/v2:computeRoutes', { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': k.apiKey, 'x-goog-fieldmask': 'routes.duration,routes.distanceMeters,routes.polyline.encodedPolyline,routes.legs.steps.navigationInstruction,routes.legs.steps.distanceMeters,routes.legs.steps.transitDetails.transitLine.nameShort,routes.legs.steps.transitDetails.transitLine.name,routes.legs.steps.transitDetails.stopDetails.arrivalStop.name,routes.legs.steps.travelMode' }, body: JSON.stringify(body) });
      const r = d?.routes?.[0];
      if (!r?.polyline?.encodedPolyline) throw new NotFound();
      const steps: MapStep[] = (r.legs ?? []).flatMap((l: any) => l.steps ?? []).map((s: any) => {
        const t = s.transitDetails;
        return { text: t ? `Take ${str(t.transitLine?.nameShort || t.transitLine?.name, 40) || 'the line'} to ${str(t.stopDetails?.arrivalStop?.name, 80) || 'your stop'}` : str(s.navigationInstruction?.instructions), meters: num(s.distanceMeters) };
      });
      return route(mode, decodePolyline(r.polyline.encodedPolyline), parseInt(String(r.duration ?? '0'), 10), r.distanceMeters, merge(steps));
    }
    case 'mapbox': case 'self-hosted': {
      const profile = k.provider === 'mapbox' ? `mapbox/${{ drive: 'driving', walk: 'walking', cycle: 'cycling', transit: 'driving' }[mode]}` : { drive: 'driving', walk: 'foot', cycle: 'cycling', transit: 'driving' }[mode];
      const base = k.provider === 'mapbox' ? 'https://api.mapbox.com/directions/v5' : `${k.baseUrl.trim().replace(/\/+$/, '')}/route/v1`;
      const d = await getJson(`${base}/${profile}/${LL(from)};${LL(to)}?overview=full&geometries=geojson&steps=true${k.provider === 'mapbox' ? `&access_token=${enc(k.apiKey)}` : ''}`, k.provider === 'self-hosted' && k.apiKey ? { headers: { authorization: `Bearer ${k.apiKey}` } } : {});
      if (d?.code && d.code !== 'Ok') { if (/NoRoute|NoSegment/.test(d.code)) throw new NotFound(); throw said('down', str(d.message) || d.code); }
      const r = d?.routes?.[0];
      if (!r) throw new NotFound();
      const steps = (r.legs ?? []).flatMap((l: any) => l.steps ?? []).map((s: any) => ({ text: str(s.maneuver?.instruction) || osrmText(s), meters: num(s.distance) }));
      return route(mode, r.geometry?.coordinates ?? [], r.duration, r.distance, steps);
    }
    case 'onemap': {
      const token = await oneMapToken(k), start = `${from.lat},${from.lng}`, end = `${to.lat},${to.lng}`;
      if (mode === 'transit') {
        const now = new Date(Date.now() + 8 * HOUR), p2 = (n: number) => String(n).padStart(2, '0');
        const date = `${p2(now.getUTCMonth() + 1)}-${p2(now.getUTCDate())}-${now.getUTCFullYear()}`, time = `${p2(now.getUTCHours())}:${p2(now.getUTCMinutes())}:00`;
        const d = await getJson(`https://www.onemap.gov.sg/api/public/routingsvc/route?start=${start}&end=${end}&routeType=pt&date=${date}&time=${enc(time)}&mode=TRANSIT&maxWalkDistance=1000&numItineraries=1`, { headers: { authorization: token } });
        const it = d?.plan?.itineraries?.[0];
        if (!it) throw new NotFound();
        const legs: any[] = it.legs ?? [];
        const coords = legs.flatMap((l) => (l.legGeometry?.points ? decodePolyline(l.legGeometry.points) : []));
        const steps = legs.map((l) => ({ text: l.mode === 'WALK' ? `Walk to ${str(l.to?.name, 80) || 'the next stop'}` : `Take ${l.mode === 'BUS' ? 'bus' : l.mode === 'SUBWAY' ? 'the MRT' : str(l.mode).toLowerCase()} ${str(l.route, 20)} to ${str(l.to?.name, 80)}`.replace(/\s+/g, ' '), meters: num(l.distance) }));
        return route(mode, coords, it.duration, legs.reduce((a, l) => a + num(l.distance), 0), steps);
      }
      const d = await getJson(`https://www.onemap.gov.sg/api/public/routingsvc/route?start=${start}&end=${end}&routeType=${{ drive: 'drive', walk: 'walk', cycle: 'cycle' }[mode]}`, { headers: { authorization: token } });
      if (!d?.route_geometry) throw new NotFound();
      const steps = (d.route_instructions ?? []).map((s: any[]) => ({ text: str([...s].reverse().find((x) => typeof x === 'string' && x.includes(' ') && x.length > 8)) || `${str(s?.[0])} ${str(s?.[1])}`.trim(), meters: num(s?.[2]) }));
      return route(mode, decodePolyline(d.route_geometry), d.route_summary?.total_time, d.route_summary?.total_distance, steps);
    }
    case 'openrouteservice': {
      const d = await getJson(`https://api.openrouteservice.org/v2/directions/${{ drive: 'driving-car', walk: 'foot-walking', cycle: 'cycling-regular', transit: 'driving-car' }[mode]}/geojson`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: k.apiKey }, body: JSON.stringify({ coordinates: [[from.lng, from.lat], [to.lng, to.lat]], instructions: true, language: 'en' }) });
      const f = d?.features?.[0];
      if (!f) throw new NotFound();
      const steps = (f.properties?.segments ?? []).flatMap((s: any) => s.steps ?? []).map((s: any) => ({ text: str(s.instruction), meters: num(s.distance) }));
      return route(mode, f.geometry?.coordinates ?? [], f.properties?.summary?.duration, f.properties?.summary?.distance, steps);
    }
    case 'naver': {
      const d = await getJson(`https://maps.apigw.ntruss.com/map-direction/v1/driving?start=${LL(from)}&goal=${LL(to)}&option=trafast&lang=en`, { headers: naverHeaders(k) });
      if (num(d?.code) !== 0) { if ([1, 2, 3, 4, 5].includes(num(d?.code))) throw new NotFound(); throw said('down', str(d?.message) || 'Naver could not make a route.'); }
      const r = d?.route?.trafast?.[0];
      if (!r) throw new NotFound();
      return route(mode, r.path ?? [], num(r.summary?.duration) / 1000, r.summary?.distance, (r.guide ?? []).map((g: any) => ({ text: str(g.instructions), meters: num(g.distance) })));
    }
    case 'kakao': {
      const d = await getJson(`https://apis-navi.kakaomobility.com/v1/directions?origin=${LL(from)}&destination=${LL(to)}`, { headers: { authorization: `KakaoAK ${k.apiKey}` } });
      const r = d?.routes?.[0];
      if (!r || num(r.result_code) !== 0) throw new NotFound();
      const coords: [number, number][] = [], steps: MapStep[] = [];
      for (const s of r.sections ?? []) {
        for (const road of s.roads ?? []) { const v: number[] = road.vertexes ?? []; for (let i = 0; i + 1 < v.length; i += 2) coords.push([v[i]!, v[i + 1]!]); }
        for (const g of s.guides ?? []) steps.push({ text: str(g.guidance), meters: num(g.distance) });
      }
      return route(mode, coords, r.summary?.duration, r.summary?.distance, steps);
    }
    case 'amap': return amapRoute(k, from, to, mode);
    case 'baidu': {
      const [fl, fa] = wgsToGcj(from.lng, from.lat), [tl, ta] = wgsToGcj(to.lng, to.lat);
      const d = await getJson(`https://api.map.baidu.com/directionlite/v1/${{ drive: 'driving', walk: 'walking', cycle: 'riding', transit: 'transit' }[mode]}?origin=${fa.toFixed(6)},${fl.toFixed(6)}&destination=${ta.toFixed(6)},${tl.toFixed(6)}&coord_type=gcj02&ret_coordtype=gcj02&ak=${enc(k.apiKey)}`);
      baiduOk(d);
      const r = d?.result?.routes?.[0];
      if (!r) throw new NotFound();
      const raw: any[] = (r.steps ?? []).flat(2);
      const coords = raw.flatMap((s) => pathLL(s.path));
      return route(mode, coords.map(([x, y]) => gcjToWgs(x, y)), r.duration, r.distance, raw.map((s) => ({ text: str(s.instruction ?? s.instructions), meters: num(s.distance) })));
    }
    case 'here': {
      const d = await getJson(`https://router.hereapi.com/v8/routes?transportMode=${{ drive: 'car', walk: 'pedestrian', cycle: 'bicycle', transit: 'car' }[mode]}&origin=${from.lat},${from.lng}&destination=${to.lat},${to.lng}&return=polyline,summary,instructions,actions&lang=en&apiKey=${enc(k.apiKey)}`);
      const sec: any[] = d?.routes?.[0]?.sections ?? [];
      if (!sec.length) throw new NotFound();
      return route(mode, sec.flatMap((s) => decodeFlexible(String(s.polyline ?? ''))), sec.reduce((a, s) => a + num(s.summary?.duration), 0), sec.reduce((a, s) => a + num(s.summary?.length), 0), sec.flatMap((s) => (s.actions ?? []).map((a: any) => ({ text: str(a.instruction), meters: num(a.length) }))));
    }
    case 'tomtom': {
      const d = await getJson(`https://api.tomtom.com/routing/1/calculateRoute/${from.lat},${from.lng}:${to.lat},${to.lng}/json?travelMode=${{ drive: 'car', walk: 'pedestrian', cycle: 'bicycle', transit: 'car' }[mode]}&instructionsType=text&language=en-GB&key=${enc(k.apiKey)}`);
      const r = d?.routes?.[0];
      if (!r) throw new NotFound();
      const coords = (r.legs ?? []).flatMap((l: any) => (l.points ?? []).map((p: any) => [num(p.longitude), num(p.latitude)] as [number, number]));
      return route(mode, coords, r.summary?.travelTimeInSeconds, r.summary?.lengthInMeters, (r.guidance?.instructions ?? []).map((g: any) => ({ text: str(g.message) })));
    }
    case 'geoapify': {
      const d = await getJson(`https://api.geoapify.com/v1/routing?waypoints=${from.lat},${from.lng}|${to.lat},${to.lng}&mode=${{ drive: 'drive', walk: 'walk', cycle: 'bicycle', transit: 'drive' }[mode]}&lang=en&apiKey=${enc(k.apiKey)}`);
      const f = d?.features?.[0];
      if (!f) throw new NotFound();
      const g = f.geometry, coords: [number, number][] = g?.type === 'MultiLineString' ? (g.coordinates ?? []).flat() : g?.coordinates ?? [];
      return route(mode, coords, f.properties?.time, f.properties?.distance, (f.properties?.legs ?? []).flatMap((l: any) => l.steps ?? []).map((s: any) => ({ text: str(s.instruction?.text), meters: num(s.distance) })));
    }
    default: throw new BrainFail('no routes', 'refused', 0, 'It does not make routes.');
  }
}
const pathLL = (p: unknown): [number, number][] => String(p ?? '').split(';').map((x) => x.split(',').map(Number) as [number, number]).filter((x) => x.length === 2 && Number.isFinite(x[0]) && Number.isFinite(x[1]));
/** Turns in a row with no words are dropped, and the same instruction twice becomes one. */
const merge = (steps: MapStep[]) => steps.filter((s, i) => s.text && s.text !== steps[i - 1]?.text);
function osrmText(s: any): string {
  const m = s?.maneuver ?? {}, name = str(s?.name, 80), mod = str(m.modifier, 20), onto = name ? ` onto ${name}` : '';
  switch (m.type) {
    case 'depart': return name ? `Head along ${name}` : 'Set off';
    case 'arrive': return 'Arrive at your destination';
    case 'roundabout': case 'rotary': return `At the roundabout, take exit ${num(m.exit) || 1}${onto}`;
    case 'merge': return `Merge${onto}`;
    case 'fork': return `Keep ${mod || 'ahead'}${onto}`;
    case 'end of road': case 'turn': case 'new name': case 'continue': default: return mod === 'straight' || !mod ? `Continue${onto}` : `Turn ${mod}${onto}`;
  }
}
async function amapRoute(k: MapKey, from: MapPlace, to: MapPlace, mode: MapMode): Promise<MapRoute> {
  const [fl, fa] = wgsToGcj(from.lng, from.lat), [tl, ta] = wgsToGcj(to.lng, to.lat);
  const o = `${fl.toFixed(6)},${fa.toFixed(6)}`, dst = `${tl.toFixed(6)},${ta.toFixed(6)}`, key = enc(k.apiKey);
  const back = (c: [number, number][]) => c.map(([x, y]) => gcjToWgs(x, y));
  if (mode === 'transit') {
    // Amap's public transport routes need each end's city code.
    const city = async (p: string) => { const r = await getJson(`https://restapi.amap.com/v3/geocode/regeo?key=${key}&location=${p}`); amapOk(r); return String(r?.regeocode?.addressComponent?.citycode ?? ''); };
    const [c1, c2] = await Promise.all([city(o), city(dst)]);
    const d = await getJson(`https://restapi.amap.com/v5/direction/transit/integrated?key=${key}&origin=${o}&destination=${dst}&city1=${enc(c1)}&city2=${enc(c2)}&show_fields=cost,polyline&AlternativeRoute=1`);
    amapOk(d);
    const t = d?.route?.transits?.[0];
    if (!t) throw new NotFound();
    const coords: [number, number][] = [], steps: MapStep[] = [];
    for (const s of t.segments ?? []) {
      for (const w of s.walking?.steps ?? []) { coords.push(...pathLL(w.polyline?.polyline ?? w.polyline)); }
      if (s.walking?.distance) steps.push({ text: `Walk ${Math.round(num(s.walking.distance))} m`, meters: num(s.walking.distance) });
      const b = s.bus?.buslines?.[0];
      if (b) { coords.push(...pathLL(b.polyline?.polyline ?? b.polyline)); steps.push({ text: `Take ${str(b.name, 60)} to ${str(b.arrival_stop?.name, 60)}`, meters: num(b.distance) }); }
    }
    return route(mode, back(coords), t.cost?.duration, t.distance, steps);
  }
  const path = { drive: 'driving', walk: 'walking', cycle: 'bicycling' }[mode];
  const d = await getJson(`https://restapi.amap.com/v5/direction/${path}?key=${key}&origin=${o}&destination=${dst}&show_fields=cost,polyline`);
  amapOk(d);
  const p = d?.route?.paths?.[0];
  if (!p) throw new NotFound();
  const steps: any[] = p.steps ?? [];
  return route(mode, back(steps.flatMap((s) => pathLL(s.polyline))), p.cost?.duration ?? p.duration, p.distance, steps.map((s) => ({ text: str(s.instruction), meters: num(s.step_distance) })));
}

// ---------------------------------------------------------------- in order, with rests
export interface MapAsk { to: string; from?: string; mode: MapMode | 'place'; here: Near; country: 'auto' | 'ww' | string }
type Entry = { entry: MapSource; provider: MapProvider | 'osm'; label: string; key?: MapKey };

export async function findRoute(env: Env, db: Db, user: { id: string; engine: unknown }, ask: MapAsk, off: readonly string[] = []): Promise<MapResult> {
  if (!mapsOn(off)) throw new BrainFail('not on account', 'refused', 0, 'Maps aren’t available on your account.');
  const engine = (user.engine ?? {}) as EnginePrefs;
  const keys = await loadMapKeys(env, db, user.id);
  const t0 = Date.now();

  // Which country's list: the one they said, else where they are (if they allowed their location), else none.
  let country: string | null = null, how: MapResult['country']['how'] = 'none';
  if (ask.country !== 'auto' && ask.country !== 'ww' && /^[A-Z]{2}$/.test(ask.country)) { country = ask.country; how = 'said'; }
  else if (ask.country === 'auto' && ask.here) { country = await countryOf(ask.here.lng, ask.here.lat); how = country ? 'gps' : 'none'; }
  const lists = mapCountryLists(engine), listed = !!(country && lists[country]);

  const now = Date.now(), rest: Record<string, BrainRest> = {};
  for (const [k, v] of Object.entries(engine.mapRest ?? {})) if (v && v.until > now) rest[k] = v;
  let changed = Object.keys(rest).length !== Object.keys(engine.mapRest ?? {}).length;
  const skipped = new Set<string>();

  const entries = (cc: string | null): Entry[] => mapChain(engine, cc && lists[cc] ? cc : null).chain.flatMap((entry): Entry[] => {
    if (entry === 'osm') return aiAllowed(off, 'map:osm') ? [{ entry, provider: 'osm', label: 'OpenStreetMap' }] : [];
    const key = keys.find((k) => `mkey:${k.id}` === entry);
    if (!key || !aiAllowed(off, mapOption(entry, key))) return [];
    return [{ entry, provider: key.provider, label: key.label || mapPreset(key.provider)!.name, key }];
  });
  const ordered = (list: Entry[]) => [...list.filter((e) => !rest[e.entry]), ...list.filter((e) => rest[e.entry]).sort((a, b) => rest[a.entry]!.until - rest[b.entry]!.until)];
  const failed = (e: Entry, err: unknown) => {
    const f = err instanceof BrainFail ? err : new BrainFail(String((err as Error)?.message ?? err).slice(0, 200), 'down', MIN);
    console.warn(`map ${e.provider} failed (${f.why}): ${f.message.slice(0, 120)}`);
    if (f.restMs > 0) { rest[e.entry] = { until: Date.now() + f.restMs, why: f.why }; changed = true; }
  };
  const worked = (e: Entry) => { if (rest[e.entry]) { delete rest[e.entry]; changed = true; } };

  if (!entries(null).length && !Object.keys(lists).some((cc) => entries(cc).length)) throw new BrainFail('no services', 'refused', 0, 'No map service is set up yet. Add one on the Engine screen.');
  try {
    // 1. The place (and the start, when they named one), from the first service that finds it.
    const placeList = ordered(entries(country)).filter((e) => {
      const why = mapSkipped(e.provider, country, 'place');
      if (why) { skipped.add(`${e.label}: ${why}`); return false; }
      return e.provider === 'osm' || mapPreset(e.provider)!.places;
    });
    const near = ask.here;
    const find = async (q: string, around: Near): Promise<{ p: MapPlace; e: Entry } | null> => {
      for (const e of placeList) {
        try { const p = e.provider === 'osm' ? await osmFind(q, around) : await findWith(e.key!, q, around); worked(e); return { p, e }; }
        catch (err) { if (err instanceof NotFound) continue; failed(e, err); }
      }
      return null;
    };
    const found = await find(ask.to, near);
    if (!found) throw new NotFound();
    const to = found.p;
    let from: MapPlace | undefined;
    if (ask.from) { const f = await find(ask.from, near ?? { lat: to.lat, lng: to.lng }); if (f) from = f.p; }
    else if (near) from = { name: 'You', lat: near.lat, lng: near.lng };
    let source = found.e;

    // 2. The route: a trip that stays in one country uses that country's list; one that crosses a border, Everywhere.
    const toCc = await countryOf(to.lng, to.lat), fromCc = from ? await countryOf(from.lng, from.lat) : null;
    const tripCc = from && fromCc !== toCc ? null : toCc ?? country;
    let r: MapRoute | undefined, noRoute: string | undefined;
    if (ask.mode !== 'place') {
      if (!from) noRoute = 'Allow your location, or say where you are starting from, to see a route.';
      else {
        const mode = ask.mode;
        const routeList = ordered(entries(tripCc)).filter((e) => {
          if (e.provider === 'osm') return false;
          const why = mapSkipped(e.provider, tripCc ?? toCc, mode) ?? (fromCc && fromCc !== toCc ? mapSkipped(e.provider, fromCc, mode) : null);
          if (why) { skipped.add(`${e.label}: ${why}`); return false; }
          return mapPreset(e.provider)!.routes.includes(mode);
        });
        for (const e of routeList) {
          try { r = await routeWith(e.key!, from, to, mode); worked(e); source = e; break; }
          catch (err) { if (err instanceof NotFound) continue; failed(e, err); }
        }
        if (!r) noRoute = routeList.length ? `No ${mode === 'transit' ? 'public transport' : mode === 'drive' ? 'driving' : mode === 'walk' ? 'walking' : 'cycling'} route was found just now.` : `None of your map services makes ${{ drive: 'driving', transit: 'public transport', walk: 'walking', cycle: 'cycling' }[mode]} routes here. Open it in an app below.`;
      }
    }
    const handoffCc = toCc ?? country;
    const chain = entries(tripCc ?? country).map((e) => e.label);
    const credit = source.provider === 'osm' ? '© OpenStreetMap contributors' : `© ${mapPreset(source.provider)?.name.replace(/ \(.*\)$/, '') ?? source.label}${handoffCc === 'CN' ? '' : ' · © OpenStreetMap contributors'}`;
    return {
      to, ...(from ? { from } : {}), mode: ask.mode, ...(r ? { route: r } : {}), ...(noRoute ? { noRoute } : {}),
      source: { id: source.entry, label: source.label, ms: Date.now() - t0 },
      country: { code: country, name: countryName(country), how, listed },
      chain: [...new Set(chain)], skipped: [...skipped].slice(0, 6), handoff: mapHandoff(handoffCc, to, ask.mode), credit,
    };
  } finally {
    if (changed) await db.update(users).set({ engine: { ...engine, mapRest: rest } as any }).where(eq(users.id, user.id)).catch(() => undefined);
  }
}

/** Test on the Engine screen: one search (or, for a route server, one route) with this key alone. */
export async function testMapKey(k: MapKey): Promise<string> {
  const sample: Partial<Record<MapProvider, [string, number, number]>> = { onemap: ['Changi Airport', 1.3644, 103.9915], naver: ['서울특별시 중구 세종대로 110', 37.5665, 126.978], kakao: ['서울역', 37.5547, 126.9707], amap: ['天安门', 39.9087, 116.3975], baidu: ['天安门', 39.9087, 116.3975] };
  const [q, lat, lng] = sample[k.provider] ?? ['Eiffel Tower', 48.8584, 2.2945];
  if (k.provider === 'self-hosted') {
    try { await routeWith(k, { name: 'a', lat, lng }, { name: 'b', lat: lat + 0.01, lng: lng + 0.01 }, 'drive'); } catch (e) { if (!(e instanceof NotFound)) throw e; }
    return 'Your route server answered.';
  }
  const p = await findWith(k, q, { lat, lng }).catch((e) => { if (e instanceof NotFound) throw new BrainFail('nothing', 'down', 0, 'It answered, but found nothing for a test search.'); throw e; });
  return `It found ${p.name}.`;
}
