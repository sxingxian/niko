// Niko admin portal: sign-in with a second factor, then users and registration.
import { StrictMode, useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { api, ApiError, Field, PasswordField, Switch } from '@niko/ui';
import { AI_OPTION_GROUPS, AI_PRESETS, HEAR_PROVIDERS, IMAGE_PROVIDERS, MAP_PROVIDERS, USAGE_KINDS, USAGE_NAMES, USAGE_STEPS, USAGE_UNITS, VOICE_PROVIDERS, type MapField, type ProvidedSetup, type UsageKind, aiHasBrain, aiOff, CALENDAR_LIMIT_STEPS, GLANCE_PART_NAMES, GLANCE_PARTS, GLANCE_STEPS, GRACE_STEPS, lengthLabel, MAX_MONTHS, money, offersLine, plansDiffer, plansOffered, showCode, toCents, unlockPlan, type AccessState, type AccountLimits, type GlanceLimits, type PaymentSettings } from '@niko/shared';
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
  engineSetup?: { keys: number; order: 'free' | 'fixed' };
  signup: { state: 'verify' | 'pay' | 'waiting'; paid: boolean; mode: Mode | null; priceCents: number | null; months: number | null; removeAt: string | null } | null;
}
interface InviteRow { id: string; email: string; role: string; expiresAt: string; access: 'paid' | 'free' | 'life'; priceCents: number | null; months: number | null; paidAt: string | null; stripeMode: Mode | null; codeTries: number; hasCode: boolean; engineSetup?: { keys: number; order: 'free' | 'fixed' } }
type Mode = 'test' | 'live';
type ModeStatus = { ready: boolean; secret: boolean; webhook: boolean; problem: string | null; connectedAt: string | null; account: string | null };
const testTag = (m: Mode | null | undefined) => (m === 'test' ? ' · test' : '');
interface AuditRow { id: string; action: string; detail: Record<string, unknown>; createdAt: string; by?: string | null; byName?: string | null }


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
type LimitsUser = { id: string; name: string; email: string; role: string; status: string; accountLimits: Partial<AccountLimits>; used?: Record<UsageKind, number>; invite?: boolean };
type LimitsReply = { defaults: AccountLimits; users: LimitsUser[]; invites: { id: string; email: string; role: string; accountLimits: Partial<AccountLimits> }[]; resets: string };
function LimitsAdmin({ guard }: { guard: (e: unknown) => void }) {
  const [defaults, setDefaults] = useState<AccountLimits | null>(null);
  const [people, setPeople] = useState<LimitsUser[]>([]);
  const [resets, setResets] = useState('');
  const [sel, setSel] = useState('all');
  const [draft, setDraft] = useState<Partial<AccountLimits>>({});
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const load = useCallback(async () => {
    try {
      const r = await api<LimitsReply>('/admin/limits');
      setDefaults(r.defaults); setResets(r.resets);
      setPeople([...r.users, ...r.invites.map((i) => ({ id: 'inv:' + i.id, name: '', email: i.email, role: i.role, status: 'invited', accountLimits: i.accountLimits, invite: true }))]);
    } catch (e) { guard(e); }
  }, [guard]);
  useEffect(() => { void load(); }, [load]);
  const person = people.find((p) => p.id === sel) ?? null;
  useEffect(() => { if (defaults) { setDraft(person ? { ...person.accountLimits } : { ...defaults }); setDirty(false); } }, [sel, defaults, people]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!defaults) return null;
  type LimitKey = keyof AccountLimits;
  const valOf = (k: LimitKey) => draft[k] ?? defaults[k];
  const isChanged = (k: LimitKey) => !!person && draft[k] !== undefined && draft[k] !== defaults[k];
  const setVal = (k: LimitKey, v: number) => {
    setNote(null); setDirty(true);
    const d = { ...draft };
    if (person && v === defaults[k]) delete d[k]; else d[k] = v;
    setDraft(d);
  };
  const anyChanged = !!person && (Object.keys(defaults) as LimitKey[]).some(isChanged);
  const save = async () => {
    setBusy(true); setNote(null);
    try {
      if (person?.invite) await api(`/admin/limits/invites/${person.id.slice(4)}`, { method: 'PUT', body: { limits: draft } });
      else if (person) await api(`/admin/limits/users/${person.id}`, { method: 'PUT', body: { limits: draft } });
      else await api('/admin/limits/default', { method: 'PUT', body: { limits: draft } });
      await load(); setNote({ ok: true, text: person ? `Saved for ${person.name || person.email}.` : 'Saved. It applies to everyone without their own limit within a minute.' });
    } catch (e) { if (e instanceof ApiError && e.status === 401) guard(e); else setNote({ ok: false, text: (e as Error).message }); } finally { setBusy(false); }
  };
  const count = (p: LimitsUser) => Object.keys(p.accountLimits).length;
  const resetDay = resets ? new Date(resets).toLocaleDateString(undefined, { day: 'numeric', month: 'short', timeZone: 'UTC' }) : '';
  const row = (k: LimitKey, name: string, sub: string, options: { v: number; label: string }[], used?: string) => {
    const changed = isChanged(k);
    const label = (n: number) => options.find((o) => o.v === n)?.label ?? String(n);
    return <div key={k} className="ai-row">
      <span className="ai-txt"><span>{name}</span><span className="sub">{changed ? `Default is ${label(defaults[k]).toLowerCase()}` : sub}{used ? ` · ${used}` : ''}</span></span>
      {changed && <><span className="chg">Changed</span><button className="lnk" onClick={() => setVal(k, defaults[k])}>Reset</button></>}
      <label className="sr" htmlFor={`lim-${k}`}>{name}</label>
      <select id={`lim-${k}`} className="in gl-sel" value={valOf(k)} onChange={(e) => setVal(k, Number(e.target.value))}>
        {options.map((o) => <option key={o.v} value={o.v}>{o.label}</option>)}
      </select>
    </div>;
  };
  return <>
    <header><h1>Limits</h1><p className="sub" style={{ fontSize: 15, maxWidth: 860 }}>How much each account may add, and how much it can use each month of what’s included: your keys and Niko’s built-in services. People’s own keys are never counted or capped.</p></header>
    {note && <p className={note.ok ? 'ok' : 'err'} role="status">{note.text}</p>}
    <div className="ai-grid">
      <section className="g card ai-people" aria-label="Applies to">
        <span className="k" style={{ padding: '0 6px' }}>Applies to</span>
        <div className="ai-list">
          {[{ id: 'all', name: 'Everyone', sub: 'The default for all accounts', badge: 'Default' }, ...people.map((p) => ({ id: p.id, name: p.invite ? 'Invited' : p.name || p.email, sub: p.email, badge: count(p) ? 'Own' : 'Default' }))].map((p) => (
            <button key={p.id} className="who-row" aria-pressed={p.id === sel} onClick={() => { if (dirty && !window.confirm('Leave without saving these changes?')) return; setSel(p.id); setNote(null); }}>
              <span className="who-txt"><b>{p.name}</b><span>{p.sub}</span></span><span className="who-badge">{p.badge}</span>
            </button>
          ))}
        </div>
        <p className="sub" style={{ fontSize: 12, padding: '0 6px' }}>New accounts get the default. An invite’s limits are copied when they join. These limits apply to admins too.</p>
      </section>
      <section className="g card ai-options" aria-label="Limits">
        <div className="ai-head">
          <div><h2>{person ? (person.invite ? `${person.email} · invited` : person.name || person.email) : 'Everyone · default'}</h2>
            <p className="sub" style={{ fontSize: 13 }}>{person ? (anyChanged ? 'Some limits are different from the default.' : 'Follows the default. Change a limit to set it for this person only.') : 'What every account gets, unless it is changed for that person.'}</p></div>
          <div className="ai-acts">
            {person && <button className="bt" onClick={() => { setDraft({}); setDirty(true); }} disabled={!anyChanged}>Reset to default</button>}
            <button className="pri" style={{ height: 44, fontSize: 14 }} onClick={save} disabled={busy || !dirty}>{busy ? 'Saving…' : 'Save'}</button>
          </div>
        </div>
        {row('calendars', 'Calendar links', 'Private and public iCal calendars, per account', CALENDAR_LIMIT_STEPS.map((n) => ({ v: n, label: n === 1 ? '1 calendar' : `Up to ${n}` })))}
        <div className="psec-row" style={{ paddingTop: 18 }}><span className="k">Included each month</span>
          {!person && <button className="lnk" onClick={() => { setNote(null); setDirty(true); setDraft({ ...draft, ...Object.fromEntries(USAGE_KINDS.map((k) => [k, 0])) }); }}>No limit on all</button>}</div>
        {USAGE_KINDS.map((k) => row(k, USAGE_NAMES[k], k === 'map' ? 'Place searches and routes, OpenStreetMap included' : k === 'hear' ? 'Minutes of speech turned into text' : `Through your keys and Workers AI`,
          USAGE_STEPS[k].map((n) => ({ v: n, label: stepText(k, n) })), person?.used ? `${person.used[k].toLocaleString()} used this month` : undefined))}
        <p className="sub" style={{ fontSize: 12, lineHeight: 1.5 }}>Monthly amounts start again on the 1st{resetDay ? ` (next: ${resetDay})` : ''}. At the limit, Niko skips what’s included and uses the person’s own keys; with none, it tells them when it starts again. Lowering a calendar limit removes nothing: only that many are read. Every change is written to the audit log.</p>
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

// ---------------------------------------------------------------- people: search, filters, pages, and one person's panel
type Show = 'all' | 'active' | 'waiting' | 'invited' | 'ended' | 'own' | 'off';
const SHOWS: [Show, string][] = [['all', 'All'], ['active', 'Active'], ['waiting', 'Waiting for you'], ['invited', 'Invited'], ['ended', 'Needs a plan'], ['own', 'Own prices'], ['off', 'Switched off']];
type Item = (UserRow & { kind: 'user'; createdAt: string }) | (InviteRow & { kind: 'invite'; createdAt: string });
type ListReply = { items: Item[]; total: number; page: number; per: number; pages: number; counts: Record<Show, number>; registration: 'invite' | 'open'; payments: PaymentSettings; stripe: boolean; stripeMode: Mode };
const AV = ['#9fdcf3', '#c9a8ff', '#7fe3a8', '#ffd38a', '#ff9fb4', '#a8c4ff'];
const initials = (s: string) => s.split(/[\s@._-]+/).filter(Boolean).map((w) => w[0]).join('').slice(0, 2).toUpperCase() || '?';
const avColour = (id: string) => AV[[...id].reduce((n, ch) => n + ch.charCodeAt(0), 0) % AV.length];
const when = (d: string | null | undefined) => {
  if (!d) return 'never';
  const days = Math.floor((Date.now() - Date.parse(d)) / 86400_000);
  return days <= 0 ? 'today' : days === 1 ? 'yesterday' : days < 14 ? `${days} days ago` : fmtDate(d);
};
/** Waits until typing pauses before searching. */
function useDebounced<T>(v: T, ms = 250): T {
  const [d, setD] = useState(v);
  useEffect(() => { const t = window.setTimeout(() => setD(v), ms); return () => window.clearTimeout(t); }, [v, ms]);
  return d;
}

/** Page controls: "26–50 of 138", previous, page numbers, next, and how many per page. */
function Pager({ page, pages, total, per, pers, onPage, onPer }: { page: number; pages: number; total: number; per: number; pers: number[]; onPage: (p: number) => void; onPer: (n: number) => void }) {
  const nums: (number | '…')[] = [];
  for (let p = 1; p <= pages; p++) if (p === 1 || p === pages || Math.abs(p - page) <= 1) nums.push(p); else if (nums[nums.length - 1] !== '…') nums.push('…');
  return (
    <footer className="pager">
      <span className="sub">{total ? `${(page - 1) * per + 1}–${Math.min(page * per, total)} of ${total}` : 'None'}</span>
      <nav aria-label="Pages" className="pager-nums">
        <button className="pg" onClick={() => onPage(page - 1)} disabled={page <= 1} aria-label="Previous page">‹ <span className="pg-word">Prev</span></button>
        {nums.map((n, i) => (n === '…' ? <span key={'d' + i} className="sub pg-dots">…</span>
          : <button key={n} className="pg pg-n" aria-current={n === page ? 'page' : undefined} onClick={() => onPage(n)}>{n}</button>))}
        <span className="sub pg-of">Page {page} of {pages}</span>
        <button className="pg" onClick={() => onPage(page + 1)} disabled={page >= pages} aria-label="Next page"><span className="pg-word">Next</span> ›</button>
      </nav>
      <span className="pager-per"><span className="sub">Per page</span>
        {pers.map((n) => <button key={n} className="pg" aria-pressed={n === per} onClick={() => onPer(n)}>{n}</button>)}
      </span>
    </footer>
  );
}

/** The invite form, in a sheet. */
function InviteDialog({ pay, stripeOn, mode, onClose, onSent }: { pay: PaymentSettings | null; stripeOn: boolean; mode: Mode; onClose: () => void; onSent: (text: string, ok: boolean, code: string) => void }) {
  const [email, setEmail] = useState('');
  const [kind, setKind] = useState<'paid' | 'free' | 'life'>(stripeOn ? 'paid' : 'free');
  const [amt, setAmt] = useState('');
  const [len, setLen] = useState<number | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLFormElement>(null);
  useEffect(() => {
    box.current?.querySelector<HTMLElement>('input')?.focus();
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [onClose]);
  const months = len ?? (kind === 'free' ? 3 : pay?.months ?? 12);
  const lengths = kind === 'free' ? FREE_LENGTHS : [...new Set([...PAID_LENGTHS, pay?.months ?? 12])].sort((x, y) => x - y);
  const later = pay ? offersLine(plansOffered(pay)) : '';
  const send = async (e: FormEvent) => {
    e.preventDefault(); setErr('');
    const priceCents = kind === 'paid' ? (amt.trim() ? toCents(amt) : pay?.onceCents ?? null) : undefined;
    if (kind === 'paid' && !priceCents) return setErr('Enter a price of at least SGD 0.50, or set a default in Payments.');
    setBusy(true);
    try {
      const r = await api<{ emailed: boolean; code: string; priceCents: number | null; months: number | null }>('/admin/invites', { body: { email, access: kind, priceCents, months: kind === 'life' ? undefined : months } });
      const what = kind === 'paid' ? `${money(r.priceCents)} once for ${lengthLabel(r.months ?? months)}` : kind === 'free' ? `free for ${lengthLabel(r.months ?? months)}` : 'lifetime, no payments';
      onSent(r.emailed ? `Sent to ${email} · ${what}. Code (shown once):` : `Invite made for ${email} · ${what}, but the email couldn’t be sent (check the Resend setup). Pass on the code yourself:`, r.emailed, r.code);
    } catch (x) { setErr((x as Error).message); setBusy(false); }
  };
  return (
    <div className="scrim" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <form ref={box} className="dialog wide" role="dialog" aria-modal="true" aria-labelledby="invh" onSubmit={send}>
        <h2 id="invh">Invite someone</h2>
        <label className="field"><span className="sub">Email</span><input className="in" style={{ height: 44 }} type="email" placeholder="name@example.com" autoComplete="off" value={email} onChange={(e) => { setEmail(e.target.value); setErr(''); }} required /></label>
        <div role="group" aria-label="How this person gets access" className="segs">
          <button type="button" className="seg" aria-pressed={kind === 'paid'} disabled={!stripeOn} onClick={() => { setKind('paid'); setLen(null); }}>Pay once</button>
          <button type="button" className="seg" aria-pressed={kind === 'free'} onClick={() => { setKind('free'); setLen(null); }}>Free for a while</button>
          <button type="button" className="seg" aria-pressed={kind === 'life'} onClick={() => { setKind('life'); setLen(null); }}>Lifetime</button>
        </div>
        {kind !== 'life' && <div className="pay-line">
          {kind === 'paid' && <label className="price"><span className="k">SGD</span><span className="sr">Pay-once price in Singapore dollars</span><input className="in" inputMode="decimal" placeholder={pay?.onceCents ? centsText(pay.onceCents) : 'Amount'} value={amt} onChange={(e) => setAmt(e.target.value)} /></label>}
          <span className="sub" style={{ color: '#fff', fontSize: 15 }}>{kind === 'paid' ? 'for' : 'Free for'}</span>
          <label><span className="sr">How long it lasts</span><select className="in sel" value={months} onChange={(e) => setLen(Number(e.target.value))}>{lengths.map((m) => <option key={m} value={m}>{lengthLabel(m)}</option>)}</select></label>
        </div>}
        <p className="sub small">{kind === 'life' ? 'No payments, ever. They just enter the code and create an account.' : `When this time ends, they choose ${later ? `a plan at the default prices (${later})` : 'the monthly or yearly plan from Payments'}.`} The link and a 6-character code go out in one email; links expire after 7 days unless paid.{!stripeOn ? ` Stripe ${mode} mode isn’t set up yet, so only free and lifetime invites can be sent.` : mode === 'test' ? ' Stripe is in test mode: no real money moves.' : ''}</p>
        {err && <p className="err" role="alert">{err}</p>}
        <div className="dialog-acts"><button type="button" className="bt" onClick={onClose}>Cancel</button><button className="pri" style={{ height: 44, fontSize: 14 }} disabled={busy}>{busy ? 'Sending…' : 'Send invite'}</button></div>
      </form>
    </div>
  );
}

/** Everything about one person (or one invite), with what can be done. */
// ---------------------------------------------------------------- set up Niko for one person (or invite)
// Services the admin provides, per kind and in order; Workers AI on or off; the monthly amounts; and whether the person
// may reorder. Keys are pasted once into a shared library and can be given to several people; they never come back out.
type PKey = { id: string; kind: UsageKind; label: string; info: Record<string, string>; users: number; invites: number };
type SetupReply = { setup: ProvidedSetup; builtins: Record<UsageKind, boolean>; limits: Partial<AccountLimits>; limitDefaults: AccountLimits; usage: Record<UsageKind, { included: number; own: number }> | null; joined: boolean };
const SETUP_TABS: [UsageKind, string][] = [['brain', 'AI answers'], ['voice', 'Voice'], ['hear', 'Listening'], ['image', 'Pictures'], ['map', 'Maps']];
const BUILTIN_NAME: Record<UsageKind, string> = { brain: 'Workers AI', voice: 'Workers AI voice', hear: 'Workers AI listening', image: 'Workers AI pictures (FLUX)', map: 'OpenStreetMap' };
const stepText = (k: UsageKind, n: number) => (n ? `${n.toLocaleString()} ${USAGE_UNITS[k][1]}` : 'No limit');
const usedText = (k: UsageKind, n: number) => (k === 'hear' ? Math.ceil(n / 60) : n).toLocaleString();
/** "OpenAI · gpt-4.1-mini": the service's own name, not its id. */
function serviceName(kind: UsageKind, info: Record<string, string>): string {
  const list: { id: string; name: string; provider?: string; baseUrl?: string }[] = kind === 'brain' ? AI_PRESETS : kind === 'voice' ? VOICE_PROVIDERS : kind === 'hear' ? HEAR_PROVIDERS : kind === 'image' ? IMAGE_PROVIDERS : MAP_PROVIDERS;
  const same = (a?: string, b?: string) => !!a && !!b && a.replace(/\/+$/, '').toLowerCase() === b.replace(/\/+$/, '').toLowerCase();
  const p = (info.baseUrl && list.find((x) => same(x.baseUrl, info.baseUrl))) || list.find((x) => x.id === info.provider || x.provider === info.provider);
  return [p && p.id !== 'other' ? p.name : info.provider, info.model].filter(Boolean).join(' · ');
}
const firstName = (s: string) => (s.includes('@') ? s : s.split(/\s+/)[0] || s);

/** What the admin types for a new key: the service, then that service's own fields. */
function KeyForm({ kind, value, onChange }: { kind: UsageKind; value: Record<string, string>; onChange: (v: Record<string, string>) => void }) {
  const set = (k: string, v: string) => onChange({ ...value, [k]: v });
  const presets: { id: string; name: string; note?: string }[] = kind === 'brain' ? AI_PRESETS : kind === 'voice' ? VOICE_PROVIDERS : kind === 'hear' ? HEAR_PROVIDERS : kind === 'image' ? IMAGE_PROVIDERS : MAP_PROVIDERS;
  const preset = value.preset || presets[0]!.id;
  const p = presets.find((x) => x.id === preset) as any;
  const other = preset === 'other';
  const models: string[] = p?.models ?? [];
  const field = (key: string, label: string, opts: { secret?: boolean; placeholder?: string; list?: string[] } = {}) => (
    <label className="kf" key={key}><span className="k">{label}</span>
      <input className="in" type={opts.secret ? 'password' : 'text'} autoComplete={opts.secret ? 'new-password' : 'off'} spellCheck={false} value={value[key] ?? ''} placeholder={opts.placeholder} list={opts.list?.length ? `kf-${kind}-${key}` : undefined} onChange={(e) => set(key, e.target.value)} />
      {opts.list?.length ? <datalist id={`kf-${kind}-${key}`}>{opts.list.map((m) => <option key={m} value={m} />)}</datalist> : null}
    </label>
  );
  return <div className="kform">
    <label className="kf"><span className="k">Service</span>
      <select className="in" value={preset} onChange={(e) => onChange({ preset: e.target.value })}>{presets.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></label>
    {p?.note && <p className="sub small">{p.note}</p>}
    {kind === 'map' ? (p?.fields as MapField[]).map((f) => field(f.key, f.label + (f.optional ? ' (optional)' : ''), { secret: f.secret, placeholder: f.placeholder }))
      : <>
        {other && field('baseUrl', 'Base URL', { placeholder: 'https://…/v1' })}
        {field('model', kind === 'image' && p?.modelLabel ? p.modelLabel : 'Model', { placeholder: kind === 'brain' ? p?.example || 'model name' : models[0] ?? '', list: models })}
        {kind === 'voice' && field('voice', 'Voice', { placeholder: p?.voices?.[0]?.id ?? 'voice id', list: (p?.voices ?? []).map((v: { id: string }) => v.id) })}
        {(kind === 'voice' || kind === 'hear') && p?.provider === 'azure' && field('region', 'Region', { placeholder: 'southeastasia' })}
        {field('apiKey', 'API key', { secret: true })}
      </>}
    {field('label', 'Name (optional)', { placeholder: 'Shown to them as an included service' })}
  </div>;
}
/** The form, as the server expects it for that kind. */
function keyBody(kind: UsageKind, v: Record<string, string>): Record<string, string> {
  const t = (k: string) => (v[k] ?? '').trim();
  if (kind === 'brain') { const p = AI_PRESETS.find((x) => x.id === (v.preset || 'openai'))!; return { baseUrl: p.id === 'other' ? t('baseUrl') : p.baseUrl, model: t('model') || p.example, apiKey: t('apiKey'), label: t('label') }; }
  if (kind === 'map') { const p = MAP_PROVIDERS.find((x) => x.id === (v.preset || MAP_PROVIDERS[0]!.id))!; return { provider: p.id, ...Object.fromEntries(p.fields.map((f) => [f.key, t(f.key)])), label: t('label') }; }
  const list: { id: string; provider: string; baseUrl?: string; models?: string[] }[] = kind === 'voice' ? VOICE_PROVIDERS : kind === 'hear' ? HEAR_PROVIDERS : IMAGE_PROVIDERS;
  const p = list.find((x) => x.id === (v.preset || list[0]!.id))!;
  return { provider: p.provider, baseUrl: p.id === 'other' ? t('baseUrl') : p.baseUrl ?? '', model: t('model') || p.models?.[0] || '', voice: t('voice'), region: t('region').toLowerCase(), apiKey: t('apiKey'), label: t('label') };
}

function SetupSheet({ target, onClose, onSaved }: { target: { who: 'user' | 'invite'; id: string; name: string }; onClose: () => void; onSaved: (text: string) => void }) {
  const first = firstName(target.name);
  const [data, setData] = useState<SetupReply | null>(null);
  const [lib, setLib] = useState<PKey[]>([]);
  const [tab, setTab] = useState<UsageKind | 'caps'>('brain');
  const [keys, setKeys] = useState<Partial<Record<UsageKind, string[]>>>({});
  const [order, setOrder] = useState<'free' | 'fixed'>('free');
  const [builtins, setBuiltins] = useState<Record<UsageKind, boolean> | null>(null);
  const [caps, setCaps] = useState<Partial<AccountLimits>>({});
  const [adding, setAdding] = useState<null | { how: 'reuse' | 'new'; reuse: string; form: Record<string, string>; give: string[] }>(null);
  const [others, setOthers] = useState<{ id: string; label: string; kind: 'user' | 'invite' }[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [addErr, setAddErr] = useState('');
  const [dirty, setDirty] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const loadLib = useCallback(async () => { const r = await api<{ keys: PKey[] }>('/admin/setup/keys'); setLib(r.keys); }, []);
  useEffect(() => {
    (async () => {
      try {
        const [r] = await Promise.all([api<SetupReply>(`/admin/setup/${target.who}/${target.id}`), loadLib()]);
        setData(r); setKeys(r.setup.keys); setOrder(r.setup.order); setBuiltins(r.builtins); setCaps(r.limits);
      } catch (e) { setErr((e as Error).message); }
    })();
  }, [target.who, target.id, loadLib]);
  const close = useCallback(() => { if (dirty && !window.confirm('Leave without saving these changes?')) return; onClose(); }, [dirty, onClose]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [close]);
  useEffect(() => { box.current?.querySelector<HTMLElement>('button')?.focus(); }, [data]);
  const touch = () => { setDirty(true); setErr(''); };
  const kindKeys = (k: UsageKind) => keys[k] ?? [];
  const setKind = (k: UsageKind, l: string[]) => { touch(); setKeys({ ...keys, [k]: l }); };
  const move = (k: UsageKind, i: number, d: -1 | 1) => { const l = [...kindKeys(k)]; [l[i], l[i + d]] = [l[i + d]!, l[i]!]; setKind(k, l); };
  const openAdd = async () => {
    const k = tab as UsageKind;
    const free = lib.filter((x) => x.kind === k && !kindKeys(k).includes(x.id));
    setAdding({ how: free.length ? 'reuse' : 'new', reuse: free[0]?.id ?? '', form: {}, give: [] });
    if (!others.length) {
      try {
        const r = await api<ListReply>('/admin/users?per=100');
        setOthers(r.items.filter((i) => i.id !== target.id).map((i) => ({ id: i.id, kind: i.kind, label: i.kind === 'user' ? `${i.name || i.email}` : `${i.email} · invited` })));
      } catch { /* the "also give to" list is optional */ }
    }
  };
  const add = async () => {
    if (!adding) return;
    const k = tab as UsageKind;
    setAddErr('');
    if (kindKeys(k).length >= 6) return setAddErr('Up to 6 included services of one kind.');
    if (adding.how === 'reuse') { if (adding.reuse) { setKind(k, [adding.reuse, ...kindKeys(k)]); setAdding(null); } return; }
    setBusy(true);
    try {
      const give = { users: adding.give.filter((id) => others.find((o) => o.id === id)?.kind === 'user'), invites: adding.give.filter((id) => others.find((o) => o.id === id)?.kind === 'invite') };
      const r = await api<{ key: { id: string } }>('/admin/setup/keys', { body: { kind: k, key: keyBody(k, adding.form), give } });
      await loadLib();
      setKind(k, [r.key.id, ...kindKeys(k)]); setAdding(null);
    } catch (e) { setAddErr((e as Error).message); } finally { setBusy(false); }
  };
  const save = async () => {
    setBusy(true); setErr('');
    try {
      await api(`/admin/setup/${target.who}/${target.id}`, { method: 'PUT', body: { keys, order, builtins, limits: caps } });
      setDirty(false); onSaved(target.who === 'user' ? `Saved. ${first} sees it the next time Niko answers.` : `Saved. ${first} starts with this when they join.`);
    } catch (e) { setErr((e as Error).message); setBusy(false); }
  };
  if (!data || !builtins) return <div className="scrim"><div className="dialog" role="dialog" aria-modal="true" aria-label="Set up Niko">{err ? <><p className="err" role="alert">{err}</p><div className="dialog-acts"><button className="bt" onClick={onClose}>Close</button></div></> : <p className="sub">Loading…</p>}</div></div>;
  const defs = data.limitDefaults;
  const capOf = (k: UsageKind) => caps[k] ?? defs[k];
  const count = (k: UsageKind) => kindKeys(k).length + (builtins[k] ? 1 : 0);
  const k = tab === 'caps' ? null : tab;
  const libOf = (id: string) => lib.find((x) => x.id === id);
  const freeLib = k ? lib.filter((x) => x.kind === k && !kindKeys(k).includes(x.id)) : [];
  const provName = (x: PKey) => serviceName(x.kind, x.info);
  return (
    <div className="scrim" onClick={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div ref={box} className="dialog sheet" role="dialog" aria-modal="true" aria-labelledby="suh">
        <div className="psec-row" style={{ alignItems: 'flex-start' }}>
          <div><h2 id="suh">Set up Niko for {first}</h2><p className="sub">{data.joined ? `What ${first} gets included. They can still add their own keys.` : `${target.name} hasn’t joined yet. This is copied to their account when they accept the invite.`}</p></div>
          <button className="bt x" onClick={close} aria-label="Close">✕</button>
        </div>
        <div className="chips" role="tablist" aria-label="Parts of Niko">
          {SETUP_TABS.map(([t, name]) => <button key={t} role="tab" className="chip" aria-selected={tab === t} aria-pressed={tab === t} onClick={() => { setTab(t); setAdding(null); }}>{name} <b>{count(t)}</b></button>)}
          <button role="tab" className="chip" aria-selected={tab === 'caps'} aria-pressed={tab === 'caps'} onClick={() => { setTab('caps'); setAdding(null); }}>Usage cap</button>
        </div>
        {k && <section aria-label={`${SETUP_TABS.find((t) => t[0] === k)![1]} services`} className="svc">
          <p className="k">{SETUP_TABS.find((t) => t[0] === k)![1]} · in the order Niko tries them</p>
          {kindKeys(k).map((id, i) => {
            const x = libOf(id);
            return <div key={id} className="srow">
              <span className="snum">{i + 1}</span>
              <span className="ai-txt"><span>{x?.label ?? 'Removed key'}</span><span className="sub">{x ? `${provName(x)} · key ending ${x.info.hint || '····'}` : 'No longer kept'}</span></span>
              <span className="tag own">Your key</span>
              <button className="bt sm arrow" onClick={() => move(k, i, -1)} disabled={i === 0} aria-label={`Move ${x?.label ?? 'key'} up`}>↑</button>
              <button className="bt sm arrow" onClick={() => move(k, i, 1)} disabled={i === kindKeys(k).length - 1} aria-label={`Move ${x?.label ?? 'key'} down`}>↓</button>
              <button className="lnk" onClick={() => setKind(k, kindKeys(k).filter((y) => y !== id))}>Remove</button>
            </div>;
          })}
          <div className="srow">
            <span className="snum">{kindKeys(k).length + 1}</span>
            <span className="ai-txt"><span>{BUILTIN_NAME[k]}</span><span className="sub">{k === 'map' ? 'Built in. Always kept as the last resort for places.' : builtins[k] ? 'Built in · counted in the usage cap' : k === 'brain' && !kindKeys('brain').length ? `Removed · ${first} needs an AI key of their own to get answers` : `Removed for ${first}`}</span></span>
            {k === 'map' ? <span className="tag">Always on</span>
              : <Switch on={builtins[k]} onChange={() => { touch(); setBuiltins({ ...builtins, [k]: !builtins[k] }); }} label={`${BUILTIN_NAME[k]} for ${first}`} />}
          </div>
          <p className="sub small">Then {first}’s own keys{order === 'free' ? `, in whatever order ${first} sets` : ''}. {k === 'voice' ? 'The on-device voice always stays last.' : k === 'hear' ? 'The device’s own recognition always stays last.' : ''}</p>
          {!adding && kindKeys(k).length < 6 && <button className="bt" style={{ alignSelf: 'flex-start' }} onClick={openAdd}>＋ Add a service with your key</button>}
          {adding && <div className="addbox">
            <div role="group" aria-label="Which key" className="segs">
              <button className="seg" aria-pressed={adding.how === 'reuse'} disabled={!freeLib.length} onClick={() => setAdding({ ...adding, how: 'reuse' })}>A key you’ve added before</button>
              <button className="seg" aria-pressed={adding.how === 'new'} onClick={() => setAdding({ ...adding, how: 'new' })}>A new key</button>
            </div>
            {adding.how === 'reuse' ? <>
              <div className="ai-list">{freeLib.map((x) => (
                <button key={x.id} className="who-row" aria-pressed={adding.reuse === x.id} onClick={() => setAdding({ ...adding, reuse: x.id })}>
                  <span className="who-txt"><b>{x.label}</b><span>{provName(x)} · ending {x.info.hint || '····'}</span></span><span className="who-badge">{x.users + x.invites} {x.users + x.invites === 1 ? 'person' : 'people'}</span>
                </button>))}</div>
              <p className="sub small">The same key, shared. Taking it away from {first} later doesn’t affect anyone else; replacing it in Keys you’ve added updates everyone.</p>
            </> : <>
              <KeyForm kind={k} value={adding.form} onChange={(form) => setAdding({ ...adding, form })} />
              <p className="sub small">Kept encrypted. Nobody sees it again, you included. It is only ever sent to that service.</p>
              {others.length > 0 && <details className="give"><summary>Also give it to{adding.give.length ? ` · ${adding.give.length}` : ''}</summary>
                <div className="give-list">{others.map((o) => <label key={o.id} className="give-row"><input type="checkbox" checked={adding.give.includes(o.id)} onChange={(e) => setAdding({ ...adding, give: e.target.checked ? [...adding.give, o.id] : adding.give.filter((x) => x !== o.id) })} /><span>{o.label}</span></label>)}</div>
                <p className="sub small">One paste, saved once. Each person gets it at the top of their list, straight away.</p></details>}
            </>}
            {addErr && <p className="err" role="alert">{addErr}</p>}
            <div className="dialog-acts"><button className="bt" onClick={() => { setAdding(null); setAddErr(''); }}>Cancel</button>
              <button className="pri" style={{ height: 44, fontSize: 14 }} disabled={busy || (adding.how === 'reuse' && !adding.reuse)} onClick={add}>{adding.how === 'reuse' ? 'Add' : busy ? 'Testing…' : 'Test and add'}</button></div>
          </div>}
        </section>}
        {tab === 'caps' && <section aria-label="Usage cap" className="svc">
          <p className="sub small">How much {first} can use each month through your keys and Niko’s built-in services. Their own keys are never counted or capped. At the cap, Niko moves on to their own keys; with none, it tells them when it resets.</p>
          {USAGE_KINDS.map((u) => {
            const changed = caps[u] !== undefined && caps[u] !== defs[u];
            return <div key={u} className="ai-row">
              <span className="ai-txt"><span>{USAGE_NAMES[u]}</span><span className="sub">{changed ? `Default is ${stepText(u, defs[u]).toLowerCase()}` : 'Follows the default'}{data.usage ? ` · ${usedText(u, data.usage[u].included)} used this month` : ''}</span></span>
              {changed && <><span className="chg">Changed</span><button className="lnk" onClick={() => { touch(); const c = { ...caps }; delete c[u]; setCaps(c); }}>Reset</button></>}
              <label className="sr" htmlFor={`cap-${u}`}>{USAGE_NAMES[u]} each month</label>
              <select id={`cap-${u}`} className="in gl-sel" value={capOf(u)} onChange={(e) => { touch(); const v = Number(e.target.value); const c = { ...caps }; if (v === defs[u]) delete c[u]; else c[u] = v; setCaps(c); }}>
                {USAGE_STEPS[u].map((n) => <option key={n} value={n}>{stepText(u, n)}</option>)}
              </select>
            </div>;
          })}
          <p className="sub small">The month runs to the 1st (UTC). The same amounts are on the Limits page.</p>
        </section>}
        <section className="svc" aria-label={`What ${first} can change`}>
          <p className="k">What {first} can change</p>
          <div className="segs col">
            <button className="seg opt" aria-pressed={order === 'free'} onClick={() => { touch(); setOrder('free'); }}><b>The order, and add their own keys</b><span>Recommended. Your keys stay; {first} can’t see or remove them.</span></button>
            <button className="seg opt" aria-pressed={order === 'fixed'} onClick={() => { touch(); setOrder('fixed'); }}><b>Only add their own keys</b><span>Your services stay first, in your order; their keys come after.</span></button>
          </div>
        </section>
        {err && <p className="err" role="alert">{err}</p>}
        <div className="dialog-acts"><button className="bt" onClick={close}>Cancel</button><button className="pri" style={{ height: 44, fontSize: 14 }} onClick={save} disabled={busy || !dirty}>{busy && !adding ? 'Saving…' : `Save for ${first}`}</button></div>
      </div>
    </div>
  );
}

/** The library: every key you've added, who has it, and replacing or removing it for everyone. */
function KeysLibrary({ guard }: { guard: (e: unknown) => void }) {
  const [lib, setLib] = useState<PKey[] | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [replacing, setReplacing] = useState<{ id: string; apiKey: string } | null>(null);
  const load = useCallback(async () => { try { setLib((await api<{ keys: PKey[] }>('/admin/setup/keys')).keys); } catch (e) { guard(e); } }, [guard]);
  useEffect(() => { void load(); }, [load]);
  if (!lib) return null;
  const replace = async () => {
    if (!replacing) return;
    try { await api(`/admin/setup/keys/${replacing.id}`, { method: 'PATCH', body: { apiKey: replacing.apiKey } }); setReplacing(null); setNote({ ok: true, text: 'Replaced. Everyone with it uses the new key now.' }); await load(); }
    catch (e) { setNote({ ok: false, text: (e as Error).message }); }
  };
  const remove = async (x: PKey) => {
    if (!window.confirm(`Remove “${x.label}”? It’s taken away from ${x.users + x.invites} ${x.users + x.invites === 1 ? 'person' : 'people'} straight away.`)) return;
    try { await api(`/admin/setup/keys/${x.id}`, { method: 'DELETE' }); setNote({ ok: true, text: `“${x.label}” was removed from everyone.` }); await load(); } catch (e) { guard(e); }
  };
  const byKind = SETUP_TABS.map(([k, label]) => [k, label, lib.filter((x) => x.kind === k)] as const).filter(([, , l]) => l.length);
  return <>
    <header><h1>Included keys</h1><p className="sub" style={{ fontSize: 15, maxWidth: 860 }}>Keys you’ve added to include services in people’s plans. Give them to people from Users → a person → Set up Niko. Each key is kept encrypted, never shown again, and only ever sent to its own service.</p></header>
    {note && <p className={note.ok ? 'ok' : 'err'} role="status">{note.text}</p>}
    <section className="g card keys-card" aria-label="Included keys">
      {!lib.length && <div className="keys-empty"><b>No keys yet</b><span className="sub">Add one while setting up Niko for someone: Users → a person → Set up Niko → Add a service with your key.</span></div>}
      {byKind.map(([k, label, list]) => <div key={k} className="keys-group">
        <span className="k">{label}</span>
        {list.map((x) => <div key={x.id} className="keys-row">
          <span className="ai-txt"><span>{x.label}</span><span className="sub">{serviceName(x.kind, x.info)} · key ending {x.info.hint || '····'}</span></span>
          <span className="keys-who sub">{x.users} {x.users === 1 ? 'person' : 'people'}{x.invites ? ` · ${x.invites} invited` : ''}</span>
          {replacing?.id === x.id ? <span className="keys-acts">
            <label className="sr" htmlFor={`rk-${x.id}`}>New key for {x.label}</label>
            <input id={`rk-${x.id}`} className="in keys-in" type="password" autoComplete="new-password" placeholder="Paste the new key" value={replacing.apiKey} onChange={(e) => setReplacing({ ...replacing, apiKey: e.target.value })} />
            <button className="bt sm" onClick={() => setReplacing(null)}>Cancel</button><button className="bt sm fill" disabled={!replacing.apiKey.trim()} onClick={replace}>Test and replace</button>
          </span> : <span className="keys-acts"><button className="bt sm" onClick={() => setReplacing({ id: x.id, apiKey: '' })}>Replace key</button><button className="bt sm" onClick={() => remove(x)}>Remove</button></span>}
        </div>)}
      </div>)}
    </section>
    <p className="sub" style={{ fontSize: 13 }}>Replacing a key updates everyone who has it. Removing one takes it from everyone straight away; their own keys are untouched. Every change is written to the audit log.</p>
  </>;
}

function PersonPanel({ item, pay, onClose, onToggle, onPrices, onUnlock, onRemove, onRevoke, onNewCode, onAudit, onSetup }: {
  item: Item; pay: PaymentSettings | null; onClose: () => void; onSetup: (t: { who: 'user' | 'invite'; id: string; name: string }) => void; onToggle: (u: UserRow) => void; onPrices: (u: UserRow) => void; onUnlock: (u: UserRow) => void;
  onRemove: (u: UserRow) => void; onRevoke: (i: InviteRow) => void; onNewCode: (i: InviteRow) => void; onAudit: (id: string) => void;
}) {
  const [recent, setRecent] = useState<AuditRow[] | null>(null);
  const box = useRef<HTMLElement>(null);
  useEffect(() => {
    box.current?.querySelector<HTMLElement>('button')?.focus();
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [onClose, item.id]);
  useEffect(() => {
    setRecent(null);
    if (item.kind === 'user') api<{ entries: AuditRow[] }>(`/admin/audit?user=${item.id}&per=10`).then((r) => setRecent(r.entries.slice(0, 5))).catch(() => setRecent([]));
  }, [item.id, item.kind]);
  const name = item.kind === 'user' ? item.name || item.email : item.email;
  if (item.kind === 'invite') {
    const p = invitePay(item);
    return (
      <aside ref={box} className="person" aria-label={`Invite for ${item.email}`}>
        <div className="person-head"><span className="av big" style={{ background: avColour(item.id) }}>{initials(item.email)}</span>
          <span className="person-id"><b>Invited</b><span className="sub ell">{item.email}</span><span className="sub small">{item.role === 'admin' ? 'Admin' : 'Member'} · invited {when(item.createdAt)} · expires {fmtDate(item.expiresAt)}</span></span>
          <button className="bt x" onClick={onClose} aria-label="Close">✕</button></div>
        <div className="psec"><span className="k">Invite</span><span className={'tone-' + (p.tone ?? 'plain')} style={{ fontSize: 15 }}>{p.text}</span></div>
        <div className="psec"><div className="psec-row"><span className="k">Engine</span><span className={'tag' + (item.engineSetup?.keys ? ' own' : '')}>{item.engineSetup?.keys ? 'Set up' : 'Default'}</span></div>
          <span style={{ fontSize: 15 }}>{engineLine(item.engineSetup)}</span><span className="sub small">Copied to their account when they join.</span>
          <button className="bt" style={{ alignSelf: 'flex-start' }} onClick={() => onSetup({ who: 'invite', id: item.id, name: item.email })}>Set up Niko for them</button></div>
        <div className="psec"><span className="k">Actions</span><div className="acts">
          {item.hasCode && item.codeTries >= 5 && <button className="bt" onClick={() => onNewCode(item)}>Send new code</button>}
          <button className="bt" onClick={() => onRevoke(item)}>{item.paidAt ? 'Revoke and refund' : 'Revoke invite'}</button>
        </div></div>
      </aside>
    );
  }
  const p = payText(item);
  const unpaid = !!item.signup && item.signup.state !== 'waiting';
  const payer = item.role !== 'admin' && !item.lifetime && !unpaid;
  return (
    <aside ref={box} className="person" aria-label={name}>
      <div className="person-head"><span className="av big" style={{ background: avColour(item.id) }}>{initials(item.name || item.email)}</span>
        <span className="person-id"><b>{item.name || '—'}</b><span className="sub ell">{item.email}</span><span className="sub small">{item.role === 'admin' ? 'Admin' : 'Member'} · joined {fmtDate(item.createdAt)} · last seen {when(item.lastActiveAt)}</span></span>
        <button className="bt x" onClick={onClose} aria-label="Close">✕</button></div>
      {!item.isOwner && !unpaid && <div className="psec"><span className="k">Account</span>
        <div className="pay-line"><Switch on={item.status === 'active'} onChange={() => onToggle(item)} label={`Account enabled for ${item.email}`} /><span style={{ fontSize: 14 }}>{item.status === 'active' ? 'Switched on: they can sign in and use Niko.' : item.signup ? 'Waiting for you: switch on to let them in (they get a welcome email).' : 'Switched off: they can’t sign in.'}</span></div></div>}
      <div className="psec"><span className="k">Payment</span><span className={'tone-' + (p.tone ?? 'plain')} style={{ fontSize: 15 }}>{p.text}</span><span className="sub small">Status: {statusText(item)}</span></div>
      {payer && pay && <div className="psec"><div className="psec-row"><span className="k">Plan prices</span><span className={'tag' + (item.keptPrices ? ' own' : '')}>{item.keptPrices ? (item.pricesFrom === 'admin' ? 'Own' : `Own · kept${item.pricesAt ? ' ' + fmtDate(item.pricesAt) : ''}`) : 'Default'}</span></div>
        <span style={{ fontSize: 15 }}>{offersLine(item.keptPrices ?? plansOffered(pay)) || 'No plans on'}</span><span className="sub small">What they pay when they next choose a plan.</span></div>}
      <div className="psec"><div className="psec-row"><span className="k">Engine</span><span className={'tag' + (item.engineSetup?.keys ? ' own' : '')}>{item.engineSetup?.keys ? 'Set up' : 'Default'}</span></div>
        <span style={{ fontSize: 15 }}>{engineLine(item.engineSetup)}</span>
        <button className="bt" style={{ alignSelf: 'flex-start' }} onClick={() => onSetup({ who: 'user', id: item.id, name: item.name || item.email })}>Set up Niko for {firstName(item.name || item.email)}</button></div>
      {(payer || unpaid) && <div className="psec"><span className="k">Actions</span><div className="acts">
        {payer && pay && <button className="bt" onClick={() => onPrices(item)}>Change prices</button>}
        {payer && <button className="bt" onClick={() => onUnlock(item)}>Unlock</button>}
        {unpaid && <button className="bt" onClick={() => onRemove(item)}>Remove sign-up</button>}
      </div></div>}
      <div className="psec"><span className="k">Recent activity</span>
        {recent === null ? <span className="sub small">Loading…</span> : !recent.length ? <span className="sub small">Nothing yet.</span>
          : <ul className="recent">{recent.map((a) => <li key={a.id}><span>{actionLabel(a.action)}</span><span className="sub small">{new Date(a.createdAt).toLocaleString([], { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}{a.by && a.by !== item.email ? ` · by ${a.byName || a.by}` : ''}</span></li>)}</ul>}
        <button className="lnk" style={{ alignSelf: 'flex-start', paddingLeft: 0 }} onClick={() => onAudit(item.id)}>See all in the audit log</button></div>
    </aside>
  );
}
const engineLine = (e?: { keys: number; order: 'free' | 'fixed' }) => (e?.keys ? `${e.keys} ${e.keys === 1 ? 'service' : 'services'} with your keys · ${e.order === 'fixed' ? 'yours stay first' : 'they can reorder'}` : 'Niko’s built-in services and their own keys.');
/** "plan_prices.user" → "Plan prices user": readable enough without a table of every action. */
const actionLabel = (a: string) => { const s = a.replace(/[._]/g, ' '); return s.charAt(0).toUpperCase() + s.slice(1); };

function PeopleTab({ onSignedOut, onOpenPayments, onAudit }: { onSignedOut: () => void; onOpenPayments: () => void; onAudit: (id: string) => void }) {
  const [q, setQ] = useState('');
  const qd = useDebounced(q.trim());
  const [show, setShow] = useState<Show>('all');
  const [page, setPage] = useState(1);
  const [per, setPer] = useState(25);
  const [data, setData] = useState<ListReply | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [selItem, setSelItem] = useState<Item | null>(null);
  const [inviting, setInviting] = useState(false);
  const [regMenu, setRegMenu] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string; code?: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [unlocking, setUnlocking] = useState<UserRow | null>(null);
  const [pricing, setPricing] = useState<UserRow | null>(null);
  const [setting, setSetting] = useState<{ who: 'user' | 'invite'; id: string; name: string } | null>(null);
  const said = (text: string, ok = true, code?: string) => { setNote({ ok, text, code }); setCopied(false); };
  const guard = useCallback((e: unknown) => { if (e instanceof ApiError && e.status === 401) onSignedOut(); else setNote({ ok: false, text: (e as Error).message }); }, [onSignedOut]);
  const load = useCallback(async () => {
    try {
      const r = await api<ListReply>(`/admin/users?${new URLSearchParams({ q: qd, show, page: String(page), per: String(per) })}`);
      setData(r);
      if (r.page !== page) setPage(r.page);
    } catch (e) { guard(e); }
  }, [qd, show, page, per, guard]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { setPage(1); }, [qd, show, per]);
  // The open panel follows the latest copy of its person (after a change), and stays open if they're on another page.
  useEffect(() => { if (sel && data) { const f = data.items.find((i) => i.id === sel); if (f) setSelItem(f); } }, [data, sel]);
  const open = (i: Item) => { setSel(i.id); setSelItem(i); };
  const close = useCallback(() => { setSel(null); setSelItem(null); }, []);
  const after = async (text?: string, ok = true) => { if (text) said(text, ok); await load(); };
  const setReg = async (mode: 'invite' | 'open') => { setRegMenu(false); try { await api('/admin/registration', { method: 'PUT', body: { mode } }); await after(mode === 'open' ? 'Registration is open: anyone can sign up.' : 'Invite only: the sign-up page is hidden.'); } catch (e) { guard(e); } };
  const toggle = async (u: UserRow) => {
    try {
      await api(`/admin/users/${u.id}`, { method: 'PATCH', body: { status: u.status === 'active' ? 'off' : 'active' } });
      await after(u.status !== 'active' && u.signup ? `${u.name || u.email} is switched on and gets a welcome email.` : undefined);
    } catch (e) { guard(e); }
  };
  const revoke = async (i: InviteRow) => {
    if (i.paidAt && !window.confirm(`Revoke ${i.email}’s invite and refund ${money(i.priceCents)}?`)) return;
    try { const r = await api<{ refunded: boolean }>(`/admin/invites/${i.id}`, { method: 'DELETE' }); close(); await after(r.refunded ? `Invite for ${i.email} revoked and refund started. Stripe returns it to their card, usually within 5–10 business days.` : `Invite for ${i.email} revoked. The link and code no longer work.`); } catch (e) { guard(e); }
  };
  const newCode = async (i: InviteRow) => {
    try { const r = await api<{ emailed: boolean; code: string }>(`/admin/invites/${i.id}/code`, { method: 'POST' }); said(`New code and link emailed to ${i.email}. The old ones no longer work:`, true, r.code); await load(); } catch (e) { guard(e); }
  };
  const remove = async (u: UserRow) => {
    if (!window.confirm(`Remove ${u.email}’s unpaid sign-up?`)) return;
    try { await api(`/admin/users/${u.id}`, { method: 'DELETE' }); close(); await after(`${u.name || u.email}’s unpaid sign-up was removed.`); } catch (e) { guard(e); }
  };
  const pay = data?.payments ?? null;
  const counts = data?.counts;
  return <>
    {data?.stripeMode === 'test' && <TestBanner onOpen={onOpenPayments} />}
    <header className="people-head">
      <div><h1>Users</h1><p className="sub" style={{ fontSize: 15 }}>Everyone with an account or an invite. Select a person to see and change everything about them.</p></div>
      <div className="people-acts">
        <div className="reg">
          <button className="chip big" aria-haspopup="menu" aria-expanded={regMenu} onClick={() => setRegMenu(!regMenu)}><span className="k">Registration</span>{data?.registration === 'open' ? 'Open registration' : 'Invite only'} ▾</button>
          {regMenu && <div className="menu" role="menu">
            {([['invite', 'Invite only', 'Only people you invite can create an account. The sign-up page is hidden.'], ['open', 'Open registration', pay?.openPay ? 'Anyone can sign up. They confirm their email and pay, then wait for you to switch them on.' : 'Anyone can sign up. They confirm their email, then wait for you to switch them on.']] as const).map(([k, label, sub]) => (
              <button key={k} role="menuitemradio" aria-checked={data?.registration === k} className="menu-item" onClick={() => setReg(k)}><span className="mark" aria-hidden="true">{data?.registration === k ? '✓' : ''}</span><span><b>{label}</b><span className="sub small">{sub}</span></span></button>
            ))}
            <p className="menu-foot sub small"><i className={'dot' + (data?.stripe ? (data.stripeMode === 'live' ? ' on' : ' test') : '')} />{data?.stripe ? (data.stripeMode === 'live' ? 'Stripe live · real payments in SGD' : 'Stripe test mode · no real money moves') : `Stripe ${data?.stripeMode ?? ''} mode isn’t set up yet`}</p>
          </div>}
        </div>
        <button className="pri" style={{ height: 44, fontSize: 14 }} onClick={() => { setInviting(true); setRegMenu(false); }}>+ Invite</button>
      </div>
    </header>
    <div className="people-bar">
      <label className="search"><span className="sr">Search by name or email</span><input className="in" type="search" placeholder="Search name or email" value={q} onChange={(e) => setQ(e.target.value)} /></label>
      <div role="group" aria-label="Show" className="chips">
        {SHOWS.map(([k, label]) => <button key={k} className="chip" aria-pressed={show === k} onClick={() => setShow(k)}>{label} <b>{counts?.[k] ?? '·'}</b></button>)}
      </div>
    </div>
    {note && <div className={note.ok ? 'ok banner' : 'err banner'} role="status"><span>{note.text}</span>
      {note.code && <><span className="code" aria-label="Invite code">{showCode(note.code)}</span><button className="bt" onClick={() => { navigator.clipboard?.writeText(note.code!).catch(() => undefined); setCopied(true); }}>{copied ? 'Copied' : 'Copy code'}</button></>}
      <button className="bt sm" onClick={() => setNote(null)} aria-label="Dismiss">✕</button>
    </div>}
    <section className="g card people" aria-label="Accounts">
      <div className="urow head" aria-hidden="true"><span className="k">Person</span><span className="k">Role</span><span className="k">Status</span><span className="k">Payment · plan prices</span><span className="k">On</span><span /></div>
      <div className="ulist">
        {data && !data.items.length && <p className="sub empty">{qd ? `No one matches “${qd}”.` : 'No one here.'}</p>}
        {data?.items.map((i) => {
          const isUser = i.kind === 'user';
          const name = isUser ? i.name || '—' : 'Invited';
          const p = isUser ? payText(i) : invitePay(i);
          const unpaid = isUser && !!i.signup && i.signup.state !== 'waiting';
          const payer = isUser && i.role !== 'admin' && !i.lifetime && !unpaid;
          const status = isUser ? statusText(i) : 'Invited';
          return (
            <div key={i.id} className={'urow' + (sel === i.id ? ' sel' : '')} onClick={() => open(i)}>
              <button className="person-cell" onClick={(e) => { e.stopPropagation(); open(i); }} aria-label={`Open ${isUser ? i.name || i.email : i.email}`}>
                <span className="av" style={{ background: avColour(i.id) }}>{initials(isUser ? i.name || i.email : i.email)}</span>
                <span className="person-id"><b className="ell">{name}</b><span className="sub ell">{i.email}</span></span>
              </button>
              <span className="u-role">{i.role === 'admin' ? 'Admin' : 'Member'}</span>
              <span><span className={'spill' + (status === 'Active' ? ' on' : status === 'Waiting for you' || status === 'Invited' ? ' wait' : status === 'Paused' ? ' ended' : '')}><i />{status}</span></span>
              <span className="u-pay"><span className={'ell tone-' + (p.tone ?? 'plain')}>{p.text}</span>
                {payer && pay && <span className="pricetag"><span className={'tag' + (i.keptPrices ? ' own' : '')}>{i.keptPrices ? (i.pricesFrom === 'admin' ? 'Own' : 'Own · kept') : 'Default'}</span><span className="sub small ell">{offersLine(i.keptPrices ?? plansOffered(pay)) || 'no plans'}</span></span>}</span>
              {/* The switch works on its own: it never opens the panel. */}
              <span className="u-on" onClick={(e) => e.stopPropagation()}>{isUser && i.isOwner ? <span className="k small">Owner</span> : isUser && !unpaid ? <Switch on={i.status === 'active'} onChange={() => toggle(i)} label={`Account enabled for ${i.email}`} /> : null}</span>
              <span className="chev" aria-hidden="true">›</span>
            </div>
          );
        })}
      </div>
      {data && <Pager page={data.page} pages={data.pages} total={data.total} per={data.per} pers={[10, 25, 50, 100]} onPage={setPage} onPer={setPer} />}
    </section>
    <p className="sub" style={{ fontSize: 13 }}>Paid sign-ups stay off until you switch them on; their paid time starts then. Unpaid sign-ups are removed after 7 days. Prices are fixed when the invite is sent. Card details go to Stripe, never to Niko. Every change here is written to the audit log.</p>
    {selItem && <PersonPanel item={selItem} pay={pay} onClose={close} onToggle={toggle} onPrices={setPricing} onUnlock={setUnlocking} onRemove={remove} onRevoke={revoke} onNewCode={newCode} onAudit={onAudit} onSetup={setSetting} />}
    {setting && <SetupSheet target={setting} onClose={() => setSetting(null)} onSaved={async (text) => { setSetting(null); await after(text); }} />}
    {inviting && <InviteDialog pay={pay} stripeOn={data?.stripe ?? false} mode={data?.stripeMode ?? 'test'} onClose={() => setInviting(false)} onSent={async (text, ok, code) => { setInviting(false); said(text, ok, code); setShow('all'); setQ(''); await load(); }} />}
    {pricing && pay && <PricesDialog user={pricing} defaults={plansOffered(pay)} onClose={() => setPricing(null)} onDone={async (text) => { setPricing(null); await after(text); }} />}
    {unlocking && <UnlockDialog user={unlocking} onClose={() => setUnlocking(null)} onDone={async (text) => { setUnlocking(null); await after(text); }} />}
  </>;
}

// ---------------------------------------------------------------- audit log, one page at a time
function AuditTab({ guard, person, onPerson }: { guard: (e: unknown) => void; person: string | null; onPerson: (id: string | null) => void }) {
  const [q, setQ] = useState('');
  const qd = useDebounced(q.trim());
  const [page, setPage] = useState(1);
  const [per, setPer] = useState(50);
  const [data, setData] = useState<{ entries: AuditRow[]; total: number; page: number; per: number; pages: number; person: { id: string; label: string } | null } | null>(null);
  useEffect(() => { setPage(1); }, [qd, per, person]);
  useEffect(() => {
    api<NonNullable<typeof data>>(`/admin/audit?${new URLSearchParams({ q: qd, page: String(page), per: String(per), ...(person ? { user: person } : {}) })}`).then(setData).catch(guard);
  }, [qd, page, per, person, guard]);
  return <>
    <header><h1>Audit log</h1><p className="sub" style={{ fontSize: 15 }}>Every sign-in, change and payment, newest first. File entries record name, size and time only, never contents.</p></header>
    <div className="people-bar">
      <label className="search"><span className="sr">Search the audit log</span><input className="in" type="search" placeholder="Search actions or details" value={q} onChange={(e) => setQ(e.target.value)} /></label>
      {data?.person && <button className="chip" aria-pressed="true" onClick={() => onPerson(null)}>Only {data.person.label} <b>✕</b></button>}
    </div>
    <section className="g card people" aria-label="Audit entries">
      <div className="arow head" aria-hidden="true"><span className="k">When</span><span className="k">What</span><span className="k">By</span><span className="k">Details</span></div>
      <div className="ulist">
        {data && !data.entries.length && <p className="sub empty">{qd ? `Nothing matches “${qd}”.` : 'Nothing yet.'}</p>}
        {data?.entries.map((a) => (
          <div key={a.id} className="arow">
            <span className="sub">{new Date(a.createdAt).toLocaleString([], { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' })}</span>
            <b className="mono-ish">{a.action}</b>
            <span className="sub ell">{a.byName || a.by || '—'}</span>
            <span className="sub a-detail">{Object.entries(a.detail).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`).join(' · ') || '—'}</span>
          </div>
        ))}
      </div>
      {data && <Pager page={data.page} pages={data.pages} total={data.total} per={data.per} pers={[25, 50, 100]} onPage={setPage} onPer={setPer} />}
    </section>
  </>;
}

function Users({ onSignedOut, initialMe }: { onSignedOut: () => void; initialMe?: { name: string; email: string } | null }) {
  const [tab, setTab] = useState<'users' | 'payments' | 'ai' | 'keys' | 'glance' | 'limits' | 'security' | 'audit'>('users');
  const [me, setMe] = useState<{ name: string; email: string } | null>(initialMe ?? null);
  const [auditFor, setAuditFor] = useState<string | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [fresh, setFresh] = useState<string[] | null>(null);
  const [confirmCodes, setConfirmCodes] = useState(false);

  const guard = useCallback((e: unknown) => { if (e instanceof ApiError && e.status === 401) onSignedOut(); else setNote({ ok: false, text: (e as Error).message }); }, [onSignedOut]);
  useEffect(() => { if (!initialMe) api('/admin/me').then(setMe).catch(() => undefined); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const newCodes = async () => {
    if (!confirmCodes) return setConfirmCodes(true);
    setConfirmCodes(false);
    try { const r = await api<{ recoveryCodes: string[] }>('/admin/recovery-codes', { method: 'POST' }); setFresh(r.recoveryCodes); } catch (e) { guard(e); }
  };
  const signOut = async () => { await api('/admin/sign-out', { method: 'POST' }).catch(() => undefined); onSignedOut(); };
  return (
    <div className="shell">
      <aside>
        <div className="brand"><span className="wordmark">NIKO</span><span className="k tag">Admin</span></div>
        <nav aria-label="Admin sections">
          <button className="nv" aria-current={tab === 'users' ? 'page' : undefined} onClick={() => setTab('users')}>Users</button>
          <button className="nv" aria-current={tab === 'payments' ? 'page' : undefined} onClick={() => setTab('payments')}>Payments</button>
          <button className="nv" aria-current={tab === 'ai' ? 'page' : undefined} onClick={() => setTab('ai')}>AI options</button>
          <button className="nv" aria-current={tab === 'keys' ? 'page' : undefined} onClick={() => setTab('keys')}>Included keys</button>
          <button className="nv" aria-current={tab === 'glance' ? 'page' : undefined} onClick={() => setTab('glance')}>New items</button>
          <button className="nv" aria-current={tab === 'limits' ? 'page' : undefined} onClick={() => setTab('limits')}>Limits</button>
          <button className="nv" aria-current={tab === 'security' ? 'page' : undefined} onClick={() => setTab('security')}>Security</button>
          <button className="nv" aria-current={tab === 'audit' ? 'page' : undefined} onClick={() => { setAuditFor(null); setTab('audit'); }}>Audit log</button>
        </nav>
        <div className="who"><span className="sub" style={{ fontSize: 13 }}>Signed in as {me?.name || me?.email || '…'}</span><button className="nv line" onClick={signOut}>Sign out</button></div>
      </aside>
      <main key={tab} className="hud-in">
        {tab === 'users' ? <PeopleTab onSignedOut={onSignedOut} onOpenPayments={() => setTab('payments')} onAudit={(id) => { setAuditFor(id); setTab('audit'); }} />
 : tab === 'payments' ? <PaymentsAdmin guard={guard} /> : tab === 'ai' ? <AiOptions guard={guard} /> : tab === 'keys' ? <KeysLibrary guard={guard} /> : tab === 'glance' ? <GlanceAdmin guard={guard} /> : tab === 'limits' ? <LimitsAdmin guard={guard} /> : tab === 'security' ? <>
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
        </> : <AuditTab guard={guard} person={auditFor} onPerson={setAuditFor} />}
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
