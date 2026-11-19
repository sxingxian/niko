// The form for adding or changing a data source, shared by Engine · Data sources (a person's own) and Admin · Data
// sources: address and sign-in, what Niko can ask (read-only actions, typed in or found in an OpenAPI file), and test
// results. Every check here is repeated on the server; these only show problems early.
import { useRef, useState } from 'react';
import { actionLine, DATA_USE_NAMES, type DataRefresh, cleanAction, cleanBaseUrl, fromExampleLink, openApiActions, type DataAction, type DataAuth, type DataKeyMode, type DataOffer, type DataParam, type DataParamType, type DataSourceInfo, type DataUse } from '@niko/shared';

export interface SourceDraft {
  name: string; use: DataUse; baseUrl: string; auth: DataAuth; authName: string; keyMode: DataKeyMode; key: string;
  actions: DataAction[]; termsOk: boolean; termsNote: string; attribution: string; offer: DataOffer;
}
export const emptyDraft = (): SourceDraft => ({ name: '', use: 'general', baseUrl: 'https://', auth: 'header', authName: '', keyMode: 'one', key: '', actions: [], termsOk: false, termsNote: '', attribution: '', offer: 'everyone' });
export const draftOf = (s: DataSourceInfo): SourceDraft => ({ name: s.name, use: s.use, baseUrl: s.baseUrl, auth: s.auth, authName: s.authName, keyMode: s.keyMode, key: '', actions: s.actions, termsOk: s.termsOk, termsNote: s.termsNote, attribution: s.attribution, offer: s.offer });
/** What step 1 still needs, or null. */
export function addressProblem(d: SourceDraft, hasKey: boolean): string | null {
  if (!d.name.trim()) return 'Give it a name.';
  const b = cleanBaseUrl(d.baseUrl);
  if ('problem' in b) return b.problem;
  if (d.auth !== 'none' && !/^[A-Za-z0-9_.-]{1,60}$/.test(d.authName.trim())) return d.auth === 'header' ? 'Enter the header’s name, such as X-Api-Key.' : 'Enter the name the key goes by in the address, such as api_key.';
  if (d.auth !== 'none' && d.keyMode === 'one' && !d.key.trim() && !hasKey) return 'Enter the key.';
  return null;
}

/** Step 1 · Address and sign-in. */
export function AddressStep({ d, set, admin, hasKey }: { d: SourceDraft; set: (p: Partial<SourceDraft>) => void; admin: boolean; hasKey: boolean }) {
  return (
    <div className="ds-step">
      <div className="ds-two">
        <label className="fld"><span className="k">{admin ? 'Name people see' : 'Name'}</span><input className="in" value={d.name} maxLength={60} onChange={(e) => set({ name: e.target.value })} placeholder="Acme orders" /></label>
        <label className="fld"><span className="k">Use as</span><select className="in" value={d.use} onChange={(e) => set({ use: e.target.value as DataUse })}>{(Object.keys(DATA_USE_NAMES) as DataUse[]).map((u) => <option key={u} value={u}>{DATA_USE_NAMES[u]}</option>)}</select></label>
      </div>
      <label className="fld"><span className="k">Address</span><input className="in" value={d.baseUrl} inputMode="url" autoComplete="off" spellCheck={false} onChange={(e) => set({ baseUrl: e.target.value })} placeholder="https://api.example.com" /><span className="ds-hint">https and a public address only.</span></label>
      <div className="ds-two">
        <label className="fld"><span className="k">Sign-in</span><select className="in" value={d.auth} onChange={(e) => set({ auth: e.target.value as DataAuth })}><option value="header">Key in a header</option><option value="query">Key in the address</option><option value="none">None</option></select></label>
        {d.auth !== 'none' && <label className="fld"><span className="k">{d.auth === 'header' ? 'Header name' : 'Name in the address'}</span><input className="in" value={d.authName} maxLength={60} spellCheck={false} onChange={(e) => set({ authName: e.target.value })} placeholder={d.auth === 'header' ? 'X-Api-Key' : 'api_key'} /></label>}
      </div>
      {d.auth !== 'none' && <div className="ds-two">
        {admin && <label className="fld"><span className="k">Key</span><select className="in" value={d.keyMode} onChange={(e) => set({ keyMode: e.target.value as DataKeyMode })}><option value="one">One key for everyone (yours)</option><option value="own">Each person adds their own</option></select></label>}
        {d.keyMode === 'one' && <label className="fld"><span className="k">{admin ? 'Your key' : 'Key'}</span><input className="in" type="password" autoComplete="off" value={d.key} maxLength={500} onChange={(e) => set({ key: e.target.value })} placeholder={hasKey ? 'Saved · leave empty to keep it' : ''} /></label>}
      </div>}
      {d.auth !== 'none' && <span className="ds-hint">{d.keyMode === 'own' && admin ? 'People enter their own key when they turn it on.' : 'Kept encrypted on Niko’s server and never shown again. Changing the address to another site drops it.'}</span>}
    </div>
  );
}

