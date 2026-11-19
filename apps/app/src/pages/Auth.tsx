import { startAuthentication } from '@simplewebauthn/browser';
import { passkeyError } from '../passkeyError';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, ApiError, Field, Icon, ParticleCore, PasswordField, type CoreMode } from '@niko/ui';
import { lengthLabel, money } from '@niko/shared';
import { useNiko } from '../niko';

export function Shell({ tag, children, label = 'Listening', mode = 'listening' }: { tag: string; children: ReactNode; label?: string; mode?: CoreMode }) {
  const landing = location.hostname.startsWith('nikoapp.') ? 'https://niko.midnightpoetry.studio/' : '/';
  return (
    <div className="auth">
      <a className="wordmark mark" href={landing}>NIKO</a>
      <div className="stage">
        <ParticleCore size="min(600px, 66vh)" mode={mode} />
        <span className="k accent">{label}</span>
        <span className="line">{tag}</span>
      </div>
      <main className="g card">{children}</main>
    </div>
  );
}

type Config = { registration: 'invite' | 'open'; needsSetup: boolean; signup?: { priceCents: number; months: number; plans: { plan: string; cents: number }[]; testMode?: boolean } | null };
const SERVER_DOWN = 'Niko can’t reach its server right now. Sign-in may not work until it’s back.';

/** Sign-in settings. If the server can't answer, say so (instead of quietly guessing "invite only, already
 * set up", which hid the first-run setup) and keep checking, so the page recovers on its own once it's back. */
function useConfig(): { cfg: Config | null; down: string } {
  const [cfg, setCfg] = useState<Config | null>(null);
  const [down, setDown] = useState('');
  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    const load = () => api<Config>('/auth/config')
      .then((c) => { if (!stop) { setCfg(c); setDown(''); } })
      .catch(() => { if (!stop) { setDown(SERVER_DOWN); timer = setTimeout(load, 10_000); } });
    load();
    return () => { stop = true; clearTimeout(timer); };
  }, []);
  return { cfg, down };
}

