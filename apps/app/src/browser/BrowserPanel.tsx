// The browser panel on Home (as the Niko Browser mockup): the live page beside the core, with tabs, an address bar,
// back, forward and reload. On a phone it fills the space under the core.
import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from 'react';
import { Icon } from '@niko/ui';
import type { BrowserSession } from './session';
import type { Driver } from './driver';

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

export function BrowserPanel({ s, d, phone, onClose, onHandToNiko }: { s: BrowserSession; d: Driver | null; phone: boolean; onClose: () => void; onHandToNiko: () => void }) {
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
  const pill = v.phase === 'reconnecting' ? ['Reconnecting', 'warn']
    : v.need?.kind === 'handoff' ? ['Your turn', 'turn'] : v.need?.kind === 'gate' ? ['Waiting for your OK', 'turn']
    : youDrive ? ['You’re driving', 'you'] : ['Niko is driving', 'niko'];
  const live = v.phase === 'live' || v.phase === 'reconnecting';
  const focusTyper = () => typer.current?.focus({ preventScroll: true });
  // A password hand-off: the field is focused in the page, so typing goes straight there.
  useEffect(() => { if (v.need?.kind === 'handoff' && v.need.handoff === 'password') focusTyper(); }, [v.need]);
  return (
    <section className="g brw" aria-label="Niko’s browser">
      <div className="brw-head">
        <span className={'brw-pill ' + pill[1]}>{pill[1] === 'niko' || pill[1] === 'turn' ? <i className="brw-dot" /> : <Svg d={hand} size={15} />}<span className="k">{pill[0]}</span></span>
        <span className="brw-acts">
          {!phone && youDrive && !d?.currentTask && <span className="brw-min sub">{minutesText(v.minutes)}</span>}
          {d && !youDrive && <button className="bt brw-act" onClick={() => d.stop()}><Svg d={hand} size={17} />{phone ? 'Take over' : 'Take over'}</button>}
          {d && youDrive && d.currentTask && !v.need && <button className="bt brw-act" onClick={() => d.resume()}>Hand back to Niko</button>}
          {d && youDrive && !d.currentTask && !phone && <button className="bt brw-act" onClick={onHandToNiko}><Icon name="spark" size={16} />Hand to Niko</button>}
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
        {v.cursor && <span className="brw-cursor" aria-hidden="true" style={{ left: `${(v.cursor.x / v.page.width) * 100}%`, top: `${(v.cursor.y / v.page.height) * 100}%` }}><i /><b>NIKO</b></span>}
        {v.need && v.phase === 'live' && d && <NeedSheet s={s} d={d} phone={phone} />}
        {toast && <div className="brw-toast" role="status">{toast}</div>}
        {v.ignoredAt && Date.now() - v.ignoredAt < 8000 && <div className="brw-toast ignored" role="status"><span className="k">Ignored</span> This page tried to give Niko orders. Niko only follows you.</div>}
      </div>
      <p className="brw-foot sub">{phone ? minutesText(v.minutes) || 'Private session · closes when you’re done' : 'Typing into a page goes to the site, not to Niko. Private session · closes when you’re done.'}</p>
    </section>
  );
}

const ALLOW: Record<string, string> = { account: 'Create account', 'sign-in': 'Sign in', submit: 'Send', terms: 'Agree', download: 'Download', 'new-site': 'Go there' };
const SAFE_NOTE = 'Niko always asks before it submits a form, signs in, agrees to terms or downloads a file. It never pays for you.';

/** When Niko needs the person, as the mockup draws each kind: their turn (a password, a payment, an "are you human?"
 * check), an OK before an action, or a question. */
function NeedSheet({ s, d, phone }: { s: BrowserSession; d: Driver; phone: boolean }) {
  const v = s.view, n = v.need!;
  const [reply, setReply] = useState('');
  if (n.kind === 'gate') return <div className="brw-sheet" role="dialog" aria-label={n.gate.title}>
    <span className="brw-sheet-top"><span className="k accent">Niko needs your OK</span>{!phone && <span className="k quiet">Nothing is sent until you choose</span>}</span>
    <span className="brw-sheet-t">{n.gate.title}</span>
    {n.gate.details.length > 0 && <dl className="brw-dl">{n.gate.details.map(([k, val], i) => <div key={i}><dt>{k}</dt><dd>{val}</dd></div>)}</dl>}
    {!phone && <span className="brw-note">{SAFE_NOTE}</span>}
    <span className="brw-sheet-b"><button className="sec" onClick={() => d.decline(n.gate)}>Not now</button><button className="pri" onClick={() => void d.approve(n.action, n.gate)}>{ALLOW[n.gate.kind] ?? 'Allow'}</button></span>
  </div>;
  if (n.kind === 'handoff') {
    const r = n.rect;
    const spot = r && <i className="brw-spot" aria-hidden="true" style={{ left: `${(r.x / v.page.width) * 100}%`, top: `${(r.y / v.page.height) * 100}%`, width: `${(r.w / v.page.width) * 100}%`, height: `${(r.h / v.page.height) * 100}%` }} />;
    const copy = n.handoff === 'password'
      ? { k: 'Your turn', t: `Type a password for ${n.site || 'this site'}.`, p: 'What you type goes straight to the site. Niko can’t see this field, and never types or keeps your passwords.', go: 'Done, carry on', no: 'I’ll finish myself' }
      : n.handoff === 'payment'
        ? { k: 'Your turn · payment', t: 'Payment is yours to finish.', p: 'Niko filled in the order. Card fields are hidden from Niko, and it never presses Pay.', go: 'Done', no: 'Cancel order' }
        : { k: 'Your turn', t: 'This site wants a person.', p: 'Tick the box yourself, then Niko carries on. Niko never tries to get past these checks.', go: 'Done, carry on', no: 'Stop here' };
    return <>
      {spot}
      <div className={'brw-sheet turn' + (r && !phone ? ' side' : '')} role="dialog" aria-label={copy.t}>
        <span className="k">{copy.k}</span>
        <span className="brw-sheet-t">{copy.t}</span>
        <span className="brw-note">{copy.p}</span>
        <span className="brw-sheet-b"><button className="pri" onClick={() => { s.setNeed(null); d.resume(); }}>{copy.go}</button><button className="sec" onClick={() => { s.setNeed(null); d.stop(); }}>{copy.no}</button></span>
      </div>
    </>;
  }
  return <form className="brw-sheet" role="dialog" aria-label="Niko asks" onSubmit={(e) => { e.preventDefault(); const t = reply.trim(); setReply(''); s.setNeed(null); d.resume(t); }}>
    <span className="k accent">Niko asks</span>
    <span className="brw-sheet-t">{n.say}</span>
    <span className="brw-reply"><input className="in" value={reply} onChange={(e) => setReply(e.target.value)} placeholder="Reply to Niko, or say it" aria-label="Reply to Niko" /><button className="pri" disabled={!reply.trim()}>Send</button></span>
    <span className="brw-sheet-b"><button type="button" className="sec" onClick={() => { s.setNeed(null); d.stop(); }}>I’ll do it myself</button></span>
  </form>;
}
