// Home (the adaptive core) and the workspace (inbox, calendar, notes with the docked core and countdown).
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, NavLink, useLocation } from 'react-router-dom';
import { aiAllowed, stripTags, PAGE_SIZES, SEND_COUNTDOWN_SECONDS, voiceName, voiceOption, voiceOrder, type Me } from '@niko/shared';
/** The first voice this account may use (the admin may have turned some off); the device voice if none. */
const firstVoice = (m: Me | null | undefined) => { const off = m?.aiOff ?? []; return off.includes('sec:voices') ? 'device' : voiceOrder(m?.engine).find((v) => v.startsWith('vkey:') || aiAllowed(off, voiceOption(v))) ?? 'device'; };
import { api, currentHue, Icon, ParticleCore, sphereOf, spots } from '@niko/ui';
import { useNiko } from '../niko';
import { pageRequest, pickItem, rewriteRequest, screenFor, scrollRequest } from '../speech';
import { isStacked } from '../flow';
import { PictureCard } from './Picture';
import { MapCard } from './Map';
import { WeatherCard } from './Weather';
import type { WeatherCard as WxCard } from '@niko/shared';
import { GlanceStack } from './Glance';
import { toggleFullscreen, useFullscreen } from '../fullscreen';
import { LockEntry } from './Lock';
import type { Brief, BriefPart, DocBlock, EventDetail, EventItem, MailDetail, NoteDetail, NoteItem } from '@niko/shared';

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

/** Niko's draft for each message it drafted in this visit (key: conversation and the message it answers). */
const draftCache = new Map<string, string>();
/** Which parts of the briefing each workspace screen shows. */
const VIEW_PARTS: Record<string, BriefPart[]> = { inbox: ['mail', 'chats'], calendar: ['events'], notes: ['notes'] };
const BRIEF_FRESH_MS = 300_000;
const EMPTY_BRIEF: Brief = { mail: [], events: [], notes: [], chats: [], problems: [] };
/** The briefing as last read, part by part, kept while the app is open (the workspace remounts on each screen). */
const briefCache: { data: Brief; at: Partial<Record<BriefPart, number>>; loaded: Set<BriefPart> } = { data: EMPTY_BRIEF, at: {}, loaded: new Set() };
function mergeBrief(r: Brief, read: BriefPart[]) {
  const d = { ...briefCache.data };
  for (const p of read) (d as any)[p] = r[p];
  for (const p of read) briefCache.loaded.add(p);
  d.problems = [...briefCache.data.problems.filter((x) => !read.includes(x.part)), ...r.problems.filter((x) => read.includes(x.part))];
  briefCache.data = d;
}

