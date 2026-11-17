// The picture card on Home: while a picture is being made, particles stream out of the core and wash colour into the
// frame; when it arrives they paint it in, patch by patch, from soft to sharp. Then: Save, Share, More like this,
// changes by voice or tap, and the pictures made in this visit.
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { currentHue, Icon, sphereOf, spots } from '@niko/ui';
import { useNiko, type PictureItem } from '../niko';
import { pictureCommand } from '../speech';

const RATIO = { square: 1, wide: 16 / 9, tall: 9 / 16 } as const;
const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const fileName = (p: PictureItem) => `niko-${p.prompt.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'picture'}.${p.type === 'image/png' ? 'png' : p.type === 'image/webp' ? 'webp' : 'jpg'}`;
/** Whether this browser can hand a picture to the system's share sheet. */
const canShareFiles = () => typeof navigator !== 'undefined' && typeof navigator.canShare === 'function' && (() => { try { return navigator.canShare({ files: [new File([new Uint8Array(1)], 'x.jpg', { type: 'image/jpeg' })] }); } catch { return false; } })();

export function savePicture(p: PictureItem) {
  if (!p.url) return;
  const a = document.createElement('a');
  a.href = p.url; a.download = fileName(p); a.rel = 'noopener';
  document.body.appendChild(a); a.click(); a.remove();
}
async function sharePicture(p: PictureItem): Promise<boolean> {
  if (!p.url) return false;
  const blob = await (await fetch(p.url)).blob();
  const file = new File([blob], fileName(p), { type: blob.type });
  try { await navigator.share({ files: [file], title: 'A picture from Niko' }); return true; }
  catch (e) { return (e as Error)?.name === 'AbortError'; } // closing the share sheet is not a problem
}

