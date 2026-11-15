// Settings: one area with a shared sidebar (Appearance, Voice, Connections, Engine, Account) and a way back to Niko.
import { startRegistration } from '@simplewebauthn/browser';
import { passkeyError } from '../passkeyError';
import { KOKORO_DOWNLOAD_MB, kokoroDownload, kokoroReady, kokoroRemove, kokoroSpeak, kokoroSpeed, kokoroSupported, kokoroTooSlow } from '../kokoro';
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { aiProviderOf, brainOrder, MAX_AI_KEYS, type AiKeyInfo, type BrainEntry, type BrainRest } from '@niko/shared';
import { checkAppKey, COLOURS, GROUPS, KOKORO_VOICES, VOICE_NAMES, VOICE_SOURCES, voiceOrder, WORKERS_VOICES, type VoiceSource, type AppDef, type Appearance as Look, type EnginePrefs, type Permissions, type ProviderDef, type ProviderField } from '@niko/shared';
import { api, Field, Icon, setAppearance, Switch } from '@niko/ui';
import { useNiko } from '../niko';

function useMedia(q: string) {
  const [on, setOn] = useState(() => typeof window !== 'undefined' && window.matchMedia(q).matches);
  useEffect(() => { const m = window.matchMedia(q); const f = () => setOn(m.matches); m.addEventListener('change', f); return () => m.removeEventListener('change', f); }, [q]);
  return on;
}

type Prov = ProviderDef & { linked: boolean; configured: boolean; label: string | null; values?: Record<string, string> | null; readsGroups?: boolean | null };
type MyApp = AppDef & { configured: boolean; hint: string | null; uses: string[]; eventsUrl: string | null };
type Note = { ok: boolean; text: string } | null;

// ---------------------------------------------------------------- shell
const SETTINGS: [string, string, string][] = [['/appearance', 'Appearance', 'palette'], ['/voice', 'Voice', 'wave'], ['/connections', 'Connections', 'plug'], ['/engine', 'Engine', 'spark'], ['/account', 'Account', 'user']];

/** Route layout: the sidebar stays put while the page beside it changes. */
export function SettingsLayout() {
  const { me, refreshMe } = useNiko();
  const nav = useNavigate();
  const { pathname } = useLocation();
  const signOut = async () => { await api('/auth/sign-out', { method: 'POST' }); await refreshMe(); nav('/sign-in', { replace: true }); };
  return (
    <div className="set">
      <aside className="set-side">
        <Link to="/" className="set-back"><span aria-hidden="true">←</span> Back to Niko</Link>
        <div className="set-brand"><span className="wordmark">NIKO</span><span className="k pill">Settings</span></div>
        <nav aria-label="Settings sections" className="set-nav">
          {SETTINGS.map(([to, name]) => <NavLink key={to} to={to} className="nv">{name}</NavLink>)}
        </nav>
        <div className="set-foot">
          <span>Signed in as {me?.name || me?.email}</span>
          <button className="nv line" onClick={signOut}>Sign out</button>
        </div>
      </aside>
      <main key={pathname} className="set-main"><Outlet /></main>
    </div>
  );
}

function SettingsPage({ title, sub, action, children }: { title: string; sub: string; action?: ReactNode; children: ReactNode }) {
  return (
    <>
      <header className="set-head">
        <div><h1>{title}</h1><p>{sub}</p></div>
        {action}
      </header>
      {children}
    </>
  );
}

function NoteLine({ note }: { note: Note }) {
  return note ? <p className={note.ok ? 'ok' : 'err'} role="status">{note.text}</p> : null;
}

/** Which connections are linked (the Engine and Voice pages need the ones Connections does not list). */
/** What is linked, and the saved settings that are not secret (addresses, models, voices), so forms reopen as saved. */
function useLinks() {
  const [linked, setLinked] = useState<Record<string, boolean>>({});
  const [values, setValues] = useState<Record<string, Record<string, string>>>({});
  const [ready, setReady] = useState(false);
  const load = useCallback(() => api<{ providers: Prov[] }>('/connections?all=1').then((r) => {
    setLinked(Object.fromEntries(r.providers.map((p) => [p.id, p.linked])));
    setValues(Object.fromEntries(r.providers.filter((p) => p.linked && p.values).map((p) => [p.id, p.values!])));
    setReady(true);
  }).catch(() => undefined), []);
  useEffect(() => { void load(); }, [load]);
  return { linked, values, ready, reload: load };
}

