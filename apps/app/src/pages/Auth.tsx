import { startAuthentication } from '@simplewebauthn/browser';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, Field, Icon, ParticleCore, PasswordField } from '@niko/ui';
import { useNiko } from '../niko';

function Shell({ tag, children }: { tag: string; children: ReactNode }) {
  const landing = location.hostname.startsWith('nikoapp.') ? 'https://niko.midnightpoetry.studio/' : '/';
  return (
    <div className="auth">
      <a className="wordmark mark" href={landing}>NIKO</a>
      <div className="stage">
        <ParticleCore size="min(600px, 62vh, 84vw)" mode="listening" />
        <span className="k accent">Listening</span>
        <span className="line">{tag}</span>
      </div>
      <main className="g card">{children}</main>
    </div>
  );
}

type Config = { registration: 'invite' | 'open'; needsSetup: boolean };
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
    } catch (x: any) { setErr(x?.name === 'NotAllowedError' ? 'Passkey sign-in was cancelled.' : x.message ?? 'Passkey sign-in failed.'); }
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

export function Invite() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const { refreshMe } = useNiko();
  const nav = useNavigate();
  const [info, setInfo] = useState<{ email: string; invitedBy: string } | null>(null);
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  useEffect(() => {
    if (!token) { setErr('Open the link from your invite email.'); return; }
    api(`/auth/invite/${encodeURIComponent(token)}`).then(setInfo).catch((x) => setErr(x.message));
  }, [token]);
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setErr('');
    try { await api(`/auth/invite/${encodeURIComponent(token)}`, { body: { name, password } }); await refreshMe(); nav('/', { replace: true }); } catch (x: any) { setErr(x.message); }
  };
  return (
    <Shell tag="You’re invited.">
      <form onSubmit={submit} style={{ display: 'contents' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <h1>Accept your invite</h1>
          {info && <p className="sub">{info.invitedBy} invited you to Niko.</p>}
        </div>
        {err && <p className="err" role="alert">{err}</p>}
        {info && <>
          <div className="fld"><span className="k">Email · from your invite</span><div className="in locked"><span>{info.email}</span><Icon name="lock" size={18} /></div></div>
          <Field label="Your name"><input className="in" type="text" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} required /></Field>
          <PasswordField label="Create a password" autoComplete="new-password" value={password} onChange={setPassword} meter />
          <button className="pri">Create account</button>
          <p className="sub" style={{ fontSize: 13 }}>This link works once and expires in 7 days.</p>
        </>}
        <Link className="lnk" to="/sign-in">I already have an account</Link>
      </form>
    </Shell>
  );
}

export function SignUp() {
  const { cfg, down } = useConfig();
  const { refreshMe } = useNiko();
  const nav = useNavigate();
  const [f, setF] = useState({ name: '', email: '', password: '', token: '' });
  const [err, setErr] = useState('');
  const [sent, setSent] = useState(false);
  const setup = !!cfg?.needsSetup;
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setErr('');
    try {
      if (setup) { await api('/auth/setup', { body: f }); await refreshMe(); nav('/', { replace: true }); }
      else { await api('/auth/sign-up', { body: f }); setSent(true); }
    } catch (x: any) { setErr(x.message); }
  };
  if (!cfg && down) {
    return <Shell tag="Reconnecting."><h1>Can’t reach Niko</h1><p className="err" role="alert">{down}</p><p className="sub">This page keeps trying and continues by itself once the server answers.</p><Link className="lnk" to="/sign-in">Back to sign in</Link></Shell>;
  }
  if (cfg && !setup && cfg.registration !== 'open') {
    return <Shell tag="Invite only."><h1>Invite only</h1><p className="sub">Niko accounts are created by invitation. Ask your admin for an invite.</p><Link className="lnk" to="/sign-in">Sign in</Link></Shell>;
  }
  return (
    <Shell tag={setup ? 'Set up Niko.' : 'Join Niko.'}>
      <form onSubmit={submit} style={{ display: 'contents' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <h1>{setup ? 'Set up Niko' : 'Create an account'}</h1>
          <p className="sub">{setup ? 'Create the owner account. You need the setup token from the server.' : 'An admin switches new accounts on before first sign-in.'}</p>
        </div>
        {err && <p className="err" role="alert">{err}</p>}
        {setup && <Field label="Setup token"><input className="in" type="password" autoComplete="off" value={f.token} onChange={(e) => setF({ ...f, token: e.target.value })} required /></Field>}
        <Field label="Your name"><input className="in" type="text" autoComplete="name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required /></Field>
        <Field label="Email"><input className="in" type="email" autoComplete="email" placeholder="name@example.com" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} required /></Field>
        <PasswordField label="Create a password" autoComplete="new-password" value={f.password} onChange={(v) => setF({ ...f, password: v })} meter />
        <button className="pri" disabled={sent}>{setup ? 'Create owner account' : sent ? 'Request sent · waiting for admin' : 'Request account'}</button>
        {!setup && <div className="links"><Link className="lnk" to="/sign-in">I already have an account</Link><Link className="lnk" to="/invite">I have an invite</Link></div>}
      </form>
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
