// New items on Home: while Home is open and on screen, Niko asks about once a minute what has come in (the server only
// reads each kind when it is due) and shows each new item for 30 seconds. Hover or focus keeps it; Open, Reply or
// Dismiss it, or say so. It never interrupts: while you talk to Niko, or an answer or picture is open, new items wait.
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { cleanGlancePrefs, GLANCE_PARTS, glanceEvery, GLANCE_LIMIT_DEFAULTS, type GlanceItem } from '@niko/shared';
import { api, currentHue, Icon, sphereOf, spots } from '@niko/ui';
import { useNiko } from '../niko';
import { cleanCommand } from '../speech';

const LIFE_MS = 30_000;
const IDLE_PAUSE_MS = 30 * 60_000; // no checks after 30 minutes without anyone using Niko
const ICON: Record<GlanceItem['kind'], string> = { mail: 'mail', chat: 'mail', invite: 'calendar', reminder: 'calendar', note: 'note' };
const LABEL: Record<GlanceItem['kind'], string> = { mail: 'New email', chat: 'New message', invite: 'New on your calendar', reminder: 'Starting soon', note: 'Note changed' };
const said = (it: GlanceItem) => ({ mail: `New email from ${it.title}.`, chat: `New message from ${it.title}.`, invite: `New on your calendar: ${it.title}.`, reminder: `${it.title} starts soon.`, note: `${it.title} was changed.` })[it.kind];

type Card = { it: GlanceItem; start: number; used: number; held: boolean; heldAt: number; leaving: boolean; entered: boolean };

/** What the person said to the card on show: "open it", "reply", "dismiss". */
export function glanceCommand(raw: string): 'open' | 'reply' | 'dismiss' | null {
  const t = cleanCommand(raw);
  if (/^(open|show)( it| that| me| this)?$/.test(t)) return 'open';
  if (/^(reply|answer|respond)( to (it|that|them|this))?$/.test(t)) return 'reply';
  if (/^(dismiss|hide|ignore|clear|close)( it| that| this| them| all)?$|^(got it|ok|okay|later|not now|not)$/.test(t)) return 'dismiss';
  return null;
}

