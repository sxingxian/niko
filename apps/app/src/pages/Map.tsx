// The map card on Home: the place, the way there, and how Niko chose the map service. The picture of the map is drawn
// here (MapLibre, with OpenFreeMap's OpenStreetMap tiles, loaded only when a map is first shown); places and routes
// come from Niko's server, so no map service key ever reaches the browser.
import { useEffect, useRef, useState } from 'react';
import { currentHue, Icon } from '@niko/ui';
import { distanceText, MAP_MODE_NAMES, MAP_MODES, minutesText, type MapMode, type MapResult } from '@niko/shared';
import { useNiko, type MapView } from '../niko';
import { mapCommand } from '../speech';

const MODE_ICON: Record<MapMode, string> = { drive: 'car', transit: 'train', walk: 'walk', cycle: 'bike' };
const NAME = (m: MapMode | 'fly' | 'place') => (m === 'fly' ? 'Flight' : m === 'place' ? 'Place' : MAP_MODE_NAMES[m]);
const STYLE = 'https://tiles.openfreemap.org/styles/positron';
const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const regionName = (cc: string) => { try { return new Intl.DisplayNames(['en'], { type: 'region' }).of(cc) ?? cc; } catch { return cc; } };

type Lib = typeof import('maplibre-gl');
let lib: Promise<Lib> | null = null;
/** MapLibre and its worker, from Niko's own address (the worker is a file of the app, so no blob: workers). */
function loadLib(): Promise<Lib> {
  lib ??= Promise.all([import('maplibre-gl'), import('maplibre-gl/dist/maplibre-gl-worker.mjs?url'), import('maplibre-gl/dist/maplibre-gl.css')])
    .then(([m, w]) => { m.setWorkerUrl(w.default); return m; })
    .catch((e) => { lib = null; throw e; });
  return lib;
}

/** OpenFreeMap's light style, recoloured to sit in Niko's dark glass. Goes by layer type and name, so it keeps working
 * when the style gains or renames layers. */
function darken(map: import('maplibre-gl').Map) {
  for (const l of map.getStyle().layers ?? []) {
    const id = l.id.toLowerCase();
    const paint = (k: string, v: unknown) => { try { (map.setPaintProperty as (id: string, k: string, v: unknown) => void)(l.id, k, v); } catch { /* not this layer */ } };
    if (l.type === 'background') paint('background-color', '#0a0e15');
    else if (l.type === 'fill') {
      paint('fill-color', /water|ocean|sea|lake|river/.test(id) ? '#0d1d2b' : /park|wood|forest|grass|landcover|green|cemetery|golf|pitch|garden/.test(id) ? '#0e1914' : /building/.test(id) ? '#151a24' : /aeroway|airport/.test(id) ? '#131823' : '#0c1119');
      if (/building/.test(id)) paint('fill-outline-color', '#1c2230');
    } else if (l.type === 'fill-extrusion') paint('fill-extrusion-color', '#151a24');
    else if (l.type === 'line') {
      paint('line-color', /casing/.test(id) ? '#080b11' : /water|river|stream|canal|ditch/.test(id) ? '#11263a' : /boundary|admin/.test(id) ? '#394050' : /rail|transit|subway/.test(id) ? '#283040' : /motorway|trunk|highway/.test(id) ? '#3a4457' : /primary|secondary/.test(id) ? '#2d3545' : '#212836');
    } else if (l.type === 'symbol') {
      paint('text-color', /water|ocean|sea|lake|river/.test(id) ? '#5b7890' : '#a7b0bf');
      paint('text-halo-color', 'rgba(8,11,17,.92)');
      paint('text-halo-width', 1.2);
      paint('icon-opacity', 0.55);
    }
  }
}

