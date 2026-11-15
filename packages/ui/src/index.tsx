import { useEffect, useRef, useState, type ReactNode } from 'react';
import { spots, startCore, startRing, type CoreHandle, type CoreMode } from './core';

export * from './core';

/** The app is served at /app on niko.sxingxian.com and at the root of nikoapp.midnightpoetry.studio. */
export const appBase = () => (location.hostname.startsWith('nikoapp.') ? '' : '/app');
export function appUrl(path = ''): string {
  if (location.hostname === 'niko.midnightpoetry.studio') return 'https://nikoapp.midnightpoetry.studio' + path;
  return appBase() + path || '/';
}

export class ApiError extends Error {
  constructor(message: string, public status: number, public data: any) { super(message); }
}
/** Same-origin JSON call. Cookies carry the session; nothing is kept in browser storage. */
export async function api<T = any>(path: string, init: { method?: string; body?: unknown; form?: FormData } = {}): Promise<T> {
  const res = await fetch('/api' + path, {
    method: init.method ?? (init.body || init.form ? 'POST' : 'GET'),
    credentials: 'same-origin',
    headers: init.body ? { 'content-type': 'application/json' } : undefined,
    body: init.form ?? (init.body ? JSON.stringify(init.body) : undefined),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data?.error ?? 'Something went wrong.', res.status, data);
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
export function ParticleCore({ size, mode = 'idle', shift = 0, particles, style, pad = 0, spot, ring }: { size: number | string; mode?: CoreMode; shift?: number; particles?: number; style?: React.CSSProperties; pad?: number; spot?: string; ring?: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const ringRef = useRef<HTMLCanvasElement>(null);
  const handle = useRef<CoreHandle | null>(null);
  useEffect(() => {
    if (!ref.current) return;
    const core = startCore(ref.current, { particles, mode });
    handle.current = core;
    // The ring of ticks (workspace only) reads the core's state each frame, so the two move together.
    const r = ring && ringRef.current ? startRing(ringRef.current, core) : null;
    return () => { r?.stop(); core.stop(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [particles]);
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

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="fld"><span className="k">{label}</span>{children}</label>;
}
