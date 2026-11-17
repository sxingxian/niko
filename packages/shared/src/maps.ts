// ---------------------------------------------------------------- maps
// Niko pulls up a map when asked the way or to see a place. Map services work like brains and voices: an ordered list,
// and when one reaches its limit or can't be reached, the next is used. On top of the Everywhere list, a country can
// have its own list (South Korea: Naver, Kakao; China: Amap, Baidu; Singapore: OneMap). Which country applies comes
// from the person's location (GPS, if they allow it) or from what they say; a country without a list uses Everywhere.
//
// The map picture itself is drawn in the browser from OpenFreeMap (OpenStreetMap data, no key). Places and routes come
// from the chosen service, through Niko's server, so keys never reach the browser.

export type MapMode = 'drive' | 'transit' | 'walk' | 'cycle';
export const MAP_MODES: MapMode[] = ['drive', 'transit', 'walk', 'cycle'];
export const MAP_MODE_NAMES: Record<MapMode, string> = { drive: 'Drive', transit: 'Transit', walk: 'Walk', cycle: 'Cycle' };
/** What a map can be asked for: a way of travelling, just the place, or a flight (a great-circle line between two places). */
export type MapAskMode = MapMode | 'place' | 'fly';

export type MapProvider = 'google' | 'mapbox' | 'onemap' | 'openrouteservice' | 'naver' | 'kakao' | 'amap' | 'baidu' | 'here' | 'tomtom' | 'geoapify' | 'maptiler' | 'self-hosted';
export interface MapField { key: 'apiKey' | 'secret' | 'email' | 'password' | 'baseUrl'; label: string; secret?: boolean; optional?: boolean; placeholder?: string }
export interface MapPreset {
  id: MapProvider; name: string; note: string; fields: MapField[];
  /** What it can do: find places, and which ways of travelling it can route. */
  places: boolean; routes: MapMode[];
  /** Where it works. Missing: everywhere (except where a country's rules skip it). */
  only?: string[];
  /** The country list a new key goes into. Missing: the Everywhere list. */
  home?: string;
}
const KEY: MapField = { key: 'apiKey', label: 'API key', secret: true };
export const MAP_PROVIDERS: MapPreset[] = [
  { id: 'google', name: 'Google Maps Platform', note: 'Places and Routes APIs, with traffic-aware times and public transport. Keys from console.cloud.google.com (enable Places API (New) and Routes API).', fields: [KEY], places: true, routes: ['drive', 'transit', 'walk', 'cycle'] },
  { id: 'mapbox', name: 'Mapbox', note: 'Search and directions for driving, walking and cycling. Access tokens from account.mapbox.com.', fields: [{ ...KEY, label: 'Access token' }], places: true, routes: ['drive', 'walk', 'cycle'] },
  { id: 'onemap', name: 'OneMap (Singapore)', note: 'The Singapore Land Authority’s map: addresses, buses and MRT. A free account from onemap.gov.sg; Niko renews its token by itself.', fields: [{ key: 'email', label: 'OneMap account email' }, { key: 'password', label: 'OneMap account password', secret: true }], places: true, routes: ['drive', 'transit', 'walk', 'cycle'], only: ['SG'], home: 'SG' },
  { id: 'openrouteservice', name: 'OpenRouteService', note: 'Free key for driving, walking and cycling routes and place search. Keys from openrouteservice.org.', fields: [KEY], places: true, routes: ['drive', 'walk', 'cycle'] },
  { id: 'naver', name: 'Naver Maps (Korea)', note: 'Korean addresses and driving routes. An application on NAVER Cloud Platform gives a client ID and client secret.', fields: [{ key: 'apiKey', label: 'Client ID' }, { key: 'secret', label: 'Client secret', secret: true }], places: true, routes: ['drive'], only: ['KR'], home: 'KR' },
  { id: 'kakao', name: 'Kakao Map (Korea)', note: 'Place search across Korea and driving routes (Kakao Mobility). A REST API key from developers.kakao.com.', fields: [{ ...KEY, label: 'REST API key' }], places: true, routes: ['drive'], only: ['KR'], home: 'KR' },
  { id: 'amap', name: 'Amap (China)', note: 'Gaode Maps: places and routes in mainland China, including public transport. A Web Service key from lbs.amap.com (needs a Chinese phone number).', fields: [{ ...KEY, label: 'Web Service key' }], places: true, routes: ['drive', 'transit', 'walk', 'cycle'], only: ['CN'], home: 'CN' },
  { id: 'baidu', name: 'Baidu Maps (China)', note: 'Places and routes in mainland China. A server key (AK) from lbsyun.baidu.com.', fields: [{ ...KEY, label: 'Server key (AK)' }], places: true, routes: ['drive', 'transit', 'walk', 'cycle'], only: ['CN'], home: 'CN' },
  { id: 'here', name: 'HERE', note: 'Search and routing for driving, walking and cycling. Keys from platform.here.com.', fields: [KEY], places: true, routes: ['drive', 'walk', 'cycle'] },
  { id: 'tomtom', name: 'TomTom', note: 'Search and routing with live traffic. Keys from developer.tomtom.com.', fields: [KEY], places: true, routes: ['drive', 'walk', 'cycle'] },
  { id: 'geoapify', name: 'Geoapify', note: 'Search and routing on OpenStreetMap data, with a free daily allowance. Keys from myprojects.geoapify.com.', fields: [KEY], places: true, routes: ['drive', 'walk', 'cycle'] },
  { id: 'maptiler', name: 'MapTiler', note: 'Place search. Keys from cloud.maptiler.com.', fields: [KEY], places: true, routes: [] },
  { id: 'self-hosted', name: 'Your own route server', note: 'An OSRM server you run, at a public https address, for driving, walking and cycling.', fields: [{ key: 'baseUrl', label: 'Server address', placeholder: 'https://osrm.example.com' }, { key: 'apiKey', label: 'Key (if your server needs one)', secret: true, optional: true }], places: false, routes: ['drive', 'walk', 'cycle'] },
];
export const mapPreset = (p: string) => MAP_PROVIDERS.find((x) => x.id === p);

