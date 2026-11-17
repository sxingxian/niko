// Engine → Maps: the Everywhere list, each country's own list, and the map services (keys) they draw from.
// Keys are saved from the sheet straight away (and go to the server only); the order of the lists is saved with the
// Engine screen's "Save changes".
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { aiAllowed, mapsOn, MAP_PROVIDERS, MAP_MODE_NAMES, mapOption, mapPreset, MAX_MAP_COUNTRIES, MAX_MAP_KEYS, type BrainRest, type MapKeyInfo, type MapProvider, type MapSource } from '@niko/shared';
import { api, Field, Icon, Switch } from '@niko/ui';
import { useNiko } from '../niko';

export interface MapLists { maps: MapSource[]; mapCountries: Record<string, MapSource[]>; dirty: boolean; saved: () => void }
type Draft = { id?: string; provider: MapProvider; label: string; apiKey: string; secret: string; email: string; password: string; baseUrl: string; list: string };

const regionName = (cc: string) => { try { return new Intl.DisplayNames(['en'], { type: 'region' }).of(cc) ?? cc; } catch { return cc; } };
let allCountries: { cc: string; name: string }[] | null = null;
function countries() {
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

export function MapSettings({ bind }: { bind: (l: MapLists) => void }) {
  const { me, refreshMe } = useNiko();
  const off = me?.aiOff ?? [];
  const [keys, setKeys] = useState<MapKeyInfo[]>([]);
  const [maps, setMaps] = useState<MapSource[]>([]);
  const [lists, setLists] = useState<Record<string, MapSource[]>>({});
  const [dirty, setDirty] = useState(false);
  const [open, setOpen] = useState('');
  const [editing, setEditing] = useState('');
  const [confirm, setConfirm] = useState('');
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [addCc, setAddCc] = useState('');
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
  // Maps off for this account, or every map service off: the whole section goes, as Niko can't show maps.
  if (!me || !mapsOn(off)) return null;
  const osm = aiAllowed(off, 'map:osm');

  const keyOf = (s: MapSource) => keys.find((k) => `mkey:${k.id}` === s);
  const ok = (s: MapSource) => { const k = keyOf(s); return !!k && aiAllowed(off, mapOption(s, k)); };
  const nameOf = (s: MapSource) => (s === 'osm' ? 'OpenStreetMap' : keyOf(s)?.label || (keyOf(s) ? mapPreset(keyOf(s)!.provider)!.name : 'Removed service'));
  const inAnyList = (s: MapSource) => maps.includes(s) || Object.values(lists).some((l) => l.includes(s));
  const shown = maps.filter(ok);
  const notInUse = keys.map((k) => `mkey:${k.id}` as MapSource).filter((s) => ok(s) && !inAnyList(s));
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

  const row = (s: MapSource, i: number | null, where: 'ww' | 'off') => {
    const k = keyOf(s), on = i !== null, p = k ? mapPreset(k.provider)! : null, resting = restLine(me.engine.mapRest?.[s]);
    const onlyHere = !!p?.only;
    return (
      <li key={s} className={'vrow' + (on ? ' on' : '')}>
        <div className="vrow-head">
          <span className="n" aria-hidden="true">{on ? i + 1 : '–'}</span>
          <button type="button" className="vrow-title" aria-expanded={open === s} onClick={() => setOpen(open === s ? '' : s)}>
            <b>{nameOf(s)}</b><span className="sub">{p ? `${p.name === nameOf(s) ? '' : `${p.name} · `}${can(k!.provider)}` : ''}</span>
            {k?.provider === 'google' && <span className="sub vrow-warn">Not used for driving, walking or cycling routes in South Korea, or anywhere in China.</span>}
            {onlyHere && <span className="sub vrow-warn">Only works in {p!.only!.map(regionName).join(', ')}: add it to that country’s list.</span>}
            {resting && <span className="sub vrow-warn">{resting}</span>}
          </button>
          <span className="k tag">{k?.provider === 'self-hosted' ? 'Your server' : 'Your key'}</span>
          {where === 'ww' && on && <span className="vrow-move">
            <button type="button" className="stp" onClick={() => change(() => setMaps(move(maps, maps.indexOf(s), -1)))} disabled={i === 0} aria-label={`Move ${nameOf(s)} up`}>↑</button>
            <button type="button" className="stp" onClick={() => change(() => setMaps(move(maps, maps.indexOf(s), 1)))} disabled={i === shown.length - 1} aria-label={`Move ${nameOf(s)} down`}>↓</button>
          </span>}
          <Switch on={on} onChange={(x) => change(() => setMaps(x ? [...maps, s] : maps.filter((y) => y !== s)))} label={`Use ${nameOf(s)} everywhere`} />
        </div>
        {open === s && k && (
          <div className="vrow-body">
            <div className="eng-fields col">
              <p className="hint">{p!.note}</p>
              <div className="eng-fields">
                <button type="button" className="bt" onClick={() => test({ id: k.id, provider: k.provider, baseUrl: k.baseUrl, email: k.email }, k.id)} disabled={!!busy}>{busy === 'test-' + k.id ? 'Testing…' : 'Test'}</button>
                <button type="button" className="bt" onClick={() => editDraft(k)}>Edit</button>
                <button type="button" className={'bt' + (confirm === k.id ? ' danger' : '')} onClick={() => remove(k)} onBlur={() => confirm === k.id && setConfirm('')}>{confirm === k.id ? 'Tap again to remove' : 'Remove'}</button>
              </div>
            </div>
          </div>
        )}
      </li>
    );
  };

  const countryCard = (cc: string) => {
    const l = lists[cc] ?? [], usable = l.filter(ok), edit = editing === cc;
    const addable = keys.map((k) => `mkey:${k.id}` as MapSource).filter((s) => ok(s) && !l.includes(s) && (!mapPreset(keyOf(s)!.provider)!.only || mapPreset(keyOf(s)!.provider)!.only!.includes(cc)));
    const skipNote = cc === 'KR' ? 'Google has no driving, walking or cycling routes here, so Niko skips it for those.' : cc === 'CN' ? 'Maps in China use their own coordinates: only Amap, Baidu, OpenStreetMap and your own route server are used here, and Niko lines the pins up.' : '';
    return (
      <div key={cc} className="map-country">
        <div className="map-country-head">
          <b>{regionName(cc)}</b>
          <button type="button" className="bt" onClick={() => setEditing(edit ? '' : cc)} aria-expanded={edit}>{edit ? 'Done' : 'Edit'}</button>
        </div>
        {!edit ? (
          <span className="map-chain">
            {usable.length ? usable.map((s) => <span key={s} className="map-chip">{nameOf(s)}</span>) : <span className="hint">No services yet.</span>}
            <span className="hint">→ then Everywhere</span>
          </span>
        ) : (
          <div className="eng-fields col">
            {usable.length > 0 && <ol className="map-mini">{usable.map((s, i) => (
              <li key={s}>
                <span>{i + 1}. {nameOf(s)}</span>
                <span className="vrow-move">
                  <button type="button" className="bt map-mini-edit" onClick={() => editDraft(keyOf(s)!)}>Settings</button>
                  <button type="button" className="stp" onClick={() => change(() => setLists({ ...lists, [cc]: move(l, l.indexOf(s), -1) }))} disabled={i === 0} aria-label={`Move ${nameOf(s)} up`}>↑</button>
                  <button type="button" className="stp" onClick={() => change(() => setLists({ ...lists, [cc]: move(l, l.indexOf(s), 1) }))} disabled={i === usable.length - 1} aria-label={`Move ${nameOf(s)} down`}>↓</button>
                  <button type="button" className="stp" onClick={() => change(() => setLists({ ...lists, [cc]: l.filter((x) => x !== s) }))} aria-label={`Take ${nameOf(s)} off ${regionName(cc)}’s list`}>×</button>
                </span>
              </li>
            ))}</ol>}
            <div className="eng-fields">
              {addable.length > 0 && (
                <label className="fld"><span className="k">Add a service to this list</span>
                  <select className="in" value="" onChange={(x) => x.target.value && change(() => setLists({ ...lists, [cc]: [...l, x.target.value as MapSource] }))}>
                    <option value="">Choose…</option>
                    {addable.map((s) => <option key={s} value={s}>{nameOf(s)}</option>)}
                  </select>
                </label>
              )}
              <button type="button" className="bt" onClick={() => { setErr(''); setDraft({ ...newDraft(), provider: presets.find((p) => p.home === cc)?.id ?? presets[0]!.id, list: cc }); }}>Add a new service</button>
              <button type="button" className={'bt' + (confirm === 'cc:' + cc ? ' danger' : '')} onClick={() => { if (confirm !== 'cc:' + cc) { setConfirm('cc:' + cc); return; } setConfirm(''); setEditing(''); change(() => { const n = { ...lists }; delete n[cc]; setLists(n); }); }} onBlur={() => confirm === 'cc:' + cc && setConfirm('')}>{confirm === 'cc:' + cc ? 'Tap again to remove' : 'Remove country'}</button>
            </div>
          </div>
        )}
        {skipNote && <span className="hint">{skipNote}</span>}
      </div>
    );
  };

  const p = draft ? mapPreset(draft.provider)! : null;
  const countryOptions = countries().filter((c) => !lists[c.cc]);
  return (
    <section className="g eng-card wide" aria-label="Maps">
      <span className="k" style={{ paddingBottom: 6 }}>Maps · Niko uses in this order</span>
      <p className="hint" style={{ paddingBottom: 8 }}>Ask Niko the way somewhere (“how do I get to the airport by train?”) or to show a place. The first service that works finds it, switching to the next when one reaches its limit, refuses its key or stops answering. When you’re in a country with its own list (or say you are, like “I’m in Korea”), that list comes first. The map picture is OpenStreetMap; keys stay on Niko’s server.</p>
      {note && <p className={'hint' + (note.ok ? '' : ' vrow-warn')} role="status">{note.text}</p>}

      <div className="map-subhead"><span className="k">Everywhere</span><span className="hint">Used in every country, after that country’s own list</span></div>
      <ol className="vlist">
        {shown.map((s, i) => row(s, i, 'ww'))}
        {osm && <li className="vrow on">
          <div className="vrow-head">
            <span className="n" aria-hidden="true">{shown.length + 1}</span>
            <span className="vrow-title"><b>OpenStreetMap</b><span className="sub">Built in · free, no key · the map and places; opens directions in the local maps app</span></span>
            <span className="k tag">Built in</span>
          </div>
        </li>}
      </ol>
      {!osm && !shown.length && <p className="hint vrow-warn" style={{ padding: '4px 0 8px' }}>No map service is on yet, so Niko can’t show maps. Add one below.</p>}
      {notInUse.length > 0 && <><span className="k" style={{ padding: '18px 0 6px' }}>Not in use</span><ul className="vlist">{notInUse.map((s) => row(s, null, 'off'))}</ul></>}

      <div className="map-subhead"><span className="k">By country</span><span className="hint">Used first for trips in that country</span></div>
      {Object.keys(lists).length ? <div className="map-countries">{Object.keys(lists).sort((a, b) => regionName(a).localeCompare(regionName(b))).map(countryCard)}</div>
        : <p className="hint">No country has its own list yet. Korean, Chinese and Singapore services go into their country’s list when you add them.</p>}

      <div className="map-add">
        {presets.length > 0 && <button type="button" className="bt add-key" onClick={() => { setErr(''); setDraft(newDraft()); }} disabled={keys.length >= MAX_MAP_KEYS}><Icon name="plus" size={18} />Add a map service</button>}
        {Object.keys(lists).length < MAX_MAP_COUNTRIES && (
          <label className="fld map-add-cc"><span className="sr">Add a country</span>
            <select className="in" value={addCc} onChange={(x) => { const cc = x.target.value; setAddCc(''); if (cc) { change(() => setLists({ ...lists, [cc]: [] })); setEditing(cc); } }}>
              <option value="">+ Add a country</option>
              {countryOptions.map((c) => <option key={c.cc} value={c.cc}>{c.name}</option>)}
            </select>
          </label>
        )}
      </div>
      {off.some((k) => k.startsWith('map:')) && <p className="hint managed">Some options are managed by your administrator.</p>}

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
