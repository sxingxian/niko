// Provider adapters. Every call here goes to a third-party API with the user's own credentials.
// None of this has been exercised against live accounts yet: treat each adapter as untested until you link one.
import { gmailBatch } from './gmail';
import { and, eq } from 'drizzle-orm';
import { connections, providerApps, users, type Db } from '@niko/db';
import { PROVIDERS, type AppId, type EventItem, type MailItem, type NoteItem } from '@niko/shared';
import { notionDeleted, notionTitle } from './details';
import { icalList, pool } from './calendarlink';
import { accountLimitsFor } from './limits';
import { imapList, imapReply, isImapProvider } from './mailbox';
import type { Env } from './env';
import { seal, unseal } from './lib/crypto';

export interface OAuthSecret { accessToken: string; refreshToken?: string; expiresAt?: number; extra?: Record<string, unknown> }
export type Secret = OAuthSecret & Record<string, any>;

interface OAuthCfg { authUrl: string; tokenUrl: string; scopes: string; clientId?: string; clientSecret?: string; extraAuth?: Record<string, string>; basicAuth?: boolean; scopeParam?: string }

const GOOGLE = { authUrl: 'https://accounts.google.com/o/oauth2/v2/auth', tokenUrl: 'https://oauth2.googleapis.com/token', extraAuth: { access_type: 'offline', prompt: 'consent select_account' } };

/** One account's own keys for a provider app. Never sent back to the browser. */
export interface AppKeys { clientId: string; clientSecret: string; tenant?: string; signingSecret?: string }

export const appFor = (provider: string): AppId | null => PROVIDERS.find((p) => p.id === provider && p.kind === 'oauth')?.app ?? null;

export async function loadAppKeys(env: Env, db: Db, userId: string, app: AppId): Promise<AppKeys | null> {
  const row = (await db.select().from(providerApps).where(and(eq(providerApps.userId, userId), eq(providerApps.app, app))).limit(1))[0];
  return row ? await unseal<AppKeys>(env.ENCRYPTION_KEY, row.secretEnc) : null;
}