// ---------------------------------------------------------------- connections
// The services Niko reads and sends through. The AI brain and the voice are not here: they live under Engine and Voice.
export function Connections() {
  const { me, refreshMe } = useNiko();
  const phone = useMedia('(max-width: 760px)');
  const [tab, setTab] = useState('mail');
  const [list, setList] = useState<Prov[]>([]);
  const [note, setNote] = useState<Note>(null);
  const [form, setForm] = useState<Prov | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [shown, setShown] = useState<{ inboundUrl: string; signingSecret: string } | null>(null);
  const dlg = useRef<HTMLDialogElement>(null);
  const [params, setParams] = useSearchParams();
  const [apps, setApps] = useState<MyApp[]>([]);
  const [redirects, setRedirects] = useState<string[]>([]);
  const [appForm, setAppForm] = useState<{ app: MyApp; then: Prov | null } | null>(null);
  const [confirmRemove, setConfirmRemove] = useState('');
  const appDlg = useRef<HTMLDialogElement>(null);
  const [manage, setManage] = useState<Prov | null>(null);
  const manageDlg = useRef<HTMLDialogElement>(null);

  const load = useCallback(() => api<{ providers: Prov[]; apps: MyApp[]; redirectUrls: string[] }>('/connections')
    .then((r) => { setList(r.providers.filter((p) => p.group !== 'ai')); setApps(r.apps); setRedirects(r.redirectUrls); return r; })
    .catch((e) => { setNote({ ok: false, text: e.message }); return null; }), []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const ok = params.get('linked'), bad = params.get('failed');
    if (ok !== null) setNote({ ok: true, text: 'Linked.' });
    if (bad !== null) setNote({ ok: false, text: 'That sign-in did not complete. Nothing was linked.' });
    if (ok !== null || bad !== null) setParams({}, { replace: true });
  }, [params, setParams]);

  const appOf = (p: Prov) => apps.find((a) => a.id === p.app);
  const act = (p: Prov) => {
    setNote(null);
    if (p.linked) { setConfirmRemove(''); setManage(p); manageDlg.current?.showModal(); return; }
    if (p.kind === 'planned') return setNote({ ok: false, text: `${p.name} is not available yet.` });
    if (p.kind === 'oauth') {
      // First time: the keys of your own app for this provider, then the provider's sign-in. One dialog, one place.
      const mine = appOf(p);
      if (mine && !mine.configured) return openApp(mine, p);
      return signIn(p);
    }
    setValues({}); setShown(null); setForm(p); dlg.current?.showModal();
  };
  const signIn = async (p: Prov) => {
    try { const r = await api<{ url: string }>(`/connections/${p.id}/oauth`); location.href = r.url; } catch (e: any) { setNote({ ok: false, text: e.message }); }
  };
  const openApp = (app: MyApp, then: Prov | null) => { manageDlg.current?.close(); setNote(null); setValues({}); setConfirmRemove(''); setAppForm({ app, then }); appDlg.current?.showModal(); };
  // Errors stay inside the sheet (thrown back to it), so nothing typed is lost.
  const saveApp = async (keys: Record<string, string>) => {
    if (!appForm) return;
    const { app, then } = appForm;
    await api(`/apps/${app.id}`, { method: 'PUT', body: keys });
    appDlg.current?.close();
    if (then) return signIn(then);
    await load();
    setNote({ ok: true, text: `Your ${app.name} app keys are saved. Connect ${app.uses.join(', ')} again to sign in with them.` });
  };
  const removeApp = async (app: MyApp) => {
    appDlg.current?.close();
    await api(`/apps/${app.id}`, { method: 'DELETE' }).catch((e) => setNote({ ok: false, text: e.message }));
    await load();
    setNote({ ok: true, text: `Your ${app.name} app keys and the links made with them were removed.` });
  };
  const unlink = async (p: Prov) => {
    manageDlg.current?.close();
    await api(`/connections/${p.id}`, { method: 'DELETE' }).catch((e) => setNote({ ok: false, text: e.message }));
    await load();
    setNote({ ok: true, text: `${p.name} removed. Its stored credentials were deleted.` });
  };
  const refreshTelegram = async () => {
    try {
      const r = await api<{ readsGroups: boolean }>('/connections/telegram-bot/refresh', { method: 'POST' });
      const fresh = await load();
      const p = fresh?.providers.find((x) => x.id === 'telegram-bot');
      if (p) setManage(p);
      setNote({ ok: true, text: r.readsGroups ? 'Checked. The bot can read group messages.' : 'Checked. Group privacy is still on.' });
    } catch (x: any) { setNote({ ok: false, text: x.message }); }
  };
  // Errors stay inside the sheet, so nothing typed is lost; mail and calendar links are checked before saving.
  const [formErr, setFormErr] = useState('');
  const [formBusy, setFormBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!form || formBusy) return;
    setFormErr(''); setFormBusy(true);
    try {
      const r = await api<{ inboundUrl?: string; signingSecret?: string; readsGroups?: boolean }>(`/connections/${form.id}`, { body: values });
      setValues({});
      if (form.id === 'telegram-bot' || form.id === 'telegram-user') await refreshMe();
      await load();
      if (r.inboundUrl && r.signingSecret) setShown({ inboundUrl: r.inboundUrl, signingSecret: r.signingSecret });
      else { dlg.current?.close(); setNote({ ok: true, text: `${form.name} linked.` }); }
    } catch (x: any) { setFormErr(x.message ?? 'That did not work.'); } finally { setFormBusy(false); }
  };
  const perm = me?.permissions ?? { draft: true, chatReply: true, files: true };
  const setPerm = async (p: Partial<Permissions>) => { await api('/me', { method: 'PATCH', body: { permissions: p } }); await refreshMe(); };
  const linked = list.filter((p) => p.linked).length;

  const rowFor = (p: Prov) => (
    <div key={p.id} className="row">
      <span className={'dot' + (p.linked ? ' on' : '')} />
      <span className="txt"><b>{p.name}</b><span className="sub">{p.label ?? p.how}</span></span>
      {p.kind === 'planned' ? <span className="k later">Later</span>
        : <button className={'bt' + (p.linked ? '' : ' fill')} onClick={() => act(p)}>{p.linked ? 'Manage' : 'Connect'}</button>}
    </div>
  );
  const panel = (id: string) => {
    const g = GROUPS.find((x) => x.id === id)!;
    return (
      <section key={id} className="g panel" aria-label={g.name}>
        <header><h2>{g.name}</h2><span className="sub">{g.note}</span></header>
        {list.filter((p) => p.group === id).map(rowFor)}
      </section>
    );
  };
  const permRows = <>
    <div className="row"><span className="txt"><b>Draft replies and invites</b><span className="sub">Prepared for you to review</span></span><Switch on={perm.draft} onChange={(v) => setPerm({ draft: v })} label="Draft replies and invites" /></div>
    <div className="row"><span className="txt"><b>Reply in chat apps</b><span className="sub">Telegram, Slack and Discord</span></span><Switch on={perm.chatReply} onChange={(v) => setPerm({ chatReply: v })} label="Reply in chat apps" /></div>
    <div className="row"><span className="txt"><b>Send and receive images and files</b><span className="sub">Passed straight through, never stored. Only name, size and time are logged.</span></span><Switch on={perm.files} onChange={(v) => setPerm({ files: v })} label="Send and receive images and files" /></div>
    <div className="row"><span className="txt"><b>Send only after I approve</b><span className="sub">Replies: voice with a 10-second countdown. The rest: a tap.</span></span><span className="k later">Locked</span></div>
  </>;
  const groups = GROUPS.filter((g) => g.id !== 'ai');
  const manageApp = manage ? appOf(manage) : undefined;

  return (
    <SettingsPage title="Connections" sub="The accounts Niko reads and sends through. Each link asks only for the access it needs."
      action={<div className="conn-count"><span className="accent">{linked}</span><span className="k">of {list.length} linked</span></div>}>
      <NoteLine note={note} />
      {phone ? <>
        <div role="group" aria-label="Connection type" className="cph-tabs">
          {groups.map((g) => <button key={g.id} aria-pressed={tab === g.id} onClick={() => setTab(g.id)}>{g.name}</button>)}
        </div>
        <section className="g cph-list" aria-label="Connections of this type">{list.filter((p) => p.group === tab).map(rowFor)}</section>
        <section className="g cph-list perms" aria-label="What Niko may do">{permRows}</section>
      </> : (
        <div className="cols conn">
          <div className="stack">
            {panel('mail')}
            <section className="g panel" aria-label="What Niko may do"><header><h2>What Niko may do</h2></header>{permRows}</section>
          </div>
          <div className="stack">{panel('calendar')}{panel('notes')}</div>
          <div className="stack">{panel('automation')}{panel('messaging')}</div>
        </div>
      )}

      <dialog ref={manageDlg} className="sheet" onClose={() => setManage(null)}>
        {manage && (
          <form method="dialog">
            <h2 style={{ fontWeight: 500, fontSize: 24 }}>{manage.name}</h2>
            <p className="sub">{manage.label ? `Linked as ${manage.label}. ` : 'Linked. '}{manage.can.read || manage.can.send ? [manage.can.read && 'Niko can read it', manage.can.send && 'send after your approval'].filter(Boolean).join(' and ') + '.' : 'Saved, but Niko does not use it yet.'}</p>
            {manage.id === 'telegram-bot' && (
              <div className={'tg-note' + (manage.readsGroups ? ' ok' : '')}>
                {manage.readsGroups
                  ? <p>Group chats appear in your inbox as soon as the bot is added to a group or someone writes there. A bot cannot see messages from before it joined.</p>
                  : <p><b>Group privacy is on</b>, so in groups the bot only receives messages that mention it or reply to it. To see the whole group: in Telegram, open <b>@BotFather</b> → <b>/setprivacy</b> → choose your bot → <b>Disable</b>. Then remove the bot from the group and add it again, and press Check again.</p>}
                <button type="button" className="bt" onClick={refreshTelegram}>Check again</button>
              </div>
            )}
            <p className="sub">Removing it deletes its stored credentials straight away.</p>
            <div className="sheet-actions">
              <button className="sec">Close</button>
              {manageApp && <button type="button" className="sec" onClick={() => openApp(manageApp, null)}>Change app keys</button>}
              <button type="button" className="pri" onClick={() => unlink(manage)}>Remove</button>
            </div>
          </form>
        )}
      </dialog>

      <dialog ref={appDlg} className="sheet wide" onClose={() => setAppForm(null)}>
        {appForm && (
          <AppKeysForm key={appForm.app.id} app={appForm.app} then={appForm.then} redirects={redirects}
            onSave={saveApp} onCancel={() => appDlg.current?.close()}
            onRemove={() => (confirmRemove === appForm.app.id ? removeApp(appForm.app) : setConfirmRemove(appForm.app.id))} confirmingRemove={confirmRemove === appForm.app.id} />
        )}
      </dialog>

      <dialog ref={dlg} className={'sheet' + (form?.steps ? ' wide' : '')} onClose={() => { setForm(null); setFormErr(''); }}>
        {form && !shown && (
          <form onSubmit={submit}>
            <h2 style={{ fontWeight: 500, fontSize: 24 }}>Connect {form.name}</h2>
            <p className="sub">{form.how}. Stored encrypted; you can remove it at any time.</p>
            {form.id === 'telegram-bot' && <p className="sub">Tip: so the bot can read whole group chats, turn off its group privacy first: @BotFather → /setprivacy → your bot → Disable.</p>}
            {form.steps && (
              <ol className="steps">
                {form.steps.map((s, i) => (
                  <li key={i}><span className="n" aria-hidden="true">{i + 1}</span><div className="step"><p>{s.text}</p>{s.link && <a className="bt step-link" href={s.link} target="_blank" rel="noopener noreferrer">{s.linkLabel ?? 'Open'} <Icon name="external" size={16} /></a>}</div></li>
                ))}
              </ol>
            )}
            {form.fields?.map((f) => (
              <Field key={f.key} label={f.label + (f.optional ? ' · optional' : '')}><input className="in" type={f.type === 'password' ? 'password' : f.type === 'url' ? 'url' : f.key === 'email' || f.placeholder?.includes('@') ? 'email' : 'text'} autoComplete="off" spellCheck={false} placeholder={f.placeholder} value={values[f.key] ?? ''} onChange={(e) => { setFormErr(''); setValues({ ...values, [f.key]: e.target.value }); }} /></Field>
            ))}
            {formErr && <p className="err" role="alert">{formErr}</p>}
            <div className="sheet-actions"><button type="button" className="sec" onClick={() => dlg.current?.close()}>Cancel</button><button className="pri" disabled={formBusy}>{formBusy ? 'Checking…' : 'Connect'}</button></div>
          </form>
        )}
        {shown && (
          <form method="dialog">
            <h2 style={{ fontWeight: 500, fontSize: 24 }}>Linked</h2>
            <p className="sub">To let this tool send events to Niko, post JSON to the address below and sign the body (HMAC-SHA256, hex) in an <code>x-niko-signature</code> header. The secret is shown only this once.</p>
            <Field label="Niko address"><input className="in" readOnly value={shown.inboundUrl} /></Field>
            <Field label="Signing secret"><input className="in" readOnly value={shown.signingSecret} /></Field>
            <button className="pri">Done</button>
          </form>
        )}
      </dialog>
    </SettingsPage>
  );
}

