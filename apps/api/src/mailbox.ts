// Mail over IMAP (reading) and SMTP (replies), for accounts signed in with an app password:
// Gmail, iCloud, a Synology NAS or any other provider that still allows it.
// Always encrypted: implicit TLS (IMAP 993, SMTP 465) or STARTTLS that must succeed (IMAP 143, SMTP 587).
// Listing and opening use a read-only mailbox (IMAP EXAMINE), so nothing is marked as read by looking.
import { connect } from 'cloudflare:sockets';
import { ImapFlow, createSocketsTransport } from 'imapflow';
import PostalMime from 'postal-mime';
import type { MailDetail, MailItem } from '@niko/shared';
import { htmlToText } from './details';

export const IMAP_PROVIDERS = ['gmail-imap', 'icloud-mail', 'synology-mail', 'imap-mail'] as const;
export const isImapProvider = (p: string) => (IMAP_PROVIDERS as readonly string[]).includes(p);

interface Endpoint { host: string; port: number }
export interface MailAccount { email: string; user: string; pass: string; imap: Endpoint; smtp: Endpoint; name: string; gmail: boolean }

// Tests only: lets the suite talk to a local test server without TLS. Never set in production,
// and even then only ever applies to 127.0.0.1.
let plaintextForTests = false;
export const _allowPlaintextForTests = (on: boolean) => { plaintextForTests = on; };
const testHost = (e: Endpoint) => plaintextForTests && e.host === '127.0.0.1';