export function SignIn() {
  const { cfg, down } = useConfig();
  const { refreshMe } = useNiko();
  const nav = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (cfg?.needsSetup) nav('/sign-up', { replace: true }); }, [cfg, nav]);

  const done = async () => { await refreshMe(); nav('/', { replace: true }); };
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setErr(''); setBusy(true);
    try { await api('/auth/sign-in', { body: { email, password } }); await done(); } catch (x: any) { setErr(x.message); } finally { setBusy(false); }
  };
  const passkey = async () => {
    setErr('');
    try {
      const { options, challengeId } = await api('/auth/passkey/login/options', { method: 'POST' });
      const response = await startAuthentication({ optionsJSON: options });
      await api('/auth/passkey/login/verify', { body: { challengeId, response } });
      await done();
    } catch (x: any) { setErr(passkeyError(x, false)); }
  };
  return (
    <Shell tag="Welcome back.">
      <form onSubmit={submit} style={{ display: 'contents' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
          <h1>Sign in</h1>{cfg?.registration !== 'open' && <span className="k">Invite only</span>}
        </div>
        {(err || down) && <p className="err" role="alert">{err || down}</p>}
        <Field label="Email"><input className="in" type="email" autoComplete="username" placeholder="name@example.com" value={email} onChange={(e) => setEmail(e.target.value)} required /></Field>
        <PasswordField label="Password" autoComplete="current-password" value={password} onChange={setPassword} />
        <button className="pri" disabled={busy}>Sign in</button>
        <button type="button" className="sec" onClick={passkey}><Icon name="key" size={20} />Use a passkey</button>
        <div className="links">
          <Link className="lnk" to="/forgot">Forgot password</Link>
          {cfg?.registration === 'open' ? <Link className="lnk" to="/sign-up">Create an account</Link> : <Link className="lnk" to="/invite">I have an invite</Link>}
        </div>
      </form>
    </Shell>
  );
}

// ---------------------------------------------------------------- shared pieces for invite, sign-up and plans
/** "1 · Code  2 · Pay  3 · Account", with the current step filled in. */
export function Steps({ names, at }: { names: string[]; at: number }) {
  return (
    <ol className="flowsteps" aria-label="Steps">
      {names.map((n, i) => <li key={n} aria-current={i === at ? 'step' : undefined} className={i < at ? 'done' : i === at ? 'now' : ''}>{i + 1} · {n}</li>)}
    </ol>
  );
}

/** Six boxes over one real input, so typing, pasting and the phone's code suggestions all work. */
export function CodeBoxes({ id, label, value, onChange, numeric, autoFocus }: { id: string; label: string; value: string; onChange: (v: string) => void; numeric?: boolean; autoFocus?: boolean }) {
  const chars = Array.from({ length: 6 }, (_, i) => value[i] ?? '');
  const clean = (v: string) => (numeric ? v.replace(/\D/g, '') : v.toUpperCase().replace(/[^A-Z0-9]/g, '')).slice(0, 6);
  return (
    <div className="fld">
      <label className="k" htmlFor={id}>{label}</label>
      <div className="codebox">
        {chars.map((ch, i) => <span key={i} aria-hidden="true" className={i === Math.min(value.length, 5) ? 'cur' : ''}>{ch}</span>)}
        <input id={id} type="text" inputMode={numeric ? 'numeric' : 'text'} autoComplete="one-time-code" autoCapitalize="characters" spellCheck={false}
          maxLength={9} value={value} onChange={(e) => onChange(clean(e.target.value))} autoFocus={autoFocus} />
      </div>
    </div>
  );
}

const fmtDate = (d: Date | string) => new Date(d).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
/** Calendar months later (the server uses the same rule). */
function monthsFromNow(months: number): Date {
  const d = new Date();
  const day = d.getDate();
  d.setDate(1); d.setMonth(d.getMonth() + months);
  d.setDate(Math.min(day, new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()));
  return d;
}
/** "SGD 9.00 a month or SGD 90.00 a year" */
export const plansText = (plans?: { plan: string; cents: number }[]) => (plans ?? []).map((p) => `${money(p.cents)} a ${p.plan === 'monthly' ? 'month' : 'year'}`).join(' or ');

/** Payments are in Stripe's test mode: said plainly wherever someone pays. */
export function TestNote() {
  return <p className="testnote" role="note"><b>Test mode.</b> Use a Stripe test card such as 4242 4242 4242 4242. No real money is charged.</p>;
}

function Waiting({ label }: { label: string }) {
  return <div role="progressbar" aria-label={label} className="waitbar"><span /></div>;
}

/** After returning from Stripe: asks the server (which asks Stripe) until the payment is confirmed. */
function usePaidCheck(check: () => Promise<boolean>, on: boolean, done: () => void) {
  const [slow, setSlow] = useState(false);
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!on) return;
    let stop = false;
    let tries = 0;
    setSlow(false);
    const tick = async () => {
      if (stop) return;
      tries++;
      const ok = await check().catch(() => false);
      if (stop) return;
      if (ok) { done(); return; }
      if (tries >= 30) { setSlow(true); return; }
      window.setTimeout(tick, tries < 5 ? 1500 : 3000);
    };
    void tick();
    return () => { stop = true; };
  }, [on, n]); // eslint-disable-line react-hooks/exhaustive-deps
  return { slow, again: () => setN((x) => x + 1) };
}

