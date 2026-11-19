// Engine · Live info (as the Engine-Live-Info mockup): the person's live services (data sources used as live
// information), which Niko tries first everywhere and in each country (map timetables always last, not live), and
// their places, so "when's my bus?" works without details.
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '@niko/ui';
import { useNiko } from '../niko';
import { AddOwn } from './DataSources';
import { countries, regionName } from './MapSettings';
import { NoteLine, SettingsPage } from './Settings';

type Svc = { id: string; name: string; what: string; own: boolean; usedIn: string[] };
type Place = { name: string; value: string };
type Suggested = { key: string; name: string; value: string; count: number };
type St = { services: Svc[]; everywhere: string[]; countries: Record<string, string[]>; places: Place[]; canAdd: boolean; suggested?: Suggested[] };
type TestResult = { action: string; name: string; ok: boolean; ms?: number; problem?: string };

export function LiveInfo() {
  const { refreshMe } = useNiko();
  const [st, setSt] = useState<St | null>(null);
  const [tab, setTab] = useState<string>('ww');
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [menu, setMenu] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [newCc, setNewCc] = useState(false);
  const [edit, setEdit] = useState<{ i: number; p: Place; from?: Suggested } | null>(null);
  const load = useCallback(() => api<St>('/data/live').then((r) => { setSt(r); return r; }).catch((e) => { setNote({ ok: false, text: (e as Error).message }); return null; }), []);
  useEffect(() => { void load().then((r) => { if (r && !r.everywhere.length) { const ccs = Object.keys(r.countries); if (ccs.length) setTab(ccs[0]!); } }); }, [load]);
  if (!st) return <SettingsPage title="Engine · Live info" sub="Bus arrivals, train alerts, traffic and parking, from live services."><NoteLine note={note} /></SettingsPage>;
  const save = async (p: Partial<Pick<St, 'everywhere' | 'countries' | 'places'>>, text?: string) => {
    setNote(null);
    try { setSt(await api<St>('/data/live', { method: 'PUT', body: p })); if (text) setNote({ ok: true, text }); } catch (e) { setNote({ ok: false, text: (e as Error).message }); }
  };
  // A place Niko noticed in their live questions: kept only with their yes (or their own name for it).
  const keepSuggested = async (x: Suggested, name?: string) => {
    setNote(null);
    try { setSt(await api<St>('/data/live/suggested', { body: { key: x.key, keep: true, ...(name ? { name } : {}) } })); setNote({ ok: true, text: `${name || x.name} saved.` }); }
    catch (e) { setNote({ ok: false, text: (e as Error).message }); }
  };
  const list = tab === 'ww' ? st.everywhere : st.countries[tab] ?? [];
  const setList = (l: string[]) => (tab === 'ww' ? save({ everywhere: l }) : save({ countries: { ...st.countries, [tab]: l } }));
  const name = (id: string) => st.services.find((x) => x.id === id)?.name ?? 'A service';
  const notIn = st.services.filter((x) => !list.includes(x.id));
  const test = async (s: Svc) => {
    setMenu(null); setNote(null);
    try { const r = await api<{ results: TestResult[] }>('/data/test', { body: { id: s.id } }); const bad = r.results.filter((x) => !x.ok); setNote(bad.length ? { ok: false, text: `${s.name}: ${bad.map((x) => `${x.name} · ${x.problem}`).join('; ')}` } : { ok: true, text: `${s.name}: every test passed.` }); }
    catch (e) { setNote({ ok: false, text: (e as Error).message }); }
  };
  const where = (cc: string) => (cc === 'Everywhere' ? 'Everywhere' : regionName(cc));
  return (
    <SettingsPage title="Engine · Live info" sub="Ask Niko when your bus comes, whether trains are running, or where to park. Add your live services, choose which Niko tries first, and tell it your usual places.">
      <NoteLine note={note} />
      <div className="kn-page">
        <div className="kn-main">
          <section className="g kn-card">
            <div className="kn-head"><b className="kn-h">1 · Your live services</b><span className="srow-hint">Keys stay on Niko’s server</span></div>
            {st.services.length ? (
              <ul className="dsp-list live">
                {st.services.map((s) => (
                  <li key={s.id}>
                    <span className="dsp-t"><b>{s.name}</b><span className="srow-hint">{s.what}</span></span>
                    <span className={'dsp-state' + (s.usedIn.length ? '' : ' off')}><i aria-hidden="true" />{s.usedIn.length ? 'Ready' : 'Not used yet'}</span>
                    {s.usedIn.length ? <span className="srow-hint dsp-from">{s.usedIn.map(where).join(', ')}</span>
                      : <button type="button" className="sec dsp-b" onClick={() => void setList([...list, s.id]).then(() => setNote({ ok: true, text: `${s.name} added to ${where(tab === 'ww' ? 'Everywhere' : tab)}.` }))}>Add to {tab === 'ww' ? 'Everywhere' : regionName(tab)}</button>}
                    <span className="dsa-more">
                      <button type="button" className="ib live-more" aria-label={`More for ${s.name}`} aria-expanded={menu === s.id} onClick={() => setMenu(menu === s.id ? null : s.id)}>⋯</button>
                      {menu === s.id && <span className="live-menu g" role="menu"><button role="menuitem" onClick={() => void test(s)}>Test</button><Link role="menuitem" to="/engine/data">{s.own ? 'Change or remove' : 'Details'}</Link></span>}
                    </span>
                  </li>
                ))}
              </ul>
            ) : <div className="dsp-empty"><b>No live services yet</b><span className="srow-hint">Without one, Niko uses timetable routes from your map services and says they aren’t live.</span></div>}
            {st.canAdd && <div className="wx-add"><button type="button" className="pri dsp-b" onClick={() => setAdding(true)}>+ Add a live service</button><span className="srow-hint">Without one, Niko uses timetable routes from your map services and says they aren’t live.</span></div>}
          </section>

          <section className="g kn-card">
            <div className="kn-head"><b className="kn-h">2 · Which Niko tries first</b><span className="srow-hint">If one is down or at its limit, Niko uses the next</span></div>
            <div className="live-tabs" role="tablist" aria-label="Where">
              <button role="tab" aria-selected={tab === 'ww'} className="segs-b live-tab" aria-pressed={tab === 'ww'} onClick={() => setTab('ww')}>Everywhere</button>
              {Object.keys(st.countries).map((cc) => <button key={cc} role="tab" aria-selected={tab === cc} className="segs-b live-tab" aria-pressed={tab === cc} onClick={() => setTab(cc)}>{regionName(cc)}</button>)}
              {newCc ? <select className="in live-cc" autoFocus aria-label="Add a country" defaultValue="" onBlur={() => setNewCc(false)} onChange={(e) => { const cc = e.target.value; setNewCc(false); if (cc) { setTab(cc); void save({ countries: { ...st.countries, [cc]: [] } }); } }}>
                <option value="" disabled>Choose a country</option>{countries().filter((c) => !st.countries[c.cc]).map((c) => <option key={c.cc} value={c.cc}>{c.name}</option>)}</select>
                : Object.keys(st.countries).length < 20 && <button type="button" className="segs-b live-tab add" onClick={() => setNewCc(true)}>+ Country</button>}
            </div>
            <div className="wx-chain"><span className="srow-hint">{tab === 'ww' ? 'Anywhere without its own list, Niko tries:' : `In ${regionName(tab)}, Niko tries:`}</span>
              <span className="wx-pills">{[...list.map(name), 'Map timetables (not live)'].map((t, i, a) => <span key={i} className="wx-pill-wrap"><span className={'wx-pill' + (i === 0 ? ' first' : '')}>{i + 1} · {t}</span>{i < a.length - 1 && <span aria-hidden="true" className="wx-arrow">→</span>}</span>)}</span></div>
            <ol className="wx-list">
              {list.map((id, i) => (
                <li key={id}>
                  <span className="wx-n" aria-hidden="true">{i + 1}</span>
                  <span className="dsp-t"><b>{name(id)}</b><span className="srow-hint">{st.services.find((x) => x.id === id)?.what} · live</span></span>
                  <span className="wx-move">
                    <button type="button" className="ib" aria-label={`Move ${name(id)} up`} disabled={i === 0} onClick={() => { const l = list.slice(); [l[i - 1], l[i]] = [l[i]!, l[i - 1]!]; void setList(l); }}>↑</button>
                    <button type="button" className="ib" aria-label={`Move ${name(id)} down`} disabled={i === list.length - 1} onClick={() => { const l = list.slice(); [l[i + 1], l[i]] = [l[i]!, l[i + 1]!]; void setList(l); }}>↓</button>
                    <button type="button" className="ib" aria-label={`Take ${name(id)} off this list`} onClick={() => void setList(list.filter((x) => x !== id))}>×</button>
                  </span>
                  <span />
                </li>
              ))}
              <li className="off"><span className="wx-n" aria-hidden="true">{list.length + 1}</span><span className="dsp-t"><b>Map timetables</b><span className="srow-hint">From your map services · always last · Niko says the times aren’t live</span></span><span /><span /></li>
            </ol>
            {!list.length && <p className="srow-hint" style={{ margin: 0 }}>{tab === 'ww' ? 'No live service for everywhere yet. Add one, or add a country with its own.' : `No live service for ${regionName(tab)} yet.`}</p>}
            <div className="live-addto">
              {notIn.length > 0 && <select className="in" aria-label="Add a service to this list" value="" onChange={(e) => e.target.value && void setList([...list, e.target.value])}>
                <option value="">+ Add a service to this list</option>{notIn.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select>}
              {tab !== 'ww' && <button type="button" className="sec dsp-b" onClick={() => { const c = { ...st.countries }; delete c[tab]; setTab('ww'); void save({ countries: c }, `${regionName(tab)} removed; it uses Everywhere now.`); }}>Remove {regionName(tab)}</button>}
            </div>
          </section>

          <section className="g kn-card">
            <div className="kn-head"><b className="kn-h">3 · Your places</b><span className="srow-hint">So “when’s my bus?” works without details</span></div>
            <ul className="live-places">
              {st.places.map((p, i) => edit?.i === i ? null : (
                <li key={i}><b>{p.name}</b><span className="live-pv">{p.value}</span><span className="live-pb"><button type="button" className="sec dsp-b" onClick={() => setEdit({ i, p })}>Edit</button><button type="button" className="sec dsp-b dsp-danger" onClick={() => void save({ places: st.places.filter((_, j) => j !== i) })}>Remove</button></span></li>
              ))}
              {(st.suggested ?? []).filter((x) => edit?.from?.key !== x.key).map((x) => (
                <li key={x.key} className="live-sug"><b>{x.name}</b><span className="live-pv">{x.value}<span className="live-from">Suggested from {x.count} times you asked</span></span><span className="live-pb"><button type="button" className="pri dsp-b" onClick={() => void keepSuggested(x)}>Yes, keep</button><button type="button" className="sec dsp-b" onClick={() => setEdit({ i: -1, p: { name: x.name, value: x.value }, from: x })}>Edit</button></span></li>
              ))}
            </ul>
            {edit ? (
              <form className="live-pform" onSubmit={(e) => {
                e.preventDefault(); const p = { name: edit.p.name.trim(), value: edit.p.value.trim() }; if (!p.name || !p.value) return;
                // A suggested place kept with their own name; with its value changed too, it's saved as their own place.
                if (edit.from && p.value === edit.from.value) void keepSuggested(edit.from, p.name);
                else void save({ places: edit.i < 0 ? [...st.places, p] : st.places.map((x, j) => (j === edit.i ? p : x)) }, `${p.name} saved.`);
                setEdit(null);
              }}>
                <input className="in" aria-label="Place name" placeholder="Home, Office, Usual stop" maxLength={40} value={edit.p.name} onChange={(e) => setEdit({ ...edit, p: { ...edit.p, name: e.target.value } })} autoFocus />
                <input className="in" aria-label="Where it is" placeholder="Example Rd stop · buses 174, 961" maxLength={160} value={edit.p.value} onChange={(e) => setEdit({ ...edit, p: { ...edit.p, value: e.target.value } })} />
                <button type="button" className="sec dsp-b" onClick={() => setEdit(null)}>Cancel</button><button type="submit" className="pri dsp-b" disabled={!edit.p.name.trim() || !edit.p.value.trim()}>Save</button>
              </form>
            ) : st.places.length < 20 && <div className="wx-add"><button type="button" className="sec dsp-b" onClick={() => setEdit({ i: -1, p: { name: '', value: '' } })}>+ Add a place</button><span className="srow-hint">A stop code helps: “Example Rd stop · 83139”.</span></div>}
          </section>
        </div>
        <aside className="kn-aside" aria-label="How live info works">
          <span className="k">How live info works</span>
          <p>Same two steps as Maps: <b>your services</b>, then <b>the order</b> for everywhere and each country. The country comes from where you are when Niko already knows it, or the one you tell it.</p>
          <p>Live answers say how fresh they are (“updated 20 seconds ago”) and refresh every minute while they’re on screen, for up to five minutes. Tap Refresh to ask again after that.</p>
          <p>For anything time-sensitive, live data always wins over your files; an old timetable in a file is shown with its date.</p>
          <span className="k">Private</span>
          <p>Only a stop code, line or location is sent to the service, never your name or files. Your key never leaves Niko’s server.</p>
          <p>Your places are used to understand your questions. They’re kept with your account and you can remove them at any time.</p>
          <p>Places you haven’t confirmed are suggestions from what Niko learned; they’re used only after you say yes.</p>
          <p><Link to="/engine">Back to Engine</Link></p>
        </aside>
      </div>
      {adding && <AddOwn use="live" onClose={() => setAdding(false)} onSaved={async (text) => { setAdding(false); await load(); await refreshMe(); setNote({ ok: true, text: `${text} Add it to a list below to use it.` }); }} />}
    </SettingsPage>
  );
}
