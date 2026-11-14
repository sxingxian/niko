// Home (the adaptive core) and the workspace (inbox, calendar, notes with the docked core and countdown).
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, NavLink, useLocation } from 'react-router-dom';
import { SEND_COUNTDOWN_SECONDS } from '@niko/shared';
import { api, Icon, ParticleCore } from '@niko/ui';
import { useNiko, type Brief } from '../niko';

// The mockups' rail: Home, Inbox, Calendar, Notes, Connections. Settings (appearance, engine, account) sit behind the last button.
const NAVS: [string, string, string][] = [['/', 'spark', 'Home'], ['/inbox', 'mail', 'Inbox'], ['/calendar', 'calendar', 'Calendar'], ['/notes', 'note', 'Notes'], ['/connections', 'plug', 'Connections'], ['/appearance', 'user', 'Settings']];

function Dock({ className }: { className: string }) {
  return (
    <nav aria-label="Primary" className={'g ' + className}>
      {NAVS.map(([to, icon, name]) => (
        <NavLink key={to} to={to} end className={({ isActive }) => 'ib' + (isActive ? ' on' : '')} aria-label={name}><Icon name={icon} /></NavLink>
      ))}
    </nav>
  );
}

export function Home() {
  const n = useNiko();
  const [nav, setNav] = useState(false);
  const [typing, setTyping] = useState(false);
  const [text, setText] = useState('');
  const open = !!n.reply;
  const wide = typeof window !== 'undefined' && window.innerWidth > 900;
  const submit = (e: FormEvent) => { e.preventDefault(); const t = text; setText(''); setTyping(false); void n.ask(t); };
  return (
    <div className={'home' + (open ? ' open' : '')}>
      <div className="bg" />
      <div className="stage">
        <ParticleCore size="var(--s)" mode={n.mode} />
        <div className="caption">
          <span className="k accent" role="status">{n.label}</span>
          <p>{n.line}</p>
        </div>
      </div>
      <div className="top">
        <div className="left">
          <button className="ib g" style={{ width: 44, height: 44 }} onClick={() => setNav(!nav)} aria-label="Show or hide navigation" aria-expanded={nav}><Icon name="menu" /></button>
          <span className="wordmark">NIKO</span>
        </div>
        <Link className="g chip" style={{ boxShadow: 'none' }} to="/engine"><span className="long"><span className="k" style={{ marginRight: 10 }}>Engine</span>{n.me?.engine.brain === 'custom-ai' ? 'Your AI' : 'Workers AI'} · {n.me?.engine.voice === 'elevenlabs' ? 'ElevenLabs' : 'Device voice'}</span><span className="short">Engine</span></Link>
      </div>
      <Dock className={'dock' + (nav ? ' show' : '')} />
      <aside className="panels" aria-label="Details" aria-hidden={!open}>
        <section className="g">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span className="k">Niko</span>
            <button className="ib" style={{ width: 44, height: 44, margin: '-8px -10px -8px 0' }} onClick={n.dismissReply} aria-label="Hide panels" tabIndex={open ? 0 : -1}><Icon name="x" /></button>
          </div>
          <p className="reply">{n.reply}</p>
        </section>
        {n.brief && n.brief.chats[0] && (
          <section className="g" aria-label="Waiting for a reply">
            <div className="meta"><span className="k">Waiting for a reply</span><span>{n.brief.chats[0].source}</span></div>
            <h2 style={{ fontSize: 18 }}>{n.brief.chats[0].title}</h2>
            <p className="reply">{n.brief.chats[0].last}</p>
            <div className="two">
              <Link className="sec" to="/inbox" tabIndex={open ? 0 : -1}>Review</Link>
              <Link className="pri" to="/inbox" tabIndex={open ? 0 : -1}>Reply</Link>
            </div>
          </section>
        )}
      </aside>
      {typing && (
        <form className="g typebar" onSubmit={submit}>
          <label className="sr" htmlFor="ask">Message Niko</label>
          <input id="ask" autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder="Ask, or tell me what to do" />
          <button className="ib on" style={{ width: 44, height: 44 }} aria-label="Send"><Icon name="arrow" size={20} /></button>
        </form>
      )}
      <div className="controls" style={wide ? undefined : { transform: 'none' }}>
        <button className="ib g" onClick={() => setTyping(!typing)} aria-label="Type instead" aria-pressed={typing}><Icon name="keys" /></button>
        <button className="micbtn" onClick={n.toggleMic} aria-label="Talk"><Icon name="mic" size={28} /></button>
        <button className="ib g" onClick={n.stop} aria-label="Stop"><Icon name="stop" /></button>
      </div>
    </div>
  );
}

