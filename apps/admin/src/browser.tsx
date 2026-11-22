// Admin portal › Browser (as the Admin-Browser mockup): connecting Cloudflare Browser Run, and a test that opens a
// browser and connects to it straight from this page with a short-lived pass, the way people's devices will.
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { api, ApiError, Cdp, settle, Switch } from '@niko/ui';
import { BROWSER_AT_ONCE_MAX, BROWSER_BLOCKED_MAX, BROWSER_HISTORY_DAYS, BROWSER_MIN_STEPS, BROWSER_OPEN_STEPS, cleanSitePattern, type BrowserAccess, type BrowserDefaults, type BrowserServiceInfo } from '@niko/shared';

type CfInfo = { connected: boolean; tail?: string; at?: string };
const fmt = (d?: string) => (d ? new Date(d).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '');

/** A dialog that closes with Escape and starts with focus on its first field. */
function useDialog(onClose: () => void) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    box.current?.querySelector<HTMLElement>('input, button')?.focus();
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [onClose]);
  return box;
}

/** Connect (or replace) Cloudflare Browser Run: account ID, API token and a fresh sign-in code. */
export function ConnectCloudflare({ replacing, onClose, onDone }: { replacing: boolean; onClose: () => void; onDone: (info: CfInfo) => void }) {
  const box = useDialog(onClose);
  const [account, setAccount] = useState(''), [token, setToken] = useState(''), [code, setCode] = useState('');
  const [busy, setBusy] = useState(false), [err, setErr] = useState<{ text: string; field?: string } | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setErr(null);
    try { const r = await api<{ cloudflare: CfInfo }>('/admin/browser/cloudflare', { method: 'PUT', body: { account, token, code } }); setToken(''); onDone(r.cloudflare); }
    catch (x) { setErr({ text: (x as Error).message, field: x instanceof ApiError ? x.data?.field : undefined }); setCode(''); }
    finally { setBusy(false); }
  };
  return <div className="scrim" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
    <div ref={box} className="dialog br-dialog" role="dialog" aria-modal="true" aria-labelledby="cfh">
      <div className="br-dhead"><h2 id="cfh">{replacing ? 'Replace the Cloudflare connection' : 'Connect Cloudflare Browser Run'}</h2><button className="bt br-x" onClick={onClose} aria-label="Close">✕</button></div>
      <ol className="sub br-steps">
        <li>In Cloudflare, open My Profile › API Tokens › Create Token, and make a custom token.</li>
        <li>Give it one permission: Account · Browser Rendering · Edit. Nothing else.</li>
        <li>Copy the token and your Account ID (on your account’s overview page) into the boxes below.</li>
      </ol>
      <form onSubmit={submit} className="br-form">
        <label className="fld"><span className="k">Account ID</span><input className="in" value={account} onChange={(e) => setAccount(e.target.value)} placeholder="32 letters and numbers" autoComplete="off" spellCheck={false} aria-invalid={err?.field === 'account'} required /></label>
        <label className="fld"><span className="k">API token</span><input className="in" type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="Paste the token" autoComplete="off" spellCheck={false} aria-invalid={err?.field === 'token'} required /></label>
        <label className="fld"><span className="k">Your sign-in code</span><input className="in" value={code} onChange={(e) => setCode(e.target.value.replace(/[^\d ]/g, ''))} inputMode="numeric" autoComplete="one-time-code" placeholder="From your authenticator app" aria-invalid={err?.field === 'code'} required /></label>
        <p className="sub small">Saved encrypted on Niko’s server. It can be replaced, but never shown again, here or anywhere. Niko tests it before saving, which uses a few seconds of today’s free browser minutes.</p>
        {err && <p className="err" role="alert">{err.text}</p>}
        <div className="dialog-acts"><button type="button" className="bt" onClick={onClose}>Cancel</button><button className="pri" style={{ height: 44, fontSize: 14 }} disabled={busy}>{busy ? 'Testing…' : 'Test and save'}</button></div>
      </form>
    </div>
  </div>;
}

