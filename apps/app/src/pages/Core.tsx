// Home (the adaptive core) and the workspace (inbox, calendar, notes with the docked core and countdown).
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, NavLink, useLocation } from 'react-router-dom';
import { SEND_COUNTDOWN_SECONDS, VOICE_NAMES, voiceOrder } from '@niko/shared';
import { api, currentHue, Icon, ParticleCore, sphereOf, spots } from '@niko/ui';
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

function useWide() {
  const q = '(min-width: 901px)';
  const [on, setOn] = useState(() => typeof window !== 'undefined' && window.matchMedia(q).matches);
  useEffect(() => { const m = window.matchMedia(q); const f = () => setOn(m.matches); m.addEventListener('change', f); return () => m.removeEventListener('change', f); }, []);
  return on;
}

/** The answer writes itself in, word by word, after its card has filled in. */
function Words({ text, start }: { text: string; start: number }) {
  const parts = text.split(/(\s+)/);
  let n = 0;
  return <>{parts.map((w, i) => (/^\s+$/.test(w) ? w : <span key={i} className="w" style={{ animationDelay: `${(start + Math.min(n++, 60) * 0.045).toFixed(3)}s` }}>{w}</span>))}</>;
}

/** Sparks that leave the core and trace each answer card's outline as it builds (desktop). */
function Sparks({ run, cards }: { run: number; cards: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current;
    if (!run || !cv || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const ctx = cv.getContext('2d')!;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const W = window.innerWidth, H = window.innerHeight;
    cv.width = W * dpr; cv.height = H * dpr;
    const PER = 80, t0 = performance.now(), rnd = Math.random;
    const list = Array.from({ length: PER * cards }, (_, i) => ({ card: Math.floor(i / PER), u: (i % PER) / PER, d: rnd() * 0.3, a: rnd() * Math.PI * 2, r: Math.sqrt(rnd()), lift: 30 + rnd() * 60 }));
    const smooth = (v: number) => v * v * v * (v * (v * 6 - 15) + 10);
    const edge = (b: DOMRect, u: number) => {
      const L = 2 * (b.width + b.height); let d = u * L;
      if (d < b.width) return [b.left + d, b.top]; d -= b.width;
      if (d < b.height) return [b.right, b.top + d]; d -= b.height;
      if (d < b.width) return [b.right - d, b.bottom]; d -= b.width;
      return [b.left, b.bottom - d];
    };
    let raf = 0;
    const frame = (now: number) => {
      const t = (now - t0) / 1000;
      const core = sphereOf(spots.get('home'));
      const boxes = Array.from(document.querySelectorAll<HTMLElement>('.home .card-build')).map((el) => el.getBoundingClientRect());
      const hue = currentHue();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, H); ctx.globalCompositeOperation = 'lighter';
      let alive = false;
      for (const sp of list) {
        const b = boxes[sp.card];
        if (!b || !core) continue;
        const start = sp.card * CARD_GAP + sp.d, v = (t - start) / 0.55;
        if (v < 1) alive = true;
        if (v <= 0 || v >= 1) continue;
        const e = smooth(v), [tx, ty] = edge(b, sp.u);
        const fx = core.x - 200 + Math.cos(sp.a) * core.R * sp.r, fy = core.y + Math.sin(sp.a) * core.R * sp.r;
        const x = fx + (tx! - fx) * e, y = fy + (ty! - fy) * e - Math.sin(Math.PI * e) * sp.lift, al = Math.sin(Math.PI * v);
        ctx.fillStyle = `hsla(${hue.toFixed(0)},90%,80%,${(0.9 * al).toFixed(3)})`; ctx.fillRect(x - 1.2, y - 1.2, 2.4, 2.4);
        ctx.fillStyle = `hsla(${hue.toFixed(0)},90%,70%,${(0.25 * al).toFixed(3)})`; ctx.fillRect(x - 3, y - 3, 6, 6);
      }
      if (alive || t < 0.2) raf = requestAnimationFrame(frame); else ctx.clearRect(0, 0, W, H);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [run, cards]);
  return <canvas ref={ref} className="sparks" aria-hidden="true" />;
}

const CARD_GAP = 0.6; // seconds between the answer card and the approval card building

export function Home() {
  const n = useNiko();
  const wide = useWide();
  const [nav, setNav] = useState(false);
  const [typing, setTyping] = useState(false);
  const [text, setText] = useState('');
  const open = !!n.reply;
  // Keep the last answer on screen while its cards close.
  const [shown, setShown] = useState<{ reply: string; chat: Brief['chats'][number] | null; id: number } | null>(null);
  const [closing, setClosing] = useState(false);
  const [caption, setCaption] = useState<'' | 'aside' | 'back'>('');
  useEffect(() => {
    if (n.reply) {
      setClosing(false);
      setShown((s) => ({ reply: n.reply!, chat: n.brief?.chats[0] ?? null, id: (s?.id ?? 0) + (s?.reply === n.reply ? 0 : 1) }));
      if (wide) setCaption('aside');
      return;
    }
    if (!shown) return;
    setClosing(true);
    if (wide) setCaption((c) => (c === 'aside' ? 'back' : c));
    const t = window.setTimeout(() => { setClosing(false); setShown(null); }, 900);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [n.reply, wide]);
  const submit = (e: FormEvent) => { e.preventDefault(); const t = text; setText(''); setTyping(false); void n.ask(t); };
  const cards = shown ? (shown.chat ? 2 : 1) : 0;
  return (
    <div className={'home' + (open ? ' open' : '') + (closing ? ' closing' : '')}>
      <div className="bg" />
      <div className="stage">
        <ParticleCore size="var(--s)" mode={n.mode} pad={wide ? 220 : 0} shift={wide && open ? -200 : 0} spot="home" />
        <div className={'caption ' + caption} key={caption}>
          <span className="k accent" role="status">{n.label}</span>
          <p>{n.line}</p>
          {n.voiceProblem && <Link to="/voice" className="voice-note">Your first voice could not speak, so the next one in your list was used. {n.voiceProblem}</Link>}
        </div>
      </div>
      <div className="top">
        <div className="left">
          <button className="ib g" style={{ width: 44, height: 44 }} onClick={() => setNav(!nav)} aria-label="Show or hide navigation" aria-expanded={nav}><Icon name="menu" /></button>
          <span className="wordmark">NIKO</span>
        </div>
        <Link className="g chip" style={{ boxShadow: 'none' }} to="/engine"><span className="long"><span className="k" style={{ marginRight: 10 }}>Engine</span>{n.me?.engine.brain === 'custom-ai' ? 'Your AI' : n.me?.engine.brain === 'self-hosted-ai' ? 'Your model' : 'Workers AI'} · {VOICE_NAMES[voiceOrder(n.me?.engine)[0] ?? 'device']}</span><span className="short">Engine</span></Link>
      </div>
      <Dock className={'dock' + (nav ? ' show' : '')} />
      {wide && <Sparks run={open && shown ? shown.id : 0} cards={cards} />}
      <aside className="panels" aria-label="Niko’s answer" aria-hidden={!open} key={shown?.id ?? 0}>
        {shown && <>
          <div className="card-build" style={{ ['--d' as string]: '0s' }}>
            <section className="g">
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span className="k">Niko</span>
                <button className="ib" style={{ width: 44, height: 44, margin: '-8px -10px -8px 0' }} onClick={n.dismissReply} aria-label="Hide the answer" tabIndex={open ? 0 : -1}><Icon name="x" /></button>
              </div>
              <p className="reply"><Words text={shown.reply} start={wide ? 1.0 : 0.35} /></p>
            </section>
            <Outline />
          </div>
          {shown.chat && (
            <div className="card-build" style={{ ['--d' as string]: `${CARD_GAP}s` }}>
              <section className="g" aria-label="Waiting for a reply">
                <div className="meta"><span className="k">Waiting for a reply</span><span>{shown.chat.source}</span></div>
                <h2 style={{ fontSize: 18 }}>{shown.chat.title}</h2>
                <p className="reply">{shown.chat.last}</p>
                <div className="two">
                  <Link className="sec" to="/inbox" tabIndex={open ? 0 : -1}>Review</Link>
                  <Link className="pri" to="/inbox" tabIndex={open ? 0 : -1}>Reply</Link>
                </div>
              </section>
              <Outline />
            </div>
          )}
        </>}
      </aside>
      {typing && (
        <form className="g typebar" onSubmit={submit}>
          <label className="sr" htmlFor="ask">Message Niko</label>
          <input id="ask" autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder="Ask, or tell me what to do" />
          <button className="ib on" style={{ width: 44, height: 44 }} aria-label="Send"><Icon name="arrow" size={20} /></button>
        </form>
      )}
      <div className="controls">
        <button className="ib g" onClick={() => setTyping(!typing)} aria-label="Type instead" aria-pressed={typing}><Icon name="keys" /></button>
        <button className="micbtn" onClick={n.toggleMic} aria-label="Talk"><Icon name="mic" size={28} /></button>
        <button className="ib g" onClick={n.stop} aria-label="Stop"><Icon name="stop" /></button>
      </div>
    </div>
  );
}

/** The glowing outline and scan line a card is built from (drawn by CSS). */
function Outline() {
  return <>
    <svg className="outline" aria-hidden="true"><rect x="0.5" y="0.5" width="99.9%" height="99.8%" rx="28" pathLength="100" /></svg>
    <i className="scan" aria-hidden="true" />
  </>;
}

type Sel = { kind: 'chat'; provider: string; chatId: string; title: string; source: string } | { kind: 'mail'; provider: string; id: string; title: string; source: string; subject: string };
type SendState = { phase: 'draft' } | { phase: 'counting'; id: string; left: number } | { phase: 'sent' } | { phase: 'busy' };

export function Workspace() {
  const n = useNiko();
  // The ring's place on screen, for the particle flow from and to Home.
  const ringRef = useCallback((el: HTMLDivElement | null) => { if (el) spots.set('ring', el); else spots.delete('ring'); }, []);
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
    api<{ reply: string }>('/chat', { body: { message: `Write only the text of a short, friendly reply to ${about}. No preamble.`, tz: new Date().getTimezoneOffset(), purpose: 'draft' } })
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
        <div className="ringbox" ref={ringRef}>
          <svg className="ticks" viewBox="0 0 600 600" aria-hidden="true"><circle className="outer" cx="300" cy="300" r="292" fill="none" stroke="rgba(255,255,255,.35)" strokeWidth="6" strokeDasharray="1.5 13.8" /><circle className="inner" cx="300" cy="300" r="276" fill="none" stroke="rgba(255,255,255,.14)" pathLength={100} /></svg>
          <svg className="sweep" viewBox="0 0 600 600" aria-hidden="true"><circle cx="300" cy="300" r="292" fill="none" strokeWidth="2.5" strokeLinecap="round" pathLength={100} /></svg>
          <svg className="count" viewBox="0 0 600 600" aria-hidden="true" style={{ opacity: counting ? 1 : 0 }}>
            <circle cx="300" cy="300" r="262" fill="none" stroke="rgba(255,255,255,.18)" strokeWidth="4" />
            <circle cx="300" cy="300" r="262" fill="none" stroke="#fff" strokeWidth="4" strokeLinecap="round" strokeDasharray={C} strokeDashoffset={counting ? C * (1 - send.left / SEND_COUNTDOWN_SECONDS) : C} style={{ transition: 'stroke-dashoffset 1s linear' }} />
          </svg>
          <ParticleCore size="86.8%" mode={n.mode} particles={1000} spot="ws" />
          {counting && <div className="num" role="status">{send.left}</div>}
        </div>
        <div className="status"><span className="k accent" role="status">{n.label}</span><span>{n.line}</span></div>
        <div className="ws-mic">
          <button className={'micbtn' + (n.mode === 'listening' ? ' live' : '')} onClick={n.toggleMic} aria-label="Talk to Niko"><Icon name="mic" /></button>
          {(n.mode === 'speaking' || n.mode === 'listening') && <button className="ib g" onClick={n.stop} aria-label="Stop"><Icon name="stop" /></button>}
        </div>
      </div>

      <div key={view} className="content hud-in">
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