type Sel = { kind: 'chat'; provider: string; chatId: string; title: string; source: string } | { kind: 'mail'; provider: string; id: string; title: string; source: string; subject: string };
type SendState = { phase: 'draft' } | { phase: 'counting'; id: string; left: number } | { phase: 'sent' } | { phase: 'busy' };

export function Workspace() {
  const n = useNiko();
  const view = useLocation().pathname.replace('/', '') as 'inbox' | 'calendar' | 'notes';
  const [brief, setBrief] = useState<Brief | null>(n.brief);
  const [sel, setSel] = useState<Sel | null>(null);
  const [thread, setThread] = useState<{ id: string; direction: string; sender: string; body: string; fileName: string | null }[]>([]);
  const [draft, setDraft] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [send, setSend] = useState<SendState>({ phase: 'draft' });
  const [err, setErr] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);
  const timer = useRef<number>(0);

  useEffect(() => { api<Brief>(`/brief?tz=${new Date().getTimezoneOffset()}`).then(setBrief).catch((e) => setErr(e.message)); }, []);
  const items: Sel[] = brief ? [
    ...brief.chats.map((c) => ({ kind: 'chat' as const, provider: c.provider, chatId: c.chatId, title: c.title, source: c.source })),
    ...brief.mail.map((m) => ({ kind: 'mail' as const, provider: m.provider, id: m.id, title: m.from, source: m.source, subject: m.subject })),
  ] : [];
  useEffect(() => { if (!sel && items[0]) setSel(items[0]); /* first item opens by default */ }, [items.length]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    setDraft(''); setFile(null); setSend({ phase: 'draft' }); setErr(''); setThread([]);
    if (sel?.kind === 'chat') api(`/threads/${sel.provider}/${encodeURIComponent(sel.chatId)}`).then((r) => setThread(r.messages)).catch(() => undefined);
  }, [sel?.kind === 'chat' ? sel.chatId : sel?.kind === 'mail' ? sel.id : null]); // eslint-disable-line react-hooks/exhaustive-deps

  const target = sel ? { provider: sel.provider, chatId: sel.kind === 'chat' ? sel.chatId : sel.id } : null;

  const finish = useCallback(async (id: string, now: boolean) => {
    window.clearInterval(timer.current);
    setSend({ phase: 'busy' });
    try {
      await api(`/sends/${id}/confirm${now ? '?now=1' : ''}`, { method: 'POST' });
      if (file && target) {
        const form = new FormData();
        form.set('file', file); form.set('provider', target.provider); form.set('chatId', target.chatId);
        await api('/relay', { form });
      }
      setSend({ phase: 'sent' }); n.setStatus('Sent', '', 'idle');
      if (sel?.kind === 'chat') setThread((t) => [...t, { id: 'new', direction: 'out', sender: 'Niko', body: draft, fileName: file?.name ?? null }]);
    } catch (e: any) { setErr(e.message); setSend({ phase: 'draft' }); n.setStatus('Problem', e.message, 'idle'); }
  }, [file, target, draft, sel, n]);

  const start = useCallback(async (via: 'voice' | 'tap') => {
    if (!target || !draft.trim() || send.phase !== 'draft') return;
    setErr('');
    try {
      const r = await api<{ id: string; seconds: number }>('/sends', { body: { ...target, body: draft, via } });
      if (!r.seconds) return void finish(r.id, true);
      setSend({ phase: 'counting', id: r.id, left: r.seconds });
      n.setStatus('Sending', '“Niko, cancel” to stop', 'speaking');
      let left = r.seconds;
      timer.current = window.setInterval(() => {
        left -= 1;
        if (left <= 0) void finish(r.id, false); else setSend({ phase: 'counting', id: r.id, left });
      }, 1000);
    } catch (e: any) { setErr(e.message); n.setStatus('Problem', e.message, 'idle'); }
  }, [target, draft, send.phase, finish, n]);

  const cancel = useCallback(async () => {
    if (send.phase !== 'counting') return;
    window.clearInterval(timer.current);
    await api(`/sends/${send.id}/cancel`, { method: 'POST' }).catch(() => undefined);
    setSend({ phase: 'draft' }); n.setStatus('Cancelled', '', 'idle');
  }, [send, n]);

  // Voice: "send it" starts the countdown, "cancel" stops it. Anything else falls through to Niko.
  useEffect(() => {
    n.setCommandHandler((p) => {
      if (/^(send|send it|send that)\b/.test(p) && view === 'inbox') { void start('voice'); return true; }
      if (/^(cancel|stop|don't send)\b/.test(p) && send.phase === 'counting') { void cancel(); return true; }
      return false;
    });
    return () => n.setCommandHandler(null);
  }, [n, start, cancel, send.phase, view]);
  useEffect(() => () => window.clearInterval(timer.current), []);

  // "Draft replies" (Connections → What Niko may do): Niko prepares a reply as soon as a conversation opens, for you to review.
  const [drafting, setDrafting] = useState(false);
  const drafted = useRef('');
  useEffect(() => {
    if (!sel || view !== 'inbox' || n.me?.permissions.draft === false) return;
    const key = sel.kind === 'chat' ? 'c:' + sel.chatId : 'm:' + sel.id;
    const lastIn = thread.filter((m) => m.direction === 'in').slice(-1)[0]?.body;
    if (drafted.current === key || (sel.kind === 'chat' && !lastIn)) return;
    drafted.current = key;
    const about = sel.kind === 'mail' ? `the email from ${sel.title} with subject "${sel.subject}"` : `the last message from ${sel.title}: "${lastIn}"`;
    setDrafting(true);
    api<{ reply: string }>('/chat', { body: { message: `Write only the text of a short, friendly reply to ${about}. No preamble.`, tz: new Date().getTimezoneOffset() } })
      .then((r) => setDraft((d) => d || (typeof r.reply === 'string' ? r.reply : ''))).catch(() => undefined).finally(() => setDrafting(false));
  }, [sel, thread, view, n.me?.permissions.draft]);

  const counting = send.phase === 'counting';
  const C = 1646.2;
  const title = view[0]!.toUpperCase() + view.slice(1);
  const count = brief ? (view === 'inbox' ? items.length : view === 'calendar' ? brief.events.length : brief.notes.length) : 0;
  const canFile = sel?.kind === 'chat' && n.me?.permissions.files !== false && ['telegram-bot', 'discord'].includes(sel.provider);

  return (
    <div className="ws">
      <div className="bg" />
      <div className="head"><span className="wordmark">NIKO</span><h1>{title}</h1><span className="k">{String(count).padStart(2, '0')}</span></div>
      <Dock className="rail" />
      <div className="corewrap">
        <div className="ringbox">
          <svg className="ticks" viewBox="0 0 600 600" aria-hidden="true"><circle cx="300" cy="300" r="292" fill="none" stroke="rgba(255,255,255,.35)" strokeWidth="6" strokeDasharray="1.5 13.8" /><circle cx="300" cy="300" r="276" fill="none" stroke="rgba(255,255,255,.14)" /></svg>
          <svg className="count" viewBox="0 0 600 600" aria-hidden="true" style={{ opacity: counting ? 1 : 0 }}>
            <circle cx="300" cy="300" r="262" fill="none" stroke="rgba(255,255,255,.18)" strokeWidth="4" />
            <circle cx="300" cy="300" r="262" fill="none" stroke="#fff" strokeWidth="4" strokeLinecap="round" strokeDasharray={C} strokeDashoffset={counting ? C * (1 - send.left / SEND_COUNTDOWN_SECONDS) : C} style={{ transition: 'stroke-dashoffset 1s linear' }} />
          </svg>
          <ParticleCore size="86.8%" mode={n.mode} particles={1000} />
          {counting && <div className="num" role="status">{send.left}</div>}
        </div>
        <div className="status"><span className="k accent" role="status">{n.label}</span><span>{n.line}</span></div>
      </div>

      <div className="content">
        {err && <p className="err" role="alert">{err}</p>}
        {brief?.problems.map((p) => <p key={p} className="sub">{p}</p>)}
        {view === 'inbox' && <>
          <section className="g list" aria-label="Messages">
            {items.length === 0 && <p className="sub" style={{ padding: 14 }}>{brief ? 'Nothing needs you. Link mail or chat apps in Connections.' : 'Loading…'}</p>}
            {items.map((it) => {
              const on = !!sel && (it.kind === 'chat' ? sel.kind === 'chat' && sel.chatId === it.chatId && sel.provider === it.provider : sel.kind === 'mail' && sel.id === it.id);
              return <button key={it.kind + (it.kind === 'chat' ? it.chatId : it.id)} className={'item' + (on ? ' on' : '')} onClick={() => setSel(it)} aria-pressed={on}><b>{it.title}</b><span className="k">{it.source}</span></button>;
            })}
          </section>
          {sel && (
            <section className="g thread" aria-label={`Conversation with ${sel.title}`}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12 }}><h2 style={{ fontWeight: 500, fontSize: 20 }}>{sel.title}</h2><span className="k">{sel.source}</span></div>
              {sel.kind === 'mail' && <p className="bubble">{sel.subject}</p>}
              {thread.slice(-6).map((m, i) => (
                <div key={m.id + i} className={'bubble' + (m.direction === 'out' ? ' out' : '')}>
                  {m.body}
                  {m.fileName && (m.direction === 'in' && sel.provider === 'telegram-bot'
                    ? <a className="att" style={{ marginTop: 8 }} href={`/api/relay/telegram/${m.id}`}><Icon name="clip" size={18} /><span style={{ flex: 1 }}>{m.fileName}</span><span className="k">Not stored</span></a>
                    : <span className="att" style={{ marginTop: 8 }}><Icon name="clip" size={18} /><span style={{ flex: 1 }}>{m.fileName}</span></span>)}
                </div>
              ))}
              {send.phase !== 'sent' && (
                <div className="draft">
                  <span className="k">{counting ? 'Niko · sending' : 'Niko · draft'}</span>
                  <label className="sr" htmlFor="draft">Reply</label>
                  <textarea id="draft" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={drafting ? 'Niko is drafting…' : 'Write a reply'} readOnly={counting} rows={2} />
                  {file && <div className="att"><Icon name="clip" size={18} /><span style={{ flex: 1 }}>{file.name}</span><span className="k">Not stored</span></div>}
                </div>
              )}
              <div className="actions">
                {send.phase === 'draft' && <>
                  {canFile && <>
                    <input ref={fileInput} type="file" hidden onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
                    <button className="ib" onClick={() => (file ? setFile(null) : fileInput.current?.click())} aria-label={file ? 'Remove the attachment' : 'Attach an image or file'} aria-pressed={!!file}><Icon name="clip" size={18} /></button>
                  </>}
                  <button className="sec voice" onClick={() => start('voice')} disabled={!draft.trim()}><Icon name="mic" size={18} />“Niko, send it”</button>
                  <button className="pri" onClick={() => start('tap')} disabled={!draft.trim()}>Send</button>
                </>}
                {counting && <>
                  <button className="pri" onClick={cancel}>Cancel</button>
                  <button className="sec" onClick={() => finish(send.id, true)}>Send now</button>
                </>}
                {send.phase === 'sent' && <span role="status" style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 18 }}><Icon name="check" />Sent</span>}
              </div>
            </section>
          )}
        </>}
        {view === 'calendar' && (
          <section className="g" aria-label="Today" style={{ padding: '8px 28px' }}>
            {brief && brief.events.length === 0 && <p className="sub" style={{ padding: '18px 0' }}>No events today, or no calendar is linked yet.</p>}
            {brief?.events.map((e, i) => <div key={i} className="big" style={{ gridTemplateColumns: '96px minmax(0,1fr) auto' }}><span style={{ font: "500 20px 'JetBrains Mono', monospace" }}>{e.time}</span><span style={{ fontSize: 24, fontWeight: 500 }}>{e.title}</span><span className="k">{e.source}</span></div>)}
          </section>
        )}
        {view === 'notes' && (
          <section className="g" aria-label="Recent notes" style={{ padding: '8px 28px' }}>
            {brief && brief.notes.length === 0 && <p className="sub" style={{ padding: '18px 0' }}>No notes yet. Link Notion or OneNote in Connections.</p>}
            {brief?.notes.map((e, i) => <div key={i} className="big" style={{ gridTemplateColumns: 'minmax(0,1fr) auto' }}><span style={{ fontSize: 24, fontWeight: 500 }}>{e.title}</span><span className="k">{e.source}</span></div>)}
          </section>
        )}
      </div>
    </div>
  );
}
