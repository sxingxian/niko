// Engine · Data sources (as the Engine-Data-Sources mockup): the person's sources (included in their plan and turned
// on, and their own), sources their plan includes that are ready to turn on, and adding their own when allowed.
// Keys are typed here and sent once; they never come back.
import { useCallback, useEffect, useRef, useState, type SyntheticEvent } from 'react';
import { Link } from 'react-router-dom';
import { actionLine, type DataSourceInfo } from '@niko/shared';
import { ActionsStep, AddressStep, addressProblem, api, draftOf, emptyDraft, Switch, TestLines, type SourceDraft, type TestResult } from '@niko/ui';
import { useNiko } from '../niko';
import { NoteLine, SettingsPage } from './Settings';

type Src = DataSourceInfo & { on: boolean };
type St = { canAdd: boolean; calls: { limit: number; used: number }; offered: Src[]; mine: Src[]; actionsOff: string[] };
type Note = { ok: boolean; text: string } | null;
const IconPlus = () => <svg className="kn-ic sm" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>;
const kinds = (s: DataSourceInfo) => [s.actions.some((a) => a.live) ? 'Live' : 'Data'];
const what = (s: DataSourceInfo) => s.actions.filter((a) => a.on).map((a) => a.name).slice(0, 4).join(' · ') || 'Nothing switched on';

