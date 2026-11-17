// Settings: one area with a shared sidebar (Appearance, Voice, Connections, Engine, Account) and a way back to Niko.
import { startRegistration } from '@simplewebauthn/browser';
import { BillingCard } from './Plan';
import { passkeyError } from '../passkeyError';
import { KOKORO_DOWNLOAD_MB, kokoroDownload, kokoroReady, kokoroRemove, kokoroSpeak, kokoroSpeed, kokoroSupported, kokoroTooSlow } from '../kokoro';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { AI_PRESETS, aiProviderOf, brainOrder, MAX_AI_KEYS, NOT_CHAT, presetOf, type AiKeyInfo, type BrainEntry, type BrainRest } from '@niko/shared';
import { designInfo, type CalendarLink } from '@niko/shared';
import { cleanGlancePrefs, GLANCE_LIMIT_DEFAULTS, GLANCE_PART_NAMES, GLANCE_PARTS, GLANCE_REMIND_STEPS, GLANCE_STEPS, glanceEvery, type GlancePart, type GlancePrefs } from '@niko/shared';
import { AI_OPTION_GROUPS, aiAllowed, brainOption, hearOption, imageOption, voiceOption } from '@niko/shared';
import { IMAGE_PROVIDERS, imageOrder, imagePresetOf, MAX_IMAGE_KEYS, type ImageKeyInfo, type ImageProvider, type ImageSource } from '@niko/shared';
import { HEAR_PROVIDERS, hearOrder, hearPresetOf, MAX_HEAR_KEYS, type HearKeyInfo, type HearProvider, type HearSource } from '@niko/shared';
import { checkAppKey, COLOURS, GROUPS, KOKORO_VOICES, MAX_VOICE_KEYS, PAGE_SIZES, VOICE_NAMES, VOICE_PROVIDERS, VOICE_SOURCES, voiceName, voiceOrder, voicePresetOf, WORKERS_VOICES, type VoiceKeyInfo, type VoiceProvider, type VoiceSource, type AppDef, type Appearance as Look, type EnginePrefs, type Permissions, type ProviderDef, type ProviderField } from '@niko/shared';
import { api, DesignPreview, Field, Icon, PasswordField, setAppearance, Switch } from '@niko/ui';
import { useNiko } from '../niko';
import { MapSettings, type MapLists } from './MapSettings';
import { ScreenLock } from './ScreenLock';
import { AccountInfo, IncludedCard, MonthLine, UsageLines, useUsage } from './Usage';
import { captureSupported, captureUtterance, transcribe, type Capture } from '../listen';

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
  // Each settings page opens at its top (the browser would otherwise keep the scroll of the page before), and on a
  // phone the section tabs slide so the open one is in view.
  const navRef = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    window.scrollTo(0, 0);
    for (const el of [document.scrollingElement, document.body, document.getElementById('root')]) if (el) el.scrollTop = 0;
    const bar = navRef.current, on = bar?.querySelector<HTMLElement>('.nv.active');
    if (bar && on && bar.scrollWidth > bar.clientWidth) bar.scrollTo({ left: bar.scrollLeft + on.getBoundingClientRect().left - bar.getBoundingClientRect().left - (bar.clientWidth - on.offsetWidth) / 2, behavior: 'smooth' });
  }, [pathname]);
  return (
    <div className="set">
      <aside className="set-side">
        <Link to="/" className="set-back"><span aria-hidden="true">←</span> Back to Niko</Link>
        <div className="set-brand"><span className="wordmark">NIKO</span><span className="k pill">Settings</span></div>
        <nav ref={navRef} aria-label="Settings sections" className="set-nav">
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
  const [cals, setCals] = useState<Prov | null>(null);
  const calDlg = useRef<HTMLDialogElement>(null);

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
    // Calendar links are a list: one sheet to add, change and remove them, linked or not.
    if (p.id === 'ical') { setCals(p); calDlg.current?.showModal(); return; }
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
    if (p.id === 'open-meteo') await refreshMe();
    setNote({ ok: true, text: p.id === 'open-meteo' ? 'Open-Meteo removed. Weather questions no longer send your location.' : `${p.name} removed. Its stored credentials were deleted.` });
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
      if (form.id === 'telegram-bot' || form.id === 'telegram-user' || form.id === 'open-meteo') await refreshMe();
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
          <div className="stack">{panel('automation')}{panel('messaging')}{panel('weather')}</div>
        </div>
      )}

      <dialog ref={manageDlg} className={'sheet' + (manage?.id === 'google-calendar' ? ' wide' : '')} onClose={() => setManage(null)}>
        {manage && (
          <form method="dialog">
            <h2 style={{ fontWeight: 500, fontSize: 24 }}>{manage.name}</h2>
            <p className="sub">{manage.label && manage.id !== 'google-calendar' ? `Linked as ${manage.label}. ` : 'Linked. '}{manage.can.read || manage.can.send ? [manage.can.read && 'Niko can read it', manage.can.send && 'send after your approval'].filter(Boolean).join(' and ') + '.' : 'Saved, but Niko does not use it yet.'}</p>
            {manage.id === 'telegram-bot' && (
              <div className={'tg-note' + (manage.readsGroups ? ' ok' : '')}>
                {manage.readsGroups
                  ? <p>Group chats appear in your inbox as soon as the bot is added to a group or someone writes there. A bot cannot see messages from before it joined.</p>
                  : <p><b>Group privacy is on</b>, so in groups the bot only receives messages that mention it or reply to it. To see the whole group: in Telegram, open <b>@BotFather</b> → <b>/setprivacy</b> → choose your bot → <b>Disable</b>. Then remove the bot from the group and add it again, and press Check again.</p>}
                <button type="button" className="bt" onClick={refreshTelegram}>Check again</button>
              </div>
            )}
            {manage.id === 'google-calendar' && <GoogleCalendars onChanged={() => void load()} />}
            <p className="sub">Removing it deletes its stored credentials straight away.</p>
            <div className="sheet-actions">
              <button className="sec">Close</button>
              {manageApp && <button type="button" className="sec" onClick={() => openApp(manageApp, null)}>Change app keys</button>}
              <button type="button" className="pri" onClick={() => unlink(manage)}>Remove</button>
            </div>
          </form>
        )}
      </dialog>

      <dialog ref={calDlg} className="sheet wide" onClose={() => setCals(null)}>
        {cals && <CalendarLinks prov={cals} onChanged={() => void load()} onClose={() => calDlg.current?.close()} />}
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