/** Sign-in settings for a connection, using the account's own app keys. The addresses are fixed here, never user-supplied. */
export function oauthConfig(provider: string, keys: AppKeys): OAuthCfg | null {
  const g = { clientId: keys.clientId, clientSecret: keys.clientSecret };
  const m = g;
  const tenant = /^(common|organizations|consumers|[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12})$/i.test(keys.tenant ?? '') ? keys.tenant! : 'common';
  // "common" accepts personal (Outlook.com, Hotmail) and work accounts; prompt=select_account lets the person pick
  // instead of being signed in silently with whatever work account the browser already has.
  const MS = { authUrl: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`, tokenUrl: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, extraAuth: { prompt: 'select_account' } };
  switch (provider) {
    case 'gmail': return { ...GOOGLE, ...g, scopes: 'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send' };
    case 'google-calendar': return { ...GOOGLE, ...g, scopes: 'https://www.googleapis.com/auth/calendar.readonly' };
    case 'outlook-mail': return { ...MS, ...m, scopes: 'offline_access Mail.Read Mail.Send' };
    case 'outlook-calendar': return { ...MS, ...m, scopes: 'offline_access Calendars.Read' };
    case 'onenote': return { ...MS, ...m, scopes: 'offline_access Notes.Read' };
    case 'notion': return { authUrl: 'https://api.notion.com/v1/oauth/authorize', tokenUrl: 'https://api.notion.com/v1/oauth/token', scopes: '', ...g, extraAuth: { owner: 'user' }, basicAuth: true };
    case 'slack': return { authUrl: 'https://slack.com/oauth/v2/authorize', tokenUrl: 'https://slack.com/api/oauth.v2.access', scopes: 'chat:write,channels:history,im:history,channels:read', ...g };
    default: return null;
  }
}

export function authorizeUrl(cfg: OAuthCfg, redirectUri: string, state: string): string {
  const u = new URL(cfg.authUrl);
  u.searchParams.set('client_id', cfg.clientId!);
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('state', state);
  if (cfg.scopes) u.searchParams.set('scope', cfg.scopes);
  for (const [k, v] of Object.entries(cfg.extraAuth ?? {})) u.searchParams.set(k, v);
  return u.toString();
}

async function tokenRequest(cfg: OAuthCfg, params: Record<string, string>): Promise<any> {
  const headers: Record<string, string> = { accept: 'application/json' };
  let body: string;
  if (cfg.basicAuth) {
    headers.authorization = 'Basic ' + btoa(`${cfg.clientId}:${cfg.clientSecret}`);
    headers['content-type'] = 'application/json';
    body = JSON.stringify(params);
  } else {
    headers['content-type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams({ ...params, client_id: cfg.clientId!, client_secret: cfg.clientSecret! }).toString();
  }
  const res = await fetch(cfg.tokenUrl, { method: 'POST', headers, body });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok || json.error || json.ok === false) throw new Error('Token exchange failed: ' + (json.error_description ?? json.error ?? res.status));
  return json;
}

export async function exchangeCode(cfg: OAuthCfg, code: string, redirectUri: string): Promise<{ secret: OAuthSecret; meta: Record<string, unknown> }> {
  const j = await tokenRequest(cfg, { grant_type: 'authorization_code', code, redirect_uri: redirectUri });
  return {
    secret: { accessToken: j.access_token, refreshToken: j.refresh_token, expiresAt: j.expires_in ? Date.now() + j.expires_in * 1000 : undefined },
    meta: { teamId: j.team?.id, teamName: j.team?.name, workspace: j.workspace_name },
  };
}

export async function getConnection(db: Db, userId: string, provider: string) {
  return (await db.select().from(connections).where(and(eq(connections.userId, userId), eq(connections.provider, provider))).limit(1))[0];
}

/** Decrypts a connection's credentials, refreshing the OAuth access token when it is about to expire. */
export async function credentials(env: Env, db: Db, userId: string, provider: string): Promise<Secret | null> {
  const conn = await getConnection(db, userId, provider);
  if (!conn) return null;
  const secret = await unseal<Secret>(env.ENCRYPTION_KEY, conn.secretEnc);
  if (!secret) return null;
  const app = appFor(provider);
  const keys = app && secret.refreshToken && secret.expiresAt && secret.expiresAt < Date.now() + 60_000 ? await loadAppKeys(env, db, userId, app) : null;
  const cfg = keys ? oauthConfig(provider, keys) : null;
  if (cfg && secret.refreshToken && secret.expiresAt && secret.expiresAt < Date.now() + 60_000) {
    const j = await tokenRequest(cfg, { grant_type: 'refresh_token', refresh_token: secret.refreshToken });
    secret.accessToken = j.access_token;
    if (j.refresh_token) secret.refreshToken = j.refresh_token;
    secret.expiresAt = j.expires_in ? Date.now() + j.expires_in * 1000 : undefined;
    await db.update(connections).set({ secretEnc: await seal(env.ENCRYPTION_KEY, secret), updatedAt: new Date() }).where(eq(connections.id, conn.id));
  }
  return secret;
}

/** Refuses URLs that are not plain https to a public host. Used for every user-supplied address. */
export function publicHttpsUrl(raw: unknown): URL | null {
  if (typeof raw !== 'string') return null;
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== 'https:' || u.username || u.password) return null;
  const h = u.hostname.toLowerCase();
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal') || h.startsWith('[')) return null;
  if (/^(10\.|127\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h)) return null;
  return u;
}

export async function api(url: string, token: string, init: RequestInit = {}, scheme = 'Bearer'): Promise<any> {
  const res = await fetch(url, { ...init, headers: { authorization: `${scheme} ${token}`, accept: 'application/json', ...(init.headers as Record<string, string> | undefined) } });
  if (!res.ok) throw new Error(`${new URL(url).hostname} answered ${res.status}`);
  return res.status === 204 ? null : res.json();
}


/** The most items any list (mail, events, notes) brings back. The screen shows them a page at a time. */
export const LIST_MAX = 50;

export async function listMail(env: Env, db: Db, userId: string, provider: string): Promise<MailItem[]> {
  const s = await credentials(env, db, userId, provider);
  if (!s) return [];
  if (isImapProvider(provider)) return imapList(provider, s);
  if (provider === 'gmail') {
    const base = 'https://gmail.googleapis.com/gmail/v1/users/me/messages';
    const list = await api(`${base}?q=${encodeURIComponent('is:unread in:inbox')}&maxResults=${LIST_MAX}`, s.accessToken);
    const ids: string[] = (list.messages ?? []).map((m: any) => String(m.id)).filter((id: string) => /^[A-Za-z0-9]{1,64}$/.test(id));
    // The senders and subjects of all of them in one batch request, instead of one request each.
    const details = await gmailBatch(s.accessToken!, ids.map((id) => `/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`));
    return ids.map((id, i) => {
      const d = details[i];
      const h = (n: string) => d?.payload?.headers?.find((x: any) => x.name === n)?.value ?? '';
      return { id, from: h('From').replace(/<.*>/, '').replace(/"/g, '').trim() || h('From') || '(unknown sender)', subject: h('Subject'), source: 'Gmail', provider };
    });
  }
  if (provider === 'outlook-mail') {
    const j = await api(`https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?$filter=isRead eq false&$top=${LIST_MAX}&$select=id,subject,from`, s.accessToken);
    return (j.value ?? []).map((m: any) => ({ id: m.id, from: m.from?.emailAddress?.name ?? m.from?.emailAddress?.address ?? '', subject: m.subject ?? '', source: 'Outlook', provider }));
  }
  return [];
}

// ---- Which Google calendars are read
// Chosen after Google sign-in, from the account's own calendar list; kept in the connection's encrypted secret (the IDs
// of shared calendars are often other people's email addresses). Nothing chosen yet: the main calendar only, as before.
// The main calendar is always stored as 'primary', so its event ids stay the same.
export interface GoogleCal { id: string; name: string; on: boolean }
export function googleCals(s: Record<string, any> | null | undefined): GoogleCal[] {
  let raw: unknown = null;
  try { raw = typeof s?.cals === 'string' ? JSON.parse(s.cals) : null; } catch { raw = null; }
  if (!Array.isArray(raw)) return [{ id: 'primary', name: 'Google', on: true }];
  return raw.flatMap((c: any) => (c && typeof c.id === 'string' && c.id.length <= 300 && !/[\s|]/.test(c.id) ? [{ id: c.id, name: String(c.name ?? '').slice(0, 60) || 'Google', on: c.on !== false }] : [])).slice(0, 50);
}
/** An event id carries its calendar, except for the main calendar (so older ids keep working). */
export const googleEventId = (cal: string, id: string) => (cal === 'primary' ? id : `${cal}|${id}`);
export function splitGoogleEventId(id: string): { cal: string; id: string } {
  const i = id.lastIndexOf('|');
  return i < 0 ? { cal: 'primary', id } : { cal: id.slice(0, i), id: id.slice(i + 1) };
}

export async function listEvents(env: Env, db: Db, userId: string, provider: string, dayStart: Date, dayEnd: Date, tzOffsetMin = 0): Promise<EventItem[]> {
  const s = await credentials(env, db, userId, provider);
  if (!s) return [];
  if (provider === 'ical') {
    const row = (await db.select({ accountLimits: users.accountLimits }).from(users).where(eq(users.id, userId)).limit(1))[0];
    return icalList(s, dayStart, dayEnd, tzOffsetMin, (await accountLimitsFor(db, row ?? {})).calendars);
  }
  if (provider === 'google-calendar') {
    const row = (await db.select({ accountLimits: users.accountLimits }).from(users).where(eq(users.id, userId)).limit(1))[0];
    const cals = googleCals(s).filter((c) => c.on).slice(0, (await accountLimitsFor(db, row ?? {})).calendars);
    // One calendar failing (unshared since, a hiccup) must not hide the others.
    const lists = await pool(cals, 6, async (cal) => {
      const u = new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(cal.id)}/events`);
      u.searchParams.set('timeMin', dayStart.toISOString()); u.searchParams.set('timeMax', dayEnd.toISOString());
      u.searchParams.set('singleEvents', 'true'); u.searchParams.set('orderBy', 'startTime'); u.searchParams.set('maxResults', String(LIST_MAX));
      const j = await api(u.toString(), s.accessToken);
      return (j.items ?? []).filter((e: any) => e.status !== 'cancelled').map((e: any) => ({ id: googleEventId(cal.id, String(e.id)), provider, title: e.summary ?? (cal.id === 'primary' ? '(no title)' : 'Busy'), source: cal.name, start: Date.parse(e.start?.dateTime ?? e.start?.date), end: Date.parse(e.end?.dateTime ?? e.end?.date) || undefined, time: '', allDay: !e.start?.dateTime } as EventItem));
    });
    const failed = lists.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (cals.length && failed.length === cals.length) throw failed[0]!.reason;
    return lists.flatMap((r) => (r.status === 'fulfilled' ? r.value : [])).sort((a, b) => a.start - b.start).slice(0, 100);
  }
  if (provider === 'outlook-calendar') {
    const u = `https://graph.microsoft.com/v1.0/me/calendarView?startDateTime=${dayStart.toISOString()}&endDateTime=${dayEnd.toISOString()}&$top=${LIST_MAX}&$select=id,subject,start,end,isCancelled&$orderby=start/dateTime`;
    const j = await api(u, s.accessToken, { headers: { prefer: 'outlook.timezone="UTC"' } });
    return (j.value ?? []).filter((e: any) => !e.isCancelled).map((e: any) => ({ id: String(e.id), provider, title: e.subject ?? '(no title)', source: 'Outlook', start: Date.parse(e.start?.dateTime + 'Z'), end: Date.parse(e.end?.dateTime + 'Z') || undefined, time: '' }));
  }
  return [];
}

