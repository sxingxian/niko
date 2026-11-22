// The browser panel on Home (as the Niko Browser mockup): the live page beside the core, with tabs, an address bar,
// back, forward and reload. On a phone it fills the space under the core.
import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from 'react';
import { Icon } from '@niko/ui';
import type { BrowserSession } from './session';

const back = 'M19 12H5M11 6l-6 6 6 6';
const fwd = 'M5 12h14M13 6l6 6-6 6';
const hand = 'M8 13V5.5a1.5 1.5 0 0 1 3 0V12M11 11.5V4a1.5 1.5 0 0 1 3 0v7.5M14 11.5V5.5a1.5 1.5 0 0 1 3 0V13c0 4-2.5 7-6 7-2.6 0-4-1.2-5.5-3.5L4 13.5a1.6 1.6 0 0 1 2.6-1.8L8 13.5';
const Svg = ({ d, size = 20 }: { d: string; size?: number }) => <svg className="ic" viewBox="0 0 24 24" aria-hidden="true" style={{ width: size, height: size }}><path d={d} /></svg>;

export function useBrowserView(s: BrowserSession | null) {
  return useSyncExternalStore((fn) => (s ? s.subscribe(fn) : () => undefined), () => s?.view ?? null, () => null);
}

function minutesText(m: { left: number | null } | null): string {
  if (!m || m.left === null) return '';
  const min = Math.floor(m.left / 60);
  return min >= 1 ? `${min} min left today` : 'Under a minute left';
}

