// Settings → Account → Screen lock. The code is set (and changed, or the lock turned off) with the account password;
// the time and what shows on the locked screen change freely. The code goes only to the server, which keeps a hash.
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { LOCK_MINUTES, weakLockCode, type LockInfo } from '@niko/shared';
import { api, Icon, PasswordField, Switch } from '@niko/ui';
import { useNiko } from '../niko';

type Info = LockInfo & { passkeys: number };
const minsText = (m: number) => (m === 60 ? '1 h' : `${m} min`);
const ago = (iso?: string) => {
  if (!iso) return '';
  const d = Math.floor((Date.now() - Date.parse(iso)) / 86400_000);
  return d <= 0 ? 'Set today' : d === 1 ? 'Set yesterday' : `Set ${d} days ago`;
};

export function ScreenLock({ onNote }: { onNote: (n: { ok: boolean; text: string }) => void }) {
  const n = useNiko();
  const [info, setInfo] = useState<Info | null>(null);
  const [sheet, setSheet] = useState<'set' | 'change' | 'off' | null>(null);
  const dlg = useRef<HTMLDialogElement>(null);
  useEffect(() => { void api<Info>('/lock').then(setInfo).catch(() => undefined); }, []);
  const open = (s: 'set' | 'change' | 'off') => { setSheet(s); dlg.current?.showModal(); };
  const save = async (body: Record<string, unknown>) => {
    try { const r = await api<Info>('/lock', { method: 'PUT', body }); setInfo(r); await n.refreshMe(); }
    catch (x: any) { onNote({ ok: false, text: x.message }); }
  };
  if (!info) return <section className="set-card" aria-label="Screen lock"><span className="k">Screen lock</span><p className="sub">Loading…</p></section>;
  const showing = info.showNew !== 'off';
  return (
    <section className="set-card lock-card" aria-label="Screen lock">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}><span className="k">Screen lock</span>{info.on && <span className="hint">{ago(info.setAt)}</span>}</div>
      <p className="sub">After the time you choose without use, Niko locks and puts your content away; the core stays. Say “Niko” or tap, then enter your 6-digit code.</p>
      <div className="row"><Icon name="lock" /><span className="txt"><b>Lock Niko when I’m away</b><span className="sub">{info.on ? `Locks after ${minsText(info.mins)} without use` : 'Off'}</span></span>
        <Switch on={info.on} onChange={(v) => open(v ? 'set' : 'off')} label="Lock Niko when I’m away" /></div>
      {info.on && <>
        <div className="grp">
          <span className="k">Lock after</span>
          <div className="lock-mins" role="group" aria-label="Lock after">
            {LOCK_MINUTES.map((m) => <button key={m} className="seg" aria-pressed={info.mins === m} onClick={() => void save({ mins: m })}>{minsText(m)}</button>)}
          </div>
        </div>
        <div className="row"><Icon name="key" /><span className="txt"><b>Code</b><span className="sub">Six digits, typed, never said aloud</span></span>
          <button className="bt" onClick={() => open('change')}>Change code</button></div>
        <div className="row"><Icon name="mail" /><span className="txt"><b>Show new items while locked</b><span className="sub">New mail, messages and events still appear. Opening or replying asks for your code.</span></span>
          <Switch on={showing} onChange={(v) => void save({ showNew: v ? 'who' : 'off' })} label="Show new items while locked" /></div>
        {showing && (
          <div className="grp lock-show">
            <span className="k">On the locked screen, show</span>
            <div className="lock-mins" role="group" aria-label="On the locked screen, show">
              <button className="seg" aria-pressed={info.showNew === 'who'} onClick={() => void save({ showNew: 'who' })}>Who it’s from</button>
              <button className="seg" aria-pressed={info.showNew === 'full'} onClick={() => void save({ showNew: 'full' })}>Who and a preview</button>
            </div>
            <span className="hint">{info.showNew === 'who' ? 'Recommended: anyone at your screen sees only the sender.' : 'Anyone at your screen can read the first line.'}</span>
          </div>
        )}
        <div className="row"><Icon name="key" /><span className="txt"><b>Also unlock with my passkey</b><span className="sub">{info.passkeys ? 'Face, fingerprint or device PIN, on devices where your passkey is saved.' : 'Add a passkey below to use this.'}</span></span>
          <Switch on={info.passkey && info.passkeys > 0} disabled={!info.passkeys} onChange={(v) => void save({ passkey: v })} label="Also unlock with my passkey" /></div>
        <div className="lock-now">
          <button className="sec" onClick={() => n.lockNow()}><Icon name="lock" size={18} />Lock now</button>
          <span className="hint">Or say “Niko, lock”.</span>
        </div>
      </>}
      <p className="set-note">Changing the code or turning the lock off asks for your password. Five wrong codes sign this device out.</p>
      <dialog ref={dlg} className="sheet" onClose={() => setSheet(null)}>
        {sheet && n.me && <CodeSheet kind={sheet} email={n.me.email} onCancel={() => dlg.current?.close()} onDone={async (body, text) => {
          try { const r = await api<Info>('/lock', { method: 'PUT', body }); setInfo(r); await n.refreshMe(); dlg.current?.close(); onNote({ ok: true, text }); return ''; }
          catch (x: any) { return x.message as string; }
        }} />}
      </dialog>
    </section>
  );
}