// ---------------------------------------------------------------- one account's own provider app (Google, Microsoft, Notion, Slack)
/** Reads Google's downloaded client file in the browser; only the two values in it are ever sent, on Save. */
function readGoogleFile(text: string, redirects: string[]): { keys?: Record<string, string>; error?: string; warn?: string } {
  let j: any;
  try { j = JSON.parse(text); } catch { return { error: 'That file is not the JSON file Google downloads.' }; }
  if (j?.installed) return { error: 'That key is for a desktop app. Create a client of type Web application instead.' };
  const w = j?.web;
  if (!w?.client_id || !w?.client_secret) return { error: 'That file has no client ID and secret in it. Use Download JSON on the screen shown right after creating the client.' };
  const listed: string[] = Array.isArray(w.redirect_uris) ? w.redirect_uris : [];
  const missing = redirects.filter((r) => !listed.includes(r));
  return { keys: { clientId: String(w.client_id), clientSecret: String(w.client_secret) }, warn: missing.length ? `The client does not list ${missing.length === 1 ? 'this address' : 'these addresses'} yet: ${missing.join(', ')}. Add ${missing.length === 1 ? 'it' : 'them'} under Authorised redirect URIs in Google Cloud, or signing in from there will fail.` : undefined };
}

function CopyRow({ value }: { value: string }) {
  const [done, setDone] = useState(false);
  const copy = async () => { try { await navigator.clipboard.writeText(value); setDone(true); window.setTimeout(() => setDone(false), 1500); } catch { /* the field stays selectable */ } };
  // Shown in full (it wraps), so it can be checked by eye on a phone too; a tap selects it all.
  return <div className="copy-row"><code className="addr">{value}</code><button type="button" className="bt" onClick={copy} aria-label={`Copy ${value}`}>{done ? 'Copied' : 'Copy'}</button></div>;
}

function AppKeysForm({ app, then, redirects, onSave, onCancel, onRemove, confirmingRemove }: {
  app: MyApp; then: Prov | null; redirects: string[]; onSave: (keys: Record<string, string>) => Promise<void>; onCancel: () => void; onRemove: () => void; confirmingRemove: boolean;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [err, setErr] = useState('');
  const [warn, setWarn] = useState('');
  const [fileName, setFileName] = useState('');
  const [busy, setBusy] = useState(false);
  const [drag, setDrag] = useState(false);
  // Changing keys later does not need the whole walk-through again.
  const [steps, setSteps] = useState(!app.configured);
  const [more, setMore] = useState(false);
  const useFile = async (f: File | undefined) => {
    setErr(''); setWarn('');
    if (!f) return;
    if (f.size > 20_000) return setErr('That file is too large to be Google’s client file.');
    const r = readGoogleFile(await f.text(), redirects);
    if (r.error) return setErr(r.error);
    setValues((v) => ({ ...v, ...r.keys })); setFileName(f.name); setWarn(r.warn ?? '');
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setErr('');
    const keys = Object.fromEntries(Object.entries(values).map(([k, v]) => [k, v.trim()]).filter(([, v]) => v));
    for (const f of app.fields) {
      const v = keys[f.key];
      if (!v && !f.optional && !app.configured) return setErr(`${f.label} is needed.`);
      const wrong = v ? checkAppKey(app.id, f.key, v) : null;
      if (wrong) return setErr(wrong);
    }
    setBusy(true);
    try { await onSave(keys); } catch (x: any) { setErr(x.message ?? 'That did not save.'); } finally { setBusy(false); }
  };
  const field = (f: ProviderField) => (
    <Field key={f.key} label={f.label + (f.optional ? ' · optional' : '')}>
      <input className="in" type={f.type === 'password' ? 'password' : 'text'} autoComplete="off" spellCheck={false}
        placeholder={app.configured ? 'Saved · type to replace' : f.placeholder} value={values[f.key] ?? ''}
        onChange={(e) => { setFileName(''); setErr(''); setValues({ ...values, [f.key]: e.target.value }); }} />
    </Field>
  );
  return (
    <form onSubmit={submit} className="app-keys">
      <h2 style={{ fontWeight: 500, fontSize: 24 }}>{then ? `Connect ${then.name}` : `Your ${app.name} app keys`}</h2>
      <p className="sub">{then ? 'First time only. ' : ''}Niko signs in to {app.uses.join(', ')} through an app you register yourself, so your data never passes through anyone else’s. {app.where}</p>
      {app.steps && !steps && <button type="button" className="lnk" style={{ alignSelf: 'flex-start' }} onClick={() => setSteps(true)}>Show the setup steps</button>}
      {app.steps && steps ? (
        <ol className="steps">
          {app.steps.map((s, i) => (
            <li key={i}>
              <span className="n" aria-hidden="true">{i + 1}</span>
              <div className="step">
                <p>{s.text}</p>
                {s.link && <a className="bt step-link" href={s.link} target="_blank" rel="noopener noreferrer">{s.linkLabel ?? 'Open'} <Icon name="external" size={16} /></a>}
                {s.redirects && redirects.map((r) => <CopyRow key={r} value={r} />)}
              </div>
            </li>
          ))}
        </ol>
      ) : !app.steps && <>{redirects.map((r) => <CopyRow key={r} value={r} />)}</>}
      {!app.steps && app.eventsUrl && <Field label="Event request address (to receive messages)"><input className="in mono" readOnly value={app.eventsUrl} onFocus={(e) => e.currentTarget.select()} /></Field>}
      {app.file === 'google-json' && (
        <label className={'drop' + (drag ? ' over' : '') + (fileName ? ' done' : '')}
          onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)}
          onDrop={(e) => { e.preventDefault(); setDrag(false); void useFile(e.dataTransfer.files[0]); }}>
          <input type="file" accept=".json,application/json" onChange={(e) => { void useFile(e.target.files?.[0]); e.target.value = ''; }} />
          <Icon name={fileName ? 'check' : 'file'} size={22} />
          <span>{fileName ? <><b>Keys read from {fileName}</b><span className="sub">Only the client ID and secret are kept, when you press Save.</span></> : <><b>Drop the downloaded JSON file here</b><span className="sub">or tap to choose it. It is read on this device.</span></>}</span>
        </label>
      )}
      {app.file === 'google-json' && !fileName && <span className="k or">Or paste them</span>}
      {(!app.file || !fileName) && app.fields.filter((f) => !f.advanced).map(field)}
      {app.fields.some((f) => f.advanced) && (more ? app.fields.filter((f) => f.advanced).map((f) => <div key={f.key}>{field(f)}<p className="hint">{f.advanced}</p></div>)
        : <button type="button" className="lnk" style={{ alignSelf: 'flex-start' }} onClick={() => setMore(true)}>Only for one organisation’s accounts?</button>)}
      {warn && <p className="warn" role="status">{warn}</p>}
      {err && <p className="err" role="alert">{err}</p>}
      <p className="sub">Stored encrypted and never shown again.{app.configured ? ' Saving new keys removes the links made with the old ones.' : ''}</p>
      <div className="sheet-actions"><button type="button" className="sec" onClick={onCancel}>Cancel</button><button className="pri" disabled={busy}>{busy ? 'Saving…' : then ? 'Save and sign in' : 'Save'}</button></div>
      {app.configured && <button type="button" className="lnk" style={{ alignSelf: 'flex-start' }} onClick={onRemove}>{confirmingRemove ? `Confirm: remove your ${app.name} keys and the links made with them` : `Remove your ${app.name} app keys`}</button>}
    </form>
  );
}

