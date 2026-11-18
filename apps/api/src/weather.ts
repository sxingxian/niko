// Weather from Open-Meteo (free, no key; data CC BY 4.0, credited on the Connections screen). Forecasts are turned
// into a short plain-text summary that goes into Niko's prompt. Places are looked up by name with Open-Meteo's
// geocoding. Answers are cached briefly; coordinates are rounded to about 1 km before use and never stored.

import type { WeatherCard, WeatherIcon } from '@niko/shared';

export interface Place { lat: number; lon: number; name: string }

// The admin's Open-Meteo paid plan key (one for the whole of Niko). With it, Niko uses Open-Meteo's customer API, as
// its terms ask of a paid service; without it, the free API.
let omKey: string | null = null;
export const setOpenMeteoKey = (k: string | null) => { omKey = k; };
const om = (host: 'api' | 'geocoding-api', path: string) => `https://${omKey ? `customer-${host}` : host}.open-meteo.com${path}${omKey ? `&apikey=${encodeURIComponent(omKey)}` : ''}`;

const WMO: Record<number, string> = {
  0: 'clear sky', 1: 'mainly clear', 2: 'partly cloudy', 3: 'overcast', 45: 'fog', 48: 'freezing fog',
  51: 'light drizzle', 53: 'drizzle', 55: 'heavy drizzle', 56: 'light freezing drizzle', 57: 'freezing drizzle',
  61: 'light rain', 63: 'rain', 65: 'heavy rain', 66: 'light freezing rain', 67: 'freezing rain',
  71: 'light snow', 73: 'snow', 75: 'heavy snow', 77: 'snow grains', 80: 'light showers', 81: 'showers', 82: 'heavy showers',
  85: 'light snow showers', 86: 'snow showers', 95: 'thunderstorms', 96: 'thunderstorms with hail', 99: 'severe thunderstorms with hail',
};
const sky = (code: unknown) => WMO[Number(code)] ?? 'unsettled';
const round2 = (v: number) => Math.round(v * 100) / 100;

/** A coordinate pair from the browser, checked and rounded; anything else is ignored. */
export function cleanWhere(w: unknown): { lat: number; lon: number } | null {
  const o = w as { lat?: unknown; lon?: unknown } | null;
  const lat = Number(o?.lat), lon = Number(o?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat: round2(lat), lon: round2(lon) };
}

async function cached<T>(key: string, ttlS: number, load: () => Promise<T>): Promise<T> {
  const id = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key))), (b) => b.toString(16).padStart(2, '0')).join('');
  const req = new Request(`https://niko-cache.invalid/weather/${id}`);
  const cache = (globalThis as any).caches?.default as Cache | undefined;
  const hit = await cache?.match(req).catch(() => undefined);
  if (hit) return hit.json() as Promise<T>;
  const value = await load();
  await cache?.put(req, new Response(JSON.stringify(value), { headers: { 'cache-control': `max-age=${ttlS}` } })).catch(() => undefined);
  return value;
}

