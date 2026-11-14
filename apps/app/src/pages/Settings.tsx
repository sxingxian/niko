// Connections hub, engine settings, per-user appearance and account (passkeys).
import { startRegistration } from '@simplewebauthn/browser';
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { COLOURS, GROUPS, type Appearance as Look, type EnginePrefs, type Permissions, type ProviderDef } from '@niko/shared';
import { api, Field, Icon, setAppearance, Switch } from '@niko/ui';
import { useNiko } from '../niko';

function Page({ title, right, children }: { title: string; right?: ReactNode; children: ReactNode }) {
  return (
    <div className="page">
      <div className="bg" />
      <header className="page-head" style={{ position: 'relative' }}>
        <span className="wordmark">NIKO</span>
        <Link to="/" className="k" style={{ textDecoration: 'none', padding: '14px 0' }}>← Back</Link>
        <h1>{title}</h1>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>{right}</div>
      </header>
      <div style={{ position: 'relative', display: 'contents' }}>{children}</div>
    </div>
  );
}

type Prov = ProviderDef & { linked: boolean; configured: boolean; label: string | null };

export function Connections() {
  const { me, refreshMe } = useNiko();
  const [list, setList] = useState<Prov[]>([]);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [form, setForm] = useState<Prov | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [shown, setShown] = useState<{ inboundUrl: string; signingSecret: string } | null>(null);
  const dlg = useRef<HTMLDialogElement>(null);
  const [params, setParams] = useSearchParams();

  const load = useCallback(() => api<{ providers: Prov[] }>('/connections').then((r) => setList(r.providers)).catch((e) => setNote({ ok: false, text: e.message })), []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const ok = params.get('linked'), bad = params.get('failed');
    if (ok !== null) setNote({ ok: true, text: 'Linked.' });
    if (bad !== null) setNote({ ok: false, text: 'That sign-in did not complete. Nothing was linked.' });
    if (ok !== null || bad !== null) setParams({}, { replace: true });
  }, [params, setParams]);

  const act = async (p: Prov) => {
    setNote(null);
    if (p.linked) {
      if (p.kind === 'builtin') return;
      await api(`/connections/${p.id}`, { method: 'DELETE' }).catch((e) => setNote({ ok: false, text: e.message }));
      return load();
    }
    if (p.kind === 'planned') return setNote({ ok: false, text: `${p.name} is not built yet.` });
    if (p.kind === 'oauth') {
      try { const r = await api<{ url: string }>(`/connections/${p.id}/oauth`); location.href = r.url; } catch (e: any) { setNote({ ok: false, text: e.message }); }
      return;
    }
    setValues({}); setShown(null); setForm(p); dlg.current?.showModal();
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!form) return;
    try {
      const r = await api<{ inboundUrl: string | null; signingSecret: string | null }>(`/connections/${form.id}`, { body: values });
      await load();
      if (r.inboundUrl && r.signingSecret) setShown({ inboundUrl: r.inboundUrl, signingSecret: r.signingSecret });
      else { dlg.current?.close(); setNote({ ok: true, text: `${form.name} linked.` }); }
    } catch (x: any) { setNote({ ok: false, text: x.message }); dlg.current?.close(); }
  };
  const perm = me?.permissions ?? { draft: true, chatReply: true, files: true };
  const setPerm = async (p: Partial<Permissions>) => { await api('/me', { method: 'PATCH', body: { permissions: p } }); await refreshMe(); };
  const linked = list.filter((p) => p.linked).length;

  const panel = (id: string) => {
    const g = GROUPS.find((x) => x.id === id)!;
    return (
      <section key={id} className="g panel" aria-label={g.name}>
        <header><h2>{g.name}</h2>{id === 'ai' ? <Link to="/engine" className="sub">Engine settings</Link> : <span className="sub">{g.note}</span>}</header>
        {list.filter((p) => p.group === id).map((p) => (
          <div key={p.id} className="row">
            <span className={'dot' + (p.linked ? ' on' : '')} />
            <span className="txt"><b>{p.name}</b><span className="sub">{p.label ?? p.how}{p.kind === 'oauth' && !p.configured ? ' · needs server setup' : ''}{p.linked && !p.can.read && !p.can.send && p.kind !== 'token' ? ' · saved, not used yet' : ''}</span></span>
            {p.kind === 'builtin' ? <span className="k">Built in</span> : p.kind === 'planned' ? <span className="k">Later</span>
              : <button className={'bt' + (p.linked ? '' : ' fill')} onClick={() => act(p)}>{p.linked ? 'Remove' : 'Connect'}</button>}
          </div>
        ))}
      </section>
    );
  };

  return (
    <Page title="Connections" right={<>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}><span className="accent" style={{ fontSize: 32, fontWeight: 500, lineHeight: 1 }}>{linked}</span><span className="k">of {list.length} linked</span></div>
      <span className="g chip" style={{ boxShadow: 'none', cursor: 'default' }}><Icon name="shield" size={18} />Credentials encrypted on the server</span>
    </>}>
      {note && <p className={note.ok ? 'ok' : 'err'} role="status">{note.text}</p>}
      <div className="cols">
        <div className="stack">
          {panel('mail')}
          <section className="g panel" aria-label="What Niko may do">
            <header><h2>What Niko may do</h2></header>
            <div className="row"><span className="txt"><b>Draft replies and invites</b><span className="sub">Prepared for you to review</span></span><Switch on={perm.draft} onChange={(v) => setPerm({ draft: v })} label="Draft replies and invites" /></div>
            <div className="row"><span className="txt"><b>Reply in chat apps</b><span className="sub">Telegram, Slack and Discord</span></span><Switch on={perm.chatReply} onChange={(v) => setPerm({ chatReply: v })} label="Reply in chat apps" /></div>
            <div className="row"><span className="txt"><b>Send and receive images and files</b><span className="sub">Passed straight through, never stored. Only name, size and time are logged.</span></span><Switch on={perm.files} onChange={(v) => setPerm({ files: v })} label="Send and receive images and files" /></div>
            <div className="row"><span className="txt"><b>Send only after I approve</b><span className="sub">Replies: voice with a 10-second countdown. The rest: a tap.</span></span><span className="k" style={{ border: '1px solid rgba(255,255,255,.3)', borderRadius: 999, padding: '6px 12px' }}>Locked</span></div>
          </section>
          <p className="g sub" style={{ padding: '16px 24px', boxShadow: 'none' }}>Removing a link deletes its stored credentials straight away.</p>
        </div>
        <div className="stack">{panel('calendar')}{panel('notes')}{panel('ai')}</div>
        <div className="stack">{panel('automation')}{panel('messaging')}</div>
      </div>

      <dialog ref={dlg} className="sheet" onClose={() => setForm(null)}>
        {form && !shown && (
          <form onSubmit={submit}>
            <h2 style={{ fontWeight: 500, fontSize: 24 }}>Connect {form.name}</h2>
            <p className="sub">{form.how}. Stored encrypted; you can remove it at any time.</p>
            {form.fields?.map((f) => (
              <Field key={f.key} label={f.label}><input className="in" type={f.type === 'password' ? 'password' : f.type === 'url' ? 'url' : 'text'} autoComplete="off" placeholder={f.placeholder} value={values[f.key] ?? ''} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })} /></Field>
            ))}
            <div style={{ display: 'flex', gap: 10 }}><button type="button" className="sec" style={{ flex: 1 }} onClick={() => dlg.current?.close()}>Cancel</button><button className="pri" style={{ flex: 1 }}>Connect</button></div>
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
    </Page>
  );
}

