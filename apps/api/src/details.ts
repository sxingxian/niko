// What opens when you tap a note, an email or an event in the workspace. Everything is turned into plain text here,
// so no provider's HTML ever reaches the browser. Long content is cut short rather than streamed.
import type { Db } from '@niko/db';
import type { DocBlock, EventDetail, MailDetail, NoteDetail } from '@niko/shared';
import type { Env } from './env';
import { api, credentials } from './providers';
import { icalDetail } from './calendarlink';
import { imapDetail, isImapProvider } from './mailbox';

const MAX_TEXT = 20_000;
const MAX_BLOCKS = 300;
const cut = (s: string, n = MAX_TEXT) => (s.length > n ? s.slice(0, n) + '…' : s);
/** Links are only passed on when they are plain https to the provider's own site. */
const safeLink = (u: unknown, hosts: RegExp): string | undefined => {
  if (typeof u !== 'string') return undefined;
  try { const x = new URL(u); return x.protocol === 'https:' && hosts.test(x.hostname) ? x.toString() : undefined; } catch { return undefined; }
};

// ---------------------------------------------------------------- HTML to text, without rendering anything
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', bull: '•', middot: '·' };
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') { const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : ''; }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}
const MARK = '\u0001';
/** Turns HTML into blocks: headings, paragraphs, list items and to-dos. Everything else becomes text. */
export function htmlToBlocks(html: string): DocBlock[] {
  let s = html.slice(0, 2_000_000)
    .replace(/<(script|style|head|title|template|noscript)[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');
  s = s
    .replace(/<h([1-6])\b[^>]*>/gi, (_m, n: string) => `\n${MARK}h${Math.min(3, Number(n))}${MARK}`)
    .replace(/<li\b[^>]*>/gi, `\n${MARK}li${MARK}`)
    .replace(/<p\b[^>]*data-tag="to-do:completed"[^>]*>/gi, `\n${MARK}done${MARK}`)
    .replace(/<p\b[^>]*data-tag="to-do"[^>]*>/gi, `\n${MARK}todo${MARK}`)
    .replace(/<blockquote\b[^>]*>/gi, `\n${MARK}quote${MARK}`)
    .replace(/<pre\b[^>]*>/gi, `\n${MARK}code${MARK}`)
    .replace(/<hr\b[^>]*>/gi, `\n${MARK}hr${MARK}\n`)
    .replace(/<img\b[^>]*>/gi, (m) => { const alt = /\balt="([^"]*)"/i.exec(m)?.[1]; return ` [Image${alt ? ': ' + alt : ''}] `; })
    .replace(/<\/(td|th)>/gi, ' · ')
    .replace(/<(br|\/p|p|div|\/div|tr|\/tr|\/h[1-6]|\/li|\/blockquote|\/pre|table|\/table|ul|\/ul|ol|\/ol)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '');
  s = decodeEntities(s);
  const out: DocBlock[] = [];
  for (const raw of s.split('\n')) {
    const m = new RegExp(`^${MARK}(h1|h2|h3|li|todo|done|quote|code|hr)${MARK}`).exec(raw);
    const text = raw.replace(new RegExp(MARK + '[a-z0-9]+' + MARK, 'g'), '').replace(/[ \t ]+/g, ' ').replace(/( · )+$/, '').trim();
    const kind = m?.[1];
    if (kind === 'hr') { out.push({ kind: 'hr', text: '' }); continue; }
    if (!text) continue;
    if (kind === 'done' || kind === 'todo') out.push({ kind: 'todo', text, done: kind === 'done' });
    else out.push({ kind: (kind as DocBlock['kind']) ?? 'p', text: cut(text, 4000) });
    if (out.length >= MAX_BLOCKS) break;
  }
  return out;
}
export const htmlToText = (html: string) => htmlToBlocks(html).map((b) => (b.kind === 'li' ? '• ' + b.text : b.kind === 'hr' ? '———' : b.text)).join('\n');

// ---------------------------------------------------------------- notes
const notionHeaders = { 'notion-version': '2022-06-28' };
const rt = (a: unknown) => (Array.isArray(a) ? a.map((t: any) => t?.plain_text ?? '').join('') : '');
/** The title of a Notion page, from whichever property is its title. */
export const notionTitle = (p: any) => rt((Object.values(p?.properties ?? {}).find((v: any) => v?.type === 'title') as any)?.title) || 'Untitled';
/** Trashed pages: `archived` in this API version, `in_trash` in newer ones. Either one means deleted. */
export const notionDeleted = (p: any) => !!(p?.archived || p?.in_trash);

function notionProp(v: any): string {
  switch (v?.type) {
    case 'rich_text': return rt(v.rich_text);
    case 'select': return v.select?.name ?? '';
    case 'status': return v.status?.name ?? '';
    case 'multi_select': return (v.multi_select ?? []).map((x: any) => x.name).join(', ');
    case 'date': return v.date ? [v.date.start, v.date.end].filter(Boolean).join(' → ') : '';
    case 'number': return v.number == null ? '' : String(v.number);
    case 'checkbox': return v.checkbox ? 'Yes' : 'No';
    case 'url': case 'email': case 'phone_number': return v[v.type] ?? '';
    case 'people': return (v.people ?? []).map((x: any) => x.name).filter(Boolean).join(', ');
    case 'formula': return v.formula ? String(v.formula[v.formula.type] ?? '') : '';
    default: return '';
  }
}
function notionBlock(b: any, depth: number): DocBlock | null {
  const v = b?.[b?.type] ?? {};
  const text = rt(v.rich_text);
  switch (b?.type) {
    case 'paragraph': return text ? { kind: 'p', text, depth } : null;
    case 'heading_1': return { kind: 'h1', text, depth };
    case 'heading_2': return { kind: 'h2', text, depth };
    case 'heading_3': return { kind: 'h3', text, depth };
    case 'bulleted_list_item': case 'toggle': return { kind: 'li', text, depth };
    case 'numbered_list_item': return { kind: 'ol', text, depth };
    case 'to_do': return { kind: 'todo', text, done: !!v.checked, depth };
    case 'quote': return { kind: 'quote', text, depth };
    case 'callout': return { kind: 'quote', text: (v.icon?.emoji ? v.icon.emoji + ' ' : '') + text, depth };
    case 'code': return { kind: 'code', text, depth };
    case 'equation': return { kind: 'code', text: v.expression ?? '', depth };
    case 'divider': return { kind: 'hr', text: '' };
    case 'child_page': return { kind: 'p', label: 'Page', text: v.title ?? 'Untitled', depth };
    case 'child_database': return { kind: 'p', label: 'Database', text: v.title ?? 'Untitled', depth };
    case 'image': case 'video': case 'file': case 'pdf': case 'audio': return { kind: 'p', label: b.type[0].toUpperCase() + b.type.slice(1), text: rt(v.caption) || v.name || '', depth };
    case 'bookmark': case 'embed': case 'link_preview': return { kind: 'p', label: 'Link', text: v.url ?? '', depth };
    case 'table': return { kind: 'p', label: 'Table', text: 'Open it in Notion to see the table.', depth };
    default: return text ? { kind: 'p', text, depth } : null;
  }
}
const NESTED = new Set(['bulleted_list_item', 'numbered_list_item', 'to_do', 'toggle', 'quote', 'callout']);

async function notionDetail(token: string, id: string): Promise<NoteDetail> {
  if (!/^[0-9a-f-]{32,36}$/i.test(id)) throw new Error('That is not a Notion page.');
  const page = await api(`https://api.notion.com/v1/pages/${id}`, token, { headers: notionHeaders });
  if (notionDeleted(page)) throw new Error('That page is in the Notion trash.');
  const blocks: DocBlock[] = [];
  for (const [name, v] of Object.entries<any>(page.properties ?? {})) {
    if (v?.type === 'title') continue;
    const text = notionProp(v);
    if (text) blocks.push({ kind: 'prop', label: name.slice(0, 60), text: cut(text, 500) });
    if (blocks.length >= 12) break;
  }
  const kids = await api(`https://api.notion.com/v1/blocks/${id}/children?page_size=100`, token, { headers: notionHeaders });
  let nestedCalls = 0;
  for (const b of kids.results ?? []) {
    const d = notionBlock(b, 0);
    if (d) blocks.push(d);
    // One level of nested items (sub-bullets, toggle contents), for at most ten blocks, to keep the page quick.
    if (b.has_children && NESTED.has(b.type) && nestedCalls < 10) {
      nestedCalls++;
      const sub = await api(`https://api.notion.com/v1/blocks/${b.id}/children?page_size=50`, token, { headers: notionHeaders }).catch(() => null);
      for (const c of sub?.results ?? []) { const e = notionBlock(c, 1); if (e) blocks.push(e); }
    }
    if (blocks.length >= MAX_BLOCKS) break;
  }
  return { title: notionTitle(page), source: 'Notion', url: safeLink(page.url, /(^|\.)notion\.(so|site|com)$/), edited: Date.parse(page.last_edited_time) || undefined, blocks, more: !!kids.has_more };
}

async function oneNoteDetail(token: string, id: string): Promise<NoteDetail> {
  if (!/^[A-Za-z0-9!_.\-]{1,300}$/.test(id)) throw new Error('That is not a OneNote page.');
  const base = `https://graph.microsoft.com/v1.0/me/onenote/pages/${encodeURIComponent(id)}`;
  const meta = await api(`${base}?$select=title,lastModifiedDateTime,links`, token);
  const res = await fetch(`${base}/content`, { headers: { authorization: `Bearer ${token}`, accept: 'text/html' } });
  if (!res.ok) throw new Error(`OneNote answered ${res.status}`);
  const blocks = htmlToBlocks(await res.text());
  // OneNote repeats the page title as the first line of its content.
  if (blocks[0] && blocks[0].text === meta.title) blocks.shift();
  return { title: meta.title || 'Untitled', source: 'OneNote', url: safeLink(meta.links?.oneNoteWebUrl?.href, /(^|\.)(onenote\.com|live\.com|office\.com|sharepoint\.com|1drv\.ms|onedrive\.live\.com)$/), edited: Date.parse(meta.lastModifiedDateTime) || undefined, blocks };
}

export async function noteDetail(env: Env, db: Db, userId: string, provider: string, id: string): Promise<NoteDetail> {
  const s = await credentials(env, db, userId, provider);
  if (!s) throw new Error('That connection is not linked.');
  if (provider === 'notion') return notionDetail(s.accessToken, id);
  if (provider === 'onenote') return oneNoteDetail(s.accessToken, id);
  throw new Error('Notes from this connection cannot be opened yet.');
}

// ---------------------------------------------------------------- mail
const b64urlBytes = (s: string) => { const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/')); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; };
const decodeAs = (bytes: Uint8Array, charset?: string) => { try { return new TextDecoder(charset || 'utf-8').decode(bytes); } catch { return new TextDecoder().decode(bytes); } };
function gmailBody(part: any): { plain?: string; html?: string } {
  const out: { plain?: string; html?: string } = {};
  const walk = (p: any) => {
    if (!p) return;
    const type = String(p.mimeType ?? '').toLowerCase();
    const charset = /charset="?([^";]+)/i.exec((p.headers ?? []).find((h: any) => h.name.toLowerCase() === 'content-type')?.value ?? '')?.[1];
    if (p.body?.data && type === 'text/plain' && out.plain == null) out.plain = decodeAs(b64urlBytes(p.body.data), charset);
    else if (p.body?.data && type === 'text/html' && out.html == null) out.html = decodeAs(b64urlBytes(p.body.data), charset);
    for (const c of p.parts ?? []) walk(c);
  };
  walk(part);
  return out;
}

export async function mailDetail(env: Env, db: Db, userId: string, provider: string, id: string): Promise<MailDetail> {
  const s = await credentials(env, db, userId, provider);
  if (!s) throw new Error('That connection is not linked.');
  if (isImapProvider(provider)) return imapDetail(provider, s, id);
  if (provider === 'gmail') {
    if (!/^[0-9a-f]{6,40}$/i.test(id)) throw new Error('That is not a Gmail message.');
    const d = await api(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`, s.accessToken);
    const h = (n: string) => d.payload?.headers?.find((x: any) => x.name.toLowerCase() === n)?.value ?? '';
    const body = gmailBody(d.payload);
    return { from: h('from'), to: h('to'), subject: h('subject'), date: Number(d.internalDate) || Date.parse(h('date')) || undefined, text: cut((body.plain ?? (body.html ? htmlToText(body.html) : d.snippet ?? '')).trim()), url: `https://mail.google.com/mail/#all/${encodeURIComponent(d.threadId ?? id)}` };
  }
  if (provider === 'outlook-mail') {
    const m = await api(`https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(id)}?$select=subject,from,toRecipients,receivedDateTime,body,webLink`, s.accessToken, { headers: { prefer: 'outlook.body-content-type="text"' } });
    const who = (r: any) => r?.emailAddress ? (r.emailAddress.name ? `${r.emailAddress.name} <${r.emailAddress.address}>` : r.emailAddress.address) : '';
    return { from: who(m.from), to: (m.toRecipients ?? []).map(who).join(', '), subject: m.subject ?? '', date: Date.parse(m.receivedDateTime) || undefined, text: cut(String(m.body?.content ?? '').trim()), url: safeLink(m.webLink, /(^|\.)(outlook\.live\.com|outlook\.office\.com|outlook\.office365\.com)$/) };
  }
  throw new Error('Mail from this connection cannot be opened yet.');
}

// ---------------------------------------------------------------- calendar events
export async function eventDetail(env: Env, db: Db, userId: string, provider: string, id: string, tzOffsetMin = 0): Promise<EventDetail> {
  const s = await credentials(env, db, userId, provider);
  if (!s) throw new Error('That connection is not linked.');
  if (id.length > 1024) throw new Error('That is not an event.');
  if (provider === 'ical') return icalDetail(s, id, tzOffsetMin);
  if (provider === 'google-calendar') {
    const e = await api(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(id)}`, s.accessToken);
    const allDay = !e.start?.dateTime;
    return {
      title: e.summary ?? '(no title)', source: 'Google', allDay,
      start: Date.parse(e.start?.dateTime ?? e.start?.date), end: Date.parse(e.end?.dateTime ?? e.end?.date) || undefined,
      location: e.location || undefined, description: e.description ? cut(htmlToText(e.description), 8000) : undefined,
      attendees: (e.attendees ?? []).map((a: any) => a.displayName || a.email).filter(Boolean).slice(0, 30),
      url: safeLink(e.htmlLink, /(^|\.)google\.com$/),
    };
  }
  if (provider === 'outlook-calendar') {
    const e = await api(`https://graph.microsoft.com/v1.0/me/events/${encodeURIComponent(id)}?$select=subject,start,end,isAllDay,location,body,attendees,webLink`, s.accessToken, { headers: { prefer: 'outlook.timezone="UTC", outlook.body-content-type="text"' } });
    return {
      title: e.subject ?? '(no title)', source: 'Outlook', allDay: !!e.isAllDay,
      start: Date.parse(e.start?.dateTime + 'Z'), end: Date.parse(e.end?.dateTime + 'Z') || undefined,
      location: e.location?.displayName || undefined, description: e.body?.content ? cut(String(e.body.content).trim(), 8000) : undefined,
      attendees: (e.attendees ?? []).map((a: any) => a.emailAddress?.name || a.emailAddress?.address).filter(Boolean).slice(0, 30),
      url: safeLink(e.webLink, /(^|\.)(outlook\.live\.com|outlook\.office\.com|outlook\.office365\.com)$/),
    };
  }
  throw new Error('Events from this connection cannot be opened yet.');
}
