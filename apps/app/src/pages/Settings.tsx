// Settings: one area with a shared sidebar (Appearance, Voice, Connections, Engine, Account) and a way back to Niko.
import { startRegistration } from '@simplewebauthn/browser';
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { COLOURS, GROUPS, type AppDef, type Appearance as Look, type EnginePrefs, type Permissions, type ProviderDef } from '@niko/shared';
import { api, Field, Icon, setAppearance, Switch } from '@niko/ui';
import { useNiko } from '../niko';

function useMedia(q: string) {
  const [on, setOn] = useState(() => typeof window !== 'undefined' && window.matchMedia(q).matches);
  useEffect(() => { const m = window.matchMedia(q); const f = () => setOn(m.matches); m.addEventListener('change', f); return () => m.removeEventListener('change', f); }, [q]);
  return on;
}

type Prov = ProviderDef & { linked: boolean; configured: boolean; label: string | null; readsGroups?: boolean | null };
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
      <main key={pathname} className="set-main hud-in"><Outlet /></main>
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
function useLinks() {
  const [linked, setLinked] = useState<Record<string, boolean>>({});
  const load = useCallback(() => api<{ providers: Prov[] }>('/connections?all=1').then((r) => setLinked(Object.fromEntries(r.providers.map((p) => [p.id, p.linked])))).catch(() => undefined), []);
  useEffect(() => { void load(); }, [load]);
  return { linked, reload: load };
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
  const saveApp = async (e: FormEvent) => {
    e.preventDefault();
    if (!appForm) return;
    const { app, then } = appForm;
    try {
      await api(`/apps/${app.id}`, { method: 'PUT', body: values });
      setValues({}); appDlg.current?.close();
      if (then) return signIn(then);
      await load();
      setNote({ ok: true, text: `Your ${app.name} app keys are saved. Connect ${app.uses.join(', ')} again to sign in with them.` });
    } catch (x: any) { setNote({ ok: false, text: x.message }); appDlg.current?.close(); }
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
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!form) return;
    try {
      const r = await api<{ inboundUrl?: string; signingSecret?: string; readsGroups?: boolean }>(`/connections/${form.id}`, { body: values });
      setValues({});
      if (form.id === 'telegram-bot' || form.id === 'telegram-user') await refreshMe();
      await load();
      if (r.inboundUrl && r.signingSecret) setShown({ inboundUrl: r.inboundUrl, signingSecret: r.signingSecret });
      else { dlg.current?.close(); setNote({ ok: true, text: `${form.name} linked.` }); }
    } catch (x: any) { setNote({ ok: false, text: x.message }); dlg.current?.close(); }
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

      <dialog ref={appDlg} className="sheet" onClose={() => setAppForm(null)}>
        {appForm && (
          <form onSubmit={saveApp}>
            <h2 style={{ fontWeight: 500, fontSize: 24 }}>{appForm.then ? `Connect ${appForm.then.name}` : `Your ${appForm.app.name} app keys`}</h2>
            <p className="sub">{appForm.then ? `First time only: ` : ''}Niko signs in to {appForm.app.uses.join(', ')} through an app you register yourself with {appForm.app.name}, so your data never passes through anyone else’s app. {appForm.app.where}</p>
            {redirects.map((r, i) => (
              <Field key={r} label={i === 0 ? 'Redirect address to register (add each one)' : 'Redirect address'}><input className="in mono" readOnly value={r} onFocus={(e) => e.currentTarget.select()} /></Field>
            ))}
            {appForm.app.eventsUrl && <Field label="Event request address (to receive messages)"><input className="in mono" readOnly value={appForm.app.eventsUrl} onFocus={(e) => e.currentTarget.select()} /></Field>}
            {appForm.app.fields.map((f) => (
              <Field key={f.key} label={f.label + (f.optional ? ' · optional' : '')}><input className="in" type={f.type === 'password' ? 'password' : 'text'} autoComplete="off" spellCheck={false} placeholder={f.placeholder ?? (appForm.app.configured ? 'Saved · type to replace' : undefined)} required={!f.optional && !appForm.app.configured} value={values[f.key] ?? ''} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })} /></Field>
            ))}
            <p className="sub">Stored encrypted and never shown again.{appForm.app.configured ? ' Saving new keys removes the links made with the old ones.' : ''}</p>
            <div className="sheet-actions"><button type="button" className="sec" onClick={() => appDlg.current?.close()}>Cancel</button><button className="pri">{appForm.then ? 'Save and sign in' : 'Save'}</button></div>
            {appForm.app.configured && <button type="button" className="lnk" style={{ alignSelf: 'flex-start' }} onClick={() => (confirmRemove === appForm.app.id ? removeApp(appForm.app) : setConfirmRemove(appForm.app.id))}>{confirmRemove === appForm.app.id ? `Confirm: remove your ${appForm.app.name} keys and the links made with them` : `Remove your ${appForm.app.name} app keys`}</button>}
          </form>
        )}
      </dialog>

      <dialog ref={dlg} className="sheet" onClose={() => setForm(null)}>
        {form && !shown && (
          <form onSubmit={submit}>
            <h2 style={{ fontWeight: 500, fontSize: 24 }}>Connect {form.name}</h2>
            <p className="sub">{form.how}. Stored encrypted; you can remove it at any time.</p>
            {form.id === 'telegram-bot' && <p className="sub">Tip: so the bot can read whole group chats, turn off its group privacy first: @BotFather → /setprivacy → your bot → Disable.</p>}
            {form.fields?.map((f) => (
              <Field key={f.key} label={f.label}><input className="in" type={f.type === 'password' ? 'password' : f.type === 'url' ? 'url' : 'text'} autoComplete="off" placeholder={f.placeholder} value={values[f.key] ?? ''} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })} /></Field>
            ))}
            <div className="sheet-actions"><button type="button" className="sec" onClick={() => dlg.current?.close()}>Cancel</button><button className="pri">Connect</button></div>
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

