// Admin · Data sources (as the Admin-Data-Sources mockup): the sources you add, then who can use them: a default for
// everyone and changes for any person, as on AI options. Nothing is built in. Keys are typed once and never shown again.
import { useCallback, useEffect, useRef, useState, type SyntheticEvent } from 'react';
import { DATA_CALL_STEPS, type DataAccess, type DataDefaults, type DataOffer, type DataSourceInfo } from '@niko/shared';
import { ActionsStep, AddressStep, addressProblem, api, ApiError, draftOf, emptyDraft, Switch, TestLines, type SourceDraft, type TestResult } from '@niko/ui';

type Src = DataSourceInfo & { calls: number };
type Person = { id: string; name: string; email: string; role: string; status: string; dataAccess: DataAccess; calls: number };
type St = { defaults: DataDefaults; openMeteo: { key: boolean }; sources: Src[]; own: { sources: number; people: number; calls: number }; users: Person[] };
type Note = { ok: boolean; text: string } | null;
const OFFER: Record<DataOffer, string> = { everyone: 'Everyone', chosen: 'People you choose', nobody: 'Nobody yet' };
const callsName = (n: number) => (n ? n.toLocaleString() : 'No limit');

export function DataSourcesAdmin({ guard }: { guard: (e: unknown) => void }) {
  const [st, setSt] = useState<St | null>(null);
  const [tab, setTab] = useState<'src' | 'who'>('src');
  const [note, setNote] = useState<Note>(null);
  const [editing, setEditing] = useState<{ src?: Src } | null>(null);
  const [menu, setMenu] = useState<string | null>(null);
  const [tests, setTests] = useState<{ id: string; results: TestResult[]; note?: string } | null>(null);
  const [omKey, setOmKey] = useState(false);
  const load = useCallback(async () => { try { setSt(await api<St>('/admin/data')); } catch (e) { guard(e); } }, [guard]);
  useEffect(() => { void load(); }, [load]);
  if (!st) return null;
  const fail = (e: unknown) => { if (e instanceof ApiError && e.status === 401) guard(e); else setNote({ ok: false, text: (e as Error).message }); };
  const saveOm = async (key: string) => {
    setMenu(null); setNote(null);
    try { await api('/admin/data/open-meteo', { method: 'PUT', body: { key } }); setOmKey(false); await load(); setNote({ ok: true, text: key ? 'Open-Meteo’s paid plan key saved. Niko now uses its customer service.' : 'Open-Meteo’s key removed. Niko uses its free service.' }); }
    catch (e) { fail(e); }
  };
  const test = async (s: Src) => { setMenu(null); setNote(null); try { const r = await api<{ results: TestResult[]; note?: string }>('/admin/data/test', { body: { id: s.id } }); setTests({ id: s.id, ...r }); } catch (e) { fail(e); } };
  const remove = async (s: Src) => {
    setMenu(null);
    if (!window.confirm(`Remove ${s.name}? Everyone using it loses it, and keys people added for it are deleted.`)) return;
    try { await api(`/admin/data/sources/${s.id}`, { method: 'DELETE' }); await load(); setNote({ ok: true, text: `${s.name} removed.` }); } catch (e) { fail(e); }
  };
  return <>
    <header><h1>Data sources</h1><p className="sub" style={{ fontSize: 15, maxWidth: 820 }}>Add the data sites Niko may use, then choose who gets each one. Only Open-Meteo for weather comes built in, and you can switch it off. You see counts, never what people asked.</p></header>
    <div className="dsa-tabs" role="tablist" aria-label="Data sources">
      <button role="tab" className="seg" aria-selected={tab === 'src'} aria-pressed={tab === 'src'} onClick={() => setTab('src')}>Sources</button>
      <button role="tab" className="seg" aria-selected={tab === 'who'} aria-pressed={tab === 'who'} onClick={() => setTab('who')}>Who can use them</button>
    </div>
    {note && <p className={note.ok ? 'ok' : 'err'} role="status">{note.text}</p>}
    {tab === 'src' ? (
      <section className="g card" aria-label="Sources">
        <div className="card-head"><div><h2 style={{ fontWeight: 500, fontSize: 22 }}>Sources</h2><p className="sub" style={{ fontSize: 13 }}>Open-Meteo is built in; the rest are ones you added. People see them as included in their plan.</p></div><button className="pri" style={{ height: 44, fontSize: 14 }} onClick={() => setEditing({})}>Add a source</button></div>
        <div className="dsa-table" role="table" aria-label="Sources">
            <div className="dsa-tr head" role="row"><span className="k" role="columnheader">Source</span><span className="k" role="columnheader">Kind</span><span className="k" role="columnheader">Offered to</span><span className="k" role="columnheader">Terms</span><span role="columnheader" /></div>
            <div role="row">
              <div className="dsa-tr">
                <span className="dsa-t" role="cell"><span className="dsa-name"><b>Open-Meteo</b><span className="lim-badge">Built in</span></span><span className="sub">Weather · built in · can’t be removed, can be switched off on Who can use them</span></span>
                <span className="sub dsa-c" role="cell">Weather</span>
                <span className="sub dsa-c" role="cell">{st.defaults.om ? 'Everyone' : 'Nobody by default'}</span>
                <span className={'dsa-terms' + (st.openMeteo.key ? ' is-ok' : '')} role="cell"><i aria-hidden="true" />{st.openMeteo.key ? 'Paid plan key added' : 'Needs its paid plan key'}</span>
                <span className="dsa-more" role="cell">
                  <button className="lnk" aria-label="More for Open-Meteo" aria-expanded={menu === 'om'} onClick={() => setMenu(menu === 'om' ? null : 'om')} style={{ fontSize: 18, color: '#fff' }}>⋯</button>
                  {menu === 'om' && <span className="dsa-menu g" role="menu">
                    <button role="menuitem" onClick={() => { setMenu(null); setOmKey(true); }}>{st.openMeteo.key ? 'Change paid plan key' : 'Add paid plan key'}</button>
                    {st.openMeteo.key && <button role="menuitem" className="danger" onClick={() => void saveOm('')}>Remove key</button>}
                  </span>}
                </span>
              </div>
            </div>
        {st.sources.length ? (<>
            {st.sources.map((s) => (
              <div key={s.id} role="row">
                <div className="dsa-tr">
                  <span className="dsa-t" role="cell"><b>{s.name}</b><span className="sub">{s.actions.filter((a) => a.on).map((a) => a.name).slice(0, 4).join(' · ')}{s.calls ? ` · ${s.calls.toLocaleString()} calls this month` : ''}</span></span>
                  <span className="sub dsa-c" role="cell">{s.use === 'live' ? 'Live' : s.use === 'weather' ? 'Weather' : 'Data'}</span>
                  <span className="sub dsa-c" role="cell">{OFFER[s.offer]}{s.auth !== 'none' && s.keyMode === 'own' ? ' · each adds a key' : ''}</span>
                  <span className={'dsa-terms' + (s.termsOk ? ' is-ok' : '')} role="cell"><i aria-hidden="true" />{s.termsOk ? 'OK for paid use' : 'Not confirmed · off'}</span>
                  <span className="dsa-more" role="cell">
                    <button className="lnk" aria-label={`More for ${s.name}`} aria-expanded={menu === s.id} onClick={() => setMenu(menu === s.id ? null : s.id)} style={{ fontSize: 18, color: '#fff' }}>⋯</button>
                    {menu === s.id && <span className="dsa-menu g" role="menu">
                      <button role="menuitem" onClick={() => { setMenu(null); setEditing({ src: s }); }}>Change</button>
                      <button role="menuitem" onClick={() => void test(s)}>Test</button>
                      <button role="menuitem" className="danger" onClick={() => void remove(s)}>Remove</button>
                    </span>}
                  </span>
                </div>
                {tests?.id === s.id && <div className="dsa-tests">{tests.note ? <p className="sub" style={{ fontSize: 13 }}>{tests.note}</p> : <TestLines results={tests.results} />}</div>}
              </div>
            ))}
          </>
        ) : null}
        </div>
        {!st.sources.length && (
          <div className="dsa-empty"><b>No data sources yet</b><span className="sub">Add a data site or an API, then choose who gets it. People can also add their own if you allow it on Who can use them.</span><button className="pri" style={{ height: 44, fontSize: 14, marginTop: 6 }} onClick={() => setEditing({})}>Add a source</button></div>
        )}
        {!st.openMeteo.key && <p className="sub" style={{ fontSize: 12, lineHeight: 1.5 }}>Open-Meteo’s free service is for non-commercial use. Add its paid plan key before people use it in Niko as a paid service.</p>}
        <p className="sub" style={{ fontSize: 12, lineHeight: 1.5 }}>Sources people add themselves are private to them and not listed here: {st.own.sources ? `${st.own.sources} from ${st.own.people} ${st.own.people === 1 ? 'person' : 'people'}, ${st.own.calls.toLocaleString()} calls this month` : 'none so far'}. Keys are kept encrypted and never shown again.</p>
      </section>
    ) : <WhoCanUse st={st} reload={load} fail={fail} setNote={setNote} />}
    {omKey && <OmKeySheet has={st.openMeteo.key} onClose={() => setOmKey(false)} onSave={saveOm} />}
    {editing && <SourceSheet src={editing.src} onClose={() => setEditing(null)} onSaved={async (text) => { setEditing(null); await load(); setNote({ ok: true, text }); }} />}
  </>;
}