/** The built-in map: OpenStreetMap data (map from OpenFreeMap, places from Photon). No key; no routes of its own. */
export const MAP_BUILTIN = 'osm';
export type MapSource = 'osm' | `mkey:${string}`;
export const MAP_ENTRY = /^(osm|mkey:[a-z0-9]{1,16})$/;
export const MAX_MAP_KEYS = 12;
export const MAX_MAP_COUNTRIES = 20;
export interface MapKeyInfo { id: string; label: string; provider: MapProvider; baseUrl: string; email: string }

/** The Everywhere list: the built-in map alone until the user adds services. */
export function mapOrder(e: { maps?: unknown } | undefined): MapSource[] {
  const list = Array.isArray(e?.maps) ? [...new Set((e!.maps as unknown[]).map(String).filter((v) => MAP_ENTRY.test(v)))] as MapSource[] : [];
  return list.length ? list : ['osm'];
}
const CC = /^[A-Z]{2}$/;
/** The countries with their own lists. */
export function mapCountryLists(e: { mapCountries?: unknown } | undefined): Record<string, MapSource[]> {
  const out: Record<string, MapSource[]> = {};
  const v = e?.mapCountries;
  if (v && typeof v === 'object') for (const [cc, list] of Object.entries(v as Record<string, unknown>).slice(0, MAX_MAP_COUNTRIES)) {
    if (!CC.test(cc) || !Array.isArray(list)) continue;
    const l = [...new Set(list.map(String).filter((x) => MAP_ENTRY.test(x)))] as MapSource[];
    if (l.length) out[cc] = l.slice(0, MAX_MAP_KEYS + 1);
  }
  return out;
}

/**
 * Whether a service is skipped in a country for a way of travelling. Built in, because these are facts about the
 * services, not choices: Google has no driving, walking or cycling routes in South Korea; in mainland China maps use
 * their own coordinates (GCJ-02), so only Chinese services are used for places and routes; Korean, Chinese and
 * Singapore-only services don't cover other countries.
 */