// ---------------------------------------------------------------- engine (the brain)
const AI_BASES: Record<string, string> = { openai: 'https://api.openai.com/v1', anthropic: 'https://api.anthropic.com/v1', google: 'https://generativelanguage.googleapis.com/v1beta/openai' };

function Opt({ on, onClick, title, sub, tag }: { on: boolean; onClick: () => void; title: string; sub: string; tag?: string }) {
  return <button className="opt" aria-pressed={on} onClick={onClick}><i /><span className="txt"><b>{title}</b><span className="sub">{sub}</span></span>{tag && <span className="k tag">{tag}</span>}</button>;
}

export function Engine() {
  const { me, refreshMe } = useNiko();
  const { linked, reload } = useLinks();
  const [e, setE] = useState<EnginePrefs | null>(null);
  const [ai, setAi] = useState({ provider: 'openai', model: '', baseUrl: AI_BASES.openai!, apiKey: '' });
  const [self, setSelf] = useState({ baseUrl: '', model: '' });
  const [note, setNote] = useState<Note>(null);
  const [busy, setBusy] = useState('');
  const [dirty, setDirty] = useState<Record<string, boolean>>({});
  useEffect(() => { if (me && !e) setE({ model: 'fast', ...me.engine }); }, [me, e]);
  if (!me || !e) return null;
  const set = (p: Partial<EnginePrefs>) => setE({ ...e, ...p });
  const editAi = (p: Partial<typeof ai>) => { setDirty((d) => ({ ...d, ai: true })); setAi({ ...ai, ...p }); };
  const editSelf = (p: Partial<typeof self>) => { setDirty((d) => ({ ...d, self: true })); setSelf({ ...self, ...p }); };

  const save = async () => {
    setNote(null); setBusy('save');
    try {
      if (dirty.ai && (ai.apiKey.trim() || linked['custom-ai'])) await api('/connections/custom-ai', { body: { baseUrl: ai.baseUrl, apiKey: ai.apiKey, model: ai.model } });
      if (dirty.self && self.baseUrl.trim()) await api('/connections/self-hosted-ai', { body: { baseUrl: self.baseUrl, model: self.model } });
      const need = e.brain === 'custom-ai' && !linked['custom-ai'] && !ai.apiKey.trim() ? 'Add an API key for your own AI first.'
        : e.brain === 'self-hosted-ai' && !linked['self-hosted-ai'] && !self.baseUrl.trim() ? 'Add your server address first.' : '';
      if (need) throw new Error(need);
      await api('/me', { method: 'PATCH', body: { engine: { brain: e.brain, model: e.model, fallback: e.fallback } } });
      await Promise.all([refreshMe(), reload()]);
      setAi((v) => ({ ...v, apiKey: '' })); setDirty({});
      setNote({ ok: true, text: 'Saved.' });
    } catch (x: any) { setNote({ ok: false, text: x.message }); } finally { setBusy(''); }
  };
  const test = async (brain: EnginePrefs['brain']) => {
    setNote(null); setBusy('test-' + brain);
    try { const r = await api<{ ms: number }>('/engine/test', { body: { brain, model: e.model } }); setNote({ ok: true, text: `Connected. It answered in ${(r.ms / 1000).toFixed(1)} s.` }); }
    catch (x: any) { setNote({ ok: false, text: x.message }); } finally { setBusy(''); }
  };
  const saved = (id: string) => (linked[id] ? 'Saved · type to replace' : '');
  return (
    <SettingsPage title="Engine" sub="What Niko thinks with. You can change it at any time." action={<button className="pri set-save" onClick={save} disabled={busy === 'save'}>{busy === 'save' ? 'Saving…' : 'Save changes'}</button>}>
      <NoteLine note={note} />
      <section className="g eng-card wide" aria-label="Brain">
        <span className="k" style={{ paddingBottom: 6 }}>Brain · language model</span>
        <div className="eng-opt">
          <Opt on={e.brain === 'workers-ai'} onClick={() => set({ brain: 'workers-ai' })} title="Cloudflare Workers AI" sub="Open models on Cloudflare’s network. Free up to a daily limit. Nothing to set up." tag="Free tier" />
          {e.brain === 'workers-ai' && (
            <div className="eng-fields">
              <label className="fld"><span className="k">Model</span><select className="in" value={e.model ?? 'fast'} onChange={(x) => set({ model: x.target.value === 'large' ? 'large' : 'fast' })}><option value="fast">Recommended · fast chat model</option><option value="large">Larger · slower, better reasoning</option></select></label>
              <button className="bt" onClick={() => test('workers-ai')} disabled={!!busy}>{busy === 'test-workers-ai' ? 'Testing…' : 'Test connection'}</button>
            </div>
          )}
        </div>
        <div className="eng-opt">
          <Opt on={e.brain === 'custom-ai'} onClick={() => set({ brain: 'custom-ai' })} title="Your own AI key" sub="OpenAI, Anthropic, Google, or any OpenAI-compatible endpoint." />
          {e.brain === 'custom-ai' && (
            <div className="eng-fields col">
              <div className="eng-fields">
                <label className="fld"><span className="k">Provider</span><select className="in" value={ai.provider} onChange={(x) => editAi({ provider: x.target.value, baseUrl: AI_BASES[x.target.value] ?? ai.baseUrl })}><option value="openai">OpenAI-compatible</option><option value="anthropic">Anthropic</option><option value="google">Google</option></select></label>
                <label className="fld"><span className="k">Model name</span><input className="in" type="text" placeholder={linked['custom-ai'] ? 'Saved · type to replace' : 'As listed by your provider'} value={ai.model} onChange={(x) => editAi({ model: x.target.value })} /></label>
              </div>
              <div className="eng-fields">
                <label className="fld"><span className="k">Base URL</span><input className="in" type="url" placeholder="https://" value={ai.baseUrl} onChange={(x) => editAi({ baseUrl: x.target.value })} /></label>
                <label className="fld"><span className="k">AI API key</span><input className="in" type="password" autoComplete="off" placeholder={saved('custom-ai') || 'Paste key'} value={ai.apiKey} onChange={(x) => editAi({ apiKey: x.target.value })} /></label>
                <button className="bt" onClick={() => test('custom-ai')} disabled={!!busy || !linked['custom-ai']} title={linked['custom-ai'] ? undefined : 'Save first'}>{busy === 'test-custom-ai' ? 'Testing…' : 'Test connection'}</button>
              </div>
            </div>
          )}
        </div>
        <div className="eng-opt">
          <Opt on={e.brain === 'self-hosted-ai'} onClick={() => set({ brain: 'self-hosted-ai' })} title="Self-hosted model" sub="A model server you run, such as on your NAS, reachable at a public https address." />
          {e.brain === 'self-hosted-ai' && (
            <div className="eng-fields">
              <label className="fld"><span className="k">Server address</span><input className="in" type="url" placeholder={saved('self-hosted-ai') || 'https://'} value={self.baseUrl} onChange={(x) => editSelf({ baseUrl: x.target.value })} /></label>
              <label className="fld"><span className="k">Model name · optional</span><input className="in" type="text" value={self.model} onChange={(x) => editSelf({ model: x.target.value })} /></label>
              <button className="bt" onClick={() => test('self-hosted-ai')} disabled={!!busy || !linked['self-hosted-ai']} title={linked['self-hosted-ai'] ? undefined : 'Save first'}>{busy === 'test-self-hosted-ai' ? 'Testing…' : 'Test connection'}</button>
            </div>
          )}
        </div>
        <label className="eng-check"><input type="checkbox" checked={e.fallback !== false} onChange={(x) => set({ fallback: x.target.checked })} />If the chosen engine fails or reaches its limit, fall back to Workers AI.</label>
      </section>
      <p className="g eng-keys"><Icon name="shield" size={20} />Keys are encrypted on the server, never stored in this browser, and never shown again after saving. The voice (ElevenLabs) is set under Voice.</p>
    </SettingsPage>
  );
}