async function getJson(url: string): Promise<any> {
  const res = await fetch(url, { signal: AbortSignal.timeout(8000), headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`weather service answered ${res.status}`); // never the address: it can hold the key
  return res.json();
}

/** Finds a place by name, such as "Tokyo" or "Paris, France". Null when nothing matches. */
export async function geocode(query: string): Promise<Place | null> {
  const q = query.replace(/[^\p{L}\p{N} ,.'’-]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
  if (q.length < 2) return null;
  return cached(`geo:${q.toLowerCase()}`, 7 * 86400, async () => {
    // The geocoder matches one name, so "Paris, France" is looked up as "Paris" and the rest picks between results.
    const [name, ...rest] = q.split(',').map((s) => s.trim()).filter(Boolean);
    const j = await getJson(om('geocoding-api', `/v1/search?name=${encodeURIComponent(name!)}&count=10&language=en&format=json`));
    const list: any[] = Array.isArray(j?.results) ? j.results : [];
    const hint = rest.join(' ').toLowerCase();
    const r = (hint && list.find((x) => [x.country, x.country_code, x.admin1].some((v) => v && String(v).toLowerCase().includes(hint)))) || list[0];
    if (!r || !Number.isFinite(r.latitude) || !Number.isFinite(r.longitude)) return null;
    const label = [r.name, r.admin1 && r.admin1 !== r.name ? r.admin1 : '', r.country].filter(Boolean).join(', ');
    return { lat: round2(r.latitude), lon: round2(r.longitude), name: label };
  });
}

/** Open-Meteo's forecast for one place (cached for 15 minutes). */
async function forecast(place: Place, units: 'C' | 'F'): Promise<any> {
  const f = units === 'F';
  const params = new URLSearchParams({
    latitude: String(round2(place.lat)), longitude: String(round2(place.lon)), timezone: 'auto', forecast_days: '7',
    current: 'temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,wind_speed_10m',
    hourly: 'temperature_2m,precipitation_probability,weather_code',
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum,uv_index_max,sunrise,sunset',
    ...(f ? { temperature_unit: 'fahrenheit', wind_speed_unit: 'mph', precipitation_unit: 'inch' } : {}),
  });
  return cached(`fc:${params}`, 15 * 60, () => getJson(om('api', `/v1/forecast?${params}`)));
}

/** The forecast for one place as a short summary: now, the next 24 hours, and 7 days. */
export async function forecastText(place: Place, units: 'C' | 'F' = 'C'): Promise<string> {
  const f = units === 'F';
  const j = await forecast(place, units);
  const deg = f ? '°F' : '°C', wind = f ? 'mph' : 'km/h', rainU = f ? 'in' : 'mm';
  const n = (v: unknown) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : '?');
  const c = j?.current ?? {};
  const now = String(c.time ?? '');
  const lines = [
    `Place: ${place.name} (local time ${now.replace('T', ' ')}, ${j?.timezone ?? 'local'})`,
    `Now: ${n(c.temperature_2m)}${deg}, feels like ${n(c.apparent_temperature)}${deg}, ${sky(c.weather_code)}, humidity ${n(c.relative_humidity_2m)}%, wind ${n(c.wind_speed_10m)} ${wind}${Number(c.precipitation) > 0 ? `, ${c.precipitation} ${rainU} falling` : ''}.`,
  ];
  const h = j?.hourly ?? {};
  const times: string[] = Array.isArray(h.time) ? h.time : [];
  const start = Math.max(0, times.findIndex((t) => t >= now.slice(0, 13)));
  const next: string[] = [];
  for (let i = start + 1; i < Math.min(times.length, start + 25); i += 3) {
    next.push(`${times[i]!.slice(11, 16)} ${n(h.temperature_2m?.[i])}${deg} ${sky(h.weather_code?.[i])}, ${n(h.precipitation_probability?.[i])}% chance of rain`);
  }
  if (next.length) lines.push(`Next 24 hours: ${next.join('; ')}.`);
  const d = j?.daily ?? {};
  const days: string[] = Array.isArray(d.time) ? d.time : [];
  const dayName = (iso: string) => new Date(iso + 'T12:00:00Z').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
  days.forEach((iso, i) => {
    lines.push(`${i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : dayName(iso)} (${iso}): ${sky(d.weather_code?.[i])}, ${n(d.temperature_2m_min?.[i])} to ${n(d.temperature_2m_max?.[i])}${deg}, ${n(d.precipitation_probability_max?.[i])}% chance of rain${Number(d.precipitation_sum?.[i]) > 0 ? ` (${d.precipitation_sum[i]} ${rainU})` : ''}, UV ${n(d.uv_index_max?.[i])}, sunrise ${String(d.sunrise?.[i] ?? '').slice(11, 16)}, sunset ${String(d.sunset?.[i] ?? '').slice(11, 16)}.`);
  });
  return lines.join('\n');
}

/** Place names Niko asked to look up, from tags such as [[weather:Tokyo, Japan]] in its reply (at most three). */
export function weatherTags(reply: string): string[] {
  return [...reply.matchAll(/\[\[weather:([^\]\n]{1,80})\]\]/gi)].map((m) => m[1]!.trim()).filter(Boolean).slice(0, 3);
}
export const stripWeatherTags = (reply: string) => reply.replace(/\[\[weather:[^\]\n]{0,80}\]\]/gi, '').trim();

