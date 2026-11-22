// Niko's browser in the app: one open browser at a time. Niko's server opens it and hands this device a short-lived
// pass; from then on the live picture, taps and typing go straight between this device and the browser service.
// The server only hears from this device every 30 seconds (so it can close the browser when time runs out).
import { api, ApiError, Cdp } from '@niko/ui';
import { hostBlocked, openableHost, toAddress, type BrowserAction, type Gate, type HandoffKind } from '@niko/shared';

export type BrowserPhase = 'opening' | 'live' | 'reconnecting' | 'ended' | 'failed';
export type BrowserDriver = 'you' | 'niko';
export interface BrowserTab { targetId: string; title: string; url: string }
export interface BrowserMinutes { used: number; cap: number; left: number | null; refillAt: string }
/** When Niko needs the person: a hand-off (their part), an OK before an action, or a question. */
export type BrowserNeed =
  | { kind: 'handoff'; handoff: HandoffKind; ref?: number; say: string }
  | { kind: 'gate'; gate: Gate; action: BrowserAction; say: string }
  | { kind: 'ask'; say: string };
export interface BrowserView {
  phase: BrowserPhase;
  id: string | null;
  tabs: BrowserTab[];
  active: string | null;
  url: string;
  title: string;
  canBack: boolean;
  canForward: boolean;
  loading: boolean;
  driver: BrowserDriver;
  /** Something to tell the person in the panel (a blocked site, a reconnect), with when it was said. */
  notice: { text: string; at: number } | null;
  /** Why it closed or failed, worded for the person. */
  error: string | null;
  minutes: BrowserMinutes | null;
  /** No taps or typing for a while: asks "Still there?" before closing. */
  idleAsk: boolean;
  /** Niko's cursor on the page (page pixels), while Niko acts. */
  cursor: { x: number; y: number } | null;
  /** The page's size in the browser (page pixels), to place the cursor. */
  page: { width: number; height: number };
  need: BrowserNeed | null;
  /** When the page last tried to give Niko orders (shown as "Ignored"). */
  ignoredAt: number | null;
}

const BEAT_MS = 30_000;
const IDLE_ASK_MS = 3 * 60_000;
const IDLE_CLOSE_MS = 30_000;
const ENDED: Record<string, string> = {
  limit: 'Today’s browser time is used up, so the browser closed.',
  idle: 'The browser closed because it wasn’t being used.',
  removed: 'The browser closed: browsing is switched off.',
  replaced: 'The browser was opened somewhere else, so it closed here.',
  closed: 'The browser closed.',
  failed: 'The browser stopped working and closed.',
};
// Links that open a new window or tab open in the same tab instead: the panel shows one tab at a time, and Niko
// opens new tabs itself (so each one gets its own pass).
const SAME_TAB = `(() => { try {
  const fix = (a) => { if (a && a.target && a.target !== '_self') a.target = '_self'; };
  document.addEventListener('click', (e) => { const a = e.target && e.target.closest ? e.target.closest('a[target]') : null; fix(a); }, true);
  const open = window.open; window.open = function (u) { if (u) { location.href = u; return window; } return open.apply(window, arguments); };
} catch (e) {} })();`;

/** Keys that don't type text, as the browser expects them (windowsVirtualKeyCode). Text goes through insertText. */
const KEYS: Record<string, [string, number]> = {
  Enter: ['Enter', 13], Backspace: ['Backspace', 8], Tab: ['Tab', 9], Escape: ['Escape', 27], Delete: ['Delete', 46],
  ArrowLeft: ['ArrowLeft', 37], ArrowUp: ['ArrowUp', 38], ArrowRight: ['ArrowRight', 39], ArrowDown: ['ArrowDown', 40],
  Home: ['Home', 36], End: ['End', 35], PageUp: ['PageUp', 33], PageDown: ['PageDown', 34],
};
const modsOf = (e: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) => (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);

