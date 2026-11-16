// Niko admin portal: sign-in with a second factor, then users and registration.
import { StrictMode, useCallback, useEffect, useState, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { api, ApiError, Field, PasswordField, Switch } from '@niko/ui';
import { AI_OPTION_GROUPS, aiHasBrain, aiOff, CALENDAR_LIMIT_STEPS, GLANCE_PART_NAMES, GLANCE_PARTS, GLANCE_STEPS, type AccountLimits, type GlanceLimits } from '@niko/shared';
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
  return d < 1 ? 'Today' : d < 2 ? 'Yesterday' : d < 31 ? `${Math.floor(d)} days ago` : d < 62 ? 'Last month' : new Date(iso).toLocaleDateString();
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

// ---------------------------------------------------------------- AI options
type AiUser = { id: string; name: string; email: string; role: string; status: string; aiAccess: Record<string, boolean> };
/** Which AI services people can see and use: a default for everyone, and changes for any one person on top of it. */
function AiOptions({ guard }: { guard: (e: unknown) => void }) {
  const [defaults, setDefaults] = useState<Record<string, boolean> | null>(null);
  const [people, setPeople] = useState<AiUser[]>([]);
  const [sel, setSel] = useState<string>('all');
  const [draft, setDraft] = useState<Record<string, boolean>>({});
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const load = useCallback(async () => {
    try { const r = await api<{ defaults: Record<string, boolean>; users: AiUser[] }>('/admin/ai'); setDefaults(r.defaults); setPeople(r.users); }
    catch (e) { guard(e); }
  }, [guard]);
  useEffect(() => { void load(); }, [load]);
  const person = people.find((p) => p.id === sel) ?? null;
  // What is being edited: the default itself, or this person's changes to it.
  useEffect(() => { if (defaults) { setDraft(person ? { ...person.aiAccess } : { ...defaults }); setDirty(false); } }, [sel, defaults, people]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!defaults) return null;
  const defOn = (k: string) => defaults[k] ?? true;
  const on = (k: string) => (k in draft ? draft[k]! : person ? defOn(k) : true);
  const changed = (k: string) => !!person && k in draft && draft[k] !== defOn(k);
  const set = (k: string, v: boolean) => {
    setNote(null); setDirty(true);
    const next = { ...draft };
    if (person && v === defOn(k)) delete next[k]; else next[k] = v; // a change back to the default is no longer a change
    setDraft(next);
  };
  const reset = (k: string) => { const next = { ...draft }; delete next[k]; setDraft(next); setDirty(true); };
  const offNow = person ? aiOff(defaults, draft) : aiOff(draft, {});
  const noBrain = !aiHasBrain(offNow);
  const count = (p: AiUser) => Object.keys(p.aiAccess).length;
  const save = async () => {
    setBusy(true); setNote(null);
    try {
      if (person) await api(`/admin/ai/users/${person.id}`, { method: 'PUT', body: { access: draft } });
      else await api('/admin/ai/default', { method: 'PUT', body: { access: draft } });
      await load(); setNote({ ok: true, text: person ? `Saved for ${person.name || person.email}.` : 'Saved. Everyone without their own changes gets this within a minute.' });
    } catch (e) { if (e instanceof ApiError && e.status === 401) guard(e); else setNote({ ok: false, text: (e as Error).message }); } finally { setBusy(false); }
  };
  const first = (p: AiUser) => (p.name || p.email).split(' ')[0];
  return <>
    <header><h1>AI options</h1><p className="sub" style={{ fontSize: 15, maxWidth: 860 }}>Choose which AI services people can see and use on their Engine and Voice screens. Set the default for everyone, then change it for anyone who needs something different.</p></header>
    {note && <p className={note.ok ? 'ok' : 'err'} role="status">{note.text}</p>}
    <div className="ai-grid">
      <section className="g card ai-people" aria-label="Applies to">
        <span className="k" style={{ padding: '0 6px' }}>Applies to</span>
        <div className="ai-list">
          {[{ id: 'all', name: 'Everyone', sub: 'The default for all accounts', badge: 'Default' }, ...people.map((p) => ({ id: p.id, name: p.name || p.email, sub: p.email, badge: p.role === 'admin' ? 'Admin' : count(p) ? `${count(p)} ${count(p) === 1 ? 'change' : 'changes'}` : 'Default' }))].map((p) => (
            <button key={p.id} className="who-row" aria-pressed={p.id === sel} onClick={() => { if (dirty && !window.confirm('Leave without saving these changes?')) return; setSel(p.id); setNote(null); }}>
              <span className="who-txt"><b>{p.name}</b><span>{p.sub}</span></span><span className="who-badge">{p.badge}</span>
            </button>
          ))}
        </div>
        <p className="sub" style={{ fontSize: 12, padding: '0 6px' }}>New accounts get the default. Admins always have every option.</p>
      </section>
      <section className="g card ai-options" aria-label="Options">
        <div className="ai-head">
          <div><h2>{person ? person.name || person.email : 'Everyone · default'}</h2>
            <p className="sub" style={{ fontSize: 13 }}>{person ? (person.role === 'admin' ? 'Admins always have every option; these apply if they are made a member.' : Object.keys(draft).length ? `${Object.keys(draft).length} different from the default. Everything else follows the default.` : `Follows the default. Turn anything on or off to change it for ${first(person)} only.`) : 'What every account gets, unless it is changed for that person.'}</p></div>
          <div className="ai-acts">
            {person && <button className="bt" onClick={() => { setDraft({}); setDirty(true); }} disabled={!Object.keys(draft).length}>Reset to default</button>}
            <button className="pri" style={{ height: 44, fontSize: 14 }} onClick={save} disabled={busy || !dirty || noBrain}>{busy ? 'Saving…' : 'Save'}</button>
          </div>
        </div>
        {noBrain && <p className="err" role="alert">At least one brain must stay on, or Niko could not answer. Turn one back on to save.</p>}
        <div className="ai-groups">
          {AI_OPTION_GROUPS.map((g) => {
            const shown = !g.section || on(g.section);
            return (
              <div key={g.id} className="ai-group">
                <div className="ai-ghead">
                  <span className="ai-gname"><span className="k" style={{ color: '#fff' }}>{g.name}</span><span className="sub" style={{ fontSize: 12 }}>{g.where}{g.section ? (shown ? ' · shown' : ' · hidden') : ' · always shown'}</span></span>
                  {g.section && <span className="ai-ctl">
                    {changed(g.section) && <><span className="chg">Changed</span><button className="lnk" onClick={() => reset(g.section!)}>Reset</button></>}
                    <Switch on={shown} onChange={(v) => set(g.section!, v)} label={`Show ${g.name}`} />
                  </span>}
                </div>
                <div className={'ai-items' + (shown ? '' : ' dim')}>
                  {(g.id === 'voices' || g.id === 'hears') && <div className="ai-row"><span className="ai-txt"><span>{g.id === 'voices' ? 'Device voice' : 'Device speech recognition'}</span><span className="sub">{g.id === 'voices' ? 'The last resort, on every device' : 'The last resort, and always hears “Niko”'}</span></span><span className="pill">Always on</span></div>}
                  {g.items.map((it) => (
                    <div key={it.key} className="ai-row">
                      <span className="ai-txt"><span>{it.name}</span><span className="sub">{changed(it.key) ? `Default is ${defOn(it.key) ? 'on' : 'off'}` : it.sub}</span></span>
                      {changed(it.key) && <><span className="chg">Changed</span><button className="lnk" onClick={() => reset(it.key)}>Reset</button></>}
                      <Switch on={on(it.key)} onChange={(v) => set(it.key, v)} label={`${it.name} (${g.name})`} disabled={!shown} />
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
        <p className="sub" style={{ fontSize: 12, lineHeight: 1.5 }}>Turning a service off hides it from that person’s screens and the server refuses it, so a key they already saved stops being used. Their keys are kept, not deleted, and work again when you turn the service back on. Every change is written to the audit log.</p>
      </section>
    </div>
  </>;
}

// ---------------------------------------------------------------- new items on Home
type GlanceUser = { id: string; name: string; email: string; role: string; status: string; glanceLimits: Partial<GlanceLimits> };
const everyLabel = (m: number) => (m === 0 ? 'Not allowed' : m === 60 ? 'Every hour at most' : m === 1 ? 'Every minute at most' : `Every ${m} minutes at most`);
/** Whether people can turn on new items on Home, and the most often each kind may be checked: a default, then per person. */
function GlanceAdmin({ guard }: { guard: (e: unknown) => void }) {
  const [defaults, setDefaults] = useState<GlanceLimits | null>(null);
  const [people, setPeople] = useState<GlanceUser[]>([]);
  const [sel, setSel] = useState('all');
  const [draft, setDraft] = useState<Partial<GlanceLimits>>({});
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const load = useCallback(async () => {
    try { const r = await api<{ defaults: GlanceLimits; users: GlanceUser[] }>('/admin/glance'); setDefaults(r.defaults); setPeople(r.users); }
    catch (e) { guard(e); }
  }, [guard]);
  useEffect(() => { void load(); }, [load]);
  const person = people.find((p) => p.id === sel) ?? null;
  useEffect(() => { if (defaults) { setDraft(person ? { ...person.glanceLimits } : { ...defaults }); setDirty(false); } }, [sel, defaults, people]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!defaults) return null;
  type K = keyof GlanceLimits;
  const val = <T extends K>(k: T): GlanceLimits[T] => (k in draft ? (draft[k] as GlanceLimits[T]) : defaults[k]);
  const changed = (k: K) => !!person && k in draft && draft[k] !== defaults[k];
  const set = (k: K, v: boolean | number) => {
    setNote(null); setDirty(true);
    const next: Partial<GlanceLimits> = { ...draft };
    if (person && v === defaults[k]) delete next[k]; else (next as Record<string, unknown>)[k] = v;
    setDraft(next);
  };
  const reset = (k: K) => { const next = { ...draft }; delete next[k]; setDraft(next); setDirty(true); };
  const count = (p: GlanceUser) => Object.keys(p.glanceLimits).length;
  const save = async () => {
    setBusy(true); setNote(null);
    try {
      if (person) await api(`/admin/glance/users/${person.id}`, { method: 'PUT', body: { limits: draft } });
      else await api('/admin/glance/default', { method: 'PUT', body: { limits: draft } });
      await load(); setNote({ ok: true, text: person ? `Saved for ${person.name || person.email}.` : 'Saved. It applies to everyone without their own changes within a minute.' });
    } catch (e) { if (e instanceof ApiError && e.status === 401) guard(e); else setNote({ ok: false, text: (e as Error).message }); } finally { setBusy(false); }
  };
  const allowed = val('allowed');
  return <>
    <header><h1>New items</h1><p className="sub" style={{ fontSize: 15, maxWidth: 860 }}>New emails, messages, calendar events and changed notes can appear on people’s Home for 30 seconds. Each person turns it on and chooses how often Niko checks; here you set whether they can, and the most often each kind may be checked.</p></header>
    {note && <p className={note.ok ? 'ok' : 'err'} role="status">{note.text}</p>}
    <div className="ai-grid">
      <section className="g card ai-people" aria-label="Applies to">
        <span className="k" style={{ padding: '0 6px' }}>Applies to</span>
        <div className="ai-list">
          {[{ id: 'all', name: 'Everyone', sub: 'The default for all accounts', badge: 'Default' }, ...people.map((p) => ({ id: p.id, name: p.name || p.email, sub: p.email, badge: count(p) ? `${count(p)} ${count(p) === 1 ? 'change' : 'changes'}` : 'Default' }))].map((p) => (
            <button key={p.id} className="who-row" aria-pressed={p.id === sel} onClick={() => { if (dirty && !window.confirm('Leave without saving these changes?')) return; setSel(p.id); setNote(null); }}>
              <span className="who-txt"><b>{p.name}</b><span>{p.sub}</span></span><span className="who-badge">{p.badge}</span>
            </button>
          ))}
        </div>
        <p className="sub" style={{ fontSize: 12, padding: '0 6px' }}>New accounts get the default. These limits apply to admins too.</p>
      </section>
      <section className="g card ai-options" aria-label="Limits">
        <div className="ai-head">
          <div><h2>{person ? person.name || person.email : 'Everyone · default'}</h2>
            <p className="sub" style={{ fontSize: 13 }}>{person ? (Object.keys(draft).length ? `${Object.keys(draft).length} different from the default. Everything else follows the default.` : 'Follows the default. Change anything to set it for this person only.') : 'What every account gets, unless it is changed for that person.'}</p></div>
          <div className="ai-acts">
            {person && <button className="bt" onClick={() => { setDraft({}); setDirty(true); }} disabled={!Object.keys(draft).length}>Reset to default</button>}
            <button className="pri" style={{ height: 44, fontSize: 14 }} onClick={save} disabled={busy || !dirty}>{busy ? 'Saving…' : 'Save'}</button>
          </div>
        </div>
        <div className="ai-row">
          <span className="ai-txt"><span>New items on Home</span><span className="sub">{allowed ? 'People can turn it on under Appearance (it starts off).' : 'Hidden: people can’t turn it on.'}</span></span>
          {changed('allowed') && <><span className="chg">Changed</span><button className="lnk" onClick={() => reset('allowed')}>Reset</button></>}
          <Switch on={allowed} onChange={(v) => set('allowed', v)} label="Allow new items on Home" />
        </div>
        <div className={'ai-items' + (allowed ? '' : ' dim')}>
          <span className="k" style={{ display: 'block', padding: '16px 0 6px' }}>Most often each kind may be checked</span>
          {GLANCE_PARTS.map((p) => (
            <div key={p} className="ai-row">
              <span className="ai-txt"><span>{GLANCE_PART_NAMES[p]}</span><span className="sub">{changed(p) ? `Default is ${everyLabel(defaults[p]).toLowerCase()}` : p === 'chats' ? 'Telegram and Slack arrive instantly; this is how often Home looks' : p === 'mail' ? 'Gmail, Outlook and other email' : p === 'events' ? 'New events, invitations and reminders' : 'Notion and OneNote'}</span></span>
              {changed(p) && <><span className="chg">Changed</span><button className="lnk" onClick={() => reset(p)}>Reset</button></>}
              <label className="sr" htmlFor={`gl-${p}`}>{GLANCE_PART_NAMES[p]}: most often</label>
              <select id={`gl-${p}`} className="in gl-sel" value={val(p)} disabled={!allowed} onChange={(e) => set(p, Number(e.target.value))}>
                {[0, ...GLANCE_STEPS].map((m) => <option key={m} value={m}>{everyLabel(m)}</option>)}
              </select>
            </div>
          ))}
        </div>
        <p className="sub" style={{ fontSize: 12, lineHeight: 1.5 }}>The server never checks a service more often than this, whatever a person chooses. Checks run only while that person has Home open and on screen, and pause after 30 minutes without use. Each check of email, calendar or notes wakes the database; longer limits use less of its monthly allowance. Every change is written to the audit log.</p>
      </section>
    </div>
  </>;
}

// ---------------------------------------------------------------- limits (how many calendar links an account may keep)
type LimitsUser = { id: string; name: string; email: string; role: string; status: string; accountLimits: Partial<AccountLimits> };
function LimitsAdmin({ guard }: { guard: (e: unknown) => void }) {
  const [defaults, setDefaults] = useState<AccountLimits | null>(null);
  const [people, setPeople] = useState<LimitsUser[]>([]);
  const [sel, setSel] = useState('all');
  const [draft, setDraft] = useState<Partial<AccountLimits>>({});
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const load = useCallback(async () => {
    try { const r = await api<{ defaults: AccountLimits; users: LimitsUser[] }>('/admin/limits'); setDefaults(r.defaults); setPeople(r.users); }
    catch (e) { guard(e); }
  }, [guard]);
  useEffect(() => { void load(); }, [load]);
  const person = people.find((p) => p.id === sel) ?? null;
  useEffect(() => { if (defaults) { setDraft(person ? { ...person.accountLimits } : { ...defaults }); setDirty(false); } }, [sel, defaults, people]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!defaults) return null;
  const cals = draft.calendars ?? defaults.calendars;
  const changed = !!person && draft.calendars !== undefined && draft.calendars !== defaults.calendars;
  const setCals = (v: number) => { setNote(null); setDirty(true); setDraft(person && v === defaults.calendars ? {} : { calendars: v }); };
  const save = async () => {
    setBusy(true); setNote(null);
    try {
      if (person) await api(`/admin/limits/users/${person.id}`, { method: 'PUT', body: { limits: draft } });
      else await api('/admin/limits/default', { method: 'PUT', body: { limits: draft } });
      await load(); setNote({ ok: true, text: person ? `Saved for ${person.name || person.email}.` : 'Saved. It applies to everyone without their own limit within a minute.' });
    } catch (e) { if (e instanceof ApiError && e.status === 401) guard(e); else setNote({ ok: false, text: (e as Error).message }); } finally { setBusy(false); }
  };
  const count = (p: LimitsUser) => Object.keys(p.accountLimits).length;
  return <>
    <header><h1>Limits</h1><p className="sub" style={{ fontSize: 15, maxWidth: 860 }}>How much each account may add. Calendar links are downloaded and unpacked every time Niko builds someone’s day, so many of them make it slower.</p></header>
    {note && <p className={note.ok ? 'ok' : 'err'} role="status">{note.text}</p>}
    <div className="ai-grid">
      <section className="g card ai-people" aria-label="Applies to">
        <span className="k" style={{ padding: '0 6px' }}>Applies to</span>
        <div className="ai-list">
          {[{ id: 'all', name: 'Everyone', sub: 'The default for all accounts', badge: 'Default' }, ...people.map((p) => ({ id: p.id, name: p.name || p.email, sub: p.email, badge: count(p) ? `${p.accountLimits.calendars} calendars` : 'Default' }))].map((p) => (
            <button key={p.id} className="who-row" aria-pressed={p.id === sel} onClick={() => { if (dirty && !window.confirm('Leave without saving these changes?')) return; setSel(p.id); setNote(null); }}>
              <span className="who-txt"><b>{p.name}</b><span>{p.sub}</span></span><span className="who-badge">{p.badge}</span>
            </button>
          ))}
        </div>
        <p className="sub" style={{ fontSize: 12, padding: '0 6px' }}>New accounts get the default. These limits apply to admins too.</p>
      </section>
      <section className="g card ai-options" aria-label="Limits">
        <div className="ai-head">
          <div><h2>{person ? person.name || person.email : 'Everyone · default'}</h2>
            <p className="sub" style={{ fontSize: 13 }}>{person ? (changed ? 'Different from the default.' : 'Follows the default. Change it to set it for this person only.') : 'What every account gets, unless it is changed for that person.'}</p></div>
          <div className="ai-acts">
            {person && <button className="bt" onClick={() => { setDraft({}); setDirty(true); }} disabled={!changed}>Reset to default</button>}
            <button className="pri" style={{ height: 44, fontSize: 14 }} onClick={save} disabled={busy || !dirty}>{busy ? 'Saving…' : 'Save'}</button>
          </div>
        </div>
        <div className="ai-row">
          <span className="ai-txt"><span>Calendar links</span><span className="sub">{changed ? `Default is ${defaults.calendars}` : 'Private and public iCal calendars, per account'}</span></span>
          {changed && <><span className="chg">Changed</span><button className="lnk" onClick={() => setCals(defaults.calendars)}>Reset</button></>}
          <label className="sr" htmlFor="lim-cal">Calendar links: most per account</label>
          <select id="lim-cal" className="in gl-sel" value={cals} onChange={(e) => setCals(Number(e.target.value))}>
            {CALENDAR_LIMIT_STEPS.map((n) => <option key={n} value={n}>{n === 1 ? '1 calendar' : `Up to ${n}`}</option>)}
          </select>
        </div>
        <p className="sub" style={{ fontSize: 12, lineHeight: 1.5 }}>Lowering a limit removes nothing: people keep what they have, but only that many are read, and they can’t add more until they are under it. Every change is written to the audit log.</p>
      </section>
    </div>
  </>;
}

function Users({ onSignedOut, initialMe }: { onSignedOut: () => void; initialMe?: { name: string; email: string } | null }) {
  const [tab, setTab] = useState<'users' | 'ai' | 'glance' | 'limits' | 'security' | 'audit'>('users');
  const [me, setMe] = useState<{ name: string; email: string } | null>(initialMe ?? null);
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
  // The account is already known when the portal opened signed in; it is asked for only after a fresh sign-in.
  useEffect(() => { void load(); if (!initialMe) api('/admin/me').then(setMe).catch(() => undefined); }, [load]); // eslint-disable-line react-hooks/exhaustive-deps
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
    try { const r = await api<{ recoveryCodes: string[] }>('/admin/recovery-codes', { method: 'POST' }); setFresh(r.recoveryCodes); } catch (e) { guard(e); }
  };
  const signOut = async () => { await api('/admin/sign-out', { method: 'POST' }).catch(() => undefined); onSignedOut(); };
  const active = users.filter((u) => u.status === 'active').length;

  return (
    <div className="shell">
      <aside>
        <div className="brand"><span className="wordmark">NIKO</span><span className="k tag">Admin</span></div>
        <nav aria-label="Admin sections">
          <button className="nv" aria-current={tab === 'users' ? 'page' : undefined} onClick={() => setTab('users')}>Users</button>
          <button className="nv" aria-current={tab === 'ai' ? 'page' : undefined} onClick={() => setTab('ai')}>AI options</button>
          <button className="nv" aria-current={tab === 'glance' ? 'page' : undefined} onClick={() => setTab('glance')}>New items</button>
          <button className="nv" aria-current={tab === 'limits' ? 'page' : undefined} onClick={() => setTab('limits')}>Limits</button>
          <button className="nv" aria-current={tab === 'security' ? 'page' : undefined} onClick={() => setTab('security')}>Security</button>
          <button className="nv" aria-current={tab === 'audit' ? 'page' : undefined} onClick={() => setTab('audit')}>Audit log</button>
        </nav>
        <div className="who"><span className="sub" style={{ fontSize: 13 }}>Signed in as {me?.name || me?.email || '…'}</span><button className="nv line" onClick={signOut}>Sign out</button></div>
      </aside>
      <main key={tab} className="hud-in">
        {tab === 'users' ? <>
          <header><h1>Users</h1><p className="sub" style={{ fontSize: 15 }}>{active} active · {invites.length} invited · {reg === 'invite' ? 'invite only' : 'open registration'}</p></header>
          {note && <p className={note.ok ? 'ok' : 'err'} role="status">{note.text}</p>}
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
        </> : tab === 'ai' ? <AiOptions guard={guard} /> : tab === 'glance' ? <GlanceAdmin guard={guard} /> : tab === 'limits' ? <LimitsAdmin guard={guard} /> : tab === 'security' ? <>
          <header><h1>Security</h1><p className="sub" style={{ fontSize: 15 }}>Your own admin sign-in: authenticator app and recovery codes.</p></header>
          {note && <p className={note.ok ? 'ok' : 'err'} role="status">{note.text}</p>}
          <div className="two">
            <section className="g card" aria-label="Second factor">
              <span className="k">Second factor</span>
              <p className="sub">Admin sign-in asks for a 6-digit code from your authenticator app every time. Each code works once.</p>
              <p className="sub">Lost the app? Sign in with a recovery code, or reset it from your computer with <span className="mono">npm run user -- reset-2fa</span>.</p>
            </section>
            <section className="g card" aria-label="Recovery codes">
              <span className="k">Recovery codes</span>
              <p className="sub">Ten single-use codes for when you lose your authenticator app. Making new ones cancels the old ones.</p>
              <div><button className="bt" onClick={newCodes}>{confirmCodes ? 'Confirm: replace the old codes' : 'Make new recovery codes'}</button></div>
            </section>
          </div>
          {fresh && (
            <section className="g card" aria-label="New recovery codes">
              <span className="k">Your new recovery codes · shown once</span>
              <p className="sub">The old codes no longer work. Each of these works once if you lose your authenticator app.</p>
              <Codes codes={fresh} />
              <div><button className="bt" onClick={() => setFresh(null)}>I’ve saved them</button></div>
            </section>
          )}
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
  const [me, setMe] = useState<{ name: string; email: string } | null>(null);
  useEffect(() => {
    api<{ name: string; email: string }>('/admin/me').then((m) => { setMe(m); setStage('in'); }).catch((e) => setStage(e instanceof ApiError && e.data?.mfa ? 'verify' : 'password'));
  }, []);
  if (stage === 'loading') return null;
  return stage === 'in' ? <Users initialMe={me} onSignedOut={() => { setMe(null); setStage('password'); }} /> : <SignIn stage={stage} setStage={setStage} />;
}

createRoot(document.getElementById('root')!).render(<StrictMode><Admin /></StrictMode>);