// ---------------------------------------------------------------- calendar links (iCal): a list to add, change and remove
// Each address is checked by reading it once before it is saved. A private address is never shown back in full: to
// change it, paste the new one (left blank, the saved one is kept).
const isCalendarId = (v: string) => /^[^\s/:?]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(v.trim());
const guessKind = (url: string): 'private' | 'public' | null => isCalendarId(url) ? 'public' : (/calendar\.google\.com\/calendar\/ical\/[^/]+\/public\//i.test(url) ? 'public' : /\/private-[^/]+\//i.test(url) ? 'private' : null);
function CalendarLinks({ prov, onChanged, onClose }: { prov: Prov; onChanged: () => void; onClose: () => void }) {
  type Reply = { calendars: CalendarLink[]; limit: number };
  const [list, setList] = useState<CalendarLink[] | null>(null);
  const [limit, setLimit] = useState(20);
  const [editing, setEditing] = useState<CalendarLink | 'new' | null>(null);
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [kind, setKind] = useState<'private' | 'public'>('private');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [sure, setSure] = useState(false);
  const [help, setHelp] = useState(false);
  const open = (c: CalendarLink | 'new') => {
    setErr(''); setSure(false); setUrl('');
    setName(c === 'new' ? '' : c.name); setKind(c === 'new' ? 'private' : c.kind);
    setEditing(c);
  };
  const take = (r: Reply) => { setList(r.calendars); setLimit(r.limit); onChanged(); };
  useEffect(() => {
    api<Reply>('/calendars').then((r) => { setList(r.calendars); setLimit(r.limit); if (!r.calendars.length) { open('new'); setHelp(true); } })
      .catch((e) => { setList([]); setErr(e.message); });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!editing || busy) return;
    setErr(''); setBusy(true);
    try {
      take(editing === 'new'
        ? await api<Reply>('/calendars', { body: { name, url, kind } })
        : await api<Reply>(`/calendars/${editing.id}`, { method: 'PATCH', body: { name, kind, ...(url.trim() ? { url } : {}) } }));
      setEditing(null);
    } catch (x: any) { setErr(x.message ?? 'That did not work.'); } finally { setBusy(false); }
  };
  const toggle = async (c: CalendarLink, on: boolean) => {
    setErr('');
    setList((l) => l?.map((x) => (x.id === c.id ? { ...x, on } : x)) ?? l);
    try { take(await api<Reply>(`/calendars/${c.id}`, { method: 'PATCH', body: { on } })); }
    catch (x: any) { setErr(x.message); setList((l) => l?.map((y) => (y.id === c.id ? { ...y, on: !on } : y)) ?? l); }
  };
  const remove = async () => {
    if (!editing || editing === 'new') return;
    if (!sure) return setSure(true);
    setBusy(true);
    try { take(await api<Reply>(`/calendars/${editing.id}`, { method: 'DELETE' })); setEditing(null); }
    catch (x: any) { setErr(x.message); } finally { setBusy(false); }
  };
  if (!list) return <form method="dialog"><h2 className="sheet-h">Calendar links</h2><p className="sub">Loading…</p></form>;
  const full = list.length >= limit;

  if (editing) {
    const isNew = editing === 'new';
    return (
      <form onSubmit={save} className="cal-form">
        <h2 className="sheet-h">{isNew ? 'Add a calendar' : `Edit “${editing.name}”`}</h2>
        {prov.steps && (isNew || help) && (
          <details className="cal-help" open={help} onToggle={(e) => setHelp((e.target as HTMLDetailsElement).open)}>
            <summary>Where to find the address</summary>
            <ol className="steps">
              {prov.steps.map((s, i) => (
                <li key={i}><span className="n" aria-hidden="true">{i + 1}</span><div className="step"><p>{s.text}</p>{s.link && <a className="bt step-link" href={s.link} target="_blank" rel="noopener noreferrer">{s.linkLabel ?? 'Open'} <Icon name="external" size={16} /></a>}</div></li>
              ))}
            </ol>
          </details>
        )}
        <Field label="Name"><input className="in" maxLength={40} autoComplete="off" placeholder="Work, Family, Public holidays…" value={name} onChange={(e) => { setErr(''); setName(e.target.value); }} /></Field>
        <Field label={isNew ? 'iCal address or Google calendar ID' : 'New iCal address or calendar ID · optional'}>
          <input className="in" type="text" inputMode="url" autoComplete="off" spellCheck={false} required={isNew}
            placeholder={isNew ? 'https://calendar.google.com/calendar/ical/…/basic.ics' : editing.address}
            value={url} onChange={(e) => { setErr(''); setUrl(e.target.value); const g = guessKind(e.target.value); if (g) setKind(g); }} />
        </Field>
        {isCalendarId(url) && <p className="sub cal-keep">A calendar ID works for public Google calendars. For a private one, paste its secret iCal address, or connect Google Calendar and switch it on there.</p>}
        {!isNew && <p className="sub cal-keep">{editing.kind === 'private' ? 'The saved address stays hidden. Leave this blank to keep it, or paste a new one to replace it.' : 'Leave this blank to keep the saved address.'}</p>}
        <div role="group" aria-label="Kind of calendar" className="cal-kind-pick">
          <button type="button" className="seg" aria-pressed={kind === 'private'} onClick={() => setKind('private')} disabled={isCalendarId(url)}>Private</button>
          <button type="button" className="seg" aria-pressed={kind === 'public'} onClick={() => setKind('public')}>Public</button>
        </div>
        <p className="sub cal-keep">{kind === 'private' ? 'A secret address: stored encrypted and never shown in full again.' : 'A calendar anyone can subscribe to (holidays, a school, a club). Its address is shown in full.'}</p>
        {err && <p className="err" role="alert">{err}</p>}
        <div className="sheet-actions">
          <button type="button" className="sec" onClick={() => (list.length ? setEditing(null) : onClose())}>{list.length ? 'Back' : 'Cancel'}</button>
          {!isNew && <button type="button" className={sure ? 'pri danger' : 'sec'} onClick={remove} disabled={busy}>{sure ? 'Yes, remove it' : 'Remove'}</button>}
          <button className="pri" disabled={busy}>{busy ? 'Checking…' : isNew ? 'Add' : 'Save'}</button>
        </div>
        {sure && !isNew && <p className="sub cal-keep" role="status">Removing “{editing.name}” deletes its saved address straight away.</p>}
      </form>
    );
  }

  return (
    <form method="dialog" className="cal-sheet">
      <div className="cal-top">
        <h2 className="sheet-h">Calendar links</h2>
        <span className="k cal-count">{list.length} of {limit}</span>
      </div>
      <p className="sub">Private and public iCal calendars, read-only. Switch one off to hide its events without removing it.</p>
      <div className="cal-list">
        {list.map((c) => (
          <div key={c.id} className={'cal-row' + (c.on ? '' : ' off')}>
            <b className="cal-name">{c.name}</b>
            <span className="cal-meta"><span className="cal-tag">{c.kind === 'private' ? 'Private' : 'Public'}</span><span className="cal-addr">{c.address}</span></span>
            <Switch on={c.on} onChange={(v) => toggle(c, v)} label={`Show ${c.name}`} />
            <button type="button" className="bt" onClick={() => open(c)} aria-label={`Edit ${c.name}`}>Edit</button>
          </div>
        ))}
      </div>
      {err && <p className="err" role="alert">{err}</p>}
      {full && <p className="sub cal-keep">{list.length > limit ? `Your account can keep ${limit}; only the first ${limit} switched on are read. Remove some to add others.` : `That’s the most your account can keep (${limit}). Remove one to add another.`}</p>}
      <div className="sheet-actions">
        <button className="sec">Done</button>
        <button type="button" className="pri" onClick={() => open('new')} disabled={full}>Add calendar</button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------- Google calendars: which ones Niko reads, after Google sign-in
function GoogleCalendars({ onChanged }: { onChanged: () => void }) {
  type GCal = { id: string; name: string; primary: boolean; role: string; on: boolean };
  type Reply = { calendars: GCal[]; limit: number };
  const [list, setList] = useState<GCal[] | null>(null);
  const [limit, setLimit] = useState(20);
  const [err, setErr] = useState('');
  useEffect(() => { api<Reply>('/google-calendars').then((r) => { setList(r.calendars); setLimit(r.limit); }).catch((e) => setErr(e.message)); }, []);
  const toggle = async (c: GCal, on: boolean) => {
    if (!list) return;
    setErr('');
    const next = list.map((x) => (x.id === c.id ? { ...x, on } : x));
    setList(next);
    try { const r = await api<Reply>('/google-calendars', { method: 'PUT', body: { on: next.filter((x) => x.on).map((x) => x.id) } }); setList((l) => l && l.map((x) => ({ ...x, on: !!r.calendars.find((y) => y.id === x.id)?.on }))); onChanged(); }
    catch (x: any) { setErr(x.message); setList(list); }
  };
  const count = list?.filter((x) => x.on).length ?? 0;
  return (
    <div className="gcal">
      <div className="cal-top"><span className="k">Calendars Niko reads</span>{list && <span className="k cal-count">{count} of {limit}</span>}</div>
      {!list && !err && <p className="sub">Asking Google…</p>}
      {list && (
        <div className="cal-list">
          {list.map((c) => (
            <div key={c.id} className={'cal-row' + (c.on ? '' : ' off')}>
              <b className="cal-name">{c.name}</b>
              <span className="cal-meta"><span className="cal-tag">{c.primary ? 'Main' : c.role}</span></span>
              <Switch on={c.on} onChange={(v) => toggle(c, v)} label={`Read ${c.name}`} disabled={!c.on && count >= limit} />
            </div>
          ))}
        </div>
      )}
      {list && !list.length && <p className="sub">Google lists no calendars on this account.</p>}
      {err && <p className="err" role="alert">{err}</p>}
      {list && <p className="sub cal-keep">Your own, shared and subscribed calendars on this Google account. “Busy times only” calendars show as Busy, without titles.</p>}
    </div>
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
type KeyDraft = { id: string; label: string; provider: AiKeyInfo['provider']; baseUrl: string; model: string; apiKey: string; saved: boolean; provided?: boolean };
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

/** Moves an entry among the ones shown; entries hidden by the admin keep their places in the saved order, so they
 * come back where they were when the admin turns them on again. */
function moveShown<T>(order: T[], shown: T[], v: T, by: -1 | 1): T[] {
  const i = shown.indexOf(v), j = i + by;
  if (i < 0 || j < 0 || j >= shown.length) return order;
  const a = order.indexOf(shown[i]!), b = order.indexOf(shown[j]!), next = [...order];
  [next[a], next[b]] = [next[b]!, next[a]!];
  return next;
}
/** Whether the admin has turned anything off in this group, for the small note under its list. */
const managedIn = (off: readonly string[], group: 'brain' | 'images' | 'maps' | 'voices' | 'hears') => { const g = AI_OPTION_GROUPS.find((x) => x.id === group)!; return g.items.some((i) => off.includes(i.key)); };
const MANAGED = 'Some options aren’t included in your plan.';

type ImageDraft = ImageKeyInfo & { apiKey: string; saved: boolean };
const imageInfo = (k: { provider: ImageProvider; baseUrl: string }) => IMAGE_PROVIDERS.find((p) => p.id === imagePresetOf(k))!;
const TEST_PICTURE = 'A small watercolour painting of a lighthouse on a cliff at dusk, soft light, calm sea.';
function imageRestLine(r: BrainRest | undefined): string {
  if (!r || r.until <= Date.now()) return '';
  if (r.why === 'limit') return `Usage limit reached. The next one paints, and this one is tried again at ${day(r.until)}.`;
  if (r.why === 'refused') return `It refused the last request. Check its key and model; it is tried again at ${day(r.until)}.`;
  return `It did not answer just now. The next one paints, and this one is tried again at ${day(r.until)}.`;
}

export function Engine() {
  const { me, refreshMe } = useNiko();
  const { usage, reload: reloadUsage } = useUsage();
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
  const [models, setModels] = useState<Record<string, { list: string[]; err: string; busy: boolean }>>({});
  // Pictures: Cloudflare and the user's image keys, in order.
  const [iOrder, setIOrder] = useState<ImageSource[]>([]);
  const [iKeys, setIKeys] = useState<ImageDraft[]>([]);
  const [iOpen, setIOpen] = useState<ImageSource | null>(null);
  const [sample, setSample] = useState<{ entry: ImageSource; url: string } | null>(null);
  const [iSelf, setISelf] = useState({ baseUrl: '', model: '', apiKey: '' });
  const mapLists = useRef<MapLists | null>(null);
  const loadKeys = useCallback(async () => {
    const r = await api<{ keys: AiKeyInfo[] }>('/engine/keys');
    setKeys((cur) => [...(r.keys ?? []).map((k) => ({ ...k, apiKey: '', saved: true })), ...cur.filter((k) => isNew(k.id))]);
  }, []);
  const loadImageKeys = useCallback(async () => {
    const r = await api<{ keys: ImageKeyInfo[] }>('/image/keys');
    setIKeys((cur) => [...(r.keys ?? []).map((k) => ({ ...k, apiKey: '', saved: true })), ...cur.filter((k) => isNew(k.id))]);
  }, []);
  useEffect(() => { if (me && !e) { setE({ model: 'fast', ...me.engine }); setOrder(brainOrder(me.engine)); setIOrder(imageOrder(me.engine)); void loadKeys(); void loadImageKeys(); } }, [me, e, loadKeys, loadImageKeys]);
  useEffect(() => () => { if (sample) URL.revokeObjectURL(sample.url); }, [sample]);
  // Reopen with what was saved. Keys are never sent back.
  useEffect(() => {
    if (!ready) return;
    const s = values['self-hosted-ai'];
    if (s && !dirty.self) setSelf({ baseUrl: s.baseUrl ?? '', model: s.model ?? '' });
    const si = values['self-hosted-image'];
    if (si && !dirty.iself) setISelf({ baseUrl: si.baseUrl ?? '', model: si.model ?? '', apiKey: '' });
  }, [ready, values]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!me || !e) return null;
  const set = (p: Partial<EnginePrefs>) => setE({ ...e, ...p });
  const editSelf = (p: Partial<typeof self>) => { setDirty((d) => ({ ...d, self: true })); setSelf({ ...self, ...p }); };
  const editKey = (id: string, p: Partial<KeyDraft>) => { setDirty((d) => ({ ...d, [id]: true })); setKeys(keys.map((k) => (k.id === id ? { ...k, ...p } : k))); };
  const keyOf = (b: BrainEntry) => keys.find((k) => `key:${k.id}` === b);
  // Options the admin has turned off for this account are not shown (and are kept in the saved order).
  const off = me.aiOff ?? [];
  const okBrain = (b: BrainEntry) => aiAllowed(off, brainOption(b, keyOf(b)?.baseUrl));
  const presets = AI_PRESETS.filter((p) => aiAllowed(off, `ai:${p.id}`));
  // Every saved or new key, plus Workers AI and the model server, is either in the order or listed as not in use.
  const all: BrainEntry[] = ['workers-ai', 'self-hosted-ai', ...keys.map((k) => `key:${k.id}` as BrainEntry)];
  const shown = order.filter(okBrain);
  const others = all.filter((b) => !order.includes(b) && okBrain(b));
  const toggle = (b: BrainEntry, on: boolean) => { setOrder(on ? [...order, b] : order.filter((x) => x !== b)); if (on) setOpen(b); };
  const move = (b: BrainEntry, by: -1 | 1) => setOrder(moveShown(order, shown, b, by));
  // Included services stay first when the plan says so; the person's own come after, in their order.
  const fixed = usage?.plan.order === 'fixed';
  const isProvided = (b: BrainEntry) => !!keyOf(b)?.provided;
  const canUp = (b: BrainEntry, i: number) => i > 0 && !(fixed && (isProvided(b) || isProvided(shown[i - 1]!)));
  const canDown = (b: BrainEntry, i: number) => i < shown.length - 1 && !(fixed && isProvided(b));
  // The provider's own list of chat models for a key: from the key being typed, or the saved one (with its saved address).
  const listModels = async (k: KeyDraft) => {
    if (!k.apiKey.trim() && !k.saved) return;
    setModels((m) => ({ ...m, [k.id]: { list: m[k.id]?.list ?? [], err: '', busy: true } }));
    try {
      const r = await api<{ models: string[] }>('/engine/models', { body: { id: isNew(k.id) ? undefined : k.id, baseUrl: k.baseUrl, apiKey: k.apiKey || undefined } });
      setModels((m) => ({ ...m, [k.id]: { list: r.models, err: r.models.length ? '' : 'No chat models were listed for this key.', busy: false } }));
    } catch (x: any) { setModels((m) => ({ ...m, [k.id]: { list: [], err: x.message, busy: false } })); }
  };
  const addKey = () => {
    const id = 'new-' + Math.random().toString(36).slice(2, 8);
    const p = presets[0];
    if (!p) return;
    setKeys([...keys, { id, label: '', provider: aiProviderOf(p.baseUrl), baseUrl: p.baseUrl, model: '', apiKey: '', saved: false }]);
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
      if (!order.filter(okBrain).length) throw new Error('Switch on at least one brain.');
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
      if (next.includes('self-hosted-ai') && okBrain('self-hosted-ai') && !linked['self-hosted-ai'] && !self.baseUrl.trim()) throw new Error('Add your model server’s address, or switch it off.');
      // Image keys, the same way.
      let iNext = [...iOrder];
      const iKept: ImageDraft[] = [], iSaved = new Set<string>();
      for (const k of iKeys) {
        if (!dirty['i:' + k.id]) { iKept.push(k); continue; }
        if (isNew(k.id) && !k.apiKey.trim()) { if (iNext.includes(`ikey:${k.id}`)) throw new Error(`Paste the API key for ${k.label || imageInfo(k).name} under Pictures, or remove it.`); iKept.push(k); continue; }
        const r = await api<{ key: ImageKeyInfo }>('/image/keys', { body: { ...k, id: isNew(k.id) ? undefined : k.id } });
        iNext = iNext.map((v) => (v === `ikey:${k.id}` ? `ikey:${r.key.id}` as ImageSource : v));
        iKept.push({ ...r.key, apiKey: '', saved: true }); iSaved.add('i:' + k.id);
      }
      setIKeys(iKept); setIOrder(iNext);
      setDirty((d) => Object.fromEntries(Object.entries(d).filter(([k]) => !iSaved.has(k))));
      if (dirty.iself && iSelf.baseUrl.trim()) await api('/connections/self-hosted-image', { body: iSelf });
      if (iNext.includes('self-hosted') && okImage('self-hosted') && !linked['self-hosted-image'] && !iSelf.baseUrl.trim()) throw new Error('Add your image server’s address, or switch it off.');
      const ml = mapLists.current;
      await api('/me', { method: 'PATCH', body: { engine: { brains: next, model: e.model, images: iNext, ...(ml?.dirty ? { maps: ml.maps, mapCountries: ml.mapCountries } : {}) } } });
      ml?.saved();
      setISelf((v) => ({ ...v, apiKey: '' }));
      setDirty({});
      setOpen((o) => (o && isNew(o.slice(4)) ? null : o));
      await Promise.all([refreshMe(), reload(), reloadUsage()]);
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
    return k ? [AI_PRESETS.find((x) => x.id === presetOf(k.baseUrl) && x.id !== 'other')?.name ?? PROVIDER_LABEL[k.provider], k.model || 'model not set'].join(' · ') + (k.saved ? '' : ' · not saved yet') : '';
  };
  const tag = (b: BrainEntry) => (b === 'workers-ai' ? 'Built in' : b === 'self-hosted-ai' ? 'Your server' : keyOf(b)?.provided ? 'Included' : 'Your key');

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
    if (k.provided) return (
      <div className="eng-fields col">
        <p className="hint">Included with your plan: there’s no key to manage. Switch it off if you’d rather Niko didn’t use it.</p>
        <div className="eng-fields">{testBtn(b, true)}</div>
      </div>
    );
    const preset = presetOf(k.baseUrl), ex = AI_PRESETS.find((x) => x.id === preset)?.example;
    const ml = models[k.id], notChat = !!k.model && NOT_CHAT.test(k.model);
    return (
      <div className="eng-fields col">
        <div className="eng-fields">
          <label className="fld"><span className="k">Provider</span>
            <select className="in" value={preset} onChange={(x) => { const p = AI_PRESETS.find((y) => y.id === x.target.value)!; editKey(k.id, { baseUrl: p.baseUrl || (preset === 'other' ? k.baseUrl : ''), provider: aiProviderOf(p.baseUrl), model: '' }); setModels((m) => ({ ...m, [k.id]: { list: [], err: '', busy: false } })); }}>
              {presets.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
          <label className="fld"><span className="k">Name · optional</span><input className="in" type="text" maxLength={40} placeholder="Work OpenAI, Spare Gemini…" value={k.label} onChange={(x) => editKey(k.id, { label: x.target.value })} /></label>
        </div>
        <div className="eng-fields">
          <label className="fld"><span className="k">API key</span><input className="in" type="password" autoComplete="off" placeholder={k.saved ? 'Saved · type to replace' : 'Paste key'} value={k.apiKey} onChange={(x) => editKey(k.id, { apiKey: x.target.value })} onBlur={() => k.apiKey.trim() && listModels(k)} /></label>
          {preset === 'other' && <label className="fld"><span className="k">Base URL</span><input className="in" type="url" placeholder="https://" value={k.baseUrl} onChange={(x) => editKey(k.id, { baseUrl: x.target.value, provider: aiProviderOf(x.target.value) })} /></label>}
        </div>
        <div className="eng-fields">
          <label className="fld"><span className="k">Model</span>
            {ml?.list.length
              ? <select className="in" value={ml.list.includes(k.model) ? k.model : ''} onChange={(x) => editKey(k.id, { model: x.target.value })}>
                  {!ml.list.includes(k.model) && <option value="">{k.model ? `${k.model} · not in this key’s list` : 'Choose a chat model'}</option>}
                  {ml.list.map((m) => <option key={m} value={m}>{m}</option>)}
                </select>
              : <input className="in" type="text" placeholder={ex ? `Such as ${ex}` : 'As listed by your provider'} value={k.model} onChange={(x) => editKey(k.id, { model: x.target.value })} />}
          </label>
          <button type="button" className="bt" onClick={() => listModels(k)} disabled={!!ml?.busy || (!k.apiKey.trim() && !k.saved)} title={!k.apiKey.trim() && !k.saved ? 'Paste the key first' : undefined}>{ml?.busy ? 'Listing…' : 'List models'}</button>
          {testBtn(b, k.saved)}
          <button type="button" className={'bt' + (confirm === k.id ? ' danger' : '')} onClick={() => removeKey(k)} onBlur={() => confirm === k.id && setConfirm('')}>{confirm === k.id ? 'Tap again to remove' : 'Remove'}</button>
        </div>
        {notChat && <p className="hint vrow-warn">“{k.model}” is not a chat model (it checks or converts text rather than answering), so it can’t answer as Niko. Choose a chat model{ex ? `, such as ${ex}` : ''}.</p>}
        {ml?.err && <p className="hint vrow-warn">{ml.err}</p>}
        {!ml?.list.length && !ml?.err && <p className="hint">Paste the key, then List models to choose from the chat models it can use.</p>}
      </div>
    );
  };
  const row = (b: BrainEntry, i: number | null) => {
    const on = i !== null, resting = on ? restLine(me.engine.rest?.[b]) : '';
    return (
      <li key={b} className={'vrow' + (on ? ' on' : '')}>
        <div className="vrow-head">
          <span className="n" aria-hidden="true">{on ? i + 1 : '–'}</span>
          <button type="button" className="vrow-title" aria-expanded={open === b} onClick={() => { const k = keyOf(b); if (open !== b && k?.saved && !models[k.id]) void listModels(k); setOpen(open === b ? null : b); }}>
            <b>{name(b)}</b><span className="sub">{sub(b)}</span>
            <UsageLines usage={usage} kind="brain" entry={b} provided={keyOf(b)?.provided} service={keyOf(b) ? AI_PRESETS.find((x) => x.id === presetOf(keyOf(b)!.baseUrl) && x.id !== 'other')?.name : undefined} />
            {resting && <span className="sub vrow-warn">{resting}</span>}
          </button>
          <span className={'k tag' + (keyOf(b)?.provided ? ' inc' : '')}>{tag(b)}</span>
          {on && <span className="vrow-move">
            <button type="button" className="stp" onClick={() => move(b, -1)} disabled={!canUp(b, i)} aria-label={`Move ${name(b)} up`}>↑</button>
            <button type="button" className="stp" onClick={() => move(b, 1)} disabled={!canDown(b, i)} aria-label={`Move ${name(b)} down`}>↓</button>
          </span>}
          <Switch on={on} onChange={(x) => toggle(b, x)} label={`Use ${name(b)}`} />
        </div>
        {open === b && <div className="vrow-body">{settings(b)}</div>}
      </li>
    );
  };
  // ---- pictures
  const editIKey = (id: string, p: Partial<ImageDraft>) => { setDirty((d) => ({ ...d, ['i:' + id]: true })); setIKeys(iKeys.map((k) => (k.id === id ? { ...k, ...p } : k))); };
  const iKeyOf = (v: ImageSource) => iKeys.find((k) => `ikey:${k.id}` === v);
  const okImage = (v: ImageSource) => aiAllowed(off, imageOption(v, iKeyOf(v)));
  const iPresets = IMAGE_PROVIDERS.filter((p) => aiAllowed(off, `img:${p.id}`));
  const iAll: ImageSource[] = ['workers', 'self-hosted', ...iKeys.map((k) => `ikey:${k.id}` as ImageSource)];
  const iShown = iOrder.filter(okImage);
  const editISelf = (p: Partial<typeof iSelf>) => { setDirty((d) => ({ ...d, iself: true })); setISelf({ ...iSelf, ...p }); };
  const iOthers = iAll.filter((v) => !iOrder.includes(v) && okImage(v));
  const iToggle = (v: ImageSource, on: boolean) => { setIOrder(on ? [...iOrder, v] : iOrder.filter((x) => x !== v)); if (on) setIOpen(v); };
  const iMove = (v: ImageSource, by: -1 | 1) => setIOrder(moveShown(iOrder, iShown, v, by));
  const iProv = (v: ImageSource) => !!iKeyOf(v)?.provided;
  const iCanUp = (v: ImageSource, i: number) => i > 0 && !(fixed && (iProv(v) || iProv(iShown[i - 1]!)));
  const iCanDown = (v: ImageSource, i: number) => i < iShown.length - 1 && !(fixed && iProv(v));
  const addIKey = () => {
    const id = 'new-' + Math.random().toString(36).slice(2, 8);
    const p = iPresets[0];
    if (!p) return;
    setIKeys([...iKeys, { id, label: '', provider: p.provider, baseUrl: p.baseUrl ?? '', model: p.models[0] ?? '', apiKey: '', saved: false }]);
    setIOrder([...iOrder, `ikey:${id}`]); setIOpen(`ikey:${id}`); setDirty((d) => ({ ...d, ['i:' + id]: true }));
  };
  const removeIKey = async (k: ImageDraft) => {
    if (confirm !== 'i:' + k.id) { setConfirm('i:' + k.id); return; }
    setConfirm(''); setNote(null);
    try {
      if (!isNew(k.id)) await api(`/image/keys/${encodeURIComponent(k.id)}`, { method: 'DELETE' });
      setIKeys(iKeys.filter((x) => x.id !== k.id)); setIOrder(iOrder.filter((x) => x !== `ikey:${k.id}`));
      if (!isNew(k.id)) { await refreshMe(); setNote({ ok: true, text: 'Image key removed.' }); }
    } catch (x: any) { setNote({ ok: false, text: x.message }); }
  };
  // Test: one small picture from this one service, as set on the page, saved or not. It is shown here and not kept.
  const testImage = async (v: ImageSource) => {
    setNote(null); setBusy('img-' + v);
    if (sample) { URL.revokeObjectURL(sample.url); setSample(null); }
    try {
      const k = iKeyOf(v);
      const res = await fetch('/api/image', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
        prompt: TEST_PICTURE, shape: 'square',
        // A key not saved yet has only a temporary id on this page, so it is sent as "ikey:draft" with its settings.
        source: k && isNew(k.id) ? 'ikey:draft' : v, key: k ? { ...k, id: undefined, apiKey: k.apiKey || undefined } : undefined,
        server: v === 'self-hosted' ? { baseUrl: iSelf.baseUrl || undefined, model: iSelf.model || undefined, apiKey: iSelf.apiKey || undefined } : undefined,
      }) });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? 'It could not make a picture.');
      const blob = await res.blob();
      setSample({ entry: v, url: URL.createObjectURL(blob) });
      setNote({ ok: true, text: `It painted a picture in ${((Number(res.headers.get('x-niko-ms')) || 0) / 1000).toFixed(1)} s.` });
      await refreshMe();
    } catch (x: any) { setNote({ ok: false, text: x.message }); } finally { setBusy(''); }
  };
  const iTestBtn = (v: ImageSource, disabled = false) => <button type="button" className="bt" onClick={() => testImage(v)} disabled={!!busy || disabled}>{busy === 'img-' + v ? 'Painting…' : 'Test'}</button>;
  const iSample = (v: ImageSource) => sample?.entry === v && <img className="eng-sample" src={sample.url} alt="The test picture" />;
  const imageSettings = (v: ImageSource) => {
    if (v === 'workers') return (
      <div className="eng-fields col">
        <div className="eng-fields">{iTestBtn(v)}</div>
        {iSample(v)}
        <p className="hint">FLUX.1 [schnell] by Black Forest Labs, run on Cloudflare. Fast and free within Cloudflare’s daily allowance, shared with the Workers AI brain and voice. Pictures are square.</p>
      </div>
    );
    if (v === 'self-hosted') return (
      <div className="eng-fields col">
        <div className="eng-fields">
          <label className="fld"><span className="k">Server address</span><input className="in" type="url" placeholder="https://" value={iSelf.baseUrl} onChange={(x) => editISelf({ baseUrl: x.target.value })} /></label>
          <label className="fld"><span className="k">Model name · optional</span><input className="in" type="text" value={iSelf.model} onChange={(x) => editISelf({ model: x.target.value.trim() })} /></label>
        </div>
        <div className="eng-fields">
          <label className="fld"><span className="k">API key · optional</span><input className="in" type="password" autoComplete="off" placeholder={linked['self-hosted-image'] ? 'Saved, or none · type to replace' : 'Only if your server asks for one'} value={iSelf.apiKey} onChange={(x) => editISelf({ apiKey: x.target.value })} /></label>
          {iTestBtn(v, !iSelf.baseUrl.trim())}
        </div>
        {iSample(v)}
        <p className="hint">Any image server with an OpenAI-compatible images API, such as LocalAI or a Stable Diffusion or FLUX server, on a NAS or your own computer. It needs a public https address; Cloudflare Tunnel is a free way to give one. A key is sent only to the address it was saved with.</p>
      </div>
    );
    const k = iKeyOf(v);
    if (!k) return null;
    if (k.provided) return (
      <div className="eng-fields col">
        <p className="hint">Included with your plan: there’s no key to manage. Switch it off if you’d rather Niko didn’t use it.</p>
        <div className="eng-fields">{iTestBtn(v)}</div>
        {iSample(v)}
      </div>
    );
    const p = imageInfo(k);
    return (
      <div className="eng-fields col">
        <div className="eng-fields">
          <label className="fld"><span className="k">Service</span>
            <select className="in" value={p.id} onChange={(x) => { const n = IMAGE_PROVIDERS.find((y) => y.id === x.target.value)!; editIKey(k.id, { provider: n.provider, baseUrl: n.baseUrl ?? (n.id === 'other' && p.id === 'other' ? k.baseUrl : ''), model: n.models[0] ?? '' }); }}>
              {iPresets.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
          </label>
          <label className="fld"><span className="k">Name · optional</span><input className="in" type="text" maxLength={40} placeholder="Work OpenAI, Spare fal…" value={k.label} onChange={(x) => editIKey(k.id, { label: x.target.value })} /></label>
        </div>
        <div className="eng-fields">
          <label className="fld"><span className="k">API key</span><input className="in" type="password" autoComplete="off" placeholder={k.saved ? 'Saved · type to replace' : 'Paste key'} value={k.apiKey} onChange={(x) => editIKey(k.id, { apiKey: x.target.value })} /></label>
          {p.id === 'other' && <label className="fld"><span className="k">Base URL</span><input className="in" type="url" placeholder="https://" value={k.baseUrl} onChange={(x) => editIKey(k.id, { baseUrl: x.target.value })} /></label>}
        </div>
        <div className="eng-fields">
          <label className="fld"><span className="k">{p.modelLabel ?? 'Model'}</span>
            {p.provider === 'ideogram'
              ? <select className="in" value={k.model.toUpperCase() || 'TURBO'} onChange={(x) => editIKey(k.id, { model: x.target.value })}>{p.models.map((m) => <option key={m} value={m}>{m[0] + m.slice(1).toLowerCase()}</option>)}</select>
              : <><input className="in" type="text" list={`img-models-${k.id}`} placeholder={p.models[0] ? `Such as ${p.models[0]}` : 'As listed by the service'} value={k.model} onChange={(x) => editIKey(k.id, { model: x.target.value.trim() })} />
                  <datalist id={`img-models-${k.id}`}>{p.models.map((m) => <option key={m} value={m} />)}</datalist></>}
          </label>
          {iTestBtn(v, !k.apiKey.trim() && !k.saved)}
          <button type="button" className={'bt' + (confirm === 'i:' + k.id ? ' danger' : '')} onClick={() => removeIKey(k)} onBlur={() => confirm === 'i:' + k.id && setConfirm('')}>{confirm === 'i:' + k.id ? 'Tap again to remove' : 'Remove'}</button>
        </div>
        {iSample(v)}
        <p className="hint">{p.note}</p>
      </div>
    );
  };
  const iName = (v: ImageSource) => { if (v === 'self-hosted') return 'Your image server'; const k = iKeyOf(v); return k ? k.label || imageInfo(k).name : 'Cloudflare FLUX'; };
  const iSub = (v: ImageSource) => {
    if (v === 'self-hosted') return iSelf.baseUrl ? [(() => { try { return new URL(iSelf.baseUrl).hostname; } catch { return iSelf.baseUrl; } })(), iSelf.model].filter(Boolean).join(' · ') : 'An image model server you run, such as on a NAS, at a public https address.';
    const k = iKeyOf(v); return k ? [imageInfo(k).name, k.model || 'default model'].join(' · ') + (k.saved ? '' : ' · not saved yet') : 'FLUX.1 [schnell] on Cloudflare, where Niko runs. Nothing to set up.';
  };
  const iRow = (v: ImageSource, i: number | null) => {
    const on = i !== null, resting = on ? imageRestLine(me.engine.imageRest?.[v]) : '';
    return (
      <li key={v} className={'vrow' + (on ? ' on' : '')}>
        <div className="vrow-head">
          <span className="n" aria-hidden="true">{on ? i + 1 : '–'}</span>
          <button type="button" className="vrow-title" aria-expanded={iOpen === v} onClick={() => setIOpen(iOpen === v ? null : v)}>
            <b>{iName(v)}</b><span className="sub">{iSub(v)}</span>
            <UsageLines usage={usage} kind="image" entry={v} provided={iKeyOf(v)?.provided} service={iKeyOf(v) ? imageInfo(iKeyOf(v)!).name : undefined} />
            {resting && <span className="sub vrow-warn">{resting}</span>}
          </button>
          <span className={'k tag' + (iProv(v) ? ' inc' : '')}>{v === 'self-hosted' ? 'Your server' : iProv(v) ? 'Included' : iKeyOf(v) ? 'Your key' : 'Built in'}</span>
          {on && <span className="vrow-move">
            <button type="button" className="stp" onClick={() => iMove(v, -1)} disabled={!iCanUp(v, i)} aria-label={`Move ${iName(v)} up`}>↑</button>
            <button type="button" className="stp" onClick={() => iMove(v, 1)} disabled={!iCanDown(v, i)} aria-label={`Move ${iName(v)} down`}>↓</button>
          </span>}
          <Switch on={on} onChange={(x) => iToggle(v, x)} label={`Use ${iName(v)}`} />
        </div>
        {iOpen === v && <div className="vrow-body">{imageSettings(v)}</div>}
      </li>
    );
  };
  return (
    <SettingsPage title="Engine" sub="What Niko thinks with. You can change it at any time." action={<button className="pri set-save" onClick={save} disabled={busy === 'save'}>{busy === 'save' ? 'Saving…' : 'Save changes'}</button>}>
      <NoteLine note={note} />
      {usage && <AccountInfo usage={usage} />}
      {usage && <IncludedCard usage={usage} kinds={['brain', 'image', 'map']} other={{ to: '/voice', label: 'Voice and listening are on the Voice page' }} />}
      <section className="g eng-card wide" aria-label="Brain">
        <span className="k" style={{ paddingBottom: 6 }}>Brain · Niko uses in this order</span>
        <p className="hint" style={{ paddingBottom: 8 }}>Niko answers with the first one that works. When one reaches its usage limit, refuses its key, stops answering or what’s included this month runs out, Niko moves to the next straight away.</p>
        <MonthLine usage={usage} kind="brain" />
        <ol className="vlist">{shown.map((b, i) => row(b, i))}</ol>
        {presets.length > 0 && <button type="button" className="bt add-key" onClick={addKey} disabled={keys.filter((k) => !k.provided).length >= MAX_AI_KEYS}><Icon name="plus" size={18} />Add an AI key</button>}
        {others.length > 0 && <>
          <span className="k" style={{ padding: '18px 0 6px' }}>Not in use</span>
          <ul className="vlist">{others.map((b) => row(b, null))}</ul>
        </>}
        {managedIn(off, 'brain') && <p className="hint managed">{MANAGED}</p>}
      </section>
      {!off.includes('sec:images') ? <section className="g eng-card wide" aria-label="Pictures">
        <span className="k" style={{ paddingBottom: 6 }}>Pictures · Niko uses in this order</span>
        <MonthLine usage={usage} kind="image" />
        <p className="hint" style={{ paddingBottom: 8 }}>Ask Niko to paint, draw or make a picture. The first service that works paints it, switching to the next when one reaches its limit, refuses its key or stops answering. Each service checks requests against its own rules: if one declines a picture, the next is asked. Pictures are never stored; Save keeps one on your device. Switch them all off to turn pictures off.</p>
        {iShown.length ? <ol className="vlist">{iShown.map((v, i) => iRow(v, i))}</ol> : <p className="hint vrow-warn" style={{ padding: '4px 0 8px' }}>Pictures are off. Switch on a service below to turn them on.</p>}
        {iPresets.length > 0 && <button type="button" className="bt add-key" onClick={addIKey} disabled={iKeys.filter((k) => !k.provided).length >= MAX_IMAGE_KEYS}><Icon name="plus" size={18} />Add an image API key</button>}
        {iOthers.length > 0 && <>
          <span className="k" style={{ padding: '18px 0 6px' }}>Not in use</span>
          <ul className="vlist">{iOthers.map((v) => iRow(v, null))}</ul>
        </>}
        {managedIn(off, 'images') && <p className="hint managed">{MANAGED}</p>}
      </section> : null}
      <MapSettings bind={(l) => { mapLists.current = l; }} usage={usage} />
      <p className="g eng-keys"><Icon name="shield" size={20} />Keys are encrypted on the server, never stored in this browser, and never shown again after saving. Included services come with your plan: there is no key to manage, and you can switch any of them off. Your own keys are never counted towards what’s included. Several keys from the same provider and account share one usage limit, so a second key helps most when it is from another account or provider. The voice is set under Voice.</p>
    </SettingsPage>
  );
}

// ---------------------------------------------------------------- voice (speech out, speech in)
type Builtin = 'workers' | 'kokoro' | 'self-hosted';
const VOICE_INFO: Record<Builtin, { sub: string; tag: string }> = {
  workers: { sub: 'Made on Cloudflare, where Niko runs. Nothing to set up.', tag: 'Built in' },
  kokoro: { sub: 'A natural voice made on this device. Private, and works offline once downloaded. Not counted.', tag: 'On this device' },
  'self-hosted': { sub: 'A speech server you run, such as on a NAS. Can use a cloned voice.', tag: 'Your server' },
};
const PREVIEW_LINE = (name: string) => `Hi ${name || 'there'}, this is how I sound.`;
/** A voice key being added or changed on this page. `id` is the saved key's id, or a temporary "new-…" one. */
type VoiceDraft = VoiceKeyInfo & { apiKey: string; saved: boolean };
type HearDraft = HearKeyInfo & { apiKey: string; saved: boolean };
const hearInfo = (k: { provider: HearProvider; baseUrl: string }) => HEAR_PROVIDERS.find((p) => p.id === hearPresetOf(k))!;
/** Services whose voices can be listed from the account. */
const LISTS_VOICES: VoiceProvider[] = ['elevenlabs', 'google', 'azure', 'cartesia', 'fishaudio'];
const presetInfo = (k: { provider: VoiceProvider; baseUrl: string }) => VOICE_PROVIDERS.find((p) => p.id === voicePresetOf(k))!;
function voiceRestLine(r: BrainRest | undefined): string {
  if (!r || r.until <= Date.now()) return '';
  if (r.why === 'limit') return `Usage limit reached. The next voice speaks, and this one is tried again at ${day(r.until)}.`;
  if (r.why === 'refused') return `It refused the last request. Check its key and voice; it is tried again at ${day(r.until)}.`;
  return `It did not answer just now. The next voice speaks, and this one is tried again at ${day(r.until)}.`;
}

export function Voice() {
  const { me, refreshMe } = useNiko();
  const { usage, reload: reloadUsage } = useUsage();
  const { linked, values, ready, reload } = useLinks();
  const [e, setE] = useState<EnginePrefs | null>(null);
  const [order, setOrder] = useState<VoiceSource[]>([]);
  const [keys, setKeys] = useState<VoiceDraft[]>([]);
  const [open, setOpen] = useState<VoiceSource | null>(null);
  const [sh, setSh] = useState({ baseUrl: '', voice: '', model: '', apiKey: '' });
  const [lists, setLists] = useState<Record<string, { list: { id: string; name: string }[]; err: string; busy: boolean }>>({});
  const [note, setNote] = useState<Note>(null);
  const [busy, setBusy] = useState('');
  const [dirty, setDirty] = useState<Record<string, boolean>>({});
  const [confirm, setConfirm] = useState('');
  const [kReady, setKReady] = useState(kokoroReady());
  const [kProgress, setKProgress] = useState<number | null>(null);
  // Speech in: Cloudflare and the user's speech-to-text keys, in order; the device's own recognition is always last.
  const [hOrder, setHOrder] = useState<HearSource[]>([]);
  const [hKeys, setHKeys] = useState<HearDraft[]>([]);
  const [hOpen, setHOpen] = useState<HearSource | null>(null);
  const [testing, setTesting] = useState<{ entry: string; cap: Capture } | null>(null);
  const [hSelf, setHSelf] = useState({ baseUrl: '', model: '', apiKey: '' });
  const playing = useRef<{ stop: () => void } | null>(null);
  const loadKeys = useCallback(async () => {
    const r = await api<{ keys: VoiceKeyInfo[] }>('/voice/keys');
    setKeys((cur) => [...(r.keys ?? []).map((k) => ({ ...k, apiKey: '', saved: true })), ...cur.filter((k) => isNew(k.id))]);
  }, []);
  const loadHearKeys = useCallback(async () => {
    const r = await api<{ keys: HearKeyInfo[] }>('/voice/hear-keys');
    setHKeys((cur) => [...(r.keys ?? []).map((k) => ({ ...k, apiKey: '', saved: true })), ...cur.filter((k) => isNew(k.id))]);
  }, []);
  useEffect(() => { if (me && !e) { setE({ ...me.engine }); setOrder(voiceOrder(me.engine)); setHOrder(hearOrder(me.engine)); void loadKeys(); void loadHearKeys(); } }, [me, e, loadKeys, loadHearKeys]);
  useEffect(() => () => testing?.cap.cancel(), [testing]);
  useEffect(() => () => playing.current?.stop(), []);
  // Saved settings are shown again, so the page reopens as it was left.
  useEffect(() => {
    if (!ready) return;
    const s = values['self-hosted-voice'];
    if (s && !dirty.sh) setSh((v) => ({ ...v, baseUrl: s.baseUrl ?? '', voice: s.voice ?? '', model: s.model ?? '' }));
    const sh2 = values['self-hosted-hear'];
    if (sh2 && !dirty.hself) setHSelf({ baseUrl: sh2.baseUrl ?? '', model: sh2.model ?? '', apiKey: '' });
  }, [ready, values]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!me || !e) return null;
  const set = (p: Partial<EnginePrefs>) => setE({ ...e, ...p });
  const editSh = (p: Partial<typeof sh>) => { setDirty((d) => ({ ...d, sh: true })); setSh({ ...sh, ...p }); };
  const editKey = (id: string, p: Partial<VoiceDraft>) => { setDirty((d) => ({ ...d, [id]: true })); setKeys(keys.map((k) => (k.id === id ? { ...k, ...p } : k))); };
  const keyOf = (v: VoiceSource) => keys.find((k) => `vkey:${k.id}` === v);
  // Options the admin has turned off for this account are not shown (and are kept in the saved order).
  const off = me.aiOff ?? [];
  const okVoice = (v: VoiceSource) => aiAllowed(off, voiceOption(v, keyOf(v)));
  const vPresets = VOICE_PROVIDERS.filter((p) => aiAllowed(off, `v:${p.id}`));
  const all: VoiceSource[] = [...VOICE_SOURCES, ...keys.map((k) => `vkey:${k.id}` as VoiceSource)];
  const shown = order.filter(okVoice);
  const others = all.filter((v) => !order.includes(v) && okVoice(v));
  const toggle = (v: VoiceSource, on: boolean) => { setOrder(on ? [...order, v] : order.filter((x) => x !== v)); if (on) setOpen(v); };
  const move = (v: VoiceSource, by: -1 | 1) => setOrder(moveShown(order, shown, v, by));
  // Included services stay first when the plan says so.
  const fixed = usage?.plan.order === 'fixed';
  const vProv = (v: VoiceSource) => !!keyOf(v)?.provided;
  const canUp = (v: VoiceSource, i: number) => i > 0 && !(fixed && (vProv(v) || vProv(shown[i - 1]!)));
  const canDown = (v: VoiceSource, i: number) => i < shown.length - 1 && !(fixed && vProv(v));
  const addKey = () => {
    const id = 'new-' + Math.random().toString(36).slice(2, 8);
    const p = vPresets[0];
    if (!p) return;
    setKeys([...keys, { id, label: '', provider: p.provider, baseUrl: p.baseUrl ?? '', voice: p.voices?.[0]?.id ?? '', model: p.models?.[0] ?? '', region: '', apiKey: '', saved: false }]);
    setOrder([...order, `vkey:${id}`]); setOpen(`vkey:${id}`); setDirty((d) => ({ ...d, [id]: true }));
  };
  const removeKey = async (k: VoiceDraft) => {
    if (confirm !== k.id) { setConfirm(k.id); return; }
    setConfirm(''); setNote(null);
    try {
      if (!isNew(k.id)) await api(`/voice/keys/${encodeURIComponent(k.id)}`, { method: 'DELETE' });
      setKeys(keys.filter((x) => x.id !== k.id)); setOrder(order.filter((x) => x !== `vkey:${k.id}`));
      if (!isNew(k.id)) { await refreshMe(); setNote({ ok: true, text: 'Voice key removed.' }); }
    } catch (x: any) { setNote({ ok: false, text: x.message }); }
  };
  const listVoices = async (k: VoiceDraft) => {
    if (!k.apiKey.trim() && !k.saved) return;
    setLists((m) => ({ ...m, [k.id]: { list: m[k.id]?.list ?? [], err: '', busy: true } }));
    try {
      const r = await api<{ voices: { id: string; name: string }[] }>('/voice/keys/voices', { body: { ...k, id: isNew(k.id) ? undefined : k.id, apiKey: k.apiKey || undefined } });
      setLists((m) => ({ ...m, [k.id]: { list: r.voices, err: r.voices.length ? '' : 'No voices were listed for this key.', busy: false } }));
      if (r.voices[0] && !r.voices.some((v) => v.id === k.voice)) editKey(k.id, { voice: r.voices[0].id });
    } catch (x: any) { setLists((m) => ({ ...m, [k.id]: { list: [], err: x.message, busy: false } })); }
  };

  const save = async () => {
    setNote(null); setBusy('save');
    try {
      // New and changed keys are saved first; a new key's temporary id becomes its saved one.
      let next = [...order];
      const kept: VoiceDraft[] = [], savedIds = new Set<string>();
      for (const k of keys) {
        if (!dirty[k.id]) { kept.push(k); continue; }
        if (isNew(k.id) && !k.apiKey.trim()) { if (next.includes(`vkey:${k.id}`)) throw new Error(`Paste the API key for ${k.label || presetInfo(k).name}, or remove it.`); kept.push(k); continue; }
        const r = await api<{ key: VoiceKeyInfo }>('/voice/keys', { body: { ...k, id: isNew(k.id) ? undefined : k.id } });
        next = next.map((v) => (v === `vkey:${k.id}` ? `vkey:${r.key.id}` as VoiceSource : v));
        kept.push({ ...r.key, apiKey: '', saved: true }); savedIds.add(k.id);
      }
      // Saved keys are kept in the page at once, so a problem further on never saves them twice.
      setKeys(kept); setOrder(next);
      setDirty((d) => Object.fromEntries(Object.entries(d).filter(([id]) => !savedIds.has(id))));
      // Speech-in keys, the same way.
      let hNext = [...hOrder];
      const hKept: HearDraft[] = [], hSaved = new Set<string>();
      for (const k of hKeys) {
        if (!dirty['h:' + k.id]) { hKept.push(k); continue; }
        if (isNew(k.id) && !k.apiKey.trim()) { if (hNext.includes(`skey:${k.id}`)) throw new Error(`Paste the API key for ${k.label || hearInfo(k).name} under Listening, or remove it.`); hKept.push(k); continue; }
        const r = await api<{ key: HearKeyInfo }>('/voice/hear-keys', { body: { ...k, id: isNew(k.id) ? undefined : k.id } });
        hNext = hNext.map((v) => (v === `skey:${k.id}` ? `skey:${r.key.id}` as HearSource : v));
        hKept.push({ ...r.key, apiKey: '', saved: true }); hSaved.add('h:' + k.id);
      }
      setHKeys(hKept); setHOrder(hNext);
      setDirty((d) => Object.fromEntries(Object.entries(d).filter(([id]) => !hSaved.has(id))));
      if (dirty.sh && sh.baseUrl.trim()) await api('/connections/self-hosted-voice', { body: sh });
      if (dirty.hself && hSelf.baseUrl.trim()) await api('/connections/self-hosted-hear', { body: hSelf });
      if (hNext.includes('self-hosted') && okHear('self-hosted') && !linked['self-hosted-hear'] && !hSelf.baseUrl.trim()) throw new Error('Add your speech-to-text server’s address under Listening, or switch it off.');
      if (next.includes('self-hosted') && okVoice('self-hosted') && !linked['self-hosted-voice'] && !sh.baseUrl.trim()) throw new Error('Add your voice server’s address, or switch it off.');
      await api('/me', { method: 'PATCH', body: { engine: { voices: next, hears: hNext, workersVoice: e.workersVoice ?? 'melo', kokoroVoice: e.kokoroVoice ?? 'af_heart', wake: e.wake } } });
      await Promise.all([refreshMe(), reload(), reloadUsage()]);
      setSh((v) => ({ ...v, apiKey: '' })); setHSelf((v) => ({ ...v, apiKey: '' })); setDirty({});
      setNote({ ok: true, text: next.includes('kokoro') && !kReady ? 'Saved. The on-device voice is skipped on this device until it is downloaded here.' : 'Saved.' });
    } catch (x: any) { setNote({ ok: false, text: x.message }); } finally { setBusy(''); }
  };

  // Preview plays the voice as set on this page, saved or not.
  const preview = async (v: VoiceSource | 'device') => {
    setNote(null); playing.current?.stop(); playing.current = null;
    const line = PREVIEW_LINE(me.name);
    if (v === 'device') { window.speechSynthesis?.cancel(); window.speechSynthesis?.speak(new SpeechSynthesisUtterance(line)); return; }
    setBusy('preview-' + v);
    try {
      if (v === 'kokoro') {
        const s = kokoroSpeak(line, e.kokoroVoice ?? 'af_heart'); playing.current = s;
        await s.started; await s.done; return;
      }
      const body: Record<string, unknown> = { text: line, source: v, preview: true };
      if (v === 'workers') body.workersVoice = e.workersVoice ?? 'melo';
      if (v === 'self-hosted') Object.assign(body, { baseUrl: sh.baseUrl || undefined, voice: sh.voice || undefined, model: sh.model || undefined, apiKey: sh.apiKey || undefined });
      const k = keyOf(v);
      if (k) body.key = { ...k, apiKey: k.apiKey || undefined };
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
  const previewBtn = (v: VoiceSource | 'device', disabled = false) => <button type="button" className="bt" onClick={() => preview(v)} disabled={!!busy || disabled}>{busy === 'preview-' + v ? 'Playing…' : 'Preview'}</button>;

  // ---- speech in
  const editHKey = (id: string, p: Partial<HearDraft>) => { setDirty((d) => ({ ...d, ['h:' + id]: true })); setHKeys(hKeys.map((k) => (k.id === id ? { ...k, ...p } : k))); };
  const hKeyOf = (v: HearSource) => hKeys.find((k) => `skey:${k.id}` === v);
  const okHear = (v: HearSource) => aiAllowed(off, hearOption(v, hKeyOf(v)));
  const hPresets = HEAR_PROVIDERS.filter((p) => aiAllowed(off, `h:${p.id}`));
  const hAll: HearSource[] = ['workers', 'self-hosted', ...hKeys.map((k) => `skey:${k.id}` as HearSource)];
  const hShown = hOrder.filter(okHear);
  const editHSelf = (p: Partial<typeof hSelf>) => { setDirty((d) => ({ ...d, hself: true })); setHSelf({ ...hSelf, ...p }); };
  const hOthers = hAll.filter((v) => !hOrder.includes(v) && okHear(v));
  const hToggle = (v: HearSource, on: boolean) => { setHOrder(on ? [...hOrder, v] : hOrder.filter((x) => x !== v)); if (on) setHOpen(v); };
  const hMove = (v: HearSource, by: -1 | 1) => setHOrder(moveShown(hOrder, hShown, v, by));
  const hProv = (v: HearSource) => !!hKeyOf(v)?.provided;
  const hCanUp = (v: HearSource, i: number) => i > 0 && !(usage?.plan.order === 'fixed' && (hProv(v) || hProv(hShown[i - 1]!)));
  const hCanDown = (v: HearSource, i: number) => i < hShown.length - 1 && !(usage?.plan.order === 'fixed' && hProv(v));
  const addHKey = () => {
    const id = 'new-' + Math.random().toString(36).slice(2, 8);
    const p = hPresets[0];
    if (!p) return;
    setHKeys([...hKeys, { id, label: '', provider: p.provider, baseUrl: p.baseUrl ?? '', model: p.models?.[0] ?? '', region: '', apiKey: '', saved: false }]);
    setHOrder([...hOrder, `skey:${id}`]); setHOpen(`skey:${id}`); setDirty((d) => ({ ...d, ['h:' + id]: true }));
  };
  const removeHKey = async (k: HearDraft) => {
    if (confirm !== 'h:' + k.id) { setConfirm('h:' + k.id); return; }
    setConfirm(''); setNote(null);
    try {
      if (!isNew(k.id)) await api(`/voice/hear-keys/${encodeURIComponent(k.id)}`, { method: 'DELETE' });
      setHKeys(hKeys.filter((x) => x.id !== k.id)); setHOrder(hOrder.filter((x) => x !== `skey:${k.id}`));
      if (!isNew(k.id)) { await refreshMe(); setNote({ ok: true, text: 'Speech-in key removed.' }); }
    } catch (x: any) { setNote({ ok: false, text: x.message }); }
  };
  // Test: you say something, and this one service (as set on the page, saved or not) writes down what it heard.
  const testHear = async (v: HearSource) => {
    if (testing) { testing.cap.finish(); return; }
    setNote(null);
    if (!captureSupported()) { setNote({ ok: false, text: 'This browser cannot record from the microphone.' }); return; }
    const cap = captureUtterance({ waitMs: 6000, maxMs: 10_000 });
    setTesting({ entry: v, cap });
    setNote({ ok: true, text: 'Listening… say something, such as “What’s on my calendar today?”' });
    try {
      const wav = await cap.done;
      if (!wav) { setNote({ ok: false, text: 'Nothing was heard. Check the microphone and try again.' }); return; }
      setNote({ ok: true, text: 'Turning that into words…' });
      const k = hKeyOf(v);
      // A key not saved yet has only a temporary id on this page, so it is sent as "skey:draft" with its settings.
      const r = await transcribe(wav, { source: k && isNew(k.id) ? 'skey:draft' : v, key: k ? { ...k, id: undefined, apiKey: k.apiKey || undefined } : undefined,
        server: v === 'self-hosted' ? { baseUrl: hSelf.baseUrl || undefined, model: hSelf.model || undefined, apiKey: hSelf.apiKey || undefined } : undefined });
      setNote({ ok: true, text: r.text ? `It heard: “${r.text}”` : 'It answered, but heard no words.' });
    } catch (x: any) { setNote({ ok: false, text: x.message }); } finally { setTesting(null); }
  };
  const testBtn = (v: HearSource, disabled = false) => <button type="button" className="bt" onClick={() => testHear(v)} disabled={disabled || (!!testing && testing.entry !== v)}>{testing?.entry === v ? 'Stop' : 'Test'}</button>;
  const hearSettings = (v: HearSource) => {
    if (v === 'workers') return (
      <div className="eng-fields col">
        <div className="eng-fields">{testBtn(v)}</div>
        <p className="hint">OpenAI’s Whisper, run on Cloudflare. Free within Cloudflare’s daily allowance, shared with the Workers AI brain and voice. Many languages.</p>
      </div>
    );
    if (v === 'self-hosted') return (
      <div className="eng-fields col">
        <div className="eng-fields">
          <label className="fld"><span className="k">Server address</span><input className="in" type="url" placeholder="https://" value={hSelf.baseUrl} onChange={(x) => editHSelf({ baseUrl: x.target.value })} /></label>
          <label className="fld"><span className="k">Model name · optional</span><input className="in" type="text" placeholder="whisper-1" value={hSelf.model} onChange={(x) => editHSelf({ model: x.target.value.trim() })} /></label>
        </div>
        <div className="eng-fields">
          <label className="fld"><span className="k">API key · optional</span><input className="in" type="password" autoComplete="off" placeholder={linked['self-hosted-hear'] ? 'Saved, or none · type to replace' : 'Only if your server asks for one'} value={hSelf.apiKey} onChange={(x) => editHSelf({ apiKey: x.target.value })} /></label>
          {testBtn(v, !hSelf.baseUrl.trim())}
        </div>
        <p className="hint">Any speech-to-text server with an OpenAI-compatible transcription API, such as Speaches (faster-whisper), whisper.cpp’s server or LocalAI, on a NAS or your own computer. It needs a public https address; Cloudflare Tunnel is a free way to give one. A key is sent only to the address it was saved with.</p>
      </div>
    );
    const k = hKeyOf(v);
    if (!k) return null;
    if (k.provided) return <p className="hint">Included with your plan: there’s no key to manage. Switch it off if you’d rather Niko didn’t use it.</p>;
    const p = hearInfo(k);
    return (
      <div className="eng-fields col">
        <div className="eng-fields">
          <label className="fld"><span className="k">Service</span>
            <select className="in" value={p.id} onChange={(x) => { const n = HEAR_PROVIDERS.find((y) => y.id === x.target.value)!; editHKey(k.id, { provider: n.provider, baseUrl: n.baseUrl ?? (n.id === 'other' && p.id === 'other' ? k.baseUrl : ''), model: n.models?.[0] ?? '', region: '' }); }}>
              {hPresets.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
          </label>
          <label className="fld"><span className="k">Name · optional</span><input className="in" type="text" maxLength={40} placeholder="Work OpenAI, Spare Groq…" value={k.label} onChange={(x) => editHKey(k.id, { label: x.target.value })} /></label>
        </div>
        <div className="eng-fields">
          <label className="fld"><span className="k">API key</span><input className="in" type="password" autoComplete="off" placeholder={k.saved ? 'Saved · type to replace' : 'Paste key'} value={k.apiKey} onChange={(x) => editHKey(k.id, { apiKey: x.target.value })} /></label>
          {k.provider === 'azure' && <label className="fld"><span className="k">Region</span><input className="in" type="text" placeholder="eastus, southeastasia…" value={k.region} onChange={(x) => editHKey(k.id, { region: x.target.value.trim().toLowerCase() })} /></label>}
          {p.id === 'other' && <label className="fld"><span className="k">Base URL</span><input className="in" type="url" placeholder="https://" value={k.baseUrl} onChange={(x) => editHKey(k.id, { baseUrl: x.target.value })} /></label>}
        </div>
        <div className="eng-fields">
          {(p.models || p.id === 'other') && <label className="fld"><span className="k">Model</span>
            {p.models
              ? <select className="in" value={k.model} onChange={(x) => editHKey(k.id, { model: x.target.value })}>{p.models.map((m) => <option key={m} value={m}>{m}</option>)}</select>
              : <input className="in" type="text" placeholder="As listed by the service" value={k.model} onChange={(x) => editHKey(k.id, { model: x.target.value })} />}
          </label>}
          {testBtn(v, !k.apiKey.trim() && !k.saved)}
          <button type="button" className={'bt' + (confirm === 'h:' + k.id ? ' danger' : '')} onClick={() => removeHKey(k)} onBlur={() => confirm === 'h:' + k.id && setConfirm('')}>{confirm === 'h:' + k.id ? 'Tap again to remove' : 'Remove'}</button>
        </div>
        <p className="hint">{p.note}</p>
      </div>
    );
  };
  const hName = (v: HearSource) => { if (v === 'self-hosted') return 'Your speech-to-text server'; const k = hKeyOf(v); return k ? k.label || hearInfo(k).name : 'Cloudflare speech recognition'; };
  const hSub = (v: HearSource) => {
    if (v === 'self-hosted') return hSelf.baseUrl ? [(() => { try { return new URL(hSelf.baseUrl).hostname; } catch { return hSelf.baseUrl; } })(), hSelf.model].filter(Boolean).join(' · ') : 'A speech-to-text server you run, such as on a NAS, at a public https address.';
    const k = hKeyOf(v); return k ? [hearInfo(k).name, k.model || 'default model'].join(' · ') + (k.saved ? '' : ' · not saved yet') : 'Whisper on Cloudflare, where Niko runs. Nothing to set up.';
  };
  const hRow = (v: HearSource, i: number | null) => {
    const on = i !== null, resting = on ? voiceRestLine(me.engine.hearRest?.[v]) : '';
    return (
      <li key={v} className={'vrow' + (on ? ' on' : '')}>
        <div className="vrow-head">
          <span className="n" aria-hidden="true">{on ? i + 1 : '–'}</span>
          <button type="button" className="vrow-title" aria-expanded={hOpen === v} onClick={() => setHOpen(hOpen === v ? null : v)}>
            <b>{hName(v)}</b><span className="sub">{hSub(v)}</span>
            <UsageLines usage={usage} kind="hear" entry={v} provided={hKeyOf(v)?.provided} service={hKeyOf(v) ? hearInfo(hKeyOf(v)!).name : undefined} />
            {resting && <span className="sub vrow-warn">{resting.replace('The next voice speaks', 'The next one listens').replace('next voice', 'next one')}</span>}
          </button>
          <span className={'k tag' + (hProv(v) ? ' inc' : '')}>{v === 'self-hosted' ? 'Your server' : hProv(v) ? 'Included' : hKeyOf(v) ? 'Your key' : 'Built in'}</span>
          {on && <span className="vrow-move">
            <button type="button" className="stp" onClick={() => hMove(v, -1)} disabled={!hCanUp(v, i)} aria-label={`Move ${hName(v)} up`}>↑</button>
            <button type="button" className="stp" onClick={() => hMove(v, 1)} disabled={!hCanDown(v, i)} aria-label={`Move ${hName(v)} down`}>↓</button>
          </span>}
          <Switch on={on} onChange={(x) => hToggle(v, x)} label={`Use ${hName(v)}`} />
        </div>
        {hOpen === v && <div className="vrow-body">{hearSettings(v)}</div>}
      </li>
    );
  };

  const keySettings = (k: VoiceDraft) => {
    const p = presetInfo(k), ml = lists[k.id];
    const voices = ml?.list.length ? ml.list : p.voices ?? [];
    const v: VoiceSource = `vkey:${k.id}`;
    return (
      <div className="eng-fields col">
        <div className="eng-fields">
          <label className="fld"><span className="k">Service</span>
            <select className="in" value={p.id} onChange={(x) => { const n = VOICE_PROVIDERS.find((y) => y.id === x.target.value)!; editKey(k.id, { provider: n.provider, baseUrl: n.baseUrl ?? (n.id === 'other' && p.id === 'other' ? k.baseUrl : ''), voice: n.voices?.[0]?.id ?? '', model: n.models?.[0] ?? '', region: '' }); setLists((m) => ({ ...m, [k.id]: { list: [], err: '', busy: false } })); }}>
              {vPresets.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
          </label>
          <label className="fld"><span className="k">Name · optional</span><input className="in" type="text" maxLength={40} placeholder="Work OpenAI, Spare Azure…" value={k.label} onChange={(x) => editKey(k.id, { label: x.target.value })} /></label>
        </div>
        <div className="eng-fields">
          <label className="fld"><span className="k">API key</span><input className="in" type="password" autoComplete="off" placeholder={k.saved ? 'Saved · type to replace' : 'Paste key'} value={k.apiKey} onChange={(x) => editKey(k.id, { apiKey: x.target.value })} onBlur={() => k.apiKey.trim() && LISTS_VOICES.includes(k.provider) && (k.provider !== 'azure' || k.region) && listVoices(k)} /></label>
          {k.provider === 'azure' && <label className="fld"><span className="k">Region</span><input className="in" type="text" placeholder="eastus, southeastasia…" value={k.region} onChange={(x) => editKey(k.id, { region: x.target.value.trim().toLowerCase() })} /></label>}
          {p.id === 'other' && <label className="fld"><span className="k">Base URL</span><input className="in" type="url" placeholder="https://api.groq.com/openai/v1" value={k.baseUrl} onChange={(x) => editKey(k.id, { baseUrl: x.target.value })} /></label>}
        </div>
        <div className="eng-fields">
          <label className="fld"><span className="k">Voice</span>
            {voices.length
              ? <select className="in" value={k.voice} onChange={(x) => editKey(k.id, { voice: x.target.value })}>
                  {k.provider === 'fishaudio' && <option value="">Fish Audio’s default voice</option>}
                  {!voices.some((o) => o.id === k.voice) && (k.voice || k.provider !== 'fishaudio') && <option value={k.voice}>{k.voice ? `${k.voice} · not in the list` : 'Choose a voice'}</option>}
                  {voices.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                </select>
              : <input className="in" type="text" placeholder={k.provider === 'openai' ? 'Voice name, such as alloy' : k.provider === 'fishaudio' ? 'Voice id from fish.audio, or empty for the default' : 'List voices, or type its id'} value={k.voice} onChange={(x) => editKey(k.id, { voice: x.target.value })} />}
          </label>
          {(p.models || p.id === 'other') && <label className="fld"><span className="k">Model</span>
            {p.models
              ? <select className="in" value={k.model} onChange={(x) => editKey(k.id, { model: x.target.value })}>{p.models.map((m) => <option key={m} value={m}>{m}</option>)}</select>
              : <input className="in" type="text" placeholder="As listed by the service" value={k.model} onChange={(x) => editKey(k.id, { model: x.target.value })} />}
          </label>}
          {LISTS_VOICES.includes(k.provider) && <button type="button" className="bt" onClick={() => listVoices(k)} disabled={!!ml?.busy || (!k.apiKey.trim() && !k.saved)}>{ml?.busy ? 'Listing…' : 'List voices'}</button>}
        </div>
        <div className="eng-fields">
          {previewBtn(v, !k.apiKey.trim() && !k.saved)}
          <button type="button" className={'bt' + (confirm === k.id ? ' danger' : '')} onClick={() => removeKey(k)} onBlur={() => confirm === k.id && setConfirm('')}>{confirm === k.id ? 'Tap again to remove' : 'Remove'}</button>
        </div>
        {ml?.err && <p className="hint vrow-warn">{ml.err}</p>}
        <p className="hint">{p.note}</p>
      </div>
    );
  };
  const settings = (v: VoiceSource) => {
    const k = keyOf(v);
    if (k?.provided) return (
      <div className="eng-fields col">
        <p className="hint">Included with your plan: there’s no key to manage. Switch it off if you’d rather Niko didn’t use it.</p>
        <div className="eng-fields">{previewBtn(v)}</div>
      </div>
    );
    if (k) return keySettings(k);
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
    return (
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
  };
  const name = (v: VoiceSource) => { const k = keyOf(v); return k ? k.label || presetInfo(k).name : voiceName(v); };
  const sub = (v: VoiceSource) => {
    const k = keyOf(v);
    if (!k) return VOICE_INFO[v as Builtin]?.sub ?? '';
    const vn = (lists[k.id]?.list ?? presetInfo(k).voices ?? []).find((o) => o.id === k.voice)?.name ?? k.voice;
    return [presetInfo(k).name, vn || (k.provider === 'fishaudio' ? 'default voice' : 'voice not set')].join(' · ') + (k.saved ? '' : ' · not saved yet');
  };
  const tag = (v: VoiceSource) => (vProv(v) ? 'Included' : keyOf(v) ? 'Your key' : VOICE_INFO[v as Builtin]?.tag ?? '');
  const row = (v: VoiceSource, i: number | null) => {
    const on = i !== null, resting = on ? voiceRestLine(me.engine.voiceRest?.[v]) : '';
    return (
      <li key={v} className={'vrow' + (on ? ' on' : '')}>
        <div className="vrow-head">
          <span className="n" aria-hidden="true">{on ? i + 1 : '–'}</span>
          <button type="button" className="vrow-title" aria-expanded={open === v} onClick={() => { const k = keyOf(v); if (open !== v && k?.saved && !lists[k.id] && LISTS_VOICES.includes(k.provider)) void listVoices(k); setOpen(open === v ? null : v); }}>
            <b>{name(v)}</b><span className="sub">{sub(v)}</span>
            {v !== 'kokoro' && <UsageLines usage={usage} kind="voice" entry={v} provided={keyOf(v)?.provided} service={keyOf(v) ? presetInfo(keyOf(v)!).name : undefined} />}
            {resting && <span className="sub vrow-warn">{resting}</span>}
            {v === 'kokoro' && on && !kReady && kokoroSupported() && <span className="sub vrow-warn">Not downloaded on this device yet, so Niko skips it here.</span>}
            {v === 'kokoro' && on && kReady && kokoroTooSlow() && <span className="sub vrow-warn">Too slow on this device to keep up while speaking, so Niko skips it here.</span>}
            {v === 'kokoro' && !kokoroSupported() && <span className="sub vrow-warn">This browser cannot run it.</span>}
          </button>
          <span className={'k tag' + (vProv(v) ? ' inc' : '')}>{tag(v)}</span>
          {on && <span className="vrow-move">
            <button type="button" className="stp" onClick={() => move(v, -1)} disabled={!canUp(v, i)} aria-label={`Move ${name(v)} up`}>↑</button>
            <button type="button" className="stp" onClick={() => move(v, 1)} disabled={!canDown(v, i)} aria-label={`Move ${name(v)} down`}>↓</button>
          </span>}
          <Switch on={on} onChange={(x) => toggle(v, x)} label={`Use ${name(v)}`} />
        </div>
        {open === v && <div className="vrow-body">{settings(v)}</div>}
      </li>
    );
  };

  return (
    <SettingsPage title="Voice" sub="How Niko speaks to you, and how it listens." action={<button className="pri set-save" onClick={save} disabled={busy === 'save'}>{busy === 'save' ? 'Saving…' : 'Save changes'}</button>}>
      <NoteLine note={note} />
      {usage && <AccountInfo usage={usage} />}
      {usage && <IncludedCard usage={usage} kinds={['voice', 'hear']} other={{ to: '/engine', label: 'Answers, pictures and maps are on the Engine page' }} />}
      <div className="eng-grid">
        {off.includes('sec:voices') ? (
          <section className="g eng-card" aria-label="Speech out">
            <span className="k" style={{ paddingBottom: 6 }}>Speech out</span>
            <div className="vrow on last"><div className="vrow-head">
              <span className="vrow-title static"><b>{VOICE_NAMES.device}</b><span className="sub">Niko speaks with this device’s own voice. Other voices aren’t included in your plan.</span></span>
              {previewBtn('device')}
            </div></div>
          </section>
        ) : (
        <section className="g eng-card" aria-label="Speech out">
          <span className="k" style={{ paddingBottom: 6 }}>Speech out · Niko uses in this order</span>
          <MonthLine usage={usage} kind="voice" />
          <p className="hint" style={{ paddingBottom: 8 }}>Niko speaks with the first voice that works. When one reaches its usage limit, refuses its key or stops answering, the next one speaks straight away, and Niko goes back to it once it has reset.</p>
          <ol className="vlist">
            {shown.map((v, i) => row(v, i))}
            <li className="vrow on last">
              <div className="vrow-head">
                <span className="n" aria-hidden="true">{shown.length + 1}</span>
                <span className="vrow-title static"><b>{VOICE_NAMES.device}</b><span className="sub">Built into this device. Always last, so Niko can always speak. Not counted.</span></span>
                <span className="k tag">On this device</span>
                {previewBtn('device')}
              </div>
            </li>
          </ol>
          {vPresets.length > 0 && <button type="button" className="bt add-key" onClick={addKey} disabled={keys.filter((k) => !k.provided).length >= MAX_VOICE_KEYS}><Icon name="plus" size={18} />Add a voice API key</button>}
          {others.length > 0 && <>
            <span className="k" style={{ padding: '18px 0 6px' }}>Not in use</span>
            <ul className="vlist">{others.map((v) => row(v, null))}</ul>
          </>}
          {managedIn(off, 'voices') && <p className="hint managed">{MANAGED}</p>}
        </section>
        )}
        <section className="g eng-card listen" aria-label="Listening">
          {off.includes('sec:hears') ? <>
          <span className="k" style={{ paddingBottom: 2 }}>Listening · speech in</span>
          <p className="hint">This browser’s own speech recognition turns what you say into words. Other speech-in services aren’t included in your plan.</p>
          </> : <>
          <span className="k" style={{ paddingBottom: 2 }}>Listening · speech in · Niko uses in this order</span>
          <MonthLine usage={usage} kind="hear" />
          <p className="hint">After you tap the mic or say “Niko”, your request is recorded and turned into words by the first service that works. When one reaches its limit or fails, the next one is used.</p>
          <ol className="vlist">
            {hShown.map((v, i) => hRow(v, i))}
            <li className="vrow on last">
              <div className="vrow-head">
                <span className="n" aria-hidden="true">{hShown.length + 1}</span>
                <span className="vrow-title static"><b>Device speech recognition</b><span className="sub">Built into this browser. Always last, and always the one that listens for “Niko”, so nothing is sent while you are not talking to Niko. Not counted.</span></span>
                <span className="k tag">On this device</span>
              </div>
            </li>
          </ol>
          {hPresets.length > 0 && <button type="button" className="bt add-key" onClick={addHKey} disabled={hKeys.filter((k) => !k.provided).length >= MAX_HEAR_KEYS}><Icon name="plus" size={18} />Add a speech-in API key</button>}
          {hOthers.length > 0 && <>
            <span className="k" style={{ padding: '14px 0 4px' }}>Not in use</span>
            <ul className="vlist">{hOthers.map((v) => hRow(v, null))}</ul>
          </>}
          {managedIn(off, 'hears') && <p className="hint managed">{MANAGED}</p>}
          </>}
          <div className="eng-line"><span>Wake when I say “Niko”</span><Switch on={!!e.wake} onChange={(x) => set({ wake: x })} label="Wake when I say Niko" /></div>
          <div className="eng-line"><span>After Niko answers, keep listening for a few seconds so you can carry on talking</span><span className="k later">On</span></div>
          <div className="eng-line"><span>Respond only to my voice <span className="k soon">Not available yet</span></span><Switch on={false} onChange={() => undefined} label="Respond only to my voice" disabled /></div>
          <p className="hint">Keys are encrypted on the server, never stored in this browser, and never shown again after saving. Recordings go to the service once and are never stored. Two keys from the same account share one allowance, so a backup helps most when it is from another account or service.</p>
        </section>
      </div>
    </SettingsPage>
  );
}

// ---------------------------------------------------------------- appearance and account
const hex = (h: number) => { const f = (n: number) => { const k = (n + h / 30) % 12, v = 0.72 - 0.9 * 0.28 * Math.max(-1, Math.min(k - 3, 9 - k, 1)); return ('0' + Math.round(v * 255).toString(16)).slice(-2); }; return ('#' + f(0) + f(8) + f(4)).toUpperCase(); };

const PREVIEW_STEP_MS = 2500;

const clockOf = (ms: number) => (new Date(ms).toDateString() === new Date().toDateString() ? '' : `${new Date(ms).toLocaleDateString([], { weekday: 'short' })} `) + new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

export function Appearance() {
  const { me, refreshMe } = useNiko();
  const [a, setA] = useState<Look | null>(me?.appearance ?? null);
  const [saved, setSaved] = useState(false);
  const [tick, setTick] = useState(0);
  const [checks, setChecks] = useState<{ checked: Record<string, number>; every: Record<string, number> } | null>(null);
  useEffect(() => { if (me && !a) setA(me.appearance); }, [me, a]);
  useEffect(() => { if (cleanGlancePrefs(me?.appearance.glance).on) api<{ checked: Record<string, number>; every: Record<string, number> }>('/glance/status').then(setChecks).catch(() => undefined); }, [me]);
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
  // New items on Home: the person's own choices, never more often than the admin allows.
  const limits = me?.glanceLimits ?? GLANCE_LIMIT_DEFAULTS;
  const g = cleanGlancePrefs(a.glance);
  const upG = (p: Partial<GlancePrefs>) => up({ glance: { ...g, ...p } });
  const every = (m: number) => (m === 60 ? 'Every hour' : m === 1 ? 'Every minute' : `Every ${m} minutes`);
  return (
    <SettingsPage title="Appearance" sub="Your own background, and how long lists are shown. The particles and accents follow your colours." action={<button className="pri set-save" onClick={save}>{saved ? 'Saved' : 'Save'}</button>}>
      <section className="set-card set-niko" aria-label="Your Niko" style={{ marginBottom: 20 }}>
        <span className="set-niko-thumb"><DesignPreview design={me?.design ?? 'nebula'} particles={me?.design && me.design !== 'nebula' ? undefined : 420} /></span>
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span className="k">Your Niko</span>
          <b style={{ fontWeight: 500, fontSize: 18 }}>{designInfo(me?.design ?? 'nebula').name}</b>
          <span className="hint">How the core looks on Home and everywhere else.</span>
        </div>
        <Link to="/niko" className="sec" style={{ height: 44, fontSize: 14 }}>Choose your Niko</Link>
      </section>
      <div className="set-grid">
        <section className="set-card" aria-label="Background settings">
          <div className="grp">
            <span className="k">Background</span>
            <div style={{ display: 'flex', gap: 10 }}>
              <button className="seg" aria-pressed={a.mode === 'shift'} onClick={() => up({ mode: 'shift' })}>Shift colours</button>
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
          <div className="grp">
            <span className="k">Items per page · Inbox, Calendar and Notes</span>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }} role="group" aria-label="Items per page">
              {PAGE_SIZES.map((n) => <button key={n} className="seg" aria-pressed={(a.pageSize ?? 10) === n} onClick={() => up({ pageSize: n })}>{n}</button>)}
            </div>
            <span className="hint">Up to 50 of each are fetched. Say “next page”, “page 3” or “last page” to move between pages.</span>
          </div>
          <p className="set-note">Saved to your account and used on all your devices. Other users keep their own settings.</p>
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
          {limits.allowed && <div className="grp glance-set" role="group" aria-label="New items on Home">
            <div className="eng-line"><span><b style={{ fontWeight: 500 }}>Show new items on Home</b><br /><span className="hint">New emails, messages, calendar events and changed notes appear for 30 seconds, then go. Only new ones: nothing you have already read or seen.</span></span><Switch on={g.on} onChange={(x) => upG({ on: x })} label="Show new items on Home" /></div>
            {g.on && <>
              <div className="eng-line"><span>Read them aloud</span><Switch on={g.aloud} onChange={(x) => upG({ aloud: x })} label="Read new items aloud" /></div>
              <span className="k" style={{ paddingTop: 6 }}>How often Niko checks</span>
              {GLANCE_PARTS.map((p: GlancePart) => {
                const min = limits[p], value = glanceEvery(g, limits, p);
                return (
                  <label key={p} className="eng-line"><span>{GLANCE_PART_NAMES[p]}{!min && <span className="hint"> · not available on your account</span>}</span>
                    <select className="in glance-sel" value={min ? value : 0} disabled={!min} onChange={(x) => upG({ [p]: Number(x.target.value) } as Partial<GlancePrefs>)}>
                      <option value={0}>Off</option>
                      {GLANCE_STEPS.filter((m) => m >= min).map((m) => <option key={m} value={m}>{every(m)}</option>)}
                    </select>
                  </label>
                );
              })}
              <label className="eng-line"><span>Remind me before events</span>
                <select className="in glance-sel" value={glanceEvery(g, limits, 'events') ? g.remind : 0} disabled={!glanceEvery(g, limits, 'events')} onChange={(x) => upG({ remind: Number(x.target.value) || GLANCE_REMIND_STEPS[0]! })}>
                  {!glanceEvery(g, limits, 'events') && <option value={0}>Calendar checks are off</option>}
                  {GLANCE_REMIND_STEPS.map((m) => <option key={m} value={m}>{m} minutes before</option>)}
                </select>
              </label>
              {checks && cleanGlancePrefs(me?.appearance.glance).on && <span className="hint glance-last">Last checked: {GLANCE_PARTS.map((p) => `${GLANCE_PART_NAMES[p]} ${!checks.every[p] ? 'off' : checks.checked[p] ? clockOf(checks.checked[p]!) : 'not yet'}`).join(' · ')}. Checks run while Home is open; the first one only learns what is already there.</span>}
              <span className="hint">Niko checks only while Home is open and on screen, and pauses after 30 minutes without use. Messages from Telegram and Slack arrive straight away; less often is kinder to your email provider. {GLANCE_PARTS.some((p) => limits[p] > 1) ? 'Your administrator sets how often checks may run.' : ''} Changes to notes you make yourself in Notion aren’t shown; OneNote doesn’t say who changed a page, so all its changes are.</span>
            </>}
          </div>}
        </section>
      </div>
    </SettingsPage>
  );
}

// Changing the password: the current one first. Other devices are signed out; this one stays signed in.
function ChangePassword({ email, onDone, onCancel }: { email: string; onDone: () => void; onCancel: () => void }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setErr(''); setBusy(true);
    try { await api('/me/password', { body: { current, password: next } }); onDone(); }
    catch (x: any) { setErr(x.message ?? 'That did not work.'); } finally { setBusy(false); }
  };
  return (
    <form onSubmit={save} className="cal-form">
      <h2 className="sheet-h">Change password</h2>
      <p className="sub">Other devices are signed out when you change it. This one stays signed in.</p>
      {/* For password managers: which account this is. */}
      <input type="email" name="username" autoComplete="username" value={email} readOnly hidden />
      <PasswordField label="Current password" autoComplete="current-password" value={current} onChange={(v) => { setErr(''); setCurrent(v); }} />
      <PasswordField label="New password" autoComplete="new-password" value={next} onChange={(v) => { setErr(''); setNext(v); }} meter />
      {err && <p className="err" role="alert">{err}</p>}
      <div className="sheet-actions">
        <button type="button" className="sec" onClick={onCancel}>Cancel</button>
        <button className="pri" disabled={busy || !current || !next}>{busy ? 'Saving…' : 'Change password'}</button>
      </div>
      {sent ? <p className="ok cal-keep" role="status">A reset link is on its way to {email}. It works once, for 30 minutes.</p>
        : <button type="button" className="lnk cal-keep" style={{ alignSelf: 'flex-start' }} onClick={async () => { await api('/auth/forgot', { body: { email } }).catch(() => undefined); setSent(true); }}>Forgot your current password? Email me a reset link</button>}
    </form>
  );
}

export function Account() {
  const [keys, setKeys] = useState<{ id: string; label: string; rpId: string }[]>([]);
  const { me, refreshMe } = useNiko();
  const pwDlg = useRef<HTMLDialogElement>(null);
  const [pwOpen, setPwOpen] = useState(false);
  const [naming, setNaming] = useState<string | null>(null);
  const saveName = async (e: FormEvent) => {
    e.preventDefault();
    if (naming === null) return;
    try { await api('/me', { method: 'PATCH', body: { name: naming.trim() } }); await refreshMe(); setNaming(null); setNote({ ok: true, text: 'Name saved.' }); }
    catch (x: any) { setNote({ ok: false, text: x.message }); }
  };
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
    <SettingsPage title="Account" sub="Your sign-in details, billing and passkeys.">
      {note && <p className={note.ok ? 'ok' : 'err'} role="status">{note.text}</p>}
      <div className="set-grid acct-grid">
        <section className="set-card" aria-label="You">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}><span className="k">You</span>{me?.role === 'admin' && <span className="k">Admin</span>}</div>
          {naming === null ? (
            <div className="row"><span className="txt"><b>{me?.name || 'No name set'}</b><span className="sub">{me?.email}</span></span>
              <button className="bt" onClick={() => setNaming(me?.name ?? '')}>Edit name</button></div>
          ) : (
            <form className="acct-name" onSubmit={saveName}>
              <Field label="Name"><input className="in" autoFocus maxLength={80} autoComplete="name" value={naming} onChange={(e) => setNaming(e.target.value)} /></Field>
              <div className="sheet-actions"><button type="button" className="sec" onClick={() => setNaming(null)}>Cancel</button><button className="pri">Save</button></div>
            </form>
          )}
          <div className="row"><Icon name="lock" /><span className="txt"><b>Password</b><span className="sub">Used with your email to sign in</span></span>
            <button className="bt" onClick={() => { setNote(null); setPwOpen(true); pwDlg.current?.showModal(); }}>Change</button></div>
          <dialog ref={pwDlg} className="sheet" onClose={() => setPwOpen(false)}>
            {pwOpen && me && <ChangePassword email={me.email} onCancel={() => pwDlg.current?.close()} onDone={() => { pwDlg.current?.close(); setNote({ ok: true, text: 'Password changed. Other devices were signed out, and an email was sent to confirm it.' }); }} />}
          </dialog>
        </section>
        <BillingCard />
        <ScreenLock key={keys.length} onNote={setNote} />
        <section className="set-card" aria-label="Passkeys">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}><span className="k">Passkeys</span><span className="hint">For signing in only</span></div>
          {keys.length === 0 && <p className="sub">No passkeys yet.</p>}
          {keys.map((k) => (
            <div key={k.id} className="row"><Icon name="key" /><span className="txt"><b>{k.label}</b><span className="sub">Works on {k.rpId}</span></span>
              <button className="bt" onClick={async () => { await api(`/me/passkeys/${k.id}`, { method: 'DELETE' }); await load(); }}>Remove</button></div>
          ))}
          <button className="pri" style={{ alignSelf: 'flex-start' }} onClick={add}><Icon name="key" size={20} />Add a passkey</button>
          <p className="set-note">This passkey will work on {rpId || 'this address'} only. Add one on each address you use Niko from.</p>
        </section>
      </div>
    </SettingsPage>
  );
}
