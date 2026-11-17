// Niko admin portal: sign-in with a second factor, then users and registration.
import { StrictMode, useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { api, ApiError, Field, PasswordField, Switch } from '@niko/ui';
import { AI_OPTION_GROUPS, aiHasBrain, aiOff, CALENDAR_LIMIT_STEPS, GLANCE_PART_NAMES, GLANCE_PARTS, GLANCE_STEPS, GRACE_STEPS, lengthLabel, MAX_MONTHS, money, offersLine, plansDiffer, plansOffered, showCode, toCents, unlockPlan, type AccessState, type AccountLimits, type GlanceLimits, type PaymentSettings } from '@niko/shared';
import '@niko/ui/src/styles.css';
import './admin.css';

type Stage = 'loading' | 'password' | 'setup' | 'verify' | 'in';

function Codes({ codes }: { codes: string[] }) {
  return <ul className="codes mono" aria-label="Recovery codes">{codes.map((c) => <li key={c}>{c}</li>)}</ul>;
}
interface UserRow {
  id: string; name: string; email: string; role: string; status: string; isOwner: boolean; lastActiveAt: string | null;
  access: AccessState; lifetime: boolean; accessUntil: string | null; accessKind: string | null; accessPaidUntil: string | null; accessStartMonths: number; paidMode: Mode | null; keptPrices: { plan: 'monthly' | 'yearly'; cents: number }[] | null; pricesFrom: 'kept' | 'admin' | null; pricesAt: string | null;
  sub: { plan: string | null; status: string | null; periodEnd: string | null; cancelAtEnd: boolean; mode: Mode | null } | null;
  signup: { state: 'verify' | 'pay' | 'waiting'; paid: boolean; mode: Mode | null; priceCents: number | null; months: number | null; removeAt: string | null } | null;
}
interface InviteRow { id: string; email: string; role: string; expiresAt: string; access: 'paid' | 'free' | 'life'; priceCents: number | null; months: number | null; paidAt: string | null; stripeMode: Mode | null; codeTries: number; hasCode: boolean }
type Mode = 'test' | 'live';
type ModeStatus = { ready: boolean; secret: boolean; webhook: boolean; problem: string | null; connectedAt: string | null; account: string | null };
const testTag = (m: Mode | null | undefined) => (m === 'test' ? ' · test' : '');
interface AuditRow { id: string; action: string; detail: Record<string, unknown>; createdAt: string }


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

// ---------------------------------------------------------------- payments (default prices)
const fmtDate = (d: string | Date | null | undefined) => (d ? new Date(d).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '');
const centsText = (c: number | null | undefined) => (typeof c === 'number' ? (c / 100).toFixed(2) : '');

/** Shown at the top of Users and Payments while new payments use Stripe's test mode. */
function TestBanner({ onOpen }: { onOpen?: () => void }) {
  return (
    <div className="testbanner" role="note">
      <span><b>Stripe test mode.</b> New payments use test cards and no real money moves, but anyone who pays with a test card still gets into Niko.</span>
      {onOpen && <button className="bt sm" onClick={onOpen}>Go live</button>}
    </div>
  );
}

/** Test or live: which Stripe keys new payments use. The keys themselves stay in the server's secrets. */
function ModeCard({ mode, modes, onSwitched, onReload, guard }: { mode: Mode; modes: Record<Mode, ModeStatus>; onSwitched: (m: Mode) => void; onReload: (text: string, ok: boolean) => void; guard: (e: unknown) => void }) {
  const [asking, setAsking] = useState<Mode | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [connecting, setConnecting] = useState<Mode | null>(null);
  const connect = async (m: Mode) => {
    setConnecting(m);
    try {
      const r = await api<{ account: string; chargesEnabled: boolean | null }>('/admin/payments/connect', { body: { mode: m } });
      onReload(m === 'live' && r.chargesEnabled === false
        ? `Connected to ${r.account || 'your Stripe account'} (live), but Stripe hasn’t activated it for payments yet. Finish activating it in Stripe before going live.`
        : `Connected to ${r.account || 'your Stripe account'} (${m}). Niko set up the webhook and the billing page there.`, true);
    } catch (e) { if (e instanceof ApiError && e.status === 401) guard(e); else onReload((e as Error).message, false); } finally { setConnecting(null); }
  };
  const go = async () => {
    if (!asking) return;
    setBusy(true); setErr('');
    try { await api('/admin/payments/mode', { method: 'PUT', body: { mode: asking } }); onSwitched(asking); setAsking(null); }
    catch (e) { if (e instanceof ApiError && e.status === 401) guard(e); else setErr((e as Error).message); } finally { setBusy(false); }
  };
  const line = (m: Mode) => {
    const st = modes[m];
    const sub = !st.secret ? `Add the ${m} secret key to the server (docs/DEPLOYMENT.md, 1c)`
      : st.problem && !/Press Connect/.test(st.problem) ? st.problem
      : st.connectedAt ? `Connected${st.account ? ` to ${st.account}` : ''} · ${fmtDate(st.connectedAt)}`
      : st.webhook ? 'Webhook secret set by hand' : 'Key set · not connected yet';
    return (
      <div className="mode-row">
        <span className="pay-txt"><span>{m === 'live' ? 'Live' : 'Test'}</span><span className="sub small">{sub}</span></span>
        {st.secret && (!st.problem || /Press Connect/.test(st.problem)) && <button className="bt sm" disabled={connecting !== null} onClick={() => connect(m)}>{connecting === m ? 'Connecting…' : st.connectedAt ? 'Connect again' : 'Connect'}</button>}
        <span className={'pill-st ' + (st.ready ? 'ok' : 'no')}>{st.ready ? 'Ready' : 'Not ready'}</span>
      </div>
    );
  };
  return (
    <section className="g card" aria-label="Stripe mode">
      <div className="mode-head">
        <div><span className="k">Stripe mode</span><p className="sub" style={{ marginTop: 6 }}>{mode === 'live' ? 'Live: new invites, sign-ups and plans charge real money.' : 'Test: new payments use Stripe’s test cards. No real money moves.'}</p></div>
        <div role="group" aria-label="Stripe mode" className="segs">
          {(['test', 'live'] as Mode[]).map((m) => (
            <button key={m} className={'seg' + (m === 'live' ? ' live' : '')} aria-pressed={mode === m} disabled={mode !== m && !modes[m].ready} title={mode !== m && !modes[m].ready ? `Add the ${m} keys first` : undefined}
              onClick={() => { if (mode !== m) { setErr(''); setAsking(m); } }}>{m === 'live' ? 'Live' : 'Test'}</button>
          ))}
        </div>
      </div>
      <div className="mode-rows">{line('test')}{line('live')}</div>
      <p className="sub small">Nothing is set up by hand in Stripe: Connect has Niko make its webhook and billing page there, and prices and products go from Niko with each payment. Switching changes only new payments; payments, plans and refunds already made keep working in their own mode, and test ones are labelled “test” in Users. The secret keys stay in the server’s secrets, never here.</p>
      {asking && (
        <div className="scrim" onClick={(e) => { if (e.target === e.currentTarget) setAsking(null); }}>
          <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="modeh">
            <div><h2 id="modeh">{asking === 'live' ? 'Switch to live payments?' : 'Switch to test mode?'}</h2>
              <p className="sub">{asking === 'live' ? 'From now on, new invites, sign-ups and plans charge real money through your live Stripe account.' : 'New payments will use Stripe’s test cards, and no real money moves.'}</p></div>
            <ul className="mode-list">
              {asking === 'live' ? <>
                <li>Check your prices in Pricing below before you switch.</li>
                <li>Anything paid in test mode keeps its access until it ends, labelled “test” in Users. Unlock or switch off those accounts if they shouldn’t keep it.</li>
                <li>Test plans keep renewing in Stripe’s test mode until cancelled there.</li>
              </> : <>
                <li>Anyone who pays with a test card gets real access to Niko. Use test mode only while you’re checking things.</li>
                <li>Live plans keep renewing and charging as normal; refunds of live payments still go to live.</li>
              </>}
            </ul>
            {err && <p className="err" role="alert">{err}</p>}
            <div className="dialog-acts"><button className="bt" onClick={() => setAsking(null)}>Cancel</button><button className="pri" style={{ height: 44, fontSize: 14 }} onClick={go} disabled={busy}>{busy ? 'Switching…' : asking === 'live' ? 'Switch to live' : 'Switch to test'}</button></div>
          </div>
        </div>
      )}
    </section>
  );
}

function PaymentsAdmin({ guard }: { guard: (e: unknown) => void }) {
  const [s, setS] = useState<PaymentSettings | null>(null);
  const [ready, setReady] = useState(true);
  const [mode, setMode] = useState<Mode>('test');
  const [modes, setModes] = useState<Record<Mode, ModeStatus> | null>(null);
  const [once, setOnce] = useState('');
  const [mPrice, setMPrice] = useState('');
  const [yPrice, setYPrice] = useState('');
  const [len, setLen] = useState('12');
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  // The settings as saved, to tell whether plan prices are being changed; and who gets the new ones.
  const [saved, setSaved] = useState<PaymentSettings | null>(null);
  const [pricesFor, setPricesFor] = useState<'everyone' | 'new' | null>(null);
  const [alsoOwn, setAlsoOwn] = useState(false);
  const [counts, setCounts] = useState<{ onDefault: number; ownPrices: number } | null>(null);
  const load = useCallback(async () => {
    try {
      const r = await api<{ settings: PaymentSettings; stripe: boolean; mode: Mode; modes: Record<Mode, ModeStatus>; onDefault: number; ownPrices: number }>('/admin/payments');
      setS(r.settings); setSaved(r.settings); setCounts({ onDefault: r.onDefault, ownPrices: r.ownPrices }); setReady(r.stripe); setMode(r.mode); setModes(r.modes);
      setOnce(centsText(r.settings.onceCents)); setMPrice(centsText(r.settings.monthly.cents)); setYPrice(centsText(r.settings.yearly.cents));
      setLen(String(r.settings.unit === 'years' ? r.settings.months / 12 : r.settings.months));
    } catch (e) { guard(e); }
  }, [guard]);
  useEffect(() => { void load(); }, [load]);
  if (!s) return null;
  const set = (patch: Partial<PaymentSettings>) => { setS({ ...s, ...patch }); setNote(null); };
  const n = Math.max(0, parseInt(len, 10) || 0);
  const months = s.unit === 'years' ? n * 12 : n;
  const draft: PaymentSettings = { ...s, months, onceCents: toCents(once), monthly: { ...s.monthly, cents: toCents(mPrice) }, yearly: { ...s.yearly, cents: toCents(yPrice) } };
  const plansChanging = !!saved && plansDiffer(saved, draft) && plansOffered(saved).length > 0;
  const save = async () => {
    setNote(null);
    const bad = (v: string) => v.trim() !== '' && toCents(v) === null;
    if (bad(once) || bad(mPrice) || bad(yPrice)) return setNote({ ok: false, text: 'Prices are in Singapore dollars, at least 0.50, like 12 or 12.50.' });
    if (!(months >= 1 && months <= MAX_MONTHS)) return setNote({ ok: false, text: `The pay-once time is 1 to ${MAX_MONTHS} months (${MAX_MONTHS / 12} years).` });
    if (s.monthly.on && !toCents(mPrice) && s.yearly.on && !toCents(yPrice)) return setNote({ ok: false, text: 'Give the plans that are on a price, or people can’t continue when their time ends.' });
    if (plansChanging && !pricesFor) return setNote({ ok: false, text: 'Choose who moves to the new default prices before saving.' });
    setBusy(true);
    try {
      const r = await api<{ settings: PaymentSettings; changed: boolean; pricesFor: 'everyone' | 'new' | null; accounts: number; ownMoved: number; onDefault: number; ownPrices: number }>('/admin/payments', { method: 'PUT', body: { settings: draft, ...(plansChanging ? { pricesFor, alsoOwn } : {}) } });
      setS(r.settings); setSaved(r.settings); setPricesFor(null); setAlsoOwn(false); setCounts({ onDefault: r.onDefault, ownPrices: r.ownPrices });
      const back = r.ownMoved ? ` ${r.ownMoved === 1 ? '1 account' : `${r.ownMoved} accounts`} with own prices went back on the default.` : '';
      setNote({ ok: true, text: !r.changed ? 'Saved. New invites and sign-ups use these prices.'
        : r.pricesFor === 'everyone' ? `Saved. Everyone on the default pays the new prices from their next plan.${back} Plans running now keep their price.`
        : `Saved. New people get the new prices;${back} ${r.accounts === 1 ? '1 account keeps' : `${r.accounts} accounts keep`} today’s prices as their own.` });
    } catch (e) { if (e instanceof ApiError && e.status === 401) guard(e); else setNote({ ok: false, text: (e as Error).message }); } finally { setBusy(false); }
  };
  const planRow = (key: 'monthly' | 'yearly', label: string, value: string, setValue: (v: string) => void) => {
    const p = s[key];
    const togglePlan = (v: boolean) => {
      const other = key === 'monthly' ? s.yearly : s.monthly;
      if (!v && !other.on) return setNote({ ok: false, text: 'Keep at least one plan on, or people can’t continue when their time ends.' });
      set({ [key]: { ...p, on: v } } as Partial<PaymentSettings>);
    };
    return (
      <div className="pay-row">
        <Switch on={p.on} onChange={togglePlan} label={`${label} plan`} />
        <span className="pay-name">{label}</span>
        <label className={'price' + (p.on ? '' : ' dim')}><span className="k">SGD</span><span className="sr">{label} price in Singapore dollars</span><input className="in" inputMode="decimal" placeholder="Amount" value={value} onChange={(e) => setValue(e.target.value)} disabled={!p.on} /></label>
        <span className="sub">{key === 'monthly' ? 'a month' : 'a year'}</span>
      </div>
    );
  };
  const laterBits = [s.monthly.on && `${toCents(mPrice) ? money(toCents(mPrice)) : 'SGD [MONTHLY]'} a month`, s.yearly.on && `${toCents(yPrice) ? money(toCents(yPrice)) : 'SGD [YEARLY]'} a year`].filter(Boolean).join(' or ');
  return <>
    {mode === 'test' && <TestBanner />}
    <header><h1>Payments</h1><p className="sub" style={{ fontSize: 15, display: 'flex', alignItems: 'center', gap: 10 }}><i className={'dot' + (ready ? (mode === 'live' ? ' on' : ' test') : '')} />{ready ? `Stripe ${mode === 'live' ? 'live' : 'test mode'} · SGD · pay once for a set time, then a monthly or yearly plan` : `Stripe ${mode} mode isn’t set up: paid invites, paid sign-ups and plans are off until its keys are added (docs/DEPLOYMENT.md).`}</p></header>
    {note && <p className={note.ok ? 'ok' : 'err'} role="status">{note.text}</p>}
    {modes && <ModeCard mode={mode} modes={modes} guard={guard} onReload={(text, ok) => { setNote({ ok, text }); api<{ stripe: boolean; mode: Mode; modes: Record<Mode, ModeStatus> }>('/admin/payments').then((r) => { setReady(r.stripe); setMode(r.mode); setModes(r.modes); }).catch(guard); }} onSwitched={(m) => { setMode(m); setReady(modes[m].ready); setNote({ ok: true, text: m === 'live' ? 'Live. New payments now charge real money.' : 'Test mode. New payments use test cards.' }); }} />}
    <div className="pay-grid">
      <section className="g card" aria-label="Default prices">
        <div><div className="card-head"><span className="k">Default prices</span>{counts && <span className="sub small">{counts.onDefault} on the default · {counts.ownPrices} with own prices</span>}</div>
          <p className="sub" style={{ marginTop: 6 }}>What new invites and sign-ups get, and everyone on the default. Each invite can change the pay-once price; give one person their own plan prices in Users → Prices.</p></div>
        <div className="pay-block">
          <b className="pay-h">1 · Pay once</b>
          <div className="pay-line">
            <label className="price"><span className="k">SGD</span><span className="sr">Pay-once price in Singapore dollars</span><input className="in" inputMode="decimal" placeholder="Amount" value={once} onChange={(e) => { setOnce(e.target.value); setNote(null); }} /></label>
            <span>for</span>
            <label><span className="sr">How many</span><input className="in num" inputMode="numeric" value={len} onChange={(e) => { setLen(e.target.value.replace(/\D/g, '').slice(0, 3)); setNote(null); }} /></label>
            <div role="group" aria-label="Months or years" className="segs">
              <button className="seg" aria-pressed={s.unit === 'months'} onClick={() => { if (s.unit === 'years') setLen(String(n * 12)); set({ unit: 'months' }); }}>Months</button>
              <button className="seg" aria-pressed={s.unit === 'years'} onClick={() => { if (s.unit === 'months') setLen(String(Math.max(1, Math.round(n / 12)))); set({ unit: 'years' }); }}>Years</button>
            </div>
          </div>
          <p className="sub small">One payment unlocks Niko for this long. Nothing is charged when it ends.</p>
        </div>
        <div className="pay-block">
          <b className="pay-h">2 · Then a plan, to keep going</b>
          {planRow('monthly', 'Monthly', mPrice, setMPrice)}
          {planRow('yearly', 'Yearly', yPrice, setYPrice)}
          <p className="sub small">{s.monthly.on && s.yearly.on ? 'Both on: people pick monthly or yearly when their time ends.' : `Only ${s.monthly.on ? 'monthly' : 'yearly'} is offered when their time ends.`}</p>
          {plansChanging && saved && (
            <fieldset className="who-pays">
              <legend className="pay-h">Who moves to the new default?</legend>
              <p className="sub small">Now: {offersLine(plansOffered(saved))}. New: {offersLine(plansOffered(draft)) || 'none'}.</p>
              <label className={'who-opt' + (pricesFor === 'everyone' ? ' on' : '')}>
                <input type="radio" name="prices-for" checked={pricesFor === 'everyone'} onChange={() => { setPricesFor('everyone'); setNote(null); }} />
                <span><b>Everyone on the default, from their next plan</b><span className="sub small">{counts ? `The ${counts.onDefault} accounts on the default` : 'Accounts on the default'} pay the new prices the next time they choose a plan. Plans running now keep renewing at their price.</span></span>
              </label>
              <label className={'who-opt' + (pricesFor === 'new' ? ' on' : '')}>
                <input type="radio" name="prices-for" checked={pricesFor === 'new'} onChange={() => { setPricesFor('new'); setNote(null); }} />
                <span><b>Only new people</b><span className="sub small">{counts ? `The ${counts.onDefault} accounts on the default keep` : 'Accounts on the default keep'} today’s prices as their own, for every plan they choose later. New invites and sign-ups get the new prices.</span></span>
              </label>
              {!!counts?.ownPrices && <div className="pay-line" style={{ paddingTop: 4 }}><Switch on={alsoOwn} onChange={(v) => { setAlsoOwn(v); setNote(null); }} label="Also put accounts with own prices back on the default" /><span style={{ fontSize: 14 }}>Also put the {counts.ownPrices === 1 ? 'account' : `${counts.ownPrices} accounts`} with own prices back on the default</span></div>}
            </fieldset>
          )}
        </div>
        <div className="pay-row">
          <Switch on={s.openPay} onChange={(v) => set({ openPay: v })} label="Open sign-ups pay too" />
          <span className="pay-txt"><span>Open sign-ups pay too</span><span className="sub small">{s.openPay ? 'Same prices. They pay after confirming their email, then wait for you to switch them on. Unpaid sign-ups are removed after 7 days.' : 'They don’t pay to sign up. Once you switch them on, they choose a plan, unless you unlock them.'}</span></span>
        </div>
        <div className="pay-acts"><button className="pri" style={{ height: 44, fontSize: 14 }} onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save default prices'}</button><span className="sub small">Anyone who already paid keeps what they paid; plans running now keep renewing at their price.</span></div>
      </section>
      <div className="pay-side">
        <section className="g card" aria-label="What people see">
          <span className="k">What people see</span>
          <ol className="timeline">
            <li><i className="dot on" /><span className="pay-txt"><span>First {months ? lengthLabel(months) : '[X] months'}</span><span className="sub small">One payment. Nothing renews.</span></span><b>{toCents(once) ? money(toCents(once)) : 'SGD [AMOUNT]'}</b></li>
            <li><i className="dot" /><span className="pay-txt"><span>When it ends</span><span className="sub small">{s.monthly.on && s.yearly.on ? 'They pick a plan. It renews until they cancel.' : 'Renews until they cancel.'}</span></span><b>{laterBits}</b></li>
          </ol>
          <p className="sub small">In Users you can unlock any account for lifetime or a set time, with no payment.</p>
        </section>
        <section className="g card" aria-label="Renewals">
          <span className="k">Renewals</span>
          <div className="pay-line spread">
            <span>If a renewal payment fails, keep access for</span>
            <div role="group" aria-label="Days of access after a failed renewal" className="segs">
              {GRACE_STEPS.map((d) => <button key={d} className="seg" aria-pressed={s.graceDays === d} onClick={() => set({ graceDays: d })}>{d} days</button>)}
            </div>
          </div>
          <p className="sub small">Stripe retries the card and Niko emails them to update it. After that, they choose a plan again to keep going.</p>
          <div className="pay-row">
            <Switch on={s.remind} onChange={(v) => set({ remind: v })} label="Email a reminder before paid time ends" />
            <span className="pay-txt"><span>Email a reminder 7 days before someone’s paid time ends</span></span>
          </div>
          <p className="sub small">Subscribers change their card or cancel on Stripe’s billing page, linked from Account in Niko. Card details never reach Niko.</p>
        </section>
      </div>
    </div>
  </>;
}

// ---------------------------------------------------------------- unlock
function UnlockDialog({ user, onClose, onDone }: { user: UserRow; onClose: () => void; onDone: (text: string) => void }) {
  const [kind, setKind] = useState<'life' | 'set'>('life');
  const [len, setLen] = useState('6');
  const [unit, setUnit] = useState<'months' | 'years'>('months');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const first = box.current?.querySelector<HTMLElement>('button');
    first?.focus();
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [onClose]);
  const n = parseInt(len, 10) || 0;
  const months = unit === 'years' ? n * 12 : n;
  const fields = { role: user.role, lifetime: user.lifetime, accessUntil: user.accessUntil, accessKind: user.accessKind, accessStartMonths: user.accessStartMonths, subStatus: user.sub?.status ?? null, subPeriodEnd: user.sub?.periodEnd ?? null };
  const plan = unlockPlan(fields, kind === 'life' ? { kind: 'life' } : { kind: 'set', months: Math.max(1, months) });
  const paidLeft = kind === 'set' ? plan.paidUntil : null;
  const preview = kind === 'life' ? 'Full access for good. No payments, ever.' : !months ? `Enter how many ${unit}.` : `Unlocked from ${paidLeft ? fmtDate(paidLeft) : 'today'} to ${fmtDate(plan.accessUntil)}. Then they choose a plan.`;
  const subName = user.sub?.plan === 'yearly' ? 'yearly' : 'monthly';
  const note = kind === 'life'
    ? `${plan.sub === 'cancel-now' ? `Their ${subName} plan is cancelled now. ` : ''}Nothing already paid is refunded. The account is switched on, and they get an email saying it’s unlocked.`
    : `${paidLeft ? `${plan.sub === 'end-at-period' ? `Their ${subName} plan won’t renew. ` : ''}The unlocked time starts after the time they already paid for, so they lose nothing. ` : 'They have no paid time left, so the unlocked time starts today. '}The account is switched on, and they get an email.`;
  const go = async () => {
    if (kind === 'set' && !(months >= 1 && months <= MAX_MONTHS)) return setErr(`Enter between 1 month and ${MAX_MONTHS / 12} years.`);
    setBusy(true); setErr('');
    try {
      await api(`/admin/users/${user.id}/unlock`, { body: kind === 'life' ? { kind } : { kind, months } });
      onDone(kind === 'life' ? `${user.name || user.email} is unlocked for lifetime.` : paidLeft ? `${user.name || user.email} keeps their paid time to ${fmtDate(paidLeft)}, then is unlocked until ${fmtDate(plan.accessUntil)}.` : `${user.name || user.email} is unlocked until ${fmtDate(plan.accessUntil)}.`);
    } catch (e) { setErr((e as Error).message); setBusy(false); }
  };
  return (
    <div className="scrim" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={box} className="dialog" role="dialog" aria-modal="true" aria-labelledby="ulh">
        <div><h2 id="ulh">Unlock {user.name || user.email}’s account</h2><p className="sub">Full access to Niko with no payment.</p></div>
        <div role="group" aria-label="How long" className="segs">
          <button className="seg" aria-pressed={kind === 'life'} onClick={() => setKind('life')}>Lifetime</button>
          <button className="seg" aria-pressed={kind === 'set'} onClick={() => setKind('set')}>For a set time</button>
        </div>
        {kind === 'set' && <div className="pay-line">
          <label><span className="sr">How many</span><input className="in num" inputMode="numeric" value={len} onChange={(e) => setLen(e.target.value.replace(/\D/g, '').slice(0, 3))} /></label>
          <div role="group" aria-label="Months or years" className="segs">
            <button className="seg" aria-pressed={unit === 'months'} onClick={() => setUnit('months')}>Months</button>
            <button className="seg" aria-pressed={unit === 'years'} onClick={() => setUnit('years')}>Years</button>
          </div>
        </div>}
        {paidLeft && <p style={{ fontSize: 14 }}>Already paid until {fmtDate(paidLeft)}</p>}
        <div className="preview"><svg viewBox="0 0 24 24" aria-hidden="true" className="ic"><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V8a4 4 0 0 1 7.5-2" /></svg><span>{preview}</span></div>
        <p className="sub small">{note}</p>
        {err && <p className="err" role="alert">{err}</p>}
        <div className="dialog-acts"><button className="bt" onClick={onClose}>Cancel</button><button className="pri" style={{ height: 44, fontSize: 14 }} onClick={go} disabled={busy}>{busy ? 'Unlocking…' : 'Unlock access'}</button></div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- one person's plan prices
// Default prices (follow Payments) or own prices, fixed for this person. With a plan running now, it can change too,
// from its next renewal, with no charge or refund today.
type Offer = { plan: 'monthly' | 'yearly'; cents: number };
function PricesDialog({ user, defaults, onClose, onDone }: { user: UserRow; defaults: Offer[]; onClose: () => void; onDone: (text: string) => void }) {
  const start = user.keptPrices ?? defaults;
  const of = (p: 'monthly' | 'yearly') => start.find((x) => x.plan === p) ?? defaults.find((x) => x.plan === p);
  const [mode, setMode] = useState<'default' | 'own'>(user.keptPrices ? 'own' : 'default');
  const [mOn, setMOn] = useState(!!start.find((x) => x.plan === 'monthly'));
  const [yOn, setYOn] = useState(!!start.find((x) => x.plan === 'yearly'));
  const [m, setM] = useState(of('monthly') ? centsText(of('monthly')!.cents) : '');
  const [y, setY] = useState(of('yearly') ? centsText(of('yearly')!.cents) : '');
  const [renew, setRenew] = useState(false);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    box.current?.querySelector<HTMLElement>('input, button')?.focus();
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [onClose]);
  const who = user.name?.split(' ')[0] || user.email;
  const own: Offer[] = [...(mOn && toCents(m) ? [{ plan: 'monthly' as const, cents: toCents(m)! }] : []), ...(yOn && toCents(y) ? [{ plan: 'yearly' as const, cents: toCents(y)! }] : [])];
  const chosen = mode === 'default' ? defaults : own;
  const sub = user.sub && ['active', 'trialing', 'past_due', 'unpaid'].includes(user.sub.status ?? '') && !user.sub.cancelAtEnd ? user.sub : null;
  const subName = sub?.plan === 'yearly' ? 'yearly' : 'monthly';
  const subPrice = chosen.find((x) => x.plan === subName);
  const now = user.keptPrices ? (user.pricesFrom === 'admin' ? 'Now: own prices, set by you.' : `Now: own prices, kept when the default changed${user.pricesAt ? ` on ${fmtDate(user.pricesAt)}` : ''}.`) : 'Now: the default prices.';
  const go = async () => {
    setErr('');
    if (mode === 'own') {
      if (!mOn && !yOn) return setErr(`Keep at least one plan on, or ${who} can’t continue when their time ends.`);
      if ((mOn && !toCents(m)) || (yOn && !toCents(y))) return setErr('Each plan that is on needs a price of at least SGD 0.50, like 12 or 12.50.');
    }
    if (renew && sub && !subPrice) return setErr(`Their running plan is ${subName}: give a ${subName} price, or leave the running plan as it is.`);
    setBusy(true);
    try {
      const r = await api<{ renewed: string | null }>(`/admin/users/${user.id}/plan-prices`, { method: 'PUT', body: mode === 'default' ? { mode, renew: renew && !!sub } : { mode, monthly: mOn ? toCents(m) : null, yearly: yOn ? toCents(y) : null, renew: renew && !!sub } });
      onDone(`${user.name || user.email} ${mode === 'default' ? `is on the default prices: ${offersLine(defaults)}.` : `now has own prices: ${offersLine(own)}.`}${r.renewed ? ` Their running plan renews at ${r.renewed} from ${fmtDate(sub!.periodEnd)}.` : ''}`);
    } catch (e) { setErr((e as Error).message); setBusy(false); }
  };
  const row = (label: string, per: string, on: boolean, setOn: (v: boolean) => void, val: string, setVal: (v: string) => void) => (
    <div className="pay-line">
      <Switch on={on} onChange={(v) => { setOn(v); setErr(''); }} label={`${label} plan`} />
      <span style={{ width: 74 }}>{label}</span>
      <label className="price"><span className="k">SGD</span><span className="sr">{label} price in Singapore dollars</span><input className="in" inputMode="decimal" placeholder="Amount" value={val} disabled={!on} onChange={(e) => { setVal(e.target.value); setErr(''); }} /></label>
      <span className="sub">{per}</span>
    </div>
  );
  return (
    <div className="scrim" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={box} className="dialog wide" role="dialog" aria-modal="true" aria-labelledby="prh">
        <div><h2 id="prh">Plan prices for {user.name || user.email}</h2><p className="sub">{now}</p></div>
        <div role="radiogroup" aria-label="Which prices" className="who-pays">
          <label className={'who-opt' + (mode === 'default' ? ' on' : '')}>
            <input type="radio" name="price-mode" checked={mode === 'default'} onChange={() => { setMode('default'); setErr(''); }} />
            <span><b>Default prices</b><span style={{ fontSize: 15 }}>{offersLine(defaults) || 'No plans on'}</span><span className="sub small">Follows Payments → Default prices. When you change those, you choose whether people on the default move with them.</span></span>
          </label>
          <label className={'who-opt' + (mode === 'own' ? ' on' : '')}>
            <input type="radio" name="price-mode" checked={mode === 'own'} onChange={() => { setMode('own'); setErr(''); }} />
            <span><b>Own prices</b><span className="sub small">Fixed for {who} only. Changing the default prices never changes these.</span></span>
          </label>
        </div>
        {mode === 'own' && <div className="own-prices">
          {row('Monthly', 'a month', mOn, setMOn, m, setM)}
          {row('Yearly', 'a year', yOn, setYOn, y, setY)}
        </div>}
        {sub && <div className="running">
          <span style={{ fontSize: 14 }}>{who}’s {subName} plan is running{sub.mode === 'test' ? ' (test)' : ''}. New prices apply when {who} next chooses a plan.</span>
          <div className="running-row"><Switch on={renew} onChange={setRenew} label="Also change the plan running now" />
            <span><span style={{ fontSize: 14 }}>Also change the plan running now</span><span className="sub small" style={{ display: 'block' }}>From its next renewal ({fmtDate(sub.periodEnd)}), with no charge or refund today. Stripe’s receipts show the new price.</span></span></div>
        </div>}
        <div className="preview"><span>From {who}’s next plan: {offersLine(chosen) || '—'}{renew && sub && subPrice ? `. The running plan renews at ${money(subPrice.cents)} from ${fmtDate(sub.periodEnd)}.` : '.'}</span></div>
        {err && <p className="err" role="alert">{err}</p>}
        <div className="dialog-acts"><button className="bt" onClick={onClose}>Cancel</button><button className="pri" style={{ height: 44, fontSize: 14 }} onClick={go} disabled={busy}>{busy ? 'Saving…' : 'Save prices'}</button></div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- users
/** What the Payment column says about an account. */
function payText(u: UserRow): { text: string; tone?: 'await' | 'ended' | 'warn' } {
  if (u.role === 'admin') return { text: u.isOwner ? '—' : 'Admin · no payment' };
  if (u.signup) {
    const removeIn = u.signup.removeAt ? Math.max(0, Math.ceil((Date.parse(u.signup.removeAt) - Date.now()) / 86400_000)) : null;
    const removing = removeIn !== null ? ` · removed in ${removeIn} day${removeIn === 1 ? '' : 's'}` : '';
    if (u.signup.state === 'verify') return { text: `Signed up, email not confirmed${removing}`, tone: 'warn' };
    if (u.signup.state === 'pay') return { text: `Signed up, not paid${removing}`, tone: 'warn' };
    if (u.signup.paid) return { text: `Signed up · paid for ${lengthLabel(u.signup.months ?? 12)}${testTag(u.signup.mode)}`, tone: 'await' };
    return { text: 'Signed up · email confirmed', tone: 'await' };
  }
  if (u.lifetime) return { text: 'Lifetime' };
  const sub = u.sub;
  if (sub && ['active', 'trialing', 'past_due', 'unpaid'].includes(sub.status ?? '')) {
    const name = sub.plan === 'yearly' ? 'yearly' : 'monthly';
    const t = testTag(sub.mode);
    if (sub.status === 'trialing') return { text: `${name === 'yearly' ? 'Yearly' : 'Monthly'} plan · starts ${fmtDate(sub.periodEnd)}${t}` };
    if (sub.status !== 'active') return { text: `${name === 'yearly' ? 'Yearly' : 'Monthly'} plan · payment failed${t}`, tone: 'warn' };
    return { text: `${name === 'yearly' ? 'Yearly' : 'Monthly'} plan · ${sub.cancelAtEnd ? 'ends' : 'renews'} ${fmtDate(sub.periodEnd)}${t}` };
  }
  if (u.access.has && u.accessKind === 'unlocked') return { text: u.accessPaidUntil ? `Paid to ${fmtDate(u.accessPaidUntil)} · then unlocked to ${fmtDate(u.accessUntil)}` : `Unlocked by admin · until ${fmtDate(u.accessUntil)}` };
  if (u.access.has && u.accessKind === 'free') return { text: `Free · until ${fmtDate(u.accessUntil)}` };
  if (u.access.has) return { text: `Paid once · until ${fmtDate(u.accessUntil)}${testTag(u.paidMode)}` };
  return { text: 'Paid time ended · needs a plan', tone: 'ended' };
}
function statusText(u: UserRow): string {
  if (u.signup && u.status !== 'active') return u.signup.state === 'waiting' ? 'Waiting for you' : u.signup.state === 'pay' ? 'Not paid' : 'Confirming email';
  if (u.status !== 'active') return 'Switched off';
  return u.role !== 'admin' && !u.access.has ? 'Paused' : 'Active';
}
function invitePay(i: InviteRow): { text: string; tone?: 'await' | 'warn' } {
  if (i.hasCode && i.codeTries >= 5) return { text: 'Code locked · 5 wrong tries', tone: 'warn' };
  if (i.access === 'life') return { text: 'Lifetime · invited' };
  if (i.access === 'free') return { text: `Free for ${lengthLabel(i.months ?? 3)} · invited` };
  if (i.paidAt) return { text: `Paid · not signed up${testTag(i.stripeMode)}`, tone: 'await' };
  return { text: `${money(i.priceCents)} for ${lengthLabel(i.months ?? 12)} · awaiting payment`, tone: 'await' };
}
const PAID_LENGTHS = [1, 3, 6, 12, 24, 36];
const FREE_LENGTHS = [1, 3, 6, 12];

function Users({ onSignedOut, initialMe }: { onSignedOut: () => void; initialMe?: { name: string; email: string } | null }) {
  const [tab, setTab] = useState<'users' | 'payments' | 'ai' | 'glance' | 'limits' | 'security' | 'audit'>('users');
  const [me, setMe] = useState<{ name: string; email: string } | null>(initialMe ?? null);
  const [users, setUsers] = useState<UserRow[]>([]);
  const [invites, setInvites] = useState<InviteRow[]>([]);
  const [reg, setReg] = useState<'invite' | 'open'>('invite');
  const [pay, setPay] = useState<PaymentSettings | null>(null);
  const [stripeOn, setStripeOn] = useState(true);
  const [mode, setMode2] = useState<Mode>('test');
  const [audit, setAudit] = useState<AuditRow[]>([]);
  const [email, setEmail] = useState('');
  const [kind, setKind] = useState<'paid' | 'free' | 'life'>('paid');
  const [amt, setAmt] = useState('');
  const [len, setLen] = useState<number | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string; code?: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [unlocking, setUnlocking] = useState<UserRow | null>(null);
  const [pricing, setPricing] = useState<UserRow | null>(null);
  const [fresh, setFresh] = useState<string[] | null>(null);
  const [confirmCodes, setConfirmCodes] = useState(false);

  const guard = useCallback((e: unknown) => { if (e instanceof ApiError && e.status === 401) onSignedOut(); else setNote({ ok: false, text: (e as Error).message }); }, [onSignedOut]);
  const load = useCallback(async () => {
    try {
      const r = await api<{ users: UserRow[]; invites: InviteRow[]; registration: 'invite' | 'open'; payments: PaymentSettings; stripe: boolean; stripeMode: Mode }>('/admin/users');
      setUsers(r.users); setInvites(r.invites); setReg(r.registration); setPay(r.payments); setStripeOn(r.stripe); setMode2(r.stripeMode);
    } catch (e) { guard(e); }
  }, [guard]);
  useEffect(() => { void load(); if (!initialMe) api('/admin/me').then(setMe).catch(() => undefined); }, [load]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (tab === 'audit') api<{ entries: AuditRow[] }>('/admin/audit').then((r) => setAudit(r.entries)).catch(guard); }, [tab, guard]);
  useEffect(() => { if (tab === 'users') void load(); }, [tab]); // eslint-disable-line react-hooks/exhaustive-deps

  const months = len ?? (kind === 'free' ? 3 : pay?.months ?? 12);
  const lengths = kind === 'free' ? FREE_LENGTHS : [...new Set([...PAID_LENGTHS, pay?.months ?? 12])].sort((x, y) => x - y);
  const said = (text: string, ok = true, code?: string) => { setNote({ ok, text, code }); setCopied(false); };
  const invite = async (e: FormEvent) => {
    e.preventDefault(); setNote(null);
    const priceCents = kind === 'paid' ? (amt.trim() ? toCents(amt) : pay?.onceCents ?? null) : undefined;
    if (kind === 'paid' && !priceCents) return said('Enter a price of at least SGD 0.50, or set a default in Payments.', false);
    try {
      const r = await api<{ emailed: boolean; code: string; priceCents: number | null; months: number | null }>('/admin/invites', { body: { email, access: kind, priceCents, months: kind === 'life' ? undefined : months } });
      const what = kind === 'paid' ? `${money(r.priceCents)} once for ${lengthLabel(r.months ?? months)}` : kind === 'free' ? `free for ${lengthLabel(r.months ?? months)}` : 'lifetime, no payments';
      said(r.emailed ? `Sent to ${email} · ${what}. Code (shown once):` : `Invite made for ${email} · ${what}, but the email couldn’t be sent (check the Resend setup). Pass on the link’s code yourself:`, r.emailed, r.code);
      setEmail(''); setAmt(''); setLen(null);
      await load();
    } catch (x) { guard(x); }
  };
  const setMode = async (mode: 'invite' | 'open') => { try { await api('/admin/registration', { method: 'PUT', body: { mode } }); setReg(mode); } catch (e) { guard(e); } };
  const toggle = async (u: UserRow) => {
    try {
      await api(`/admin/users/${u.id}`, { method: 'PATCH', body: { status: u.status === 'active' ? 'off' : 'active' } });
      if (u.status !== 'active' && u.signup) said(`${u.name || u.email} is switched on and gets a welcome email.`);
      await load();
    } catch (e) { guard(e); }
  };
  const revoke = async (i: InviteRow) => {
    if (i.paidAt && !window.confirm(`Revoke ${i.email}’s invite and refund ${money(i.priceCents)}?`)) return;
    try { const r = await api<{ refunded: boolean }>(`/admin/invites/${i.id}`, { method: 'DELETE' }); said(r.refunded ? `Invite for ${i.email} revoked and refund started. Stripe returns it to their card, usually within 5–10 business days.` : `Invite for ${i.email} revoked. The link and code no longer work.`); await load(); } catch (e) { guard(e); }
  };
  const newCode = async (i: InviteRow) => {
    try { const r = await api<{ emailed: boolean; code: string }>(`/admin/invites/${i.id}/code`, { method: 'POST' }); said(`New code and link emailed to ${i.email}. The old ones no longer work:`, true, r.code); await load(); } catch (e) { guard(e); }
  };
  const remove = async (u: UserRow) => {
    if (!window.confirm(`Remove ${u.email}’s unpaid sign-up?`)) return;
    try { await api(`/admin/users/${u.id}`, { method: 'DELETE' }); said(`${u.name || u.email}’s unpaid sign-up was removed.`); await load(); } catch (e) { guard(e); }
  };
  const newCodes = async () => {
    if (!confirmCodes) return setConfirmCodes(true);
    setConfirmCodes(false);
    try { const r = await api<{ recoveryCodes: string[] }>('/admin/recovery-codes', { method: 'POST' }); setFresh(r.recoveryCodes); } catch (e) { guard(e); }
  };
  const signOut = async () => { await api('/admin/sign-out', { method: 'POST' }).catch(() => undefined); onSignedOut(); };
  const active = users.filter((u) => u.status === 'active').length;
  const waiting = users.filter((u) => u.signup?.state === 'waiting' && u.status !== 'active').length;
  const ended = users.filter((u) => u.status === 'active' && u.role !== 'admin' && !u.access.has).length;
  const later = pay ? [pay.monthly.on && pay.monthly.cents && `${money(pay.monthly.cents)} a month`, pay.yearly.on && pay.yearly.cents && `${money(pay.yearly.cents)} a year`].filter(Boolean).join(' or ') : '';

  return (
    <div className="shell">
      <aside>
        <div className="brand"><span className="wordmark">NIKO</span><span className="k tag">Admin</span></div>
        <nav aria-label="Admin sections">
          <button className="nv" aria-current={tab === 'users' ? 'page' : undefined} onClick={() => setTab('users')}>Users</button>
          <button className="nv" aria-current={tab === 'payments' ? 'page' : undefined} onClick={() => setTab('payments')}>Payments</button>
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
          {mode === 'test' && <TestBanner onOpen={() => setTab('payments')} />}
          <header><h1>Users</h1><p className="sub" style={{ fontSize: 15 }}>{active} active · {waiting} sign-up{waiting === 1 ? '' : 's'} waiting for you · {invites.length} invited · {ended} needing a plan · {reg === 'invite' ? 'invite only' : 'open registration'}</p></header>
          <div className="two">
            <section className="g card" aria-label="Registration">
              <span className="k">Registration</span>
              <div role="group" aria-label="Who can create an account" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button className="seg" aria-pressed={reg === 'invite'} onClick={() => setMode('invite')}>Invite only</button>
                <button className="seg" aria-pressed={reg === 'open'} onClick={() => setMode('open')}>Open registration</button>
              </div>
              <p className="sub">{reg === 'invite' ? 'Only people you invite can create an account. The sign-up page is hidden.' : pay?.openPay ? 'Anyone can sign up. They confirm their email and pay, then wait for you to switch them on.' : 'Anyone can sign up. They confirm their email, then wait for you to switch them on.'}</p>
              <div className="stripe-line"><i className={'dot' + (stripeOn ? (mode === 'live' ? ' on' : ' test') : '')} /><span className="sub">{stripeOn ? (mode === 'live' ? 'Stripe live · real payments in SGD' : 'Stripe test mode · no real money moves') : `Stripe ${mode} mode isn’t set up yet: only free and lifetime invites can be sent.`}</span></div>
            </section>
            <form className="g card" aria-label="Invite a user" onSubmit={invite}>
              <span className="k">Invite a user</span>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                <label style={{ flex: 1, minWidth: 200, display: 'flex' }}><span className="sr">Email address</span><input className="in" style={{ height: 44 }} type="email" placeholder="name@example.com" autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} required /></label>
                <button className="pri" style={{ height: 44, fontSize: 14 }}>Send invite</button>
              </div>
              <div className="pay-line">
                <span className="sub" style={{ color: '#fff', fontSize: 15 }}>Access</span>
                <div role="group" aria-label="How this person gets access" className="segs">
                  <button type="button" className="seg" aria-pressed={kind === 'paid'} onClick={() => { setKind('paid'); setLen(null); }}>Pay once</button>
                  <button type="button" className="seg" aria-pressed={kind === 'free'} onClick={() => { setKind('free'); setLen(null); }}>Free for a while</button>
                  <button type="button" className="seg" aria-pressed={kind === 'life'} onClick={() => { setKind('life'); setLen(null); }}>Lifetime</button>
                </div>
              </div>
              {kind !== 'life' && <div className="pay-line">
                {kind === 'paid' && <label className="price"><span className="k">SGD</span><span className="sr">Pay-once price in Singapore dollars</span><input className="in" inputMode="decimal" placeholder={pay?.onceCents ? centsText(pay.onceCents) : 'Amount'} value={amt} onChange={(e) => setAmt(e.target.value)} /></label>}
                <span className="sub" style={{ color: '#fff', fontSize: 15 }}>{kind === 'paid' ? 'for' : 'Free for'}</span>
                <label><span className="sr">How long it lasts</span><select className="in sel" value={months} onChange={(e) => setLen(Number(e.target.value))}>{lengths.map((m) => <option key={m} value={m}>{lengthLabel(m)}</option>)}</select></label>
              </div>}
              <p className="sub" style={{ fontSize: 13 }}>{kind === 'life' ? 'No payments, ever. They just enter the code and create an account.' : `When this time ends, they choose ${later ? `a plan (${later})` : 'the monthly or yearly plan from Payments'}.`} The link and a 6-character code go out in one email; links expire after 7 days unless paid.</p>
            </form>
          </div>
          {note && <div className={note.ok ? 'ok banner' : 'err banner'} role="status"><span>{note.text}</span>
            {note.code && <><span className="code" aria-label="Invite code">{showCode(note.code)}</span><button className="bt" onClick={() => { navigator.clipboard?.writeText(note.code!).catch(() => undefined); setCopied(true); }}>{copied ? 'Copied' : 'Copy code'}</button></>}
          </div>}
          <section className="g card table" aria-label="Accounts">
            <div className="tr pay head"><span className="k">Name</span><span className="k">Email</span><span className="k">Role</span><span className="k">Status</span><span className="k">Payment</span><span className="k">Access</span></div>
            {users.map((u) => {
              const p = payText(u);
              const unpaid = !!u.signup && u.signup.state !== 'waiting';
              const canUnlock = u.role !== 'admin' && !u.lifetime && !unpaid;
              return (
                <div key={u.id} className="tr pay">
                  <b>{u.name || '—'}</b><span className="sub ell">{u.email}</span><span>{u.role === 'admin' ? 'Admin' : 'Member'}</span>
                  <span className="st"><i className={u.status === 'active' ? 'on' : ''} />{statusText(u)}</span>
                  <span className="paycell">
                    <span className="paytxt"><span className={'tone-' + (p.tone ?? 'plain')}>{p.text}</span>
                      {canUnlock && pay && <span className="pricetag"><span className={'tag' + (u.keptPrices ? ' own' : '')}>{u.keptPrices ? (u.pricesFrom === 'admin' ? 'Own' : `Own · kept${u.pricesAt ? ' ' + fmtDate(u.pricesAt) : ''}`) : 'Default'}</span><span className="sub small">{offersLine(u.keptPrices ?? plansOffered(pay)) || 'no plans'}</span></span>}</span>
                    {canUnlock && pay && <button className="bt sm" onClick={() => setPricing(u)}>Prices</button>}
                    {canUnlock && <button className="bt sm" onClick={() => setUnlocking(u)}>Unlock</button>}
                  </span>
                  <span>{u.isOwner ? <span className="k">Owner</span> : unpaid ? <button className="bt" onClick={() => remove(u)}>Remove</button> : <Switch on={u.status === 'active'} onChange={() => toggle(u)} label={`Account enabled for ${u.email}`} />}</span>
                </div>
              );
            })}
            {invites.map((i) => {
              const p = invitePay(i);
              return (
                <div key={i.id} className="tr pay">
                  <b>Invited</b><span className="sub ell">{i.email}</span><span>{i.role === 'admin' ? 'Admin' : 'Member'}</span>
                  <span className="st"><i />Invited</span>
                  <span className="paycell"><span className={'tone-' + (p.tone ?? 'plain')}>{p.text}</span>{i.hasCode && i.codeTries >= 5 && <button className="bt sm" onClick={() => newCode(i)}>Send new code</button>}</span>
                  <span>{i.paidAt ? <button className="bt" onClick={() => revoke(i)}>Revoke and refund</button> : <button className="bt" onClick={() => revoke(i)}>Revoke</button>}</span>
                </div>
              );
            })}
          </section>
          <p className="sub" style={{ fontSize: 13 }}>Paid sign-ups stay off until you switch them on; their paid time starts then. Unpaid sign-ups are removed after 7 days. Prices are fixed when the invite is sent. Card details go to Stripe, never to Niko. Every change here is written to the audit log.</p>
          {pricing && pay && <PricesDialog user={pricing} defaults={plansOffered(pay)} onClose={() => setPricing(null)} onDone={async (text) => { setPricing(null); said(text); await load(); }} />}
          {unlocking && <UnlockDialog user={unlocking} onClose={() => setUnlocking(null)} onDone={async (text) => { setUnlocking(null); said(text); await load(); }} />}
        </> : tab === 'payments' ? <PaymentsAdmin guard={guard} /> : tab === 'ai' ? <AiOptions guard={guard} /> : tab === 'glance' ? <GlanceAdmin guard={guard} /> : tab === 'limits' ? <LimitsAdmin guard={guard} /> : tab === 'security' ? <>
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
