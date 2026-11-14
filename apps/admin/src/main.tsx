// Niko admin portal: sign-in with a second factor, then users and registration.
import { StrictMode, useCallback, useEffect, useState, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { api, ApiError, Field, PasswordField, Switch } from '@niko/ui';
import '@niko/ui/src/styles.css';
import './admin.css';

type Stage = 'loading' | 'password' | 'setup' | 'verify' | 'in';

function Codes({ codes }: { codes: string[] }) {
  return <ul className="codes mono" aria-label="Recovery codes">{codes.map((c) => <li key={c}>{c}</li>)}</ul>;
}
interface UserRow { id: string; name: string; email: string; role: string; status: string; isOwner: boolean; lastActiveAt: string | null }
interface InviteRow { id: string; email: string; role: string; expiresAt: string }
interface AuditRow { id: string; action: string; detail: Record<string, unknown>; createdAt: string }

const ago = (iso: string | null) => {
  if (!iso) return 'Not yet';
  const d = (Date.now() - Date.parse(iso)) / 86400_000;
  return d < 1 ? 'Today' : d < 2 ? 'Yesterday' : d < 31 ? `${Math.floor(d)} days ago` : new Date(iso).toLocaleDateString();
};

function SignIn({ stage, setStage }: { stage: Stage; setStage: (s: Stage) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [secret, setSecret] = useState<{ secret: string; uri: string } | null>(null);
  const [err, setErr] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);
  const [useRecovery, setUseRecovery] = useState(false);
  useEffect(() => {
    if (stage === 'setup' && !secret) api('/admin/totp/setup', { method: 'POST' }).then(setSecret).catch((e) => setErr(e.message));
  }, [stage, secret]);
  const pw = async (e: FormEvent) => {
    e.preventDefault(); setErr('');
    try { const r = await api<{ step: 'setup' | 'verify' }>('/admin/sign-in', { body: { email, password } }); setStage(r.step); } catch (x: any) { setErr(x.message); }
  };
  const verify = async (e: FormEvent) => {
    e.preventDefault(); setErr('');
    try {
      if (useRecovery) { await api('/admin/totp/recovery', { body: { code } }); setStage('in'); return; }
      const r = await api<{ recoveryCodes?: string[] }>('/admin/totp/verify', { body: { code } });
      if (r.recoveryCodes) setCodes(r.recoveryCodes); else setStage('in');
    } catch (x: any) { setErr(x.message); }
  };
  if (codes) {
    return (
      <div className="gate">
        <div className="g gate-card">
          <div className="brand"><span className="wordmark">NIKO</span><span className="k tag">Admin</span></div>
          <h1>Save your recovery codes</h1>
          <p className="sub">Each code works once if you lose your authenticator app. They are shown only now. Keep them in a password manager.</p>
          <Codes codes={codes} />
          <button className="pri" onClick={() => setStage('in')}>I’ve saved them</button>
        </div>
      </div>
    );
  }
  return (
    <div className="gate">
      <form className="g gate-card" onSubmit={stage === 'password' ? pw : verify}>
        <div className="brand"><span className="wordmark">NIKO</span><span className="k tag">Admin</span></div>
        <h1>{stage === 'password' ? 'Admin sign-in' : stage === 'setup' ? 'Set up your second factor' : 'Enter your code'}</h1>
        {err && <p className="err" role="alert">{err}</p>}
        {stage === 'password' && <>
          <Field label="Email"><input className="in" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required /></Field>
          <PasswordField label="Password" autoComplete="current-password" value={password} onChange={setPassword} />
          <button className="pri">Continue</button>
        </>}
        {stage === 'setup' && secret && <>
          <p className="sub">Add this key to an authenticator app (any app that supports time-based codes), then enter the 6-digit code it shows.</p>
          <Field label="Setup key"><input className="in mono" readOnly value={secret.secret} /></Field>
          <a className="lnk" href={secret.uri}>Open in an authenticator app on this device</a>
        </>}
        {(stage === 'setup' || stage === 'verify') && <>
          {useRecovery
            ? <Field label="Recovery code"><input className="in mono" autoComplete="off" placeholder="xxxxx-xxxxx" value={code} onChange={(e) => setCode(e.target.value)} required /></Field>
            : <Field label="6-digit code"><input className="in mono" inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} required /></Field>}
          <button className="pri">Sign in</button>
          {stage === 'verify' && <button type="button" className="lnk" onClick={() => { setUseRecovery(!useRecovery); setCode(''); setErr(''); }}>{useRecovery ? 'Use my authenticator app' : 'Use a recovery code instead'}</button>}
        </>}
      </form>
    </div>
  );
}

