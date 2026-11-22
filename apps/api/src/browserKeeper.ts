// BrowserKeeper: one Durable Object per person, keeping their open browser (one at a time).
// It closes the browser when the day's minutes run out, or when the device stops checking in (closed tab, lost
// connection), records the time used, and lets the person's next browser replace an old one. Its alarm is the only
// timer; no cron schedules are used.
import { and, eq, isNull } from 'drizzle-orm';
import { browserSessions, createDb } from '@niko/db';
import type { Env } from './env';
import { countedSeconds, keeperNext, type KeeperEnd, type KeeperStart } from './browser';
import { cfClose, cfConnection } from './browserCf';

type Kept = KeeperStart & { lastSeen: number };

export class BrowserKeeper {
  constructor(private readonly ctx: DurableObjectState, private readonly env: Env) {}

  async fetch(req: Request): Promise<Response> {
    const path = new URL(req.url).pathname;
    const body = (await req.json().catch(() => ({}))) as Record<string, any>;
    const s = await this.ctx.storage.get<Kept>('s');
    if (path === '/start') {
      if (s) await this.finish(s, 'replaced');
      const next: Kept = { ...(body as KeeperStart), lastSeen: Date.now() };
      await this.ctx.storage.put('s', next);
      await this.schedule(next);
      return Response.json({ ok: true });
    }
    if (path === '/beat') {
      if (!s || s.sessionId !== body.sessionId) return Response.json({ ended: true, why: (await this.ctx.storage.get<{ id: string; why: KeeperEnd }>('last'))?.why ?? 'closed' });
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
      }
    } catch (e) { console.warn(`browser close failed: ${String((e as Error)?.message ?? e).slice(0, 160)}`); }
    const now = Date.now();
    await db.update(browserSessions).set({ endedAt: new Date(now), lastSeenAt: new Date(s.lastSeen), seconds: countedSeconds(s.startedAt, now, s.refillAt), endedWhy: why })
      .where(and(eq(browserSessions.id, s.sessionId), isNull(browserSessions.endedAt))).catch((e) => console.error('browser session not recorded', e));
  }
}
