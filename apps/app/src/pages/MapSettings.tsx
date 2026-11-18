// Engine → Maps: the Everywhere list, each country's own list, and the map services (keys) they draw from.
// Keys are saved from the sheet straight away (and go to the server only); the order of the lists is saved with the
// Engine screen's "Save changes".
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { aiAllowed, mapsOn, MAP_PROVIDERS, MAP_MODE_NAMES, mapOption, mapPreset, MAX_MAP_COUNTRIES, MAX_MAP_KEYS, type BrainRest, type MapKeyInfo, type MapProvider, type MapSource, type UsageInfo } from '@niko/shared';
import { MonthLine, UsageLines } from './Usage';
import { api, Field, Icon } from '@niko/ui';
import { useNiko } from '../niko';

export interface MapLists { maps: MapSource[]; mapCountries: Record<string, MapSource[]>; dirty: boolean; saved: () => void }
type Draft = { id?: string; provider: MapProvider; label: string; apiKey: string; secret: string; email: string; password: string; baseUrl: string; list: string };

export const regionName = (cc: string) => { try { return new Intl.DisplayNames(['en'], { type: 'region' }).of(cc) ?? cc; } catch { return cc; } };
let allCountries: { cc: string; name: string }[] | null = null;
export function countries() {
  if (allCountries) return allCountries;
  const out: { cc: string; name: string }[] = [], A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  try { const dn = new Intl.DisplayNames(['en'], { type: 'region' }); for (const a of A) for (const b of A) { const cc = a + b, name = dn.of(cc); if (name && name !== cc && !/unknown|^[A-Z]{2}$/i.test(name) && !['EU', 'EZ', 'UN', 'QO', 'XA', 'XB', 'ZZ'].includes(cc)) out.push({ cc, name }); } } catch { /* none */ }
  const seen = new Set<string>();
  return (allCountries = out.filter((c) => !seen.has(c.name) && !!seen.add(c.name)).sort((x, y) => x.name.localeCompare(y.name)));
}
const can = (p: MapProvider) => { const x = mapPreset(p)!; return [x.places ? 'Places' : '', x.routes.length ? `${x.routes.map((m) => MAP_MODE_NAMES[m]).join(', ')} routes` : ''].filter(Boolean).join(' · ') || 'Places'; };
const time = (t: number) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
function restLine(r: BrainRest | undefined) {
  if (!r || r.until <= Date.now()) return '';
  return r.why === 'limit' ? `Usage limit reached. The next one is used, and this one is tried again at ${time(r.until)}.`
    : r.why === 'refused' ? `It refused the last request. Check its key; it is tried again at ${time(r.until)}.`
    : `It did not answer just now. The next one is used, and this one is tried again at ${time(r.until)}.`;
}
const move = <T,>(l: T[], i: number, by: -1 | 1): T[] => { const j = i + by; if (j < 0 || j >= l.length) return l; const n = l.slice(); [n[i], n[j]] = [n[j]!, n[i]!]; return n; };