function Users({ onSignedOut }: { onSignedOut: () => void }) {
  const [tab, setTab] = useState<'users' | 'audit'>('users');
  const [me, setMe] = useState<{ name: string; email: string } | null>(null);
  const [users, setUsers] = useState<UserRow[]>([]);
  const [invites, setInvites] = useState<InviteRow[]>([]);
  const [reg, setReg] = useState<'invite' | 'open'>('invite');
  const [audit, setAudit] = useState<AuditRow[]>([]);
  const [email, setEmail] = useState('');
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [fresh, setFresh] = useState<string[] | null>(null);
  const [confirmCodes, setConfirmCodes] = useState(false);

  const guard = useCallback((e: unknown) => { if (e instanceof ApiError && e.status === 401) onSignedOut(); else setNote({ ok: false, text: (e as Error).message }); }, [onSignedOut]);
  const load = useCallback(async () => {
    try {
      const r = await api<{ users: UserRow[]; invites: InviteRow[]; registration: 'invite' | 'open' }>('/admin/users');
      setUsers(r.users); setInvites(r.invites); setReg(r.registration);
    } catch (e) { guard(e); }
  }, [guard]);
  useEffect(() => { void load(); api('/admin/me').then(setMe).catch(() => undefined); }, [load]);
  useEffect(() => { if (tab === 'audit') api<{ entries: AuditRow[] }>('/admin/audit').then((r) => setAudit(r.entries)).catch(guard); }, [tab, guard]);

  const invite = async (e: FormEvent) => {
    e.preventDefault(); setNote(null);
    try {
      const r = await api<{ emailed: boolean }>('/admin/invites', { body: { email } });
      setEmail(''); setNote({ ok: r.emailed, text: r.emailed ? 'Invite sent.' : 'Invite created, but the email could not be sent. Check the Resend setup.' });
      await load();
    } catch (x) { guard(x); }
  };
  const setMode = async (mode: 'invite' | 'open') => { try { await api('/admin/registration', { method: 'PUT', body: { mode } }); setReg(mode); } catch (e) { guard(e); } };
  const toggle = async (u: UserRow) => { try { await api(`/admin/users/${u.id}`, { method: 'PATCH', body: { status: u.status === 'active' ? 'off' : 'active' } }); await load(); } catch (e) { guard(e); } };
  const revoke = async (id: string) => { try { await api(`/admin/invites/${id}`, { method: 'DELETE' }); await load(); } catch (e) { guard(e); } };
  const newCodes = async () => {
    if (!confirmCodes) return setConfirmCodes(true);
    setConfirmCodes(false);
    try { const r = await api<{ recoveryCodes: string[] }>('/admin/recovery-codes', { method: 'POST' }); setFresh(r.recoveryCodes); setTab('users'); } catch (e) { guard(e); }
  };
  const signOut = async () => { await api('/admin/sign-out', { method: 'POST' }).catch(() => undefined); onSignedOut(); };
  const active = users.filter((u) => u.status === 'active').length;

  return (
    <div className="shell">
      <aside>
        <div className="brand"><span className="wordmark">NIKO</span><span className="k tag">Admin</span></div>
        <nav aria-label="Admin sections">
          <button className="nv" aria-current={tab === 'users' ? 'page' : undefined} onClick={() => setTab('users')}>Users</button>
          <button className="nv" aria-current={tab === 'audit' ? 'page' : undefined} onClick={() => setTab('audit')}>Audit log</button>
        </nav>
        <div className="who"><span className="sub" style={{ fontSize: 13 }}>Signed in as {me?.name || me?.email || '…'}</span><button className="nv line" onClick={newCodes}>{confirmCodes ? 'Confirm: replace old codes' : 'New recovery codes'}</button><button className="nv line" onClick={signOut}>Sign out</button></div>
      </aside>
      <main>
        {tab === 'users' ? <>
          <header><h1>Users</h1><p className="sub" style={{ fontSize: 15 }}>{active} active · {invites.length} invited · {reg === 'invite' ? 'invite only' : 'open registration'}</p></header>
          {note && <p className={note.ok ? 'ok' : 'err'} role="status">{note.text}</p>}
          {fresh && (
            <section className="g card" aria-label="New recovery codes">
              <span className="k">Your new recovery codes · shown once</span>
              <p className="sub">The old codes no longer work. Each of these works once if you lose your authenticator app.</p>
              <Codes codes={fresh} />
              <div><button className="bt" onClick={() => setFresh(null)}>I’ve saved them</button></div>
            </section>
          )}
          <div className="two">
            <section className="g card" aria-label="Registration">
              <span className="k">Registration</span>
              <div role="group" aria-label="Who can create an account" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button className="seg" aria-pressed={reg === 'invite'} onClick={() => setMode('invite')}>Invite only</button>
                <button className="seg" aria-pressed={reg === 'open'} onClick={() => setMode('open')}>Open registration</button>
              </div>
              <p className="sub">{reg === 'invite' ? 'Only people you invite can create an account. The sign-up page is hidden.' : 'Anyone can sign up. New accounts stay switched off until you enable them.'}</p>
            </section>
            <form className="g card" aria-label="Invite a user" onSubmit={invite}>
              <span className="k">Invite a user</span>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                <label style={{ flex: 1, minWidth: 200, display: 'flex' }}><span className="sr">Email address</span><input className="in" style={{ height: 44 }} type="email" placeholder="name@example.com" autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} required /></label>
                <button className="pri" style={{ height: 44, fontSize: 14 }}>Send invite</button>
              </div>
              <p className="sub">Invite links work once and expire after 7 days.</p>
            </form>
          </div>
          <section className="g card table" aria-label="Accounts">
            <div className="tr head"><span className="k">Name</span><span className="k">Email</span><span className="k">Role</span><span className="k">Status</span><span className="k">Last active</span><span className="k">Access</span></div>
            {users.map((u) => (
              <div key={u.id} className="tr">
                <b>{u.name || '—'}</b><span className="sub ell">{u.email}</span><span>{u.role === 'admin' ? 'Admin' : 'Member'}</span>
                <span className="st"><i className={u.status === 'active' ? 'on' : ''} />{u.status === 'active' ? 'Active' : 'Switched off'}</span>
                <span className="sub">{ago(u.lastActiveAt)}</span>
                <span>{u.isOwner ? <span className="k">Owner</span> : <Switch on={u.status === 'active'} onChange={() => toggle(u)} label={`Account enabled for ${u.email}`} />}</span>
              </div>
            ))}
            {invites.map((i) => (
              <div key={i.id} className="tr">
                <b>Invited</b><span className="sub ell">{i.email}</span><span>{i.role === 'admin' ? 'Admin' : 'Member'}</span>
                <span className="st"><i />Invited</span><span className="sub">Not yet</span>
                <span><button className="bt" onClick={() => revoke(i.id)}>Revoke</button></span>
              </div>
            ))}
          </section>
          <p className="sub" style={{ fontSize: 13 }}>Admin sign-in needs a second factor. Every change here is written to the audit log.</p>
        </> : <>
          <header><h1>Audit log</h1><p className="sub" style={{ fontSize: 15 }}>The latest 200 events. File entries record name, size and time only, never contents.</p></header>
          <section className="g card table" aria-label="Audit entries">
            {audit.map((a) => (
              <div key={a.id} className="tr audit"><span className="sub">{new Date(a.createdAt).toLocaleString()}</span><b>{a.action}</b><span className="sub ell">{Object.entries(a.detail).map(([k, v]) => `${k}: ${String(v)}`).join(' · ')}</span></div>
            ))}
          </section>
        </>}
      </main>
    </div>
  );
}

function Admin() {
  const [stage, setStage] = useState<Stage>('loading');
  useEffect(() => {
    api('/admin/me').then(() => setStage('in')).catch((e) => setStage(e instanceof ApiError && e.data?.mfa ? 'verify' : 'password'));
  }, []);
  if (stage === 'loading') return null;
  return stage === 'in' ? <Users onSignedOut={() => setStage('password')} /> : <SignIn stage={stage} setStage={setStage} />;
}

createRoot(document.getElementById('root')!).render(<StrictMode><Admin /></StrictMode>);