// ---------------------------------------------------------------- voice (speech out, speech in)
export function Voice() {
  const { me, refreshMe } = useNiko();
  const { linked, reload } = useLinks();
  const [e, setE] = useState<EnginePrefs | null>(null);
  const [el, setEl] = useState({ apiKey: '', voiceId: '' });
  const [voices, setVoices] = useState<{ id: string; name: string; cloned: boolean }[]>([]);
  const [note, setNote] = useState<Note>(null);
  const [busy, setBusy] = useState('');
  const [dirty, setDirty] = useState(false);
  useEffect(() => { if (me && !e) setE({ ...me.engine }); }, [me, e]);
  const listVoices = useCallback(async (apiKey?: string) => {
    try {
      const r = await api<{ voices: { id: string; name: string; cloned: boolean }[] }>('/voice/voices', { body: { apiKey: apiKey || undefined } });
      const list = Array.isArray(r.voices) ? r.voices : [];
      setVoices(list);
      setEl((v) => (v.voiceId || !list[0] ? v : { ...v, voiceId: (list.find((x) => x.cloned) ?? list[0])!.id }));
    } catch (x: any) { setNote({ ok: false, text: x.message }); }
  }, []);
  useEffect(() => { if (linked.elevenlabs) void listVoices(); }, [linked.elevenlabs, listVoices]);
  if (!me || !e) return null;
  const set = (p: Partial<EnginePrefs>) => setE({ ...e, ...p });
  const editEl = (p: Partial<typeof el>) => { setDirty(true); setEl({ ...el, ...p }); };

  const save = async () => {
    setNote(null); setBusy('save');
    try {
      if (dirty && (el.apiKey.trim() || linked.elevenlabs)) await api('/connections/elevenlabs', { body: { apiKey: el.apiKey, voiceId: el.voiceId } });
      if (e.voice === 'elevenlabs' && !linked.elevenlabs && !el.apiKey.trim()) throw new Error('Add your ElevenLabs API key first.');
      await api('/me', { method: 'PATCH', body: { engine: { voice: e.voice, wake: e.wake } } });
      await Promise.all([refreshMe(), reload()]);
      setEl((v) => ({ ...v, apiKey: '' })); setDirty(false);
      setNote({ ok: true, text: 'Saved.' });
    } catch (x: any) { setNote({ ok: false, text: x.message }); } finally { setBusy(''); }
  };
  const preview = async () => {
    setNote(null); setBusy('preview');
    try {
      const res = await fetch('/api/voice/tts', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: `Hi ${me.name || 'there'}, this is how I sound.`, apiKey: el.apiKey || undefined, voiceId: el.voiceId || undefined }) });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? 'ElevenLabs could not play that voice.');
      const url = URL.createObjectURL(await res.blob()); const a = new Audio(url); a.onended = () => URL.revokeObjectURL(url); await a.play();
    } catch (x: any) { setNote({ ok: false, text: x.message }); } finally { setBusy(''); }
  };
  return (
    <SettingsPage title="Voice" sub="How Niko speaks to you, and how it listens." action={<button className="pri set-save" onClick={save} disabled={busy === 'save'}>{busy === 'save' ? 'Saving…' : 'Save changes'}</button>}>
      <NoteLine note={note} />
      <div className="eng-grid">
        <section className="g eng-card" aria-label="Speech out">
          <span className="k" style={{ paddingBottom: 6 }}>Speech out</span>
          <div className="eng-opt">
            <Opt on={e.voice === 'elevenlabs'} onClick={() => set({ voice: 'elevenlabs' })} title="ElevenLabs" sub="Natural speech, including a voice you cloned in ElevenLabs. Needs your ElevenLabs key." />
            {e.voice === 'elevenlabs' && (
              <div className="eng-fields col">
                <label className="fld"><span className="k">ElevenLabs API key</span><input className="in" type="password" autoComplete="off" placeholder={linked.elevenlabs ? 'Saved · type to replace' : 'Paste key'} value={el.apiKey} onChange={(x) => editEl({ apiKey: x.target.value })} onBlur={() => el.apiKey.trim() && listVoices(el.apiKey)} /></label>
                <div className="eng-fields">
                  <label className="fld"><span className="k">Voice</span>
                    <select className="in" value={el.voiceId} onChange={(x) => editEl({ voiceId: x.target.value })} disabled={!voices.length}>
                      {!voices.length && <option value="">Add your key to list your voices</option>}
                      {voices.map((v) => <option key={v.id} value={v.id}>{v.cloned ? `${v.name} · your cloned voice` : v.name}</option>)}
                    </select>
                  </label>
                  <button className="bt" onClick={preview} disabled={!!busy || (!el.apiKey && !linked.elevenlabs)}>{busy === 'preview' ? 'Playing…' : 'Preview voice'}</button>
                </div>
                <p className="hint">The key needs the Text to Speech and Voices permissions. ElevenLabs’ free plan refuses requests from cloud servers such as Niko’s, so a paid plan is needed.</p>
              </div>
            )}
          </div>
          <div className="eng-opt last">
            <Opt on={e.voice === 'device'} onClick={() => set({ voice: 'device' })} title="Device voice" sub="Free and built in. Also used whenever ElevenLabs is unavailable." tag="Free" />
          </div>
        </section>
        <section className="g eng-card listen" aria-label="Listening">
          <span className="k">Listening · speech in</span>
          <label className="fld"><span className="hint">How your voice is turned into text</span><select className="in" value="device" onChange={() => undefined}><option value="device">Device speech recognition · free</option><option value="workers" disabled>Workers AI speech-to-text · not available yet</option></select></label>
          <div className="eng-line"><span>Wake when I say “Niko”</span><Switch on={!!e.wake} onChange={(v) => set({ wake: v })} label="Wake when I say Niko" /></div>
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
    } catch (x: any) { setNote({ ok: false, text: x?.name === 'NotAllowedError' ? 'Adding the passkey was cancelled.' : x.message ?? 'That did not work.' }); }
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
