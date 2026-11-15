import hoodiecrow from 'hoodiecrow-imap';
import { SMTPServer } from 'smtp-server';
import { _allowPlaintextForTests, imapList, imapDetail, imapReply, imapCheck, buildReply, accountFor } from '../apps/api/src/mailbox.ts';
import { htmlToBlocks } from '../apps/api/src/details.ts';

const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
const MSG = (n, extra = '') => `From: Maya Chen <maya@example.com>\r\nTo: me@example.com\r\nSubject: Venue ${n}\r\nMessage-ID: <m${n}@example.com>\r\nReply-To: Maya R <maya.r@example.com>\r\nDate: Sun, 15 Nov 2026 08:00:00 +0000\r\n${extra}\r\n`;
const html = MSG(1, 'MIME-Version: 1.0\r\nContent-Type: multipart/alternative; boundary="b1"\r\n') + '--b1\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<p>Hello <b>there</b> &amp; welcome</p><ul><li>One</li></ul>\r\n--b1--\r\n';
const imap = hoodiecrow({
  plugins: ['ENABLE', 'UIDPLUS', 'SPECIAL-USE', 'IDLE', 'LITERALPLUS', 'ID', 'UNSELECT'],
  storage: {
    INBOX: { messages: [{ raw: html, flags: [] }, { raw: MSG(2) + 'Already read.', flags: ['\\Seen'] }, { raw: MSG(3) + 'Plain text body.\r\n.Line that starts with a dot', flags: [] }] },
    '': { separator: '/', folders: { Sent: { 'special-use': '\\Sent', messages: [] } } },
  },
  users: { 'me@example.com': { password: 'apppassword1234' } },
});
await new Promise((r) => imap.listen(11143, r));
const got = [];
const smtp = new SMTPServer({ secure: false, allowInsecureAuth: true, disabledCommands: ['STARTTLS'], authMethods: ['PLAIN'],
  onAuth(auth, _s, cb) { cb(auth.username === 'me@example.com' && auth.password === 'apppassword1234' ? null : new Error('bad'), { user: auth.username }); },
  onData(stream, s, cb) { let d = ''; stream.on('data', (c) => (d += c)); stream.on('end', () => { got.push({ from: s.envelope.mailFrom.address, to: s.envelope.rcptTo.map((r) => r.address), data: d }); cb(); }); } });
await new Promise((r) => smtp.listen(11465, '127.0.0.1', r));

_allowPlaintextForTests(true);
const S = { email: 'me@example.com', password: 'apppassword1234', imapHost: '127.0.0.1:11143', smtpHost: '127.0.0.1:11465', name: 'Xing' };
try {
  await imapCheck('imap-mail', S); ok(true, 'sign-in check passes with the right app password');
  try { await imapCheck('imap-mail', { ...S, password: 'wrong' }); ok(false, 'wrong password refused'); } catch (e) { ok(/refused/.test(e.message), 'wrong password refused: ' + e.message); }
  const list = await imapList('imap-mail', S);
  ok(list.length === 2, `lists the 2 unread messages (got ${list.length}: ${list.map((m) => m.subject).join(', ')})`);
  ok(list[0].from === 'Maya Chen' && /^\d+\.\d+$/.test(list[0].id), 'sender name and id: ' + JSON.stringify(list[0]));
  const d1 = await imapDetail('imap-mail', S, list.find((m) => m.subject === 'Venue 1').id);
  ok(/Hello there & welcome/.test(d1.text) && /One/.test(d1.text), 'HTML-only mail becomes text: ' + JSON.stringify(d1.text));
  const again = await imapList('imap-mail', S);
  ok(again.length === 2, 'opening a message does not mark it as read');
  await imapReply('imap-mail', S, list.find((m) => m.subject === 'Venue 3').id, 'Sounds good.\n.see you');
  ok(got.length === 1 && got[0].to[0] === 'maya.r@example.com' && got[0].from === 'me@example.com', 'reply goes to Reply-To, from the account: ' + JSON.stringify({ to: got[0]?.to, from: got[0]?.from }));
  const data = got[0]?.data ?? '';
  ok(/^Subject: Re: Venue 3/m.test(data) && /^In-Reply-To: <m3@example.com>/m.test(data) && /^References: <m3@example.com>/m.test(data), 'threading headers set');
  const body = Buffer.from(data.split('\r\n\r\n').slice(1).join('').replace(/\s+/g, ''), 'base64').toString();
  ok(body === 'Sounds good.\r\n.see you', 'body intact (dot-stuffing undone by the server): ' + JSON.stringify(body));
  const { ImapFlow } = await import('imapflow');
  const c = new ImapFlow({ host: '127.0.0.1', port: 11143, secure: false, auth: { user: 'me@example.com', pass: 'apppassword1234' }, logger: false });
  await c.connect();
  const sent = await c.status('Sent', { messages: true });
  await c.mailboxOpen('INBOX', { readOnly: true });
  const flags = (await c.fetchOne('3', { flags: true })).flags;
  await c.logout();
  ok(sent.messages === 1, 'a copy is kept in Sent (' + sent.messages + ')');
  ok(flags.has('\\Answered') && !flags.has('\\Seen'), 'original marked answered, not read: ' + [...flags]);
  const after = await imapList('imap-mail', S);
  ok(after.length === 2, 'still 2 unread after replying (answered, not read)');
  // A header-injection attempt in the subject stays one line.
  const r = buildReply({ from: 'a@b.co', to: 'c@d.co', subject: 'Hi\r\nBcc: evil@x.co', body: 'x', domain: 'b.co' });
  ok(!/^Bcc:/m.test(r), 'a line break in a subject cannot add a header');
  try { accountFor('imap-mail', { ...S, email: 'me@outlook.com' }); ok(false, 'outlook refused'); } catch (e) { ok(/Microsoft/.test(e.message), 'Outlook.com address refused with the reason'); }
  try { accountFor('imap-mail', { ...S, imapHost: 'imap.example.com:110' }); ok(false, 'port 110'); } catch (e) { ok(/encrypted/.test(e.message), 'unencrypted port refused'); }
  _allowPlaintextForTests(false);
  try { accountFor('imap-mail', S); ok(false, 'ip refused'); } catch (e) { ok(/public name/.test(e.message), 'a bare IP address is refused outside tests'); }
  const b = htmlToBlocks('<h1>T</h1><p data-tag="to-do:completed">Done thing</p><p data-tag="to-do">Open thing</p><script>alert(1)</script><p>A &lt;b&gt; &#x1F600;</p>');
  ok(JSON.stringify(b) === JSON.stringify([{ kind: 'h1', text: 'T' }, { kind: 'todo', text: 'Done thing', done: true }, { kind: 'todo', text: 'Open thing', done: false }, { kind: 'p', text: 'A <b> 😀' }]), 'HTML to blocks: ' + JSON.stringify(b));
} catch (e) { ok(false, 'unexpected: ' + (e.stack || e)); }
imap.close?.(); smtp.close(); setTimeout(() => process.exit(), 200);
