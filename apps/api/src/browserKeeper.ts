// BrowserKeeper: one Durable Object per person, keeping their open browser (one at a time).
// It closes the browser when the day's minutes run out, or when the device stops checking in (closed tab, lost
// connection), records the time used, and lets the person's next browser replace an old one. Its alarm is the only
// timer; no cron schedules are used.
// For services other than Cloudflare (the account's own server, a hosted service, a person's own), the keeper also holds
// the connection to the service, with its key, and relays each tab to the person's device: the device connects to
// Niko's server, never to the service, so keys and addresses never leave the server. Each browser gets its own
// browser context (its own cookies), closed with it, so people sharing the account's server never share sign-ins.
import { and, eq, isNull } from 'drizzle-orm';
import { browserSessions, createDb } from '@niko/db';
import type { Env } from './env';
import { countedSeconds, keeperNext, type KeeperEnd, type KeeperStart } from './browser';
import { cfClose, cfConnection } from './browserCf';
import { openSocket, ServiceError } from './browserServices';
import { Upstream } from './browserRelay';

type Kept = KeeperStart & { lastSeen: number };

export class BrowserKeeper {
  private up: Upstream | null = null;
  constructor(private readonly ctx: DurableObjectState, private readonly env: Env) {}

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url), path = url.pathname;
    const s = await this.ctx.storage.get<Kept>('s');
    // A device showing one tab of a relayed browser (the Worker checked the person and the pass first).
    if (path === '/relay') {
      if (req.headers.get('Upgrade') !== 'websocket') return new Response('expected a WebSocket', { status: 426 });
      if (!s || s.sessionId !== url.searchParams.get('session') || !this.up || this.up.closed) {
        if (s && s.service !== 'cloudflare' && (!this.up || this.up.closed)) await this.finish(s, 'failed');
        return new Response('gone', { status: 410 });
      }
      const target = url.searchParams.get('target') ?? '';
      let sid: string;
      try { sid = await this.up.attach(target); } catch { return new Response('no such tab', { status: 404 }); }
      const pair = new WebSocketPair();
      const [client, server] = [pair[0], pair[1]];
      server.accept();
      this.up.connect(target, sid, server);
      return new Response(null, { status: 101, webSocket: client });
    }
    const body = (await req.json().catch(() => ({}))) as Record<string, any>;
    if (path === '/start') {
      if (s) await this.finish(s, 'replaced');
      // A relayed service: connect to it first (with its key, which is kept in memory only), make this browser's own
      // context and its first tab. Nothing is stored if that fails, so Niko can try the next service.
      let targetId: string | undefined;
      if (body.relay) {
        try {
          const ws = await openSocket(String(body.relay.wsUrl));
          const up = new Upstream(ws);
          const ctx = await up.send<{ browserContextId?: string }>('Target.createBrowserContext', { disposeOnDetach: true }).catch(() => ({} as { browserContextId?: string }));
          up.context = ctx.browserContextId ?? '';
          targetId = await up.newTab(String(body.relay.url || 'about:blank'));
          this.up = up;
          up.onClosed = () => { void this.ctx.storage.get<Kept>('s').then((k) => { if (k && this.up === up) return this.finish(k, 'failed'); }); };
        } catch (e) {
          const err = e instanceof ServiceError ? e : new ServiceError('The browser service couldn’t be reached.', 'down');
          return Response.json({ error: err.message, code: err.code }, { status: 502 });
        }
        delete body.relay;
      }
      const next: Kept = { ...(body as KeeperStart), lastSeen: Date.now() };
      await this.ctx.storage.put('s', next);
      await this.schedule(next);
      return Response.json({ ok: true, ...(targetId ? { targetId } : {}) });
    }
    // Tabs of a relayed browser.
    if (path === '/tab' || path === '/close-tab') {
      if (!s || s.sessionId !== body.sessionId || !this.up || this.up.closed) return Response.json({ error: 'gone' }, { status: 410 });
      try {
        if (path === '/tab') return Response.json({ targetId: await this.up.newTab(String(body.url || 'about:blank')) });
        await this.up.send('Target.closeTarget', { targetId: String(body.targetId ?? '') }, 5000).catch(() => undefined);
        return Response.json({ ok: true });
      } catch (e) { return Response.json({ error: (e as Error).message }, { status: 502 }); }
    }
    if (path === '/beat') {
      if (!s || s.sessionId !== body.sessionId) return Response.json({ ended: true, why: (await this.ctx.storage.get<{ id: string; why: KeeperEnd }>('last'))?.why ?? 'closed' });
      // A relayed browser whose connection to the service was lost (the keeper restarted, or the service went away).
      if (s.service !== 'cloudflare' && (!this.up || this.up.closed)) { await this.finish(s, 'failed'); return Response.json({ ended: true, why: 'failed' }); }
      s.lastSeen = Date.now();
      // A raised or lowered allowance (the admin changed it, or the day refilled) moves the end.
      if (body.capAt === null || typeof body.capAt === 'number') s.capAt = body.capAt;
      await this.ctx.storage.put('s', s);
      const n = keeperNext(s, Date.now());
      if ('end' in n) { await this.finish(s, n.end); return Response.json({ ended: true, why: n.end }); }
      await this.ctx.storage.setAlarm(n.at);
      return Response.json({ ok: true, capAt: s.capAt });
    }
    if (path === '/end') {
      if (s && (!body.sessionId || s.sessionId === body.sessionId)) await this.finish(s, (body.why as KeeperEnd) || 'closed');
      return Response.json({ ok: true });
    }
    // An OK token is good once: the first time it is seen it is remembered (until it would have expired anyway).
    if (path === '/once') {
      const key = `ok:${String(body.nonce ?? '').slice(0, 64)}`;
      if (!body.nonce || (await this.ctx.storage.get(key))) return Response.json({ used: true });
      await this.ctx.storage.put(key, Number(body.exp) || Date.now() + 120_000);
      return Response.json({ used: false });
    }
    if (path === '/state') return Response.json(s ? { open: true, sessionId: s.sessionId, capAt: s.capAt } : { open: false });
    return new Response('not found', { status: 404 });
  }

  async alarm(): Promise<void> {
    const s = await this.ctx.storage.get<Kept>('s');
    if (!s) return;
    const n = keeperNext(s, Date.now());
    if ('end' in n) await this.finish(s, n.end);
    else await this.ctx.storage.setAlarm(n.at);
  }

  private async schedule(s: Kept) {
    const n = keeperNext(s, Date.now());
    if ('end' in n) await this.finish(s, n.end);
    else await this.ctx.storage.setAlarm(n.at);
  }

  /** Closes the browser on its service and records the time it counted today. */
  private async finish(s: Kept, why: KeeperEnd) {
    await this.ctx.storage.delete('s');
    // OK tokens belong to one browser: forget them with it.
    const oks = await this.ctx.storage.list({ prefix: 'ok:' });
    if (oks.size) await this.ctx.storage.delete([...oks.keys()]);
    await this.ctx.storage.put('last', { id: s.sessionId, why });
    await this.ctx.storage.deleteAlarm();
    const db = createDb(this.env.DATABASE_URL);
    try {
      if (s.service === 'cloudflare') {
        const conn = await cfConnection(this.env, db);
        if (conn) await cfClose(conn, s.remoteId);
      } else if (this.up) {
        const up = this.up; this.up = null;
        await up.shutdown();
      }
    } catch (e) { console.warn(`browser close failed: ${String((e as Error)?.message ?? e).slice(0, 160)}`); }
    const now = Date.now();
    await db.update(browserSessions).set({ endedAt: new Date(now), lastSeenAt: new Date(s.lastSeen), seconds: countedSeconds(s.startedAt, now, s.refillAt), endedWhy: why })
      .where(and(eq(browserSessions.id, s.sessionId), isNull(browserSessions.endedAt))).catch((e) => console.error('browser session not recorded', e));
  }
}