function MapCanvas({ result }: { result: MapResult | undefined }) {
  const box = useRef<HTMLDivElement>(null);
  const mapRef = useRef<import('maplibre-gl').Map | null>(null);
  const [ready, setReady] = useState(false);
  const [broken, setBroken] = useState('');
  useEffect(() => {
    let gone = false, ro: ResizeObserver | null = null;
    loadLib().then((m) => {
      if (gone || !box.current) return;
      const coarse = window.matchMedia('(pointer: coarse)').matches;
      const map = new m.Map({
        container: box.current, style: STYLE, center: [0, 20], zoom: 1.2, attributionControl: false,
        dragRotate: false, pitchWithRotate: false, touchPitch: false, cooperativeGestures: coarse, fadeDuration: reducedMotion() ? 0 : 150,
      });
      map.touchZoomRotate.disableRotation();
      mapRef.current = map;
      map.on('error', (e) => console.warn('map:', String((e as unknown as { error?: { message?: string } }).error?.message ?? 'error')));
      map.once('load', () => {
        if (gone) return;
        darken(map);
        const hue = Math.round(currentHue());
        const empty = { type: 'FeatureCollection' as const, features: [] };
        map.addSource('niko-route', { type: 'geojson', data: empty });
        map.addSource('niko-pts', { type: 'geojson', data: empty });
        map.addLayer({ id: 'niko-glow', type: 'line', source: 'niko-route', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': `hsl(${hue}, 100%, 70%)`, 'line-width': 12, 'line-opacity': 0.22, 'line-blur': 4 } });
        map.addLayer({ id: 'niko-line', type: 'line', source: 'niko-route', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': `hsl(${hue}, 95%, 72%)`, 'line-width': 4.5 } });
        map.addLayer({ id: 'niko-pts', type: 'circle', source: 'niko-pts', paint: {
          'circle-radius': ['case', ['==', ['get', 'k'], 'to'], 8, 6], 'circle-color': ['case', ['==', ['get', 'k'], 'to'], `hsl(${hue}, 95%, 72%)`, '#ffffff'],
          'circle-stroke-width': 3, 'circle-stroke-color': ['case', ['==', ['get', 'k'], 'to'], '#ffffff', `hsl(${hue}, 95%, 60%)`] } });
        setReady(true);
      });
      ro = new ResizeObserver(() => map.resize());
      ro.observe(box.current);
    }).catch((e) => { if (!gone) { console.warn('map could not load', e); setBroken('The map can’t be drawn on this device. The steps and apps below still work.'); } });
    return () => { gone = true; ro?.disconnect(); mapRef.current?.remove(); mapRef.current = null; };
  }, []);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || !result) return;
    const line = result.route?.coords ?? [];
    // A flight is drawn dashed, so it reads as a path in the air rather than a road.
    try { map.setPaintProperty('niko-line', 'line-dasharray', result.route?.mode === 'fly' ? [2, 1.6] : [1, 0]); } catch { /* older style */ }
    (map.getSource('niko-route') as import('maplibre-gl').GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: line.length > 1 ? [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: line } }] : [] });
    const pts = [...(result.from ? [{ k: 'from', p: result.from }] : []), { k: 'to', p: result.to }];
    (map.getSource('niko-pts') as import('maplibre-gl').GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: pts.map(({ k, p }) => ({ type: 'Feature', properties: { k }, geometry: { type: 'Point', coordinates: [p.lng, p.lat] } })) });
    const all: [number, number][] = [...line, ...pts.map(({ p }) => [p.lng, p.lat] as [number, number])];
    const duration = reducedMotion() ? 0 : 700;
    if (all.length < 2 || (!line.length && !result.from)) map.easeTo({ center: [result.to.lng, result.to.lat], zoom: 15, duration });
    else {
      let w = 180, s = 90, e = -180, n = -90;
      for (const [x, y] of all) { w = Math.min(w, x); e = Math.max(e, x); s = Math.min(s, y); n = Math.max(n, y); }
      map.fitBounds([[w, s], [e, n]], { padding: 36, maxZoom: 16, duration });
    }
  }, [ready, result]);
  return (
    <div className="map-canvas" ref={box} role="img" aria-label={result ? (result.route ? `Map of the way to ${result.to.name}` : `Map showing ${result.to.name}`) : 'Map'}>
      {broken && <p className="map-broken">{broken}</p>}
    </div>
  );
}