function PayButton({ label, onPay }: { label: string; onPay: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  return <button type="button" className="pri" disabled={busy} onClick={async () => { setBusy(true); try { await onPay(); } finally { setBusy(false); } }}><Icon name="lock" size={18} />{busy ? 'Opening Stripe…' : label}</button>;
}

// ---------------------------------------------------------------- invite
type InviteInfo = {
  invitedBy: string; needsCode: boolean; locked: boolean; access: 'paid' | 'free' | 'life';
  email?: string; priceCents?: number | null; months?: number | null; paid?: boolean; plans?: { plan: string; cents: number }[]; payments?: boolean; testMode?: boolean;
};
type InviteStep = 'loading' | 'code' | 'locked' | 'pay' | 'confirming' | 'paid' | 'account' | 'gone';

export function Invite() {
  const [params, setParams] = useSearchParams();
  const token = params.get('token') ?? '';
  const returned = params.get('paid');
  const { refreshMe } = useNiko();
  const nav = useNavigate();
  const [info, setInfo] = useState<InviteInfo | null>(null);
  const [step, setStep] = useState<InviteStep>('loading');
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [note, setNote] = useState(params.get('cancelled') ? 'Payment cancelled. Nothing was charged.' : '');
  const path = `/auth/invite/${encodeURIComponent(token)}`;
  const next = (i: InviteInfo): InviteStep => (i.locked ? 'locked' : i.needsCode ? 'code' : i.access !== 'paid' ? 'account' : i.paid ? 'paid' : returned ? 'confirming' : 'pay');
  useEffect(() => {
    if (!token) { setErr('Open the link from your invite email.'); setStep('gone'); return; }
    api<InviteInfo>(path).then((i) => { setInfo(i); setStep(next(i)); }).catch((x) => { setErr(x.message); setStep('gone'); });
    if (params.get('cancelled')) setParams({ token }, { replace: true });
  }, [token]); // eslint-disable-line react-hooks/exhaustive-deps
  const { slow, again } = usePaidCheck(
    async () => (await api<{ paid: boolean }>(`${path}/status${returned ? `?session=${encodeURIComponent(returned)}` : ''}`)).paid,
    step === 'confirming',
    () => { setStep('paid'); setParams({ token }, { replace: true }); },
  );
  const sendCode = async (e: FormEvent) => {
    e.preventDefault(); setErr('');
    try { const i = await api<InviteInfo>(`${path}/code`, { body: { code } }); setInfo(i); setStep(next(i)); }
    catch (x) {
      const ae = x as ApiError;
      if (ae.data?.locked) setStep('locked'); else { setErr(ae.message); setCode(''); }
    }
  };
  const pay = async () => {
    setErr(''); setNote('');
    try { const r = await api<{ url: string }>(`${path}/checkout`, { method: 'POST' }); location.href = r.url; } catch (x: any) { setErr(x.message); }
  };
  const create = async (e: FormEvent) => {
    e.preventDefault(); setErr('');
    try { await api(path, { body: { name, password } }); await refreshMe(); nav('/', { replace: true }); } catch (x: any) { setErr(x.message); }
  };
  const paidInvite = info?.access === 'paid';
  const names = paidInvite ? ['Code', 'Pay', 'Account'] : ['Code', 'Account'];
  const at = step === 'code' || step === 'locked' ? 0 : step === 'account' ? names.length - 1 : 1;
  const months = info?.months ?? 12;
  const tag = { loading: 'You’re invited.', code: 'You’re invited.', locked: 'Invite locked.', pay: 'Almost there.', confirming: 'One moment.', paid: 'Welcome to Niko.', account: 'You’re invited.', gone: 'You’re invited.' }[step];
  const label = { code: 'Invite code', locked: 'Locked', pay: 'Payment', confirming: 'Confirming', paid: 'Paid', account: 'Your account' }[step as string] ?? 'Listening';
  return (
    <Shell tag={tag} label={label} mode={step === 'confirming' ? 'thinking' : 'listening'}>
      {info && step !== 'gone' && step !== 'loading' && <Steps names={names} at={at} />}
      {step === 'gone' && <><h1>Accept your invite</h1>{err && <p className="err" role="alert">{err}</p>}<Link className="lnk" to="/sign-in">Back to sign in</Link></>}

      {step === 'code' && <form onSubmit={sendCode} style={{ display: 'contents' }}>
        <div className="hd"><h1>Enter your invite code</h1><p className="sub">It’s the 6 characters in the email from {info?.invitedBy}.</p></div>
        <CodeBoxes id="invcode" label="Invite code" value={code} onChange={(v) => { setCode(v); setErr(''); }} autoFocus />
        {err && <p className="err" role="alert">{err}</p>}
        <button className="pri" disabled={code.length < 6}>Continue</button>
        <p className="sub small">No 0, O, 1 or I, so nothing looks alike. Five wrong tries locks this invite.</p>
      </form>}

      {step === 'locked' && <div className="hd"><h1>This invite is locked</h1><p className="sub">The code was entered wrong 5 times. Ask {info?.invitedBy ?? 'the person who invited you'} to send you a new code. Nothing has been charged.</p></div>}

      {step === 'pay' && info && <>
        <div className="hd"><h1>One payment, then you’re in</h1><p className="sub">One payment unlocks Niko for {lengthLabel(months)}. Nothing renews by itself.</p></div>
        {info.testMode && <TestNote />}
        {note && <p className="ok" role="status">{note}</p>}
        {err && <p className="err" role="alert">{err}</p>}
        <dl className="paysum">
          <div><dt className="k">Invited by</dt><dd>{info.invitedBy}</dd></div>
          <div><dt className="k">Email</dt><dd>{info.email}<Icon name="lock" size={16} /></dd></div>
          <div><dt className="k">Access</dt><dd>{lengthLabel(months)} · to {fmtDate(monthsFromNow(months))}</dd></div>
          <div><dt className="k">Pay once</dt><dd className="amount">{money(info.priceCents)}</dd></div>
        </dl>
        {info.payments === false ? <p className="err" role="alert">Payments aren’t set up yet. Ask {info.invitedBy} to try again later.</p> : <PayButton label={`Pay ${money(info.priceCents)}`} onPay={pay} />}
        <p className="sub small">{info.plans?.length ? `After that, keep going with ${plansText(info.plans)}. ` : ''}You’ll pay on Stripe’s secure page and come straight back. Card details never reach Niko.</p>
      </>}

      {step === 'confirming' && <>
        <div className="hd"><h1>Confirming your payment</h1><p className="sub">Back from Stripe. Waiting for Stripe to confirm with Niko, usually a few seconds.</p></div>
        <Waiting label="Confirming payment" />
        {slow ? <><p className="sub">Stripe hasn’t confirmed it yet. If you paid, it’s safe: this link stays open and you can come back to it.</p><button type="button" className="sec" onClick={again}>Check again</button></>
          : <p className="sub small">You can close this page. Your payment is safe and this link stays open until you finish.</p>}
      </>}

      {step === 'paid' && <>
        <div className="hd"><Icon name="check" size={40} /><h1>Payment received</h1><p className="sub">Receipt sent to {info?.email}. Your paid time starts when you create your account.</p></div>
        <button type="button" className="pri" onClick={() => setStep('account')}>Create your account</button>
        <p className="sub small">This link stays open until your account is made. Next, Niko learns your voice.</p>
      </>}

      {step === 'account' && info && <form onSubmit={create} style={{ display: 'contents' }}>
        <div className="hd"><h1>Create your account</h1><p className="sub">{info.access === 'life' ? `${info.invitedBy} invited you to Niko. There’s nothing to pay.` : info.access === 'free' ? `Free for ${lengthLabel(months)}, until ${fmtDate(monthsFromNow(months))}.` : `${lengthLabel(months)} of Niko, until ${fmtDate(monthsFromNow(months))}.`}</p></div>
        {err && <p className="err" role="alert">{err}</p>}
        <div className="fld"><span className="k">Email · from your invite</span><div className="in locked"><span>{info.email}</span><Icon name="lock" size={18} /></div></div>
        <Field label="Your name"><input className="in" type="text" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} required /></Field>
        <PasswordField label="Create a password" autoComplete="new-password" value={password} onChange={setPassword} meter />
        <button className="pri">Create account</button>
        {info.access === 'free' && info.plans?.length ? <p className="sub small">When the free time ends, keep going with {plansText(info.plans)}.</p> : null}
      </form>}
    </Shell>
  );
}

