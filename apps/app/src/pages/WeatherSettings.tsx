// Connections · Weather (as the Connections-Weather mockup): where Niko gets the forecast and in what order (the
// built-in Open-Meteo when the plan has it, and data sources used as weather), then the home place, units and whether
// weather questions may carry the device's rounded location.
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, Segmented, Switch } from '@niko/ui';
import { useNiko } from '../niko';
import { NoteLine, SettingsPage } from './Settings';

type Src = { id: string; name: string; badge: string; what: string; on: boolean };
type St = { list: Src[]; on: string[]; home: string; units: 'C' | 'F'; location: boolean; canAdd: boolean; omInPlan: boolean };

export function Weather() {
  const { refreshMe } = useNiko();
  const [st, setSt] = useState<St | null>(null);
  const [home, setHome] = useState('');
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const take = (r: St) => { setSt(r); setHome(r.home); };
  useEffect(() => { void api<St>('/data/weather').then(take).catch((e) => setNote({ ok: false, text: (e as Error).message })); }, []);
  const save = useCallback(async (p: Partial<{ order: string[]; off: string[]; home: string; units: 'C' | 'F'; location: boolean }>, text?: string) => {
    setBusy(true); setNote(null);
    try { take(await api<St>('/data/weather', { method: 'PUT', body: p })); await refreshMe(); if (text) setNote({ ok: true, text }); }
    catch (e) { setNote({ ok: false, text: (e as Error).message }); } finally { setBusy(false); }
  }, [refreshMe]);
  if (!st) return <SettingsPage title="Connections · Weather" sub="Where Niko gets the forecast, and in what order."><NoteLine note={note} /></SettingsPage>;
  const ids = st.list.map((x) => x.id), off = st.list.filter((x) => !x.on).map((x) => x.id);
  const move = (i: number, by: -1 | 1) => { const o = ids.slice(); [o[i], o[i + by]] = [o[i + by]!, o[i]!]; void save({ order: o }); };
  const on = st.list.filter((x) => x.on);
  return (
    <SettingsPage title="Connections · Weather" sub="Ask “will it rain this afternoon?” or “what’s the weather in Tokyo on Saturday?”. Choose where Niko gets the forecast, and in what order.">
      <NoteLine note={note} />
      <div className="kn-page">
        <div className="kn-main">
          <section className="g kn-card">
            <div className="kn-head"><b className="kn-h">1 · Where Niko gets the weather</b><span className="srow-hint">If one is down or at its limit, Niko uses the next</span></div>
            <div className="wx-chain">
              <span className="srow-hint">{on.length ? 'For a weather question, Niko tries:' : 'Nothing is on.'}</span>
              <span className="wx-pills">{on.length ? on.map((x, i) => <span key={x.id} className="wx-pill-wrap"><span className={'wx-pill' + (i === 0 ? ' first' : '')}>{i + 1} · {x.name}</span>{i < on.length - 1 && <span aria-hidden="true" className="wx-arrow">→</span>}</span>)
                : <span className="wx-pill warn">Weather isn’t set up</span>}</span>
            </div>
            {st.list.length ? (
              <ol className="wx-list">
                {st.list.map((x, i) => (
                  <li key={x.id} className={x.on ? '' : 'off'}>
                    <span className="wx-n" aria-hidden="true">{i + 1}</span>
                    <span className="dsp-t"><span className="wx-name"><b>{x.name}</b><span className="kn-pill">{x.badge}</span></span><span className="srow-hint">{x.what}</span></span>
                    <span className="wx-move"><button type="button" className="ib" aria-label={`Move ${x.name} up`} disabled={i === 0 || busy} onClick={() => move(i, -1)}>↑</button><button type="button" className="ib" aria-label={`Move ${x.name} down`} disabled={i === st.list.length - 1 || busy} onClick={() => move(i, 1)}>↓</button></span>
                    <Switch on={x.on} disabled={busy} onChange={(v) => void save({ off: v ? off.filter((o) => o !== x.id) : [...off, x.id] })} label={`Use ${x.name}`} />
                  </li>
                ))}
              </ol>
            ) : <p className="srow-hint">No weather sources are included in your plan yet.</p>}
            {!on.length && !!st.list.length && <span className="wx-warn">No weather source is on. Niko will say weather isn’t set up when you ask.</span>}
            {st.canAdd && <div className="wx-add"><Link className="sec" to="/engine/data">+ Add a weather source</Link><span className="srow-hint">Opens Engine · Data sources, where you can add one of your own and use it as weather.</span></div>}
          </section>
          <section className="g kn-card">
            <b className="kn-h">2 · Your weather settings</b>
            <form className="wx-row" onSubmit={(e) => { e.preventDefault(); if (home.trim() !== st.home) void save({ home: home.trim() }, home.trim() ? 'Home place saved.' : 'Home place removed.'); }}>
              <span className="dsp-t"><span>Home place</span><span className="srow-hint">Used when your location is off. Checked as you save.</span></span>
              <span className="wx-home"><input className="in" aria-label="Home place" value={home} maxLength={120} placeholder="Singapore" onChange={(e) => setHome(e.target.value)} />{home.trim() !== st.home && <button type="submit" className="pri" disabled={busy}>Save</button>}</span>
            </form>
            <div className="wx-row"><span>Temperature</span><Segmented value={st.units} options={[['C', '°C'], ['F', '°F']] as const} onChange={(v) => void save({ units: v })} label="Temperature" disabled={busy} /></div>
            <div className="wx-row"><span className="dsp-t"><span>Use my location for weather questions</span><span className="srow-hint">Rounded to about 1 km, sent only with weather questions, never stored.</span></span><Switch on={st.location} disabled={busy} onChange={(v) => void save({ location: v })} label="Use my location for weather questions" /></div>
          </section>
        </div>
        <aside className="kn-aside" aria-label="How weather works">
          <span className="k">How weather works</span>
          {st.omInPlan && <p>Open-Meteo comes with Niko and needs no key. You can switch it off, add other weather sources, and choose the order.</p>}
          <p>Niko tries the first source that’s on, then the next if it can’t answer. Answers credit the source.</p>
          <p>Forecasts are kept for 15 minutes and place lookups for 7 days, so repeat questions are quick.</p>
          <p><Link to="/connections">Back to Connections</Link></p>
        </aside>
      </div>
    </SettingsPage>
  );
}