function RemoveCloudflare({ onClose, onDone }: { onClose: () => void; onDone: (info: CfInfo) => void }) {
  const box = useDialog(onClose);
  const [code, setCode] = useState(''), [busy, setBusy] = useState(false), [err, setErr] = useState('');
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setErr('');
    try { const r = await api<{ cloudflare: CfInfo }>('/admin/browser/cloudflare', { method: 'DELETE', body: { code } }); onDone(r.cloudflare); }
    catch (x) { setErr((x as Error).message); setCode(''); } finally { setBusy(false); }
  };
  return <div className="scrim" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
    <div ref={box} className="dialog" role="dialog" aria-modal="true" aria-labelledby="cfrh">
      <div><h2 id="cfrh">Remove the Cloudflare connection?</h2><p className="sub">Niko’s built-in browser stops working for everyone until it is connected again. Browsers open right now close within a few minutes.</p></div>
      <form onSubmit={submit} className="br-form">
        <label className="fld"><span className="k">Your sign-in code</span><input className="in" value={code} onChange={(e) => setCode(e.target.value.replace(/[^\d ]/g, ''))} inputMode="numeric" autoComplete="one-time-code" required /></label>
        {err && <p className="err" role="alert">{err}</p>}
        <div className="dialog-acts"><button type="button" className="bt" onClick={onClose}>Cancel</button><button className="pri danger" style={{ height: 44, fontSize: 14 }} disabled={busy}>{busy ? 'Removing…' : 'Remove'}</button></div>
      </form>
    </div>
  </div>;
}

// ---- The account's own browser server, and a hosted service with a key
type SvcInfo = BrowserServiceInfo;
const SVC_COPY = {
  server: { title: 'Your own browser server', add: 'Set up your own browser server', addr: 'Address', addrPh: 'wss://browser.example.com', key: 'Token (if it has one)', keyPh: 'The server’s token',
    note: 'A browser server you run, such as Browserless or Chrome on a NAS. It must be reachable over HTTPS, for example through a Cloudflare Tunnel. Home network addresses can’t be used. Each person gets their own browser on it, with its own sign-ins.' },
  hosted: { title: 'Browser service with a key', add: 'Add a browser service with a key', addr: 'Service address', addrPh: 'wss://production-sfo.browserless.io', key: 'API key', keyPh: 'Paste the key',
    note: 'A hosted service you have an account with, usually billed by the hour. The company running it can see the pages Niko opens on it, including anything typed in a hand-off, such as a password.' },
} as const;
function ServiceDialog({ kind, replacing, onClose, onDone }: { kind: 'server' | 'hosted'; replacing: boolean; onClose: () => void; onDone: (s: SvcInfo, product: string) => void }) {
  const box = useDialog(onClose);
  const t = SVC_COPY[kind];
  const [name, setName] = useState(''), [url, setUrl] = useState(''), [key, setKey] = useState(''), [code, setCode] = useState('');
  const [busy, setBusy] = useState(false), [err, setErr] = useState<{ text: string; field?: string } | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setErr(null);
    try { const r = await api<{ service: SvcInfo; product: string }>('/admin/browser/service', { method: 'PUT', body: { kind, name, url, key, code } }); setKey(''); onDone(r.service, r.product); }
    catch (x) { setErr({ text: (x as Error).message, field: x instanceof ApiError ? x.data?.field : undefined }); setCode(''); }
    finally { setBusy(false); }
  };
  return <div className="scrim" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
    <div ref={box} className="dialog br-dialog" role="dialog" aria-modal="true" aria-labelledby="svch">
      <div className="br-dhead"><h2 id="svch">{replacing ? `Replace ${t.title.toLowerCase()}` : t.add}</h2><button className="bt br-x" onClick={onClose} aria-label="Close">✕</button></div>
      <p className="sub">{t.note}</p>
      <form onSubmit={submit} className="br-form">
        <label className="fld"><span className="k">Name (optional)</span><input className="in" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} placeholder={kind === 'server' ? 'Home NAS' : 'Browserless'} autoComplete="off" /></label>
        <label className="fld"><span className="k">{t.addr}</span><input className="in" value={url} onChange={(e) => setUrl(e.target.value)} placeholder={t.addrPh} inputMode="url" autoComplete="off" spellCheck={false} aria-invalid={err?.field === 'url'} required /></label>
        <label className="fld"><span className="k">{t.key}</span><input className="in" type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder={t.keyPh} autoComplete="off" spellCheck={false} aria-invalid={err?.field === 'key'} required={kind === 'hosted'} /></label>
        <label className="fld"><span className="k">Your sign-in code</span><input className="in" value={code} onChange={(e) => setCode(e.target.value.replace(/[^\d ]/g, ''))} inputMode="numeric" autoComplete="one-time-code" placeholder="From your authenticator app" aria-invalid={err?.field === 'code'} required /></label>
        <p className="sub small">Saved encrypted on Niko’s server, never sent to anyone’s device, and never shown again. Niko connects to it for people and relays the live picture. Niko tests it before saving.</p>
        {err && <p className="err" role="alert">{err.text}</p>}
        <div className="dialog-acts"><button type="button" className="bt" onClick={onClose}>Cancel</button><button className="pri" style={{ height: 44, fontSize: 14 }} disabled={busy}>{busy ? 'Testing…' : 'Test and save'}</button></div>
      </form>
    </div>
  </div>;
}
function RemoveService({ kind, onClose, onDone }: { kind: 'server' | 'hosted'; onClose: () => void; onDone: () => void }) {
  const box = useDialog(onClose);
  const [code, setCode] = useState(''), [busy, setBusy] = useState(false), [err, setErr] = useState('');
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setErr('');
    try { await api(`/admin/browser/service/${kind}`, { method: 'DELETE', body: { code } }); onDone(); }
    catch (x) { setErr((x as Error).message); setCode(''); } finally { setBusy(false); }
  };
  return <div className="scrim" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
    <div ref={box} className="dialog" role="dialog" aria-modal="true" aria-labelledby="svrh">
      <div><h2 id="svrh">Remove {SVC_COPY[kind].title.toLowerCase()}?</h2><p className="sub">Niko stops using it. Browsers open on it right now keep working until they close.</p></div>
      <form onSubmit={submit} className="br-form">
        <label className="fld"><span className="k">Your sign-in code</span><input className="in" value={code} onChange={(e) => setCode(e.target.value.replace(/[^\d ]/g, ''))} inputMode="numeric" autoComplete="one-time-code" required /></label>
        {err && <p className="err" role="alert">{err}</p>}
        <div className="dialog-acts"><button type="button" className="bt" onClick={onClose}>Cancel</button><button className="pri danger" style={{ height: 44, fontSize: 14 }} disabled={busy}>{busy ? 'Removing…' : 'Remove'}</button></div>
      </form>
    </div>
  </div>;
}

