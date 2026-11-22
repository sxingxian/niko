// A small Chrome DevTools Protocol client over a WebSocket, used by the app's browser panel and the admin test.
// It talks straight to the browser service with a short-lived pass; nothing goes through Niko's server.
export type CdpEvent = { method: string; params: any; sessionId?: string };

export class CdpError extends Error { constructor(message: string, readonly code?: number) { super(message); } }

export class Cdp {
  private ws: WebSocket;
  private next = 1;
  private waiting = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private listeners = new Set<(e: CdpEvent) => void>();
  private closedWith: string | null = null;
  readonly opened: Promise<void>;
  onClose: ((why: string) => void) | null = null;

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.opened = new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => { reject(new CdpError('The browser didn’t answer in time.')); try { this.ws.close(); } catch { /* already closed */ } }, 15_000);
      this.ws.addEventListener('open', () => { clearTimeout(t); resolve(); }, { once: true });
      this.ws.addEventListener('error', () => { clearTimeout(t); reject(new CdpError('Couldn’t connect to the browser.')); }, { once: true });
    });
    this.opened.catch(() => undefined);
    this.ws.addEventListener('message', (m) => {
      let msg: any;
      try { msg = JSON.parse(typeof m.data === 'string' ? m.data : ''); } catch { return; }
      if (typeof msg?.id === 'number') {
        const w = this.waiting.get(msg.id);
        if (!w) return;
        this.waiting.delete(msg.id); clearTimeout(w.timer);
        if (msg.error) w.reject(new CdpError(String(msg.error.message ?? 'The browser refused that.'), msg.error.code));
        else w.resolve(msg.result ?? {});
      } else if (typeof msg?.method === 'string') {
        const ev: CdpEvent = { method: msg.method, params: msg.params ?? {}, sessionId: msg.sessionId };
        for (const l of this.listeners) { try { l(ev); } catch (e) { console.error('cdp listener', e); } }
      }
    });
    this.ws.addEventListener('close', (e) => {
      this.closedWith = e.reason || 'closed';
      for (const w of this.waiting.values()) { clearTimeout(w.timer); w.reject(new CdpError('The browser closed.')); }
      this.waiting.clear();
      this.onClose?.(this.closedWith);
    });
  }

  get open(): boolean { return this.ws.readyState === WebSocket.OPEN; }

  send<T = any>(method: string, params: Record<string, unknown> = {}, sessionId?: string, timeoutMs = 20_000): Promise<T> {
    if (this.closedWith) return Promise.reject(new CdpError('The browser closed.'));
    const id = this.next++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.waiting.delete(id); reject(new CdpError(`The browser didn’t answer (${method}).`)); }, timeoutMs);
      this.waiting.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
    });
  }

  on(fn: (e: CdpEvent) => void): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  /** Waits for one event (optionally matching), or rejects after `timeoutMs`. */
  once(method: string, match: (p: any) => boolean = () => true, timeoutMs = 15_000): Promise<any> {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { off(); reject(new CdpError(`Waited too long for ${method}.`)); }, timeoutMs);
      const off = this.on((e) => { if (e.method === method && match(e.params)) { clearTimeout(t); off(); resolve(e.params); } });
    });
  }

  close(): void { try { this.ws.close(1000, 'done'); } catch { /* already closed */ } }
}

/** Waits for the page to finish loading (or `ms`, whichever comes first). */
export async function settle(cdp: Cdp, ms = 8000, sessionId?: string): Promise<void> {
  await cdp.send('Page.enable', {}, sessionId).catch(() => undefined);
  const ready = await cdp.send<{ result?: { value?: string } }>('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true }, sessionId).catch(() => null);
  if (ready?.result?.value === 'complete') return;
  await cdp.once('Page.loadEventFired', () => true, ms).catch(() => undefined);
}