// ---------------------------------------------------------------- sign-up
type SignupView = { state: 'verify' | 'pay' | 'waiting' | null; email?: string; priceCents?: number | null; months?: number | null; paid?: boolean; plans?: { plan: string; cents: number }[]; testMode?: boolean };
type SignupStep = 'account' | 'email' | 'pay' | 'confirming' | 'paid' | 'waiting';

export function SignUp() {
  const { cfg, down } = useConfig();
  const { refreshMe } = useNiko();
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const returned = params.get('paid');
  const [f, setF] = useState({ name: '', email: '', password: '', token: '' });
  const [err, setErr] = useState('');
  const [note, setNote] = useState(params.get('cancelled') ? 'Payment cancelled. Nothing was charged.' : '');
  const [view, setView] = useState<SignupView | null>(null);
  const [step, setStep] = useState<SignupStep>('account');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const setup = !!cfg?.needsSetup;
  const open = cfg?.registration === 'open' && !setup;
  const fromView = (v: SignupView): SignupStep => (v.state === 'verify' ? 'email' : v.state === 'pay' ? (returned ? 'confirming' : 'pay') : v.state === 'waiting' ? (v.paid ? 'paid' : 'waiting') : 'account');
  // Picks up where this browser left off (the place is kept in a cookie, never in page storage).
  useEffect(() => {
    if (!open) return;
    api<SignupView>('/auth/sign-up/state').then((v) => { setView(v); setStep(fromView(v)); }).catch(() => undefined);
    if (params.get('cancelled')) setParams({}, { replace: true });
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const { slow, again } = usePaidCheck(
    async () => { const v = await api<SignupView>(`/auth/sign-up/status${returned ? `?session=${encodeURIComponent(returned)}` : ''}`); setView(v); return !!v.paid; },
    step === 'confirming',
    () => { setStep('paid'); setParams({}, { replace: true }); },
  );
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setErr(''); setBusy(true);
    try {
      if (setup) { await api('/auth/setup', { body: f }); await refreshMe(); nav('/', { replace: true }); return; }
      const r = await api<{ email: string }>('/auth/sign-up', { body: f });
      setView({ state: 'verify', email: r.email }); setCode(''); setStep('email');
    } catch (x: any) { setErr(x.message); } finally { setBusy(false); }
  };
  const confirm = async (e: FormEvent) => {
    e.preventDefault(); setErr('');
    try { const v = await api<SignupView>('/auth/sign-up/verify', { body: { code } }); setView(v); setStep(fromView(v)); } catch (x: any) { setErr(x.message); setCode(''); }
  };
  const resend = async () => { setErr(''); try { await api('/auth/sign-up/resend', { method: 'POST' }); setNote('New code sent. The old one no longer works.'); setCode(''); } catch (x: any) { setErr(x.message); } };
  const restart = async () => { await api('/auth/sign-up/restart', { method: 'POST' }).catch(() => undefined); setView(null); setNote(''); setErr(''); setCode(''); setStep('account'); };
  const pay = async () => { setErr(''); setNote(''); try { const r = await api<{ url: string }>('/auth/sign-up/checkout', { method: 'POST' }); location.href = r.url; } catch (x: any) { setErr(x.message); } };

  if (!cfg && down) {
    return <Shell tag="Reconnecting."><h1>Can’t reach Niko</h1><p className="err" role="alert">{down}</p><p className="sub">This page keeps trying and continues by itself once the server answers.</p><Link className="lnk" to="/sign-in">Back to sign in</Link></Shell>;
  }
  if (cfg && !setup && cfg.registration !== 'open') {
    return <Shell tag="Invite only."><h1>Invite only</h1><p className="sub">Niko accounts are created by invitation. Use the link in your invite email.</p><Link className="lnk" to="/sign-in">Sign in</Link></Shell>;
  }
  const price = view?.priceCents ?? cfg?.signup?.priceCents ?? null;
  const months = view?.months ?? cfg?.signup?.months ?? 12;
  const plans = view?.plans ?? cfg?.signup?.plans;
  const pays = !!price;
  const names = pays ? ['Account', 'Email', 'Pay'] : ['Account', 'Email'];
  const at = step === 'account' ? 0 : step === 'email' ? 1 : step === 'waiting' ? 2 : step === 'paid' ? 3 : 2;
  const email = view?.email || f.email;
  const tag = setup ? 'Set up Niko.' : { account: 'Join Niko.', email: 'Check your inbox.', pay: 'Almost there.', confirming: 'One moment.', paid: 'Almost ready.', waiting: 'Almost ready.' }[step];
  const label = setup ? 'Listening' : { account: 'Listening', email: 'Email', pay: 'Payment', confirming: 'Confirming', paid: 'Paid', waiting: 'Waiting' }[step];
  return (
    <Shell tag={tag} label={label} mode={step === 'confirming' ? 'thinking' : 'listening'}>
      {open && <Steps names={names} at={at} />}

      {step === 'account' && <form onSubmit={submit} style={{ display: 'contents' }}>
        <div className="hd">
          <h1>{setup ? 'Set up Niko' : 'Create an account'}</h1>
          <p className="sub">{setup ? 'Create the owner account. You need the setup token from the server.' : pays ? `${money(price)} once for ${lengthLabel(months)} of Niko. You pay after confirming your email, then your account is switched on.` : 'You confirm your email, then your account is switched on.'}</p>
        </div>
        {err && <p className="err" role="alert">{err}</p>}
        {setup && <Field label="Setup token"><input className="in" type="password" autoComplete="off" value={f.token} onChange={(e) => setF({ ...f, token: e.target.value })} required /></Field>}
        <Field label="Your name"><input className="in" type="text" autoComplete="name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required /></Field>
        <Field label="Email"><input className="in" type="email" autoComplete="email" placeholder="name@example.com" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} required /></Field>
        <PasswordField label="Create a password" autoComplete="new-password" value={f.password} onChange={(v) => setF({ ...f, password: v })} meter />
        <button className="pri" disabled={busy}>{setup ? 'Create owner account' : 'Create account'}</button>
        {!setup && <div className="links"><Link className="lnk" to="/sign-in">I already have an account</Link><Link className="lnk" to="/invite">I have an invite</Link></div>}
      </form>}

      {step === 'email' && <form onSubmit={confirm} style={{ display: 'contents' }}>
        <div className="hd"><h1>Check your email</h1><p className="sub">We sent a 6-digit code to {email}. It works for 15 minutes.</p></div>
        <CodeBoxes id="ecode" label="Email code" value={code} onChange={(v) => { setCode(v); setErr(''); }} numeric autoFocus />
        {err && <p className="err" role="alert">{err}</p>}
        {note && <p className="ok" role="status">{note}</p>}
        <button className="pri" disabled={code.length < 6}>Confirm email</button>
        <div className="links"><button type="button" className="lnk" onClick={resend}>Send a new code</button><button type="button" className="lnk" onClick={restart}>Wrong email?</button></div>
      </form>}

      {step === 'pay' && <>
        <div className="hd"><h1>One payment, then you’re in</h1><p className="sub">One payment unlocks Niko for {lengthLabel(months)}. Nothing renews by itself.</p></div>
        {(view?.testMode ?? cfg?.signup?.testMode) && <TestNote />}
        {note && <p className="ok" role="status">{note}</p>}
        {err && <p className="err" role="alert">{err}</p>}
        <dl className="paysum">
          <div><dt className="k">Email</dt><dd>{email}<Icon name="lock" size={16} /></dd></div>
          <div><dt className="k">Access</dt><dd>{lengthLabel(months)} · from when you’re switched on</dd></div>
          <div><dt className="k">Pay once</dt><dd className="amount">{money(price)}</dd></div>
        </dl>
        <PayButton label={`Pay ${money(price)}`} onPay={pay} />
        <p className="sub small">{plans?.length ? `After that, keep going with ${plansText(plans)}. ` : ''}You’ll pay on Stripe’s secure page. Unpaid sign-ups are removed after 7 days.</p>
      </>}

      {step === 'confirming' && <>
        <div className="hd"><h1>Confirming your payment</h1><p className="sub">Back from Stripe. Waiting for Stripe to confirm with Niko, usually a few seconds.</p></div>
        <Waiting label="Confirming payment" />
        {slow ? <><p className="sub">Stripe hasn’t confirmed it yet. If you paid, it’s safe: open this page again later on this device.</p><button type="button" className="sec" onClick={again}>Check again</button></>
          : <p className="sub small">You can close this page. Your payment is safe.</p>}
      </>}

      {(step === 'paid' || step === 'waiting') && <>
        <div className="hd"><Icon name="check" size={40} /><h1>{step === 'paid' ? 'Payment received' : 'Email confirmed'}</h1>
          <p className="sub">{step === 'paid' ? `Receipt sent to ${email}. Your paid time starts when your account is switched on.` : 'You can sign in once your account is switched on.'}</p></div>
        <div className="notebox"><Icon name="mail" size={20} /><span>We’ll email you as soon as it’s on.</span></div>
        <a className="sec" href={location.hostname.startsWith('nikoapp.') ? 'https://niko.midnightpoetry.studio/' : '/'}>Back to the Niko home page</a>
      </>}
    </Shell>
  );
}