/** Particles from the core into the frame, and the patches of colour they leave. */
function Paint({ pic, frame, onRevealed }: { pic: PictureItem; frame: React.RefObject<HTMLDivElement | null>; onRevealed: () => void }) {
  const cvRef = useRef<HTMLCanvasElement>(null);
  const fxRef = useRef<HTMLCanvasElement>(null);
  const done = useRef(onRevealed);
  done.current = onRevealed;
  // The washes of colour belong to the picture, so they carry on when it arrives (the effect starts again then).
  const store = useRef<{ id: number; wash: Float32Array; tint: number[] } | null>(null);
  const url = pic.status === 'done' ? pic.url : undefined;
  useEffect(() => {
    const cv = cvRef.current, fx = fxRef.current, box = frame.current;
    if (!cv || !fx || !box) return;
    const ctx = cv.getContext('2d')!, fxc = fx.getContext('2d')!;
    const still = reducedMotion();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const COLS = 18, ROWS = Math.max(6, Math.round(COLS / RATIO[pic.shape]));
    if (!store.current || store.current.id !== pic.id || store.current.wash.length !== COLS * ROWS) store.current = { id: pic.id, wash: new Float32Array(COLS * ROWS), tint: Array.from({ length: COLS * ROWS }, () => Math.random() * 50 - 25) };
    const { wash, tint } = store.current;
    const shown = new Float32Array(COLS * ROWS);
    let img: HTMLImageElement | null = null, revealAt = 0, crisp = 0, finished = false, raf = 0, last = performance.now(), spawn = 0;
    type P = { cell: number; t0: number; dur: number; sx: number; sy: number; bend: number };
    let parts: P[] = [];
    const order = Array.from({ length: COLS * ROWS }, (_, i) => i).sort(() => Math.random() - 0.5);
    if (url) {
      img = new Image();
      img.onload = () => { revealAt = performance.now(); if (still) { finished = true; done.current(); } };
      img.onerror = () => { finished = true; done.current(); };
      img.src = url;
    }
    const size = () => {
      const b = box.getBoundingClientRect();
      if (cv.width !== Math.round(b.width * dpr) || cv.height !== Math.round(b.height * dpr)) { cv.width = Math.round(b.width * dpr); cv.height = Math.round(b.height * dpr); }
      const W = window.innerWidth, H = window.innerHeight;
      if (fx.width !== Math.round(W * dpr) || fx.height !== Math.round(H * dpr)) { fx.width = Math.round(W * dpr); fx.height = Math.round(H * dpr); }
      return b;
    };
    const launch = (cell: number, now: number, delay = 0) => {
      const core = sphereOf(spots.get('home'));
      if (!core || still) { wash[cell] = Math.min(1, wash[cell]! + 0.5); return; }
      const a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * core.R;
      parts.push({ cell, t0: now + delay, dur: 650 + Math.random() * 450, sx: core.x + Math.cos(a) * r, sy: core.y + Math.sin(a) * r, bend: (Math.random() - 0.5) * 240 });
    };
    const frameFn = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000); last = now;
      const b = size(), hue = currentHue();
      const cw = b.width / COLS, ch = b.height / ROWS;
      // 1. New particles: a steady stream while painting; a burst to every patch once the picture is here.
      if (!img || !revealAt) {
        spawn += dt * (still ? 0 : 70);
        while (spawn >= 1) { spawn--; launch(Math.floor(Math.random() * wash.length), now); }
      } else if (order.length && !still) {
        for (const cell of order.splice(0, order.length)) launch(cell, now, Math.random() * 700);
      }
      // 2. Particles in flight, drawn on the screen-wide layer; each one lands in its patch.
      fxc.setTransform(dpr, 0, 0, dpr, 0, 0); fxc.clearRect(0, 0, fx.width, fx.height);
      fxc.globalCompositeOperation = 'lighter';
      const alive: P[] = [];
      for (const p of parts) {
        const u = (now - p.t0) / p.dur;
        if (u < 0) { alive.push(p); continue; }
        if (u >= 1) { if (revealAt) shown[p.cell] = Math.max(shown[p.cell]!, 0.01); else wash[p.cell] = Math.min(1, wash[p.cell]! + 0.35); continue; }
        alive.push(p);
        const e = u * u * (3 - 2 * u);
        const tx = b.left + ((p.cell % COLS) + 0.5) * cw, ty = b.top + (Math.floor(p.cell / COLS) + 0.5) * ch;
        const mx = (p.sx + tx) / 2, my = (p.sy + ty) / 2 + p.bend;
        const x = (1 - e) * (1 - e) * p.sx + 2 * (1 - e) * e * mx + e * e * tx, y = (1 - e) * (1 - e) * p.sy + 2 * (1 - e) * e * my + e * e * ty;
        const al = Math.sin(Math.PI * u);
        fxc.fillStyle = `hsla(${hue.toFixed(0)},95%,82%,${(0.9 * al).toFixed(3)})`; fxc.fillRect(x - 1.2, y - 1.2, 2.4, 2.4);
        fxc.fillStyle = `hsla(${hue.toFixed(0)},90%,70%,${(0.22 * al).toFixed(3)})`; fxc.fillRect(x - 3, y - 3, 6, 6);
      }
      parts = alive;
      fxc.globalCompositeOperation = 'source-over';
      // 3. The frame: soft washes of colour while waiting, then the picture, patch by patch, then sharp all over.
      ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, cv.width, cv.height);
      const pw = cv.width / COLS, ph = cv.height / ROWS;
      for (let i = 0; i < wash.length; i++) {
        wash[i] = Math.max(0, wash[i]! - dt * 0.18);
        if (wash[i]! <= 0.01) continue;
        const x = (i % COLS) * pw, y = Math.floor(i / COLS) * ph;
        ctx.fillStyle = `hsla(${(hue + tint[i]!).toFixed(0)},70%,${(45 + wash[i]! * 20).toFixed(0)}%,${(wash[i]! * 0.45).toFixed(3)})`;
        ctx.fillRect(x, y, pw + 1, ph + 1);
      }
      if (img && revealAt && img.complete && img.naturalWidth) {
        for (let i = 0; i < shown.length; i++) if (shown[i]! > 0) shown[i] = Math.min(1, shown[i]! + dt * 3);
        const allIn = still || (!parts.length && shown.every((v) => v >= 1));
        if (allIn) crisp = Math.min(1, crisp + dt * 1.6);
        // Cover-fit the picture into the frame.
        const s = Math.max(cv.width / img.naturalWidth, cv.height / img.naturalHeight);
        const iw = img.naturalWidth * s, ih = img.naturalHeight * s, ox = (cv.width - iw) / 2, oy = (cv.height - ih) / 2;
        ctx.save();
        ctx.filter = `blur(${((1 - crisp) * 7 * dpr).toFixed(1)}px)`;
        for (let i = 0; i < shown.length; i++) {
          if (shown[i]! <= 0) continue;
          const x = (i % COLS) * pw, y = Math.floor(i / COLS) * ph;
          ctx.globalAlpha = shown[i]!;
          ctx.save(); ctx.beginPath(); ctx.rect(x, y, pw + 1, ph + 1); ctx.clip(); ctx.drawImage(img, ox, oy, iw, ih); ctx.restore();
        }
        ctx.restore();
        if (crisp > 0) { ctx.globalAlpha = crisp; ctx.drawImage(img, ox, oy, iw, ih); ctx.globalAlpha = 1; }
        if (crisp >= 1 && !finished) { finished = true; done.current(); }
      }
      if (!finished || parts.length) raf = requestAnimationFrame(frameFn);
      else fxc.clearRect(0, 0, fx.width, fx.height);
    };
    raf = requestAnimationFrame(frameFn);
    return () => { cancelAnimationFrame(raf); fxc.clearRect(0, 0, fx.width, fx.height); };
  }, [pic.id, url]); // eslint-disable-line react-hooks/exhaustive-deps
  return <>
    <canvas ref={cvRef} className="pic-paint" aria-hidden="true" />
    {/* On the page itself: inside the glass card, a fixed layer would be cut to the card's edges. */}
    {createPortal(<canvas ref={fxRef} className="sparks" aria-hidden="true" />, document.body)}
  </>;
}