export function GlanceStack({ wide }: { wide: boolean }) {
  const n = useNiko();
  const prefs = cleanGlancePrefs(n.me?.appearance.glance);
  const limits = n.me?.glanceLimits ?? GLANCE_LIMIT_DEFAULTS;
  const enabled = prefs.on && limits.allowed && GLANCE_PARTS.some((p) => glanceEvery(prefs, limits, p) > 0);
  const [cards, setCards] = useState<Card[]>([]);
  const [, setTick] = useState(0);
  const queue = useRef<GlanceItem[]>([]);
  const cardsRef = useRef(cards);
  cardsRef.current = cards;
  const max = wide ? 3 : 2;
  // While Niko is listening, thinking or speaking, or an answer or picture is open, new items wait (and cards hold).
  const busy = n.mode !== 'idle' || !!n.reply || !!n.picture;
  const hidden = !!n.reply || !!n.picture;
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const nRef = useRef(n);
  nRef.current = n;
  const fx = useRef<HTMLCanvasElement>(null);
  const lastActive = useRef(Date.now());
  const sparks = useRef<{ sx: number; sy: number; tx: number; ty: number; t0: number; dur: number; lift: number }[]>([]);

  // ---- asking for new items
  useEffect(() => {
    if (!enabled) return;
    let stop = false, timer = 0, running = false;
    const run = async () => {
      window.clearTimeout(timer);
      if (stop || running) return;
      let wait = 60_000;
      if (document.visibilityState === 'visible' && Date.now() - lastActive.current < IDLE_PAUSE_MS) {
        running = true;
        try {
          const r = await api<{ items: GlanceItem[]; waitMs?: number; off?: boolean }>('/glance', { body: { tz: new Date().getTimezoneOffset() } });
          if (r.off) stop = true;
          const known = new Set([...queue.current.map((x) => x.key), ...cardsRef.current.map((c) => c.it.key)]);
          queue.current.push(...(r.items ?? []).filter((x) => !known.has(x.key)));
          wait = Math.max(45_000, r.waitMs ?? 60_000);
          setTick((x) => x + 1);
        } catch { wait = 120_000; } finally { running = false; }
      }
      if (!stop) timer = window.setTimeout(run, wait);
    };
    // Back from being away or hidden: check now rather than waiting out the minute.
    const active = () => { const wasIdle = Date.now() - lastActive.current >= IDLE_PAUSE_MS; lastActive.current = Date.now(); if (wasIdle) void run(); };
    const shown = () => { if (document.visibilityState === 'visible') { lastActive.current = Date.now(); void run(); } };
    window.addEventListener('pointerdown', active); window.addEventListener('keydown', active);
    document.addEventListener('visibilitychange', shown);
    timer = window.setTimeout(run, 2500);
    return () => { stop = true; window.clearTimeout(timer); window.removeEventListener('pointerdown', active); window.removeEventListener('keydown', active); document.removeEventListener('visibilitychange', shown); };
  }, [enabled]);
  // Anything said to Niko counts as being here.
  useEffect(() => { if (n.mode !== 'idle') lastActive.current = Date.now(); }, [n.mode]);

  // ---- showing, counting down, leaving
  const leave = (key: string) => {
    setCards((cs) => cs.map((c) => (c.it.key === key ? { ...c, leaving: true } : c)));
    window.setTimeout(() => setCards((cs) => cs.filter((c) => c.it.key !== key)), 380);
  };
  useEffect(() => {
    const t = window.setInterval(() => {
      const now = Date.now();
      // Room on screen and nothing going on: the next waiting item comes in.
      if (!busyRef.current && queue.current.length && cardsRef.current.filter((c) => !c.leaving).length < max) {
        const it = queue.current.shift()!, first = cardsRef.current.length === 0;
        setCards((cs) => [...cs, { it, start: now, used: 0, held: false, heldAt: 0, leaving: false, entered: false }]);
        window.setTimeout(() => setCards((cs) => cs.map((c) => (c.it.key === it.key ? { ...c, entered: true } : c))), 30);
        window.setTimeout(() => burst(it.key), 60);
        const p = cleanGlancePrefs(nRef.current.me?.appearance.glance);
        if (p.aloud && first) nRef.current.say(said(it));
        else if (first) { nRef.current.setStatus('New', said(it)); window.setTimeout(() => { if (nRef.current.label === 'New') nRef.current.rest(); }, 4500); }
      }
      // Time is up (time held, or while Niko is busy, does not count).
      for (const c of cardsRef.current) {
        const held = c.held || busyRef.current;
        if (!held && !c.leaving && now - c.start - c.used >= LIFE_MS) leave(c.it.key);
      }
      // While Niko is busy the cards hold; otherwise only the drain lines move.
      if (cardsRef.current.length) {
        if (busyRef.current) setCards((cs) => cs.map((c) => (c.held ? c : { ...c, used: c.used - 250 })));
        else setTick((x) => x + 1);
      }
    }, 250);
    return () => window.clearInterval(t);
  }, [max]); // eslint-disable-line react-hooks/exhaustive-deps

  const hold = (key: string, on: boolean) => setCards((cs) => cs.map((c) => {
    if (c.it.key !== key || c.leaving) return c;
    if (on && !c.held) return { ...c, held: true, heldAt: Date.now() };
    if (!on && c.held) return { ...c, held: false, used: c.used - (Date.now() - c.heldAt) };
    return c;
  }));
  const act = (c: Card, what: 'open' | 'reply' | 'dismiss') => {
    leave(c.it.key);
    if (what !== 'dismiss') n.openItem(c.it.view, c.it.open);
  };
  // Voice: "open it", "reply", "dismiss" act on the newest card on show.
  useEffect(() => {
    const live = cards.filter((c) => !c.leaving);
    if (!live.length || hidden) { n.setGlanceHandler(null); return; }
    n.setGlanceHandler((phrase) => {
      const cmd = glanceCommand(phrase), c = live[live.length - 1]!;
      if (!cmd || (cmd === 'reply' && !c.it.canReply)) return false;
      act(c, cmd);
      if (cmd === 'dismiss') { n.setStatus('Heard', 'Dismissed.', 'speaking'); window.setTimeout(n.carryOn, 900); }
      return true;
    });
    return () => n.setGlanceHandler(null);
  }); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- sparks from the core to a card that has just arrived (not with reduced motion)
  const burst = (key: string) => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const el = document.querySelector<HTMLElement>(`[data-glance="${CSS.escape(key)}"]`), core = sphereOf(spots.get('home'));
    if (!el || !core) return;
    const b = el.getBoundingClientRect(), t0 = performance.now();
    for (let i = 0; i < 70; i++) {
      const L = 2 * (b.width + b.height); let d = (i / 70) * L, tx: number, ty: number;
      if (d < b.width) { tx = b.left + d; ty = b.top; } else if ((d -= b.width) < b.height) { tx = b.right; ty = b.top + d; } else if ((d -= b.height) < b.width) { tx = b.right - d; ty = b.bottom; } else { d -= b.width; tx = b.left; ty = b.bottom - d; }
      const a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * core.R;
      sparks.current.push({ sx: core.x + Math.cos(a) * r, sy: core.y + Math.sin(a) * r, tx, ty, t0: t0 + Math.random() * 250, dur: 600 + Math.random() * 300, lift: 30 + Math.random() * 50 });
    }
    draw();
  };
  const drawing = useRef(0);
  const draw = () => {
    const cv = fx.current;
    if (!cv || drawing.current) return;
    const ctx = cv.getContext('2d')!, dpr = Math.min(window.devicePixelRatio || 1, 2);
    const frame = (t: number) => {
      const W = window.innerWidth, H = window.innerHeight;
      if (cv.width !== W * dpr || cv.height !== H * dpr) { cv.width = W * dpr; cv.height = H * dpr; }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, H); ctx.globalCompositeOperation = 'lighter';
      const h = currentHue().toFixed(0);
      sparks.current = sparks.current.filter((s) => t - s.t0 < s.dur);
      for (const s of sparks.current) {
        const u = (t - s.t0) / s.dur; if (u < 0) continue;
        const e = u * u * (3 - 2 * u), mx = (s.sx + s.tx) / 2, my = (s.sy + s.ty) / 2 - s.lift;
        const x = (1 - e) * (1 - e) * s.sx + 2 * (1 - e) * e * mx + e * e * s.tx, y = (1 - e) * (1 - e) * s.sy + 2 * (1 - e) * e * my + e * e * s.ty, al = Math.sin(Math.PI * u);
        ctx.fillStyle = `hsla(${h},95%,82%,${(0.9 * al).toFixed(2)})`; ctx.fillRect(x - 1.2, y - 1.2, 2.4, 2.4);
        ctx.fillStyle = `hsla(${h},90%,70%,${(0.22 * al).toFixed(2)})`; ctx.fillRect(x - 3, y - 3, 6, 6);
      }
      if (sparks.current.length) drawing.current = requestAnimationFrame(frame); else { drawing.current = 0; ctx.clearRect(0, 0, W, H); }
    };
    drawing.current = requestAnimationFrame(frame);
  };
  useEffect(() => () => cancelAnimationFrame(drawing.current), []);

  if (!enabled) return null;
  const now = Date.now(), waiting = queue.current.length;
  return <>
    <aside className={'glance-stack' + (hidden ? ' away' : '')} aria-label="New for you" aria-live="polite">
      {cards.map((c) => {
        const held = c.held || busy, left = Math.max(0, LIFE_MS - ((held && c.held ? c.heldAt : now) - c.start - c.used));
        const ago = Math.round((now - c.start) / 1000);
        return (
          <section key={c.it.key} data-glance={c.it.key} className={'g glance' + (c.entered && !c.leaving ? ' arrived' : '')} aria-label={`${LABEL[c.it.kind]}: ${c.it.title}`}
            onMouseEnter={() => hold(c.it.key, true)} onMouseLeave={() => hold(c.it.key, false)} onFocus={() => hold(c.it.key, true)} onBlur={() => hold(c.it.key, false)}>
            <div className="glance-top">
              <span className="glance-ic"><Icon name={ICON[c.it.kind]} size={19} /></span>
              <span className="glance-meta"><span className="k">{LABEL[c.it.kind]} · {c.it.source}</span><span>{ago < 5 ? 'now' : `${ago} s ago`} · {c.held ? 'Paused' : `${Math.ceil(left / 1000)} s`}</span></span>
              <button className="ib" aria-label="Dismiss" onClick={() => act(c, 'dismiss')}><Icon name="x" size={18} /></button>
            </div>
            <button className="glance-open" onClick={() => act(c, 'open')} aria-label={`Open ${c.it.title}`}><b className="glance-title">{c.it.title}</b><span className="glance-line">{c.it.line}</span></button>
            <div className="glance-acts">
              <button className="pri" onClick={() => act(c, 'open')}>Open</button>
              {c.it.canReply && <button className="sec" onClick={() => act(c, 'reply')}>Reply</button>}
            </div>
            <div className="glance-drain" aria-hidden="true"><i style={{ width: `${(left / LIFE_MS) * 100}%` }} /></div>
          </section>
        );
      })}
      {waiting > 0 && cards.length > 0 && <p className="glance-more">+{waiting} more waiting · they appear as these go</p>}
      {cards.length > 0 && wide && <p className="glance-hint">Say “open it”, “reply” or “dismiss”. Hover to keep it.</p>}
    </aside>
    {createPortal(<canvas ref={fx} className="sparks" aria-hidden="true" />, document.body)}
  </>;
}
