// Niko admin portal: sign-in with a second factor, then users and registration.
import { StrictMode, useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { api, ApiError, Meter, BackgroundPreview, DesignPreview, Field, PasswordField, Switch } from '@niko/ui';
import { BACKGROUNDS, backgroundInfo, DESIGNS, designInfo, type BackgroundInfo, type DesignInfo } from '@niko/shared';
import { AI_OPTION_GROUPS, AI_PRESETS, aiAllowed, defaultOn, KN_DB_FREE_BYTES, KN_FILE_STEPS, KN_MB_FILE_STEPS, KN_MB_TOTAL_STEPS, type KnowledgeLimits, BUILTIN_TOKEN, hearPresetOf, imagePresetOf, presetOf, providedIds, voicePresetOf, HEAR_PROVIDERS, IMAGE_PROVIDERS, MAP_PROVIDERS, USAGE_KINDS, USAGE_NAMES, USAGE_STEPS, USAGE_UNITS, VOICE_PROVIDERS, type MapField, type ProvidedSetup, type UsageKind, aiHasBrain, aiOff, CALENDAR_LIMIT_STEPS, GLANCE_PART_NAMES, GLANCE_PARTS, GLANCE_STEPS, GRACE_STEPS, lengthLabel, MAX_MONTHS, money, offersLine, plansDiffer, plansOffered, showCode, toCents, unlockPlan, type AccessState, type AccountLimits, type GlanceLimits, type PaymentSettings } from '@niko/shared';
import '@niko/ui/src/styles.css';
import './admin.css';
import { DataSourcesAdmin } from './dataSources';

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
  const [find, setFind] = useState('');
  const load = useCallback(async () => {
    try { const r = await api<{ defaults: Record<string, boolean>; users: AiUser[] }>('/admin/ai'); setDefaults(r.defaults); setPeople(r.users); }
    catch (e) { guard(e); }
  }, [guard]);
  useEffect(() => { void load(); }, [load]);
  const person = people.find((p) => p.id === sel) ?? null;
  // What is being edited: the default itself, or this person's changes to it.
  useEffect(() => { if (defaults) { setDraft(person ? { ...person.aiAccess } : { ...defaults }); setDirty(false); } }, [sel, defaults, people]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!defaults) return null;
  const defOn = (k: string) => defaultOn(defaults, k);
  const on = (k: string) => (k in draft ? draft[k]! : person ? defOn(k) : defaultOn({}, k));
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
        <input className="in lim-find" type="search" aria-label="Find a person" placeholder="Find a person" value={find} onChange={(e) => setFind(e.target.value)} />
        <div className="ai-list">
          {[{ id: 'all', name: 'Everyone', sub: 'The default for all accounts', badge: 'Default', tone: '' }, ...people.filter((p) => !find.trim() || `${p.name} ${p.email}`.toLowerCase().includes(find.trim().toLowerCase())).map((p) => ({ id: p.id, name: p.name || p.email, sub: p.email, badge: p.role === 'admin' ? 'Admin' : count(p) ? `${count(p)} ${count(p) === 1 ? 'change' : 'changes'}` : 'Default', tone: p.role === 'admin' ? ' is-free' : count(p) ? ' is-chg' : '' }))].map((p) => (
            <button key={p.id} className="who-row" aria-pressed={p.id === sel} onClick={() => { if (dirty && !window.confirm('Leave without saving these changes?')) return; setSel(p.id); setNote(null); }}>
              <span className="who-txt"><b>{p.name}</b><span>{p.sub}</span></span><span className={'lim-badge' + p.tone}>{p.badge}</span>
            </button>
          ))}
          {find.trim() && !people.some((p) => `${p.name} ${p.email}`.toLowerCase().includes(find.trim().toLowerCase())) && <p className="sub small" style={{ padding: '6px' }}>No one matches “{find.trim()}”.</p>}
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
          {AI_OPTION_GROUPS.filter((g) => !g.ownPage).map((g) => {
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

// ---------------------------------------------------------------- Knowledge (as the Admin-Knowledge mockup)
type KnAdminUser = { id: string; name: string; email: string; role: string; status: string; knowledgeLimits: Partial<KnowledgeLimits>; used: { files: number; bytes: number; notes?: number } };
type KnAdmin = { ready: boolean; usage: { bytes: number; files: number; people: number } | null; split: 'browser' | 'server'; defaults: KnowledgeLimits; users: KnAdminUser[] };
/** The Knowledge switches built so far, in their groups (the others in AI_OPTION_GROUPS arrive with their stages). */
const KN_GROUPS: [string, string[]][] = [['Files', ['kn:files']], ['Where they keep files', ['kn:place:niko', 'kn:place:device', 'kn:place:notion', 'kn:place:gdrive', 'kn:place:onedrive', 'kn:place:s3']], ['Cloudflare', ['kn:cf-read', 'kn:cf-search']], ['Other search sources', ['kn:search-key', 'kn:search-server']], ['Learning', ['kn:learning']]];
const KN_SHOWN = KN_GROUPS.flatMap(([, keys]) => keys);
const KN_LIMIT_ROWS: [keyof KnowledgeLimits, string, string, number[], (n: number) => string][] = [
  ['files', 'Files', 'How many files each person can keep', KN_FILE_STEPS, (n) => `${n.toLocaleString()} files`],
  ['mbPerFile', 'Size of each file', 'The largest file they can add', KN_MB_FILE_STEPS, (n) => `${n} MB`],
  ['mbTotal', 'All their files together', 'Counts the files as added, before splitting', KN_MB_TOTAL_STEPS, (n) => `${n} MB`],
];
const knSize = (b: number) => (b < 1024 * 1024 ? `${Math.round(b / 1024)} KB` : b < 1024 ** 3 ? `${(b / 1024 / 1024).toFixed(b < 10 * 1024 * 1024 ? 1 : 0)} MB` : `${(b / 1024 ** 3).toFixed(1)} GB`);
/** Whether each person can give Niko their own files, where, with Cloudflare or not, and how much: a default, then per person. */
function KnowledgeAdmin({ guard }: { guard: (e: unknown) => void }) {
  const [kn, setKn] = useState<KnAdmin | null>(null);
  const [ai, setAi] = useState<{ defaults: Record<string, boolean>; users: AiUser[] } | null>(null);
  const [sel, setSel] = useState('all');
  const [access, setAccess] = useState<Record<string, boolean>>({});
  const [limits, setLimits] = useState<Partial<KnowledgeLimits>>({});
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [find, setFind] = useState('');
  const [split, setSplit] = useState<'browser' | 'server'>('browser');
  const load = useCallback(async () => {
    try {
      const [a, b] = await Promise.all([api<KnAdmin>('/admin/knowledge'), api<{ defaults: Record<string, boolean>; users: AiUser[] }>('/admin/ai')]);
      setKn(a); setAi(b);
    } catch (e) { guard(e); }
  }, [guard]);
  useEffect(() => { void load(); }, [load]);
  const person = kn?.users.find((p) => p.id === sel) ?? null;
  const aiPerson = ai?.users.find((p) => p.id === sel) ?? null;
  useEffect(() => {
    if (!kn || !ai) return;
    const own = aiPerson?.aiAccess ?? {};
    setAccess(Object.fromEntries(KN_SHOWN.filter((k) => (person ? k in own : true)).map((k) => [k, person ? own[k]! : defaultOn(ai.defaults, k)])));
    setLimits(person ? { ...person.knowledgeLimits } : { ...kn.defaults });
    setSplit(kn.split);
    setDirty(false);
  }, [sel, kn, ai]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!kn || !ai) return null;
  const defOn = (k: string) => defaultOn(ai.defaults, k);
  const on = (k: string) => (k in access ? access[k]! : person ? defOn(k) : defaultOn({}, k));
  const changed = (k: string) => !!person && k in access && access[k] !== defOn(k);
  const setOn = (k: string, v: boolean) => { const next = { ...access }; if (person && v === defOn(k)) delete next[k]; else next[k] = v; setAccess(next); setDirty(true); setNote(null); };
  const resetOn = (k: string) => { const next = { ...access }; delete next[k]; setAccess(next); setDirty(true); };
  const limOf = (k: keyof KnowledgeLimits) => limits[k] ?? kn.defaults[k];
  const limChanged = (k: keyof KnowledgeLimits) => !!person && limits[k] !== undefined && limits[k] !== kn.defaults[k];
  const setLim = (k: keyof KnowledgeLimits, v: number) => { const next = { ...limits }; if (person && v === kn.defaults[k]) delete next[k]; else next[k] = v; setLimits(next); setDirty(true); setNote(null); };
  const count = (p: KnAdminUser) => Object.keys(p.knowledgeLimits).length + KN_SHOWN.filter((k) => k in (ai.users.find((u) => u.id === p.id)?.aiAccess ?? {})).length;
  const filesOn = on('kn:files');
  const save = async () => {
    setBusy(true); setNote(null);
    try {
      // AI options keep every switch together, so the Knowledge ones are saved alongside the rest unchanged.
      if (person) {
        const rest = Object.fromEntries(Object.entries(aiPerson?.aiAccess ?? {}).filter(([k]) => !KN_SHOWN.includes(k)));
        await api(`/admin/ai/users/${person.id}`, { method: 'PUT', body: { access: { ...rest, ...access } } });
        await api(`/admin/knowledge/users/${person.id}`, { method: 'PUT', body: { limits } });
      } else {
        await api('/admin/ai/default', { method: 'PUT', body: { access: { ...ai.defaults, ...access } } });
        await api('/admin/knowledge/settings', { method: 'PUT', body: { limits, split } });
      }
      await load(); setNote({ ok: true, text: person ? `Saved for ${person.name || person.email}.` : 'Saved. Everyone without their own changes gets this within a minute.' });
    } catch (e) { if (e instanceof ApiError && e.status === 401) guard(e); else setNote({ ok: false, text: (e as Error).message }); } finally { setBusy(false); }
  };
  const item = (key: string) => AI_OPTION_GROUPS.find((g) => g.id === 'knowledge')!.items.find((i) => i.key === key)!;
  const q = find.trim().toLowerCase();
  const first = person ? (person.name || person.email).split(' ')[0] : '';
  const total = person ? limOf('mbTotal') * 1024 * 1024 : 0;
  const changedMark = (isChanged: boolean, reset: () => void) => isChanged ? <><span className="chg">Changed</span><button className="lnk" onClick={reset}>Reset</button></> : null;
  return <>
    <header className="kn-adm-head">
      <div><h1>Knowledge</h1><p className="sub" style={{ fontSize: 15, maxWidth: 760 }}>Whether each person can give Niko their own files, where they may keep them, and how much. You never see what is in anyone’s files, only counts and sizes.</p></div>
      <section className="g kn-db" aria-label="Knowledge database">
        {kn.ready && kn.usage ? <>
          <span className="kn-db-top"><span className="k">Knowledge database</span><span>{knSize(kn.usage.bytes)} of {knSize(KN_DB_FREE_BYTES)}</span></span>
          <Meter value={kn.usage.bytes / KN_DB_FREE_BYTES} label="Knowledge database used" />
          <span className="sub">Its own free Neon project, so it can never fill up accounts. {kn.usage.files.toLocaleString()} {kn.usage.files === 1 ? 'file' : 'files'} from {kn.usage.people} {kn.usage.people === 1 ? 'person' : 'people'}. Warns at 80%.</span>
        </> : kn.ready ? <><span className="k">Knowledge database</span><span className="sub">Connected.</span></>
          : <><span className="k">Knowledge database</span><span className="sub">Not set up yet, so Knowledge is off for everyone. Add <code>KNOWLEDGE_DATABASE_URL</code> as a Cloudflare build secret and deploy (docs/DEPLOYMENT.md, section 1a).</span></>}
      </section>
    </header>
    {note && <p className={note.ok ? 'ok' : 'err'} role="status">{note.text}</p>}
    <div className="ai-grid">
      <section className="g card ai-people" aria-label="Applies to">
        <span className="k" style={{ padding: '0 6px' }}>Applies to</span>
        <input className="in lim-find" type="search" aria-label="Find a person" placeholder="Find a person" value={find} onChange={(e) => setFind(e.target.value)} />
        <div className="ai-list">
          {[{ id: 'all', name: 'Everyone', sub: 'The default for all accounts', badge: 'Default', tone: '' }, ...kn.users.filter((p) => !q || `${p.name} ${p.email}`.toLowerCase().includes(q)).map((p) => ({ id: p.id, name: p.name || p.email, sub: p.email, badge: p.role === 'admin' ? 'Admin' : count(p) ? `${count(p)} ${count(p) === 1 ? 'change' : 'changes'}` : 'Default', tone: p.role === 'admin' ? ' is-free' : count(p) ? ' is-chg' : '' }))].map((p) => (
            <button key={p.id} className="who-row" aria-pressed={p.id === sel} onClick={() => { if (dirty && !window.confirm('Leave without saving these changes?')) return; setSel(p.id); setNote(null); }}>
              <span className="who-txt"><b>{p.name}</b><span>{p.sub}</span></span><span className={'lim-badge' + p.tone}>{p.badge}</span>
            </button>
          ))}
        </div>
        <p className="sub" style={{ fontSize: 12, padding: '0 6px' }}>New accounts and invites get the default.</p>
      </section>
      <section className="g card ai-options kn-opts" aria-label="Knowledge settings">
        <div className="ai-head">
          <div><h2>{person ? person.name || person.email : 'Everyone · default'}</h2>
            <p className="sub" style={{ fontSize: 13 }}>{person ? (person.role === 'admin' ? 'Admins always have every option; these apply if they are made a member.' : count(person) ? 'Different from the default where marked. Everything else follows the default.' : `Follows the default. Change anything to change it for ${first} only.`) : 'What every account gets, unless it is changed for that person.'}</p></div>
          <div className="ai-acts">
            {person && <button className="bt" onClick={() => { setAccess({}); setLimits({}); setDirty(true); }} disabled={!count(person) && !dirty}>Reset to default</button>}
            <button className="pri" style={{ height: 44, fontSize: 14 }} onClick={save} disabled={busy || !dirty}>{busy ? 'Saving…' : 'Save'}</button>
          </div>
        </div>
        {person && <div className="kn-useline">
          <span className="kn-useline-l"><span>{first} uses {knSize(person.used.bytes)} of {limOf('mbTotal')} MB · {person.used.files.toLocaleString()} of {limOf('files').toLocaleString()} files{person.used.notes ? ` · ${person.used.notes.toLocaleString()} learned ${person.used.notes === 1 ? 'note' : 'notes'}` : ''}</span><Meter value={total ? person.used.bytes / total : 0} label={`Space ${first} uses`} /></span>
          <span className="sub">Kept in Niko’s Knowledge database. You see sizes and counts only.</span>
        </div>}
        {KN_GROUPS.map(([title, keys]) => <div key={title} className="kn-group">
          <span className="k kn-group-h">{title}</span>
          {keys.map((k) => {
            const it = item(k), gated = k !== 'kn:files' && !filesOn;
            return <div key={k} className={'kn-krow' + (gated ? ' dim' : '')}>
              <span className="kn-krow-t"><b>{it.name}</b><span className="sub">{changed(k) ? `Default is ${defOn(k) ? 'on' : 'off'}` : it.sub}</span></span>
              <span className="kn-krow-m">{changedMark(changed(k), () => resetOn(k))}</span>
              <span className="kn-krow-c"><Switch on={on(k)} onChange={(v) => setOn(k, v)} label={it.name} disabled={gated} /></span>
            </div>;
          })}
        </div>)}
        <div className="kn-group">
          <span className="k kn-group-h">How much each person keeps</span>
          {KN_LIMIT_ROWS.map(([k, name, sub, steps, label]) => (
            <div key={k} className={'kn-krow' + (filesOn ? '' : ' dim')}>
              <span className="kn-krow-t"><b>{name}</b><span className="sub">{limChanged(k) ? `Default is ${label(kn.defaults[k])}` : sub}</span></span>
              <span className="kn-krow-m">{changedMark(limChanged(k), () => setLim(k, kn.defaults[k]))}</span>
              <span className="kn-krow-c"><select className="in kn-sel" aria-label={name} value={limOf(k)} onChange={(e) => setLim(k, Number(e.target.value))} disabled={!filesOn}>
                {steps.map((n) => <option key={n} value={n}>{label(n)}</option>)}
              </select></span>
            </div>
          ))}
        </div>
        {!person && <div className="kn-group">
          <span className="k kn-group-h">Reading files</span>
          <div className="kn-krow">
            <span className="kn-krow-t"><b>Split files on Niko’s server</b><span className="sub">{split === 'server' ? 'On · the browser sends the text, Niko splits it' : 'Off · each person’s browser splits their files'}</span></span>
            <span className="kn-krow-m" />
            <span className="kn-krow-c"><Switch on={split === 'server'} onChange={(v) => { setSplit(v ? 'server' : 'browser'); setDirty(true); setNote(null); }} label="Split files on Niko’s server" /></span>
          </div>
          {split === 'server' && <div className="kn-adm-warn">Needs Workers Paid ($5 a month): on the free plan, big files stop part-way. Files already added aren’t changed.</div>}
          <p className="sub" style={{ fontSize: 12, margin: '8px 0 0' }}>Off: each person’s browser splits their files, as now (free plan). On: the browser sends the text and Niko splits it, which is quicker on phones and older computers. Files kept on This device are always read on the device.</p>
        </div>}
        <p className="sub kn-foot">Knowledge files start off: people get them only when you turn them on, for everyone or for them. Lowering a limit never deletes anything; it only stops more files being added. Answering Telegram from Knowledge is each person’s own Settings switch. People see these as part of their plan, with no mention of an admin. Every change is written to the audit log.</p>
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
  const [find, setFind] = useState('');
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
        <input className="in lim-find" type="search" aria-label="Find a person" placeholder="Find a person" value={find} onChange={(e) => setFind(e.target.value)} />
        <div className="ai-list">
          {[{ id: 'all', name: 'Everyone', sub: 'The default for all accounts', badge: 'Default', tone: '' }, ...people.filter((p) => !find.trim() || `${p.name} ${p.email}`.toLowerCase().includes(find.trim().toLowerCase())).map((p) => ({ id: p.id, name: p.name || p.email, sub: p.email, badge: count(p) ? `${count(p)} ${count(p) === 1 ? 'change' : 'changes'}` : 'Default', tone: count(p) ? ' is-chg' : '' }))].map((p) => (
            <button key={p.id} className="who-row" aria-pressed={p.id === sel} onClick={() => { if (dirty && !window.confirm('Leave without saving these changes?')) return; setSel(p.id); setNote(null); }}>
              <span className="who-txt"><b>{p.name}</b><span>{p.sub}</span></span><span className={'lim-badge' + p.tone}>{p.badge}</span>
            </button>
          ))}
          {find.trim() && !people.some((p) => `${p.name} ${p.email}`.toLowerCase().includes(find.trim().toLowerCase())) && <p className="sub small" style={{ padding: '6px' }}>No one matches “{find.trim()}”.</p>}
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
  const [find, setFind] = useState('');
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
  const resetDay = resets ? new Date(resets).toLocaleDateString(undefined, { day: 'numeric', month: 'short', timeZone: 'UTC' }) : '';
  // What each person gets (their own amount, or the default), and whether they are close to a monthly amount.
  const eff = (p: LimitsUser, k: UsageKind) => p.accountLimits[k] ?? defaults[k];
  const near = (p: LimitsUser) => !!p.used && USAGE_KINDS.some((k) => eff(p, k) > 0 && p.used![k] >= eff(p, k) * 0.9);
  const changes = (p: LimitsUser) => Object.keys(p.accountLimits).filter((k) => (p.accountLimits as Record<string, number>)[k] !== (defaults as unknown as Record<string, number>)[k]).length;
  const noLimit = (p: LimitsUser) => USAGE_KINDS.every((k) => eff(p, k) === 0) && USAGE_KINDS.some((k) => defaults[k] > 0);
  const badge = (p: LimitsUser) => (changes(p) ? (noLimit(p) ? 'No limit' : `${changes(p)} ${changes(p) === 1 ? 'change' : 'changes'}`) : 'Default');
  const following = people.filter((p) => !p.invite && !changes(p)).length;
  const q = find.trim().toLowerCase();
  const shownPeople = people.filter((p) => !q || `${p.name} ${p.email}`.toLowerCase().includes(q));
  const totals = Object.fromEntries(USAGE_KINDS.map((k) => [k, people.reduce((n, p) => n + (p.used?.[k] ?? 0), 0)])) as Record<UsageKind, number>;
  const active = Object.fromEntries(USAGE_KINDS.map((k) => [k, people.filter((p) => (p.used?.[k] ?? 0) > 0).length])) as Record<UsageKind, number>;
  const unitOf = (k: UsageKind, n: number) => USAGE_UNITS[k][n === 1 ? 0 : 1];
  const ROW_SUB: Record<UsageKind, string> = { brain: 'Replies from the AI', voice: 'Spoken replies', hear: 'Minutes of speech turned into words', image: 'Pictures made', map: 'Place searches and routes' };
  const monthCol = (k: UsageKind) => {
    if (!person) return `${totals[k].toLocaleString()} ${unitOf(k, totals[k])} · ${active[k]} ${active[k] === 1 ? 'account' : 'accounts'}`;
    if (person.invite) return 'Counts from the day they join';
    const used = person.used?.[k] ?? 0, cap = valOf(k);
    return cap ? `${used.toLocaleString()} of ${cap.toLocaleString()}` : `${used.toLocaleString()} · no limit`;
  };
  const row = (k: LimitKey, name: string, sub: string, options: { v: number; label: string }[], month: string, hot = false) => {
    const changed = isChanged(k);
    const label = (n: number) => options.find((o) => o.v === n)?.label ?? String(n);
    return <div key={k} className="lim-row">
      <span className="lim-what"><b>{name}</b><span className="sub">{changed ? `Default is ${label(defaults[k]).toLowerCase()}` : sub}</span>
        {changed && <span className="cap-chg"><span className="chg">Changed</span><button className="lnk" style={{ padding: 0 }} onClick={() => setVal(k, defaults[k])}>Reset</button></span>}</span>
      <span className={'lim-month' + (hot ? ' hot' : '')}>{month}</span>
      <label className="sr" htmlFor={`lim-${k}`}>{name}, each month</label>
      <select id={`lim-${k}`} className="in lim-sel" value={valOf(k)} onChange={(e) => setVal(k, Number(e.target.value))}>
        {options.map((o) => <option key={o.v} value={o.v}>{o.label}</option>)}
      </select>
    </div>;
  };
  const monthHead = person ? (person.invite ? 'Before they join' : 'This month') : 'Across everyone this month';
  return <>
    <header><h1>Limits</h1><p className="sub" style={{ fontSize: 15, maxWidth: 860 }}>How much each account may add, and how much of Niko’s included services it can use each month. Set the default for everyone, then change it for anyone who needs something different.</p></header>
    {note && <p className={note.ok ? 'ok' : 'err'} role="status">{note.text}</p>}
    <div className="ai-grid">
      <section className="g card ai-people" aria-label="Applies to">
        <span className="k" style={{ padding: '0 6px' }}>Applies to</span>
        <input className="in lim-find" type="search" aria-label="Find a person" placeholder="Find a person" value={find} onChange={(e) => setFind(e.target.value)} />
        <div className="ai-list">
          {[{ id: 'all', name: 'Everyone', sub: 'The default for all accounts', badge: 'Default', warn: false }, ...shownPeople.map((p) => ({ id: p.id, name: p.invite ? p.email : p.name || p.email, sub: p.invite ? 'Invited · not joined yet' : near(p) ? 'Near a monthly amount' : p.email, badge: badge(p), warn: !p.invite && near(p) }))].map((p) => (
            <button key={p.id} className="who-row" aria-pressed={p.id === sel} onClick={() => { if (dirty && !window.confirm('Leave without saving these changes?')) return; setSel(p.id); setNote(null); }}>
              <span className="who-txt"><b>{p.name}</b><span className={p.warn ? 'warn' : ''}>{p.sub}</span></span><span className={'lim-badge' + (p.badge === 'Default' ? '' : p.badge === 'No limit' ? ' is-free' : ' is-chg')}>{p.badge}</span>
            </button>
          ))}
          {q && !shownPeople.length && <p className="sub small" style={{ padding: '6px' }}>No one matches “{find.trim()}”.</p>}
        </div>
        <p className="sub" style={{ fontSize: 12, padding: '0 6px' }}>New accounts and invites get the default. Their own keys are never counted.</p>
      </section>
      <section className="g card ai-options" aria-label="Limits">
        <div className="ai-head">
          <div><h2>{person ? (person.invite ? `${person.email} · invited` : person.name || person.email) : 'Everyone · default'}</h2>
            <p className="sub" style={{ fontSize: 13 }}>{person ? (anyChanged ? 'Some limits are different from the default; the rest follow it.' : 'Follows the default. Change a limit to set it for this person only.') : `What every account gets, unless it is changed for that person. ${following} ${following === 1 ? 'account follows' : 'accounts follow'} it.`}</p></div>
          <div className="ai-acts">
            {person && <button className="bt" onClick={() => { setDraft({}); setDirty(true); }} disabled={!anyChanged}>Reset to default</button>}
            <button className="pri" style={{ height: 44, fontSize: 14 }} onClick={save} disabled={busy || !dirty}>{busy ? 'Saving…' : 'Save'}</button>
          </div>
        </div>
        <div className="psec-row lim-sec"><span className="k" style={{ color: '#fff' }}>Included each month</span>
          {!person && <button className="lnk" onClick={() => { setNote(null); setDirty(true); setDraft({ ...draft, ...Object.fromEntries(USAGE_KINDS.map((k) => [k, 0])) }); }}>No limit on all</button>}</div>
        <p className="sub" style={{ fontSize: 13, lineHeight: 1.5 }}>Counts what Niko’s included services do: the keys you give people and Niko’s built-in ones (Workers AI, OpenStreetMap). Their own keys, the on-device voice and the device’s own listening are never counted. Resets on the 1st of each month{resetDay ? ` (next: ${resetDay})` : ''}.</p>
        <div className="lim-row lim-headrow" aria-hidden="true"><span className="k">What</span><span className="k">{monthHead}</span><span className="k">Each month</span></div>
        {(['brain', 'voice', 'hear', 'image', 'map'] as UsageKind[]).map((k) => row(k, USAGE_NAMES[k], ROW_SUB[k], USAGE_STEPS[k].map((n) => ({ v: n, label: stepText(k, n) })), monthCol(k),
          !!person && !person.invite && valOf(k) > 0 && (person.used?.[k] ?? 0) >= valOf(k) * 0.9))}
        <div className="psec-row lim-sec"><span className="k" style={{ color: '#fff' }}>Accounts</span></div>
        {row('calendars', 'Calendar links', 'Private and public iCal calendars, per account', CALENDAR_LIMIT_STEPS.map((n) => ({ v: n, label: n === 1 ? '1 calendar' : `Up to ${n}` })), `${valOf('calendars')} per account`)}
        <p className="sub" style={{ fontSize: 12, lineHeight: 1.5, paddingTop: 8 }}>At the monthly amount, Niko moves on to the person’s own keys; with none, it tells them when it resets. Raising an amount takes effect at once; lowering one never deletes anything. People see what is included, and their use, on their Engine and Voice pages, worded as part of their plan. Every change is written to the audit log.</p>
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

/** The form, as the server expects it for that kind. */
function keyBody(kind: UsageKind, v: Record<string, string>): Record<string, string> {
  const t = (k: string) => (v[k] ?? '').trim();
  if (kind === 'brain') { const p = AI_PRESETS.find((x) => x.id === (v.preset || 'openai'))!; return { baseUrl: p.id === 'other' ? t('baseUrl') : p.baseUrl, model: t('model') || p.example, apiKey: t('apiKey'), label: t('label') }; }
  if (kind === 'map') { const p = MAP_PROVIDERS.find((x) => x.id === (v.preset || MAP_PROVIDERS[0]!.id))!; return { provider: p.id, ...Object.fromEntries(p.fields.map((f) => [f.key, t(f.key)])), label: t('label') }; }
  const list: { id: string; provider: string; baseUrl?: string; models?: string[] }[] = kind === 'voice' ? VOICE_PROVIDERS : kind === 'hear' ? HEAR_PROVIDERS : IMAGE_PROVIDERS;
  const p = list.find((x) => x.id === (v.preset || list[0]!.id))!;
  return { provider: p.provider, baseUrl: p.id === 'other' ? t('baseUrl') : p.baseUrl ?? '', model: t('model') || p.models?.[0] || '', voice: t('voice'), region: t('region').toLowerCase(), apiKey: t('apiKey'), label: t('label') };
}

/** One provider's fields for a new key (the service is chosen with the chips above). */
function NewKeyFields({ kind, preset, value, onChange }: { kind: UsageKind; preset: string; value: Record<string, string>; onChange: (v: Record<string, string>) => void }) {
  const set = (k: string, v: string) => onChange({ ...value, [k]: v });
  const p = presetList(kind).find((x) => x.id === preset) as any;
  const field = (key: string, label: string, opts: { secret?: boolean; placeholder?: string; list?: string[]; wide?: boolean } = {}) => (
    <label className={'kf' + (opts.wide ? ' wide' : '')} key={key}><span className="sr">{label}</span>
      <input className="in" aria-label={label} type={opts.secret ? 'password' : 'text'} autoComplete={opts.secret ? 'new-password' : 'off'} spellCheck={false} value={value[key] ?? ''} placeholder={opts.placeholder ?? label} list={opts.list?.length ? `kf-${kind}-${key}` : undefined} onChange={(e) => set(key, e.target.value)} />
      {opts.list?.length ? <datalist id={`kf-${kind}-${key}`}>{opts.list.map((m) => <option key={m} value={m} />)}</datalist> : null}
    </label>
  );
  const models: string[] = p?.models ?? [];
  return <div className="kform" onClick={(e) => e.stopPropagation()}>
    {field('label', 'Name, e.g. Team key')}
    {kind === 'map' ? (p?.fields as MapField[]).map((f) => field(f.key, f.label + (f.optional ? ' (optional)' : ''), { secret: f.secret, placeholder: f.placeholder ?? (f.secret ? `Paste the ${f.label.toLowerCase()}` : f.label) }))
      : field('apiKey', 'Paste the API key', { secret: true, wide: true })}
    {kind !== 'map' && preset === 'other' && field('baseUrl', 'Base URL, https://…/v1', { wide: true })}
    {kind !== 'map' && field('model', kind === 'image' && p?.modelLabel ? p.modelLabel : `Model${kind === 'brain' && p?.example ? `, e.g. ${p.example}` : models[0] ? `, e.g. ${models[0]}` : ''}`, { list: models })}
    {kind === 'voice' && field('voice', `Voice${p?.voices?.[0] ? `, e.g. ${p.voices[0].id}` : ''}`, { list: (p?.voices ?? []).map((v: { id: string }) => v.id) })}
    {(kind === 'voice' || kind === 'hear') && p?.provider === 'azure' && field('region', 'Region, e.g. southeastasia')}
    {p?.note && <p className="sub small wide">{p.note}</p>}
  </div>;
}
const presetList = (kind: UsageKind): { id: string; name: string; provider?: string; baseUrl?: string }[] => (kind === 'brain' ? AI_PRESETS : kind === 'voice' ? VOICE_PROVIDERS : kind === 'hear' ? HEAR_PROVIDERS : kind === 'image' ? IMAGE_PROVIDERS : MAP_PROVIDERS);
const OPTION_PREFIX: Record<UsageKind, string> = { brain: 'ai:', voice: 'v:', hear: 'h:', image: 'img:', map: 'map:' };
/** Which provider chip a kept key belongs to. */
function presetOfKey(kind: UsageKind, info: Record<string, string>): string {
  const b = info.baseUrl ?? '';
  if (kind === 'brain') return presetOf(b);
  if (kind === 'voice') return voicePresetOf({ provider: info.provider as any, baseUrl: b });
  if (kind === 'hear') return hearPresetOf({ provider: info.provider as any, baseUrl: b });
  if (kind === 'image') return imagePresetOf({ provider: info.provider as any, baseUrl: b });
  return info.provider ?? '';
}
const BUILT_SHORT: Record<UsageKind, string> = { brain: 'Workers AI', voice: 'Workers AI voice', hear: 'Workers AI', image: 'Workers AI', map: 'OpenStreetMap' };
const BUILT_ROW: Record<UsageKind, string> = { brain: 'Workers AI', voice: 'Workers AI voice', hear: 'Workers AI · Whisper', image: 'Workers AI · FLUX', map: 'OpenStreetMap' };
const DEVICE_ROW: Partial<Record<UsageKind, [string, string]>> = { voice: ['Device voice', 'Always last, on every device'], hear: ['Device speech recognition', 'Always last; it also hears “Niko”'] };
/** The list as the admin set it: provided keys and the built-in, in order (the built-in last when not placed). */
const listOf = (keys: Partial<Record<UsageKind, string[]>>, builtins: Record<UsageKind, boolean>, k: UsageKind) => {
  const l = (keys[k] ?? []).filter((x) => x !== BUILTIN_TOKEN || (builtins[k] && k !== 'map'));
  return builtins[k] && k !== 'map' && !l.includes(BUILTIN_TOKEN) ? [...l, BUILTIN_TOKEN] : l;
};
const capText = (n: number) => (n ? n.toLocaleString() : 'No cap');
type SetupDraft = { keys: Partial<Record<UsageKind, string[]>>; order: 'free' | 'fixed'; builtins: Record<UsageKind, boolean>; limits: Partial<AccountLimits> };

function SetupSheet({ target, startTab, copy, others, onClose, onSaved }: {
  target: { who: 'user' | 'invite'; id: string; name: string }; startTab?: UsageKind | 'caps'; copy?: { from: string; draft: SetupDraft } | null;
  others: { id: string; label: string; kind: 'user' | 'invite' }[]; onClose: () => void; onSaved: (text: string) => void;
}) {
  const first = firstName(target.name);
  const joined = target.who === 'user';
  const [data, setData] = useState<(SetupReply & { off: string[] }) | null>(null);
  const [lib, setLib] = useState<PKey[]>([]);
  const [tab, setTab] = useState<UsageKind | 'caps'>(startTab ?? 'brain');
  const [d, setD] = useState<SetupDraft | null>(null);
  const [adding, setAdding] = useState<null | { preset: string; how: 'reuse' | 'new'; reuse: string; form: Record<string, string>; give: string[] }>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [addErr, setAddErr] = useState('');
  const [note, setNote] = useState('');
  const [dirty, setDirty] = useState(false);
  const [find, setFind] = useState('');
  const box = useRef<HTMLDivElement>(null);
  const loadLib = useCallback(async () => { const r = await api<{ keys: PKey[] }>('/admin/setup/keys'); setLib(r.keys); }, []);
  useEffect(() => {
    (async () => {
      try {
        const [r] = await Promise.all([api<SetupReply & { off: string[] }>(`/admin/setup/${target.who}/${target.id}`), loadLib()]);
        setData(r);
        // A copied setup never brings back what AI options turn off for this person.
        if (copy) { setD({ ...copy.draft, builtins: Object.fromEntries(USAGE_KINDS.map((x) => [x, copy.draft.builtins[x] && r.builtins[x]])) as Record<UsageKind, boolean> }); setDirty(true); setNote(`Copied from ${copy.from}. Check it, then save.`); }
        else setD({ keys: r.setup.keys, order: r.setup.order, builtins: r.builtins, limits: r.limits });
      } catch (e) { setErr((e as Error).message); }
    })();
  }, [target.who, target.id, loadLib, copy]);
  const close = useCallback(() => { if (dirty && !window.confirm('Leave without saving these changes?')) return; onClose(); }, [dirty, onClose]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [close]);
  useEffect(() => { box.current?.querySelector<HTMLElement>('.tab[aria-pressed="true"], button')?.focus(); }, [!!d]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!data || !d) return <div className="scrim"><div className="dialog" role="dialog" aria-modal="true" aria-label="Set up Niko">{err ? <><p className="err" role="alert">{err}</p><div className="dialog-acts"><button className="bt" onClick={onClose}>Close</button></div></> : <p className="sub">Loading…</p>}</div></div>;

  const change = (p: Partial<SetupDraft>) => { setD({ ...d, ...p }); setDirty(true); setErr(''); setNote(''); };
  const list = (k: UsageKind) => listOf(d.keys, d.builtins, k);
  const setList = (k: UsageKind, l: string[]) => change({ keys: { ...d.keys, [k]: l } });
  const libOf = (id: string) => lib.find((x) => x.id === id);
  const provCount = (k: UsageKind) => providedIds(d.keys[k]).length;
  const off = data.off ?? [];
  // AI options decide what this person may use; the setup only arranges what is allowed.
  const allowed = data.builtins;
  const SECTION: Partial<Record<UsageKind, string>> = { voice: 'sec:voices', hear: 'sec:hears', image: 'sec:images', map: 'sec:maps' };
  const secOff = (x: UsageKind) => !!SECTION[x] && off.includes(SECTION[x]!);
  const keyAllowed = (x: UsageKind, key: PKey) => aiAllowed(off, OPTION_PREFIX[x] + presetOfKey(x, key.info));
  const brainEmpty = !providedIds(d.keys.brain).some((id) => { const x = libOf(id); return x && keyAllowed('brain', x); }) && !d.builtins.brain;
  const k = tab === 'caps' ? null : tab;
  const tabs: [UsageKind | 'caps', string][] = [['brain', 'AI · answers'], ['voice', 'Voice'], ['hear', 'Listening'], ['image', 'Pictures'], ['map', 'Maps'], ['caps', 'Usage cap']];
  const tabName = tabs.find((t) => t[0] === tab)![1];

  const openAdd = () => {
    if (!k) return;
    const presets = presetList(k).filter((p) => aiAllowed(off, OPTION_PREFIX[k] + p.id));
    const withKey = presets.find((p) => lib.some((x) => x.kind === k && !list(k).includes(x.id) && presetOfKey(k, x.info) === p.id));
    const preset = (withKey ?? presets[0])?.id ?? '';
    const reuse = lib.find((x) => x.kind === k && !list(k).includes(x.id) && presetOfKey(k, x.info) === preset);
    setAddErr(''); setAdding({ preset, how: reuse ? 'reuse' : 'new', reuse: reuse?.id ?? '', form: {}, give: [] });
  };
  const pickPreset = (preset: string) => {
    if (!k || !adding) return;
    const reuse = lib.find((x) => x.kind === k && !list(k).includes(x.id) && presetOfKey(k, x.info) === preset);
    setAddErr(''); setAdding({ ...adding, preset, how: reuse ? 'reuse' : 'new', reuse: reuse?.id ?? '', form: {} });
  };
  const add = async () => {
    if (!k || !adding) return;
    setAddErr('');
    if (provCount(k) >= 6) return setAddErr('Up to 6 of your keys for each part.');
    if (adding.how === 'reuse') { setList(k, [adding.reuse, ...list(k)]); setAdding(null); return; }
    setBusy(true);
    try {
      const give = { users: adding.give.filter((id) => others.find((o) => o.id === id)?.kind === 'user'), invites: adding.give.filter((id) => others.find((o) => o.id === id)?.kind === 'invite') };
      const r = await api<{ key: { id: string }; given: number; skipped: number }>('/admin/setup/keys', { body: { kind: k, key: keyBody(k, { ...adding.form, preset: adding.preset }), give } });
      await loadLib();
      setD((cur) => (cur ? { ...cur, keys: { ...cur.keys, [k]: [r.key.id, ...listOf(cur.keys, cur.builtins, k)] } } : cur)); setDirty(true); setAdding(null);
      if (r.given || r.skipped) setNote(`Also given to ${r.given} ${r.given === 1 ? 'person' : 'people'}${r.skipped ? `; ${r.skipped} couldn’t get it because AI options turn ${provName} off for them` : ''}.`);
    } catch (e) { setAddErr((e as Error).message); } finally { setBusy(false); }
  };
  const save = async () => {
    setBusy(true); setErr('');
    try {
      const keys = Object.fromEntries(USAGE_KINDS.map((x) => [x, list(x)]));
      await api(`/admin/setup/${target.who}/${target.id}`, { method: 'PUT', body: { keys, order: d.order, builtins: d.builtins, limits: d.limits } });
      setDirty(false); onSaved(joined ? `Saved for ${first}. They get it the next time Niko opens.` : `Saved. It waits with the invite and is in place at ${first}’s first sign-in.`);
    } catch (e) { setErr((e as Error).message); setBusy(false); }
  };

  // ---- one part's list
  const rows = k ? list(k) : [];
  const fixedRows: [string, string, string][] = k === 'map' ? (allowed.map ? [['OpenStreetMap', 'Built in · always last', 'Built in']] : []) : k && DEVICE_ROW[k] ? [[DEVICE_ROW[k]![0], DEVICE_ROW[k]![1], 'Device']] : [];
  const move = (i: number, by: -1 | 1) => { if (!k) return; const l = [...rows]; const j = i + by; [l[i], l[j]] = [l[j]!, l[i]!]; setList(k, l); };
  const remove = (token: string) => {
    if (!k) return;
    if (token === BUILTIN_TOKEN) change({ builtins: { ...d.builtins, [k]: false }, keys: { ...d.keys, [k]: rows.filter((x) => x !== token) } });
    else setList(k, rows.filter((x) => x !== token));
  };
  const presets = k ? presetList(k).filter((p) => aiAllowed(off, OPTION_PREFIX[k] + p.id)) : [];
  const reusable = k && adding ? lib.filter((x) => x.kind === k && !rows.includes(x.id) && presetOfKey(k, x.info) === adding.preset) : [];
  const provName = adding ? presets.find((p) => p.id === adding.preset)?.name ?? 'the service' : '';
  const sel = (on: boolean) => ({ className: 'opt' + (on ? ' on' : ''), 'aria-pressed': on });
  // "Also give it to": the people picked, then up to 8 more (matching the search).
  const q = find.trim().toLowerCase();
  const picked = adding ? others.filter((o) => adding.give.includes(o.id)) : [];
  const matches = others.filter((o) => !picked.includes(o) && (!q || o.label.toLowerCase().includes(q)));
  const giveShown = [...picked, ...matches.slice(0, 8)];
  const giveMore = Math.max(0, matches.length - 8);

  // ---- caps
  const defs = data.limitDefaults;
  const capOf = (u: UsageKind) => d.limits[u] ?? defs[u];
  const usedOf = (u: UsageKind) => (data.usage ? (u === 'hear' ? Math.ceil(data.usage[u].included / 60) : data.usage[u].included) : 0);
  const changedCaps = USAGE_KINDS.filter((u) => d.limits[u] !== undefined && d.limits[u] !== defs[u]);

  return (
    <div className="scrim" onClick={(e) => { if (e.target === e.currentTarget) close(); }}>
      <section ref={box} className="setup" role="dialog" aria-modal="true" aria-labelledby="suh">
        <header className="setup-head">
          <div><h2 id="suh">Set up Niko for {target.name}{joined ? '' : ' · before they join'}</h2>
            <p className="sub">{joined ? `Choose the services Niko uses for ${first}, in order, with your keys where a service needs one, and how much they can use each month. Niko tries them top to bottom and moves to the next when one fails, runs out or reaches the cap.`
              : `It waits with the invite and is in place the first time ${first} signs in. Choose the services, in order, with your keys where a service needs one, and how much they can use each month.`}</p></div>
          <button className="bt x" onClick={close} aria-label="Close">✕</button>
        </header>
        <div className="setup-body">
          <nav className="setup-rail" aria-label="Engine parts">
            {tabs.map(([t, name]) => { const n = t === 'caps' ? 0 : provCount(t); return (
              <button key={t} className="tab" aria-pressed={tab === t} onClick={() => { setTab(t); setAdding(null); }}><span>{name}</span><b>{t === 'caps' ? 'monthly' : n ? `${n} ${n === 1 ? 'key' : 'keys'}` : ''}</b></button>); })}
            <p className="sub rail-note">Services you turned off for {first} in AI options don’t appear here.</p>
          </nav>
          <div className="setup-main">
            {k && <>
              <div className="setup-sec-head"><span className="k">{tabName} · in the order Niko tries them</span>
                <span className="sub">{k === 'map' ? (allowed.map ? 'OpenStreetMap is always last and can’t be removed.' : 'OpenStreetMap is turned off in AI options.') : `Built-in services need no key. Remove any you don’t want ${first} to use.`}</span></div>
              {secOff(k) && <p className="sub off-line">{tabName} {k === 'map' ? 'are' : k === 'voice' ? 'voices are' : 'is'} turned off for {first} in AI options, so there’s nothing to set up here{k === 'voice' ? ' beyond the device voice' : k === 'hear' ? ' beyond the device’s own recognition' : ''}. Change it in AI options first.</p>}
              {!secOff(k) && rows.map((token, i) => {
                const x = token === BUILTIN_TOKEN ? null : libOf(token);
                const name = token === BUILTIN_TOKEN ? BUILT_ROW[k] : x ? serviceName(k, x.info) : 'Removed key';
                const blocked = !!x && !keyAllowed(k, x);
                const sub = token === BUILTIN_TOKEN ? 'Built in · Cloudflare · no key needed' : blocked ? `Turned off for ${first} in AI options · not given when you save` : x ? `${x.label} ··· ${x.info.hint || '····'} · added by you · ${first} can’t see it` : 'No longer kept';
                return <div key={token} className={'svc' + (blocked ? ' blocked' : '')}>
                  <span className="svc-n">{i + 1}</span>
                  <span className="svc-txt"><span className="svc-name"><b>{name}</b><span className={'tag' + (token === BUILTIN_TOKEN || blocked ? '' : ' own')}>{token === BUILTIN_TOKEN ? 'Built in' : blocked ? 'Off in AI options' : 'From you'}</span></span><span className="sub">{sub}</span></span>
                  <span className="svc-mv"><button className="mv" onClick={() => move(i, -1)} disabled={i === 0} aria-label={`Move ${name} up`}>↑</button><button className="mv" onClick={() => move(i, 1)} disabled={i === rows.length - 1} aria-label={`Move ${name} down`}>↓</button></span>
                  <span className="svc-rm"><button className="lnk" onClick={() => remove(token)}>Remove</button></span>
                </div>;
              })}
              {fixedRows.map(([name, sub, tag], i) => <div key={name} className="svc">
                <span className="svc-n">{rows.length + i + 1}</span>
                <span className="svc-txt"><span className="svc-name"><b>{name}</b><span className="tag">{tag}</span></span><span className="sub">{sub}</span></span>
                <span className="svc-mv"><button className="mv" disabled aria-label={`${name} stays last`}>↑</button><button className="mv" disabled aria-label={`${name} stays last`}>↓</button></span>
                <span className="svc-rm" />
              </div>)}
              {!secOff(k) && k !== 'map' && allowed[k] && !d.builtins[k] && <button className="lnk" style={{ alignSelf: 'flex-start', paddingLeft: 0 }} onClick={() => change({ builtins: { ...d.builtins, [k]: true } })}>Put {BUILT_ROW[k]} back</button>}
              {!secOff(k) && k !== 'map' && !allowed[k] && <p className="sub off-line">{BUILT_ROW[k]} is turned off for {first} in AI options, so it isn’t offered here.</p>}
              {k === 'brain' && brainEmpty && <p className="warn-line" role="status">No included way to answer yet: {first} will need an AI key of their own. Add a service with your key to include one.</p>}
              {!adding && !secOff(k) && <button className="bt" style={{ alignSelf: 'flex-start', marginTop: 4 }} onClick={openAdd} disabled={!presets.length}>＋ Add a service with your key</button>}
              {adding && <div className="addbox">
                <div className="psec-row"><b className="addbox-title">Add a service for {first}</b><button className="lnk" onClick={() => { setAdding(null); setAddErr(''); }}>Cancel</button></div>
                <div className="chips-wrap" role="group" aria-label="Service">{presets.map((p) => <button key={p.id} className="chipb" aria-pressed={adding.preset === p.id} onClick={() => pickPreset(p.id)}>{p.name}</button>)}</div>
                {reusable.length ? reusable.map((x) => (
                  <button key={x.id} {...sel(adding.how === 'reuse' && adding.reuse === x.id)} onClick={() => setAdding({ ...adding, how: 'reuse', reuse: x.id })}>
                    <span className="dot" aria-hidden="true"><i /></span>
                    <span className="opt-txt"><b>{reusable.length > 1 ? x.label : 'A key you’ve added before'}</b><span className="sub">{reusable.length > 1 ? '' : `${x.label} `}··· {x.info.hint || '····'} · used by {x.users + x.invites} {x.users + x.invites === 1 ? 'person' : 'people'} · nothing to paste</span></span>
                  </button>))
                  : <div className="opt off" aria-disabled="true"><span className="dot" aria-hidden="true" /><span className="opt-txt"><b>A key you’ve added before</b><span className="sub">None yet for {provName}</span></span></div>}
                <div {...sel(adding.how === 'new')} role="button" tabIndex={0} onClick={() => setAdding({ ...adding, how: 'new' })} onKeyDown={(e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) { e.preventDefault(); setAdding({ ...adding, how: 'new' }); } }}>
                  <span className="dot" aria-hidden="true"><i /></span>
                  <span className="opt-txt"><b>A new key</b><span className="sub">Kept encrypted. Nobody sees it again, you included; it is only ever sent to {provName}.</span>
                    {adding.how === 'new' && <NewKeyFields kind={k} preset={adding.preset} value={adding.form} onChange={(form) => setAdding({ ...adding, form })} />}</span>
                </div>
                {adding.how === 'new' && others.length > 0 && <div className="give">
                  <span className="k">Also give it to</span>
                  {others.length > 8 && <input className="in give-find" type="search" aria-label="Find a person" placeholder="Find a person" value={find} onChange={(e) => setFind(e.target.value)} />}
                  <div className="chips-wrap">{giveShown.map((o) => { const on = adding.give.includes(o.id); return <button key={o.id} className="chipb sm" aria-pressed={on} onClick={() => setAdding({ ...adding, give: on ? adding.give.filter((x) => x !== o.id) : [...adding.give, o.id] })}>{on ? '✓ ' : ''}{o.label}</button>; })}</div>
                  {giveMore > 0 && <span className="sub small">{giveMore} more · search to find them</span>}
                  <span className="sub small">One paste, saved once. Each person gets it at the top of their {tabName.toLowerCase()} list; you can take it away from one person without affecting the others.</span>
                </div>}
                {addErr && <p className="err" role="alert">{addErr}</p>}
                <div className="add-go"><button className="pri" onClick={add} disabled={busy || (adding.how === 'reuse' && !adding.reuse)}>{adding.how === 'reuse' ? 'Add' : busy ? 'Testing…' : 'Test and add'}</button>
                  <span className="sub small">{adding.how === 'reuse' ? `It goes to the top of ${first}’s list.` : `Niko checks the key with ${provName} first, then puts it at the top.`}</span></div>
              </div>}
            </>}
            {tab === 'caps' && <>
              <div className="setup-sec-head col"><span className="k">Usage cap · each month</span>
                <span className="sub">{changedCaps.length ? `Some caps are changed for ${first}; the rest follow the default for everyone (set on Limits).` : `Follows the default for everyone (set on Limits). Pick a different amount to change it for ${first} only.`} How much {first} can use through your keys and Workers AI each month. Their own keys are never counted or capped. At the cap, Niko moves on to their own keys; with none, it tells them when the cap resets.</span></div>
              {USAGE_KINDS.map((u) => {
                const cap = capOf(u), used = usedOf(u), changed = changedCaps.includes(u);
                const pct = cap ? Math.min(100, Math.round((used / cap) * 100)) : Math.min(100, used / 20);
                return <div key={u} className="cap">
                  <span className="cap-name"><b>{USAGE_NAMES[u]}</b><span className="sub">{u === 'map' ? 'searches and routes a month' : `${USAGE_UNITS[u][1]} a month`}</span><span className="sub">Default {capText(defs[u])}</span>
                    {changed && <span className="cap-chg"><span className="chg">Changed</span><button className="lnk" style={{ padding: 0 }} onClick={() => { const l = { ...d.limits }; delete l[u]; change({ limits: l }); }}>Reset</button></span>}</span>
                  <span className="cap-pick"><span className="chips-wrap" role="group" aria-label={`${USAGE_NAMES[u]} each month`}>{USAGE_STEPS[u].map((n) => <button key={n} className="chipb sm" aria-pressed={cap === n} onClick={() => { const l = { ...d.limits }; if (n === defs[u]) delete l[u]; else l[u] = n; change({ limits: l }); }}>{capText(n)}</button>)}</span>
                    <span className="bar" aria-hidden="true"><i style={{ width: `${pct}%` }} className={cap && pct >= 90 ? 'hot' : ''} /></span></span>
                  <span className="sub cap-used">{joined ? `${used.toLocaleString()} used · ${capText(cap)}` : `Counts from the day ${first} joins`}</span>
                </div>;
              })}
              <span className="sub small">Caps reset on the 1st of each month. {first} sees the same numbers on their Engine screen. “No cap” means only your services’ own limits apply.</span>
            </>}
          </div>
        </div>
        <footer className="setup-foot">
          <fieldset><legend className="k">What {first} can change</legend>
            <div className="opts-row">
              <button {...sel(d.order === 'free')} onClick={() => change({ order: 'free' })}><span className="dot" aria-hidden="true"><i /></span><span className="opt-txt"><b>The order, and add their own keys</b><span className="sub">Recommended. Your keys stay; {first} can’t see or remove them.</span></span></button>
              <button {...sel(d.order === 'fixed')} onClick={() => change({ order: 'fixed' })}><span className="dot" aria-hidden="true"><i /></span><span className="opt-txt"><b>Only add their own keys</b><span className="sub">Your order stays as you set it; their keys come after yours.</span></span></button>
            </div>
          </fieldset>
          <div className="setup-acts">
            {err ? <span className="err" role="alert">{err}</span> : <span className={note ? 'ok' : 'sub'} role="status">{note || (joined ? `${first} gets this the next time Niko opens.` : `Waits with the invite; in place at ${first}’s first sign-in.`)}</span>}
            <div className="acts"><button className="bt" onClick={close}>Cancel</button><button className="pri" onClick={save} disabled={busy}>{busy && !adding ? 'Saving…' : `Save for ${first}`}</button></div>
          </div>
        </footer>
      </section>
    </div>
  );
}

/** The Engine card in a person's panel: what Niko uses for them, set up by you or not, and this month's use. */
function EngineCard({ who, id, name, onSetup, onCopy, copyFrom }: {
  who: 'user' | 'invite'; id: string; name: string; onSetup: (tab?: UsageKind | 'caps') => void; onCopy: (fromId: string, fromName: string, fromWho: 'user' | 'invite') => void;
  copyFrom: { id: string; label: string; kind: 'user' | 'invite' }[];
}) {
  const [data, setData] = useState<(SetupReply & { off: string[] }) | null>(null);
  const [lib, setLib] = useState<PKey[]>([]);
  const [menu, setMenu] = useState(false);
  const first = firstName(name);
  useEffect(() => {
    let live = true;
    setData(null);
    Promise.all([api<SetupReply & { off: string[] }>(`/admin/setup/${who}/${id}`), api<{ keys: PKey[] }>('/admin/setup/keys')])
      .then(([r, l]) => { if (live) { setData(r); setLib(l.keys); } }).catch(() => undefined);
    return () => { live = false; };
  }, [who, id, name]);
  if (!data) return <div className="psec"><span className="k">Engine</span><span className="sub small">Loading…</span></div>;
  const provided = USAGE_KINDS.reduce((n, k) => n + providedIds(data.setup.keys[k]).length, 0);
  const short = (k: UsageKind, token: string) => { if (token === BUILTIN_TOKEN) return BUILT_SHORT[k]; const x = lib.find((y) => y.id === token); return x ? `${serviceName(k, x.info).split(' · ')[0]} (your key)` : ''; };
  const off = data.off ?? [];
  const SECTION: Partial<Record<UsageKind, string>> = { voice: 'sec:voices', hear: 'sec:hears', image: 'sec:images', map: 'sec:maps' };
  const line = (k: UsageKind) => {
    if (SECTION[k] && off.includes(SECTION[k]!)) return k === 'voice' ? 'Device voice only (AI options)' : k === 'hear' ? 'Device recognition only (AI options)' : 'Turned off in AI options';
    const l = listOf(data.setup.keys, data.builtins, k)
      .filter((t) => { const x = t === BUILTIN_TOKEN ? null : lib.find((y) => y.id === t); return !x || aiAllowed(off, OPTION_PREFIX[k] + presetOfKey(k, x.info)); })
      .map((t) => short(k, t)).filter(Boolean);
    if (k === 'map' && data.builtins.map) l.push('OpenStreetMap');
    if (k === 'voice' || k === 'hear') l.push(k === 'voice' ? 'Device voice' : 'Device speech recognition');
    return l.length ? l.slice(0, 2).join(', then ') : k === 'brain' ? 'Their own AI key' : k === 'image' ? 'Their own image key' : k === 'map' ? 'Their own map key' : 'None';
  };
  const parts: [UsageKind, string][] = [['brain', 'Answers'], ['voice', 'Voice'], ['hear', 'Listening'], ['image', 'Pictures'], ['map', 'Maps']];
  const tag = provided ? (who === 'user' ? 'Set up by you' : `Ready for when ${first} joins`) : 'Default';
  return <>
    <div className="psec eng-card">
      <div className="psec-row"><span className="k" style={{ color: '#fff' }}>Engine</span><span className={'tag' + (provided ? ' own' : '')}>{tag}</span></div>
      {parts.map(([k, label]) => <div key={k} className="eng-line"><span className="sub">{label}</span><span>{line(k)}</span></div>)}
      <span className="sub small">{who === 'user' ? `${first} can still add their own keys. Their own keys are never capped.` : `Set up before ${first} joins: it is waiting at their first sign-in.`}</span>
      <div className="acts copy-wrap">
        <button className="bt fill" onClick={() => onSetup()}>Set up Niko for {first}</button>
        <button className="bt" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(!menu)} disabled={!copyFrom.length} title={copyFrom.length ? undefined : 'No one else is set up yet'}>Copy from…</button>
        {menu && <div className="menu copy-menu" role="menu">
          {copyFrom.map((o) => <button key={o.id} role="menuitem" className="menu-item" onClick={() => { setMenu(false); onCopy(o.id, o.label, o.kind); }}><span className="mark" aria-hidden="true" /><span><b>{o.label}</b><span className="sub small">Their setup, ready to check and save</span></span></button>)}
        </div>}
      </div>
    </div>
    <div className="psec">
      <div className="psec-row"><span className="k">Use this month</span><span className="sub small">{who === 'user' ? `Resets ${resetDay()}` : `Starts when ${first} joins`}</span></div>
      {who === 'user' && data.usage ? <>
        {parts.map(([k, label]) => {
          const cap = data.limits[k] ?? data.limitDefaults[k], used = k === 'hear' ? Math.ceil(data.usage![k].included / 60) : data.usage![k].included;
          const pct = cap ? Math.min(100, Math.round((used / cap) * 100)) : 0;
          return <div key={k} className="use-row"><div className="psec-row"><span className="small">{label}</span><span className="sub small">{used.toLocaleString()} of {capText(cap)}</span></div><span className="bar" aria-hidden="true"><i style={{ width: `${pct}%` }} className={cap && pct >= 90 ? 'hot' : ''} /></span></div>;
        })}
        <button className="lnk" style={{ alignSelf: 'flex-start', paddingLeft: 0 }} onClick={() => onSetup('caps')}>Change the caps</button>
      </> : <span className="sub small">Nothing yet. Caps are set and start counting when {first} joins.</span>}
    </div>
  </>;
}
const resetDay = () => { const n = new Date(); return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth() + 1, 1)).toLocaleDateString(undefined, { day: 'numeric', month: 'short', timeZone: 'UTC' }); };

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

type SetupTarget = { who: 'user' | 'invite'; id: string; name: string };
// ---------------------------------------------------------------- designs
// Which Niko designs people can choose, and what they cost. Switching a design off hides it from people who don't own
// it (whoever bought it keeps it); switching it back on makes it new for bundle owners who don't have it.
type DesignRow = { on: boolean; paid: boolean; cents: number | null; everOn: boolean; wasOff: boolean };
type DesignCfg = { designs: Record<string, DesignRow>; bundleCents: number | null; credit: boolean; rate: 'saving' | 'percent'; percent: number; pro: { on: boolean; monthly: number | null; yearly: number | null } };
function DesignsAdmin({ guard }: { guard: (e: unknown) => void }) {
  const [saved, setSaved] = useState<DesignCfg | null>(null);
  const [d, setD] = useState<DesignCfg | null>(null);
  const [prices, setPrices] = useState<Record<string, string>>({});
  const [bundle, setBundle] = useState('');
  const [pct, setPct] = useState('30');
  const [proM, setProM] = useState('');
  const [proY, setProY] = useState('');
  const [list, setList] = useState<DesignInfo[]>([]);
  const [owners, setOwners] = useState<Record<string, number>>({});
  const [counts, setCounts] = useState<{ bundles: number; pro: number } | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const take = (s: DesignCfg) => {
    setSaved(s); setD(s);
    setPrices(Object.fromEntries(Object.entries(s.designs).map(([id, e]) => [id, centsText(e.cents)])));
    setBundle(centsText(s.bundleCents)); setPct(String(s.percent)); setProM(centsText(s.pro.monthly)); setProY(centsText(s.pro.yearly));
  };
  useEffect(() => {
    api<{ settings: DesignCfg; designs: DesignInfo[]; owners: Record<string, number>; bundles: number; pro: number }>('/admin/designs')
      .then((r) => { take(r.settings); setList(r.designs); setOwners(r.owners); setCounts({ bundles: r.bundles, pro: r.pro }); }).catch(guard);
  }, [guard]);
  if (!d || !saved) return null;
  const row = (id: string, p: Partial<DesignRow>) => { setD({ ...d, designs: { ...d.designs, [id]: { ...d.designs[id]!, ...p } } }); setNote(null); };
  // The draft as it would be saved: typed prices read as cents.
  const draft: DesignCfg = {
    ...d, bundleCents: toCents(bundle), percent: Math.max(0, Math.min(90, parseInt(pct, 10) || 0)),
    pro: { ...d.pro, monthly: toCents(proM), yearly: toCents(proY) },
    designs: Object.fromEntries(Object.entries(d.designs).map(([id, e]) => [id, { ...e, cents: toCents(prices[id] ?? '') }])),
  };
  const offered = list.filter((x) => x.id !== 'nebula' && draft.designs[x.id]?.on && draft.designs[x.id]!.paid);
  const missing = offered.filter((x) => !draft.designs[x.id]!.cents).length;
  const sum = offered.reduce((n, x) => n + (draft.designs[x.id]!.cents ?? 0), 0);
  const b = draft.bundleCents;
  const ratio = !missing && b && sum > b ? b / sum : null;
  const bundleNote = !offered.length ? 'No paid designs are offered, so the bundle is hidden.'
    : missing ? `Covers the ${offered.length} paid designs offered today. Give every paid design a price to see the saving.`
    : !b ? `Covers the ${offered.length} paid designs offered today, ${money(sum)} if bought one by one.`
    : b >= sum ? `The bundle should cost less than the ${money(sum)} the designs cost one by one.`
    : `Covers the ${offered.length} paid designs offered today, ${money(sum)} one by one. People save ${Math.round((1 - ratio!) * 100)}%.`;
  const off = d.rate === 'saving' ? (ratio == null ? null : 1 - ratio) : draft.percent / 100;
  const EX = 400;
  const rateNote = off == null ? 'Bundle owners get the same saving as the bundle. Set the bundle price to see an example.'
    : `Example: a new design at ${money(EX)} costs bundle owners ${money(Math.max(50, Math.round(EX * (1 - off))))} (${Math.round(off * 100)}% off). Everyone else pays full price.`;
  const status = (id: string) => {
    const e = draft.designs[id]!, was = saved.designs[id]!;
    const priceBit = !e.paid ? 'included' : e.cents ? `${money(e.cents)} once` : 'needs a price';
    const own = owners[id] ? ` · ${owners[id]} own it` : '';
    if (!e.on) return { text: was.on || e.everOn ? `Not offered · anyone who bought it keeps it${own}` : 'New · not offered yet', hi: false };
    if (e.wasOff || (!was.on && was.everOn)) return { text: `Back as a new design · ${priceBit}`, hi: true };
    if (!was.everOn) return { text: `New · ${priceBit}`, hi: true };
    return { text: `Offered · ${priceBit}${own}`, hi: false };
  };
  const save = async () => {
    setNote(null);
    const bad = (v: string) => v.trim() !== '' && toCents(v) === null;
    if (Object.values(prices).some(bad) || bad(bundle) || bad(proM) || bad(proY)) return setNote({ ok: false, text: 'Prices are in Singapore dollars, at least 0.50, like 4 or 4.50.' });
    setBusy(true);
    try {
      const r = await api<{ settings: DesignCfg }>('/admin/designs', { method: 'PUT', body: { settings: draft } });
      take(r.settings);
      setNote({ ok: true, text: 'Saved. New purchases use these prices; anyone who already unlocked keeps what they have.' });
    } catch (e) { if (e instanceof ApiError && e.status === 401) guard(e); else setNote({ ok: false, text: (e as Error).message }); } finally { setBusy(false); }
  };
  const proLine = [draft.pro.monthly ? `+${money(draft.pro.monthly)} a month` : '+SGD [MONTHLY]', draft.pro.yearly ? `+${money(draft.pro.yearly)} a year` : '+SGD [YEARLY]'].join(' or ');
  const see = [
    { name: 'Nebula', note: 'Included for everyone.', price: 'Included' },
    { name: 'One design', note: 'Pay once, keep it.', price: offered.length ? 'Price above' : '—' },
    { name: 'All designs', note: `Every paid design offered today.${d.credit ? ' Less what they already paid.' : ''}`, price: b ? money(b) : 'SGD [BUNDLE]' },
    { name: 'New design, bundle owners', note: 'Pro-rated, one payment.', price: off == null ? 'SGD [PRO-RATED]' : `${Math.round(off * 100)}% off` },
    { name: 'Niko Pro add-on', note: d.pro.on ? 'On top of their plan, once pay-once time ends. Every design, new ones included.' : 'Not offered.', price: d.pro.on ? proLine : '—' },
  ];
  return <>
    <header><h1>Designs</h1><p className="sub" style={{ fontSize: 15 }}>Which Niko designs people can choose, and what they cost. Prices in Singapore dollars{counts ? ` · ${counts.bundles} with the bundle · ${counts.pro} on Niko Pro` : ''}.</p></header>
    {note && <p className={note.ok ? 'ok' : 'err'} role="status">{note.text}</p>}
    <div className="pay-grid">
      <section className="g card" aria-label="Design prices">
        <div><span className="k">Design prices</span>
          <p className="sub" style={{ marginTop: 6 }}>Switch a design on to offer it. Paid designs are a one-time unlock, kept on every device, even after a design is switched off.</p></div>
        <div className="pay-block">
          <b className="pay-h">1 · Each design</b>
          <div className="dz-rows">
            {list.map((x) => {
              const fixed = x.id === 'nebula', e = draft.designs[x.id], st = fixed ? null : status(x.id);
              return (
                <div key={x.id} className="dz-arow">
                  <Switch on={fixed || !!e?.on} onChange={(v) => row(x.id, { on: v })} label={`Offer ${x.name}`} disabled={fixed} />
                  <span className="dz-amini"><DesignPreview design={x.id} particles={x.id === 'nebula' ? 300 : undefined} /></span>
                  <span className="pay-txt"><span>{x.name}</span><span className={'sub small' + (st?.hi ? ' dz-hi' : '')}>{fixed ? 'Everyone has it' : st!.text}</span></span>
                  {fixed ? <span className="sub small">Always included · the default</span> : (
                    <div className="pay-line">
                      <div role="group" aria-label={`${x.name}: included or paid`} className="segs">
                        <button className="seg" aria-pressed={!e!.paid} disabled={!e!.on} onClick={() => row(x.id, { paid: false })}>Included</button>
                        <button className="seg" aria-pressed={e!.paid} disabled={!e!.on} onClick={() => row(x.id, { paid: true })}>Paid</button>
                      </div>
                      <label className={'price' + (e!.on && e!.paid ? '' : ' dim')}><span className="k">SGD</span><span className="sr">{x.name} price in Singapore dollars</span>
                        <input className="in" inputMode="decimal" placeholder="Amount" value={prices[x.id] ?? ''} disabled={!e!.on || !e!.paid} onChange={(ev) => { setPrices({ ...prices, [x.id]: ev.target.value }); setNote(null); }} style={{ width: 110 }} /></label>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
        <div className="pay-block">
          <b className="pay-h">2 · All designs bundle</b>
          <div className="pay-line">
            <label className="price"><span className="k">SGD</span><span className="sr">Bundle price in Singapore dollars</span><input className="in" inputMode="decimal" placeholder="Amount" value={bundle} onChange={(ev) => { setBundle(ev.target.value); setNote(null); }} /></label>
            <span>once, for every paid design offered today</span>
          </div>
          <p className={'sub small' + (b && sum && !missing && b >= sum ? ' err' : '')}>{bundleNote}</p>
          <div className="pay-row">
            <Switch on={d.credit} onChange={(v) => { setD({ ...d, credit: v }); setNote(null); }} label="Count designs someone already bought toward the bundle" />
            <span className="pay-txt"><span>Count designs someone already bought</span><span className="sub small">{d.credit ? 'Someone who owns a few designs pays the bundle price minus what they paid for them.' : 'Everyone pays the full bundle price, whatever they already own.'}</span></span>
          </div>
        </div>
        <div className="pay-block">
          <b className="pay-h">3 · When a new design arrives</b>
          <p className="sub small">The bundle covers what was offered when someone bought it. Bundle owners can add each new design for a pro-rated amount.</p>
          <div role="group" aria-label="How the pro-rated amount is worked out" className="segs">
            <button className="seg" aria-pressed={d.rate === 'saving'} onClick={() => { setD({ ...d, rate: 'saving' }); setNote(null); }}>Bundle’s saving</button>
            <button className="seg" aria-pressed={d.rate === 'percent'} onClick={() => { setD({ ...d, rate: 'percent' }); setNote(null); }}>Set percentage off</button>
          </div>
          {d.rate === 'percent' && <div className="pay-line"><label><span className="sr">Percentage off for bundle owners</span><input className="in num" inputMode="numeric" value={pct} onChange={(ev) => { setPct(ev.target.value.replace(/\D/g, '').slice(0, 2)); setNote(null); }} /></label><span>% off each new design’s price</span></div>}
          <p className="sub small">{rateNote}</p>
        </div>
        <div className="pay-block">
          <b className="pay-h">4 · Switching a design off, or back on</b>
          <div className="dz-rule"><span className="k">Off</span><span className="pay-txt"><span>It stops being offered</span><span className="sub small">Hidden from people who don’t own it and left out of the bundle. Everyone who bought it, on its own or in a bundle, keeps using it.</span></span></div>
          <div className="dz-rule"><span className="k dz-hi">On</span><span className="pay-txt"><span>It comes back as a new design</span><span className="sub small">People who own it keep it. Bundle owners who don’t have it can add it at the pro-rated amount, and it joins the bundle for new buyers.</span></span></div>
        </div>
        <div className="pay-acts"><button className="pri" style={{ height: 44, fontSize: 14 }} onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save design prices'}</button><span className="sub small">Anyone who already unlocked a design keeps it. New prices apply to new purchases.</span></div>
      </section>
      <div className="pay-side">
        <section className="g card" aria-label="Niko Pro">
          <div className="card-head"><span className="k">Niko Pro · add-on</span><Switch on={d.pro.on} onChange={(v) => { setD({ ...d, pro: { ...d.pro, on: v } }); setNote(null); }} label="Offer the Niko Pro add-on" /></div>
          <p className="sub">Added on top of someone’s monthly or yearly plan: every design offered, new ones included, while the add-on is on. It covers backgrounds too unless Backgrounds leaves them out.</p>
          <div className="pay-row"><span className="pay-name" style={{ width: 140 }}>On monthly plans</span><label className={'price' + (d.pro.on ? '' : ' dim')}><span className="k">SGD</span><span className="sr">Add-on price for monthly plans, in Singapore dollars</span><input className="in" inputMode="decimal" placeholder="Amount" value={proM} disabled={!d.pro.on} onChange={(ev) => { setProM(ev.target.value); setNote(null); }} /></label><span className="sub">extra a month</span></div>
          <div className="pay-row"><span className="pay-name" style={{ width: 140 }}>On yearly plans</span><label className={'price' + (d.pro.on ? '' : ' dim')}><span className="k">SGD</span><span className="sr">Add-on price for yearly plans, in Singapore dollars</span><input className="in" inputMode="decimal" placeholder="Amount" value={proY} disabled={!d.pro.on} onChange={(ev) => { setProY(ev.target.value); setNote(null); }} /></label><span className="sub">extra a year</span></div>
          <ul className="dz-list sub small">
            <li>Not offered during pay-once time. It appears once someone is on a monthly or yearly plan.</li>
            <li>Joins their plan’s Stripe subscription, so both renew and bill together. Adding it mid-period charges only the rest of that period.</li>
            <li>If the add-on or their plan ends: designs bought once stay; the rest go back to Nebula.</li>
          </ul>
        </section>
        <section className="g card" aria-label="What people see">
          <span className="k">What people see</span>
          <ol className="dz-see">{see.map((x) => <li key={x.name}><span className="pay-txt"><span>{x.name}</span><span className="sub small">{x.note}</span></span><b>{x.price}</b></li>)}</ol>
          <p className="sub small">To give one person a design with no payment, go to Users → the person → Designs.</p>
        </section>
      </div>
    </div>
  </>;
}

/** One person's designs in Users: what they own and how, and gifts (a design with no payment). Only gifts can be
 * taken back; anything paid for stays theirs. */
function PersonDesigns({ id, isAdmin }: { id: string; isAdmin: boolean }) {
  const [r, setR] = useState<{ owned: { design: string; source: string }[]; bundle: string | null; pro: boolean } | null>(null);
  const [give, setGive] = useState('');
  const [msg, setMsg] = useState('');
  const load = () => api<{ owned: { design: string; source: string }[]; bundle: string | null; pro: boolean }>(`/admin/users/${id}/designs`).then(setR).catch(() => setR({ owned: [], bundle: null, pro: false }));
  useEffect(() => { setR(null); setMsg(''); void load(); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (isAdmin) return <div className="psec"><span className="k">Designs</span><span className="sub small">Admins have every design.</span></div>;
  if (!r) return <div className="psec"><span className="k">Designs</span><span className="sub small">Loading…</span></div>;
  const how: Record<string, string> = { single: 'Bought', bundle: 'In bundle', topup: 'Added later', gift: 'Given by you' };
  const owned = new Set(r.owned.map((o) => o.design));
  const left = DESIGNS.filter((x) => x.id !== 'nebula' && !owned.has(x.id));
  const act = async (p: Promise<unknown>) => { setMsg(''); try { await p; await load(); setGive(''); } catch (e) { setMsg((e as Error).message); } };
  return (
    <div className="psec"><span className="k">Designs</span>
      <span className="sub small">{[r.bundle ? `All designs bundle since ${fmtDate(r.bundle)}` : '', r.pro ? 'Niko Pro is on' : ''].filter(Boolean).join(' · ') || 'Nebula, plus anything included.'}</span>
      {r.owned.length > 0 && <ul className="recent">{r.owned.map((o) => <li key={o.design}><span>{designInfo(o.design).name}</span><span className="sub small">{how[o.source] ?? o.source}{o.source === 'gift' && <> · <button className="lnk" style={{ padding: 0, minHeight: 0 }} onClick={() => act(api(`/admin/users/${id}/designs/${o.design}`, { method: 'DELETE' }))}>Take back</button></>}</span></li>)}</ul>}
      {left.length > 0 && <div className="pay-line">
        <label><span className="sr">Design to give</span><select className="in sel" value={give} onChange={(e) => setGive(e.target.value)}><option value="">Choose a design</option>{left.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></label>
        <button className="bt" disabled={!give} onClick={() => act(api(`/admin/users/${id}/designs`, { body: { design: give } }))}>Give</button>
      </div>}
      {msg && <span className="err small" role="alert">{msg}</span>}
    </div>
  );
}

// ---------------------------------------------------------------- backgrounds
// Which backgrounds people can choose behind Niko, and what they cost. The same rules as designs. Niko Pro's price is
// set with designs; here the admin only says whether Pro covers backgrounds too.
type BgRow = { on: boolean; paid: boolean; cents: number | null; everOn: boolean; wasOff: boolean };
type BgCfg = { backgrounds: Record<string, BgRow>; bundleCents: number | null; credit: boolean; rate: 'saving' | 'percent'; percent: number; pro: boolean };
function BackgroundsAdmin({ guard }: { guard: (e: unknown) => void }) {
  const [saved, setSaved] = useState<BgCfg | null>(null);
  const [d, setD] = useState<BgCfg | null>(null);
  const [prices, setPrices] = useState<Record<string, string>>({});
  const [bundle, setBundle] = useState('');
  const [pct, setPct] = useState('30');
  const [list, setList] = useState<BackgroundInfo[]>([]);
  const [owners, setOwners] = useState<Record<string, number>>({});
  const [bundles, setBundles] = useState<number | null>(null);
  const [proPrice, setProPrice] = useState<{ on: boolean; monthly: number | null; yearly: number | null } | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const take = (s: BgCfg) => {
    setSaved(s); setD(s);
    setPrices(Object.fromEntries(Object.entries(s.backgrounds).map(([id, e]) => [id, centsText(e.cents)])));
    setBundle(centsText(s.bundleCents)); setPct(String(s.percent));
  };
  useEffect(() => {
    api<{ settings: BgCfg; backgrounds: BackgroundInfo[]; owners: Record<string, number>; bundles: number; proPrice: { on: boolean; monthly: number | null; yearly: number | null } }>('/admin/backgrounds')
      .then((r) => { take(r.settings); setList(r.backgrounds); setOwners(r.owners); setBundles(r.bundles); setProPrice(r.proPrice); }).catch(guard);
  }, [guard]);
  if (!d || !saved) return null;
  const row = (id: string, p: Partial<BgRow>) => { setD({ ...d, backgrounds: { ...d.backgrounds, [id]: { ...d.backgrounds[id]!, ...p } } }); setNote(null); };
  const draft: BgCfg = {
    ...d, bundleCents: toCents(bundle), percent: Math.max(0, Math.min(90, parseInt(pct, 10) || 0)),
    backgrounds: Object.fromEntries(Object.entries(d.backgrounds).map(([id, e]) => [id, { ...e, cents: toCents(prices[id] ?? '') }])),
  };
  const offered = list.filter((x) => x.id !== 'glow' && draft.backgrounds[x.id]?.on && draft.backgrounds[x.id]!.paid);
  const missing = offered.filter((x) => !draft.backgrounds[x.id]!.cents).length;
  const sum = offered.reduce((n, x) => n + (draft.backgrounds[x.id]!.cents ?? 0), 0);
  const b = draft.bundleCents;
  const ratio = !missing && b && sum > b ? b / sum : null;
  const bundleNote = !offered.length ? 'No paid backgrounds are offered, so the bundle is hidden.'
    : missing ? `Covers the ${offered.length} paid backgrounds offered today. Give every paid background a price to see the saving.`
    : !b ? `Covers the ${offered.length} paid backgrounds offered today, ${money(sum)} if bought one by one.`
    : b >= sum ? `The bundle should cost less than the ${money(sum)} the backgrounds cost one by one.`
    : `Covers the ${offered.length} paid backgrounds offered today, ${money(sum)} one by one. People save ${Math.round((1 - ratio!) * 100)}%.`;
  const off = d.rate === 'saving' ? (ratio == null ? null : 1 - ratio) : draft.percent / 100;
  const EX = 300;
  const rateNote = off == null ? 'Bundle owners get the same saving as the bundle. Set the bundle price to see an example.'
    : `Example: a new background at ${money(EX)} costs bundle owners ${money(Math.max(50, Math.round(EX * (1 - off))))} (${Math.round(off * 100)}% off). Everyone else pays full price.`;
  const status = (id: string) => {
    const e = draft.backgrounds[id]!, was = saved.backgrounds[id]!;
    const priceBit = !e.paid ? 'included' : e.cents ? `${money(e.cents)} once` : 'needs a price';
    const own = owners[id] ? ` · ${owners[id]} own it` : '';
    if (!e.on) return { text: was.on || e.everOn ? `Not offered · anyone who bought it keeps it${own}` : 'New · not offered yet', hi: false };
    if (e.wasOff || (!was.on && was.everOn)) return { text: `Back as a new background · ${priceBit}`, hi: true };
    if (!was.everOn) return { text: `New · ${priceBit}`, hi: true };
    return { text: `Offered · ${priceBit}${own}`, hi: false };
  };
  const save = async () => {
    setNote(null);
    const bad = (v: string) => v.trim() !== '' && toCents(v) === null;
    if (Object.values(prices).some(bad) || bad(bundle)) return setNote({ ok: false, text: 'Prices are in Singapore dollars, at least 0.50, like 3 or 3.50.' });
    setBusy(true);
    try {
      const r = await api<{ settings: BgCfg }>('/admin/backgrounds', { method: 'PUT', body: { settings: draft } });
      take(r.settings);
      setNote({ ok: true, text: 'Saved. New purchases use these prices; anyone who already unlocked keeps what they have.' });
    } catch (e) { if (e instanceof ApiError && e.status === 401) guard(e); else setNote({ ok: false, text: (e as Error).message }); } finally { setBusy(false); }
  };
  const proOn = !!proPrice?.on;
  const proLine = !proOn ? 'Not offered' : [proPrice!.monthly ? `+${money(proPrice!.monthly)} a month` : '', proPrice!.yearly ? `+${money(proPrice!.yearly)} a year` : ''].filter(Boolean).join(' or ') || 'Set under Designs';
  const see = [
    { name: 'Glow', note: 'Included for everyone.', price: 'Included' },
    { name: 'One background', note: 'Pay once, keep it.', price: offered.length ? 'Price above' : '—' },
    { name: 'All backgrounds', note: `Every paid background offered today.${d.credit ? ' Less what they already paid.' : ''}`, price: b ? money(b) : 'SGD [BUNDLE]' },
    { name: 'New background, bundle owners', note: 'Pro-rated, one payment.', price: off == null ? 'SGD [PRO-RATED]' : `${Math.round(off * 100)}% off` },
    { name: 'Niko Pro add-on', note: !proOn ? 'Switched off under Designs.' : d.pro ? 'On top of their plan, once pay-once time ends. Every background and design, new ones included.' : 'Covers designs only. Backgrounds are bought on their own.', price: d.pro ? proLine : '—' },
  ];
  return <>
    <header><h1>Backgrounds</h1><p className="sub" style={{ fontSize: 15 }}>Which backgrounds people can choose behind Niko, and what they cost. Prices in Singapore dollars{bundles != null ? ` · ${bundles} with the bundle` : ''}.</p></header>
    {note && <p className={note.ok ? 'ok' : 'err'} role="status">{note.text}</p>}
    <div className="pay-grid">
      <section className="g card" aria-label="Background prices">
        <div><span className="k">Background prices</span>
          <p className="sub" style={{ marginTop: 6 }}>Switch a background on to offer it. Paid backgrounds are a one-time unlock, kept on every device, even after a background is switched off.</p></div>
        <div className="pay-block">
          <b className="pay-h">1 · Each background</b>
          <div className="dz-rows">
            {list.map((x) => {
              const fixed = x.id === 'glow', e = draft.backgrounds[x.id], st = fixed ? null : status(x.id);
              return (
                <div key={x.id} className="dz-arow">
                  <Switch on={fixed || !!e?.on} onChange={(v) => row(x.id, { on: v })} label={`Offer ${x.name}`} disabled={fixed} />
                  <span className="dz-amini wide"><BackgroundPreview background={x.id} paused /></span>
                  <span className="pay-txt"><span>{x.name}</span><span className={'sub small' + (st?.hi ? ' dz-hi' : '')}>{fixed ? 'Everyone has it' : st!.text}</span></span>
                  {fixed ? <span className="sub small">Always included · the default</span> : (
                    <div className="pay-line">
                      <div role="group" aria-label={`${x.name}: included or paid`} className="segs">
                        <button className="seg" aria-pressed={!e!.paid} disabled={!e!.on} onClick={() => row(x.id, { paid: false })}>Included</button>
                        <button className="seg" aria-pressed={e!.paid} disabled={!e!.on} onClick={() => row(x.id, { paid: true })}>Paid</button>
                      </div>
                      <label className={'price' + (e!.on && e!.paid ? '' : ' dim')}><span className="k">SGD</span><span className="sr">{x.name} price in Singapore dollars</span>
                        <input className="in" inputMode="decimal" placeholder="Amount" value={prices[x.id] ?? ''} disabled={!e!.on || !e!.paid} onChange={(ev) => { setPrices({ ...prices, [x.id]: ev.target.value }); setNote(null); }} style={{ width: 110 }} /></label>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
        <div className="pay-block">
          <b className="pay-h">2 · All backgrounds bundle</b>
          <div className="pay-line">
            <label className="price"><span className="k">SGD</span><span className="sr">Bundle price in Singapore dollars</span><input className="in" inputMode="decimal" placeholder="Amount" value={bundle} onChange={(ev) => { setBundle(ev.target.value); setNote(null); }} /></label>
            <span>once, for every paid background offered today</span>
          </div>
          <p className={'sub small' + (b && sum && !missing && b >= sum ? ' err' : '')}>{bundleNote}</p>
          <div className="pay-row">
            <Switch on={d.credit} onChange={(v) => { setD({ ...d, credit: v }); setNote(null); }} label="Count backgrounds someone already bought toward the bundle" />
            <span className="pay-txt"><span>Count backgrounds someone already bought</span><span className="sub small">{d.credit ? 'Someone who owns a few backgrounds pays the bundle price minus what they paid for them.' : 'Everyone pays the full bundle price, whatever they already own.'}</span></span>
          </div>
        </div>
        <div className="pay-block">
          <b className="pay-h">3 · When a new background arrives</b>
          <p className="sub small">The bundle covers what was offered when someone bought it. Bundle owners can add each new background for a pro-rated amount.</p>
          <div role="group" aria-label="How the pro-rated amount is worked out" className="segs">
            <button className="seg" aria-pressed={d.rate === 'saving'} onClick={() => { setD({ ...d, rate: 'saving' }); setNote(null); }}>Bundle’s saving</button>
            <button className="seg" aria-pressed={d.rate === 'percent'} onClick={() => { setD({ ...d, rate: 'percent' }); setNote(null); }}>Set percentage off</button>
          </div>
          {d.rate === 'percent' && <div className="pay-line"><label><span className="sr">Percentage off for bundle owners</span><input className="in num" inputMode="numeric" value={pct} onChange={(ev) => { setPct(ev.target.value.replace(/\D/g, '').slice(0, 2)); setNote(null); }} /></label><span>% off each new background’s price</span></div>}
          <p className="sub small">{rateNote}</p>
        </div>
        <div className="pay-block">
          <b className="pay-h">4 · Switching a background off, or back on</b>
          <div className="dz-rule"><span className="k">Off</span><span className="pay-txt"><span>It stops being offered</span><span className="sub small">Hidden from people who don’t own it and left out of the bundle. Everyone who bought it, on its own or in a bundle, keeps using it.</span></span></div>
          <div className="dz-rule"><span className="k dz-hi">On</span><span className="pay-txt"><span>It comes back as a new background</span><span className="sub small">People who own it keep it. Bundle owners who don’t have it can add it at the pro-rated amount, and it joins the bundle for new buyers.</span></span></div>
        </div>
        <div className="pay-acts"><button className="pri" style={{ height: 44, fontSize: 14 }} onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save background prices'}</button><span className="sub small">Anyone who already unlocked a background keeps it. New prices apply to new purchases.</span></div>
      </section>
      <div className="pay-side">
        <section className="g card" aria-label="Niko Pro">
          <span className="k">Niko Pro · add-on</span>
          <p className="sub">One add-on on top of someone’s monthly or yearly plan. Its price is set once, under Designs → Niko Pro{proOn ? ` (${proLine})` : ', where it’s switched off now'}.</p>
          <div className="pay-row">
            <Switch on={d.pro} onChange={(v) => { setD({ ...d, pro: v }); setNote(null); }} label="Include backgrounds in Niko Pro" />
            <span className="pay-txt"><span>Include backgrounds in Niko Pro</span><span className="sub small">{d.pro ? 'People with Niko Pro get every background, new ones included.' : 'Niko Pro covers designs only. Backgrounds are bought on their own.'}</span></span>
          </div>
          <ul className="dz-list sub small">
            <li>Not offered during pay-once time. It appears once someone is on a monthly or yearly plan.</li>
            <li>Joins their plan’s Stripe subscription, so both renew and bill together.</li>
            <li>If the add-on or their plan ends: backgrounds bought once stay; the rest go back to Glow.</li>
          </ul>
        </section>
        <section className="g card" aria-label="What people see">
          <span className="k">What people see</span>
          <ol className="dz-see">{see.map((x) => <li key={x.name}><span className="pay-txt"><span>{x.name}</span><span className="sub small">{x.note}</span></span><b>{x.price}</b></li>)}</ol>
          <p className="sub small">To give one person a background with no payment, go to Users → the person → Backgrounds.</p>
        </section>
      </div>
    </div>
  </>;
}

/** One person's backgrounds in Users: what they own and how, and gifts. Only gifts can be taken back. */
function PersonBackgrounds({ id, isAdmin }: { id: string; isAdmin: boolean }) {
  const [r, setR] = useState<{ owned: { background: string; source: string }[]; bundle: string | null } | null>(null);
  const [give, setGive] = useState('');
  const [msg, setMsg] = useState('');
  const load = () => api<{ owned: { background: string; source: string }[]; bundle: string | null }>(`/admin/users/${id}/backgrounds`).then(setR).catch(() => setR({ owned: [], bundle: null }));
  useEffect(() => { setR(null); setMsg(''); void load(); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (isAdmin) return <div className="psec"><span className="k">Backgrounds</span><span className="sub small">Admins have every background.</span></div>;
  if (!r) return <div className="psec"><span className="k">Backgrounds</span><span className="sub small">Loading…</span></div>;
  const how: Record<string, string> = { single: 'Bought', bundle: 'In bundle', topup: 'Added later', gift: 'Given by you' };
  const owned = new Set(r.owned.map((o) => o.background));
  const left = BACKGROUNDS.filter((x) => x.id !== 'glow' && !owned.has(x.id));
  const act = async (p: Promise<unknown>) => { setMsg(''); try { await p; await load(); setGive(''); } catch (e) { setMsg((e as Error).message); } };
  return (
    <div className="psec"><span className="k">Backgrounds</span>
      <span className="sub small">{r.bundle ? `All backgrounds bundle since ${fmtDate(r.bundle)}` : 'Glow, plus anything included.'}</span>
      {r.owned.length > 0 && <ul className="recent">{r.owned.map((o) => <li key={o.background}><span>{backgroundInfo(o.background).name}</span><span className="sub small">{how[o.source] ?? o.source}{o.source === 'gift' && <> · <button className="lnk" style={{ padding: 0, minHeight: 0 }} onClick={() => act(api(`/admin/users/${id}/backgrounds/${o.background}`, { method: 'DELETE' }))}>Take back</button></>}</span></li>)}</ul>}
      {left.length > 0 && <div className="pay-line">
        <label><span className="sr">Background to give</span><select className="in sel" value={give} onChange={(e) => setGive(e.target.value)}><option value="">Choose a background</option>{left.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></label>
        <button className="bt" disabled={!give} onClick={() => act(api(`/admin/users/${id}/backgrounds`, { body: { background: give } }))}>Give</button>
      </div>}
      {msg && <span className="err small" role="alert">{msg}</span>}
    </div>
  );
}

function PersonPanel({ item, pay, onClose, onToggle, onPrices, onUnlock, onRemove, onRevoke, onNewCode, onAudit, onSetup, onCopy, copyFrom }: {
  item: Item; pay: PaymentSettings | null; onClose: () => void; onSetup: (t: SetupTarget, tab?: UsageKind | 'caps') => void;
  onCopy: (t: SetupTarget, fromId: string, fromName: string, fromWho: 'user' | 'invite') => void; copyFrom: { id: string; label: string; kind: 'user' | 'invite' }[]; onToggle: (u: UserRow) => void; onPrices: (u: UserRow) => void; onUnlock: (u: UserRow) => void;
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
        <EngineCard who="invite" id={item.id} name={item.email} onSetup={(tab) => onSetup({ who: 'invite', id: item.id, name: item.email }, tab)} onCopy={(fid, fname, fwho) => onCopy({ who: 'invite', id: item.id, name: item.email }, fid, fname, fwho)} copyFrom={copyFrom.filter((o) => o.id !== item.id)} />
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
      <EngineCard who="user" id={item.id} name={item.name || item.email} onSetup={(tab) => onSetup({ who: 'user', id: item.id, name: item.name || item.email }, tab)} onCopy={(fid, fname, fwho) => onCopy({ who: 'user', id: item.id, name: item.name || item.email }, fid, fname, fwho)} copyFrom={copyFrom.filter((o) => o.id !== item.id)} />
      {!unpaid && <PersonDesigns id={item.id} isAdmin={item.role === 'admin'} />}
      {!unpaid && <PersonBackgrounds id={item.id} isAdmin={item.role === 'admin'} />}
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
  const [setting, setSetting] = useState<{ target: SetupTarget; tab?: UsageKind | 'caps'; copy?: { from: string; draft: SetupDraft } | null } | null>(null);
  const [everyone, setEveryone] = useState<Item[]>([]);
  // Everyone (not only this page), for "Also give it to" and "Copy from…".
  useEffect(() => { api<ListReply>('/admin/users?per=100').then((r) => setEveryone(r.items)).catch(() => undefined); }, [data]);
  const giveTo = everyone.map((i) => ({ id: i.id, kind: i.kind, label: i.kind === 'user' ? i.name || i.email : `${i.email} (invited)` }));
  const copyFrom = everyone.filter((i) => i.engineSetup?.keys).map((i) => ({ id: i.id, kind: i.kind, label: i.kind === 'user' ? i.name || i.email : `${i.email} (invited)` }));
  const copySetup = async (target: SetupTarget, fromId: string, fromName: string, fromWho: 'user' | 'invite') => {
    try {
      const r = await api<SetupReply>(`/admin/setup/${fromWho}/${fromId}`);
      setSetting({ target, copy: { from: fromName, draft: { keys: r.setup.keys, order: r.setup.order, builtins: r.builtins, limits: r.limits } } });
    } catch (e) { guard(e); }
  };
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
    {selItem && <PersonPanel item={selItem} pay={pay} onClose={close} onToggle={toggle} onPrices={setPricing} onUnlock={setUnlocking} onRemove={remove} onRevoke={revoke} onNewCode={newCode} onAudit={onAudit} onSetup={(target, tab) => setSetting({ target, tab })} onCopy={copySetup} copyFrom={copyFrom} />}
    {setting && <SetupSheet target={setting.target} startTab={setting.tab} copy={setting.copy} others={giveTo.filter((o) => o.id !== setting.target.id)} onClose={() => setSetting(null)} onSaved={async (text) => { setSetting(null); await after(text); }} />}
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
  const [tab, setTab] = useState<'users' | 'payments' | 'designs' | 'backgrounds' | 'ai' | 'keys' | 'glance' | 'limits' | 'knowledge' | 'data' | 'security' | 'audit'>('users');
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
          <button className="nv" aria-current={tab === 'designs' ? 'page' : undefined} onClick={() => setTab('designs')}>Designs</button>
          <button className="nv" aria-current={tab === 'backgrounds' ? 'page' : undefined} onClick={() => setTab('backgrounds')}>Backgrounds</button>
          <button className="nv" aria-current={tab === 'ai' ? 'page' : undefined} onClick={() => setTab('ai')}>AI options</button>
          <button className="nv" aria-current={tab === 'keys' ? 'page' : undefined} onClick={() => setTab('keys')}>Included keys</button>
          <button className="nv" aria-current={tab === 'glance' ? 'page' : undefined} onClick={() => setTab('glance')}>New items</button>
          <button className="nv" aria-current={tab === 'limits' ? 'page' : undefined} onClick={() => setTab('limits')}>Limits</button>
          <button className="nv" aria-current={tab === 'knowledge' ? 'page' : undefined} onClick={() => setTab('knowledge')}>Knowledge</button>
          <button className="nv" aria-current={tab === 'data' ? 'page' : undefined} onClick={() => setTab('data')}>Data sources</button>
          <button className="nv" aria-current={tab === 'security' ? 'page' : undefined} onClick={() => setTab('security')}>Security</button>
          <button className="nv" aria-current={tab === 'audit' ? 'page' : undefined} onClick={() => { setAuditFor(null); setTab('audit'); }}>Audit log</button>
        </nav>
        <div className="who"><span className="sub" style={{ fontSize: 13 }}>Signed in as {me?.name || me?.email || '…'}</span><button className="nv line" onClick={signOut}>Sign out</button></div>
      </aside>
      <main key={tab} className="hud-in">
        {tab === 'users' ? <PeopleTab onSignedOut={onSignedOut} onOpenPayments={() => setTab('payments')} onAudit={(id) => { setAuditFor(id); setTab('audit'); }} />
 : tab === 'payments' ? <PaymentsAdmin guard={guard} /> : tab === 'designs' ? <DesignsAdmin guard={guard} /> : tab === 'backgrounds' ? <BackgroundsAdmin guard={guard} /> : tab === 'ai' ? <AiOptions guard={guard} /> : tab === 'keys' ? <KeysLibrary guard={guard} /> : tab === 'glance' ? <GlanceAdmin guard={guard} /> : tab === 'limits' ? <LimitsAdmin guard={guard} /> : tab === 'knowledge' ? <KnowledgeAdmin guard={guard} /> : tab === 'data' ? <DataSourcesAdmin guard={guard} /> : tab === 'security' ? <>
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