const TYPES: [DataParamType, string][] = [['text', 'Text'], ['number', 'Number'], ['integer', 'Whole number'], ['enum', 'One of a list'], ['date', 'Date'], ['boolean', 'Yes or no']];
const blankParam = (): DataParam => ({ name: '', in: 'query', type: 'text', required: false, max: 100 });

/** Step 2 · What Niko can ask: read-only actions, from an OpenAPI file or added one by one. */
export function ActionsStep({ d, set, onBase, datasets = true }: { d: SourceDraft; set: (p: Partial<SourceDraft>) => void; onBase?: (url: string) => void; datasets?: boolean }) {
  const file = useRef<HTMLInputElement>(null);
  const [left, setLeft] = useState<{ name: string; why: string }[]>([]);
  const [edit, setEdit] = useState<{ i: number; a: DataAction } | null>(null);
  const [err, setErr] = useState('');
  const read = async (f: File) => {
    setErr('');
    if (f.size > 2 * 1024 * 1024) return setErr('That file is larger than 2 MB.');
    let spec: unknown;
    try { spec = JSON.parse(await f.text()); } catch { return setErr('Niko reads OpenAPI files saved as JSON.'); }
    const r = openApiActions(spec);
    if ('problem' in r) return setErr(r.problem);
    const taken = new Set(d.actions.map((a) => a.id));
    set({ actions: [...d.actions, ...r.kept.filter((a) => !taken.has(a.id))].slice(0, 30) });
    setLeft(r.left);
    if (r.base && onBase && !/^https:\/\/[^/]+/.test(d.baseUrl)) onBase(r.base);
    if (!r.kept.length) setErr('Nothing in that file is read-only, so nothing was added.');
  };
  const save = () => {
    if (!edit) return;
    const taken = new Set(d.actions.filter((_, j) => j !== edit.i).map((a) => a.id));
    const a = cleanAction(edit.a, taken);
    if ('problem' in a) return setErr(a.problem);
    setErr('');
    set({ actions: edit.i < 0 ? [...d.actions, a] : d.actions.map((x, j) => (j === edit.i ? a : x)) });
    setEdit(null);
  };
  const ea = edit?.a;
  // The path's {names} and its values are kept in step: each {name} gets a path value, and a value whose name is no
  // longer in the path goes back to the address.
  const synced = (a: DataAction): DataAction => {
    const names = [...a.path.matchAll(/\{([A-Za-z_][A-Za-z0-9_.-]{0,39})\}/g)].map((m) => m[1]!);
    const params = a.params.map((p) => (names.includes(p.name) ? { ...p, in: 'path' as const, required: true } : p.in === 'path' ? { ...p, in: 'query' as const } : p));
    for (const n of names) if (!params.some((p) => p.name === n)) params.push({ name: n, in: 'path', type: 'text', required: true, max: 100 });
    return { ...a, params: params.slice(0, 12) };
  };
  const setA = (p: Partial<DataAction>) => edit && setEdit({ ...edit, a: synced({ ...edit.a, ...p }) });
  const setP = (k: number, p: Partial<DataParam>) => ea && setA({ params: ea.params.map((x, j) => (j === k ? { ...x, ...p } : x)) });
  return (
    <div className="ds-step">
      <div className="ds-row-b">
        <button type="button" className="sec" onClick={() => file.current?.click()}>Import an OpenAPI file</button>
        <button type="button" className="sec" disabled={d.actions.length >= 30} onClick={() => { setErr(''); setEdit({ i: -1, a: { id: '', name: '', path: '/', params: [], live: true, example: '', on: true } }); }}>Add an action</button>
        <input ref={file} type="file" accept="application/json,.json" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void read(f); }} />
      </div>
      {err && <p className="ds-err" role="alert">{err}</p>}
      {edit && ea && (
        <div className="ds-edit">
          <div className="ds-two">
            <label className="fld"><span className="k">Name</span><input className="in" value={ea.name} maxLength={60} onChange={(e) => setA({ name: e.target.value })} placeholder="Order status" /></label>
            <label className="fld"><span className="k">Path (GET)</span><input className="in" value={ea.path} maxLength={200} spellCheck={false} onChange={(e) => setA({ path: e.target.value })} placeholder="/orders/{number}" /></label>
          </div>
          <label className="fld"><span className="k">Example question</span><input className="in" value={ea.example} maxLength={120} onChange={(e) => setA({ example: e.target.value })} placeholder="where’s order 482910?" /></label>
          <label className="fld"><span className="k">How Niko uses it</span><select className="in" value={ea.dataset ? `ds-${ea.dataset}` : ea.live ? 'live' : 'recent'} onChange={(e) => { const v = e.target.value; setA(v.startsWith('ds-') ? { dataset: v.slice(3) as DataRefresh, live: false } : { dataset: undefined, live: v === 'live' }); }}>
            <option value="live">Live answer: asked every time</option>
            <option value="recent">Answer: asked when needed, reused for a few minutes</option>
            {(datasets || ea.dataset) && <><option value="ds-day">Dataset in Knowledge, refreshed daily when used</option><option value="ds-week">Dataset in Knowledge, refreshed weekly when used</option><option value="ds-month">Dataset in Knowledge, refreshed monthly when used</option></>}
          </select>{ea.dataset && <span className="ds-hint">Fetched without a question, so each needed value uses its fixed or test value. Kept as a table in Knowledge, so Niko can count and add up its rows.</span>}</label>
          <span className="k">Values Niko fills in</span>
          {ea.params.map((p, k) => (
            <div key={k} className="ds-param">
              <input className="in" aria-label="Value name" value={p.name} maxLength={40} spellCheck={false} placeholder="name" onChange={(e) => setP(k, { name: e.target.value })} />
              <select className="in" aria-label="Where" value={p.in} onChange={(e) => setP(k, { in: e.target.value as 'path' | 'query' })}><option value="query">Address</option><option value="path">Path</option></select>
              <select className="in" aria-label="Kind" value={p.type} onChange={(e) => setP(k, { type: e.target.value as DataParamType })}>{TYPES.map(([v, n]) => <option key={v} value={v}>{n}</option>)}</select>
              {p.type === 'enum'
                ? <input className="in" aria-label="Allowed values" value={(p.values ?? []).join(', ')} placeholder="north, south, east" onChange={(e) => setP(k, { values: e.target.value.split(',').map((x) => x.trim()) })} />
                : p.type === 'text' ? <input className="in" aria-label="Longest" inputMode="numeric" value={p.max ?? ''} placeholder="up to 100" onChange={(e) => setP(k, { max: Number(e.target.value) || undefined })} />
                : p.type === 'number' || p.type === 'integer' ? <span className="ds-mm"><input className="in" aria-label="Lowest" inputMode="decimal" value={p.min ?? ''} placeholder="from" onChange={(e) => setP(k, { min: e.target.value === '' ? undefined : Number(e.target.value) })} /><input className="in" aria-label="Highest" inputMode="decimal" value={p.max ?? ''} placeholder="to" onChange={(e) => setP(k, { max: e.target.value === '' ? undefined : Number(e.target.value) })} /></span>
                : <span />}
              <input className="in" aria-label="Test value" value={p.sample ?? ''} maxLength={100} placeholder="test value" onChange={(e) => setP(k, { sample: e.target.value || undefined })} />
              <label className="ds-check sm"><input type="checkbox" checked={p.required || p.in === 'path'} disabled={p.in === 'path'} onChange={(e) => setP(k, { required: e.target.checked })} />Needed</label>
              <button type="button" className="ds-x" aria-label={`Remove ${p.name || 'value'}`} onClick={() => setA({ params: ea.params.filter((_, j) => j !== k) })}>×</button>
            </div>
          ))}
          <div className="ds-row-b">
            <button type="button" className="sec sm" disabled={ea.params.length >= 12} onClick={() => setA({ params: [...ea.params, blankParam()] })}>Add a value</button>
            <span className="ds-grow" />
            <button type="button" className="sec sm" onClick={() => { setEdit(null); setErr(''); }}>Cancel</button>
            <button type="button" className="pri sm" onClick={save}>{edit.i < 0 ? 'Add' : 'Keep changes'}</button>
          </div>
        </div>
      )}
      {!!d.actions.length && <span className="ds-hint">Keep the ones Niko may use.</span>}
      <ul className="ds-actions">
        {d.actions.map((a, i) => (
          <li key={a.id} className={a.on ? '' : 'off'}>
            <span className="ds-a-t"><span>{a.name}</span><span className="ds-hint">{actionLine(a)}</span></span>
            <span className="ds-a-b">
              <button type="button" className="ds-lnk" onClick={() => { setErr(''); setEdit({ i, a }); }}>Edit</button>
              <button type="button" className={'ds-tag' + (a.on ? ' keep' : '')} aria-pressed={a.on} onClick={() => set({ actions: d.actions.map((x, j) => (j === i ? { ...x, on: !x.on } : x)) })}>{a.on ? 'Keep' : 'Left out'}</button>
              <button type="button" className="ds-x" aria-label={`Remove ${a.name}`} onClick={() => set({ actions: d.actions.filter((_, j) => j !== i) })}>×</button>
            </span>
          </li>
        ))}
        {left.map((l, i) => <li key={`l${i}`} className="off"><span className="ds-a-t"><span>{l.name}</span><span className="ds-hint">{l.why}</span></span><span className="ds-tag">Left out</span></li>)}
      </ul>
      <span className="ds-hint">Niko only reads: actions that change data are left out. Each action is tested before saving.</span>
    </div>
  );
}