export function Engine() {
  const { me, refreshMe } = useNiko();
  const [links, setLinks] = useState<Record<string, boolean>>({});
  useEffect(() => { api<{ providers: Prov[] }>('/connections').then((r) => setLinks(Object.fromEntries(r.providers.map((p) => [p.id, p.linked])))).catch(() => undefined); }, []);
  if (!me) return null;
  const e = me.engine;
  const set = async (p: Partial<EnginePrefs>) => { await api('/me', { method: 'PATCH', body: { engine: p } }); await refreshMe(); };
  const Opt = ({ on, onClick, title, sub, tag }: { on: boolean; onClick: () => void; title: string; sub: string; tag?: string }) => (
    <div style={{ borderTop: '1px solid rgba(255,255,255,.14)', padding: '8px 0 12px' }}>
      <button className="opt" aria-pressed={on} onClick={onClick}><i /><span className="txt" style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 2 }}><b style={{ fontSize: 18, fontWeight: 500 }}>{title}</b><span className="sub">{sub}</span></span>{tag && <span className="k" style={{ border: '1px solid rgba(255,255,255,.3)', borderRadius: 999, padding: '5px 10px' }}>{tag}</span>}</button>
    </div>
  );
  return (
    <Page title="Engine">
      <p className="sub" style={{ fontSize: 15 }}>Choose what Niko thinks with and what it speaks with. API keys are added on the Connections screen.</p>
      <div className="cols">
        <section className="g panel" aria-label="Brain" style={{ paddingBottom: 18 }}>
          <span className="k">Brain · language model</span>
          <Opt on={e.brain !== 'custom-ai'} onClick={() => set({ brain: 'workers-ai' })} title="Cloudflare Workers AI" sub="Open models on Cloudflare’s network. Free up to a daily limit." tag="Free tier" />
          <Opt on={e.brain === 'custom-ai'} onClick={() => (links['custom-ai'] ? set({ brain: 'custom-ai' }) : undefined)} title="Your own API key" sub={links['custom-ai'] ? 'OpenAI-compatible or Anthropic, as linked in Connections.' : 'Link “Other AI systems” in Connections first.'} />
          <div className="row"><span className="txt"><span className="sub">If the chosen engine fails or reaches its limit, fall back to Workers AI.</span></span><Switch on={e.fallback !== false} onChange={(v) => set({ fallback: v })} label="Fall back to Workers AI" /></div>
        </section>
        <div className="stack">
          <section className="g panel" aria-label="Voice" style={{ paddingBottom: 18 }}>
            <span className="k">Voice · speech out</span>
            <Opt on={e.voice === 'elevenlabs'} onClick={() => (links.elevenlabs ? set({ voice: 'elevenlabs' }) : undefined)} title="ElevenLabs" sub={links.elevenlabs ? 'Your own key and voice, including a clone of your voice.' : 'Link “ElevenLabs voice” in Connections first.'} />
            <Opt on={e.voice !== 'elevenlabs'} onClick={() => set({ voice: 'device' })} title="Device voice" sub="Free and built in. Also the fallback if ElevenLabs is unavailable." tag="Free" />
          </section>
          <section className="g panel" aria-label="Listening" style={{ paddingBottom: 18 }}>
            <span className="k">Listening · speech in and wake word</span>
            <div className="row"><span className="txt"><b>Wake when I say “Niko”</b><span className="sub">Works while Niko is open and the microphone is allowed.</span></span><Switch on={!!e.wake} onChange={(v) => set({ wake: v })} label="Wake when I say Niko" /></div>
            <div className="row"><span className="txt"><b>Respond only to my voice</b><span className="sub">Not built yet. Niko currently responds to anyone who says its name.</span></span><Switch on={false} onChange={() => undefined} label="Respond only to my voice" disabled /></div>
          </section>
          <p className="g sub" style={{ padding: '16px 20px', display: 'flex', gap: 12, alignItems: 'center', boxShadow: 'none' }}><Icon name="shield" size={20} />Keys are encrypted on the server, never stored in this browser, and never shown again after saving.</p>
        </div>
      </div>
    </Page>
  );
}