export function mapSkipped(provider: MapProvider | 'osm', country: string | null, mode: MapAskMode): string | null {
  const p = provider === 'osm' ? null : mapPreset(provider);
  if (p?.only && (!country || !p.only.includes(country))) return `${p.name} only covers ${p.only.join(', ')}`;
  // OpenStreetMap data (the built-in search, and a route server the person runs) lines up with the map as it is.
  if (country === 'CN' && !['amap', 'baidu', 'osm', 'self-hosted'].includes(provider)) return 'their maps are offset in China';
  if (country === 'KR' && provider === 'google' && mode !== 'place' && mode !== 'transit') return 'Google has no driving, walking or cycling routes in South Korea';
  return null;
}

/** The services to try for a request, in order: the country's list (when it has one), then Everywhere. */
export function mapChain(e: { maps?: unknown; mapCountries?: unknown } | undefined, country: string | null): { chain: MapSource[]; listed: boolean } {
  const lists = mapCountryLists(e), own = country ? lists[country] : undefined;
  // The built-in map always comes last, so a place can be shown even when every service is resting.
  const all = [...(own ?? []), ...mapOrder(e), 'osm' as MapSource];
  return { chain: [...new Set(all)], listed: !!own };
}

// ---------------------------------------------------------------- China's coordinates
// Chinese services work in GCJ-02 (Baidu in BD-09). The map picture uses WGS-84, so their places and routes are moved
// back before they are drawn, and the person's position is moved into their system before it is sent to them.
const A = 6378245.0, EE = 0.00669342162296594323;
const outOfChina = (lng: number, lat: number) => lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271;
function tLat(x: number, y: number) { let r = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x)); r += ((20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2) / 3; r += ((20 * Math.sin(y * Math.PI) + 40 * Math.sin((y / 3) * Math.PI)) * 2) / 3; r += ((160 * Math.sin((y / 12) * Math.PI) + 320 * Math.sin((y * Math.PI) / 30)) * 2) / 3; return r; }
function tLng(x: number, y: number) { let r = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x)); r += ((20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2) / 3; r += ((20 * Math.sin(x * Math.PI) + 40 * Math.sin((x / 3) * Math.PI)) * 2) / 3; r += ((150 * Math.sin((x / 12) * Math.PI) + 300 * Math.sin((x / 30) * Math.PI)) * 2) / 3; return r; }
export function wgsToGcj(lng: number, lat: number): [number, number] {
  if (outOfChina(lng, lat)) return [lng, lat];
  let dLat = tLat(lng - 105, lat - 35), dLng = tLng(lng - 105, lat - 35);
  const rad = (lat / 180) * Math.PI; let m = Math.sin(rad); m = 1 - EE * m * m; const s = Math.sqrt(m);
  dLat = (dLat * 180) / (((A * (1 - EE)) / (m * s)) * Math.PI); dLng = (dLng * 180) / ((A / s) * Math.cos(rad) * Math.PI);
  return [lng + dLng, lat + dLat];
}
/** Back from GCJ-02 to WGS-84 (to within a metre or two, by repeating the forward step). */
export function gcjToWgs(lng: number, lat: number): [number, number] {
  if (outOfChina(lng, lat)) return [lng, lat];
  let x = lng, y = lat;
  for (let i = 0; i < 4; i++) { const [gx, gy] = wgsToGcj(x, y); x -= gx - lng; y -= gy - lat; }
  return [x, y];
}
const XPI = (Math.PI * 3000) / 180;
export function bdToGcj(lng: number, lat: number): [number, number] { const x = lng - 0.0065, y = lat - 0.006, z = Math.sqrt(x * x + y * y) - 0.00002 * Math.sin(y * XPI), t = Math.atan2(y, x) - 0.000003 * Math.cos(x * XPI); return [z * Math.cos(t), z * Math.sin(t)]; }
export function gcjToBd(lng: number, lat: number): [number, number] { const z = Math.sqrt(lng * lng + lat * lat) + 0.00002 * Math.sin(lat * XPI), t = Math.atan2(lat, lng) + 0.000003 * Math.cos(lng * XPI); return [z * Math.cos(t) + 0.0065, z * Math.sin(t) + 0.006]; }