export function DataSources() {
  const { refreshMe } = useNiko();
  const [st, setSt] = useState<St | null>(null);
  const [note, setNote] = useState<Note>(null);
  const [detail, setDetail] = useState<Src | null>(null);
  const [adding, setAdding] = useState<{ edit?: Src } | null>(null);
  const [keyFor, setKeyFor] = useState<Src | null>(null);
  const load = useCallback(() => api<St>('/data').then((r) => { setSt(r); return r; }).catch((e) => { setNote({ ok: false, text: (e as Error).message }); return null; }), []);
  useEffect(() => { void load(); }, [load]);
  if (!st) return <SettingsPage title="Engine · Data sources" sub="Connect data sites so Niko can answer from them."><NoteLine note={note} /></SettingsPage>;
  const yours = [...st.offered.filter((s) => s.on), ...st.mine];
  const ready = st.offered.filter((s) => !s.on);
  const turnOn = async (s: Src, key?: string) => {
    setNote(null);
    try { await api(`/data/included/${s.id}`, { method: 'PUT', body: { on: true, ...(key ? { key } : {}) } }); await load(); setNote({ ok: true, text: `${s.name} is on.` }); setKeyFor(null); }
    catch (e) { setNote({ ok: false, text: (e as Error).message }); }
  };
  const step = (n: number) => String(n);
  return (
    <SettingsPage title="Engine · Data sources" sub="Connect data sites so Niko can answer from them: live answers like air quality now, asked when you ask.">
      <NoteLine note={note} />
      <div className="kn-page">
        <div className="kn-main">
          <section className="g kn-card">
            <div className="kn-head"><b className="kn-h">{step(1)} · Your data sources</b><span className="srow-hint">Keys stay on Niko’s server</span></div>
            {yours.length ? (
              <ul className="dsp-list">
                {yours.map((s) => (
                  <li key={s.id}>
                    <span className="dsp-t"><b>{s.name}</b><span className="srow-hint">{what(s)}</span></span>
                    <span className="dsp-tags">{kinds(s).map((k) => <span key={k} className={'kn-pill' + (k === 'Live' ? ' rec' : '')}>{k}</span>)}</span>
                    <span className="srow-hint dsp-from">{s.own ? 'Added by you' : 'Included in your plan'}</span>
                    <span className={'dsp-state' + (s.own && !s.on ? ' off' : '')}><i aria-hidden="true" />{s.own && !s.on ? 'Not in your plan now' : 'Ready'}</span>
                    <button type="button" className="sec dsp-b" onClick={() => setDetail(s)}>Details</button>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="dsp-empty"><b>No data sources yet</b><span className="srow-hint">Niko answers from what it knows, what it finds online and your apps. Add a data source and it can answer from that too.</span></div>
            )}
            {st.calls.limit > 0 && <span className="srow-hint">{st.calls.used.toLocaleString()} of {st.calls.limit.toLocaleString()} data calls used this month, included in your plan. Answers reused from a moment ago aren’t counted.</span>}
          </section>
          {ready.length > 0 && (
            <section className="g kn-card">
              <div className="kn-head"><b className="kn-h">{step(2)} · Included in your plan</b><span className="srow-hint">Ready to turn on</span></div>
              <ul className="dsp-list">
                {ready.map((s) => (
                  <li key={s.id} className="two">
                    <span className="dsp-t"><b>{s.name}</b><span className="srow-hint">{what(s)}{s.termsNote ? ` · ${s.termsNote}` : ''}</span></span>
                    <button type="button" className="pri dsp-b" onClick={() => (s.keyMode === 'own' && s.auth !== 'none' && !s.hasKey ? setKeyFor(s) : void turnOn(s))}>Turn on</button>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {st.canAdd && (
            <section className="g kn-card dsp-add">
              <span className="dsp-t"><b className="kn-h">{step(ready.length ? 3 : 2)} · Add your own</b><span className="srow-hint">Any data site or your company’s system with an API: an https address, a key if it needs one, and what Niko may ask it. Only you can use it.</span></span>
              <button type="button" className="pri dsp-b" onClick={() => setAdding({})}><IconPlus />Add a data source</button>
            </section>
          )}
        </div>
        <aside className="kn-aside" aria-label="How data sources work">
          <span className="k">How data sources work</span>
          <p>Niko asks a source when your question needs it, and answers say where the data came from and when.</p>
          <p>Niko only asks a source what you allowed.</p>
          <p>Nothing is connected until you or your plan adds it.</p>
          <span className="k">Private</span>
          <p>Only what an action needs is sent, such as a region or an order number. Your keys never leave Niko’s server.</p>
          <p>Your own sources must use https and a public address.</p>
          <p><Link to="/engine">Back to Engine</Link></p>
        </aside>
      </div>
      {detail && <Details s={detail} off={st.actionsOff} onClose={() => setDetail(null)} onEdit={() => { setAdding({ edit: detail }); setDetail(null); }}
        onChanged={async (text) => { const r = await load(); setDetail(r ? [...r.offered, ...r.mine].find((x) => x.id === detail.id) ?? null : null); if (text) setNote({ ok: true, text }); }}
        onGone={async (text) => { setDetail(null); await load(); await refreshMe(); setNote({ ok: true, text }); }} />}
      {adding && <AddOwn edit={adding.edit} onClose={() => setAdding(null)} onSaved={async (text) => { setAdding(null); await load(); await refreshMe(); setNote({ ok: true, text }); }} />}
      {keyFor && <KeySheet s={keyFor} onClose={() => setKeyFor(null)} onKey={(k) => turnOn(keyFor, k)} />}
    </SettingsPage>
  );
}

function useSheet(onClose: () => void) {
  const dlg = useRef<HTMLDialogElement>(null);
  useEffect(() => { dlg.current?.showModal(); }, []);
  return { ref: dlg, onCancel: (e: SyntheticEvent) => { e.preventDefault(); onClose(); } };
}

function Details({ s, off, onClose, onEdit, onChanged, onGone }: { s: Src; off: string[]; onClose: () => void; onEdit: () => void; onChanged: (text?: string) => Promise<void>; onGone: (text: string) => Promise<void> }) {
  const sheet = useSheet(onClose);
  const [tests, setTests] = useState<TestResult[] | null>(null);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const toggle = async (id: string, on: boolean) => {
    setErr('');
    try { await api('/data/actions', { method: 'PUT', body: { source: s.id, action: id, on } }); await onChanged(); } catch (e) { setErr((e as Error).message); }
  };
  const test = async () => { setBusy('test'); setErr(''); try { setTests((await api<{ results: TestResult[] }>('/data/test', { body: { id: s.id } })).results); } catch (e) { setErr((e as Error).message); } finally { setBusy(''); } };
  const remove = async () => {
    setBusy('remove'); setErr('');
    try {
      if (s.own) await api(`/data/sources/${s.id}`, { method: 'DELETE' }); else await api(`/data/included/${s.id}`, { method: 'PUT', body: { on: false } });
      await onGone(s.own ? `${s.name} removed.` : `${s.name} is off.`);
    } catch (e) { setErr((e as Error).message); setBusy(''); }
  };
  return (
    <dialog ref={sheet.ref} className="ds-sheet" aria-label={`${s.name} details`} onCancel={sheet.onCancel}>
      <div className="ds-sheet-in">
        <div className="ds-sheet-h"><b>{s.name}</b><span className="ds-hint">{s.own ? 'Added by you' : 'Included in your plan'}</span></div>
        <span className="k">What Niko can ask</span>
        <ul className="ds-actions">
          {s.actions.filter((a) => a.on).map((a) => {
            const on = !off.includes(`${s.id}:${a.id}`);
            return (
              <li key={a.id}>
                <span className="ds-a-t"><span>{a.name}</span><span className="ds-hint">{actionLine(a)}</span>{a.example && <span className="ds-hint dim">e.g. {a.example}</span>}</span>
                <Switch on={on} onChange={(v) => void toggle(a.id, v)} label={a.name} />
              </li>
            );
          })}
        </ul>
        <span className="ds-hint">{s.own ? 'Added by you. Read-only actions only.' : `Included in your plan${s.keyMode === 'own' && s.auth !== 'none' ? ', with your key' : s.auth !== 'none' ? ', with its own key, so you don’t need one' : ''}.`}{s.attribution ? ` Answers credit it as “${s.attribution}”.` : ''}</span>
        <TestLines results={tests} />
        {err && <p className="ds-err" role="alert">{err}</p>}
        <div className="ds-end">
          <button type="button" className="sec left dsp-danger" disabled={!!busy} onClick={() => void remove()}>{s.own ? 'Remove' : 'Turn off'}</button>
          {s.own && <button type="button" className="sec" onClick={onEdit}>Change</button>}
          <button type="button" className="sec" disabled={!!busy} onClick={() => void test()}>{busy === 'test' ? 'Testing…' : 'Test'}</button>
          <button type="button" className="pri" onClick={onClose}>Done</button>
        </div>
      </div>
    </dialog>
  );
}

function KeySheet({ s, onClose, onKey }: { s: Src; onClose: () => void; onKey: (key: string) => Promise<void> }) {
  const sheet = useSheet(onClose);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <dialog ref={sheet.ref} className="ds-sheet" aria-label={`Your key for ${s.name}`} onCancel={sheet.onCancel}>
      <form className="ds-sheet-in" onSubmit={async (e) => { e.preventDefault(); setBusy(true); await onKey(key.trim()); setBusy(false); }}>
        <div className="ds-sheet-h"><b>Your key for {s.name}</b></div>
        <span className="ds-hint">{s.name} asks each person for their own key.{s.termsNote ? ` ${s.termsNote}` : ''} It’s kept encrypted on Niko’s server and never shown again.</span>
        <label className="fld"><span className="k">Key</span><input className="in" type="password" autoComplete="off" value={key} maxLength={500} onChange={(e) => setKey(e.target.value)} autoFocus /></label>
        <div className="ds-end"><button type="button" className="sec" onClick={onClose}>Cancel</button><button type="submit" className="pri" disabled={!key.trim() || busy}>{busy ? 'Turning on…' : 'Turn on'}</button></div>
      </form>
    </dialog>
  );
}

/** Add a data source (or change one of their own): 1 · Address and sign-in, 2 · What Niko can ask, 3 · Test and save. */
function AddOwn({ edit, onClose, onSaved }: { edit?: Src; onClose: () => void; onSaved: (text: string) => Promise<void> }) {
  const sheet = useSheet(onClose);
  const [d, setD] = useState<SourceDraft>(() => (edit ? draftOf(edit) : emptyDraft()));
  const [stepN, setStep] = useState(1);
  const [err, setErr] = useState('');
  const [tests, setTests] = useState<TestResult[] | null>(null);
  const [busy, setBusy] = useState('');
  const set = (p: Partial<SourceDraft>) => { setD((x) => ({ ...x, ...p })); setErr(''); if (p.actions || p.baseUrl || p.key !== undefined || p.auth || p.authName !== undefined) setTests(null); };
  const p1 = addressProblem(d, !!edit?.hasKey), kept = d.actions.filter((a) => a.on).length;
  const body = () => ({ ...d, termsOk: d.termsOk });
  const test = async () => {
    setBusy('test'); setErr('');
    try { setTests((await api<{ results: TestResult[] }>('/data/test', { body: { id: edit?.id, draft: body() } })).results); } catch (e) { setErr((e as Error).message); } finally { setBusy(''); }
  };
  const go = (n: number) => { if (n > 1 && p1) return setErr(p1); if (n > 2 && !kept) return setErr('Keep at least one thing Niko can ask.'); setErr(''); setStep(n); if (n === 3 && !tests) void test(); };
  const save = async () => {
    setBusy('save'); setErr('');
    try {
      if (edit) await api(`/data/sources/${edit.id}`, { method: 'PUT', body: body() }); else await api('/data/sources', { body: body() });
      await onSaved(edit ? `${d.name} saved.` : `${d.name} added. Only you can use it.`);
    } catch (e) { setErr((e as Error).message); setBusy(''); }
  };
  return (
    <dialog ref={sheet.ref} className="ds-sheet" aria-label={edit ? `Change ${edit.name}` : 'Add a data source'} onCancel={sheet.onCancel}>
      <div className="ds-sheet-in">
        <div className="ds-sheet-h"><b>{edit ? `Change ${edit.name}` : 'Add a data source'}</b></div>
        <div className="ds-steps" role="group" aria-label="Steps">
          {['Address and sign-in', 'What Niko can ask', 'Test and save'].map((t, i) => <button key={t} type="button" aria-current={stepN === i + 1 ? 'step' : undefined} onClick={() => go(i + 1)}>{i + 1} · {t}</button>)}
        </div>
        {stepN === 1 && <AddressStep d={d} set={set} admin={false} hasKey={!!edit?.hasKey} />}
        {stepN === 2 && <ActionsStep d={d} set={set} onBase={(url) => set({ baseUrl: url })} />}
        {stepN === 3 && <div className="ds-step">
          {busy === 'test' && <span className="ds-hint" role="status">Testing each action…</span>}
          <TestLines results={tests} />
          {tests && tests.some((t) => !t.ok) && <span className="ds-hint">An action that didn’t pass can still be saved; check its test value or path, or leave it out.</span>}
          <button type="button" className="sec" style={{ alignSelf: 'flex-start', height: 40, fontSize: 13 }} disabled={!!busy} onClick={() => void test()}>Test again</button>
          <label className="ds-check"><input type="checkbox" checked={d.termsOk} onChange={(e) => set({ termsOk: e.target.checked })} />This source’s terms let me use it this way.</label>
        </div>}
        {err && <p className="ds-err" role="alert">{err}</p>}
        <div className="ds-end">
          <button type="button" className="sec" onClick={onClose}>Cancel</button>
          {stepN < 3 ? <button type="button" className="pri" onClick={() => go(stepN + 1)}>Next</button>
            : <button type="button" className="pri" disabled={!d.termsOk || !!busy} onClick={() => void save()}>{busy === 'save' ? 'Saving…' : 'Save'}</button>}
        </div>
      </div>
    </dialog>
  );
}