/** Who can use them: the default for everyone, and changes per person. */
function WhoCanUse({ st, reload, fail, setNote }: { st: St; reload: () => Promise<void>; fail: (e: unknown) => void; setNote: (n: Note) => void }) {
  const [sel, setSel] = useState('all');
  const [find, setFind] = useState('');
  const person = st.users.find((p) => p.id === sel) ?? null;
  const defOf = (k: string): boolean | number | string => (k === 'own' ? st.defaults.own : k === 'ds' ? st.defaults.ds : k === 'om' ? st.defaults.om : k === 'calls' ? st.defaults.calls : k === 'wxFirst' ? st.defaults.wxFirst : st.sources.find((s) => `src:${s.id}` === k)?.offer === 'everyone');
  const [draft, setDraft] = useState<Record<string, boolean | number | string>>({});
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setDraft(person ? { ...person.dataAccess } : {}); setDirty(false); }, [sel, st]); // eslint-disable-line react-hooks/exhaustive-deps
  const val = (k: string) => (k in draft ? draft[k]! : defOf(k));
  const changed = (k: string) => !!person && k in draft && draft[k] !== defOf(k);
  const set = (k: string, v: boolean | number | string) => { setDirty(true); setNote(null); const n = { ...draft }; if (person && v === defOf(k)) delete n[k]; else n[k] = v; setDraft(n); };
  const reset = (k: string) => { const n = { ...draft }; delete n[k]; setDraft(n); setDirty(true); };
  const count = (p: Person) => Object.keys(p.dataAccess).length;
  const save = async () => {
    setBusy(true);
    try {
      if (person) await api(`/admin/data/users/${person.id}`, { method: 'PUT', body: { access: draft } });
      else await api('/admin/data/default', { method: 'PUT', body: { own: val('own'), ds: val('ds'), om: val('om'), wxFirst: val('wxFirst'), calls: val('calls'), sources: Object.fromEntries(st.sources.map((s) => [s.id, val(`src:${s.id}`)])) } });
      await reload(); setNote({ ok: true, text: person ? `Saved for ${person.name || person.email}.` : 'Saved for everyone.' });
    } catch (e) { fail(e); } finally { setBusy(false); }
  };
  const row = (k: string, name: string, sub: string, control: 'switch' | 'calls' | 'wx', disabled = false) => (
    <div key={k} className="ai-row">
      <span className="ai-txt"><span>{name}</span><span className="sub">{changed(k) ? `Default is ${control === 'calls' ? callsName(defOf(k) as number) : defOf(k) ? 'on' : 'off'}` : sub}</span></span>
      {changed(k) && <><span className="chg">Changed</span><button className="lnk" onClick={() => reset(k)}>Reset</button></>}
      {control === 'wx' ? <select className="in sel" aria-label={name} value={String(val(k))} onChange={(e) => set(k, e.target.value)}><option value="om">Open-Meteo first</option><option value="others">Other weather sources first</option></select>
        : control === 'switch' ? <Switch on={!!val(k)} onChange={(v) => set(k, v)} label={name} disabled={disabled} />
        : <select className="in sel" aria-label={name} value={String(val(k))} onChange={(e) => set(k, Number(e.target.value))}>{DATA_CALL_STEPS.map((n) => <option key={n} value={n}>{callsName(n)}</option>)}</select>}
    </div>
  );
  return (
    <div className="ai-grid">
      <section className="g card ai-people" aria-label="Applies to">
        <span className="k" style={{ padding: '0 6px' }}>Applies to</span>
        <input className="in lim-find" type="search" aria-label="Find a person" placeholder="Find a person" value={find} onChange={(e) => setFind(e.target.value)} />
        <div className="ai-list">
          {[{ id: 'all', name: 'Everyone', sub: 'The default for all accounts', badge: 'Default', tone: '' }, ...st.users.filter((p) => !find.trim() || `${p.name} ${p.email}`.toLowerCase().includes(find.trim().toLowerCase())).map((p) => ({ id: p.id, name: p.name || p.email, sub: p.email, badge: p.role === 'admin' ? 'Admin' : count(p) ? `${count(p)} ${count(p) === 1 ? 'change' : 'changes'}` : 'Default', tone: p.role === 'admin' ? ' is-free' : count(p) ? ' is-chg' : '' }))].map((p) => (
            <button key={p.id} className="who-row" aria-pressed={p.id === sel} onClick={() => { if (dirty && !window.confirm('Leave without saving these changes?')) return; setSel(p.id); setNote(null); }}>
              <span className="who-txt"><b>{p.name}</b><span>{p.sub}</span></span><span className={'lim-badge' + p.tone}>{p.badge}</span>
            </button>
          ))}
        </div>
      </section>
      <section className="g card ai-options" aria-label="Who can use them">
        <div className="ai-head">
          <div><h2>{person ? person.name || person.email : 'Everyone · default'}</h2><p className="sub" style={{ fontSize: 13 }}>{person ? (person.role === 'admin' ? 'Admins can use every source; these apply if they are made a member.' : Object.keys(draft).length ? `${Object.keys(draft).length} different from the default.` : 'Follows the default.') : 'What every account gets, unless changed for that person.'}{person ? ` ${person.calls.toLocaleString()} calls this month.` : ''}</p></div>
          <div className="ai-acts">
            {person && <button className="bt" onClick={() => { setDraft({}); setDirty(true); }} disabled={!Object.keys(draft).length}>Reset to default</button>}
            <button className="pri" style={{ height: 44, fontSize: 14 }} onClick={() => void save()} disabled={busy || !dirty}>{busy ? 'Saving…' : 'Save'}</button>
          </div>
        </div>
        <span className="k dsa-gh">Weather</span>
        {row('om', 'Open-Meteo (built in)', st.openMeteo.key ? 'They can still switch it off and add other weather sources' : 'Add its paid plan key before people use it in Niko', 'switch')}
        {!person && row('wxFirst', 'Weather order for new accounts', 'They can change the order in Connections · Weather', 'wx')}
        <span className="k dsa-gh">Sources you added</span>
        {st.sources.length ? st.sources.map((s) => row(`src:${s.id}`, s.name, s.termsOk ? s.actions.filter((a) => a.on).map((a) => a.name).slice(0, 3).join(' · ') : 'Confirm its terms (Change) before anyone can use it', 'switch', !s.termsOk))
          : <p className="sub" style={{ fontSize: 13, padding: '14px 0', borderTop: '1px solid rgba(255,255,255,.1)' }}>No sources added yet. Add one on the Sources tab.</p>}
        <span className="k dsa-gh">Their own sources</span>
        {row('own', 'Let them add their own', 'Private to them · https, public addresses, read-only actions', 'switch')}
        <span className="k dsa-gh">Datasets and limits</span>
        {row('ds', 'Import datasets into Knowledge', 'Needs Knowledge files kept in Niko; counts toward their space', 'switch')}
        {row('calls', 'Data calls each month', 'Answers reused from a moment ago aren’t counted', 'calls')}
      </section>
    </div>
  );
}