export class BrowserSession {
  private v: BrowserView = { phase: 'opening', id: null, tabs: [], active: null, url: '', title: '', canBack: false, canForward: false, loading: true, driver: 'you', notice: null, error: null, minutes: null, idleAsk: false, cursor: null, page: { width: 800, height: 520 }, need: null, ignoredAt: null };
  private subs = new Set<() => void>();
  private cdp: Cdp | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private lastFrame: ImageBitmap | null = null;
  private size = { width: 800, height: 520, mobile: false, dsf: 1 };
  private beatTimer = 0;
  private idleTimer = 0;
  private lastInput = Date.now();
  private reconnects = 0;
  private closing = false;
  private resizeTimer = 0;
  /** Sites the admin blocked (from the server): the panel refuses them before the page even asks. */
  blocked: string[] = [];
  /** Called when the browser ends, with why (for Niko to say). */
  onEnded: ((text: string) => void) | null = null;

  get view(): BrowserView { return this.v; }
  subscribe(fn: () => void): () => void { this.subs.add(fn); return () => this.subs.delete(fn); }
  private set(p: Partial<BrowserView>) { this.v = { ...this.v, ...p }; for (const s of this.subs) s(); }
  private say(text: string) { this.set({ notice: { text, at: Date.now() } }); }

  // ---------------------------------------------------------------- opening and closing
  async open(to?: string): Promise<void> {
    this.set({ phase: 'opening', loading: true, error: null });
    try {
      const r = await api<{ id: string; targetId: string; ws: string; minutes: BrowserMinutes }>('/browser/open', { body: to ? { url: to } : {} });
      this.set({ id: r.id, minutes: r.minutes, tabs: [{ targetId: r.targetId, title: '', url: to ?? '' }], active: r.targetId });
      await this.connect(r.targetId, r.ws);
      this.beatTimer = window.setInterval(() => void this.beat(), BEAT_MS);
      this.idleTimer = window.setInterval(() => this.checkIdle(), 10_000);
    } catch (e) {
      const text = e instanceof ApiError ? (e.data?.code === 'minutes' ? `Today’s browser time is used up. It’s back at ${new Date(e.data.refillAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.` : e.message) : 'The browser couldn’t be opened.';
      this.set({ phase: 'failed', loading: false, error: text });
      throw new Error(text);
    }
  }