// ---------------------------------------------------------------- the weather card on Home
/** The kind of sky, for the card's icon. */
export function wxIcon(code: unknown): WeatherIcon {
  const c = Number(code);
  if (c === 0 || c === 1) return 'clear';
  if (c === 2) return 'partly';
  if (c === 3) return 'cloudy';
  if (c === 45 || c === 48) return 'fog';
  if (c >= 51 && c <= 57) return 'drizzle';
  if ((c >= 61 && c <= 67)) return 'rain';
  if (c >= 80 && c <= 82) return 'showers';
  if ((c >= 71 && c <= 77) || c === 85 || c === 86) return 'snow';
  if (c >= 95) return 'storm';
  return 'cloudy';
}
const int = (v: unknown) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : null);
/** One short tip from the numbers (no model is asked, so it is never wordy or wrong about the data). */
function tipFor(rain: number | null, hi: number | null, lo: number | null, uv: number | null, icon: WeatherIcon, f: boolean): string {
  const hot = f ? 91 : 33, cold = f ? 41 : 5;
  if (icon === 'storm' && (rain ?? 0) >= 40) return 'Thunderstorms likely: take an umbrella.';
  if ((rain ?? 0) >= 60) return 'Take an umbrella.';
  if ((rain ?? 0) >= 30) return 'Maybe pack an umbrella.';
  if (icon === 'snow') return 'Snow: wrap up warm.';
  if (hi !== null && hi >= hot) return 'Hot: drink plenty of water.';
  if (lo !== null && lo <= cold) return 'Cold: wrap up warm.';
  if ((uv ?? 0) >= 8) return 'Strong sun: wear sunscreen.';
  return '';
}
/** The card for one place: now, today's high and low and rain, the next hours, and three days. */
export async function forecastCard(place: Place, units: 'C' | 'F', label?: string): Promise<WeatherCard> {
  const j = await forecast(place, units);
  const c = j?.current ?? {}, h = j?.hourly ?? {}, d = j?.daily ?? {};
  const now = String(c.time ?? '');
  const times: string[] = Array.isArray(h.time) ? h.time : [];
  const start = Math.max(0, times.findIndex((t) => t >= now.slice(0, 13)));
  const hourLabel = (iso: string) => { const hr = Number(iso.slice(11, 13)); return hr === 0 ? '12 am' : hr === 12 ? '12 pm' : hr < 12 ? `${hr} am` : `${hr - 12} pm`; };
  const hours: WeatherCard['hours'] = [];
  for (let k = 0; k < 5; k++) {
    const i = start + k * 3;
    if (i >= times.length) break;
    hours.push({ label: k === 0 ? 'Now' : hourLabel(times[i]!), temp: int(k === 0 ? c.temperature_2m : h.temperature_2m?.[i]), rain: int(h.precipitation_probability?.[i]), icon: wxIcon(k === 0 ? c.weather_code : h.weather_code?.[i]) });
  }
  const dates: string[] = Array.isArray(d.time) ? d.time : [];
  const days: WeatherCard['days'] = dates.slice(0, 3).map((iso, i) => ({
    label: i === 0 ? 'Today' : new Date(iso + 'T12:00:00Z').toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' }),
    hi: int(d.temperature_2m_max?.[i]), lo: int(d.temperature_2m_min?.[i]), rain: int(d.precipitation_probability_max?.[i]), icon: wxIcon(d.weather_code?.[i]),
  }));
  const icon = wxIcon(c.weather_code), today = days[0];
  // A place found from the browser's location has no name: its time zone's city is close enough ("Asia/Singapore").
  const tzCity = String(j?.timezone ?? '').split('/').pop()?.replace(/_/g, ' ') ?? '';
  const sky = (WMO[Number(c.weather_code)] ?? 'unsettled');
  return {
    place: (label || tzCity || 'Your location').slice(0, 60), units,
    now: { temp: int(c.temperature_2m), feels: int(c.apparent_temperature), sky: sky[0]!.toUpperCase() + sky.slice(1), icon },
    today: { hi: today?.hi ?? null, lo: today?.lo ?? null, rain: today?.rain ?? null },
    hours, days, tip: tipFor(today?.rain ?? null, today?.hi ?? null, today?.lo ?? null, int(d.uv_index_max?.[0]), icon, units === 'F'),
  };
}
