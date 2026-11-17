// Full screen: the browser's Fullscreen API where it exists (desktop browsers, Android, iPad), with Safari's older
// prefixed names. iPhone Safari has no full screen for pages: there, Niko added to the Home Screen opens without the
// browser's bars instead. An app installed on Android opens in full screen by itself (manifest display: fullscreen).
import { useEffect, useState } from 'react';

type Doc = Document & { webkitFullscreenElement?: Element | null; webkitExitFullscreen?: () => Promise<void> | void; webkitFullscreenEnabled?: boolean };
type El = HTMLElement & { webkitRequestFullscreen?: () => Promise<void> | void };
const doc = () => document as Doc;

export const fullscreenSupported = () => typeof document !== 'undefined' && !!(doc().fullscreenEnabled || doc().webkitFullscreenEnabled);
export const isFullscreen = () => !!(doc().fullscreenElement || doc().webkitFullscreenElement);
/** Opened from the Home Screen as an app that already fills the screen. */
export const installedFull = () => typeof window !== 'undefined' && (window.matchMedia('(display-mode: fullscreen)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true);

/** Full screen on. Browsers allow it only right after a tap or a key, so by voice this can be refused: then false. */
export async function enterFullscreen(): Promise<boolean> {
  if (isFullscreen()) return true;
  try {
    const el = document.documentElement as El;
    await (el.requestFullscreen ? el.requestFullscreen({ navigationUI: 'hide' }) : el.webkitRequestFullscreen?.());
  } catch { return false; }
  return isFullscreen();
}
/** Full screen off (no tap needed). */
export async function exitFullscreen(): Promise<void> {
  try { if (isFullscreen()) await (doc().exitFullscreen ? doc().exitFullscreen() : doc().webkitExitFullscreen?.()); } catch { /* already off */ }
}

export async function toggleFullscreen(): Promise<void> {
  try {
    if (isFullscreen()) { await (doc().exitFullscreen ? doc().exitFullscreen() : doc().webkitExitFullscreen?.()); return; }
    const el = document.documentElement as El;
    await (el.requestFullscreen ? el.requestFullscreen({ navigationUI: 'hide' }) : el.webkitRequestFullscreen?.());
  } catch { /* refused (no tap, or the browser said no): nothing changes */ }
}

/** Whether to offer the button, and whether full screen is on now. */
export function useFullscreen(): { offer: boolean; on: boolean } {
  const [on, setOn] = useState(isFullscreen);
  useEffect(() => {
    const up = () => setOn(isFullscreen());
    document.addEventListener('fullscreenchange', up);
    document.addEventListener('webkitfullscreenchange', up);
    return () => { document.removeEventListener('fullscreenchange', up); document.removeEventListener('webkitfullscreenchange', up); };
  }, []);
  // Hidden where pages can't go full screen, and in an installed app that already fills the screen.
  return { offer: fullscreenSupported() && (on || !installedFull()), on };
}