function CodeSheet({ kind, email, onCancel, onDone }: { kind: 'set' | 'change' | 'off'; email: string; onCancel: () => void; onDone: (body: Record<string, unknown>, text: string) => Promise<string> }) {
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [again, setAgain] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const off = kind === 'off';
  const digits = (v: string) => v.replace(/\D/g, '').slice(0, 6);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (!off) {
      if (code.length !== 6) return setErr('The code must be 6 digits.');
      if (weakLockCode(code)) return setErr('That code is too easy to guess. Avoid one digit repeated or digits in a row.');
      if (code !== again) return setErr('The two codes don’t match.');
    }
    setBusy(true); setErr('');
    const msg = await onDone(off ? { on: false, password } : { code, password, on: true },
      off ? 'Screen lock turned off.' : kind === 'set' ? 'Screen lock is on. Niko locks when you’re away.' : 'Code changed.');
    setBusy(false);
    if (msg) setErr(msg);
  };
  return (
    <form onSubmit={submit} className="cal-form">
      <h2 className="sheet-h">{off ? 'Turn off the screen lock' : kind === 'set' ? 'Set your code' : 'Change your code'}</h2>
      <p className="sub">{off ? 'Your code is removed. Enter your password so nobody at your screen can turn it off.' : 'Your password is asked so nobody at your screen can change it.'}</p>
      <input type="email" name="username" autoComplete="username" value={email} readOnly hidden />
      <PasswordField label="Your password" autoComplete="current-password" value={password} onChange={(v) => { setErr(''); setPassword(v); }} />
      {!off && <>
        <div className="fld">
          <label className="k" htmlFor="lock-new">New code</label>
          <input id="lock-new" className="in lock-code" type="password" inputMode="numeric" pattern="[0-9]*" maxLength={6} autoComplete="new-password" value={code} onChange={(e) => { setErr(''); setCode(digits(e.target.value)); }} placeholder="••••••" />
        </div>
        <div className="fld">
          <label className="k" htmlFor="lock-again">Once more</label>
          <input id="lock-again" className="in lock-code" type="password" inputMode="numeric" pattern="[0-9]*" maxLength={6} autoComplete="new-password" value={again} onChange={(e) => { setErr(''); setAgain(digits(e.target.value)); }} placeholder="••••••" />
        </div>
        <span className="hint">Six digits. Avoid 123456, a repeated digit or your birthday.</span>
      </>}
      {err && <p className="err" role="alert">{err}</p>}
      <div className="sheet-actions">
        <button type="button" className="sec" onClick={onCancel}>Cancel</button>
        <button className="pri" disabled={busy || !password || (!off && (code.length < 6 || again.length < 6))}>{busy ? 'Saving…' : off ? 'Turn off' : 'Save code'}</button>
      </div>
    </form>
  );
}