export function MapSettings({ bind, usage = null }: { bind: (l: MapLists) => void; usage?: UsageInfo | null }) {
  const { me, refreshMe } = useNiko();
  const off = me?.aiOff ?? [];
  const [keys, setKeys] = useState<MapKeyInfo[]>([]);
  const [maps, setMaps] = useState<MapSource[]>([]);
  const [lists, setLists] = useState<Record<string, MapSource[]>>({});
  const [dirty, setDirty] = useState(false);
  const [tab, setTab] = useState('ww');
  const [menu, setMenu] = useState('');
  const [confirm, setConfirm] = useState('');
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const dlg = useRef<HTMLDialogElement>(null);
  const started = useRef(false);

  const load = useCallback(async () => { const r = await api<{ keys: MapKeyInfo[] }>('/map/keys'); setKeys(r.keys ?? []); }, []);
  useEffect(() => {
    if (!me || started.current) return;
    started.current = true;
    setMaps((me.engine.maps ?? []).filter((x) => x !== 'osm'));
    setLists(Object.fromEntries(Object.entries(me.engine.mapCountries ?? {}).filter(([, l]) => l.length)));
    void load();
  }, [me, load]);
  bind({ maps: [...maps, 'osm'], mapCountries: lists, dirty, saved: () => setDirty(false) });
  useEffect(() => { if (draft) dlg.current?.showModal(); }, [draft]);
  // The ⋯ menu closes on a tap elsewhere or Escape.
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu('');
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenu(''); };
    document.addEventListener('click', close); document.addEventListener('keydown', key);
    return () => { document.removeEventListener('click', close); document.removeEventListener('keydown', key); };
  }, [menu]);
  // Maps off for this account, or every map service off: the whole section goes, as Niko can't show maps.
  if (!me || !mapsOn(off)) return null;
  const osm = aiAllowed(off, 'map:osm');

  const keyOf = (s: MapSource) => keys.find((k) => `mkey:${k.id}` === s);
  const ok = (s: MapSource) => { const k = keyOf(s); return !!k && aiAllowed(off, mapOption(s, k)); };
  const nameOf = (s: MapSource) => (s === 'osm' ? 'OpenStreetMap' : keyOf(s)?.label || (keyOf(s) ? mapPreset(keyOf(s)!.provider)!.name : 'Removed service'));
  const shown = maps.filter(ok);
  const change = (fn: () => void) => { fn(); setDirty(true); };
  const presets = MAP_PROVIDERS.filter((p) => aiAllowed(off, `map:${p.id}`));

  const editDraft = (k: MapKeyInfo) => { setErr(''); setConfirm(''); setDraft({ id: k.id, provider: k.provider, label: k.label, apiKey: '', secret: '', email: k.email, password: '', baseUrl: k.baseUrl, list: 'ww' }); };
  const newDraft = (): Draft => { const p = presets[0]!; return { provider: p.id, label: '', apiKey: '', secret: '', email: '', password: '', baseUrl: '', list: p.home ?? 'ww' }; };
  const closeSheet = () => dlg.current?.close();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!draft) return;
    setErr(''); setBusy('save');
    try {
      const r = await api<{ key: MapKeyInfo }>('/map/keys', { body: { ...draft, list: draft.id ? undefined : draft.list } });
      if (!draft.id) {
        const s = `mkey:${r.key.id}` as MapSource;
        // The server put it in its list too; the page does the same, keeping any order not saved yet.
        if (draft.list === 'ww') setMaps((m) => [...m, s]); else setLists((l) => ({ ...l, [draft.list]: [...(l[draft.list] ?? []), s] }));
      }
      await load(); await refreshMe();
      setNote({ ok: true, text: draft.id ? 'Map service saved.' : `${r.key.label} added.` });
      closeSheet();
    } catch (x: any) { setErr(x.message); } finally { setBusy(''); }
  };
  const test = async (body: object, tag: string) => {
    setErr(''); setNote(null); setBusy('test-' + tag);
    try { const r = await api<{ message: string }>('/map/keys/test', { body }); if (draft) setErr(`✓ ${r.message}`); else setNote({ ok: true, text: r.message }); }
    catch (x: any) { if (draft) setErr(x.message); else setNote({ ok: false, text: x.message }); }
    finally { setBusy(''); }
  };
  const remove = async (k: MapKeyInfo) => {
    if (confirm !== k.id) { setConfirm(k.id); return; }
    setConfirm(''); setNote(null);
    try {
      await api(`/map/keys/${encodeURIComponent(k.id)}`, { method: 'DELETE' });
      const s = `mkey:${k.id}`;
      setMaps((m) => m.filter((x) => x !== s)); setLists((l) => Object.fromEntries(Object.entries(l).map(([cc, v]) => [cc, v.filter((x) => x !== s)])));
      await load(); await refreshMe();
      setNote({ ok: true, text: 'Map service removed.' });
    } catch (x: any) { setNote({ ok: false, text: x.message }); }
  };

  // ---- 1 · your map services: one quiet list; Test, Edit and Remove in each row's ⋯ menu.
  const usedIn = (s: MapSource) => [...(maps.includes(s) ? ['Everywhere'] : []), ...Object.keys(lists).filter((cc) => lists[cc]!.includes(s)).map(regionName)];
  const capsLine = (pr: MapProvider) => { const x = mapPreset(pr)!; return [x.places ? 'Places' : '', ...x.routes.map((m) => MAP_MODE_NAMES[m])].filter(Boolean).join(' · '); };
  const homeOf = (k: MapKeyInfo) => mapPreset(k.provider)?.home ?? null;
  const useIt = (k: MapKeyInfo) => {
    const s = `mkey:${k.id}` as MapSource, home = homeOf(k);
    change(() => { if (home) setLists((l) => ({ ...l, [home]: [...(l[home] ?? []), s] })); else setMaps((m) => [...m, s]); });
    setTab(home ?? 'ww');
  };
  const serviceRow = (k: MapKeyInfo) => {
    const s = `mkey:${k.id}` as MapSource, where = usedIn(s), resting = restLine(me.engine.mapRest?.[s]), home = homeOf(k);
    const status = resting ? { col: 'is-warn', text: 'Resting' } : where.length ? { col: 'is-ok', text: 'Ready' } : { col: 'is-warn', text: 'Not used yet' };
    return (
      <li key={k.id} className="msrv">
        <span className="msrv-name"><b>{k.label || mapPreset(k.provider)!.name}</b><span className="sub">{k.provided ? `Included · ${capsLine(k.provider)}` : capsLine(k.provider)}</span><UsageLines usage={usage} kind="map" entry={s} provided={k.provided} service={mapPreset(k.provider)?.name} />{resting && <span className="sub vrow-warn">{resting}</span>}</span>
        <span className={'msrv-status ' + status.col}><i aria-hidden="true" />{status.text}</span>
        <span className="msrv-used">{where.length ? where.join(', ') : <button type="button" className="bt msrv-use" onClick={() => useIt(k)}>{home ? `Add to ${regionName(home)}` : 'Use everywhere'}</button>}</span>
        <span className="msrv-more">
          {!k.provided && <button type="button" className="stp msrv-dots" aria-label={`More for ${k.label}`} aria-haspopup="menu" aria-expanded={menu === k.id} onClick={(e) => { e.stopPropagation(); setMenu(menu === k.id ? '' : k.id); setConfirm(''); }}>⋯</button>}
          {menu === k.id && !k.provided && (
            <span className="msrv-menu" role="menu" onClick={(e) => e.stopPropagation()}>
              <button type="button" role="menuitem" disabled={!!busy} onClick={() => { setMenu(''); void test({ id: k.id, provider: k.provider, baseUrl: k.baseUrl, email: k.email }, k.id); }}>{busy === 'test-' + k.id ? 'Testing…' : 'Test'}</button>
              <button type="button" role="menuitem" onClick={() => { setMenu(''); editDraft(k); }}>Edit</button>
              <button type="button" role="menuitem" className="danger" onClick={() => { if (confirm === k.id) setMenu(''); void remove(k); }}>{confirm === k.id ? 'Tap again to remove' : 'Remove'}</button>
            </span>
          )}
        </span>
      </li>
    );
  };

  // ---- 2 · which Niko tries first: a tab for Everywhere and one for each country.
  const allowedKeys = keys.filter((k) => ok(`mkey:${k.id}` as MapSource));
  const tabs = ['ww', ...Object.keys(lists).sort((a, b) => regionName(a).localeCompare(regionName(b)))];
  const cur = tabs.includes(tab) ? tab : 'ww';
  const own = (cur === 'ww' ? maps : lists[cur] ?? []).filter(ok);
  const setOwn = (l: MapSource[]) => change(() => { if (cur === 'ww') setMaps([...l, ...maps.filter((x) => !ok(x))]); else setLists({ ...lists, [cur]: l }); });
  const then = cur === 'ww' ? [] : shown.filter((s) => !own.includes(s));
  const fullChain = [...own, ...then.filter((s) => !own.includes(s)), ...(osm ? ['osm' as MapSource] : [])];
  const addable = allowedKeys.map((k) => `mkey:${k.id}` as MapSource).filter((s) => !own.includes(s) && (() => { const only = mapPreset(keyOf(s)!.provider)!.only; return !only || (cur !== 'ww' && only.includes(cur)); })());
  const skipNote = cur === 'KR' ? 'Google is skipped here for driving, walking and cycling routes.' : cur === 'CN' ? 'Only Amap, Baidu, OpenStreetMap and your own route server are used here; Niko lines the pins up.' : '';
  // Included services stay first when the plan says so.
  const fixed = usage?.plan.order === 'fixed';
  const prov = (s: MapSource) => !!keyOf(s)?.provided;
  const orderRow = (s: MapSource, i: number) => (
    <li key={s} className="mord">
      <span className="mord-n">{i + 1}</span>
      <span className="mord-name"><span>{nameOf(s)}</span><span className="sub">{capsLine(keyOf(s)!.provider)}</span></span>
      <span className="vrow-move">
        <button type="button" className="stp" onClick={() => setOwn(move(own, i, -1))} disabled={i === 0 || (fixed && (prov(s) || prov(own[i - 1]!)))} aria-label={`Move ${nameOf(s)} up`}>↑</button>
        <button type="button" className="stp" onClick={() => setOwn(move(own, i, 1))} disabled={i === own.length - 1 || (fixed && prov(s))} aria-label={`Move ${nameOf(s)} down`}>↓</button>
        <button type="button" className="stp" onClick={() => setOwn(own.filter((x) => x !== s))} aria-label={`Take ${nameOf(s)} off this list`}>×</button>
      </span>
    </li>
  );
  const fadedRow = (s: MapSource, i: number) => (
    <li key={s} className="mord faded">
      <span className="mord-n">{i}</span>
      <span className="mord-name"><span>{nameOf(s)}</span><span className="sub">{s === 'osm' ? 'Built in · always last' : capsLine(keyOf(s)!.provider)}</span></span>
    </li>
  );

  const p = draft ? mapPreset(draft.provider)! : null;
  const countryOptions = countries().filter((c) => !lists[c.cc]);
  return (
    <section className="g eng-card wide" aria-label="Maps">
      <span className="k" style={{ paddingBottom: 6 }}>Maps</span>
      <MonthLine usage={usage} kind="map" />
      <p className="hint" style={{ paddingBottom: 8 }}>Ask Niko the way somewhere or to show a place. Add your map services, then choose which Niko tries first, everywhere or in a country of your choosing.</p>
      {note && <p className={'hint' + (note.ok ? '' : ' vrow-warn')} role="status">{note.text}</p>}

      <div className="map-step">
        <div className="map-subhead"><span className="k" style={{ color: '#fff' }}>1 · Your map services</span><span className="hint">Keys stay on Niko’s server</span></div>
        {allowedKeys.length > 0 && (
          <ul className="msrv-list">
            <li className="msrv msrv-head k" aria-hidden="true"><span>Service</span><span>Status</span><span>Used in</span><span /></li>
            {allowedKeys.map(serviceRow)}
          </ul>
        )}
        {!allowedKeys.length && !osm && <p className="hint vrow-warn">No map service is on yet, so Niko can’t show maps. Add one below.</p>}
        <div className="msrv-foot">
          {presets.length > 0 && <button type="button" className="pri msrv-add" onClick={() => { setErr(''); setDraft(newDraft()); }} disabled={keys.filter((k) => !k.provided).length >= MAX_MAP_KEYS}><Icon name="plus" size={16} />Add a map service</button>}
          {osm && <span className="hint">OpenStreetMap is built in and always tried last.</span>}
        </div>
      </div>

      <div className="map-step">
        <div className="map-subhead"><span className="k" style={{ color: '#fff' }}>2 · Which Niko tries first</span><span className="hint">If one is at its limit or can’t connect, Niko uses the next</span></div>
        <div className="mtabs" role="tablist" aria-label="Where">
          {tabs.map((t) => (
            <button key={t} type="button" role="tab" className="mtab" aria-selected={cur === t} onClick={() => { setTab(t); setConfirm(''); }}>
              <Icon name={t === 'ww' ? 'globe' : 'pin'} size={15} />{t === 'ww' ? 'Everywhere' : regionName(t)}
            </button>
          ))}
          {tabs.length - 1 < MAX_MAP_COUNTRIES && (
            <label className="mtab mtab-add"><Icon name="plus" size={15} /><span className="sr">Add a country</span>
              <select value="" aria-label="Add a country" onChange={(x) => { const cc = x.target.value; if (cc) { change(() => setLists({ ...lists, [cc]: [] })); setTab(cc); } }}>
                <option value="">Country</option>
                {countryOptions.map((c) => <option key={c.cc} value={c.cc}>{c.name}</option>)}
              </select>
              <span aria-hidden="true">Country</span>
            </label>
          )}
        </div>
        <div className="mpanel" role="tabpanel">
          <div className="mchain">
            <span className="hint">{cur === 'ww' ? 'Anywhere without its own list, Niko tries:' : `In ${regionName(cur)}, Niko tries:`}</span>
            <span className="mchain-items">
              {fullChain.length ? fullChain.map((s, i) => <span key={s} className="mchain-item">{i > 0 && <span className="mchain-arrow" aria-hidden="true">→</span>}<span className={'map-chip' + (own.includes(s) ? ' own' : '')}>{i + 1} · {nameOf(s).replace(/ \((Singapore|Korea|China)\)$/, '')}</span></span>) : <span className="hint vrow-warn">Nothing yet: Niko can’t show maps here.</span>}
            </span>
            {skipNote && <span className="hint vrow-warn">{skipNote}</span>}
          </div>
          {own.length > 0 ? <ol className="mord-list">{own.map(orderRow)}</ol>
            : <p className="hint">{cur === 'ww' ? 'No services in this list yet.' : 'No services in this list yet. Add one below; until then Niko uses Everywhere here.'}</p>}
          <div className="mpanel-actions">
            {addable.length > 0 && (
              <label className="mtab mtab-add"><Icon name="plus" size={15} />
                <select value="" aria-label="Add a service to this list" onChange={(x) => x.target.value && setOwn([...own, x.target.value as MapSource])}>
                  <option value="">Add a service</option>
                  {addable.map((s) => <option key={s} value={s}>{nameOf(s)}</option>)}
                </select>
                <span aria-hidden="true">Add a service to this list</span>
              </label>
            )}
            {cur !== 'ww' && <button type="button" className={'bt' + (confirm === 'cc:' + cur ? ' danger' : ' quiet')} onClick={() => { if (confirm !== 'cc:' + cur) { setConfirm('cc:' + cur); return; } setConfirm(''); change(() => { const n = { ...lists }; delete n[cur]; setLists(n); }); setTab('ww'); }} onBlur={() => confirm === 'cc:' + cur && setConfirm('')}>{confirm === 'cc:' + cur ? 'Tap again to remove' : 'Remove this country'}</button>}
          </div>
          {cur !== 'ww' && (then.length > 0 || osm) && <>
            <span className="k mthen">Then Everywhere <span className="hint">· change it on the Everywhere tab</span></span>
            <ol className="mord-list">{[...then, ...(osm ? ['osm' as MapSource] : [])].map((s, i) => fadedRow(s, own.length + i + 1))}</ol>
          </>}
          {cur === 'ww' && osm && <ol className="mord-list">{fadedRow('osm', own.length + 1)}</ol>}
        </div>
      </div>
      {off.some((k) => k.startsWith('map:')) && <p className="hint managed">Some options aren’t included in your plan.</p>}

      <dialog ref={dlg} className="sheet wide" onClose={() => { setDraft(null); setErr(''); }}>
        {draft && p && (
          <form onSubmit={submit}>
            <h2 className="sheet-h">{draft.id ? `Edit ${draft.label || p.name}` : 'Add a map service'}</h2>
            <Field label="Service">
              <select className="in" value={draft.provider} disabled={!!draft.id} onChange={(x) => { const n = mapPreset(x.target.value)!; setErr(''); setDraft({ ...draft, provider: n.id, list: n.home ?? (draft.list === 'ww' || !mapPreset(draft.provider)?.home ? draft.list : 'ww') }); }}>
                {presets.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
              </select>
            </Field>
            <p className="sub">{p.note} <b>Can do:</b> {can(p.id)}.</p>
            <Field label="Name · optional"><input className="in" maxLength={40} autoComplete="off" placeholder={p.name} value={draft.label} onChange={(x) => setDraft({ ...draft, label: x.target.value })} /></Field>
            {p.fields.map((f) => (
              <Field key={f.key} label={f.label + (f.optional ? ' · optional' : '')}>
                <input className="in" type={f.secret ? 'password' : f.key === 'baseUrl' ? 'url' : f.key === 'email' ? 'email' : 'text'} autoComplete="off" spellCheck={false}
                  placeholder={draft.id && f.secret ? 'Saved · type to replace' : f.placeholder} required={!draft.id && !f.optional}
                  value={draft[f.key]} onChange={(x) => { setErr(''); setDraft({ ...draft, [f.key]: x.target.value }); }} />
              </Field>
            ))}
            {!draft.id && (
              <Field label="Put it in">
                <select className="in" value={draft.list} onChange={(x) => setDraft({ ...draft, list: x.target.value })}>
                  {!p.only && <option value="ww">Everywhere</option>}
                  {(p.only ?? [...new Set([...Object.keys(lists), ...(p.home ? [p.home] : [])])]).map((cc) => <option key={cc} value={cc}>{regionName(cc)}’s list</option>)}
                </select>
              </Field>
            )}
            <p className="sub">Stored encrypted and sent only to {p.id === 'self-hosted' ? 'the address you enter' : p.name}.</p>
            {err && <p className={err.startsWith('✓') ? 'sub' : 'err'} role="alert">{err}</p>}
            <div className="sheet-actions">
              <button type="button" className="sec" onClick={closeSheet}>Cancel</button>
              {draft.id && <button type="button" className={confirm === draft.id ? 'pri danger' : 'sec'} disabled={!!busy} onClick={async () => { const k = keys.find((x) => x.id === draft.id); if (!k) return; const sure = confirm === k.id; await remove(k); if (sure) closeSheet(); }}>{confirm === draft.id ? 'Yes, remove it' : 'Remove'}</button>}
              <button type="button" className="sec" disabled={!!busy} onClick={() => test(draft, 'draft')}>{busy === 'test-draft' ? 'Testing…' : 'Test'}</button>
              <button className="pri" disabled={!!busy}>{busy === 'save' ? 'Saving…' : draft.id ? 'Save' : 'Add'}</button>
            </div>
          </form>
        )}
      </dialog>
    </section>
  );
}