/** The Notion user who connected Niko, so that page changes they made themselves can be told apart. Kept per instance. */
const notionOwners = new Map<string, string>();
async function notionOwner(userId: string, token: string): Promise<string> {
  if (notionOwners.has(userId)) return notionOwners.get(userId)!;
  const me = await api('https://api.notion.com/v1/users/me', token, { headers: { 'notion-version': '2022-06-28' } }).catch(() => null);
  const id = String(me?.bot?.owner?.user?.id ?? '');
  if (notionOwners.size > 500) notionOwners.delete(notionOwners.keys().next().value!);
  notionOwners.set(userId, id);
  return id;
}

export async function listNotes(env: Env, db: Db, userId: string, provider: string): Promise<NoteItem[]> {
  const s = await credentials(env, db, userId, provider);
  if (!s) return [];
  if (provider === 'notion') {
    // Search can return pages that are in the trash; those are left out. More are asked for, so there are still enough.
    const j = await api('https://api.notion.com/v1/search', s.accessToken, {
      method: 'POST', headers: { 'content-type': 'application/json', 'notion-version': '2022-06-28' },
      body: JSON.stringify({ page_size: 70, sort: { direction: 'descending', timestamp: 'last_edited_time' }, filter: { property: 'object', value: 'page' } }),
    });
    const owner = await notionOwner(userId, s.accessToken);
    return (j.results ?? []).filter((p: any) => !notionDeleted(p)).slice(0, LIST_MAX)
      .map((p: any) => ({ id: String(p.id), provider, title: notionTitle(p), source: 'Notion', edited: Date.parse(p.last_edited_time) || undefined, ...(owner && p.last_edited_by?.id === owner ? { byMe: true } : {}) }));
  }
  if (provider === 'onenote') {
    const j = await api('https://graph.microsoft.com/v1.0/me/onenote/pages?$top=${LIST_MAX}&$select=id,title,lastModifiedDateTime&$orderby=lastModifiedDateTime desc', s.accessToken);
    return (j.value ?? []).map((p: any) => ({ id: String(p.id), provider, title: p.title || 'Untitled', source: 'OneNote', edited: Date.parse(p.lastModifiedDateTime) || undefined }));
  }
  return [];
}