// ---------------------------------------------------------------- engine (the brain)
const AI_BASES: Record<AiKeyInfo['provider'], string> = { openai: 'https://api.openai.com/v1', anthropic: 'https://api.anthropic.com/v1', google: 'https://generativelanguage.googleapis.com/v1beta/openai' };
const PROVIDER_LABEL: Record<AiKeyInfo['provider'], string> = { openai: 'OpenAI-compatible', anthropic: 'Anthropic', google: 'Google' };
/** A key being added or changed on this page. `id` is the saved key's id, or a temporary "new-…" one. */
type KeyDraft = { id: string; label: string; provider: AiKeyInfo['provider']; baseUrl: string; model: string; apiKey: string; saved: boolean };
const isNew = (id: string) => id.startsWith('new-');
const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const day = (ms: number) => (new Date(ms).toDateString() === new Date().toDateString() ? clock(ms) : `${new Date(ms).toLocaleDateString([], { weekday: 'short' })} ${clock(ms)}`);
/** Why a brain is being skipped right now, in words. */
function restLine(r: BrainRest | undefined): string {
  if (!r || r.until <= Date.now()) return '';
  if (r.why === 'limit') return `Usage limit reached. Niko is using the next one, and tries this again at ${day(r.until)}.`;
  if (r.why === 'refused') return `It refused the last request. Check its key and model; Niko tries it again at ${day(r.until)}.`;
  return `It did not answer just now. Niko is using the next one, and tries this again at ${day(r.until)}.`;
}