// ---- The test
type Check = { name: string; url: string; state: 'waiting' | 'checking' | 'works' | 'refuses' | 'unsure' | 'failed'; note?: string; shot?: string };
const SIGN_INS: [string, string][] = [
  ['Google', 'https://accounts.google.com/signin'],
  ['Microsoft', 'https://login.live.com/'],
  ['Apple', 'https://account.apple.com/sign-in'],
  ['Facebook', 'https://www.facebook.com/login/'],
];
/** Words sign-in pages show when they won't let an automated browser in. Matched only, never shown. */
const REFUSED = /(browser or app may not be secure|this browser (is|isn.t) (not )?supported|unsupported browser|try (using )?a different browser|couldn.t sign you in|unusual traffic|automated (queries|requests|browser)|verify (that )?you.re (a )?human|are you a robot|access denied|request blocked|enable (javascript|cookies) and try)/i;

async function look(ws: string): Promise<{ text: string; shot: string }> {
  const cdp = new Cdp(ws);
  try {
    await cdp.opened;
    await settle(cdp, 10_000);
    const t = await cdp.send<{ result?: { value?: string } }>('Runtime.evaluate', { expression: 'document.title + "\\n" + (document.body ? document.body.innerText : "")', returnByValue: true });
    const s = await cdp.send<{ data: string }>('Page.captureScreenshot', { format: 'jpeg', quality: 50 });
    return { text: String(t.result?.value ?? '').slice(0, 4000), shot: 'data:image/jpeg;base64,' + s.data };
  } finally { cdp.close(); }
}