/** Why this map service, in one or two plain sentences. */
function whyLine(v: MapView, r: MapResult, chosen: string): string {
  const c = r.country, name = c.name ?? '';
  const chain = r.chain.length ? r.chain.join(', then ') : 'OpenStreetMap';
  let why = '';
  if (chosen === 'ww') why = `You chose the Worldwide list: ${chain}.`;
  else if (c.code && c.listed) why = `${c.how === 'gps' ? `You’re in ${name}` : `You said ${name}`}, so ${name}’s list comes first: ${chain}.`;
  else if (c.code) why = `${c.how === 'gps' ? `You’re in ${name}, which` : name} has no list of its own, so Niko uses Worldwide: ${chain}.`;
  else why = v.located ? `Worldwide list: ${chain}.` : `Location is off, so Niko uses the Worldwide list. Say a country to switch, like “I’m in Korea”.`;
  if (r.skipped.length) why += ` Skipped: ${r.skipped.join('; ')}.`;
  return why;
}

export function MapCard({ v, tabbable }: { v: MapView; tabbable?: boolean }) {
  const n = useNiko();
  const [picker, setPicker] = useState(false);
  const [steps, setSteps] = useState(false);
  const tab = tabbable ? 0 : -1;
  const r = v.result;
  const lists = Object.keys(n.me?.engine.mapCountries ?? {}).filter((cc) => n.me?.engine.mapCountries?.[cc]?.length).sort();

  // Voice: "by train", "walking instead", "drive me there", "close the map". Anything else goes on to the brain.
  useEffect(() => {
    n.setCommandHandler((phrase) => {
      const c = mapCommand(phrase);
      if (!c) return false;
      if ('close' in c) { n.closeMap(); n.carryOn(); return true; }
      if ('steps' in c) {
        const has = !!v.result?.route?.steps.length;
        setSteps(c.steps && has);
        n.setStatus('Heard', !has ? 'There are no steps for this map.' : c.steps ? 'Here are the steps.' : 'Steps hidden.', 'speaking');
        window.setTimeout(n.carryOn, 1200);
        return true;
      }
      n.setMapMode(c.mode);
      n.setStatus('Heard', c.mode === 'fly' ? 'Flight: drawing the flight path.' : `${MAP_MODE_NAMES[c.mode]}: finding the way.`, 'speaking');
      window.setTimeout(n.carryOn, 1200);
      return true;
    });
    return () => n.setCommandHandler(null);
  }); // eslint-disable-line react-hooks/exhaustive-deps

  const listed = !!(r?.country.code && r.country.listed);
  const pillName = listed ? r!.country.name : 'Worldwide';
  const pillSub = n.mapCountry === 'ww' ? 'chosen' : r?.country.how === 'gps' ? (listed ? 'from your location' : `you’re in ${r.country.name}`) : r?.country.how === 'said' ? (listed ? 'you said' : `no list for ${r.country.name}`) : r && !v.located ? 'location off' : '';
  const fly = v.mode === 'fly';
  const head = v.status === 'explain' ? 'Your location' : v.status === 'loading' ? (v.mode === 'place' ? 'Finding it' : fly ? 'Drawing the flight path' : 'Finding the way') : v.status === 'failed' ? 'Not found'
    : r?.route ? (r.route.mode === 'fly' ? `About ${minutesText(r.route.seconds)} · Flight · ${distanceText(r.route.meters)}` : `${minutesText(r.route.seconds)} · ${NAME(r.route.mode)} · ${distanceText(r.route.meters)}`) : v.mode === 'place' ? 'Place' : `${NAME(v.mode)} · no route`;
  const credit = [r?.source.id !== 'osm' && r ? `© ${r.source.label}` : '', 'OpenFreeMap', '© OpenStreetMap contributors'].filter(Boolean).join(' · ');

  return (
    <section className="g mapcard" aria-label="Map" aria-busy={v.status === 'loading'}>
      <div className="map-head">
        <span className="map-title">
          <span className="k" role="status">{head}</span>
          <b>{r?.to.name ?? v.to}</b>
          {r?.to.address && r.to.address !== r.to.name && <span className="map-addr">{r.to.address}</span>}
        </span>
        <button className="ib" style={{ width: 44, height: 44, margin: '-6px -8px 0 0' }} onClick={n.closeMap} aria-label="Close the map" tabIndex={tab}><Icon name="x" /></button>
      </div>

      {v.status === 'explain' ? (
        <div className="map-explain">
          <p>To use the right map services for the country you’re in, Niko asks your browser for your location.</p>
          <p className="map-small">Used for this request only, never stored. If you say no, Niko uses the Worldwide services, and you can say a country, like “I’m in Korea”.</p>
          <div className="two">
            <button className="sec" onClick={() => n.answerLocation(false)} tabIndex={tab}>Use Worldwide</button>
            <button className="pri" onClick={() => n.answerLocation(true)} tabIndex={tab}>Continue</button>
          </div>
        </div>
      ) : <>
        <div className="map-where">
          <button className="map-pill" onClick={() => setPicker(!picker)} aria-expanded={picker} aria-controls="map-where-list" tabIndex={tab} disabled={!r}>
            <Icon name={listed ? 'pin' : 'globe'} size={16} />{pillName}{pillSub && <span className="map-sub">· {pillSub}</span>}<span aria-hidden="true" className="map-caret">▾</span>
          </button>
        </div>
        {picker && (
          <div className="map-where-list" id="map-where-list" role="group" aria-label="Which country’s map services">
            {n.mapCountry !== 'auto' && <button className="map-opt" onClick={() => { setPicker(false); n.setMapCountry('auto'); }} tabIndex={tab}><Icon name="nav" size={14} />From my location</button>}
            <button className="map-opt" aria-pressed={!listed} onClick={() => { setPicker(false); n.setMapCountry('ww'); }} tabIndex={tab}><Icon name="globe" size={14} />Worldwide</button>
            {lists.map((cc) => <button key={cc} className="map-opt" aria-pressed={listed && r?.country.code === cc} onClick={() => { setPicker(false); n.setMapCountry(cc); }} tabIndex={tab}><Icon name="pin" size={14} />{regionName(cc)}</button>)}
            {!lists.length && <span className="map-small">No country has its own list yet. Add one on the Engine screen.</span>}
          </div>
        )}
        <div className={'map-frame' + (v.status === 'loading' ? ' busy' : '')}>
          <MapCanvas result={r} />
          {v.status === 'failed' && <div className="map-failed"><p>{v.error}</p><button className="sec" onClick={() => n.showMap(v.to, v.from, v.mode)} tabIndex={tab}>Try again</button></div>}
          <span className="map-credit">{credit}</span>
        </div>
        {fly ? (
          <div className="map-flight">
            <Icon name="plane" size={18} />
            <span><b>{r?.from?.name === 'You' ? 'Your location' : r?.from?.name ?? v.from ?? 'Your location'}</b> → <b>{r?.to.name ?? v.to}</b></span>
            <span className="map-small">The line is the shortest path over the globe and the time an estimate: airlines, winds and air traffic decide the real ones.</span>
          </div>
        ) : (
        <div className="map-tabs" role="group" aria-label="How to get there">
          {MAP_MODES.map((m) => (
            <button key={m} className="map-tab" aria-pressed={v.mode === m} onClick={() => n.setMapMode(m)} tabIndex={tab}>
              <Icon name={MODE_ICON[m]} size={16} /><b>{MAP_MODE_NAMES[m]}</b>{v.times[m] ? <span>{minutesText(v.times[m]!)}</span> : null}
            </button>
          ))}
        </div>
        )}
        {r && (
          <div className="map-service">
            <span className="map-svc"><span className="k">Map service</span><b>{r.source.label}</b></span>
            <span className="map-small">{whyLine(v, r, n.mapCountry)}</span>
            {r.noRoute && <span className="map-note">{r.noRoute}</span>}
          </div>
        )}
        {r && r.handoff.length > 0 && (
          <div className="map-apps">
            {r.handoff.map((h, i) => <a key={h.app} className={i ? 'sec' : 'pri'} href={h.url} target="_blank" rel="noopener noreferrer" tabIndex={tab}><Icon name="nav" size={16} />{r.mode === 'fly' ? (h.app === 'Google Flights' ? 'Find flights' : `Open in ${h.app}`) : r.mode === 'place' ? `Open in ${h.app}` : `Start in ${h.app}`}</a>)}
          </div>
        )}
        {r?.route && r.route.steps.length > 0 && (
          <details className="map-steps" open={steps} onToggle={(e) => setSteps((e.target as HTMLDetailsElement).open)}>
            <summary tabIndex={tab}>Steps ({r.route.steps.length})</summary>
            <ol>{r.route.steps.map((s, i) => <li key={i}><span>{s.text}</span>{s.meters ? <span className="map-small">{distanceText(s.meters)}</span> : null}</li>)}</ol>
          </details>
        )}
      </>}
    </section>
  );
}