const hex = (h: number) => { const f = (n: number) => { const k = (n + h / 30) % 12, v = 0.72 - 0.9 * 0.28 * Math.max(-1, Math.min(k - 3, 9 - k, 1)); return ('0' + Math.round(v * 255).toString(16)).slice(-2); }; return ('#' + f(0) + f(8) + f(4)).toUpperCase(); };

export function Appearance() {
  const { me, refreshMe } = useNiko();
  const [a, setA] = useState<Look | null>(me?.appearance ?? null);
  const [saved, setSaved] = useState(false);
  useEffect(() => { if (me && !a) setA(me.appearance); }, [me, a]);
  // Preview live: the whole screen is the preview.
  useEffect(() => { if (a) setAppearance(a); return () => { if (me) setAppearance(me.appearance); }; }, [a, me]);
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
  const save = async () => { await api('/me', { method: 'PATCH', body: { appearance: a } }); await refreshMe(); setSaved(true); };
  return (
    <Page title="Appearance" right={<button className="pri" onClick={save}>{saved ? 'Saved' : 'Save'}</button>}>
      <p className="sub" style={{ fontSize: 15 }}>Your own background. The particles and accents follow it. Other users keep their own colours.</p>
      <section className="g" aria-label="Background settings" style={{ padding: '26px 28px', display: 'flex', flexDirection: 'column', gap: 20, maxWidth: 720 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <span className="k">Background</span>
          <div style={{ display: 'flex', gap: 10 }}>
            <button className="seg" aria-pressed={a.mode === 'shift'} onClick={() => up({ mode: 'shift' })}>Shift between colours</button>
            <button className="seg" aria-pressed={a.mode === 'single'} onClick={() => up({ mode: 'single' })}>One colour</button>
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <span className="k">{a.mode === 'shift' ? 'Colours in the rotation' : 'Colour'}</span>
          <div className="sw-row">
            {names.map((n) => (
              <button key={n} className="swatch" aria-pressed={isOn(n)} onClick={() => pick(n)}>
                <i style={{ background: `hsl(${hueOf(n)},90%,72%)` }}>{isOn(n) && <Icon name="check" size={26} />}</i>{n[0]!.toUpperCase() + n.slice(1)}
              </button>
            ))}
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <span className="k">Custom colour</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <button className="stp" onClick={() => custom(a.customHue - 10)} aria-label="Shift custom colour left">−</button>
            <button className="spectrum" aria-label="Pick a custom colour from the spectrum" onClick={(ev) => { const r = ev.currentTarget.getBoundingClientRect(); custom(Math.max(0, Math.min(0.999, (ev.clientX - r.left) / r.width)) * 360); }}><span style={{ left: `${a.customHue / 3.6}%` }} /></button>
            <button className="stp" onClick={() => custom(a.customHue + 10)} aria-label="Shift custom colour right">+</button>
            <span style={{ font: "500 14px 'JetBrains Mono', monospace", width: 78, textAlign: 'right' }}>{hex(a.customHue)}</span>
          </div>
        </div>
        {a.mode === 'shift' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <span className="k">Seconds on each colour</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <button className="stp" onClick={() => up({ seconds: Math.max(4, a.seconds - 1) })} aria-label="Fewer seconds">−</button>
              <span style={{ minWidth: 84, height: 44, borderRadius: 12, border: '1px solid rgba(255,255,255,.25)', display: 'flex', alignItems: 'center', justifyContent: 'center', font: "500 15px 'JetBrains Mono', monospace" }}>{a.seconds} s</span>
              <button className="stp" onClick={() => up({ seconds: Math.min(30, a.seconds + 1) })} aria-label="More seconds">+</button>
            </div>
          </div>
        )}
        <p className="sub" style={{ borderTop: '1px solid rgba(255,255,255,.14)', paddingTop: 16 }}>The screen behind this panel is the live preview. Saved to your account and used on all your devices.</p>
      </section>
    </Page>
  );
}

export function Account() {
  const { me, refreshMe } = useNiko();
  const nav = useNavigate();
  const [keys, setKeys] = useState<{ id: string; label: string; rpId: string }[]>([]);
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
  const signOut = async () => { await api('/auth/sign-out', { method: 'POST' }); await refreshMe(); nav('/sign-in', { replace: true }); };
  return (
    <Page title="Account" right={<button className="sec" onClick={signOut}>Sign out</button>}>
      {note && <p className={note.ok ? 'ok' : 'err'} role="status">{note.text}</p>}
      <div className="cols">
        <section className="g panel" style={{ paddingBottom: 18 }}>
          <header><h2>You</h2></header>
          <div className="row"><span className="txt"><b>{me?.name || 'No name set'}</b><span className="sub">{me?.email}</span></span><span className="k">{me?.role}</span></div>
        </section>
        <section className="g panel" style={{ paddingBottom: 18 }}>
          <header><h2>Passkeys</h2><span className="sub">For signing in only</span></header>
          {keys.length === 0 && <p className="sub" style={{ padding: '10px 0' }}>No passkeys yet.</p>}
          {keys.map((k) => (
            <div key={k.id} className="row"><Icon name="key" /><span className="txt"><b>{k.label}</b><span className="sub">Works on {k.rpId}</span></span>
              <button className="bt" onClick={async () => { await api(`/me/passkeys/${k.id}`, { method: 'DELETE' }); await load(); }}>Remove</button></div>
          ))}
          <div className="row" style={{ borderTop: 0 }}><button className="pri" onClick={add}><Icon name="key" size={20} />Add a passkey for {rpId || 'this domain'}</button></div>
          <p className="sub">A passkey works on one domain only. Add one on each address you use Niko from.</p>
        </section>
      </div>
    </Page>
  );
}
