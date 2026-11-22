// The relay between a person's device and a browser service other than Cloudflare (used by the BrowserKeeper).
// One DevTools connection to the service carries every tab ("flattened" sessions). Each device socket shows one tab:
// what it sends goes to that tab only, and commands for the whole browser (other tabs, other people's browser
// contexts, closing the browser) are refused. Each browser gets its own browser context, so its cookies and sign-ins
// are its own, and the context is thrown away when the browser closes.
import { ServiceError } from './browserServices';

/** What the relay needs of a WebSocket (the Workers one, or the one in tests). */
type Sock = { send(data: string): void; close(code?: number, reason?: string): void; addEventListener(type: string, fn: (e: any) => void): void };

/** The keeper's connection to a browser service: one browser context, its tabs, and the devices watching them. */
export class Upstream {
  private n = 0;
  private waiting = new Map<number, { ok: (v: any) => void; no: (e: Error) => void; t: ReturnType<typeof setTimeout> }>();
  /** Each tab's DevTools session on the service, and the device sockets showing it. */
  readonly sessions = new Map<string, string>();
  readonly clients = new Map<string, Set<Sock>>();
  context = '';
  closed = false;
  onClosed: (() => void) | null = null;
  constructor(readonly ws: Sock) {
    ws.addEventListener('message', (e) => this.onMessage(String(e.data)));
    ws.addEventListener('close', () => this.gone());
    ws.addEventListener('error', () => this.gone());
  }
  send<T = any>(method: string, params: Record<string, unknown> = {}, ms = 15_000): Promise<T> {
    const id = ++this.n;
    return new Promise<T>((ok, no) => {
      if (this.closed) { no(new ServiceError('The browser service closed the connection.', 'down')); return; }
      const t = setTimeout(() => { this.waiting.delete(id); no(new ServiceError('The browser service didn’t answer.', 'down')); }, ms);
      this.waiting.set(id, { ok, no, t });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  private onMessage(raw: string) {
    let m: any;
    try { m = JSON.parse(raw); } catch { return; }
    if (m.sessionId) {
      // A tab's message: pass it to the devices showing that tab, as if they were connected to the tab itself.
      const target = [...this.sessions].find(([, sid]) => sid === m.sessionId)?.[0];
      const out = target ? this.clients.get(target) : undefined;
      if (out?.size) { delete m.sessionId; const text = JSON.stringify(m); for (const c of out) { try { c.send(text); } catch { /* gone */ } } }
      return;
    }
    if (typeof m.id === 'number' && this.waiting.has(m.id)) {
      const w = this.waiting.get(m.id)!; this.waiting.delete(m.id); clearTimeout(w.t);
      if (m.error) w.no(new ServiceError(String(m.error.message ?? 'The browser service answered with an error.').slice(0, 200), 'other')); else w.ok(m.result ?? {});
      return;
    }
    if (m.method === 'Target.detachedFromTarget' || m.method === 'Target.targetDestroyed') {
      const target = m.params?.targetId ?? [...this.sessions].find(([, sid]) => sid === m.params?.sessionId)?.[0];
      if (target) { this.sessions.delete(target); for (const c of this.clients.get(target) ?? []) { try { c.close(1000, 'tab closed'); } catch { /* gone */ } } this.clients.delete(target); }
    }
  }
  /** A DevTools session on a tab (flattened, so one connection carries every tab). */
  async attach(targetId: string): Promise<string> {
    const had = this.sessions.get(targetId);
    if (had) return had;
    const r = await this.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true });
    this.sessions.set(targetId, r.sessionId);
    return r.sessionId;
  }
  async newTab(url: string): Promise<string> {
    const r = await this.send<{ targetId: string }>('Target.createTarget', { url, ...(this.context ? { browserContextId: this.context } : {}) });
    return r.targetId;
  }
  /** A device showing a tab: what it sends goes to that tab only. */
  connect(targetId: string, sessionId: string, client: Sock) {
    const set = this.clients.get(targetId) ?? new Set<Sock>();
    set.add(client); this.clients.set(targetId, set);
    client.addEventListener('message', (e) => {
      let m: any;
      try { m = JSON.parse(String(e.data)); } catch { return; }
      if (typeof m?.id !== 'number' || typeof m?.method !== 'string' || m.method.length > 80) return;
      // Commands for the whole browser (other tabs, other browser contexts, closing it) aren't passed on.
      if (/^(Target|Browser|SystemInfo|Tethering)\./.test(m.method)) { try { client.send(JSON.stringify({ id: m.id, error: { code: -32601, message: 'Not allowed' } })); } catch { /* gone */ } return; }
      if (this.closed) return;
      this.ws.send(JSON.stringify({ id: m.id, method: m.method, params: m.params ?? {}, sessionId }));
    });
    const drop = () => { set.delete(client); };
    client.addEventListener('close', drop);
    client.addEventListener('error', drop);
  }
  private gone() {
    if (this.closed) return;
    this.closed = true;
    for (const w of this.waiting.values()) { clearTimeout(w.t); w.no(new ServiceError('The browser service closed the connection.', 'down')); }
    this.waiting.clear();
    for (const set of this.clients.values()) for (const c of set) { try { c.close(1011, 'service gone'); } catch { /* gone */ } }
    this.onClosed?.();
  }
  /** Closes the tabs and the browser context, then the connection. */
  async shutdown() {
    if (this.closed) return;
    try {
      if (this.context) await this.send('Target.disposeBrowserContext', { browserContextId: this.context }, 5000);
      else for (const t of this.sessions.keys()) await this.send('Target.closeTarget', { targetId: t }, 3000).catch(() => undefined);
    } catch { /* closing anyway */ }
    for (const set of this.clients.values()) for (const c of set) { try { c.close(1000, 'closed'); } catch { /* gone */ } }
    this.closed = true;
    try { this.ws.close(1000, 'closed'); } catch { /* gone */ }
  }
}