const EMAIL = /^[^\s<>@,;:"()[\]\\]+@[a-z0-9.-]+\.[a-z]{2,}$/i;
const MICROSOFT = /@(outlook|hotmail|live|msn)\.[a-z.]+$/i;
/** "host" or "host:port"; a public name only (no addresses, no local names). */
function endpoint(raw: string | undefined, fallbackPort: number, allowed: number[]): Endpoint {
  const m = /^\s*([a-z0-9.-]+)(?::(\d{2,5}))?\s*$/i.exec(raw ?? '');
  if (!m) throw new Error('Use a server name such as mail.example.com, with :port if it is not the usual one.');
  const host = m[1]!.toLowerCase(), port = m[2] ? Number(m[2]) : fallbackPort;
  if (plaintextForTests && host === '127.0.0.1') return { host, port };
  if (/^\d+(\.\d+){3}$/.test(host) || !host.includes('.') || /(^|\.)(localhost|local|internal|lan|home)$/.test(host)) throw new Error('Use the public name of the mail server.');
  if (!allowed.includes(port)) throw new Error(`Port ${port} is not supported. Use ${allowed.join(' or ')}: Niko only talks to mail servers over an encrypted connection.`);
  if (/(^|\.)(outlook\.office365\.com|outlook\.com|office365\.com|hotmail\.com|live\.com)$/.test(host)) throw new Error(MS_REFUSED);
  return { host, port };
}
/** iCloud Mail signs in with the iCloud Mail address (@icloud.com, @me.com, @mac.com), not the Apple Account's own
 * email when that is another address (Outlook, Gmail…). Said plainly when Apple refuses such an address. */
export const ICLOUD_ADDRESS = /@(icloud|me|mac)\.com$/i;
export function icloudRefused(email: string): string {
  return ICLOUD_ADDRESS.test(email)
    ? 'Apple refused the app-specific password. Create a new one at account.apple.com (Sign-In and Security → App-Specific Passwords) and paste it in full.'
    : `Apple refused ${email}. iCloud Mail signs in with your iCloud Mail address (ending in @icloud.com, @me.com or @mac.com), not the email you use for your Apple Account. On iPhone: Settings → your name → iCloud → iCloud Mail shows it.`;
}
const MS_REFUSED = 'Microsoft switched off app passwords for Outlook.com, Hotmail and Live mail in September 2024, so they cannot connect this way. Use the Outlook connection, which signs in with Microsoft.';

/** The servers for each kind of account. Secrets come from the encrypted connection; nothing here is user-routable beyond the checks above. */
export function accountFor(provider: string, s: Record<string, string>): MailAccount {
  const email = String(s.email || s.username || '').trim();
  if (!EMAIL.test(email)) throw new Error('Enter the full email address.');
  // Only for "Other email (IMAP)", where the address decides which server it is. iCloud, Gmail and Synology always use
  // their own servers, so an Apple Account that signs in with an Outlook address (common) is not Microsoft at all.
  if (provider === 'imap-mail' && MICROSOFT.test(email)) throw new Error(MS_REFUSED);
  const pass = String(s.password ?? '').replace(/\s+/g, ''); // Google shows app passwords in groups of four
  if (!pass) throw new Error('Enter the app password.');
  const base = { email, user: email, pass, name: String(s.name ?? '').slice(0, 80) };
  switch (provider) {
    case 'gmail-imap': // Google Workspace addresses use the same servers
      return { ...base, imap: { host: 'imap.gmail.com', port: 993 }, smtp: { host: 'smtp.gmail.com', port: 465 }, gmail: true };
    case 'icloud-mail':
      return { ...base, imap: { host: 'imap.mail.me.com', port: 993 }, smtp: { host: 'smtp.mail.me.com', port: 587 }, gmail: false };
    case 'synology-mail': {
      const host = String(s.host ?? '').replace(/^https?:\/\//, '').replace(/\/.*$/, '');
      return { ...base, user: String(s.username || email), imap: endpoint(host, 993, [993, 143]), smtp: endpoint(host, 465, [465, 587]), gmail: false };
    }
    case 'imap-mail':
      return { ...base, imap: endpoint(s.imapHost, 993, [993, 143]), smtp: endpoint(s.smtpHost, 465, [465, 587]), gmail: /(^|\.)gmail\.com$/.test(String(s.imapHost)) };
    default:
      throw new Error('That is not a mail connection.');
  }
}



async function withImap<T>(a: MailAccount, fn: (c: ImapFlow) => Promise<T>): Promise<T> {
  const plain = testHost(a.imap);
  const c = new ImapFlow({
    host: a.imap.host, port: a.imap.port, secure: !plain && a.imap.port === 993,
    doSTARTTLS: plain ? false : a.imap.port === 143 ? true : undefined,
    auth: { user: a.user, pass: a.pass }, logger: false, transport: createSocketsTransport(connect as any),
    connectionTimeout: 10_000, greetingTimeout: 8_000, socketTimeout: 25_000, disableAutoIdle: true,
    clientInfo: { name: 'Niko' },
  } as any);
  try { await c.connect(); }
  catch (e) { throw new Error(signInProblem(e, a)); }
  try { return await fn(c); }
  finally { await c.logout().catch(() => c.close()); }
}
function signInProblem(e: unknown, a: MailAccount): string {
  const m = String((e as any)?.responseText ?? (e as Error)?.message ?? e);
  if ((e as any)?.authenticationFailed || /auth|credential|password|login|invalid/i.test(m)) {
    if (a.gmail) return 'Gmail refused the app password. Check it was copied in full, and that 2-Step Verification is still on.';
    if (a.imap.host === 'imap.mail.me.com') return icloudRefused(a.email);
    return 'The mail server refused the email address or app password.';
  }
  if (/timeout|timed out/i.test(m)) return `${a.imap.host} did not answer in time.`;
  return `Could not reach ${a.imap.host}.`;
}

const who = (list: any): string => {
  const x = Array.isArray(list) ? list[0] : list;
  return x ? (x.name ? String(x.name) : String(x.address ?? '')) : '';
};
const idFor = (uidValidity: unknown, uid: number) => `${String(uidValidity)}.${uid}`;
function parseId(id: string): { validity: string; uid: number } {
  const m = /^(\d{1,20})\.(\d{1,10})$/.exec(id);
  if (!m) throw new Error('That is not a message from this mailbox.');
  return { validity: m[1]!, uid: Number(m[2]) };
}
const LABEL: Record<string, string> = { 'gmail-imap': 'Gmail', 'icloud-mail': 'iCloud', 'synology-mail': 'Synology', 'imap-mail': 'Email' };

/** Unread mail in the inbox, the newest 50, without marking anything as read. */
export async function imapList(provider: string, s: Record<string, string>): Promise<MailItem[]> {
  const a = accountFor(provider, s);
  return withImap(a, async (c) => {
    const lock = await c.getMailboxLock('INBOX', { readOnly: true });
    try {
      const validity = (c.mailbox as any)?.uidValidity;
      const uids = ((await c.search({ seen: false }, { uid: true })) || []) as number[];
      const pick = uids.slice(-50);
      if (!pick.length) return [];
      const out: MailItem[] = [];
      for await (const m of c.fetch(pick, { envelope: true, uid: true }, { uid: true })) {
        out.push({ id: idFor(validity, m.uid), provider, from: who(m.envelope?.from) || '(unknown sender)', subject: String(m.envelope?.subject ?? ''), source: LABEL[provider] ?? 'Email' });
      }
      return out.reverse();
    } finally { lock.release(); }
  });
}

/** One message, as text. Read-only: opening it does not mark it as read. */
export async function imapDetail(provider: string, s: Record<string, string>, id: string): Promise<MailDetail> {
  const a = accountFor(provider, s);
  const { validity, uid } = parseId(id);
  return withImap(a, async (c) => {
    const lock = await c.getMailboxLock('INBOX', { readOnly: true });
    try {
      if (String((c.mailbox as any)?.uidValidity) !== validity) throw new Error('The mailbox changed since this list was made. Go back and open the message again.');
      const m = await c.fetchOne(String(uid), { source: { maxLength: 1_500_000 } as any, envelope: true, internalDate: true }, { uid: true });
      if (!m) throw new Error('That message is no longer in the inbox.');
      const parsed = await PostalMime.parse(m.source as any).catch(() => null);
      const text = (parsed?.text?.trim() || (parsed?.html ? htmlToText(parsed.html) : '') || '').slice(0, 20_000);
      const addr = (l: any[] | undefined) => (l ?? []).map((x) => (x.name ? `${x.name} <${x.address}>` : x.address)).join(', ');
      return { from: addr(m.envelope?.from), to: addr(m.envelope?.to), subject: String(m.envelope?.subject ?? ''), date: m.internalDate ? new Date(m.internalDate as any).getTime() : undefined, text };
    } finally { lock.release(); }
  });
}

// ---------------------------------------------------------------- replies (SMTP)
const clean = (v: string) => v.replace(/[\r\n]+/g, ' ').trim();
const b64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));
const encodeWord = (s: string) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64(s)}?=`);
const wrap76 = (s: string) => s.replace(/.{1,76}/g, '$&\r\n');

/** Builds a plain-text reply. Every header value has line breaks removed, so nothing can be injected. */
export function buildReply(o: { from: string; fromName?: string; to: string; subject: string; inReplyTo?: string; references?: string; body: string; domain: string }): string {
  const subject = /^re:/i.test(o.subject) ? o.subject : 'Re: ' + o.subject;
  const refs = [o.references, o.inReplyTo].filter(Boolean).map((x) => clean(x!)).join(' ').slice(-2000);
  const head = [
    `From: ${o.fromName ? `${encodeWord(clean(o.fromName))} <${o.from}>` : `<${o.from}>`}`,
    `To: <${o.to}>`,
    `Subject: ${encodeWord(clean(subject))}`,
    `Date: ${new Date().toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: <${crypto.randomUUID()}@${o.domain}>`,
    ...(o.inReplyTo ? [`In-Reply-To: ${clean(o.inReplyTo)}`] : []),
    ...(refs ? [`References: ${refs}`] : []),
    'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64',
  ];
  return head.join('\r\n') + '\r\n\r\n' + wrap76(b64(o.body.replace(/\r?\n/g, '\r\n')));
}

/** A small SMTP client: EHLO, (STARTTLS), AUTH PLAIN, one message. 465 uses TLS from the start; 587 must upgrade. */
export async function smtpSend(e: Endpoint, user: string, pass: string, from: string, to: string, message: string): Promise<void> {
  const plain = testHost(e);
  let sock = connect({ hostname: e.host, port: e.port }, { secureTransport: plain ? 'off' : e.port === 465 ? 'on' : 'starttls', allowHalfOpen: false });
  let reader = sock.readable.getReader(), writer = sock.writable.getWriter();
  const enc = new TextEncoder(), dec = new TextDecoder();
  let buf = '';
  const reply = async (): Promise<{ code: number; text: string }> => {
    for (;;) {
      const lines = buf.split('\r\n');
      for (let i = 0; i < lines.length - 1; i++) {
        if (/^\d{3} /.test(lines[i]!)) { buf = lines.slice(i + 1).join('\r\n'); return { code: Number(lines[i]!.slice(0, 3)), text: lines.slice(0, i + 1).join('\n') }; }
      }
      const { value, done } = await reader.read();
      if (done) throw new Error('The mail server closed the connection.');
      buf += dec.decode(value, { stream: true });
    }
  };
  const say = (line: string) => writer.write(enc.encode(line + '\r\n'));
  const expect = async (codes: number[], what: string) => {
    const r = await reply();
    if (!codes.includes(r.code)) throw new Error(r.code === 535 || r.code === 534 ? 'The mail server refused the app password for sending.' : `The mail server refused the message (${what}: ${r.code}).`);
    return r;
  };
  const run = async () => {
    await expect([220], 'greeting');
    await say('EHLO niko.app'); await expect([250], 'EHLO');
    if (!plain && e.port !== 465) {
      await say('STARTTLS'); await expect([220], 'STARTTLS');
      reader.releaseLock(); writer.releaseLock();
      sock = sock.startTls();
      reader = sock.readable.getReader(); writer = sock.writable.getWriter(); buf = '';
      await say('EHLO niko.app'); await expect([250], 'EHLO');
    }
    await say('AUTH PLAIN ' + b64(`\0${user}\0${pass}`)); await expect([235], 'AUTH');
    await say(`MAIL FROM:<${from}>`); await expect([250], 'MAIL FROM');
    await say(`RCPT TO:<${to}>`); await expect([250, 251], 'RCPT TO');
    await say('DATA'); await expect([354], 'DATA');
    // Dot-stuffing: a line that starts with "." gets another, so it cannot end the message early.
    await writer.write(enc.encode(message.replace(/(^|\r\n)\./g, '$1..') + '\r\n.\r\n')); await expect([250], 'message');
    await say('QUIT').catch(() => undefined);
  };
  let timer = 0 as unknown as ReturnType<typeof setTimeout>;
  try {
    await Promise.race([run(), new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`${e.host} did not answer in time.`)), 25_000); })]);
  } finally {
    clearTimeout(timer);
    await sock.close().catch(() => undefined);
  }
}

/** Replies to one message: sends it by SMTP, marks the original as answered, and keeps a copy in Sent (Gmail does that itself). */
export async function imapReply(provider: string, s: Record<string, string>, id: string, body: string): Promise<void> {
  const a = accountFor(provider, s);
  const { validity, uid } = parseId(id);
  const orig = await withImap(a, async (c) => {
    const lock = await c.getMailboxLock('INBOX', { readOnly: true });
    try {
      if (String((c.mailbox as any)?.uidValidity) !== validity) throw new Error('The mailbox changed since this list was made. Open the message again.');
      const m = await c.fetchOne(String(uid), { envelope: true, headers: ['references'] }, { uid: true });
      if (!m) throw new Error('That message is no longer in the inbox.');
      return m;
    } finally { lock.release(); }
  });
  const to = String((orig.envelope?.replyTo?.[0] ?? orig.envelope?.from?.[0])?.address ?? '');
  if (!EMAIL.test(to)) throw new Error('That message has no address to reply to.');
  const references = /references:\s*([\s\S]*)/i.exec(new TextDecoder().decode(orig.headers as any ?? new Uint8Array()))?.[1]?.replace(/\s+/g, ' ').trim();
  const message = buildReply({ from: a.email, fromName: a.name, to, subject: String(orig.envelope?.subject ?? ''), inReplyTo: orig.envelope?.messageId, references, body, domain: a.email.split('@')[1]! });
  await smtpSend(a.smtp, a.user, a.pass, a.email, to, message);
  // Best effort: the reply has gone out whatever happens here.
  await withImap(a, async (c) => {
    const lock = await c.getMailboxLock('INBOX');
    try { await c.messageFlagsAdd(String(uid), ['\\Answered'], { uid: true }); } finally { lock.release(); }
    if (!a.gmail) {
      const sent = (await c.list()).find((b: any) => b.specialUse === '\\Sent');
      if (sent) await c.append(sent.path, message, ['\\Seen']);
    }
  }).catch(() => undefined);
}

/** Signs in once to check the details before they are saved. */
export async function imapCheck(provider: string, s: Record<string, string>): Promise<void> {
  const a = accountFor(provider, s);
  await withImap(a, async (c) => { await c.status('INBOX', { messages: true }); });
}