export function Engine() {
  const { me, refreshMe } = useNiko();
  const { linked, values, ready, reload } = useLinks();
  const [e, setE] = useState<EnginePrefs | null>(null);
  const [order, setOrder] = useState<BrainEntry[]>([]);
  const [keys, setKeys] = useState<KeyDraft[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [self, setSelf] = useState({ baseUrl: '', model: '' });
  const [note, setNote] = useState<Note>(null);
  const [busy, setBusy] = useState('');
  const [dirty, setDirty] = useState<Record<string, boolean>>({});
  const [confirm, setConfirm] = useState('');
  const loadKeys = useCallback(async () => {
    const r = await api<{ keys: AiKeyInfo[] }>('/engine/keys');
    setKeys((cur) => [...(r.keys ?? []).map((k) => ({ ...k, apiKey: '', saved: true })), ...cur.filter((k) => isNew(k.id))]);
  }, []);
  useEffect(() => { if (me && !e) { setE({ model: 'fast', ...me.engine }); setOrder(brainOrder(me.engine)); void loadKeys(); } }, [me, e, loadKeys]);
  // Reopen with what was saved. Keys are never sent back.
  useEffect(() => {
    if (!ready) return;
    const s = values['self-hosted-ai'];
    if (s && !dirty.self) setSelf({ baseUrl: s.baseUrl ?? '', model: s.model ?? '' });
  }, [ready, values]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!me || !e) return null;
  const set = (p: Partial<EnginePrefs>) => setE({ ...e, ...p });
  const editSelf = (p: Partial<typeof self>) => { setDirty((d) => ({ ...d, self: true })); setSelf({ ...self, ...p }); };
  const editKey = (id: string, p: Partial<KeyDraft>) => { setDirty((d) => ({ ...d, [id]: true })); setKeys(keys.map((k) => (k.id === id ? { ...k, ...p } : k))); };
  const keyOf = (b: BrainEntry) => keys.find((k) => `key:${k.id}` === b);
  // Every saved or new key, plus Workers AI and the model server, is either in the order or listed as not in use.
  const all: BrainEntry[] = ['workers-ai', 'self-hosted-ai', ...keys.map((k) => `key:${k.id}` as BrainEntry)];
  const others = all.filter((b) => !order.includes(b));
  const toggle = (b: BrainEntry, on: boolean) => { setOrder(on ? [...order, b] : order.filter((x) => x !== b)); if (on) setOpen(b); };
  const move = (b: BrainEntry, by: -1 | 1) => {
    const i = order.indexOf(b), j = i + by;
    if (i < 0 || j < 0 || j >= order.length) return;
    const next = [...order]; [next[i], next[j]] = [next[j]!, next[i]!]; setOrder(next);
  };
  const addKey = () => {
    const id = 'new-' + Math.random().toString(36).slice(2, 8);
    setKeys([...keys, { id, label: '', provider: 'openai', baseUrl: AI_BASES.openai, model: '', apiKey: '', saved: false }]);
    setOrder([...order, `key:${id}`]); setOpen(`key:${id}`); setDirty((d) => ({ ...d, [id]: true }));
  };
  const removeKey = async (k: KeyDraft) => {
    if (confirm !== k.id) { setConfirm(k.id); return; }
    setConfirm(''); setNote(null);
    try {
      if (!isNew(k.id)) await api(`/engine/keys/${encodeURIComponent(k.id)}`, { method: 'DELETE' });
      setKeys(keys.filter((x) => x.id !== k.id)); setOrder(order.filter((x) => x !== `key:${k.id}`));
      if (!isNew(k.id)) { await refreshMe(); setNote({ ok: true, text: 'Key removed.' }); }
    } catch (x: any) { setNote({ ok: false, text: x.message }); }
  };

  const save = async () => {
    setNote(null); setBusy('save');
    try {
      if (!order.length) throw new Error('Switch on at least one brain.');
      // New and changed keys are saved first; a new key's temporary id becomes its saved one.
      let next = [...order];
      const kept: KeyDraft[] = [], savedIds = new Set<string>();
      for (const k of keys) {
        if (!dirty[k.id]) { kept.push(k); continue; }
        if (isNew(k.id) && !k.apiKey.trim()) { if (next.includes(`key:${k.id}`)) throw new Error(`Paste the API key for ${k.label || PROVIDER_LABEL[k.provider]}, or remove it.`); kept.push(k); continue; }
        const r = await api<{ key: AiKeyInfo }>('/engine/keys', { body: { id: isNew(k.id) ? undefined : k.id, label: k.label, baseUrl: k.baseUrl, model: k.model, apiKey: k.apiKey } });
        next = next.map((b) => (b === `key:${k.id}` ? `key:${r.key.id}` as BrainEntry : b));
        kept.push({ ...r.key, apiKey: '', saved: true }); savedIds.add(k.id);
      }
      // Saved keys are kept in the page at once, so a problem further on never saves them twice.
      setKeys(kept); setOrder(next);
      setDirty((d) => Object.fromEntries(Object.entries(d).filter(([k]) => !savedIds.has(k))));
      if (dirty.self && self.baseUrl.trim()) await api('/connections/self-hosted-ai', { body: { baseUrl: self.baseUrl, model: self.model } });
      if (next.includes('self-hosted-ai') && !linked['self-hosted-ai'] && !self.baseUrl.trim()) throw new Error('Add your model server’s address, or switch it off.');
      await api('/me', { method: 'PATCH', body: { engine: { brains: next, model: e.model } } });
      setDirty({});
      setOpen((o) => (o && isNew(o.slice(4)) ? null : o));
      await Promise.all([refreshMe(), reload()]);
      setNote({ ok: true, text: 'Saved.' });
    } catch (x: any) { setNote({ ok: false, text: x.message }); } finally { setBusy(''); }
  };
  const test = async (b: BrainEntry) => {
    setNote(null); setBusy('test-' + b);
    try { const r = await api<{ ms: number }>('/engine/test', { body: { entry: b, model: e.model } }); setNote({ ok: true, text: `Connected. It answered in ${(r.ms / 1000).toFixed(1)} s.` }); await refreshMe(); }
    catch (x: any) { setNote({ ok: false, text: x.message }); } finally { setBusy(''); }
  };
  const testBtn = (b: BrainEntry, saved: boolean) => (
    <button type="button" className="bt" onClick={() => test(b)} disabled={!!busy || !saved || !!dirty[b.startsWith('key:') ? b.slice(4) : b === 'self-hosted-ai' ? 'self' : '']} title={saved ? undefined : 'Save first'}>{busy === 'test-' + b ? 'Testing…' : 'Test'}</button>
  );

  const name = (b: BrainEntry) => (b === 'workers-ai' ? 'Cloudflare Workers AI' : b === 'self-hosted-ai' ? 'Your model server' : (keyOf(b)?.label || PROVIDER_LABEL[keyOf(b)?.provider ?? 'openai']));
  const sub = (b: BrainEntry) => {
    if (b === 'workers-ai') return 'Open models on Cloudflare’s network. Free up to a daily limit, shared with the Cloudflare voice.';
    if (b === 'self-hosted-ai') return 'A model server you run, such as on a NAS, at a public https address.';
    const k = keyOf(b);
    return k ? [PROVIDER_LABEL[k.provider], k.model || 'model not set'].join(' · ') + (k.saved ? '' : ' · not saved yet') : '';
  };
  const tag = (b: BrainEntry) => (b === 'workers-ai' ? 'Free tier' : b === 'self-hosted-ai' ? 'Your server' : 'Your key');

  const settings = (b: BrainEntry) => {
    if (b === 'workers-ai') return (
      <div className="eng-fields">
        <label className="fld"><span className="k">Model</span><select className="in" value={e.model ?? 'fast'} onChange={(x) => set({ model: x.target.value === 'large' ? 'large' : 'fast' })}><option value="fast">Recommended · fast chat model</option><option value="large">Larger · slower, better reasoning</option></select></label>
        {testBtn(b, true)}
      </div>
    );
    if (b === 'self-hosted-ai') return (
      <div className="eng-fields col">
        <div className="eng-fields">
          <label className="fld"><span className="k">Server address</span><input className="in" type="url" placeholder="https://" value={self.baseUrl} onChange={(x) => editSelf({ baseUrl: x.target.value })} /></label>
          <label className="fld"><span className="k">Model name · optional</span><input className="in" type="text" value={self.model} onChange={(x) => editSelf({ model: x.target.value })} /></label>
          {testBtn(b, !!linked['self-hosted-ai'])}
        </div>
        <p className="hint">Any server with an OpenAI-compatible chat API, such as Ollama or LM Studio. It needs a public https address; Cloudflare Tunnel is a free way to give one to a NAS.</p>
      </div>
    );
    const k = keyOf(b);
    if (!k) return null;
    return (
      <div className="eng-fields col">
        <div className="eng-fields">
          <label className="fld"><span className="k">Provider</span><select className="in" value={k.provider} onChange={(x) => { const p = x.target.value as AiKeyInfo['provider']; editKey(k.id, { provider: p, baseUrl: AI_BASES[p] }); }}><option value="openai">OpenAI-compatible</option><option value="anthropic">Anthropic</option><option value="google">Google</option></select></label>
          <label className="fld"><span className="k">Name · optional</span><input className="in" type="text" maxLength={40} placeholder="Work OpenAI, Spare Gemini…" value={k.label} onChange={(x) => editKey(k.id, { label: x.target.value })} /></label>
        </div>
        <div className="eng-fields">
          <label className="fld"><span className="k">Model name</span><input className="in" type="text" placeholder="As listed by your provider" value={k.model} onChange={(x) => editKey(k.id, { model: x.target.value })} /></label>
          <label className="fld"><span className="k">Base URL</span><input className="in" type="url" placeholder="https://" value={k.baseUrl} onChange={(x) => editKey(k.id, { baseUrl: x.target.value, provider: aiProviderOf(x.target.value) })} /></label>
        </div>
        <div className="eng-fields">
          <label className="fld"><span className="k">API key</span><input className="in" type="password" autoComplete="off" placeholder={k.saved ? 'Saved · type to replace' : 'Paste key'} value={k.apiKey} onChange={(x) => editKey(k.id, { apiKey: x.target.value })} /></label>
          {testBtn(b, k.saved)}
          <button type="button" className={'bt' + (confirm === k.id ? ' danger' : '')} onClick={() => removeKey(k)} onBlur={() => confirm === k.id && setConfirm('')}>{confirm === k.id ? 'Tap again to remove' : 'Remove'}</button>
        </div>
      </div>
    );
  };
  const row = (b: BrainEntry, i: number | null) => {
    const on = i !== null, resting = on ? restLine(me.engine.rest?.[b]) : '';
    return (
      <li key={b} className={'vrow' + (on ? ' on' : '')}>
        <div className="vrow-head">
          <span className="n" aria-hidden="true">{on ? i + 1 : '–'}</span>
          <button type="button" className="vrow-title" aria-expanded={open === b} onClick={() => setOpen(open === b ? null : b)}>
            <b>{name(b)}</b><span className="sub">{sub(b)}</span>
            {resting && <span className="sub vrow-warn">{resting}</span>}
          </button>
          <span className="k tag">{tag(b)}</span>
          {on && <span className="vrow-move">
            <button type="button" className="stp" onClick={() => move(b, -1)} disabled={i === 0} aria-label={`Move ${name(b)} up`}>↑</button>
            <button type="button" className="stp" onClick={() => move(b, 1)} disabled={i === order.length - 1} aria-label={`Move ${name(b)} down`}>↓</button>
          </span>}
          <Switch on={on} onChange={(x) => toggle(b, x)} label={`Use ${name(b)}`} />
        </div>
        {open === b && <div className="vrow-body">{settings(b)}</div>}
      </li>
    );
  };
  return (
    <SettingsPage title="Engine" sub="What Niko thinks with. You can change it at any time." action={<button className="pri set-save" onClick={save} disabled={busy === 'save'}>{busy === 'save' ? 'Saving…' : 'Save changes'}</button>}>
      <NoteLine note={note} />
      <section className="g eng-card wide" aria-label="Brain">
        <span className="k" style={{ paddingBottom: 6 }}>Brain · tried in this order</span>
        <p className="hint" style={{ paddingBottom: 8 }}>Niko answers with the first one that works. When one reaches its usage limit, refuses its key or stops answering, Niko moves to the next straight away, and goes back to it once its limit has reset.</p>
        <ol className="vlist">{order.map((b, i) => row(b, i))}</ol>
        <button type="button" className="bt add-key" onClick={addKey} disabled={keys.length >= MAX_AI_KEYS}><Icon name="plus" size={18} />Add an AI key</button>
        {others.length > 0 && <>
          <span className="k" style={{ padding: '18px 0 6px' }}>Not in use</span>
          <ul className="vlist">{others.map((b) => row(b, null))}</ul>
        </>}
      </section>
      <p className="g eng-keys"><Icon name="shield" size={20} />Keys are encrypted on the server, never stored in this browser, and never shown again after saving. Several keys from the same provider and account share one usage limit, so a second key helps most when it is from another account or provider. The voice is set under Voice.</p>
    </SettingsPage>
  );
}

// ---------------------------------------------------------------- voice (speech out, speech in)
type Src = VoiceSource;
const VOICE_INFO: Record<Src, { sub: string; tag: string }> = {
  workers: { sub: 'Made on Cloudflare, where Niko runs. Nothing to set up.', tag: 'Free' },
  kokoro: { sub: 'A natural voice made on this device. Private, and works offline once downloaded.', tag: 'Free' },
  'self-hosted': { sub: 'A speech server you run, such as on a NAS. Can use a cloned voice.', tag: 'Your server' },
  elevenlabs: { sub: 'Natural speech and your ElevenLabs voices. Needs a paid ElevenLabs plan.', tag: 'Paid plan' },
};
const PREVIEW_LINE = (name: string) => `Hi ${name || 'there'}, this is how I sound.`;

export function Voice() {
  const { me, refreshMe } = useNiko();
  const { linked, values, ready, reload } = useLinks();
  const [e, setE] = useState<EnginePrefs | null>(null);
  const [order, setOrder] = useState<Src[]>([]);
  const [open, setOpen] = useState<Src | null>(null);
  const [el, setEl] = useState({ apiKey: '', voiceId: '' });
  const [sh, setSh] = useState({ baseUrl: '', voice: '', model: '', apiKey: '' });
  const [voices, setVoices] = useState<{ id: string; name: string; cloned: boolean }[]>([]);
  const [note, setNote] = useState<Note>(null);
  const [busy, setBusy] = useState('');
  const [dirty, setDirty] = useState({ el: false, sh: false });
  const [kReady, setKReady] = useState(kokoroReady());
  const [kProgress, setKProgress] = useState<number | null>(null);
  const playing = useRef<{ stop: () => void } | null>(null);
  useEffect(() => { if (me && !e) { setE({ ...me.engine }); setOrder(voiceOrder(me.engine)); } }, [me, e]);
  useEffect(() => () => playing.current?.stop(), []);
  const listVoices = useCallback(async (apiKey?: string) => {
    try {
      const r = await api<{ voices: { id: string; name: string; cloned: boolean }[] }>('/voice/voices', { body: { apiKey: apiKey || undefined } });
      const list = Array.isArray(r.voices) ? r.voices : [];
      setVoices(list);
      // Keep the chosen voice; pick one only if none is chosen or it no longer exists in the account.
      setEl((v) => (!list[0] || list.some((x) => x.id === v.voiceId) ? v : { ...v, voiceId: (list.find((x) => x.cloned) ?? list[0])!.id }));
    } catch (x: any) { setNote({ ok: false, text: x.message }); }
  }, []);
  // Saved settings are shown again, so the page reopens as it was left.
  useEffect(() => {
    if (!ready) return;
    if (values.elevenlabs?.voiceId && !dirty.el) setEl((v) => ({ ...v, voiceId: values.elevenlabs!.voiceId! }));
    const s = values['self-hosted-voice'];
    if (s && !dirty.sh) setSh((v) => ({ ...v, baseUrl: s.baseUrl ?? '', voice: s.voice ?? '', model: s.model ?? '' }));
  }, [ready, values]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (ready && linked.elevenlabs) void listVoices(); }, [ready, linked.elevenlabs, listVoices]);
  if (!me || !e) return null;
  const set = (p: Partial<EnginePrefs>) => setE({ ...e, ...p });
  const editEl = (p: Partial<typeof el>) => { setDirty((d) => ({ ...d, el: true })); setEl({ ...el, ...p }); };
  const editSh = (p: Partial<typeof sh>) => { setDirty((d) => ({ ...d, sh: true })); setSh({ ...sh, ...p }); };
  const others = VOICE_SOURCES.filter((v) => !order.includes(v));
  const toggle = (v: Src, on: boolean) => { setOrder(on ? [...order, v] : order.filter((x) => x !== v)); if (on) setOpen(v); };
  const move = (v: Src, by: -1 | 1) => {
    const i = order.indexOf(v), j = i + by;
    if (i < 0 || j < 0 || j >= order.length) return;
    const next = [...order]; [next[i], next[j]] = [next[j]!, next[i]!]; setOrder(next);
  };

  const save = async () => {
    setNote(null); setBusy('save');
    try {
      if (dirty.el && (el.apiKey.trim() || linked.elevenlabs)) await api('/connections/elevenlabs', { body: { apiKey: el.apiKey, voiceId: el.voiceId } });
      if (dirty.sh && sh.baseUrl.trim()) await api('/connections/self-hosted-voice', { body: sh });
      if (order.includes('elevenlabs') && !linked.elevenlabs && !el.apiKey.trim()) throw new Error('Add your ElevenLabs API key, or switch ElevenLabs off.');
      if (order.includes('self-hosted') && !linked['self-hosted-voice'] && !sh.baseUrl.trim()) throw new Error('Add your voice server’s address, or switch it off.');
      await api('/me', { method: 'PATCH', body: { engine: { voices: order, workersVoice: e.workersVoice ?? 'melo', kokoroVoice: e.kokoroVoice ?? 'af_heart', wake: e.wake } } });
      await Promise.all([refreshMe(), reload()]);
      setEl((v) => ({ ...v, apiKey: '' })); setSh((v) => ({ ...v, apiKey: '' })); setDirty({ el: false, sh: false });
      setNote({ ok: true, text: order.includes('kokoro') && !kReady ? 'Saved. The on-device voice is skipped on this device until it is downloaded here.' : 'Saved.' });
    } catch (x: any) { setNote({ ok: false, text: x.message }); } finally { setBusy(''); }
  };

  // Preview plays the voice as set on this page, saved or not.
  const preview = async (v: Src | 'device') => {
    setNote(null); playing.current?.stop(); playing.current = null;
    const line = PREVIEW_LINE(me.name);
    if (v === 'device') { window.speechSynthesis?.cancel(); window.speechSynthesis?.speak(new SpeechSynthesisUtterance(line)); return; }
    setBusy('preview-' + v);
    try {
      if (v === 'kokoro') {
        const s = kokoroSpeak(line, e.kokoroVoice ?? 'af_heart'); playing.current = s;
        await s.started; await s.done; return;
      }
      const body: Record<string, unknown> = { text: line, source: v };
      if (v === 'workers') body.workersVoice = e.workersVoice ?? 'melo';
      if (v === 'elevenlabs') Object.assign(body, { apiKey: el.apiKey || undefined, voiceId: el.voiceId || undefined });
      if (v === 'self-hosted') Object.assign(body, { baseUrl: sh.baseUrl || undefined, voice: sh.voice || undefined, model: sh.model || undefined, apiKey: sh.apiKey || undefined });
      const res = await fetch('/api/voice/tts', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? 'That voice could not speak.');
      const url = URL.createObjectURL(await res.blob()); const a = new Audio(url);
      playing.current = { stop: () => { a.pause(); URL.revokeObjectURL(url); } };
      a.onended = () => URL.revokeObjectURL(url); await a.play();
    } catch (x: any) { if (x?.message !== 'stopped') setNote({ ok: false, text: x.message }); } finally { setBusy(''); }
  };
  const download = async () => {
    setNote(null); setKProgress(0);
    try { await kokoroDownload((p) => setKProgress(p)); setKReady(true); setNote({ ok: true, text: 'The on-device voice is ready on this device.' }); }
    catch (x: any) { setNote({ ok: false, text: x.message }); } finally { setKProgress(null); }
  };
  const removeKokoro = async () => { await kokoroRemove(); setKReady(false); setNote({ ok: true, text: 'Removed the on-device voice from this device.' }); };
  const previewBtn = (v: Src | 'device', disabled = false) => <button type="button" className="bt" onClick={() => preview(v)} disabled={!!busy || disabled}>{busy === 'preview-' + v ? 'Playing…' : 'Preview'}</button>;

  const settings = (v: Src) => {
    if (v === 'workers') return (
      <div className="eng-fields col">
        <div className="eng-fields">
          <label className="fld"><span className="k">Voice</span>
            <select className="in" value={e.workersVoice ?? 'melo'} onChange={(x) => set({ workersVoice: x.target.value })}>
              {WORKERS_VOICES.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
            </select>
          </label>
          {previewBtn('workers')}
        </div>
        <p className="hint">Standard can speak for hours a day. Natural voices sound better but use far more of Cloudflare’s free daily allowance, about 30 replies, shared with the Workers AI brain. When it runs out, the next voice in your list is used until midnight UTC.</p>
      </div>
    );
    if (v === 'kokoro') return (
      <div className="eng-fields col">
        {!kokoroSupported() ? <p className="hint">This browser cannot run the on-device voice.</p> : <>
          <div className="eng-fields">
            <label className="fld"><span className="k">Voice</span>
              <select className="in" value={e.kokoroVoice ?? 'af_heart'} onChange={(x) => set({ kokoroVoice: x.target.value })}>
                {KOKORO_VOICES.map((k) => <option key={k.id} value={k.id}>{k.name}</option>)}
              </select>
            </label>
            {previewBtn('kokoro', !kReady)}
          </div>
          {kProgress !== null ? (
            <div className="dl" role="progressbar" aria-label="Downloading the on-device voice" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(kProgress * 100)}>
              <span className="dl-bar"><i style={{ width: `${Math.round(kProgress * 100)}%` }} /></span><span className="k">{kProgress < 1 ? `${Math.round(kProgress * 100)}%` : 'Preparing…'}</span>
            </div>
          ) : kReady ? (
            <>
              <div className="eng-line"><span><b className="ok-dot" aria-hidden="true" />Ready on this device</span><button type="button" className="lnk" onClick={removeKokoro}>Remove from this device</button></div>
              {kokoroSpeed() && (kokoroTooSlow()
                ? <p className="hint vrow-warn">This device makes speech more slowly than it plays ({kokoroSpeed()!.rtf}× real time), so Niko uses the next voice in your list instead. It is measured each time the app opens.</p>
                : <p className="hint">This device keeps up comfortably ({kokoroSpeed()!.rtf}× real time{kokoroSpeed()!.threads > 1 ? `, ${kokoroSpeed()!.threads} cores` : ''}). The engine starts in the background each time the app opens; until it has, Niko uses the next voice.</p>)}
            </>
          ) : (
            <button type="button" className="bt fill" style={{ alignSelf: 'flex-start' }} onClick={download}>Download to this device · about {KOKORO_DOWNLOAD_MB} MB</button>
          )}
          <p className="hint">Downloaded once on each device, from the model’s official source, and checked before use. What Niko says never leaves the device. Quick on laptops; slower, and harder on the battery, on phones. Until it is downloaded on a device, Niko skips it there.</p>
        </>}
      </div>
    );
    if (v === 'self-hosted') return (
      <div className="eng-fields col">
        <label className="fld"><span className="k">Server address</span><input className="in" type="url" placeholder="https://voice.example.com/v1" value={sh.baseUrl} onChange={(x) => editSh({ baseUrl: x.target.value })} /></label>
        <div className="eng-fields">
          <label className="fld"><span className="k">Voice name</span><input className="in" type="text" placeholder="af_heart, or your cloned voice" value={sh.voice} onChange={(x) => editSh({ voice: x.target.value })} /></label>
          <label className="fld"><span className="k">Model · optional</span><input className="in" type="text" placeholder="tts-1" value={sh.model} onChange={(x) => editSh({ model: x.target.value })} /></label>
        </div>
        <div className="eng-fields">
          <label className="fld"><span className="k">API key · optional</span><input className="in" type="password" autoComplete="off" placeholder={linked['self-hosted-voice'] ? 'Saved · type to replace' : 'Only if your server asks for one'} value={sh.apiKey} onChange={(x) => editSh({ apiKey: x.target.value })} /></label>
          {previewBtn('self-hosted', !sh.baseUrl && !linked['self-hosted-voice'])}
        </div>
        <p className="hint">Any server with an OpenAI-compatible speech API works, such as Kokoro-FastAPI, or Chatterbox TTS Server, which can clone a voice from a few seconds of recording. It needs a public https address; Cloudflare Tunnel is a free way to give one to a NAS.</p>
      </div>
    );
    return (
      <div className="eng-fields col">
        <label className="fld"><span className="k">ElevenLabs API key</span><input className="in" type="password" autoComplete="off" placeholder={linked.elevenlabs ? 'Saved · type to replace' : 'Paste key'} value={el.apiKey} onChange={(x) => editEl({ apiKey: x.target.value })} onBlur={() => el.apiKey.trim() && listVoices(el.apiKey)} /></label>
        <div className="eng-fields">
          <label className="fld"><span className="k">Voice</span>
            <select className="in" value={el.voiceId} onChange={(x) => editEl({ voiceId: x.target.value })} disabled={!voices.length}>
              {!voices.length && <option value="">Add your key to list your voices</option>}
              {voices.map((x) => <option key={x.id} value={x.id}>{x.cloned ? `${x.name} · your cloned voice` : x.name}</option>)}
            </select>
          </label>
          {previewBtn('elevenlabs', !el.apiKey && !linked.elevenlabs)}
        </div>
        <p className="hint">The key needs the Text to Speech and Voices permissions. ElevenLabs’ free plan refuses requests from cloud servers such as Niko’s, so a paid plan is needed.</p>
      </div>
    );
  };
  const row = (v: Src, i: number | null) => {
    const on = i !== null;
    return (
      <li key={v} className={'vrow' + (on ? ' on' : '')}>
        <div className="vrow-head">
          <span className="n" aria-hidden="true">{on ? i + 1 : '–'}</span>
          <button type="button" className="vrow-title" aria-expanded={open === v} onClick={() => setOpen(open === v ? null : v)}>
            <b>{VOICE_NAMES[v]}</b><span className="sub">{VOICE_INFO[v].sub}</span>
            {v === 'kokoro' && on && !kReady && kokoroSupported() && <span className="sub vrow-warn">Not downloaded on this device yet, so Niko skips it here.</span>}
            {v === 'kokoro' && on && kReady && kokoroTooSlow() && <span className="sub vrow-warn">Too slow on this device to keep up while speaking, so Niko skips it here.</span>}
            {v === 'kokoro' && !kokoroSupported() && <span className="sub vrow-warn">This browser cannot run it.</span>}
          </button>
          <span className="k tag">{VOICE_INFO[v].tag}</span>
          {on && <span className="vrow-move">
            <button type="button" className="stp" onClick={() => move(v, -1)} disabled={i === 0} aria-label={`Move ${VOICE_NAMES[v]} up`}>↑</button>
            <button type="button" className="stp" onClick={() => move(v, 1)} disabled={i === order.length - 1} aria-label={`Move ${VOICE_NAMES[v]} down`}>↓</button>
          </span>}
          <Switch on={on} onChange={(x) => toggle(v, x)} label={`Use ${VOICE_NAMES[v]}`} />
        </div>
        {open === v && <div className="vrow-body">{settings(v)}</div>}
      </li>
    );
  };

  return (
    <SettingsPage title="Voice" sub="How Niko speaks to you, and how it listens." action={<button className="pri set-save" onClick={save} disabled={busy === 'save'}>{busy === 'save' ? 'Saving…' : 'Save changes'}</button>}>
      <NoteLine note={note} />
      <div className="eng-grid">
        <section className="g eng-card" aria-label="Speech out">
          <span className="k" style={{ paddingBottom: 6 }}>Speech out · tried in this order</span>
          <ol className="vlist">
            {order.map((v, i) => row(v, i))}
            <li className="vrow on last">
              <div className="vrow-head">
                <span className="n" aria-hidden="true">{order.length + 1}</span>
                <span className="vrow-title static"><b>{VOICE_NAMES.device}</b><span className="sub">Built into this device. Always last, so Niko can always speak.</span></span>
                <span className="k tag">Free</span>
                {previewBtn('device')}
              </div>
            </li>
          </ol>
          {others.length > 0 && <>
            <span className="k" style={{ padding: '18px 0 6px' }}>Not in use</span>
            <ul className="vlist">{others.map((v) => row(v, null))}</ul>
          </>}
        </section>
        <section className="g eng-card listen" aria-label="Listening">
          <span className="k">Listening · speech in</span>
          <label className="fld"><span className="hint">How your voice is turned into text</span><select className="in" value="device" onChange={() => undefined}><option value="device">Device speech recognition · free</option><option value="workers" disabled>Workers AI speech-to-text · not available yet</option></select></label>
          <div className="eng-line"><span>Wake when I say “Niko”</span><Switch on={!!e.wake} onChange={(x) => set({ wake: x })} label="Wake when I say Niko" /></div>
          <div className="eng-line"><span>After Niko answers, keep listening for a few seconds so you can carry on talking</span><span className="k later">On</span></div>
          <div className="eng-line"><span>Respond only to my voice <span className="k soon">Not available yet</span></span><Switch on={false} onChange={() => undefined} label="Respond only to my voice" disabled /></div>
        </section>
      </div>
    </SettingsPage>
  );
}

