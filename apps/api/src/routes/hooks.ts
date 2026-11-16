// Inbound webhooks from chat apps and automation tools. No session: each is authenticated by its own secret or signature.
import { and, eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { auditLog, connections, messages } from '@niko/db';
import { loadAppKeys } from '../providers';
import type { AppEnv } from '../env';
import { hmacSha256Hex, safeEqual, unseal } from '../lib/crypto';
import { handleStripeEvent } from '../billing';
import { verifyStripeSignature } from '../stripe';

export const hooks = new Hono<AppEnv>();

hooks.post('/telegram/:connId', async (c) => {
  const db = c.get('db');
  const conn = (await db.select().from(connections).where(eq(connections.id, c.req.param('connId'))).limit(1))[0];
  const secret = conn ? await unseal<Record<string, string>>(c.env.ENCRYPTION_KEY, conn.secretEnc) : null;
  const given = c.req.header('x-telegram-bot-api-secret-token') ?? '';
  if (!conn || conn.provider !== 'telegram-bot' || !secret?.hookSecret || !safeEqual(given, secret.hookSecret)) return c.json({ ok: false }, 403);
  const update = await c.req.json<any>().catch(() => null);
  // The bot was added to (or removed from) a group or channel: record it so the chat appears in the inbox straight away.
  const member = update?.my_chat_member;
  if (member?.chat?.id && member.chat.type !== 'private') {
    const status = String(member.new_chat_member?.status ?? '');
    const joined = ['member', 'administrator', 'creator'].includes(status);
    const left = ['left', 'kicked'].includes(status);
    if (joined || left) {
      await db.insert(messages).values({
        userId: conn.userId, provider: 'telegram-bot', chatId: String(member.chat.id), chatTitle: String(member.chat.title ?? 'Group').slice(0, 200), sender: 'Telegram',
        body: joined ? 'Your bot was added to this group.' : 'Your bot was removed from this group.', direction: 'in',
      });
    }
    return c.json({ ok: true });
  }
  const m = update?.message ?? update?.edited_message ?? update?.channel_post;
  if (m?.chat?.id) {
    const file = m.document ?? (Array.isArray(m.photo) ? m.photo[m.photo.length - 1] : null);
    const who = [m.from?.first_name, m.from?.last_name].filter(Boolean).join(' ') || m.from?.username || m.author_signature || m.chat?.title || 'Someone';
    await db.insert(messages).values({
      userId: conn.userId, provider: 'telegram-bot', chatId: String(m.chat.id), chatTitle: m.chat.title ?? who, sender: who,
      body: String(m.text ?? m.caption ?? '').slice(0, 4000), direction: 'in',
      // Only the file's name and Telegram's own file id are kept, so it can be fetched on demand. The bytes are never stored.
      fileName: file ? String(m.document?.file_name ?? 'photo.jpg').slice(0, 200) : null, externalId: file?.file_id ?? null,
    });
    if (file) await db.insert(auditLog).values({ userId: conn.userId, action: 'file.received', detail: { provider: 'telegram-bot', name: m.document?.file_name ?? 'photo.jpg', size: file.file_size ?? null, from: who } });
  }
  return c.json({ ok: true });
});

// Each account has its own Slack app, so each has its own address and its own signing secret.
hooks.post('/slack/:userId', async (c) => {
  const userId = c.req.param('userId');
  if (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(userId)) return c.json({ ok: false }, 403);
  const raw = await c.req.text();
  const ts = c.req.header('x-slack-request-timestamp') ?? '';
  const sig = c.req.header('x-slack-signature') ?? '';
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return c.json({ ok: false }, 403);
  const signingSecret = (await loadAppKeys(c.env, c.get('db'), userId, 'slack'))?.signingSecret;
  if (!signingSecret) return c.json({ ok: false }, 403);
  const expect = 'v0=' + (await hmacSha256Hex(signingSecret, `v0:${ts}:${raw}`));
  if (!safeEqual(expect, sig)) return c.json({ ok: false }, 403);
  const body = JSON.parse(raw);
  if (body.type === 'url_verification') return c.json({ challenge: body.challenge });
  const ev = body.event;
  if (ev?.type === 'message' && !ev.bot_id && !ev.subtype && body.team_id) {
    const db = c.get('db');
    const conn = (await db.select().from(connections).where(and(eq(connections.userId, userId), sql`${connections.provider} = 'slack' and ${connections.meta}->>'teamId' = ${String(body.team_id)}`)).limit(1))[0];
    if (conn) {
      await db.insert(messages).values({ userId: conn.userId, provider: 'slack', chatId: String(ev.channel), chatTitle: 'Slack ' + ev.channel, sender: String(ev.user ?? 'Someone'), body: String(ev.text ?? '').slice(0, 4000), direction: 'in' });
    }
  }
  return c.json({ ok: true });
});

// Make.com, n8n and Power Automate can push an event to Niko. Body: {"title":"...","text":"..."} signed with the connection's secret.
hooks.post('/in/:connId', async (c) => {
  const db = c.get('db');
  const raw = await c.req.text();
  if (raw.length > 20_000) return c.json({ ok: false }, 413);
  const conn = (await db.select().from(connections).where(eq(connections.id, c.req.param('connId'))).limit(1))[0];
  const secret = conn ? await unseal<Record<string, string>>(c.env.ENCRYPTION_KEY, conn.secretEnc) : null;
  const given = c.req.header('x-niko-signature') ?? '';
  if (!conn || !secret?.signingSecret || !safeEqual(given, await hmacSha256Hex(secret.signingSecret, raw))) return c.json({ ok: false }, 403);
  let body: any = {};
  try { body = JSON.parse(raw); } catch { /* plain text is fine */ }
  await db.insert(messages).values({ userId: conn.userId, provider: conn.provider, chatId: 'automation', chatTitle: String(body.title ?? conn.provider).slice(0, 120), sender: conn.provider, body: String(body.text ?? raw).slice(0, 4000), direction: 'in' });
  return c.json({ ok: true });
});

// Stripe: payments, plans and renewals. Trusted only with a valid signature from this endpoint's signing secret.
hooks.post('/stripe', async (c) => {
  const raw = await c.req.text();
  if (raw.length > 512_000) return c.json({ ok: false }, 413);
  if (!c.env.STRIPE_WEBHOOK_SECRET || !(await verifyStripeSignature(c.env.STRIPE_WEBHOOK_SECRET, c.req.header('stripe-signature'), raw))) return c.json({ ok: false }, 400);
  let event: any;
  try { event = JSON.parse(raw); } catch { return c.json({ ok: false }, 400); }
  // A failure answers 500, so Stripe sends the event again later.
  await handleStripeEvent(c.env, c.get('db'), event);
  return c.json({ ok: true });
});
