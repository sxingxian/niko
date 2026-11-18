import { useEffect, useRef, useState, type ReactNode } from 'react';
import { currentHue, spots, startCore, startRing, type CoreHandle, type CoreMode } from './core';
import { runDesign } from './designs';
import { runBackground, type BackgroundHandle } from './backgrounds';
export { sampleDesign } from './designs';

export * from './core';
export * from './dataSource';

/** Starts the chosen design on a canvas: Nebula is the original core (startCore); the others come from designs.js and
 * behave the same way (states, voice level, sideways shift, the shared hue). */
export function startDesign(canvas: HTMLCanvasElement, design: string | undefined, opts: { particles?: number; mode?: CoreMode } = {}): CoreHandle {
  return !design || design === 'nebula' ? startCore(canvas, opts) : runDesign(canvas, design, currentHue, { mode: opts.mode });
}

/** The app is served at /app on niko.sxingxian.com and at the root of nikoapp.midnightpoetry.studio. */
export const appBase = () => (location.hostname.startsWith('nikoapp.') ? '' : '/app');
export function appUrl(path = ''): string {
  if (location.hostname === 'niko.midnightpoetry.studio') return 'https://nikoapp.midnightpoetry.studio' + path;
  return appBase() + path || '/';
}

export class ApiError extends Error {
  constructor(message: string, public status: number, public data: any) { super(message); }
}
/** Tells the app the server refused a request because the screen is locked, with when that request was sent: an
 * answer to a request sent before the latest unlock is old news and must not lock the screen again. */