export function BrowserPanel({ s, phone, onClose }: { s: BrowserSession; phone: boolean; onClose: () => void }) {
  const v = useBrowserView(s)!;
  const canvas = useRef<HTMLCanvasElement>(null);
  const typer = useRef<HTMLTextAreaElement>(null);
  const [addr, setAddr] = useState('');
  const [editing, setEditing] = useState(false);
  const composing = useRef(false);
  // The canvas's size sets the page's size in the browser: keep them matched as the panel changes size.
  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const fit = () => s.setCanvas(el, phone);
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => { ro.disconnect(); s.setCanvas(null, phone); };
  }, [s, phone]);
  useEffect(() => { if (!editing) setAddr(v.url); }, [v.url, editing]);
  const [toast, setToast] = useState<string | null>(null);
  useEffect(() => {
    if (!v.notice) return;
    setToast(v.notice.text);
    const t = window.setTimeout(() => setToast(null), 4000);
    return () => window.clearTimeout(t);
  }, [v.notice]);
  const go = (e: FormEvent) => { e.preventDefault(); setEditing(false); (document.activeElement as HTMLElement | null)?.blur(); if (addr.trim()) void s.go(addr); };
  const youDrive = v.driver === 'you';
  const pill = v.phase === 'reconnecting' ? ['Reconnecting', 'warn'] : youDrive ? ['You’re driving', 'you'] : ['Niko is driving', 'niko'];
  const live = v.phase === 'live' || v.phase === 'reconnecting';
  const focusTyper = () => typer.current?.focus({ preventScroll: true });
  return (
    <section className="g brw" aria-label="Niko’s browser">
      <div className="brw-head">
        <span className={'brw-pill ' + pill[1]}>{pill[1] === 'niko' ? <i className="brw-dot" /> : <Svg d={hand} size={15} />}<span className="k">{pill[0]}</span></span>
        <span className="brw-acts">
          {!phone && <span className="brw-min sub">{minutesText(v.minutes)}</span>}
          <button className="ib" style={{ width: 40, height: 40 }} onClick={onClose} aria-label="Close the browser"><Icon name="x" size={20} /></button>
        </span>
      </div>
      {v.tabs.length > 0 && !phone && (
        <div className="brw-tabs" role="tablist" aria-label="Tabs">
          {v.tabs.map((t) => (
            <span key={t.targetId} className="brw-tab" aria-selected={t.targetId === v.active} role="tab">
              <button className="brw-tab-go" onClick={() => void s.switchTab(t.targetId)}>{t.title || (t.url ? t.url.replace(/^https?:\/\/(www\.)?/, '').split('/')[0] : 'New tab')}</button>
              <button className="brw-tab-x" onClick={() => void s.closeTab(t.targetId)} aria-label={`Close ${t.title || 'tab'}`}><Icon name="x" size={14} /></button>
            </span>
          ))}
          <button className="ib brw-newtab" onClick={() => void s.newTab()} aria-label="New tab"><Icon name="plus" size={16} /></button>
        </div>
      )}
      <form className="brw-nav" onSubmit={go}>
        {!phone && <>
          <button type="button" className="ib" style={{ width: 40, height: 40 }} onClick={() => void s.back()} disabled={!v.canBack || !youDrive} aria-label="Back"><Svg d={back} /></button>
          <button type="button" className="ib" style={{ width: 40, height: 40 }} onClick={() => void s.forward()} disabled={!v.canForward || !youDrive} aria-label="Forward"><Svg d={fwd} /></button>
          <button type="button" className="ib" style={{ width: 40, height: 40 }} onClick={() => void s.reload()} disabled={!youDrive} aria-label="Reload"><Icon name="again" size={20} /></button>
        </>}
        <label className="brw-addr">
          <span className={'brw-lock' + (v.url.startsWith('https:') ? '' : ' plain')} aria-hidden="true"><Icon name="lock" size={14} /></span>
          <span className="sr">Address</span>
          <input value={addr} onChange={(e) => setAddr(e.target.value)} onFocus={(e) => { setEditing(true); e.currentTarget.select(); }} onBlur={() => setEditing(false)}
            placeholder="Search or type an address" inputMode="url" autoCapitalize="off" autoCorrect="off" spellCheck={false} enterKeyHint="go" disabled={!youDrive || !live} />
        </label>
      </form>
      <div className={'brw-view' + (v.loading ? ' loading' : '')}>
        <canvas ref={canvas} className="brw-canvas" role="img" aria-label={v.title ? `The page: ${v.title}` : 'The page'}
          onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); s.pointer('down', e.nativeEvent); focusTyper(); }}
          onPointerMove={(e) => s.pointer('move', e.nativeEvent)}
          onPointerUp={(e) => s.pointer('up', e.nativeEvent)}
          onWheel={(e) => s.wheel(e.nativeEvent)}
          onContextMenu={(e) => e.preventDefault()} />
        {/* Typing goes to the page through this box: it catches every kind of typing (other languages, emoji,
            the phone's own keyboard) and sends it straight to the site. */}
        <textarea ref={typer} className="brw-typer" aria-label="Type into the page" autoCapitalize="off" autoCorrect="off" spellCheck={false}
          onKeyDown={(e) => { if (composing.current) return; if (s.key(e.nativeEvent)) e.preventDefault(); }}
          onCompositionStart={() => { composing.current = true; }}
          onCompositionEnd={(e) => { composing.current = false; s.text(e.data); e.currentTarget.value = ''; }}
          onInput={(e) => { if (composing.current) return; const t = e.currentTarget.value; e.currentTarget.value = ''; s.text(t); }}
          onPaste={(e) => { e.preventDefault(); s.text(e.clipboardData.getData('text/plain')); }} />
        {(v.phase === 'opening' || (v.loading && !live)) && <div className="brw-cover"><span className="brw-bar"><i /></span><span className="k">Starting a private browser</span></div>}
        {v.phase === 'reconnecting' && <div className="brw-cover soft"><span className="k">Reconnecting…</span></div>}
        {(v.phase === 'ended' || v.phase === 'failed') && v.error && <div className="brw-cover"><p className="brw-end">{v.error}</p><button className="sec" onClick={onClose}>Close</button></div>}
        {v.idleAsk && v.phase === 'live' && <div className="brw-sheet" role="dialog" aria-label="Still there?"><span className="k accent">Still there?</span><span className="brw-sheet-t">The browser closes in 30 seconds if it isn’t used.</span><span className="brw-sheet-b"><button className="pri" onClick={() => s.stillHere()}>Keep it open</button><button className="sec" onClick={onClose}>Close it</button></span></div>}
        {toast && <div className="brw-toast" role="status">{toast}</div>}
      </div>
      <p className="brw-foot sub">{phone ? minutesText(v.minutes) || 'Private session · closes when you’re done' : 'Typing into a page goes to the site, not to Niko. Private session · closes when you’re done.'}</p>
    </section>
  );
}
