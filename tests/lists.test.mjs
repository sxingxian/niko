// Long lists: Gmail's batch answer is read back per message, and voice can move between pages.
import assert from 'node:assert/strict';
import { gmailBatch } from '../apps/api/src/gmail.ts';
import { pageRequest } from '../apps/app/src/speech.ts';

let pass = 0;
const ok = async (name, fn) => { try { await fn(); pass++; console.log('PASS', name); } catch (e) { console.log('FAIL', name, e?.message); process.exitCode = 1; } };
let sent = null;
globalThis.fetch = async (url, init) => {
  sent = { url: String(url), init };
  const b = 'batch_abc';
  const part = (i, status, body) => `--${b}\r\nContent-Type: application/http\r\nContent-ID: <response-i${i}>\r\n\r\nHTTP/1.1 ${status}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${body}\r\n`;
  const text = part(1, '200 OK', JSON.stringify({ id: 'b', payload: { headers: [{ name: 'Subject', value: 'Two } {' }] } })) +
    part(0, '200 OK', JSON.stringify({ id: 'a', payload: { headers: [{ name: 'From', value: 'Ann <ann@x.com>' }] } })) +
    part(2, '404 Not Found', JSON.stringify({ error: { code: 404 } })) + `--${b}--`;
  return new Response(text, { headers: { 'content-type': `multipart/mixed; boundary=${b}` } });
};

await ok('Gmail batch: one request, answers matched to their messages, failures left empty', async () => {
  const out = await gmailBatch('TOKEN', ['/gmail/v1/users/me/messages/a?format=metadata', '/gmail/v1/users/me/messages/b', '/gmail/v1/users/me/messages/c']);
  assert.equal(sent.url, 'https://gmail.googleapis.com/batch/gmail/v1');
  assert.equal(sent.init.headers.authorization, 'Bearer TOKEN');
  assert.ok(String(sent.init.body).includes('GET /gmail/v1/users/me/messages/b'));
  assert.equal(out[0].id, 'a'); assert.equal(out[1].id, 'b'); assert.equal(out[1].payload.headers[0].value, 'Two } {'); assert.equal(out[2], null);
});
await ok('Gmail batch: nothing to read makes no request', async () => { sent = null; assert.deepEqual(await gmailBatch('T', []), []); assert.equal(sent, null); });

const pr = { 'next page': 'next', 'go to the next page': 'next', 'Niko, next page please': 'next', 'previous page': 'prev', 'back a page': 'prev', 'go back to the previous page': 'prev',
  'first page': 'first', 'go to the first page': 'first', 'last page': 'last', 'page 3': 3, 'page three': 3, 'go to page two': 2, 'show page 4': 4, 'page number 5': 5 };
for (const [p, want] of Object.entries(pr)) await ok(`page: "${p}"`, () => assert.equal(pageRequest(p), want));
for (const p of ['scroll down', 'open the second one', 'next', 'what is on page six of the report tomorrow', 'make it shorter', 'page down'])
  await ok(`not a page move: "${p}"`, () => assert.equal(pageRequest(p), null));
console.log(`${pass} list checks passed`);