/** After a stop: carry on the answer, or ask the question again (the same as saying "continue" / "try again"). */
function ResumeRow() {
  const n = useNiko();
  if (!n.resumable || n.mode === 'thinking' || n.mode === 'speaking') return null; // shown while idle or listening for "continue"
  return (
    <div className="resume" role="group" aria-label="Pick up where Niko stopped">
      {n.resumable.canContinue && <button className="pri" onClick={n.resume}>Continue</button>}
      <button className="sec" onClick={n.retry}>Ask again</button>
    </div>
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
  const fs = useFullscreen();
  const [nav, setNav] = useState(false);
  const [typing, setTyping] = useState(false);
  const [text, setText] = useState('');
  const pic = n.picture;
  const mapv = n.map;
  const open = !!n.reply || !!pic || !!mapv;
  // Keep the last answer on screen while its cards close.
  const [shown, setShown] = useState<{ reply: string; chat: Brief['chats'][number] | null; id: number; wx: WxCard | null } | null>(null);
  const [closing, setClosing] = useState(false);
  const [caption, setCaption] = useState<'' | 'aside' | 'back'>('');
  useEffect(() => {
    if (n.reply) {
      setClosing(false);
      setShown((s) => ({ reply: n.reply!, chat: n.brief?.chats[0] ?? null, id: (s?.id ?? 0) + (s?.reply === n.reply ? 0 : 1), wx: n.weather?.for === n.reply ? n.weather.card : null }));
      return;
    }
    if (!shown) return;
    setClosing(true);
    const t = window.setTimeout(() => { setClosing(false); setShown(null); }, 900);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [n.reply, n.weather, wide]);
  const submit = (e: FormEvent) => { e.preventDefault(); const t = text; setText(''); setTyping(false); void n.ask(t); };
  const cards = shown ? (shown.chat ? 2 : 1) : 0;
  const card = !!pic || !!mapv;
  // The caption always sits under the core: aside exactly when the core moves aside (an answer, a picture or a map is
  // open on a wide screen), back when it returns. Before, a new question asked over a map or picture sent the caption
  // back while the core stayed aside.
  const aside = wide && open;
  const locked = n.locked;
  const wasAside = useRef(false);
  useEffect(() => {
    if (aside === wasAside.current) return;
    wasAside.current = aside;
    setCaption(aside ? 'aside' : wide ? 'back' : '');
  }, [aside, wide]);
  return (
    <div className={'home' + (open ? ' open' : '') + (closing && !card ? ' closing' : '') + (pic ? ' picture' : '') + (mapv ? ' mapping' : '') + (locked ? ' locked' : '')}>
      <div className="bg" />
      <div className="stage">
        <ParticleCore size="var(--s)" mode={n.mode} pad={wide ? 220 : 0} shift={wide && open ? -200 : 0} spot="home" />
        {/* Locked: a tap anywhere on the core shows the code entry. */}
        {locked && !n.lockAsk && <button className="lock-tap" onClick={() => n.requestUnlock()} aria-label="Unlock Niko" />}
        <div className={'caption ' + caption} key={caption}>
          <span className="k accent" role="status">{n.label}</span>
          {locked && n.lockAsk ? <LockEntry /> : <>
            <p>{n.line}</p>
            {!locked && n.voiceProblem && <Link to="/voice" className="voice-note">Your first voice could not speak, so the next one in your list was used. {n.voiceProblem}</Link>}
            {!locked && <ResumeRow />}
          </>}
        </div>
      </div>
      <div className="top">
        <div className="left">
          {!locked && <button className="ib g" style={{ width: 44, height: 44 }} onClick={() => setNav(!nav)} aria-label="Show or hide navigation" aria-expanded={nav}><Icon name="menu" /></button>}
          <span className="wordmark">NIKO</span>
        </div>
        <div className="right">
        {locked ? <span className="lock-pill"><Icon name="lock" size={14} />Locked</span> : <>
        {fs.offer && <button className="ib g" style={{ width: 44, height: 44 }} onClick={() => void toggleFullscreen()} aria-label={fs.on ? 'Leave full screen' : 'Full screen'} aria-pressed={fs.on} title={fs.on ? 'Leave full screen' : 'Full screen'}><Icon name={fs.on ? 'collapse' : 'expand'} /></button>}
        <Link className="g chip" style={{ boxShadow: 'none' }} to="/engine"><span className="long"><span className="k" style={{ marginRight: 10 }}>Engine</span>{n.me?.engine.brain === 'custom-ai' ? 'Your AI' : n.me?.engine.brain === 'self-hosted-ai' ? 'Your model' : 'Workers AI'} · {voiceName(firstVoice(n.me))}</span><span className="short">Engine</span></Link>
        </>}
        </div>
      </div>
      {!locked && <Dock className={'dock' + (nav ? ' show' : '')} />}
      <GlanceStack wide={wide} />
      {!locked && wide && !card && <Sparks run={open && shown ? shown.id : 0} cards={cards} />}
      {n.fullscreenAsk && (
        <div className="fs-ask g" role="dialog" aria-label="Full screen">
          <span>Browsers need a tap for full screen.</span>
          <button className="pri" onClick={() => n.answerFullscreen(true)} autoFocus><Icon name="expand" size={16} />Go full screen</button>
          <button className="sec" onClick={() => n.answerFullscreen(false)}>Not now</button>
        </div>
      )}
      {mapv ? (
        <aside className="panels mapp" aria-label="Map" key="map">
          <div className="card-build" style={{ ['--d' as string]: '0s' }}>
            <MapCard v={mapv} tabbable />
            <Outline />
          </div>
        </aside>
      ) : pic ? (
        <aside className="panels pic" aria-label="Niko’s picture" key="picture">
          <div className="card-build" style={{ ['--d' as string]: '0s' }}>
            <PictureCard pic={pic} tabbable />
            <Outline />
          </div>
        </aside>
      ) : (
      <aside className="panels" aria-label="Niko’s answer" aria-hidden={!open} key={shown?.id ?? 0}>
        {shown && <>
          <div className="card-build" style={{ ['--d' as string]: '0s' }}>
            {shown.wx ? <WeatherCard card={shown.wx} onClose={n.dismissReply} tabbable={open} /> : (
            <section className="g">
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span className="k">Niko</span>
                <button className="ib" style={{ width: 44, height: 44, margin: '-8px -10px -8px 0' }} onClick={n.dismissReply} aria-label="Hide the answer" tabIndex={open ? 0 : -1}><Icon name="x" /></button>
              </div>
              <p className="reply"><Words text={shown.reply} start={wide ? 1.0 : 0.35} /></p>
            </section>
            )}
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
      )}
      {typing && !locked && (
        <form className="g typebar" onSubmit={submit}>
          <label className="sr" htmlFor="ask">Message Niko</label>
          <input id="ask" autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder="Ask, or tell me what to do" />
          <button className="ib on" style={{ width: 44, height: 44 }} aria-label="Send"><Icon name="arrow" size={20} /></button>
        </form>
      )}
      {!locked && <div className="controls">
        <button className="ib g" onClick={() => setTyping(!typing)} aria-label="Type instead" aria-pressed={typing}><Icon name="keys" /></button>
        <button className="micbtn" onClick={n.toggleMic} aria-label="Talk"><Icon name="mic" size={28} /></button>
        <button className="ib g" onClick={n.stop} aria-label="Stop"><Icon name="stop" /></button>
      </div>}
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
/** Loads one detail (a note, an email or an event) when its address changes; earlier answers are kept for this visit. */
const detailCache = new Map<string, unknown>();
function useDetail<T>(path: string | null): { data: T | null; loading: boolean; error: string } {
  const [st, setSt] = useState<{ path: string | null; data: T | null; loading: boolean; error: string }>({ path: null, data: null, loading: false, error: '' });
  useEffect(() => {
    if (!path) { setSt({ path, data: null, loading: false, error: '' }); return; }
    const hit = detailCache.get(path) as T | undefined;
    if (hit) { setSt({ path, data: hit, loading: false, error: '' }); return; }
    let live = true;
    setSt({ path, data: null, loading: true, error: '' });
    api<T>(path).then((d) => { detailCache.set(path, d); if (live) setSt({ path, data: d, loading: false, error: '' }); })
      .catch((e: Error) => { if (live) setSt({ path, data: null, loading: false, error: e.message }); });
    return () => { live = false; };
  }, [path]);
  return st.path === path ? st : { data: null, loading: !!path, error: '' };
}
const when = (t: number) => new Date(t).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const clock = (t: number) => new Date(t).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

/** A note's content, as plain text blocks (never the provider's HTML). */
function Blocks({ blocks }: { blocks: DocBlock[] }) {
  let n = 0;
  return (
    <div className="doc">
      {blocks.map((b, i) => {
        n = b.kind === 'ol' ? n + 1 : 0;
        const style = b.depth ? { marginLeft: 22 * b.depth } : undefined;
        switch (b.kind) {
          case 'h1': return <h3 key={i} className="d-h1" style={style}>{b.text}</h3>;
          case 'h2': return <h4 key={i} className="d-h2" style={style}>{b.text}</h4>;
          case 'h3': return <h5 key={i} className="d-h3" style={style}>{b.text}</h5>;
          case 'li': return <p key={i} className="d-li" style={style}>{b.text}</p>;
          case 'ol': return <p key={i} className="d-ol" style={style} data-n={n + '.'}>{b.text}</p>;
          case 'todo': return <p key={i} className={'d-todo' + (b.done ? ' done' : '')} style={style}><span className="box" aria-hidden="true">{b.done ? '✓' : ''}</span><span className="sr">{b.done ? 'Done: ' : 'To do: '}</span>{b.text}</p>;
          case 'quote': return <blockquote key={i} style={style}>{b.text}</blockquote>;
          case 'code': return <pre key={i} style={style}>{b.text}</pre>;
          case 'hr': return <hr key={i} />;
          case 'prop': return <p key={i} className="d-prop"><span className="k">{b.label}</span><span>{b.text}</span></p>;
          default: return <p key={i} style={style}>{b.label && <span className="k tagk">{b.label}</span>}{b.text}</p>;
        }
      })}
    </div>
  );
}

type SendState = { phase: 'draft' } | { phase: 'counting'; id: string; left: number } | { phase: 'sent' } | { phase: 'busy' };

export function Workspace() {
  const n = useNiko();
  // The ring's place on screen, for the particle flow from and to Home.
  const ringRef = useCallback((el: HTMLDivElement | null) => { if (el) spots.set('ring', el); else spots.delete('ring'); }, []);
  const view = useLocation().pathname.replace('/', '') as 'inbox' | 'calendar' | 'notes';
  const [brief, setBrief] = useState<Brief | null>(() => (briefCache.data !== EMPTY_BRIEF ? briefCache.data : n.brief));
  const [sel, setSel] = useState<Sel | null>(null);
  const [thread, setThread] = useState<{ id: string; direction: string; sender: string; body: string; fileName: string | null }[]>([]);
  const [draft, setDraft] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [send, setSend] = useState<SendState>({ phase: 'draft' });
  const sendNow = useRef(send);
  sendNow.current = send;
  const [err, setErr] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);
  const timer = useRef<number>(0);
  // Replies sent to an email in this visit, shown under it (mail has no stored thread).
  const [mailSent, setMailSent] = useState<string[]>([]);
  const [noteSel, setNoteSel] = useState<NoteItem | null>(null);
  const [eventSel, setEventSel] = useState<EventItem | null>(null);
  const mail = useDetail<MailDetail>(sel?.kind === 'mail' ? `/mail/${sel.provider}/${encodeURIComponent(sel.id)}` : null);
  const note = useDetail<NoteDetail>(noteSel ? `/notes/${noteSel.provider}/${encodeURIComponent(noteSel.id)}` : null);
  const event = useDetail<EventDetail>(eventSel ? `/events/${eventSel.provider}/${encodeURIComponent(eventSel.id)}?tz=${new Date().getTimezoneOffset()}` : null);

  // Each screen reads only its own part: Inbox = mail + chats, Calendar = events, Notes = notes, so opening Notes
  // never calls a calendar or a mail server. Parts read in the last 5 minutes are reused when switching screens.
  // Chats (kept by Niko itself) are checked every 30 s while the page is in view; mail, calendars and notes come
  // from other services, so they refresh every 5 minutes: gentle on their rate limits and sign-in limits.
  const parts = VIEW_PARTS[view] ?? [];
  const ready = parts.every((p) => briefCache.loaded.has(p));
  const loadBrief = useCallback((force = false) => {
    const stale = parts.filter((p) => force || Date.now() - (briefCache.at[p] ?? 0) > BRIEF_FRESH_MS);
    if (!stale.length) return Promise.resolve();
    for (const p of stale) briefCache.at[p] = Date.now(); // claimed now, so a second tick doesn't ask again meanwhile
    return api<Brief>(`/brief?tz=${new Date().getTimezoneOffset()}&parts=${stale.join(',')}`)
      .then((r) => { mergeBrief(r, stale); setBrief(briefCache.data); })
      .catch((e) => { for (const p of stale) briefCache.at[p] = 0; setErr(e.message); });
  }, [view]); // eslint-disable-line react-hooks/exhaustive-deps
  const loadChats = useCallback(() => api<{ chats: Brief['chats'] }>('/brief/chats').then((r) => { briefCache.data = { ...briefCache.data, chats: r.chats }; setBrief(briefCache.data); }).catch(() => undefined), []);
  useEffect(() => { if (briefCache.data !== EMPTY_BRIEF) setBrief(briefCache.data); void loadBrief(); }, [loadBrief]);
  useEffect(() => {
    const tick = () => { if (document.hidden) return; void loadBrief(); if (parts.includes('chats')) void loadChats(); };
    const t = window.setInterval(tick, 30_000);
    document.addEventListener('visibilitychange', tick);
    return () => { window.clearInterval(t); document.removeEventListener('visibilitychange', tick); };
  }, [loadBrief, loadChats]); // eslint-disable-line react-hooks/exhaustive-deps
  // The conversation list belongs to Inbox only: on Calendar and Notes nothing is selected, so no thread is fetched.
  const items: Sel[] = brief && view === 'inbox' ? [
    ...brief.chats.map((c) => ({ kind: 'chat' as const, provider: c.provider, chatId: c.chatId, title: c.title, source: c.source })),
    ...brief.mail.map((m) => ({ kind: 'mail' as const, provider: m.provider, id: m.id, title: m.from, source: m.source, subject: m.subject })),
  ] : [];
  // The first item opens by default, unless the AI was just asked to open a particular one here.
  const openingAsked = !!n.pendingOpen && n.pendingOpen.view === view;
  useEffect(() => { if (!sel && items[0] && !openingAsked) setSel(items[0]); }, [items.length]); // eslint-disable-line react-hooks/exhaustive-deps
  // This screen's list as titles (for opening by voice), which one is open, and opening one.
  const listTitles: string[] = view === 'inbox' ? items.map((it) => (it.kind === 'mail' ? `${it.title} ${it.subject}` : it.title))
    : view === 'calendar' ? (brief?.events ?? []).map((e) => e.title) : (brief?.notes ?? []).map((e) => e.title);
  const listIndex = view === 'inbox'
    ? items.findIndex((it) => !!sel && it.kind === sel.kind && it.provider === sel.provider && (it.kind === 'chat' ? sel.kind === 'chat' && it.chatId === sel.chatId : sel.kind === 'mail' && it.id === sel.id))
    : view === 'calendar' ? (brief?.events ?? []).findIndex((e) => e.id === eventSel?.id && e.provider === eventSel?.provider)
    : (brief?.notes ?? []).findIndex((e) => e.id === noteSel?.id && e.provider === noteSel?.provider);
  // Pages: each list shows a page at a time (Settings → Appearance sets how many). Each screen keeps its own page,
  // and the page follows the open item when it is opened from elsewhere (by voice, or "next").
  const pageSize = PAGE_SIZES.includes(n.me?.appearance.pageSize ?? 10) ? n.me!.appearance.pageSize ?? 10 : 10;
  const [pageOf, setPageOf] = useState<Record<string, number>>({});
  const pages = Math.max(1, Math.ceil(listTitles.length / pageSize));
  const page = Math.min(pageOf[view] ?? 0, pages - 1);
  const pStart = page * pageSize, pEnd = pStart + pageSize;
  const goPage = (p: number) => setPageOf((m) => ({ ...m, [view]: Math.max(0, Math.min(pages - 1, p)) }));
  useEffect(() => { if (listIndex >= 0 && (listIndex < pStart || listIndex >= pEnd)) goPage(Math.floor(listIndex / pageSize)); }, [listIndex, pageSize]); // eslint-disable-line react-hooks/exhaustive-deps
  const pager = pages > 1 && (
    <nav className="pager" aria-label="Pages">
      <button type="button" className="pg" onClick={() => goPage(page - 1)} disabled={page === 0} aria-label="Previous page">‹</button>
      <span className="k" aria-live="polite">{pStart + 1}–{Math.min(pEnd, listTitles.length)} of {listTitles.length}<span className="pg-n"> · page {page + 1} of {pages}</span></span>
      <button type="button" className="pg" onClick={() => goPage(page + 1)} disabled={page >= pages - 1} aria-label="Next page">›</button>
    </nav>
  );
  const openAt = (i: number, spoken: boolean) => {
    const title = view === 'inbox' ? items[i]?.title : view === 'calendar' ? brief?.events[i]?.title : brief?.notes[i]?.title;
    if (title === undefined) return;
    if (view === 'inbox') setSel(items[i]!); else if (view === 'calendar') setEventSel(brief!.events[i]!); else setNoteSel(brief!.notes[i]!);
    if (spoken) { n.setStatus('Heard', `Opening ${title}.`, 'speaking'); window.setTimeout(n.carryOn, 1200); }
    // On a phone the open item is below the list: bring it into view.
    if (isStacked()) requestAnimationFrame(() => document.querySelector('.ws .thread')?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  };
  const selKey = sel ? (sel.kind === 'chat' ? `c:${sel.provider}:${sel.chatId}` : `m:${sel.provider}:${sel.id}`) : null;
  const loadThread = useCallback(() => {
    if (sel?.kind !== 'chat' || view !== 'inbox') return;
    const key = selKey;
    api<{ messages: typeof thread }>(`/threads/${sel.provider}/${encodeURIComponent(sel.chatId)}`)
      .then((r) => { if (key === selKeyNow.current) setThread((t) => (t.length === r.messages.length && t.every((m, i) => m.id === r.messages[i]!.id) ? t : r.messages)); })
      .catch(() => undefined);
  }, [selKey, view]); // eslint-disable-line react-hooks/exhaustive-deps
  const selKeyNow = useRef(selKey);
  selKeyNow.current = selKey;
  useEffect(() => {
    setDraft(''); setFile(null); setSend({ phase: 'draft' }); setErr(''); setThread([]); setMailSent([]);
    loadThread();
  }, [selKey]); // eslint-disable-line react-hooks/exhaustive-deps
  // An open conversation keeps itself up to date, so new messages appear and can be answered in turn.
  useEffect(() => {
    if (sel?.kind !== 'chat' || view !== 'inbox') return;
    const t = window.setInterval(() => { if (!document.hidden) loadThread(); }, 6000);
    return () => window.clearInterval(t);
  }, [selKey, view, loadThread]); // eslint-disable-line react-hooks/exhaustive-deps

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
      if (sel?.kind === 'chat') { setThread((t) => [...t, { id: 'new-' + Date.now(), direction: 'out', sender: 'Niko', body: draft, fileName: file?.name ?? null }]); window.setTimeout(loadThread, 800); }
      else setMailSent((l) => [...l, draft]);
      // "Sent" shows briefly, then an empty reply box returns, so the conversation can carry on.
      setDraft(''); setFile(null);
      window.setTimeout(() => { if (sendNow.current.phase !== 'sent') return; setSend({ phase: 'draft' }); n.rest(); }, 1600);
    } catch (e: any) { setErr(e.message); setSend({ phase: 'draft' }); n.setStatus('Problem', e.message, 'idle'); }
  }, [file, target, draft, sel, n, loadThread]);

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

  // Rewriting the draft, by voice or with the Rewrite button: the current draft and the request go to the brain,
  // and what comes back replaces the draft (still to be reviewed and sent as usual).
  const [rewriting, setRewriting] = useState(false);
  const rewrite = useCallback(async (request: string, spoken: boolean) => {
    if (!sel || send.phase !== 'draft' || rewriting) return;
    const lastIn = thread.filter((m) => m.direction === 'in').slice(-1)[0]?.body;
    const about = sel.kind === 'mail' ? `the email from ${sel.title} with subject "${sel.subject}"` : lastIn ? `the last message from ${sel.title}: "${lastIn.slice(0, 800)}"` : `a conversation with ${sel.title}`;
    const current = draft.trim();
    const message = current
      ? `This is a draft reply to ${about}.\nDRAFT START\n${current.slice(0, 3500)}\nDRAFT END\nRewrite the draft as the user asks: "${request.slice(0, 200)}". Keep what the user did not ask to change. Write only the new reply text, with no preamble and no quotation marks.`
      : `Write only the text of a reply to ${about}, as the user asks: "${request.slice(0, 200)}". No preamble.`;
    setRewriting(true);
    if (spoken) n.setStatus('Rewriting', 'Changing the draft…', 'thinking');
    try {
      const r = await api<{ reply: string }>('/chat', { body: { message, tz: new Date().getTimezoneOffset(), purpose: 'draft' } });
      // Only the reply itself: no "Here's the new draft:" lead-in, no wrapping quotes, no draft markers.
      const t = stripTags(typeof r.reply === 'string' ? r.reply : '').trim()
        .replace(/^(sure[,!.]?\s*)?(here('|’)s|here is)\s+(the|a|your)\s+[^:\n]{0,40}:\s*/i, '')
        .replace(/^DRAFT START\s*/i, '').replace(/\s*DRAFT END$/i, '')
        .replace(/^["“](.*)["”]$/s, '$1').trim();
      if (!t) throw new Error('Niko couldn’t rewrite the draft just now. Try again.');
      setDraft(t);
      if (draftKey.current) draftCache.set(draftKey.current, t);
      setErr('');
      if (spoken) n.say(`Here's the new draft. ${t}`); else n.setStatus('Draft rewritten', 'Review it, then send.', 'idle');
    } catch (e: any) {
      setErr(e.message);
      n.setStatus('Problem', e.message, 'idle');
    } finally { setRewriting(false); }
  }, [sel, send.phase, rewriting, thread, draft, n]);

  // Voice: "send it" starts the countdown, "cancel" stops it, "make it shorter" and the like rewrite the draft.
  // Anything else falls through to Niko.
  useEffect(() => {
    n.setCommandHandler((p, quiet) => {
      if (/^(send|send it|send that)\b/.test(p) && view === 'inbox') { void start('voice'); return true; }
      if (/^(cancel|stop|don't send)\b/.test(p) && send.phase === 'counting') { void cancel(); return true; }
      // "Next page", "page 3", "last page": the list's pages, when it has more than one.
      const pr = pageRequest(p);
      if (pr !== null && pages > 1) {
        const to = pr === 'next' ? page + 1 : pr === 'prev' ? page - 1 : pr === 'first' ? 0 : pr === 'last' ? pages - 1 : pr - 1;
        if (to >= 0 && to < pages) goPage(to);
        if (quiet) return true; // asked for by the AI's reply, which Niko is already saying
        n.setStatus('Heard', to < 0 ? 'This is the first page.' : to >= pages ? `There are only ${pages} pages.` : `Page ${to + 1} of ${pages}.`, 'speaking');
        window.setTimeout(n.carryOn, 1000);
        return true;
      }
      if (typeof pr === 'number' || pr === 'first' || pr === 'last') { if (!quiet) { n.setStatus('Heard', 'Everything fits on one page.', 'speaking'); window.setTimeout(n.carryOn, 1000); } return true; }
      if (quiet) return false; // the AI's reply asked only for a page; anything else is not for here
      if (scrollRequest(p)) return false; // "scroll down", "show me more", "next page" on a one-page list: scrolling, handled by Niko
      const ask = view === 'inbox' && sel && send.phase === 'draft' ? rewriteRequest(p) : null;
      if (ask) { void rewrite(ask, true); return true; }
      // "Open Testing 123021", "open the second one", "next": an item in this screen's list. A screen's name
      // ("open calendar") still means the screen.
      if (screenFor(p)) return false;
      // "The second one" means on this page; a title can be anywhere in the list (its page opens).
      const onPage = pickItem(p, listTitles.slice(pStart, pEnd), listIndex - pStart);
      const i = onPage !== null ? pStart + onPage : pickItem(p, listTitles, listIndex);
      if (i === null) return false;
      openAt(i, true);
      return true;
    });
    return () => n.setCommandHandler(null);
  }, [n, start, cancel, rewrite, sel, send.phase, view, listTitles.join('\u0001'), listIndex, page, pages, pStart, pEnd]); // eslint-disable-line react-hooks/exhaustive-deps

  // An item the AI was asked to open ("[[item:notes:…]]"), once this screen's list has arrived.
  useEffect(() => {
    const want = n.pendingOpen;
    if (!want || want.view !== view || !ready || Date.now() - want.at > 30_000) return;
    n.clearPendingOpen();
    const i = pickItem('open ' + want.title, listTitles, listIndex);
    openAt(i ?? 0, false); // not found: the first item, as usual
  }, [n.pendingOpen, view, ready, listTitles.length]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => window.clearInterval(timer.current), []);

  // "Draft replies" (Connections → What Niko may do): Niko prepares a reply as soon as a conversation opens, for you to review.
  const [drafting, setDrafting] = useState(false);
  const drafted = useRef('');
  const draftKey = useRef('');
  useEffect(() => {
    if (!sel || view !== 'inbox' || n.me?.permissions.draft === false) return;
    const lastInMsg = thread.filter((m) => m.direction === 'in').slice(-1)[0];
    const lastIn = lastInMsg?.body;
    // Each new message from them gets its own draft (once), so a back-and-forth keeps going.
    const key = sel.kind === 'chat' ? `c:${sel.chatId}:${lastInMsg?.id ?? ''}` : 'm:' + sel.id;
    if (drafted.current === key || (sel.kind === 'chat' && !lastIn) || send.phase !== 'draft' || draft.trim()) return;
    drafted.current = key; draftKey.current = key;
    // Already drafted earlier in this visit (the workspace remounts on each screen): reuse it, don't ask the AI again.
    const kept = draftCache.get(key);
    if (kept !== undefined) { setDraft((d) => d || kept); return; }
    const about = sel.kind === 'mail' ? `the email from ${sel.title} with subject "${sel.subject}"` : `the last message from ${sel.title}: "${lastIn}"`;
    setDrafting(true);
    api<{ reply: string }>('/chat', { body: { message: `Write only the text of a short, friendly reply to ${about}. No preamble.`, tz: new Date().getTimezoneOffset(), purpose: 'draft' } })
      .then((r) => { const t = stripTags(typeof r.reply === 'string' ? r.reply : ''); if (t) { if (draftCache.size > 100) draftCache.delete(draftCache.keys().next().value!); draftCache.set(key, t); } setDraft((d) => d || t); }).catch(() => undefined).finally(() => setDrafting(false));
  }, [sel, thread, view, n.me?.permissions.draft, send.phase]); // eslint-disable-line react-hooks/exhaustive-deps

  const counting = send.phase === 'counting';
  const C = 1646.2;
  const title = view[0]!.toUpperCase() + view.slice(1);
  const count = brief ? (view === 'inbox' ? items.length : view === 'calendar' ? brief.events.length : brief.notes.length) : 0;
  // The first note or event opens by default, like the first conversation does.
  useEffect(() => { if (openingAsked) return; if (view === 'notes' && !noteSel && brief?.notes[0]) setNoteSel(brief.notes[0]); if (view === 'calendar' && !eventSel && brief?.events[0]) setEventSel(brief.events[0]); }, [view, brief]); // eslint-disable-line react-hooks/exhaustive-deps
  const canFile = sel?.kind === 'chat' && n.me?.permissions.files !== false && ['telegram-bot', 'discord'].includes(sel.provider);

  return (
    <div className="ws">
      <div className="bg" />
      <div className="head"><span className="wordmark">NIKO</span><h1>{title}</h1><span className="k">{String(count).padStart(2, '0')}</span></div>
      <Dock className="rail" />
      <div className="corewrap">
        <div className="ringbox" ref={ringRef}>
          {/* The plain inner line; the ticks and all the ring's movement are drawn by the core's ring canvas. */}
          <svg className="ticks" viewBox="0 0 600 600" aria-hidden="true"><circle className="inner" cx="300" cy="300" r="276" fill="none" stroke="rgba(255,255,255,.14)" pathLength={100} /></svg>
          <svg className="sweep" viewBox="0 0 600 600" aria-hidden="true"><circle cx="300" cy="300" r="292" fill="none" strokeWidth="2.5" strokeLinecap="round" pathLength={100} /></svg>
          <svg className="count" viewBox="0 0 600 600" aria-hidden="true" style={{ opacity: counting ? 1 : 0 }}>
            <circle cx="300" cy="300" r="262" fill="none" stroke="rgba(255,255,255,.18)" strokeWidth="4" />
            <circle cx="300" cy="300" r="262" fill="none" stroke="#fff" strokeWidth="4" strokeLinecap="round" strokeDasharray={C} strokeDashoffset={counting ? C * (1 - send.left / SEND_COUNTDOWN_SECONDS) : C} style={{ transition: 'stroke-dashoffset 1s linear' }} />
          </svg>
          <ParticleCore size="86.8%" mode={n.mode} particles={1000} spot="ws" ring />
          {counting && <div className="num" role="status">{send.left}</div>}
        </div>
        <div className="status"><span className="k accent" role="status">{n.label}</span><span>{n.line}</span></div>
        <ResumeRow />
        <div className="ws-mic">
          <button className={'micbtn' + (n.mode === 'listening' ? ' live' : '')} onClick={n.toggleMic} aria-label="Talk to Niko"><Icon name="mic" /></button>
          {n.mode !== 'idle' && <button className="ib g" onClick={n.stop} aria-label="Stop"><Icon name="stop" /></button>}
        </div>
      </div>

      <div key={view} className="content hud-in">
        {err && <p className="err" role="alert">{err}</p>}
        {brief?.problems.filter((p) => parts.includes(p.part)).map((p) => <p key={p.text} className="sub">{p.text}</p>)}
        {view === 'inbox' && <>
          <section className="g list" aria-label="Messages">
            {items.length === 0 && <p className="sub" style={{ padding: 14 }}>{ready ? 'Nothing needs you. Link mail or chat apps in Connections.' : 'Loading…'}</p>}
            {items.slice(pStart, pEnd).map((it) => {
              const on = !!sel && (it.kind === 'chat' ? sel.kind === 'chat' && sel.chatId === it.chatId && sel.provider === it.provider : sel.kind === 'mail' && sel.id === it.id);
              return <button key={it.kind + (it.kind === 'chat' ? it.chatId : it.id)} className={'item' + (on ? ' on' : '')} onClick={() => setSel(it)} aria-pressed={on}><b>{it.title}</b><span className="k">{it.source}</span></button>;
            })}
            {pager}
          </section>
          {sel && (
            <section className="g thread" aria-label={`Conversation with ${sel.title}`}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12 }}><h2 style={{ fontWeight: 500, fontSize: 20 }}>{sel.title}</h2><span className="k">{sel.source}</span></div>
              {sel.kind === 'mail' && (
                <article className="letter" aria-label="Email">
                  <div className="letter-head"><b>{sel.subject || '(no subject)'}</b>{mail.data?.date && <span className="k">{when(mail.data.date)}</span>}</div>
                  {mail.data && <span className="sub">From {mail.data.from}{mail.data.to ? ` · to ${mail.data.to}` : ''}</span>}
                  {mail.loading && <p className="sub">Opening…</p>}
                  {mail.error && <p className="err" role="alert">{mail.error}</p>}
                  {mail.data && <div className="letter-body">{mail.data.text || '(This email has no text.)'}</div>}
                  {mail.data?.url && <a className="bt ext" href={mail.data.url} target="_blank" rel="noopener noreferrer">Open in {sel.source} <Icon name="external" size={16} /></a>}
                </article>
              )}
              {sel.kind === 'mail' && mailSent.map((b, i) => <div key={i} className="bubble out">{b}</div>)}
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
                  <textarea id="draft" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={drafting || rewriting ? 'Niko is writing…' : (draft.trim() ? 'Write a reply' : 'Write a reply, or tap Draft')} readOnly={counting || rewriting} rows={2} aria-busy={rewriting} />
                  {file && <div className="att"><Icon name="clip" size={18} /><span style={{ flex: 1 }}>{file.name}</span><span className="k">Not stored</span></div>}
                </div>
              )}
              <div className="actions">
                {send.phase === 'draft' && <>
                  {canFile && <>
                    <input ref={fileInput} type="file" hidden onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
                    <button className="ib" onClick={() => (file ? setFile(null) : fileInput.current?.click())} aria-label={file ? 'Remove the attachment' : 'Attach an image or file'} aria-pressed={!!file}><Icon name="clip" size={18} /></button>
                  </>}
                  <button className="sec" onClick={() => rewrite(draft.trim() ? 'Rewrite it: another version, same meaning.' : 'Write a short, friendly reply.', false)} disabled={rewriting || drafting} title="Ask Niko for another version. You can also say “make it shorter” or “say I’ll be there at 7”.">{rewriting ? 'Rewriting…' : draft.trim() ? 'Rewrite' : 'Draft'}</button>
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
        {view === 'calendar' && <>
          <section className="g list" aria-label="Upcoming events">
            {ready && brief && brief.events.length === 0 && <p className="sub" style={{ padding: 14 }}>Nothing in the next 30 days, or no calendar is linked yet.</p>}
            {!ready && !brief?.events.length && <p className="sub" style={{ padding: 14 }}>Loading…</p>}
            {brief?.events.slice(pStart, pEnd).map((e) => {
              const on = eventSel?.id === e.id && eventSel.provider === e.provider;
              return <button key={e.provider + e.id} className={'item ev' + (on ? ' on' : '')} onClick={() => setEventSel(e)} aria-pressed={on}>{(() => { const m = /^(.*\S)\s+(\S+)$/.exec(e.time); return m && !/^all$/i.test(m[1]!) ? <span className="t d"><small>{m[1]}</small>{m[2]}</span> : <span className="t">{e.time}</span>; })()}<b>{e.title}</b><span className="k">{e.source}</span></button>;
            })}
            {pager}
          </section>
          {eventSel && (
            <section className="g thread" aria-label={eventSel.title}>
              <div className="doc-head"><h2>{event.data?.title ?? eventSel.title}</h2><span className="k">{eventSel.source}</span></div>
              {event.loading && <p className="sub">Opening…</p>}
              {event.error && <p className="err" role="alert">{event.error}</p>}
              {event.data && <dl className="facts">
                <dt className="k">When</dt><dd>{event.data.allDay ? 'All day' : `${when(event.data.start)}${event.data.end ? ' – ' + clock(event.data.end) : ''}`}</dd>
                {event.data.location && <><dt className="k">Where</dt><dd>{event.data.location}</dd></>}
                {!!event.data.attendees?.length && <><dt className="k">With</dt><dd>{event.data.attendees.join(', ')}</dd></>}
              </dl>}
              {event.data?.description && <div className="letter-body">{event.data.description}</div>}
              {event.data?.url && <a className="bt ext" href={event.data.url} target="_blank" rel="noopener noreferrer">Open in {eventSel.source} <Icon name="external" size={16} /></a>}
            </section>
          )}
        </>}
        {view === 'notes' && <>
          <section className="g list" aria-label="Recent notes">
            {ready && brief && brief.notes.length === 0 && <p className="sub" style={{ padding: 14 }}>No notes yet. Link Notion or OneNote in Connections.</p>}
            {!ready && !brief?.notes.length && <p className="sub" style={{ padding: 14 }}>Loading…</p>}
            {brief?.notes.slice(pStart, pEnd).map((e) => {
              const on = noteSel?.id === e.id && noteSel.provider === e.provider;
              return <button key={e.provider + e.id} className={'item' + (on ? ' on' : '')} onClick={() => setNoteSel(e)} aria-pressed={on}><b>{e.title}</b><span className="k">{e.source}</span></button>;
            })}
            {pager}
          </section>
          {noteSel && (
            <section className="g thread" aria-label={noteSel.title}>
              <div className="doc-head"><h2>{note.data?.title ?? noteSel.title}</h2><span className="k">{noteSel.source}</span></div>
              {(note.data?.edited ?? noteSel.edited) && <span className="sub">Edited {when((note.data?.edited ?? noteSel.edited)!)}</span>}
              {note.loading && <p className="sub">Opening…</p>}
              {note.error && <p className="err" role="alert">{note.error}</p>}
              {note.data && (note.data.blocks.length ? <Blocks blocks={note.data.blocks} /> : <p className="sub">This page is empty.</p>)}
              {note.data?.more && <p className="sub">The page continues; open it to read the rest.</p>}
              {note.data?.url && <a className="bt ext" href={note.data.url} target="_blank" rel="noopener noreferrer">Open in {noteSel.source} <Icon name="external" size={16} /></a>}
            </section>
          )}
        </>}
      </div>
    </div>
  );
}