export function lockedSignal(sent: number) {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('niko:locked', { detail: { sent } }));
}
/** Same-origin JSON call. Cookies carry the session; nothing is kept in browser storage. */
export async function api<T = any>(path: string, init: { method?: string; body?: unknown; form?: FormData } = {}): Promise<T> {
  const sent = Date.now();
  const res = await fetch('/api' + path, {
    method: init.method ?? (init.body || init.form ? 'POST' : 'GET'),
    credentials: 'same-origin',
    headers: init.body ? { 'content-type': 'application/json' } : undefined,
    body: init.form ?? (init.body ? JSON.stringify(init.body) : undefined),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // The server keeps the screen lock: any refused call tells the app to show the lock.
    if (res.status === 423 && data?.locked && typeof window !== 'undefined') lockedSignal(sent);
    throw new ApiError(data?.error ?? 'Something went wrong.', res.status, data);
  }
  return data as T;
}

const PATHS: Record<string, string> = {
  spark: 'M12 3c.6 4.6 3.4 7.4 9 9-5.6 1.6-8.4 4.4-9 9-.6-4.6-3.4-7.4-9-9 5.6-1.6 8.4-4.4 9-9z',
  mail: 'M5 5h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2zM3 7l9 6 9-6',
  calendar: 'M5 5h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2zM3 10h18M8 3v4M16 3v4',
  note: 'M6 3h9l4 4v14H6zM14 3v5h5M9 13h7M9 17h5',
  plug: 'M9 3v5M15 3v5M6 8h12v3a6 6 0 0 1-12 0zM12 17v4',
  gear: 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1',
  mic: 'M12 3a3 3 0 0 1 3 3v5a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3zM5 11a7 7 0 0 0 14 0M12 18v3',
  stop: 'M9 7h6a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2z',
  keys: 'M5 6h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2zM7 10h.01M11 10h.01M15 10h.01M8 14h8',
  x: 'M6 6l12 12M18 6L6 18',
  plus: 'M12 5v14M5 12h14',
  menu: 'M4 7h16M4 12h16M4 17h10',
  shield: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6zM9 12l2 2 4-4',
  lock: 'M7 11h10a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2zM8 11V8a4 4 0 0 1 8 0v3',
  clip: 'M21 11.5l-8.6 8.6a5 5 0 0 1-7.1-7.1l8.6-8.6a3.5 3.5 0 0 1 5 5l-8.5 8.5a2 2 0 0 1-2.9-2.8l7.9-7.9',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  key: 'M8 10a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM11 11l9-8M16 6l3 3M14 8l2 2',
  arrow: 'M5 12h14M13 6l6 6-6 6',
  user: 'M12 4a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM4 21a8 8 0 0 1 16 0',
  external: 'M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5',
  file: 'M7 3h7l5 5v13H7zM14 3v5h5M12 12v6M9 15l3-3 3 3',
  palette: 'M12 3a9 9 0 1 0 0 18c1.7 0 2-1.3 1.2-2.3-.8-1 0-2.7 1.5-2.7H17a4 4 0 0 0 4-4c0-5-4-9-9-9zM7.5 11h.01M10 7.5h.01M14.5 7.5h.01',
  save: 'M12 4v11M7 10l5 5 5-5M5 20h14',
  share: 'M12 15V4M8 8l4-4 4 4M5 13v6h14v-6',
  again: 'M20 12a8 8 0 1 1-2.3-5.6M20 4v5h-5',
  expand: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
  collapse: 'M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5',
  image: 'M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM3 16l5-5 4 4 3-3 6 6M15.5 9.5a1.5 1.5 0 1 0 0-.01',
  pin: 'M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21zM12 12.2a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z',
  globe: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z',
  info: 'M12 3a9 9 0 1 1 0 18a9 9 0 0 1 0-18zM12 8h.01M11 12h1v4h1',
  car: 'M5 16h14v-4l-2-5H7l-2 5v4zM5 16v2.5M19 16v2.5M5 12h14M8 14h.01M16 14h.01',
  train: 'M7 3h10a2 2 0 0 1 2 2v9a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3V5a2 2 0 0 1 2-2zM5 10h14M9 14h.01M15 14h.01M8 17l-2 4M16 17l2 4',
  walk: 'M13 5.5a1.5 1.5 0 1 0 0-.01M10 21l2-6 3 3v3M9 12l2-4 4 2 2 3M12 15l-1-4M9 12l-2 1',
  bike: 'M6 17.5a3.5 3.5 0 1 0 0-.01M18 17.5a3.5 3.5 0 1 0 0-.01M6 17.5L9.5 9h5l3.5 8.5M12 17.5L9.5 9M14 6h2.5',
  nav: 'M12 3l7 18-7-4-7 4 7-18z',
  plane: 'M10.5 21l1.5-1v-5.5l8 2.5v-2l-8-5V4.5a1.5 1.5 0 0 0-3 0V10l-8 5v2l8-2.5V20l1.5 1z',
};
export function Icon({ name, size = 22 }: { name: keyof typeof PATHS | string; size?: number }) {
  return <svg className="ic" viewBox="0 0 24 24" aria-hidden="true" style={{ width: size, height: size }}><path d={PATHS[name] ?? ''} /></svg>;
}

export function Switch({ on, onChange, label, disabled }: { on: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button type="button" className="swt" role="switch" aria-checked={on} aria-label={label} disabled={disabled} onClick={() => onChange(!on)}>
      <span className="trk"><span className="knb" /></span>
    </button>
  );
}

/** The live particle sphere. `shift` slides it sideways (used when panels open). */
/** The particle sphere. `pad` widens the canvas on both sides so particles can drift sideways (`shift`) without being cut off.
 * `spot` names it for the screen-to-screen transition. */
export function ParticleCore({ size, mode = 'idle', shift = 0, particles, style, pad = 0, spot, ring, design }: { size: number | string; mode?: CoreMode; shift?: number; particles?: number; style?: React.CSSProperties; pad?: number; spot?: string; ring?: boolean; design?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const ringRef = useRef<HTMLCanvasElement>(null);
  const handle = useRef<CoreHandle | null>(null);
  useEffect(() => {
    if (!ref.current) return;
    const core = startDesign(ref.current, design, { particles, mode });
    if (shift) core.setShift(shift);
    handle.current = core;
    // The ring of ticks (workspace only) reads the core's state each frame, so the two move together.
    const r = ring && ringRef.current ? startRing(ringRef.current, core) : null;
    return () => { r?.stop(); core.stop(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [particles, design]);
  useEffect(() => { handle.current?.setMode(mode); }, [mode]);
  useEffect(() => { handle.current?.setShift(shift); }, [shift]);
  useEffect(() => {
    if (!spot || !ref.current) return;
    const el = ref.current;
    spots.set(spot, el);
    return () => { if (spots.get(spot) === el) spots.delete(spot); };
  }, [spot]);
  const w = pad ? `calc(${typeof size === 'number' ? size + 'px' : size} + ${2 * pad}px)` : size;
  const core = <canvas ref={ref} data-core="1" role="img" aria-label="Niko particle core" style={{ width: w, height: size, display: 'block', flex: 'none', ...style }} />;
  return ring ? <><canvas ref={ringRef} className="ring" aria-hidden="true" />{core}</> : core;
}

/** A live preview of a design (picker tiles and the large preview). Animates only while on screen; off screen it
 * stops, so a grid of many designs stays light on phones. */
export function DesignPreview({ design, mode = 'idle', particles, className, label }: { design: string; mode?: CoreMode; particles?: number; className?: string; label?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const handle = useRef<CoreHandle | null>(null);
  const modeRef = useRef(mode);
  modeRef.current = mode;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const start = () => { if (!handle.current) handle.current = startDesign(el, design, { particles, mode: modeRef.current }); };
    const stop = () => { handle.current?.stop(); handle.current = null; };
    if (typeof IntersectionObserver === 'undefined') { start(); return stop; }
    const io = new IntersectionObserver(([e]) => (e?.isIntersecting ? start() : stop()), { rootMargin: '80px' });
    io.observe(el);
    return () => { io.disconnect(); stop(); };
  }, [design, particles]);
  useEffect(() => { handle.current?.setMode(mode); }, [mode]);
  return <canvas ref={ref} className={className} {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true })} style={{ display: 'block', width: '100%', height: '100%' }} />;
}

/** A live background (the big preview, picker tiles, Settings). Tiles pass paused: one settled frame and no more drawing,
 * so a grid of twenty stays light; off screen it stops altogether. */
export function BackgroundPreview({ background, mode = 'idle', paused = false, react = true, className, label }: { background: string; mode?: CoreMode; paused?: boolean; react?: boolean; className?: string; label?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const handle = useRef<BackgroundHandle | null>(null);
  const opts = useRef({ mode, paused, react });
  opts.current = { mode, paused, react };
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const start = () => { if (!handle.current) handle.current = runBackground(el, background, currentHue, opts.current); };
    const stop = () => { handle.current?.stop(); handle.current = null; };
    if (typeof IntersectionObserver === 'undefined') { start(); return stop; }
    const io = new IntersectionObserver(([e]) => (e?.isIntersecting ? start() : stop()), { rootMargin: '80px' });
    io.observe(el);
    return () => { io.disconnect(); stop(); };
  }, [background]);
  useEffect(() => { handle.current?.setMode(mode); }, [mode]);
  useEffect(() => { handle.current?.setPaused(paused); }, [paused]);
  useEffect(() => { handle.current?.setReact(react); }, [react]);
  return <canvas ref={ref} className={className} {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true })} style={{ display: 'block', width: '100%', height: '100%' }} />;
}