export type TestResult = { action: string; name: string; ok: boolean; ms?: number; problem?: string; peek?: string };
/** Test results, one line per action, with the start of what came back when it's shown. */
export function TestLines({ results }: { results: TestResult[] | null }) {
  if (!results) return null;
  if (!results.length) return null;
  return (
    <div className="ds-tests" role="status">
      {results.map((r) => <span key={r.action} className={r.ok ? 'is-ok' : 'is-bad'}><i aria-hidden="true" />{r.name} · {r.ok ? `test passed in ${((r.ms ?? 0) / 1000).toFixed(1)} s` : r.problem}</span>)}
      {results.filter((r) => r.ok && r.peek).map((r) => <details key={`p${r.action}`} className="ds-peek" open={results.length === 1}><summary>What {r.name} gave back</summary><pre>{r.peek}{(r.peek?.length ?? 0) >= 600 ? '\n…' : ''}</pre></details>)}
    </div>
  );
}

/** What step 1 still needs when starting from a link. */
export function linkProblem(d: SourceDraft, hasKey: boolean): string | null {
  if (!d.actions.length) return 'Paste a link that works, starting with https://.';
  return addressProblem(d, hasKey);
}

/** Step 1, the simple way · Paste a link that works: Niko reads the address, the path and each value (with its example)
 *  from it, and a key in the link becomes the key. Then the name and the key. */