export function Forgot() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const submit = async (e: FormEvent) => { e.preventDefault(); await api('/auth/forgot', { body: { email } }).catch(() => undefined); setSent(true); };
  return (
    <Shell tag="Reset your password.">
      <form onSubmit={submit} style={{ display: 'contents' }}>
        <h1>Forgot password</h1>
        {sent ? <p className="ok" role="status">If that email has an account, a reset link is on its way. It expires in 30 minutes.</p> : <>
          <Field label="Email"><input className="in" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required /></Field>
          <button className="pri">Send reset link</button>
        </>}
        <Link className="lnk" to="/sign-in">Back to sign in</Link>
      </form>
    </Shell>
  );
}

export function Reset() {
  const [params] = useSearchParams();
  const nav = useNavigate();
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setErr('');
    try { await api('/auth/reset', { body: { token: params.get('token'), password } }); nav('/sign-in', { replace: true }); } catch (x: any) { setErr(x.message); }
  };
  return (
    <Shell tag="Choose a new password.">
      <form onSubmit={submit} style={{ display: 'contents' }}>
        <h1>New password</h1>
        {err && <p className="err" role="alert">{err}</p>}
        <PasswordField label="New password" autoComplete="new-password" value={password} onChange={setPassword} meter />
        <button className="pri">Save and sign in</button>
      </form>
    </Shell>
  );
}