// ---------------------------------------------------------------- what the map card shows
export interface MapPlace { name: string; address?: string; lat: number; lng: number }
export interface MapStep { text: string; meters?: number }
export interface MapRoute { mode: MapMode | 'fly'; coords: [number, number][]; seconds: number; meters: number; steps: MapStep[] }
export interface MapResult {
  to: MapPlace; from?: MapPlace; mode: MapAskMode; route?: MapRoute;
  /** Why there is no route (no service that routes this way here), when there isn't one. */
  noRoute?: string;
  source: { id: string; label: string; ms: number };
  /** Which country's list was used, and why. how: 'gps' (from the location), 'said' (they said it), 'none'. */
  country: { code: string | null; name: string | null; how: 'gps' | 'said' | 'none'; listed: boolean };
  chain: string[]; skipped: string[];
  /** Apps to start the trip in, for where it is. */
  handoff: { app: string; url: string }[];
  credit: string;
}

/** Links that open the trip in the app people use there. */
export function mapHandoff(country: string | null, to: MapPlace, mode: MapAskMode, from?: MapPlace): { app: string; url: string }[] {
  if (mode === 'fly') {
    const q = from && from.name !== 'You' ? `Flights from ${from.name} to ${to.name}` : `Flights to ${to.name}`;
    return [{ app: 'Google Flights', url: `https://www.google.com/travel/flights?q=${encodeURIComponent(q)}` }, { app: 'Google Maps', url: `https://www.google.com/maps/search/?api=1&query=${to.lat.toFixed(6)},${to.lng.toFixed(6)}` }];
  }
  const ll = `${to.lat.toFixed(6)},${to.lng.toFixed(6)}`, name = encodeURIComponent(to.name);
  const gmode = { drive: 'driving', transit: 'transit', walk: 'walking', cycle: 'bicycling', place: 'driving' }[mode];
  const google = { app: 'Google Maps', url: mode === 'place' ? `https://www.google.com/maps/search/?api=1&query=${ll}` : `https://www.google.com/maps/dir/?api=1&destination=${ll}&travelmode=${gmode}` };
  const apple = { app: 'Apple Maps', url: `https://maps.apple.com/?${mode === 'place' ? 'q' : 'daddr'}=${ll}${mode === 'place' ? '' : `&dirflg=${{ drive: 'd', transit: 'r', walk: 'w', cycle: 'w', place: 'd' }[mode]}`}` };
  if (country === 'KR') return [{ app: 'Naver Map', url: `https://map.naver.com/p/search/${name}` }, { app: 'KakaoMap', url: `https://map.kakao.com/link/to/${name},${ll}` }];
  if (country === 'CN') { const [gl, ga] = wgsToGcj(to.lng, to.lat); return [{ app: 'Amap', url: `https://uri.amap.com/${mode === 'place' ? 'marker?position' : 'navigation?to'}=${gl.toFixed(6)},${ga.toFixed(6)},${name}&coordinate=gaode${mode === 'place' ? '' : `&mode=${{ drive: 'car', transit: 'bus', walk: 'walk', cycle: 'ride', place: 'car' }[mode]}`}` }, apple]; }
  return [google, apple];
}
export const minutesText = (s: number) => { const m = Math.max(1, Math.round(s / 60)); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`; };
export const distanceText = (m: number) => (m < 950 ? `${Math.round(m / 10) * 10} m` : m < 9500 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m / 1000).toLocaleString('en')} km`);