const utf8b64url = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** Sends a reply or message. `chatId` is the mail message id, chat id or channel id, depending on the provider. */
export async function sendText(env: Env, db: Db, userId: string, provider: string, chatId: string, body: string): Promise<void> {
  const s = await credentials(env, db, userId, provider);
  if (!s) throw new Error('That connection is not linked.');
  if (isImapProvider(provider)) return imapReply(provider, s, chatId, body);
  switch (provider) {
    case 'telegram-bot': {
      const j = await (await fetch(`https://api.telegram.org/bot${s.token}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: chatId, text: body }) })).json<any>();
      if (!j.ok) throw new Error('Telegram refused the message.');
      return;
    }
    case 'slack': {
      const j = await api('https://slack.com/api/chat.postMessage', s.accessToken, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ channel: chatId, text: body }) });
      if (!j.ok) throw new Error('Slack refused the message: ' + j.error);
      return;
    }
    case 'discord':
      await api(`https://discord.com/api/v10/channels/${encodeURIComponent(chatId || s.channelId)}/messages`, s.token, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: body.slice(0, 2000) }) }, 'Bot');
      return;
    case 'outlook-mail':
      await api(`https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(chatId)}/reply`, s.accessToken, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ comment: body }) });
      return;
    case 'gmail': {
      const base = 'https://gmail.googleapis.com/gmail/v1/users/me/messages';
      const d = await api(`${base}/${encodeURIComponent(chatId)}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Message-ID&metadataHeaders=Reply-To`, s.accessToken);
      const h = (n: string) => d.payload?.headers?.find((x: any) => x.name.toLowerCase() === n.toLowerCase())?.value ?? '';
      const clean = (v: string) => v.replace(/[\r\n]+/g, ' ');
      const subject = /^re:/i.test(h('Subject')) ? h('Subject') : 'Re: ' + h('Subject');
      const raw = [`To: ${clean(h('Reply-To') || h('From'))}`, `Subject: ${clean(subject)}`, `In-Reply-To: ${clean(h('Message-ID'))}`, `References: ${clean(h('Message-ID'))}`, 'Content-Type: text/plain; charset=utf-8', '', body].join('\r\n');
      await api(`${base}/send`, s.accessToken, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ raw: utf8b64url(raw), threadId: d.threadId }) });
      return;
    }
    default:
      throw new Error('Sending is not available for this connection yet.');
  }
}