// ---------------------------------------------------------------- appearance and account
const hex = (h: number) => { const f = (n: number) => { const k = (n + h / 30) % 12, v = 0.72 - 0.9 * 0.28 * Math.max(-1, Math.min(k - 3, 9 - k, 1)); return ('0' + Math.round(v * 255).toString(16)).slice(-2); }; return ('#' + f(0) + f(8) + f(4)).toUpperCase(); };

const PREVIEW_STEP_MS = 2500;

export function Appearance() {
  const { me, refreshMe } = useNiko();
  const [a, setA] = useState<Look | null>(me?.appearance ?? null);
  const [saved, setSaved] = useState(false);
  const [tick, setTick] = useState(0);
  useEffect(() => { if (me && !a) setA(me.appearance); }, [me, a]);
  // The preview cycles faster than the app will, so every colour in the rotation shows within a few seconds.
  useEffect(() => { const t = window.setInterval(() => setTick((n) => n + 1), PREVIEW_STEP_MS); return () => window.clearInterval(t); }, []);
  if (!a) return null;
  const up = (p: Partial<Look>) => { setSaved(false); setA({ ...a, ...p }); };
  const names = [...Object.keys(COLOURS), 'custom'];
  const hueOf = (n: string) => (n === 'custom' ? a.customHue : COLOURS[n]!);
  const isOn = (n: string) => (a.mode === 'shift' ? a.colours.includes(n) : a.single === n);
  const pick = (n: string) => {
    if (a.mode === 'single') return up({ single: n });
    const next = a.colours.includes(n) ? a.colours.filter((x) => x !== n) : [...a.colours, n];
    if (next.length) up({ colours: next });
  };
  const custom = (h: number) => {
    const hue = ((Math.round(h) % 360) + 360) % 360;
    up(a.mode === 'shift' ? { customHue: hue, colours: a.colours.includes('custom') ? a.colours : [...a.colours, 'custom'] } : { customHue: hue, single: 'custom' });
  };
  const save = async () => { await api('/me', { method: 'PATCH', body: { appearance: a } }); await refreshMe(); setAppearance(a); setSaved(true); };
  const rotation = a.mode === 'shift' ? a.colours : [a.single];
  const ph = hueOf(rotation[tick % rotation.length] ?? 'cyan');
  return (
    <SettingsPage title="Appearance" sub="Your own background. The particles and accents follow it." action={<button className="pri set-save" onClick={save}>{saved ? 'Saved' : 'Save'}</button>}>
      <div className="set-grid">
        <section className="set-card" aria-label="Background settings">
          <div className="grp">
            <span className="k">Background</span>
            <div style={{ display: 'flex', gap: 10 }}>
              <button className="seg" aria-pressed={a.mode === 'shift'} onClick={() => up({ mode: 'shift' })}>Shift between colours</button>
              <button className="seg" aria-pressed={a.mode === 'single'} onClick={() => up({ mode: 'single' })}>One colour</button>
            </div>
          </div>
          <div className="grp" style={{ gap: 12 }}>
            <span className="k">{a.mode === 'shift' ? 'Colours in the rotation' : 'Colour'}</span>
            <div className="sw-row">
              {names.map((n) => (
                <button key={n} className="swatch" aria-pressed={isOn(n)} onClick={() => pick(n)}>
                  <i style={{ background: `hsl(${hueOf(n)},90%,72%)` }}>{isOn(n) && <Icon name="check" size={26} />}</i>{n[0]!.toUpperCase() + n.slice(1)}
                </button>
              ))}
            </div>
          </div>
          <div className="grp">
            <span className="k">Custom colour</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <button className="stp" onClick={() => custom(a.customHue - 10)} aria-label="Shift custom colour left">−</button>
              <button className="spectrum" aria-label="Pick a custom colour from the spectrum" onClick={(ev) => { const r = ev.currentTarget.getBoundingClientRect(); custom(Math.max(0, Math.min(0.999, (ev.clientX - r.left) / r.width)) * 360); }}><span style={{ left: `${a.customHue / 3.6}%` }} /></button>
              <button className="stp" onClick={() => custom(a.customHue + 10)} aria-label="Shift custom colour right">+</button>
              <span style={{ font: "500 14px 'JetBrains Mono', monospace", width: 78, textAlign: 'right' }}>{hex(a.customHue)}</span>
            </div>
          </div>
          {a.mode === 'shift' && (
            <div className="grp">
              <span className="k">Seconds on each colour</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <button className="stp" onClick={() => up({ seconds: Math.max(4, a.seconds - 1) })} aria-label="Fewer seconds">−</button>
                <span className="secs">{a.seconds} s</span>
                <button className="stp" onClick={() => up({ seconds: Math.min(30, a.seconds + 1) })} aria-label="More seconds">+</button>
              </div>
            </div>
          )}
          <p className="set-note">Saved to your account and used on all your devices. Other users keep their own colours.</p>
        </section>
        <section className="set-card" aria-label="Preview" style={{ gap: 14 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}><span className="k">Preview</span><span className="hint">{rotation.length > 1 ? 'Cycling faster than the app will' : 'One colour'}</span></div>
          <div className="pv fade" style={{ backgroundColor: `hsl(${ph},55%,6%)` }}>
            <div className="pv-glow fade" aria-hidden="true" style={{ backgroundColor: `hsl(${ph},80%,45%)` }} />
            <div className="pv-dots fade" aria-hidden="true" style={{ color: `hsl(${ph},100%,75%)` }} />
            <span className="pv-mark">NIKO</span>
            <div className="pv-cap"><span className="k fade" style={{ color: `hsl(${ph},100%,75%)` }}>Standing by</span><span>Say “Niko” to start.</span></div>
            <span className="pv-mic fade" aria-hidden="true" style={{ backgroundColor: `hsl(${ph},100%,75%)` }} />
          </div>
        </section>
      </div>
    </SettingsPage>
  );
}

export function Account() {
  const [keys, setKeys] = useState<{ id: string; label: string; rpId: string }[]>([]);
  const { me } = useNiko();
  const [rpId, setRpId] = useState('');
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const load = useCallback(() => api('/me/passkeys').then((r) => { setKeys(r.passkeys); setRpId(r.rpId); }).catch(() => undefined), []);
  useEffect(() => { void load(); }, [load]);
  const add = async () => {
    setNote(null);
    try {
      const { options, challengeId } = await api('/me/passkeys/options', { method: 'POST' });
      const response = await startRegistration({ optionsJSON: options });
      await api('/me/passkeys/verify', { body: { challengeId, response } });
      setNote({ ok: true, text: 'Passkey added. You can use it next time you sign in on this domain.' });
      await load();
    } catch (x: any) { setNote({ ok: false, text: passkeyError(x, true) }); }
  };
  return (
    <SettingsPage title="Account" sub="Your sign-in details and passkeys.">
      {note && <p className={note.ok ? 'ok' : 'err'} role="status">{note.text}</p>}
      <div className="set-grid">
        <section className="set-card" aria-label="You">
          <span className="k">You</span>
          <div className="row"><span className="txt"><b>{me?.name || 'No name set'}</b><span className="sub">{me?.email}</span></span><span className="k">{me?.role}</span></div>
        </section>
        <section className="set-card" aria-label="Passkeys">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}><span className="k">Passkeys</span><span className="hint">For signing in only</span></div>
          {keys.length === 0 && <p className="sub">No passkeys yet.</p>}
          {keys.map((k) => (
            <div key={k.id} className="row"><Icon name="key" /><span className="txt"><b>{k.label}</b><span className="sub">Works on {k.rpId}</span></span>
              <button className="bt" onClick={async () => { await api(`/me/passkeys/${k.id}`, { method: 'DELETE' }); await load(); }}>Remove</button></div>
          ))}
          <button className="pri" style={{ alignSelf: 'flex-start' }} onClick={add}><Icon name="key" size={20} />Add a passkey for {rpId || 'this domain'}</button>
          <p className="set-note">A passkey works on one domain only. Add one on each address you use Niko from.</p>
        </section>
      </div>
    </SettingsPage>
  );
}