/** Add a source (or change one): 1 · Address and sign-in, 2 · What Niko can ask, 3 · Terms, 4 · Who gets it. */
function SourceSheet({ src, onClose, onSaved }: { src?: Src; onClose: () => void; onSaved: (text: string) => Promise<void> }) {
  const dlg = useRef<HTMLDialogElement>(null);
  useEffect(() => { dlg.current?.showModal(); }, []);
  const [d, setD] = useState<SourceDraft>(() => (src ? draftOf(src) : emptyDraft()));
  const [stepN, setStep] = useState(1);
  const [err, setErr] = useState('');
  const [tests, setTests] = useState<TestResult[] | null>(null);
  const [testNote, setTestNote] = useState('');
  const [busy, setBusy] = useState('');
  const set = (p: Partial<SourceDraft>) => { setD((x) => ({ ...x, ...p })); setErr(''); };
  const p1 = addressProblem(d, !!src?.hasKey), kept = d.actions.filter((a) => a.on).length;
  const go = (n: number) => { if (n > 1 && p1) return setErr(p1); if (n > 2 && !kept) return setErr('Keep at least one thing Niko can ask.'); setErr(''); setStep(n); };
  const test = async () => {
    setBusy('test'); setErr(''); setTestNote('');
    try { const r = await api<{ results: TestResult[]; note?: string }>('/admin/data/test', { body: { id: src?.id, draft: d } }); setTests(r.results); setTestNote(r.note ?? ''); } catch (e) { setErr((e as Error).message); } finally { setBusy(''); }
  };
  const save = async () => {
    setBusy('save'); setErr('');
    const body = { ...d, offer: d.termsOk ? d.offer : 'nobody' };
    try {
      if (src) await api(`/admin/data/sources/${src.id}`, { method: 'PUT', body }); else await api('/admin/data/sources', { body });
      await onSaved(!d.termsOk ? `${d.name} saved, switched off until its terms are confirmed.` : body.offer === 'everyone' ? `Saved. ${d.name} is now included for everyone.` : body.offer === 'chosen' ? `Saved. Turn ${d.name} on for people on Who can use them.` : `${d.name} saved, offered to nobody yet.`);
    } catch (e) { setErr((e as Error).message); setBusy(''); }
  };
  const close = (e?: SyntheticEvent) => { e?.preventDefault(); dlg.current?.close(); onClose(); };
  return (
    <dialog ref={dlg} className="ds-sheet" aria-label={src ? `Change ${src.name}` : 'Add a source'} onCancel={close}>
      <div className="ds-sheet-in">
        <div className="ds-sheet-h"><b>{src ? `Change ${src.name}` : 'Add a source'}</b></div>
        <div className="ds-steps" role="group" aria-label="Steps">
          {['Address and sign-in', 'What Niko can ask', 'Terms', 'Who gets it'].map((t, i) => <button key={t} type="button" aria-current={stepN === i + 1 ? 'step' : undefined} onClick={() => go(i + 1)}>{i + 1} · {t}</button>)}
        </div>
        {stepN === 1 && <AddressStep d={d} set={set} admin hasKey={!!src?.hasKey} />}
        {stepN === 2 && <ActionsStep d={d} set={set} onBase={(url) => set({ baseUrl: url })} />}
        {stepN === 3 && <div className="ds-step">
          <label className="ds-check"><input type="checkbox" checked={d.termsOk} onChange={(e) => set({ termsOk: e.target.checked })} />Its terms allow use in a paid service like Niko.</label>
          <label className="fld"><span className="k">Terms note (people see this)</span><input className="in" value={d.termsNote} maxLength={300} onChange={(e) => set({ termsNote: e.target.value })} placeholder="Open data. Production key added." /></label>
          <label className="fld"><span className="k">Attribution shown in answers</span><input className="in" value={d.attribution} maxLength={120} onChange={(e) => set({ attribution: e.target.value })} placeholder="Source: data.gov.sg" /></label>
          <span className="ds-hint">If the terms need a paid plan you don’t have yet, save it with the box unticked: it stays off until you tick it.</span>
          <div className="ds-row-b"><button type="button" className="sec sm" disabled={!!busy} onClick={() => void test()}>{busy === 'test' ? 'Testing…' : 'Test each action'}</button></div>
          {testNote ? <span className="ds-hint">{testNote}</span> : <TestLines results={tests} />}
        </div>}
        {stepN === 4 && <div className="ds-step">
          <div className="ds-radios" role="radiogroup" aria-label="Who gets it">
            {(['everyone', 'chosen', 'nobody'] as DataOffer[]).map((o) => <label key={o}><input type="radio" name="offer" checked={(d.termsOk ? d.offer : 'nobody') === o} disabled={!d.termsOk && o !== 'nobody'} onChange={() => set({ offer: o })} />{o === 'everyone' ? 'Everyone, by default' : o === 'chosen' ? 'Only people I choose' : 'Nobody yet (save switched off)'}</label>)}
          </div>
          <span className="ds-hint">{d.termsOk ? 'You can change it per person on Who can use them.' : 'Until its terms are confirmed (step 3), it’s saved switched off.'}</span>
        </div>}
        {err && <p className="ds-err" role="alert">{err}</p>}
        <div className="ds-end">
          <button type="button" className="sec" onClick={() => close()}>Cancel</button>
          {stepN < 4 ? <button type="button" className="pri" onClick={() => go(stepN + 1)}>Next</button>
            : <button type="button" className="pri" disabled={!!busy} onClick={() => void save()}>{busy === 'save' ? 'Saving…' : 'Save'}</button>}
        </div>
      </div>
    </dialog>
  );
}

