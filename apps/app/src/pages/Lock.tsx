// The code entry on the locked Home: the caption under the core turns into six small dots. The code is typed (the
// keyboard on a computer, the phone's own number pad), never said, and goes only to the server, which checks it.
import { useEffect, useRef, useState } from 'react';
import { api } from '@niko/ui';
import { useNiko } from '../niko';

export function LockEntry() {
  const n = useNiko();
  const [code, setCode] = useState('');
  const [state, setState] = useState<'' | 'checking' | 'ok' | 'bad'>('');
  const [err, setErr] = useState('');
  const [forgot, setForgot] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  const passkey = !!n.me?.lock?.passkey && typeof window !== 'undefined' && 'PublicKeyCredential' in window;
  const focus = () => field.current?.focus({ preventScroll: true });
  // Focus on showing, and again when it is asked for another reason (Open on a new item while it is already up).
  useEffect(() => { focus(); }, [n.lockAsk]); // eslint-disable-line react-hooks/exhaustive-deps
  // Esc closes the entry (the question that was waiting is dropped).
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') n.cancelUnlock(); };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [n]);

  const wrong = (msg: string) => {
    setState('bad'); setErr(msg);
    window.setTimeout(() => { setCode(''); setState(''); focus(); }, 420);
  };
  const submit = async (c: string) => {
    setState('checking'); setErr('');
    const r = await n.unlock(c);
    if (r.ok) { setState('ok'); return; }
    if (r.signedOut) { setState('bad'); setErr(r.error); return; }
    wrong(r.left != null ? `Wrong code · ${r.left} ${r.left === 1 ? 'try' : 'tries'} left` : r.error);
  };
  const type = (v: string) => {
    if (state === 'checking' || state === 'ok') return;
    const digits = v.replace(/\D/g, '').slice(0, 6);
    setCode(digits); setErr('');
    if (digits.length === 6) void submit(digits);
  };
  const withPasskey = async () => {
    setErr('');
    const r = await n.unlockWithPasskey();
    if (r.ok) setState('ok'); else { setErr(r.error); focus(); }
  };
  const signOut = async () => {
    await api('/auth/sign-out', { body: {} }).catch(() => undefined);
    location.assign(location.pathname.startsWith('/app') ? '/app/sign-in' : '/sign-in');
  };

  return (
    <div className="lock-entry" onClick={focus}>
      <p id="lock-why">{n.lockAsk?.reason}</p>
      <div className={'lock-dots' + (state === 'ok' ? ' ok' : state === 'bad' ? ' bad' : state === 'checking' ? ' checking' : '')} aria-hidden="true">
        {Array.from({ length: 6 }, (_, i) => <i key={i} className={i < code.length ? 'on' : ''} />)}
      </div>
      <input ref={field} className="lock-field" value={code} onChange={(e) => type(e.target.value)} inputMode="numeric" pattern="[0-9]*" maxLength={6}
        autoComplete="off" autoCorrect="off" spellCheck={false} aria-label={`Code, 6 digits, ${code.length} entered`} aria-describedby="lock-why lock-err" disabled={state === 'checking' || state === 'ok'} />
      <span id="lock-err" className="lock-err" role="alert">{err}</span>
      {forgot ? (
        <span className="lock-forgot">
          <span>Forgot your code? Sign out, then sign in again with your password or passkey.</span>
          <span className="lock-links"><button className="lock-link strong" onClick={() => void signOut()}>Sign out</button><span aria-hidden="true">·</span><button className="lock-link" onClick={() => { setForgot(false); focus(); }}>Back</button></span>
        </span>
      ) : (
        <span className="lock-links">
          {passkey && <><button className="lock-link" onClick={(e) => { e.stopPropagation(); void withPasskey(); }}>Use passkey</button><span aria-hidden="true">·</span></>}
          <button className="lock-link" onClick={(e) => { e.stopPropagation(); setForgot(true); }}>Forgot code?</button>
          <span aria-hidden="true">·</span>
          <button className="lock-link" onClick={(e) => { e.stopPropagation(); n.cancelUnlock(); }}>Cancel</button>
        </span>
      )}
    </div>
  );
}
