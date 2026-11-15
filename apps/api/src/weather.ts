// Weather from Open-Meteo (free, no key; data CC BY 4.0, credited on the Connections screen). Forecasts are turned
// into a short plain-text summary that goes into Niko's prompt. Places are looked up by name with Open-Meteo's
// geocoding. Answers are cached briefly; coordinates are rounded to about 1 km before use and never stored.

export interface Place { lat: number; lon: number; name: string }

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
  if (!res.ok) throw new Error(`weather service answered ${res.status}`);
  return res.json();
}

/** Finds a place by name, such as "Tokyo" or "Paris, France". Null when nothing matches. */
export async function geocode(query: string): Promise<Place | null> {
  const q = query.replace(/[^\p{L}\p{N} ,.'’-]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
  if (q.length < 2) return null;
  return cached(`geo:${q.toLowerCase()}`, 7 * 86400, async () => {
    // The geocoder matches one name, so "Paris, France" is looked up as "Paris" and the rest picks between results.
    const [name, ...rest] = q.split(',').map((s) => s.trim()).filter(Boolean);
    const j = await getJson(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name!)}&count=10&language=en&format=json`);
    const list: any[] = Array.isArray(j?.results) ? j.results : [];
    const hint = rest.join(' ').toLowerCase();
    const r = (hint && list.find((x) => [x.country, x.country_code, x.admin1].some((v) => v && String(v).toLowerCase().includes(hint)))) || list[0];
    if (!r || !Number.isFinite(r.latitude) || !Number.isFinite(r.longitude)) return null;
    const label = [r.name, r.admin1 && r.admin1 !== r.name ? r.admin1 : '', r.country].filter(Boolean).join(', ');
    return { lat: round2(r.latitude), lon: round2(r.longitude), name: label };
  });
}

/** The forecast for one place as a short summary: now, the next 24 hours, and 7 days. */
export async function forecastText(place: Place, units: 'C' | 'F' = 'C'): Promise<string> {
  const f = units === 'F';
  const params = new URLSearchParams({
    latitude: String(round2(place.lat)), longitude: String(round2(place.lon)), timezone: 'auto', forecast_days: '7',
    current: 'temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,wind_speed_10m',
    hourly: 'temperature_2m,precipitation_probability,weather_code',
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum,uv_index_max,sunrise,sunset',
    ...(f ? { temperature_unit: 'fahrenheit', wind_speed_unit: 'mph', precipitation_unit: 'inch' } : {}),
  });
  const j = await cached(`fc:${params}`, 15 * 60, () => getJson(`https://api.open-meteo.com/v1/forecast?${params}`));
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