export function LinkStep({ d, set, admin, hasKey, onManual }: { d: SourceDraft; set: (p: Partial<SourceDraft>) => void; admin: boolean; hasKey: boolean; onManual: () => void }) {
  const [link, setLink] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const read = (raw: string) => {
    setLink(raw);
    if (!raw.trim()) { setNote(null); return; }
    const r = fromExampleLink(raw);
    if ('problem' in r) { setNote(r.problem); return; }
    setNote(null);
    set({ baseUrl: r.baseUrl, actions: [r.action], ...(d.name.trim() ? {} : { name: r.name }), ...(r.key ? { auth: 'query' as DataAuth, authName: r.key.name, key: r.key.value } : {}) });
  };
  const a = d.actions[0];
  const asks = a?.params.filter((p) => p.fixed === undefined) ?? [];
  const host = (() => { try { return new URL(d.baseUrl).hostname; } catch { return ''; } })();
  return (
    <div className="ds-step">
      <label className="fld"><span className="k">A link that works</span>
        <input className="in ds-link" value={link} inputMode="url" autoComplete="off" spellCheck={false} onChange={(e) => read(e.target.value)} placeholder="https://api.example.com/arrivals?stop=83139" autoFocus />
        <span className="ds-hint">From the service’s docs: an example request you could open yourself. A key in the link is kept as the key, never as an example.</span>
      </label>
      {note && <p className="ds-err" role="alert">{note}</p>}
      {a && !note && <div className="ds-found" role="status">
        <span className="ds-found-t">Niko found</span>
        <span className="ds-hint">{a.name}{host ? ` on ${host}` : ''}</span>
        <span className="ds-hint">{asks.length ? <>It asks for {asks.map((p, i) => <span key={p.name}>{i ? ', ' : ''}<b>{p.name}</b>{p.sample ? ` (e.g. ${p.sample})` : ''}</span>)}</> : 'It needs no values.'}</span>
      </div>}
      <div className="ds-two">
        <label className="fld"><span className="k">{admin ? 'Name people see' : 'Name'}</span><input className="in" value={d.name} maxLength={60} onChange={(e) => set({ name: e.target.value })} placeholder="Bus arrivals" /></label>
        <label className="fld"><span className="k">Use as</span><select className="in" value={d.use} onChange={(e) => set({ use: e.target.value as DataUse })}>{(Object.keys(DATA_USE_NAMES) as DataUse[]).map((u) => <option key={u} value={u}>{DATA_USE_NAMES[u]}</option>)}</select></label>
      </div>
      <div className="fld"><span className="k">Does it need a key?</span>
        <span className="ds-seg" role="radiogroup" aria-label="Does it need a key?">
          {([['none', 'No key'], ['header', 'Key in a header'], ['query', 'Key in the link']] as [DataAuth, string][]).map(([v, t]) => <button key={v} type="button" role="radio" aria-checked={d.auth === v} onClick={() => set({ auth: v })}>{t}</button>)}
        </span>
      </div>
      {d.auth !== 'none' && <div className="ds-two">
        <label className="fld"><span className="k">{d.auth === 'header' ? 'Header name' : 'Name in the link'}</span><input className="in" value={d.authName} maxLength={60} spellCheck={false} onChange={(e) => set({ authName: e.target.value })} placeholder={d.auth === 'header' ? 'AccountKey' : 'api_key'} /></label>
        {admin && <label className="fld"><span className="k">Key</span><select className="in" value={d.keyMode} onChange={(e) => set({ keyMode: e.target.value as DataKeyMode })}><option value="one">One key for everyone (yours)</option><option value="own">Each person adds their own</option></select></label>}
        {d.keyMode === 'one' && <label className="fld"><span className="k">{admin ? 'Your key' : 'Key'}</span><input className="in" type="password" autoComplete="off" value={d.key} maxLength={500} onChange={(e) => set({ key: e.target.value })} placeholder={hasKey ? 'Saved · leave empty to keep it' : ''} /></label>}
      </div>}
      {d.auth !== 'none' && <span className="ds-hint">The service’s docs say what it’s called (LTA DataMall: a header named AccountKey). {d.keyMode === 'own' && admin ? 'People enter their own key when they turn it on.' : 'Kept encrypted on Niko’s server and never shown again.'}</span>}
      <button type="button" className="ds-lnk" onClick={onManual}>More ways: set up by hand, or import an OpenAPI file</button>
    </div>
  );
}

