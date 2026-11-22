// Admin portal › Browser (as the Admin-Browser mockup): connecting Cloudflare Browser Run, and a test that opens a
// browser and connects to it straight from this page with a short-lived pass, the way people's devices will.
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { api, ApiError, Cdp, settle } from '@niko/ui';

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

export function BrowserAdmin({ guard }: { guard: (e: unknown) => void }) {
  const [cf, setCf] = useState<CfInfo | null>(null);
  const [dialog, setDialog] = useState<'connect' | 'remove' | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const load = useCallback(async () => {
    try { const r = await api<{ cloudflare: CfInfo }>('/admin/browser'); setCf(r.cloudflare); } catch (e) { guard(e); }
  }, [guard]);
  useEffect(() => { void load(); }, [load]);
  const close = useCallback(() => setDialog(null), []);
  if (!cf) return null;
  return <>
    <header><h1>Browser</h1><p className="sub" style={{ fontSize: 15, maxWidth: 880 }}>Who can let Niko use a browser, which browser services run it, and how much time each person gets.</p></header>
    {note && <p className={note.ok ? 'ok' : 'err'} role="status">{note.text}</p>}
    <section className="g card" aria-label="Browser services, in order">
      <span className="br-shead"><span className="k" style={{ color: '#fff' }}>Browser services, in order</span><span className="sub small">Niko uses the first one that works and moves to the next when one runs out or can’t be reached.</span></span>
      <div className="br-svc">
        <span className="br-num">1</span>
        <span className="br-svc-txt"><span className="br-svc-name">Cloudflare Browser Run <span className="pill">Built in</span></span>
          <span className="sub">{cf.connected ? `Account …${cf.tail} · token saved ${fmt(cf.at)}. Free plan: 10 minutes a day for the whole account, 3 browsers at once.` : 'Not connected. Connect your Cloudflare account to use the built-in browser.'}</span></span>
        {cf.connected ? <><span className="pill-ok">Connected</span><button className="bt" onClick={() => setDialog('connect')}>Change</button><button className="lnk" onClick={() => setDialog('remove')}>Remove</button></>
          : <button className="pri" style={{ height: 44, fontSize: 14 }} onClick={() => setDialog('connect')}>Connect</button>}
      </div>
    </section>
    {cf.connected && <BrowserTest guard={guard} />}
    {dialog === 'connect' && <ConnectCloudflare replacing={cf.connected} onClose={close} onDone={(i) => { setCf(i); setDialog(null); setNote({ ok: true, text: 'Cloudflare Browser Run is connected. The token is saved encrypted and won’t be shown again.' }); }} />}
    {dialog === 'remove' && <RemoveCloudflare onClose={close} onDone={(i) => { setCf(i); setDialog(null); setNote({ ok: true, text: 'The Cloudflare connection was removed.' }); }} />}
  </>;
}