/** The card itself. `byVoice` actions come from the Home screen's command handler. */
export function PictureCard({ pic, tabbable }: { pic: PictureItem; tabbable: boolean }) {
  const n = useNiko();
  const frame = useRef<HTMLDivElement>(null);
  // A picture already painted (chosen from the strip) shows at once; a new one is painted in.
  const [revealed, setRevealed] = useState(() => pic.status === 'done');
  const seen = useRef(new Set<number>(pic.status === 'done' ? [pic.id] : []));
  const [secs, setSecs] = useState(0);
  const [change, setChange] = useState('');
  const [note, setNote] = useState('');
  const share = useRef(canShareFiles());
  useEffect(() => {
    setNote('');
    setRevealed(pic.status === 'done' && seen.current.has(pic.id));
  }, [pic.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (pic.status !== 'painting') return;
    const t = window.setInterval(() => setSecs(Math.round((Date.now() - pic.started) / 1000)), 500);
    return () => window.clearInterval(t);
  }, [pic.id, pic.status, pic.started]);
  const reveal = () => { seen.current.add(pic.id); setRevealed(true); };

  const act = async (what: 'save' | 'share' | 'more' | 'close', byVoice: boolean) => {
    if (what === 'close') { n.closePicture(); if (byVoice) n.carryOn(); return; }
    if (what === 'more') { n.paintPicture(pic.prompt, pic.shape, true, pic.asked); return; }
    if (pic.status !== 'done') { if (byVoice) { n.setStatus('Heard', 'The picture isn’t finished yet.', 'speaking'); window.setTimeout(n.carryOn, 1400); } return; }
    if (what === 'save') {
      savePicture(pic); setNote('Saved to your device.');
      if (byVoice) { n.setStatus('Heard', 'Saved to your device.', 'speaking'); window.setTimeout(n.carryOn, 1400); }
      return;
    }
    // Sharing needs a tap: browsers open the share sheet only from one.
    if (byVoice || !share.current) {
      const t = share.current ? 'Tap Share to choose where it goes.' : 'This browser can’t share pictures. Save it, then share it from your photos.';
      setNote(t); if (byVoice) { n.setStatus('Heard', t, 'speaking'); window.setTimeout(n.carryOn, 1800); }
      return;
    }
    if (!(await sharePicture(pic))) setNote('It couldn’t be shared. Try Save instead.');
  };
  // Voice: "save it", "share it", "more like this", "close it". Anything else (such as "make it night") goes to the
  // brain, which knows the last prompt and answers with a new picture.
  useEffect(() => {
    n.setCommandHandler((phrase) => { const c = pictureCommand(phrase); if (!c) return false; void act(c, true); return true; });
    return () => n.setCommandHandler(null);
  }); // eslint-disable-line react-hooks/exhaustive-deps

  const submitChange = (e: FormEvent) => { e.preventDefault(); const t = change.trim(); if (!t) return; setChange(''); void n.ask(t); };
  const painted = n.pictures.filter((x) => x.status === 'done');
  const tab = tabbable ? 0 : -1;
  const ar = RATIO[pic.shape];
  return (
    <section className="g picture" aria-label="The picture Niko made" aria-busy={pic.status === 'painting'}>
      <div className="meta">
        <span className="k" role="status">{pic.status === 'painting' ? 'Painting' : pic.status === 'failed' ? 'Not painted' : 'Niko made this'}</span>
        <span className="pic-meta">
          <span>{pic.status === 'painting' ? `${secs} s` : pic.status === 'done' && pic.label ? `${pic.label} · ${Math.max(1, Math.round((pic.ms ?? 0) / 1000))} s` : ''}</span>
          <button className="ib" style={{ width: 44, height: 44, margin: '-10px -12px -10px 0' }} onClick={() => n.closePicture()} aria-label="Hide the picture" tabIndex={tab}><Icon name="x" /></button>
        </span>
      </div>
      <div ref={frame} className={'pic-frame' + (pic.status === 'painting' ? ' busy' : '')} style={{ ['--ar' as string]: String(ar) }}>
        {pic.status !== 'failed' && !revealed && <Paint pic={pic} frame={frame} onRevealed={reveal} />}
        {pic.url && <img src={pic.url} alt={`A picture Niko made: ${pic.prompt}`} className={revealed ? 'on' : ''} draggable={false} />}
        {pic.status === 'failed' && <div className="pic-failed"><p>{pic.error}</p><button className="sec" onClick={() => n.paintPicture(pic.prompt, pic.shape, false, pic.asked)} tabIndex={tab}>Try again</button></div>}
      </div>
      <p className="pic-prompt" title={pic.prompt}>“{pic.prompt}”</p>
      {pic.status === 'done' && <>
        <div className="pic-actions">
          <button className="pri" onClick={() => void act('save', false)} tabIndex={tab}><Icon name="save" size={18} />Save</button>
          {share.current && <button className="sec" onClick={() => void act('share', false)} tabIndex={tab}><Icon name="share" size={18} />Share</button>}
          <button className="sec" onClick={() => void act('more', false)} tabIndex={tab}><Icon name="again" size={18} />More like this</button>
        </div>
        <form className="pic-change" onSubmit={submitChange}>
          <label className="sr" htmlFor="pic-change">Change the picture</label>
          <input id="pic-change" value={change} onChange={(e) => setChange(e.target.value)} placeholder="Type a change, or just say it" tabIndex={tab} maxLength={300} />
          <button className="ib" aria-label="Change it" style={{ width: 40, height: 40 }} disabled={!change.trim()} tabIndex={tab}><Icon name="arrow" size={18} /></button>
        </form>
      </>}
      {note && <p className="pic-note" role="status">{note}</p>}
      {painted.length > 1 && (
        <div className="pic-strip" role="group" aria-label="Pictures from this visit">
          {painted.map((x) => (
            <button key={x.id} className="pic-thumb" onClick={() => { seen.current.add(x.id); n.showPicture(x.id); }} aria-pressed={x.id === pic.id} aria-label={`Show: ${x.prompt.slice(0, 80)}`} tabIndex={tab}>
              <img src={x.url} alt="" draggable={false} />
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