/** Step 2, the simple way · What it answers: one card per thing Niko can ask, with a question it answers and, for each
 *  value, who decides it (Niko from the question, or always the same). Kinds, limits and the path are under More options. */
export function AnswersStep({ d, set, datasets = true, onManual }: { d: SourceDraft; set: (p: Partial<SourceDraft>) => void; datasets?: boolean; onManual: () => void }) {
  const [adding, setAdding] = useState<string | null>(null);
  const [err, setErr] = useState('');
  const setA = (i: number, p: Partial<DataAction>) => set({ actions: d.actions.map((x, j) => (j === i ? { ...x, ...p } : x)) });
  const setP = (i: number, k: number, p: Partial<DataParam>) => setA(i, { params: d.actions[i]!.params.map((x, j) => (j === k ? { ...x, ...p } : x)) });
  const addLink = () => {
    const r = fromExampleLink(adding ?? '', new Set(d.actions.map((a) => a.id)));
    if ('problem' in r) return setErr(r.problem);
    const site = (u: string) => { try { return new URL(u).origin; } catch { return ''; } };
    if (site(r.baseUrl) !== site(d.baseUrl)) return setErr('That link is on another site. Add it as a separate data source.');
    if (d.actions.length >= 30) return setErr('A source can have up to 30 things Niko can ask.');
    set({ actions: [...d.actions, r.action], ...(r.key && d.auth === 'none' ? { auth: 'query' as DataAuth, authName: r.key.name, key: r.key.value } : {}) });
    setAdding(null); setErr('');
  };
  return (
    <div className="ds-step">
      {d.actions.map((a, i) => (
        <div key={a.id || i} className={'ds-card' + (a.on ? '' : ' off')}>
          <div className="ds-two">
            <label className="fld"><span className="k">Name</span><input className="in" value={a.name} maxLength={60} onChange={(e) => setA(i, { name: e.target.value })} /></label>
            <label className="fld"><span className="k">A question it answers</span><input className="in" value={a.example} maxLength={120} onChange={(e) => setA(i, { example: e.target.value })} placeholder="When’s bus 269 coming to my stop?" /></label>
          </div>
          <div className="ds-vals">
            <span className="k">What Niko fills in</span>
            {!a.params.length && <span className="ds-hint">Nothing: it’s always asked the same way.</span>}
            {a.params.map((p, k) => (
              <div key={k} className="ds-val">
                <span className="ds-val-n"><input className="in" aria-label="Value name" value={p.name} maxLength={40} spellCheck={false} placeholder="name" readOnly={p.in === 'path'} onChange={(e) => setP(i, k, { name: e.target.value })} />{p.sample && p.fixed === undefined && <span className="ds-hint">e.g. {p.sample}</span>}</span>
                <span className="ds-val-w">
                  <select className="in" aria-label={`Who decides ${p.name || 'this value'}`} value={p.fixed !== undefined ? 'fixed' : 'ai'} disabled={p.in === 'path'} onChange={(e) => setP(i, k, e.target.value === 'fixed' ? { fixed: p.fixed ?? p.sample ?? '', required: true } : { fixed: undefined, sample: p.sample ?? p.fixed })}>
                    <option value="ai">Niko picks it from the question</option>
                    <option value="fixed">Always the same</option>
                  </select>
                  {p.fixed !== undefined && <input className="in" aria-label={`${p.name} is always`} value={p.fixed} maxLength={100} onChange={(e) => setP(i, k, { fixed: e.target.value })} />}
                </span>
                <label className="ds-check sm"><input type="checkbox" checked={p.required || p.in === 'path' || p.fixed !== undefined} disabled={p.in === 'path' || p.fixed !== undefined} onChange={(e) => setP(i, k, { required: e.target.checked })} />Needed</label>
                <button type="button" className="ds-x" aria-label={`Remove ${p.name || 'value'}`} disabled={p.in === 'path'} onClick={() => setA(i, { params: a.params.filter((_, j) => j !== k) })}>×</button>
              </div>
            ))}
            {a.params.length < 12 && <button type="button" className="ds-lnk" onClick={() => setA(i, { params: [...a.params, blankParam()] })}>+ Add a value the link didn’t have</button>}
          </div>
          <details className="ds-more">
            <summary>More options: live or reused, kinds of values, path</summary>
            <label className="fld"><span className="k">How Niko uses it</span><select className="in" value={a.dataset ? `ds-${a.dataset}` : a.live ? 'live' : 'recent'} onChange={(e) => { const v = e.target.value; setA(i, v.startsWith('ds-') ? { dataset: v.slice(3) as DataRefresh, live: false } : { dataset: undefined, live: v === 'live' }); }}>
              <option value="live">Live answer: asked every time</option>
              <option value="recent">Answer: asked when needed, reused for a few minutes</option>
              {(datasets || a.dataset) && <><option value="ds-day">Dataset in Knowledge, refreshed daily when used</option><option value="ds-week">Dataset in Knowledge, refreshed weekly when used</option><option value="ds-month">Dataset in Knowledge, refreshed monthly when used</option></>}
            </select></label>
            <label className="fld"><span className="k">Path</span><input className="in" value={a.path} maxLength={200} spellCheck={false} onChange={(e) => setA(i, { path: e.target.value })} /></label>
            {a.params.filter((p) => p.fixed === undefined).map((p) => { const k = a.params.indexOf(p); return (
              <label key={k} className="fld"><span className="k">{p.name || 'Value'} · kind</span><select className="in" value={p.type} onChange={(e) => setP(i, k, { type: e.target.value as DataParamType })}>{TYPES.map(([v, n]) => <option key={v} value={v}>{n}</option>)}</select></label>
            ); })}
          </details>
          {d.actions.length > 1 && <div className="ds-row-b">
            <button type="button" className={'ds-tag' + (a.on ? ' keep' : '')} aria-pressed={a.on} onClick={() => setA(i, { on: !a.on })}>{a.on ? 'Keep' : 'Left out'}</button>
            <button type="button" className="ds-lnk" onClick={() => set({ actions: d.actions.filter((_, j) => j !== i) })}>Remove</button>
          </div>}
        </div>
      ))}
      {adding === null
        ? <button type="button" className="ds-lnk" onClick={() => { setAdding(''); setErr(''); }}>+ Add another link from this site</button>
        : <div className="ds-row-b ds-addlink">
            <input className="in ds-link" value={adding} inputMode="url" spellCheck={false} autoFocus onChange={(e) => { setAdding(e.target.value); setErr(''); }} placeholder="https://… another example from the same site" />
            <button type="button" className="sec sm" onClick={() => { setAdding(null); setErr(''); }}>Cancel</button>
            <button type="button" className="pri sm" onClick={addLink}>Add</button>
          </div>}
      {err && <p className="ds-err" role="alert">{err}</p>}
      <span className="ds-hint">Niko only reads: it never changes anything there. <button type="button" className="ds-lnk inline" onClick={onManual}>More ways: by hand, or an OpenAPI file</button></span>
    </div>
  );
}

/** Before testing: each kept action checked the way the server will, so problems show here first. */
export function answersProblem(d: SourceDraft): string | null {
  const kept = d.actions.filter((a) => a.on);
  if (!kept.length) return 'Keep at least one thing Niko can ask.';
  const taken = new Set<string>();
  for (const a of kept) { const r = cleanAction(a, taken); if ('problem' in r) return `${a.name || 'One of them'}: ${r.problem}`; taken.add(r.id); }
  return null;
}
