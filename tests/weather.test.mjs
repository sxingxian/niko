// Weather: place lookup, the forecast summary, location rounding and the tags Niko uses to ask for other places.
import assert from 'node:assert/strict';
import { cleanWhere, forecastText, geocode, stripWeatherTags, weatherTags } from '../apps/api/src/weather.ts';
import { isWeatherQuestion } from '../packages/shared/src/index.ts';

let pass = 0;
const ok = async (name, fn) => { try { await fn(); pass++; console.log('PASS', name); } catch (e) { console.log('FAIL', name, e?.message); process.exitCode = 1; } };
const seen = [];
globalThis.fetch = async (url) => {
  url = String(url); seen.push(url);
  if (url.startsWith('https://geocoding-api.open-meteo.com/')) {
    const name = new URL(url).searchParams.get('name');
    if (name === 'Nowhereville') return Response.json({});
    if (name === 'Paris') return Response.json({ results: [
      { name: 'Paris', latitude: 33.66, longitude: -95.55, country: 'United States', country_code: 'US', admin1: 'Texas' },
      { name: 'Paris', latitude: 48.8534, longitude: 2.3488, country: 'France', country_code: 'FR', admin1: 'Île-de-France' },
    ] });
    return Response.json({ results: [{ name: 'Tokyo', latitude: 35.6895, longitude: 139.69171, country: 'Japan', admin1: 'Tokyo' }] });
  }
  if (url.startsWith('https://api.open-meteo.com/v1/forecast')) {
    const hours = Array.from({ length: 48 }, (_, i) => `2026-11-15T${String(i % 24).padStart(2, '0')}:00`);
    return Response.json({
      timezone: 'Asia/Tokyo',
      current: { time: '2026-11-15T09:15', temperature_2m: 14.6, apparent_temperature: 12.2, relative_humidity_2m: 70, precipitation: 0, weather_code: 3, wind_speed_10m: 11.4 },
      hourly: { time: hours, temperature_2m: hours.map((_, i) => 10 + (i % 24) / 2), precipitation_probability: hours.map((_, i) => (i * 7) % 100), weather_code: hours.map(() => 61) },
      daily: { time: ['2026-11-15', '2026-11-16', '2026-11-17'], weather_code: [3, 63, 0], temperature_2m_max: [17, 15, 19], temperature_2m_min: [9, 10, 8],
        precipitation_probability_max: [20, 85, 0], precipitation_sum: [0, 12.3, 0], uv_index_max: [3, 1, 4], sunrise: ['2026-11-15T06:14', '', ''], sunset: ['2026-11-15T16:35', '', ''] },
    });
  }
  return new Response('no', { status: 404 });
};

await ok('weather questions are recognised, others are not', () => {
  for (const q of ['What’s the weather like?', 'Will it rain this afternoon?', 'Do I need an umbrella tomorrow', 'How hot is it in Tokyo', 'forecast for the weekend', 'is it going to be stormy', 'any thunderstorms later', 'Is there drizzle']) assert.ok(isWeatherQuestion(q), q);
  for (const q of ['Reply to Mei Lin', 'What’s on my calendar today', 'Open my notes', 'Draft an email to Priya']) assert.ok(!isWeatherQuestion(q), q);
});
await ok('a location is rounded to about 1 km, and junk is ignored', () => {
  assert.deepEqual(cleanWhere({ lat: 1.352083, lon: 103.819836 }), { lat: 1.35, lon: 103.82 });
  assert.equal(cleanWhere({ lat: 'x', lon: 2 }), null);
  assert.equal(cleanWhere({ lat: 95, lon: 2 }), null);
  assert.equal(cleanWhere(null), null);
});
await ok('a place is found by name, with country and region', async () => {
  const p = await geocode('Tokyo');
  assert.equal(p.name, 'Tokyo, Japan'); assert.equal(p.lat, 35.69); assert.equal(p.lon, 139.69);
});
await ok('a country after a comma picks between places of the same name', async () => {
  assert.equal((await geocode('Paris, France')).name, 'Paris, Île-de-France, France');
  assert.equal((await geocode('Paris')).name, 'Paris, Texas, United States');
});
await ok('an unknown place is null', async () => { assert.equal(await geocode('Nowhereville'), null); });
await ok('odd characters are dropped from what is looked up', async () => {
  seen.length = 0; await geocode('Tokyo<script>');
  assert.ok(!seen[0].includes('%3C') && !seen[0].includes('<'));
});
await ok('the forecast reads as now, the next hours and the days', async () => {
  const t = await forecastText({ lat: 35.6895, lon: 139.6917, name: 'Tokyo, Japan' });
  assert.match(t, /Place: Tokyo, Japan/);
  assert.match(t, /Now: 15°C, feels like 12°C, overcast, humidity 70%, wind 11 km\/h\./);
  assert.match(t, /Next 24 hours: 10:00 15°C light rain/);
  assert.match(t, /Tomorrow \(2026-11-16\): rain, 10 to 15°C, 85% chance of rain \(12\.3 mm\)/);
  assert.ok(seen.at(-1).includes('latitude=35.69') && seen.at(-1).includes('longitude=139.69'), 'coordinates are rounded in the request');
});
await ok('Fahrenheit asks for °F, mph and inches', async () => {
  const t = await forecastText({ lat: 1, lon: 2, name: 'x' }, 'F');
  assert.match(t, /°F/); assert.ok(seen.at(-1).includes('temperature_unit=fahrenheit') && seen.at(-1).includes('wind_speed_unit=mph'));
});
await ok('weather tags are read (at most three) and removed from the reply', () => {
  assert.deepEqual(weatherTags('[[weather:Tokyo, Japan]]'), ['Tokyo, Japan']);
  assert.deepEqual(weatherTags('[[weather:A]] [[weather:B]] [[weather:C]] [[weather:D]]'), ['A', 'B', 'C']);
  assert.equal(stripWeatherTags('Sure. [[weather:Tokyo]]'), 'Sure.');
});
console.log(`${pass} weather checks passed`);