/** The page background behind Niko. Glow (or nothing chosen) is the plain CSS glow, as before, costing nothing to draw;
 * any other background is drawn on a canvas inside the same .bg layer, so transitions that treat .bg specially still do. */
export function Backdrop({ background, mode = 'idle', motion = true }: { background?: string; mode?: CoreMode; motion?: boolean }) {
  const live = !!background && background !== 'glow';
  return <div className={'bg' + (live ? ' bg-live' : '')}>{live && <BackgroundPreview background={background} mode={mode} react={motion} />}</div>;
}

export function PasswordField({ label, value, onChange, autoComplete, meter }: { label: string; value: string; onChange: (v: string) => void; autoComplete: string; meter?: boolean }) {
  const [show, setShow] = useState(false);
  const len = value.length, lvl = len >= 16 ? 4 : len >= 12 ? 3 : len >= 8 ? 2 : len >= 1 ? 1 : 0;
  return (
    <div className="fld">
      <label className="k" htmlFor={'pw-' + autoComplete}>{label}</label>
      <div className="pw">
        <input id={'pw-' + autoComplete} className="in" type={show ? 'text' : 'password'} autoComplete={autoComplete} value={value} onChange={(e) => onChange(e.target.value)} required />
        <button type="button" onClick={() => setShow(!show)} aria-pressed={show}>{show ? 'Hide' : 'Show'}</button>
      </div>
      {meter && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div className="meter" aria-hidden="true">{[1, 2, 3, 4].map((n) => <span key={n} className={lvl >= n ? 'on' : ''} />)}</div>
          <span className="k" role="status">{lvl >= 3 ? 'Strong' : lvl === 2 ? 'Add more' : '12 or more'}</span>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- shared controls (the same on every screen)
/** A pill switcher for choosing one of a few options (for example Files first / Only my files / Off). */
export function Segmented<T extends string>({ value, options, onChange, label, disabled }: { value: T; options: readonly (readonly [T, string])[]; onChange: (v: T) => void; label: string; disabled?: boolean }) {
  return (
    <span className="segs" role="group" aria-label={label}>
      {options.map(([v, name]) => <button key={v} type="button" className="segs-b" aria-pressed={v === value} disabled={disabled} onClick={() => v !== value && onChange(v)}>{name}</button>)}
    </span>
  );
}
/** One setting: what it is and a line about it on the left, its control (switch, select, button) on the right. */
export function SettingRow({ title, hint, children, id }: { title: ReactNode; hint?: ReactNode; children: ReactNode; id?: string }) {
  return (
    <div className="srow">
      <span className="srow-t" id={id}><span className="srow-name">{title}</span>{hint && <span className="srow-hint">{hint}</span>}</span>
      <span className="srow-c">{children}</span>
    </div>
  );
}
/** A coloured dot with a short state, such as Ready or Needs a look. */
export function Status({ tone, children }: { tone: 'ready' | 'look' | 'busy' | 'bad'; children: ReactNode }) {
  return <span className={`state ${tone}`}><i aria-hidden="true" />{children}</span>;
}
/** How full something is, 0 to 1. Turns amber from `warnAt`. */
export function Meter({ value, warnAt = 0.8, label }: { value: number; warnAt?: number; label: string }) {
  const v = Math.max(0, Math.min(1, value || 0));
  return <span className={'fillbar' + (v >= warnAt ? ' warn' : '')} role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(v * 100)}><i style={{ width: `${v * 100}%` }} /></span>;
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="fld"><span className="k">{label}</span>{children}</label>;
}