function BrowserTest({ guard }: { guard: (e: unknown) => void }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string; shot?: string; ms?: Record<string, number> } | null>(null);
  const [checks, setChecks] = useState<Check[]>([]);
  const [extra, setExtra] = useState('');
  const run = async () => {
    setBusy(true); setResult(null);
    const list: Check[] = [...SIGN_INS.map(([name, url]) => ({ name, url, state: 'waiting' as const })), ...extra.split(/[\s,]+/).filter(Boolean).slice(0, 3).map((u) => ({ name: u.replace(/^https?:\/\//, '').split('/')[0]!, url: /^https?:\/\//.test(u) ? u : 'https://' + u, state: 'waiting' as const }))];
    setChecks(list);
    let sessionId = '';
    try {
      const t0 = performance.now();
      const o = await api<{ sessionId: string; ws: string; ms: Record<string, number> }>('/admin/browser/test/open', { method: 'POST' });
      sessionId = o.sessionId;
      const t1 = performance.now();
      const first = await look(o.ws);
      setResult({ ok: true, text: 'This page connected straight to the browser with a short-lived pass and received its picture. People’s devices will connect the same way.', shot: first.shot, ms: { ...o.ms, direct: Math.round(performance.now() - t1), total: Math.round(performance.now() - t0) } });
      for (let i = 0; i < list.length; i++) {
        setChecks((c) => c.map((x, j) => (j === i ? { ...x, state: 'checking' } : x)));
        try {
          const t = await api<{ ws: string }>('/admin/browser/test/tab', { method: 'POST', body: { sessionId, url: list[i]!.url } });
          const seen = await look(t.ws);
          const refused = REFUSED.test(seen.text);
          setChecks((c) => c.map((x, j) => (j === i ? { ...x, state: refused ? 'refuses' : seen.text.trim().length < 20 ? 'unsure' : 'works', shot: seen.shot } : x)));
        } catch (e) { setChecks((c) => c.map((x, j) => (j === i ? { ...x, state: 'failed', note: (e as Error).message } : x))); }
      }
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) guard(e);
      else setResult({ ok: false, text: (e as Error).message });
    } finally {
      if (sessionId) await api('/admin/browser/test/close', { method: 'POST', body: { sessionId } }).catch(() => undefined);
      setBusy(false);
    }
  };
  const word: Record<Check['state'], string> = { waiting: 'Waiting', checking: 'Checking…', works: 'Lets Niko in', refuses: 'Refuses automated browsers', unsure: 'Couldn’t tell', failed: 'Didn’t open' };
  return <section className="g card" aria-label="Test the browser">
    <div className="ai-head"><div><h2>Test the browser</h2><p className="sub" style={{ fontSize: 13 }}>Opens a browser on Cloudflare, connects to it straight from this page, then tries common sign-in pages. Uses about a minute of today’s free browser minutes.</p></div>
      <div className="ai-acts"><button className="pri" style={{ height: 44, fontSize: 14 }} onClick={run} disabled={busy}>{busy ? 'Testing…' : 'Run the test'}</button></div></div>
    <label className="fld"><span className="k">Also check these sites (optional)</span><input className="in" value={extra} onChange={(e) => setExtra(e.target.value)} placeholder="Up to 3 addresses, separated by spaces" disabled={busy} /></label>
    {result && <div className={result.ok ? 'ok' : 'err'} role="status">{result.text}{result.ms && <span className="br-ms"> Start {result.ms.open} ms · tab {result.ms.tab} ms · pass {result.ms.pass} ms · direct picture {result.ms.direct} ms.</span>}</div>}
    {result?.shot && <img className="br-shot" src={result.shot} alt="The test page, as the browser shows it" />}
    {checks.length > 0 && <div className="br-checks">
      {checks.map((x) => <div key={x.url} className="br-check">
        {x.shot ? <img src={x.shot} alt={`${x.name}, as the browser shows it`} /> : <span className="br-noshot" aria-hidden="true" />}
        <span className="br-ctxt"><b>{x.name}</b><span className={'sub' + (x.state === 'refuses' ? ' warn' : '')}>{word[x.state]}{x.note ? ` · ${x.note}` : ''}</span></span>
      </div>)}
      <p className="sub small">“Refuses” means the page showed a message like “this browser may not be secure”. For those sites, Niko offers Connections instead, or hands the sign-in to the person.</p>
    </div>}
  </section>;
}

type BrowserUser = { id: string; name: string; email: string; role: string; browserAccess: BrowserAccess };
/** − value +: steps through the allowed values. */
function Stepper({ value, steps, label, show, onChange, disabled }: { value: number; steps: readonly number[]; label: string; show: (n: number) => string; onChange: (n: number) => void; disabled?: boolean }) {
  const i = Math.max(0, steps.indexOf(value));
  return <span className="br-step" role="group" aria-label={label}>
    <button type="button" className="ib br-step-b" aria-label={`Less: ${label}`} disabled={disabled || i === 0} onClick={() => onChange(steps[i - 1]!)}>−</button>
    <span className="br-step-v" aria-live="polite">{show(value)}</span>
    <button type="button" className="ib br-step-b" aria-label={`More: ${label}`} disabled={disabled || i === steps.length - 1} onClick={() => onChange(steps[i + 1]!)}>+</button>
  </span>;
}
const HOURS = Array.from({ length: 24 }, (_, h) => h);
/** A UTC hour as this computer's local time ("8:00 am"). */
const localHour = (utcHour: number) => { const d = new Date(); d.setUTCHours(utcHour, 0, 0, 0); return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); };

export function BrowserAdmin({ guard }: { guard: (e: unknown) => void }) {
  const [cf, setCf] = useState<CfInfo | null>(null);
  const [services, setServices] = useState<SvcInfo[]>([]);
  const [svcDialog, setSvcDialog] = useState<{ kind: 'server' | 'hosted'; remove?: boolean } | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [defaults, setDefaults] = useState<BrowserDefaults | null>(null);
  const [people, setPeople] = useState<BrowserUser[]>([]);
  const [sel, setSel] = useState('all');
  const [draftAll, setDraftAll] = useState<BrowserDefaults | null>(null);
  const [draftOne, setDraftOne] = useState<BrowserAccess>({});
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [find, setFind] = useState('');
  const [site, setSite] = useState<string | null>(null);
  const [dialog, setDialog] = useState<'connect' | 'remove' | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const load = useCallback(async () => {
    try { const r = await api<{ cloudflare: CfInfo; services: SvcInfo[]; defaults: BrowserDefaults; users: BrowserUser[] }>('/admin/browser'); setCf(r.cloudflare); setServices(r.services); setDefaults(r.defaults); setPeople(r.users); } catch (e) { guard(e); }
  }, [guard]);
  useEffect(() => { void load(); }, [load]);
  const person = people.find((p) => p.id === sel) ?? null;
  useEffect(() => { if (defaults) { setDraftAll({ ...defaults }); setDraftOne(person ? { ...person.browserAccess } : {}); setDirty(false); setSite(null); } }, [sel, defaults, people]); // eslint-disable-line react-hooks/exhaustive-deps
  const close = useCallback(() => setDialog(null), []);
  if (!cf || !defaults || !draftAll) return null;
  type PK = keyof BrowserAccess;
  const val = <K extends PK>(k: K): NonNullable<BrowserAccess[K]> => (person ? (draftOne[k] ?? defaults[k]) : draftAll[k]) as NonNullable<BrowserAccess[K]>;
  const changed = (k: PK) => !!person && k in draftOne && draftOne[k] !== defaults[k];
  const setP = (k: PK, v: boolean | number) => {
    setNote(null); setDirty(true);
    if (person) { const next = { ...draftOne }; if (v === defaults[k]) delete next[k]; else (next as Record<string, unknown>)[k] = v; setDraftOne(next); }
    else setDraftAll({ ...draftAll, [k]: v });
  };
  const setAll = <K extends keyof BrowserDefaults>(k: K, v: BrowserDefaults[K]) => { setNote(null); setDirty(true); setDraftAll({ ...draftAll, [k]: v }); };
  const reset = (k: PK) => { const next = { ...draftOne }; delete next[k]; setDraftOne(next); setDirty(true); };
  const count = (p: BrowserUser) => Object.keys(p.browserAccess).length;
  const mark = (k: PK) => changed(k) ? <><span className="chg">Changed</span><button className="lnk" onClick={() => reset(k)}>Reset</button></> : null;
  const save = async () => {
    setBusy(true); setNote(null);
    try {
      if (person) await api(`/admin/browser/users/${person.id}`, { method: 'PUT', body: { access: draftOne } });
      else {
        const r = await api<{ forgot: number }>('/admin/browser/default', { method: 'PUT', body: { defaults: draftAll } });
        if (r.forgot) setNote({ ok: true, text: `Saved. ${r.forgot} kept ${r.forgot === 1 ? 'sign-in was' : 'sign-ins were'} deleted.` });
      }
      await load();
      setNote((n) => n ?? { ok: true, text: person ? `Saved for ${person.name || person.email}.` : 'Saved. It applies to everyone without their own changes within a minute.' });
    } catch (e) { if (e instanceof ApiError && e.status === 401) guard(e); else setNote({ ok: false, text: (e as Error).message }); } finally { setBusy(false); }
  };
  const addSite = () => {
    const clean = cleanSitePattern(site ?? '');
    if (!clean) { setNote({ ok: false, text: 'Enter a site, such as bank.com or *.bank.com.' }); return; }
    if (!draftAll.blocked.includes(clean)) setAll('blocked', [...draftAll.blocked, clean]);
    setSite(null);
  };
  const on = val('on');
  const svc = (k: 'server' | 'hosted') => services.find((x) => x.kind === k) ?? null;
  const test = async (k: 'server' | 'hosted') => {
    setTesting(k); setNote(null);
    try { const r = await api<{ product: string }>(`/admin/browser/service/${k}/test`, { method: 'POST' }); setNote({ ok: true, text: `${SVC_COPY[k].title} works: ${r.product}.` }); }
    catch (e) { if (e instanceof ApiError && e.status === 401) guard(e); else setNote({ ok: false, text: (e as Error).message }); } finally { setTesting(null); }
  };
  const openLabel = (n: number) => (n === 0 ? 'No limit' : `${n} min`);
  const first = person ? (person.name || person.email).split(' ')[0] : '';
  const q = find.trim().toLowerCase();
  const minSub = person ? (changed('mins') ? `Default is ${defaults.mins} min` : 'Per person. Counted only while a browser is open.') : 'Per person. Counted only while a browser is open.';
  return <>
    <header><h1>Browser</h1><p className="sub" style={{ fontSize: 15, maxWidth: 880 }}>Who can let Niko use a browser, which browser services run it, and how much time each person gets. Set the default for everyone, then change it for anyone who needs something different.</p></header>
    {note && <p className={note.ok ? 'ok' : 'err'} role="status">{note.text}</p>}
    <div className="ai-grid">
      <section className="g card ai-people" aria-label="Applies to">
        <span className="k" style={{ padding: '0 6px' }}>Applies to</span>
        <input className="in lim-find" type="search" aria-label="Find a person" placeholder="Find a person" value={find} onChange={(e) => setFind(e.target.value)} />
        <div className="ai-list">
          {[{ id: 'all', name: 'Everyone', sub: 'The default for all accounts', badge: 'Default', tone: '' }, ...people.filter((p) => !q || `${p.name} ${p.email}`.toLowerCase().includes(q)).map((p) => ({ id: p.id, name: p.name || p.email, sub: p.email, badge: p.role === 'admin' ? 'Admin' : count(p) ? `${count(p)} ${count(p) === 1 ? 'change' : 'changes'}` : 'Default', tone: p.role === 'admin' ? ' is-free' : count(p) ? ' is-chg' : '' }))].map((p) => (
            <button key={p.id} className="who-row" aria-pressed={p.id === sel} onClick={() => { if (dirty && !window.confirm('Leave without saving these changes?')) return; setSel(p.id); setNote(null); }}>
              <span className="who-txt"><b>{p.name}</b><span>{p.sub}</span></span><span className={'lim-badge' + p.tone}>{p.badge}</span>
            </button>
          ))}
          {q && !people.some((p) => `${p.name} ${p.email}`.toLowerCase().includes(q)) && <p className="sub small" style={{ padding: '6px' }}>No one matches “{find.trim()}”.</p>}
        </div>
        <p className="sub" style={{ fontSize: 12, padding: '0 6px' }}>People see limits as Niko’s own (“Niko can’t open this site”), never as set by someone else.</p>
      </section>
      <div className="br-col">
      <section className="g card ai-options" aria-label="Browser settings">
        <div className="ai-head">
          <div><h2>{person ? person.name || person.email : 'Everyone · default'}</h2>
            <p className="sub" style={{ fontSize: 13 }}>{person ? (person.role === 'admin' ? 'Admins always have the browser; the time limit still applies.' : Object.keys(draftOne).length ? 'Different from the default where marked. Everything else follows the default.' : `Follows the default. Change anything to change it for ${first} only.`) : 'What every account gets, unless it is changed for that person.'}</p></div>
          <div className="ai-acts">
            {person && <button className="bt" onClick={() => { setDraftOne({}); setDirty(true); }} disabled={!Object.keys(draftOne).length}>Reset to default</button>}
            <button className="pri" style={{ height: 44, fontSize: 14 }} onClick={() => void save()} disabled={busy || !dirty}>{busy ? 'Saving…' : 'Save'}</button>
          </div>
        </div>
        <div className="ai-row">
          <span className="ai-txt"><span>Browser</span><span className="sub">{changed('on') ? `Default is ${defaults.on ? 'on' : 'off'}` : 'Off: Niko can still look things up, but can’t open websites or act on them.'}</span></span>
          {mark('on')}
          <Switch on={on} onChange={(v) => setP('on', v)} label="Browser" disabled={person?.role === 'admin'} />
        </div>
        <div className={'ai-row' + (on ? '' : ' dim')}>
          <span className="ai-txt"><span>May add their own browser service</span><span className="sub">{changed('ownService') ? `Default is ${defaults.ownService ? 'on' : 'off'}` : 'Their own server or a hosted service with their key, in Settings › Browser. Used before the services below.'}</span></span>
          {mark('ownService')}
          <Switch on={val('ownService')} onChange={(v) => setP('ownService', v)} label="May add their own browser service" disabled={!on} />
        </div>

        {!person && <div className="br-group">
          <span className="br-shead"><span className="k" style={{ color: '#fff' }}>Browser services, in order</span><span className="sub small">Niko uses the first one that works and moves to the next when one runs out or can’t be reached.</span></span>
          <div className="br-svc">
            <span className="br-num">1</span>
            <span className="br-svc-txt"><span className="br-svc-name">Cloudflare Browser Run <span className="pill">Built in</span></span>
              <span className="sub">{cf.connected ? `Account …${cf.tail} · token saved ${fmt(cf.at)}. Free plan: 10 minutes a day for the whole account, 3 browsers at once.` : 'Not connected. Connect your Cloudflare account to use the built-in browser.'}</span></span>
            {cf.connected ? <><span className="pill-ok">Connected</span><button className="bt" onClick={() => setDialog('connect')}>Change</button><button className="lnk" onClick={() => setDialog('remove')}>Remove</button></>
              : <button className="pri" style={{ height: 44, fontSize: 14 }} onClick={() => setDialog('connect')}>Connect</button>}
          </div>
          {(['server', 'hosted'] as const).map((k, i) => {
            const x = svc(k);
            return <div key={k} className="br-svc">
              <span className="br-num">{i + 2}</span>
              <span className="br-svc-txt"><span className="br-svc-name">{x ? x.name : SVC_COPY[k].title}</span>
                <span className="sub">{x ? `${x.host} · ${x.hasKey ? 'key saved' : 'no token'} ${fmt(x.at)}. ${k === 'server' ? `No daily limit; at most ${draftAll.atOnce} at once.` : draftAll.hostMins ? `${draftAll.hostMins} min a day per person.` : 'No daily limit.'}`
                  : k === 'server' ? 'A browser server you run, such as on a NAS. No daily limit.' : 'A hosted service you have an account with, usually billed by the hour. Not added.'}</span></span>
              {x ? <><span className="pill-ok">Saved</span><button className="bt" onClick={() => void test(k)} disabled={testing === k}>{testing === k ? 'Testing…' : 'Test'}</button><button className="bt" onClick={() => setSvcDialog({ kind: k })}>Change</button><button className="lnk" onClick={() => setSvcDialog({ kind: k, remove: true })}>Remove</button></>
                : <button className="bt" onClick={() => setSvcDialog({ kind: k })}>{k === 'server' ? 'Set up' : 'Add'}</button>}
            </div>;
          })}
        </div>}

        <div className={'br-group' + (on ? '' : ' dim')}>
          <span className="br-shead"><span className="k" style={{ color: '#fff' }}>Limits</span><span className="sub small">Counted only while a browser is open.</span></span>
          <div className="ai-row">
            <span className="ai-txt"><span>Built-in browser time a day</span><span className="sub">{minSub}</span></span>
            {mark('mins')}
            <Stepper value={val('mins')} steps={BROWSER_MIN_STEPS} label="Built-in browser time a day" show={(n) => `${n} min`} onChange={(n) => setP('mins', n)} disabled={!on} />
          </div>
          {!person && <div className="ai-row">
            <span className="ai-txt"><span>Your own server: browsers at once</span><span className="sub">Applies to everyone. No daily limit; this protects the server. When it’s full, Niko uses the next service.</span></span>
            <Stepper value={draftAll.atOnce} steps={Array.from({ length: BROWSER_AT_ONCE_MAX }, (_, n) => n + 1)} label="Your own server: browsers at once" show={(n) => String(n)} onChange={(n) => setAll('atOnce', n)} disabled={!on} />
          </div>}
          <div className="ai-row">
            <span className="ai-txt"><span>Hosted service time a day</span><span className="sub">{changed('hostMins') ? `Default is ${openLabel(defaults.hostMins)}` : 'No limit unless you set one. That service bills you for the time used.'}</span></span>
            {mark('hostMins')}
            <Stepper value={val('hostMins')} steps={BROWSER_OPEN_STEPS} label="Hosted service time a day" show={openLabel} onChange={(n) => setP('hostMins', n)} disabled={!on} />
          </div>
          <div className="ai-row">
            <span className="ai-txt"><span>Time on their own service</span><span className="sub">{changed('ownMins') ? `Default is ${openLabel(defaults.ownMins)}` : 'Doesn’t use the built-in minutes. The live picture still runs through Niko’s server, so limit it only if that needs one.'}</span></span>
            {mark('ownMins')}
            <Stepper value={val('ownMins')} steps={BROWSER_OPEN_STEPS} label="Time on their own service" show={openLabel} onChange={(n) => setP('ownMins', n)} disabled={!on || !val('ownService')} />
          </div>
          {!person && <div className="ai-row">
            <span className="ai-txt"><span>Minutes refill at</span><span className="sub">Your time ({Intl.DateTimeFormat().resolvedOptions().timeZone}), {String(draftAll.refillHourUtc).padStart(2, '0')}:00 UTC. Cloudflare’s free minutes reset at midnight UTC.</span></span>
            <Stepper value={draftAll.refillHourUtc} steps={HOURS} label="Minutes refill at" show={localHour} onChange={(n) => setAll('refillHourUtc', n)} />
          </div>}
        </div>

        {!person && <div className="br-group">
          <span className="br-shead"><span className="k" style={{ color: '#fff' }}>Sign-ins and history</span></span>
          <div className="ai-row">
            <span className="ai-txt"><span>Allow “Stay signed in”</span><span className="sub">{draftAll.staySignedIn ? 'People can keep a site’s sign-in, encrypted, for their account only.' : 'Off: every sign-in is forgotten when the browser closes.'}{defaults.staySignedIn && !draftAll.staySignedIn ? ' Saving deletes every kept sign-in.' : ''}</span></span>
            <Switch on={draftAll.staySignedIn} onChange={(v) => setAll('staySignedIn', v)} label="Allow Stay signed in" />
          </div>
          <div className="ai-row">
            <span className="ai-txt"><span>Longest activity history</span><span className="sub">People can choose less. Sites and steps only.</span></span>
            <select className="in br-sel" aria-label="Longest activity history" value={draftAll.historyDays} onChange={(e) => setAll('historyDays', Number(e.target.value) as BrowserDefaults['historyDays'])}>
              {BROWSER_HISTORY_DAYS.map((d) => <option key={d} value={d}>{d} days</option>)}
            </select>
          </div>
        </div>}

        {!person && <div className="br-group">
          <span className="br-shead"><span className="k" style={{ color: '#fff' }}>Sites Niko can’t open</span><span className="sub small">Applies to everyone. A site also covers its subdomains; use * for every page on a site.</span></span>
          <div className="br-sites">
            {draftAll.blocked.map((b) => <span key={b} className="br-site">{b}<button type="button" className="br-site-x" aria-label={`Unblock ${b}`} onClick={() => setAll('blocked', draftAll.blocked.filter((x) => x !== b))}>✕</button></span>)}
            {site === null
              ? <button type="button" className="bt br-add" onClick={() => setSite('')} disabled={draftAll.blocked.length >= BROWSER_BLOCKED_MAX}>+ Add site</button>
              : <form className="br-addf" onSubmit={(e) => { e.preventDefault(); addSite(); }}>
                  <input className="in" autoFocus value={site} maxLength={300} placeholder="bank.com" aria-label="Site Niko can’t open" onChange={(e) => setSite(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape') setSite(null); }} />
                  <button className="pri" style={{ height: 44, fontSize: 14 }} disabled={!site.trim()}>Add</button><button type="button" className="bt" onClick={() => setSite(null)}>Cancel</button>
                </form>}
          </div>
        </div>}
        {person && <p className="sub small br-foot">Browser services, browsers at once on your own server, the refill time, “Stay signed in”, history and blocked sites apply to everyone. Choose Everyone to change them.</p>}
        <p className="sub small br-foot">Every change is written to the audit log. Turning the browser off for someone closes a browser they have open.</p>
      </section>
      {cf.connected && !person && <BrowserTest guard={guard} />}
      </div>
    </div>
    {dialog === 'connect' && <ConnectCloudflare replacing={cf.connected} onClose={close} onDone={(i) => { setCf(i); setDialog(null); setNote({ ok: true, text: 'Cloudflare Browser Run is connected. The token is saved encrypted and won’t be shown again.' }); }} />}
    {svcDialog && !svcDialog.remove && <ServiceDialog kind={svcDialog.kind} replacing={!!svc(svcDialog.kind)} onClose={() => setSvcDialog(null)} onDone={(x, product) => { setServices((all) => [...all.filter((y) => y.kind !== x.kind), x]); setSvcDialog(null); setNote({ ok: true, text: `${SVC_COPY[x.kind].title} is saved and works (${product}). The ${x.kind === 'server' ? 'token' : 'key'} won’t be shown again.` }); }} />}
    {svcDialog?.remove && <RemoveService kind={svcDialog.kind} onClose={() => setSvcDialog(null)} onDone={() => { const k = svcDialog.kind; setServices((all) => all.filter((y) => y.kind !== k)); setSvcDialog(null); setNote({ ok: true, text: `${SVC_COPY[k].title} was removed.` }); }} />}
    {dialog === 'remove' && <RemoveCloudflare onClose={close} onDone={(i) => { setCf(i); setDialog(null); setNote({ ok: true, text: 'The Cloudflare connection was removed.' }); }} />}
  </>;
}
