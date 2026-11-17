// In full screen (or opened from the Home Screen as an app), Niko keeps the screen from going to sleep with the Screen
// Wake Lock API, so it stays ready to hear "Niko". Browsers can't keep the screen on and still let the system dim it
// (the wake lock stops both), so Niko dims itself instead: after a minute with nothing going on, a dark veil fades in;
// any touch, key, mouse movement or Niko starting to listen or speak brings the screen straight back.
import { useEffect, useRef, useState } from 'react';
import { installedFull, useFullscreen } from './fullscreen';
import { useNiko } from './niko';

const DIM_AFTER_MS = 60_000;
type Sentinel = { release: () => Promise<void>; released: boolean; addEventListener: (t: 'release', f: () => void) => void };

export function Awake() {
  const n = useNiko();
  const fs = useFullscreen();
  const want = !!n.me && (fs.on || installedFull());
  const lock = useRef<Sentinel | null>(null);
  const [dim, setDim] = useState(false);
  const last = useRef(Date.now());

  // The wake lock: taken while wanted, taken again when the page comes back into view (browsers drop it when hidden).
  useEffect(() => {
    const wl = (navigator as Navigator & { wakeLock?: { request: (t: 'screen') => Promise<Sentinel> } }).wakeLock;
    if (!want || !wl) return;
    let gone = false;
    const take = async () => {
      if (gone || document.visibilityState !== 'visible' || (lock.current && !lock.current.released)) return;
      try { const s = await wl.request('screen'); if (gone) { void s.release(); return; } lock.current = s; } catch { /* battery saver, or not allowed: the screen sleeps as usual */ }
    };
    void take();
    const vis = () => { if (document.visibilityState === 'visible') void take(); };
    document.addEventListener('visibilitychange', vis);
    return () => { gone = true; document.removeEventListener('visibilitychange', vis); void lock.current?.release().catch(() => undefined); lock.current = null; };
  }, [want]);

  // Niko's own dimming.
  useEffect(() => {
    if (!want) { setDim(false); return; }
    const wake = () => { last.current = Date.now(); setDim(false); };
    const evs = ['pointermove', 'pointerdown', 'keydown', 'wheel', 'touchstart'] as const;
    for (const e of evs) window.addEventListener(e, wake, { passive: true });
    const t = window.setInterval(() => { if (Date.now() - last.current >= DIM_AFTER_MS) setDim(true); }, 2000);
    return () => { for (const e of evs) window.removeEventListener(e, wake); window.clearInterval(t); };
  }, [want]);
  // Listening, thinking or speaking counts as use.
  useEffect(() => { if (n.mode !== 'idle') { last.current = Date.now(); setDim(false); } }, [n.mode]);

  return want ? <div className={'awake-dim' + (dim ? ' on' : '')} aria-hidden="true" /> : null;
}
