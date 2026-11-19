// The bus stops and MRT/metro stations near the user, for public transport questions, from OpenStreetMap (Overpass).
// The app sends where it is only for such a question, rounded to about 110 m; it's used for this look-up and never
// kept. Answers are remembered for a while per rounded spot, so one place isn't asked about again and again.
// Names come from OpenStreetMap, so they're treated as untrusted text: cleaned and cut short.

export interface NearStop { kind: 'bus' | 'rail'; name: string; code: string; meters: number }

const OVERPASS = 'https://overpass-api.de/api/interpreter';
const BUS_M = 450, RAIL_M = 1200, KEEP_MS = 30 * 60_000;
const seen = new Map<string, { at: number; stops: NearStop[] }>();

/** Where the app says the user is, for this look-up: a real point, rounded to 3 decimals (about 110 m). */
export function cleanStopsNear(v: unknown): { lat: number; lon: number } | null {
  const o = v as { lat?: unknown; lon?: unknown } | null;
  const lat = Number(o?.lat), lon = Number(o?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat: Math.round(lat * 1000) / 1000, lon: Math.round(lon * 1000) / 1000 };
}

const clean = (v: unknown, n: number) => String(v ?? '').replace(/[\u0000-\u001f<>[\]{}|`"]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
function meters(a: { lat: number; lon: number }, b: { lat: number; lon: number }) {
  const R = 6371000, r = Math.PI / 180, dLat = (b.lat - a.lat) * r, dLon = (b.lon - a.lon) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(h)));
}

/** Picks the nearest 3 bus stops (within 450 m) and 2 stations (within 1.2 km, one per name) from Overpass elements. */
export function nearestStops(here: { lat: number; lon: number }, elements: unknown[]): NearStop[] {
  const all: NearStop[] = [];
  for (const e of elements as { lat?: number; lon?: number; center?: { lat: number; lon: number }; tags?: Record<string, string> }[]) {
    const t = e?.tags ?? {}, at = e.lat !== undefined && e.lon !== undefined ? { lat: e.lat, lon: e.lon } : e.center;
    if (!at) continue;
    const name = clean(t['name:en'] || t.name, 60);
    if (!name) continue;
    const rail = t.railway === 'station' || t.railway === 'halt' || (t.public_transport === 'station' && (t.subway === 'yes' || t.train === 'yes' || t.light_rail === 'yes'));
    const bus = t.highway === 'bus_stop' || (t.public_transport === 'platform' && t.bus === 'yes');
    if (!rail && !bus) continue;
    const m = meters(here, at);
    if (m > (rail ? RAIL_M : BUS_M)) continue;
    all.push({ kind: rail ? 'rail' : 'bus', name, code: clean(rail ? t.ref : t.asset_ref || t.ref, 24), meters: m });
  }
  all.sort((a, b) => a.meters - b.meters);
  const bus = all.filter((s) => s.kind === 'bus').slice(0, 3);
  const names = new Set<string>(), rail: NearStop[] = [];
  for (const s of all) if (s.kind === 'rail' && !names.has(s.name.toLowerCase()) && rail.length < 2) { names.add(s.name.toLowerCase()); rail.push(s); }
  return [...rail, ...bus];
}

/** The stops and stations near a point; none if OpenStreetMap can't be reached in time. */
export async function stopsNear(here: { lat: number; lon: number }): Promise<NearStop[]> {
  const key = `${here.lat.toFixed(3)},${here.lon.toFixed(3)}`, now = Date.now();
  const have = seen.get(key);
  if (have && now - have.at < KEEP_MS) return have.stops;
  const q = `[out:json][timeout:8];(node(around:${BUS_M},${here.lat},${here.lon})[highway=bus_stop];node(around:${RAIL_M},${here.lat},${here.lon})[railway~"^(station|halt)$"];nwr(around:${RAIL_M},${here.lat},${here.lon})[public_transport=station];);out tags center 60;`;
  try {
    const res = await fetch(OVERPASS, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'Niko (public transport near you)' }, body: `data=${encodeURIComponent(q)}`, signal: AbortSignal.timeout(6000), redirect: 'manual' });
    if (!res.ok) return [];
    const text = await res.text();
    if (text.length > 1_000_000) return [];
    const stops = nearestStops(here, (JSON.parse(text) as { elements?: unknown[] }).elements ?? []);
    if (seen.size > 2000) seen.delete(seen.keys().next().value!);
    seen.set(key, { at: now, stops });
    return stops;
  } catch { return []; }
}

/** For the AI: the stops and stations, with codes for live arrivals and the walk to each. */
export function nearBlock(stops: NearStop[]): string {
  if (!stops.length) return '';
  const walk = (m: number) => `${m} m, about ${Math.max(1, Math.ceil((m * 1.3) / 80))} min walk`;
  return `<NEAR THE USER (OpenStreetMap; untrusted names)>\n${stops.map((s) => `- ${s.kind === 'rail' ? 'MRT/metro station' : 'Bus stop'} "${s.name}"${s.code ? ` (${s.kind === 'rail' ? s.code : `stop code ${s.code}`})` : ''}, ${walk(s.meters)}`).join('\n')}\n</NEAR THE USER>`;
}