function OmKeySheet({ has, onClose, onSave }: { has: boolean; onClose: () => void; onSave: (key: string) => Promise<void> }) {
  const dlg = useRef<HTMLDialogElement>(null);
  useEffect(() => { dlg.current?.showModal(); }, []);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <dialog ref={dlg} className="ds-sheet" aria-label="Open-Meteo paid plan key" onCancel={(e) => { e.preventDefault(); onClose(); }}>
      <form className="ds-sheet-in" onSubmit={async (e) => { e.preventDefault(); setBusy(true); await onSave(key.trim()); setBusy(false); }}>
        <div className="ds-sheet-h"><b>Open-Meteo paid plan key</b></div>
        <span className="ds-hint">With a key, Niko uses Open-Meteo’s customer service for everyone, as its terms ask of a paid service. It’s kept encrypted and never shown again.{has ? ' A key is saved; a new one replaces it.' : ''}</span>
        <label className="fld"><span className="k">Key</span><input className="in" type="password" autoComplete="off" value={key} maxLength={200} onChange={(e) => setKey(e.target.value)} autoFocus /></label>
        <div className="ds-end"><button type="button" className="sec" onClick={onClose}>Cancel</button><button type="submit" className="pri" disabled={!key.trim() || busy}>{busy ? 'Saving…' : 'Save'}</button></div>
      </form>
    </dialog>
  );
}