// ---------------------------------------------------------------- flights
/** The great-circle line between two places, as [lng, lat] points that never jump across the 180° meridian. */
export function greatCircle(a: { lat: number; lng: number }, b: { lat: number; lng: number }, n = 128): [number, number][] {
  const r = Math.PI / 180, toV = (p: { lat: number; lng: number }) => [Math.cos(p.lat * r) * Math.cos(p.lng * r), Math.cos(p.lat * r) * Math.sin(p.lng * r), Math.sin(p.lat * r)];
  const A = toV(a), B = toV(b);
  const d = Math.acos(Math.min(1, Math.max(-1, A[0]! * B[0]! + A[1]! * B[1]! + A[2]! * B[2]!)));
  if (d < 1e-9) return [[a.lng, a.lat], [b.lng, b.lat]];
  const out: [number, number][] = [];
  let prev = a.lng;
  for (let i = 0; i <= n; i++) {
    const t = i / n, s1 = Math.sin((1 - t) * d) / Math.sin(d), s2 = Math.sin(t * d) / Math.sin(d);
    const x = s1 * A[0]! + s2 * B[0]!, y = s1 * A[1]! + s2 * B[1]!, z = s1 * A[2]! + s2 * B[2]!;
    const lat = Math.atan2(z, Math.sqrt(x * x + y * y)) / r;
    let lng = Math.atan2(y, x) / r;
    while (lng - prev > 180) lng -= 360;
    while (lng - prev < -180) lng += 360;
    prev = lng;
    out.push([lng, lat]);
  }
  return out;
}
/** The distance along the surface, in metres. */
export function greatCircleMeters(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const r = Math.PI / 180, dLat = (b.lat - a.lat) * r, dLng = (b.lng - a.lng) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371_008.8 * Math.asin(Math.min(1, Math.sqrt(h)));
}
/** A rough flying time: about 830 km/h in the air, plus half an hour for take-off, climb and landing. An estimate only. */
export const flightSeconds = (meters: number) => Math.round((meters / 1000 / 830) * 3600 + 30 * 60);

// ---------------------------------------------------------------- a place named by its country
const COUNTRY_ALIASES: Record<string, string> = {
  usa: 'US', 'u.s.': 'US', 'u.s.a.': 'US', us: 'US', america: 'US', 'united states of america': 'US', uk: 'GB', 'u.k.': 'GB', britain: 'GB', 'great britain': 'GB', england: 'GB', scotland: 'GB', wales: 'GB',
  korea: 'KR', 'south korea': 'KR', 'republic of korea': 'KR', 'north korea': 'KP', holland: 'NL', 'the netherlands': 'NL', uae: 'AE', 'the uae': 'AE', emirates: 'AE', 'hong kong': 'HK', macau: 'MO', macao: 'MO',
  taiwan: 'TW', 'mainland china': 'CN', prc: 'CN', russia: 'RU', vietnam: 'VN', 'viet nam': 'VN', laos: 'LA', burma: 'MM', 'czech republic': 'CZ', czechia: 'CZ', turkey: 'TR', 'türkiye': 'TR', 'ivory coast': 'CI', 'the philippines': 'PH',
};
let countryNames: Map<string, string> | null = null;
function countryTable(): Map<string, string> {
  if (countryNames) return countryNames;
  countryNames = new Map(Object.entries(COUNTRY_ALIASES));
  try {
    const dn = new Intl.DisplayNames(['en'], { type: 'region' });
    const A = 65;
    for (let i = 0; i < 26; i++) for (let j = 0; j < 26; j++) {
      const cc = String.fromCharCode(A + i, A + j), name = dn.of(cc);
      if (name && name !== cc && !/unknown/i.test(name)) countryNames.set(name.toLowerCase(), cc);
    }
  } catch { /* no Intl region names: the aliases still work */ }
  return countryNames;
}
/** The country a place is named by: the whole of it ("Japan"), or its last part ("Tokyo, Japan", "Osaka Japan").
 * A place in one country is then never looked up with a service that covers only another country. */
export function countryNamed(q: string): string | null {
  const t = q.toLowerCase().replace(/[()]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t) return null;
  const table = countryTable();
  if (table.has(t)) return table.get(t)!;
  const last = t.includes(',') ? t.slice(t.lastIndexOf(',') + 1).trim() : '';
  if (last && table.has(last)) return table.get(last)!;
  // "Osaka Japan": the last one to three words.
  const w = t.split(' ');
  for (let k = Math.min(3, w.length - 1); k >= 1; k--) { const tail = w.slice(-k).join(' '); if (table.has(tail) && tail.length > 3) return table.get(tail)!; }
  return null;
}
/** Only the country itself ("Japan", not "Tokyo, Japan"). */
export const isCountryName = (q: string) => countryTable().has(q.toLowerCase().replace(/\s+/g, ' ').trim());