  async close(why: 'closed' | 'quiet' = 'closed'): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    this.stopTimers();
    this.cdp?.close(); this.cdp = null;
    const id = this.v.id;
    this.set({ phase: 'ended', loading: false });
    if (id) await api(`/browser/${id}/close`, { method: 'POST' }).catch(() => undefined);
    if (why === 'closed') this.lastFrame?.close();
  }

  private stopTimers() { window.clearInterval(this.beatTimer); window.clearInterval(this.idleTimer); window.clearTimeout(this.resizeTimer); }

  private ended(why: string, tellServer = false) {
    if (this.closing) return;
    this.closing = true;
    this.stopTimers();
    this.cdp?.close(); this.cdp = null;
    if (tellServer && this.v.id) void api(`/browser/${this.v.id}/close`, { method: 'POST' }).catch(() => undefined);
    const text = ENDED[why] ?? ENDED.closed!;
    this.set({ phase: 'ended', loading: false, error: text });
    this.onEnded?.(text);
  }

  private async beat() {
    if (!this.v.id || this.closing) return;
    try {
      const r = await api<{ ended?: boolean; why?: string; minutes?: BrowserMinutes }>(`/browser/${this.v.id}/beat`, { method: 'POST' });
      if (r.ended) this.ended(r.why ?? 'closed');
      else if (r.minutes) this.set({ minutes: r.minutes });
    } catch { /* offline for a moment: the next check-in tries again */ }
  }

  private checkIdle() {
    const quiet = Date.now() - this.lastInput;
    if (this.v.driver === 'niko') { this.lastInput = Date.now(); return; }
    if (quiet >= IDLE_ASK_MS + IDLE_CLOSE_MS) this.ended('idle', true);
    else if (quiet >= IDLE_ASK_MS && !this.v.idleAsk) this.set({ idleAsk: true });
  }
  /** "I'm still here" (or any tap or key): the idle question goes away. */
  stillHere() { this.lastInput = Date.now(); if (this.v.idleAsk) this.set({ idleAsk: false }); }
  /** Niko is acting (or stopped acting): the panel shows who drives, and idle time doesn't count while Niko works. */
  setDriver(d: BrowserDriver) { this.lastInput = Date.now(); this.set({ driver: d, ...(d === 'you' ? { cursor: null } : {}) }); }
  setCursor(p: { x: number; y: number } | null) { this.set({ cursor: p }); }
  setNeed(n: BrowserNeed | null) { this.set({ need: n }); }
  flagIgnored() { this.set({ ignoredAt: Date.now() }); }

  // ---------------------------------------------------------------- the connection to one tab
  /** The CDP connection for Niko's own actions (stage 2 onwards). */
  get connection(): Cdp | null { return this.cdp; }

  private async connect(targetId: string, ws: string): Promise<void> {
    this.cdp?.close();
    const cdp = new Cdp(ws);
    this.cdp = cdp;
    await cdp.opened;
    cdp.onClose = () => { if (this.cdp === cdp && !this.closing) void this.reconnect(); };
    cdp.on((e) => this.event(cdp, e.method, e.params));
    await cdp.send('Page.enable');
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: SAME_TAB }).catch(() => undefined);
    await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Request' }] }).catch(() => undefined);
    await this.applySize(cdp);
    this.reconnects = 0;
    this.set({ phase: 'live', active: targetId });
    await this.refreshPlace(cdp);
  }

  private async reconnect() {
    if (this.closing || !this.v.id || !this.v.active) return;
    if (this.reconnects++ >= 3) { this.ended('failed'); return; }
    this.set({ phase: 'reconnecting' });
    await new Promise((r) => setTimeout(r, 800 * this.reconnects));
    try {
      const p = await api<{ ws: string }>(`/browser/${this.v.id}/pass`, { body: { targetId: this.v.active } });
      await this.connect(this.v.active, p.ws);
    } catch (e) {
      if (e instanceof ApiError && e.status === 410) this.ended('closed');
      else void this.reconnect();
    }
  }

  private event(cdp: Cdp, method: string, p: any) {
    if (cdp !== this.cdp) return;
    if (method === 'Page.screencastFrame') {
      void cdp.send('Page.screencastFrameAck', { sessionId: p.sessionId }).catch(() => undefined);
      void this.draw(String(p.data ?? ''));
    } else if (method === 'Page.frameNavigated' && !p.frame?.parentId) {
      this.set({ url: String(p.frame?.url ?? ''), loading: true });
      void this.refreshPlace(cdp);
    } else if (method === 'Page.loadEventFired') {
      this.set({ loading: false });
      void this.refreshPlace(cdp);
    } else if (method === 'Fetch.requestPaused') {
      void this.guard(cdp, p);
    }
  }

  /** Every page load is checked before it is sent: public http(s) sites only, never one the admin blocked. */
  private async guard(cdp: Cdp, p: any) {
    const url = String(p.request?.url ?? '');
    const host = url === 'about:blank' ? 'about' : openableHost(url);
    const ok = url === 'about:blank' || (!!host && !hostBlocked(host, this.blocked));
    if (ok) { await cdp.send('Fetch.continueRequest', { requestId: p.requestId }).catch(() => undefined); return; }
    await cdp.send('Fetch.failRequest', { requestId: p.requestId, errorReason: 'BlockedByClient' }).catch(() => undefined);
    this.say(host ? 'Niko can’t open this site.' : 'That isn’t a website Niko can open.');
  }

  private async refreshPlace(cdp: Cdp) {
    try {
      const h = await cdp.send<{ currentIndex: number; entries: { url: string; title: string }[] }>('Page.getNavigationHistory');
      const cur = h.entries[h.currentIndex];
      const url = cur?.url && cur.url !== 'about:blank' ? cur.url : '';
      const title = cur?.title ?? '';
      this.set({ url, title, canBack: h.currentIndex > 0, canForward: h.currentIndex < h.entries.length - 1, tabs: this.v.tabs.map((t) => (t.targetId === this.v.active ? { ...t, url, title } : t)) });
    } catch { /* the page is changing; the next event refreshes it */ }
  }

  // ---------------------------------------------------------------- the picture
  /** The canvas the panel draws into. Its size sets the page's size in the browser. */
  setCanvas(el: HTMLCanvasElement | null, mobile: boolean) {
    this.canvas = el;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const dsf = Math.min(window.devicePixelRatio || 1, 2);
    const next = { width: Math.max(320, Math.round(rect.width)), height: Math.max(240, Math.round(rect.height)), mobile, dsf };
    const changed = next.width !== this.size.width || next.height !== this.size.height || next.mobile !== this.size.mobile || next.dsf !== this.size.dsf;
    this.size = next;
    if (changed) this.set({ page: { width: next.width, height: next.height } });
    el.width = Math.round(next.width * dsf); el.height = Math.round(next.height * dsf);
    if (this.lastFrame) this.paint(this.lastFrame);
    if (changed && this.cdp) { window.clearTimeout(this.resizeTimer); this.resizeTimer = window.setTimeout(() => { if (this.cdp) void this.applySize(this.cdp); }, 250); }
  }

  private async applySize(cdp: Cdp) {
    const { width, height, mobile, dsf } = this.size;
    await cdp.send('Page.stopScreencast').catch(() => undefined);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: dsf, mobile }).catch(() => undefined);
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: mobile, maxTouchPoints: mobile ? 5 : 0 }).catch(() => undefined);
    await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 72, maxWidth: Math.round(width * dsf), maxHeight: Math.round(height * dsf), everyNthFrame: 1 });
  }

  private async draw(b64: string) {
    if (!b64) return;
    try {
      const bin = atob(b64), bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
      this.lastFrame?.close();
      this.lastFrame = bmp;
      this.paint(bmp);
      if (this.v.loading && this.v.phase === 'live') this.set({ loading: false });
    } catch { /* a frame that can't be read is skipped */ }
  }
  private paint(bmp: ImageBitmap) {
    const c = this.canvas;
    if (!c) return;
    const g = c.getContext('2d');
    if (!g) return;
    g.drawImage(bmp, 0, 0, c.width, c.height);
  }

  // ---------------------------------------------------------------- your taps and typing
  /** A point on the canvas, in the page's own pixels. */
  private at(e: { clientX: number; clientY: number }) {
    const r = this.canvas!.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * this.size.width, y: ((e.clientY - r.top) / r.height) * this.size.height };
  }
  private canAct() { return !!this.cdp && this.v.phase === 'live' && this.v.driver === 'you'; }

  pointer(kind: 'down' | 'move' | 'up', e: PointerEvent) {
    this.stillHere();
    if (!this.canAct() || !this.canvas) return;
    const { x, y } = this.at(e);
    if (e.pointerType === 'touch' && this.size.mobile) {
      const type = kind === 'down' ? 'touchStart' : kind === 'move' ? 'touchMove' : 'touchEnd';
      void this.cdp!.send('Input.dispatchTouchEvent', { type, touchPoints: kind === 'up' ? [] : [{ x, y }] }).catch(() => undefined);
      return;
    }
    const type = kind === 'down' ? 'mousePressed' : kind === 'move' ? 'mouseMoved' : 'mouseReleased';
    const button = kind === 'move' ? (e.buttons & 1 ? 'left' : 'none') : e.button === 2 ? 'right' : 'left';
    void this.cdp!.send('Input.dispatchMouseEvent', { type, x, y, button, buttons: e.buttons, clickCount: kind === 'move' ? 0 : 1, modifiers: modsOf(e) }).catch(() => undefined);
  }
  wheel(e: WheelEvent) {
    this.stillHere();
    if (!this.canAct() || !this.canvas) return;
    const { x, y } = this.at(e);
    void this.cdp!.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: e.deltaX, deltaY: e.deltaY, modifiers: modsOf(e) }).catch(() => undefined);
  }
  /** A key that doesn't type text (Enter, Backspace, arrows…) or a shortcut. Returns true when it was sent. */
  key(e: KeyboardEvent): boolean {
    this.stillHere();
    if (!this.canAct()) return false;
    const special = KEYS[e.key];
    const shortcut = (e.ctrlKey || e.metaKey) && /^[a-z]$/i.test(e.key);
    if (!special && !shortcut) return false;
    const [key, code] = special ?? [e.key, e.key.toUpperCase().charCodeAt(0)];
    const commands = shortcut ? ({ a: ['selectAll'], c: ['copy'], x: ['cut'], z: [e.shiftKey ? 'redo' : 'undo'] } as Record<string, string[]>)[e.key.toLowerCase()] : undefined;
    const base = { key, code: e.code || key, windowsVirtualKeyCode: code, modifiers: modsOf(e) };
    void this.cdp!.send('Input.dispatchKeyEvent', { type: key === 'Enter' ? 'keyDown' : 'rawKeyDown', ...base, ...(key === 'Enter' ? { text: '\r' } : {}), ...(commands ? { commands } : {}) })
      .then(() => this.cdp?.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base })).catch(() => undefined);
    return true;
  }
  /** Typed or pasted text, as it is (any language, emoji). */
  text(t: string) {
    this.stillHere();
    if (!t || !this.canAct()) return;
    void this.cdp!.send('Input.insertText', { text: t }).catch(() => undefined);
  }

  // ---------------------------------------------------------------- going places
  async go(raw: string): Promise<void> {
    this.stillHere();
    const url = toAddress(raw) ?? `https://duckduckgo.com/?q=${encodeURIComponent(raw.trim())}`;
    const host = openableHost(url);
    if (!host || hostBlocked(host, this.blocked)) { this.say(host ? 'Niko can’t open this site.' : 'That isn’t a website Niko can open.'); return; }
    await this.cdp?.send('Page.navigate', { url }).catch(() => undefined);
  }
  async back() { await this.history(-1); }
  async forward() { await this.history(1); }
  private async history(step: number) {
    this.stillHere();
    const cdp = this.cdp;
    if (!cdp) return;
    const h = await cdp.send<{ currentIndex: number; entries: { id: number }[] }>('Page.getNavigationHistory').catch(() => null);
    const entry = h?.entries[h.currentIndex + step];
    if (entry) await cdp.send('Page.navigateToHistoryEntry', { entryId: entry.id }).catch(() => undefined);
  }
  async reload() { this.stillHere(); await this.cdp?.send('Page.reload').catch(() => undefined); }

  async newTab(to?: string): Promise<void> {
    this.stillHere();
    if (!this.v.id) return;
    try {
      const r = await api<{ targetId: string; ws: string }>(`/browser/${this.v.id}/tab`, { body: to ? { url: to } : {} });
      this.set({ tabs: [...this.v.tabs, { targetId: r.targetId, title: '', url: to ?? '' }] });
      await this.connect(r.targetId, r.ws);
    } catch (e) { this.say((e as Error).message); }
  }
  async switchTab(targetId: string): Promise<void> {
    this.stillHere();
    if (!this.v.id || targetId === this.v.active) return;
    try {
      const p = await api<{ ws: string }>(`/browser/${this.v.id}/pass`, { body: { targetId } });
      await this.connect(targetId, p.ws);
    } catch (e) { this.say((e as Error).message); }
  }
  async closeTab(targetId: string): Promise<void> {
    if (!this.v.id) return;
    const left = this.v.tabs.filter((t) => t.targetId !== targetId);
    if (!left.length) { await this.close(); return; }
    await api(`/browser/${this.v.id}/tab/${targetId}`, { method: 'DELETE' }).catch(() => undefined);
    this.set({ tabs: left });
    if (targetId === this.v.active) await this.switchTab(left[left.length - 1]!.targetId);
  }
}