/** Relays one file straight to the chat app. The bytes live only in this request's memory. */
export async function relayFile(env: Env, db: Db, userId: string, provider: string, chatId: string, file: File, caption: string): Promise<void> {
  const s = await credentials(env, db, userId, provider);
  if (!s) throw new Error('That connection is not linked.');
  const form = new FormData();
  if (provider === 'telegram-bot') {
    form.set('chat_id', chatId);
    if (caption) form.set('caption', caption.slice(0, 1024));
    form.set('document', file, file.name);
    const j = await (await fetch(`https://api.telegram.org/bot${s.token}/sendDocument`, { method: 'POST', body: form })).json<any>();
    if (!j.ok) throw new Error('Telegram refused the file.');
    return;
  }
  if (provider === 'discord') {
    form.set('payload_json', JSON.stringify({ content: caption.slice(0, 2000) }));
    form.set('files[0]', file, file.name);
    const res = await fetch(`https://discord.com/api/v10/channels/${encodeURIComponent(chatId || s.channelId)}/messages`, { method: 'POST', headers: { authorization: `Bot ${s.token}` }, body: form });
    if (!res.ok) throw new Error('Discord refused the file.');
    return;
  }
  throw new Error('Sending files is not available for this connection yet.');
}

/** Points the bot at Niko. `readsGroups` is false while the bot's group privacy is on: then, in groups,
 * Telegram only delivers messages that mention the bot, commands and replies to it. */
export async function telegramSetWebhook(token: string, url: string, secret: string): Promise<{ ok: boolean; username?: string; readsGroups?: boolean }> {
  const me = await (await fetch(`https://api.telegram.org/bot${token}/getMe`)).json<any>();
  if (!me.ok) return { ok: false };
  const r = await (await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    // my_chat_member tells Niko when the bot is added to a group, so the group shows up before anyone writes.
    body: JSON.stringify({ url, secret_token: secret, allowed_updates: ['message', 'edited_message', 'channel_post', 'my_chat_member'] }),
  })).json<any>();
  return { ok: !!r.ok, username: me.result?.username, readsGroups: !!me.result?.can_read_all_group_messages };
}
