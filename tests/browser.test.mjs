// Niko's browser: the admin's settings, sites Niko may open, daily minutes, and the Cloudflare Browser Run calls
// (against a stand-in for Cloudflare's API: what is sent, and how each kind of refusal is worded).
import assert from 'node:assert/strict';
import { browserFor, cleanBrowserAccess, cleanBrowserDefaults, cleanBrowserPrefs, cleanServiceUrl, cleanSitePattern, DEFAULT_BROWSER, hostBlocked, isCfAccountId, isCfToken, lastRefill, nextRefill, openableHost, siteOf, toAddress } from '../packages/shared/src/browser.ts';
import { cf, cfClose, CfError, cfOpen, cfPass, cfTab, passHost } from '../apps/api/src/browserCf.ts';

const ok = async (name, fn) => { try { await fn(); console.log('PASS', name); } catch (e) { console.log('FAIL', name, e?.stack ?? e?.message); process.exitCode = 1; } };

await ok('Cloudflare account IDs and tokens are checked before anything is sent', () => {
  assert.ok(isCfAccountId('0123456789abcdef0123456789ABCDEF'));
  assert.ok(!isCfAccountId('0123456789abcdef'));
  assert.ok(!isCfAccountId('0123456789abcdef0123456789abcdeg'));
  assert.ok(isCfToken('aB3_-'.repeat(8)));
  assert.ok(!isCfToken('short'));
  assert.ok(!isCfToken('has spaces in it but is long enough to pass'));
  assert.ok(!isCfToken('Bearer abcdefghijklmnopqrstuvwxyz0123456789'));
});

await ok('admin settings keep only known, valid values; blocked sites become host names', () => {
  assert.deepEqual(cleanBrowserDefaults(null), DEFAULT_BROWSER);
  const d = cleanBrowserDefaults({ on: false, mins: 30, ownMins: 7, hostMins: 60, atOnce: 99, refillHourUtc: 25, historyDays: 30, blocked: ['https://www.ExampleBank.com/login', 'example-casino.com/*', '*.shop.co', 'localhost', '10.0.0.1', 'nope', 'examplebank.com'], extra: 1 });
  assert.equal(d.on, false); assert.equal(d.mins, 30); assert.equal(d.ownMins, 0); assert.equal(d.hostMins, 60);
  assert.equal(d.atOnce, 2); assert.equal(d.refillHourUtc, 0); assert.equal(d.historyDays, 30);
  assert.deepEqual(d.blocked, ['examplebank.com', 'example-casino.com', 'shop.co']);
  assert.ok(!('extra' in d));
  assert.equal(cleanSitePattern('http://intranet'), null);
});

await ok('one person: the default with their changes on top; admins always have the browser', () => {
  const d = cleanBrowserDefaults({ on: false, mins: 10, ownService: false });
  assert.deepEqual(cleanBrowserAccess({ on: true, mins: 11, ownMins: 30, nope: 1 }), { on: true, ownMins: 30 });
  assert.deepEqual(browserFor(d, { mins: 20, ownService: true }), { on: false, ownService: true, mins: 20, ownMins: 0, hostMins: 0 });
  assert.equal(browserFor(d, {}, true).on, true);
  assert.equal(browserFor(d, { on: true }).on, true);
});

await ok('Niko only opens public http(s) sites; blocked sites cover their subdomains', () => {
  assert.equal(openableHost('https://Accounts.Pebbleandpeak.com/join'), 'accounts.pebbleandpeak.com');
  for (const bad of ['file:///etc/passwd', 'javascript:alert(1)', 'http://localhost:8080', 'http://192.168.1.1', 'http://[::1]/', 'https://user:pw@site.com', 'chrome://settings', 'http://router.local']) assert.equal(openableHost(bad), null, bad);
  assert.ok(hostBlocked('www.examplebank.com', ['examplebank.com']));
  assert.ok(hostBlocked('login.examplebank.com', ['examplebank.com']));
  assert.ok(!hostBlocked('notexamplebank.com', ['examplebank.com']));
  assert.equal(siteOf('accounts.pebbleandpeak.com'), 'pebbleandpeak.com');
  assert.equal(siteOf('www.shop.com.sg'), 'shop.com.sg');
  assert.equal(toAddress('pebbleandpeak.com'), 'https://pebbleandpeak.com/');
  assert.equal(toAddress('not a site'), null);
  assert.equal(toAddress('localhost'), null);
});

await ok('daily minutes refill at the admin’s hour (UTC)', () => {
  const now = new Date('2026-11-22T05:30:00Z');
  assert.equal(lastRefill(now, 0).toISOString(), '2026-11-22T00:00:00.000Z');
  assert.equal(lastRefill(now, 7).toISOString(), '2026-11-21T07:00:00.000Z');
  assert.equal(nextRefill(now, 7).toISOString(), '2026-11-22T07:00:00.000Z');
});

await ok('people’s choices never keep history longer than the admin allows', () => {
  assert.equal(cleanBrowserPrefs({ keepDays: 90 }, 30).keepDays, 30);
  assert.equal(cleanBrowserPrefs({ keepDays: 8 }).keepDays, 30);
  assert.equal(cleanBrowserPrefs({ askDownloads: false }).askDownloads, false);
});

await ok('browser service addresses: https or wss, public, no sign-in in the address', () => {
  assert.deepEqual(cleanServiceUrl('wss://browser.mynas.net/?x=1#y'), { url: 'wss://browser.mynas.net/?x=1' });
  assert.ok('problem' in cleanServiceUrl('http://browser.mynas.net'));
  assert.match(cleanServiceUrl('https://192.168.1.20:3000').problem, /number address|Home network/);
  assert.match(cleanServiceUrl('https://nas.local').problem, /Home network/);
  assert.ok('problem' in cleanServiceUrl('https://me:pw@browser.net'));
});

// ---- Cloudflare's API, stood in for
const sent = [];
let answer = () => Response.json({});
globalThis.fetch = async (url, init = {}) => { sent.push({ url: String(url), method: init.method, auth: init.headers?.authorization, body: init.body }); return answer(String(url), init); };
const conn = { account: '0123456789abcdef0123456789abcdef', token: 'tok_'.repeat(10) };

await ok('opening a browser, a tab and a pass sends the right calls, with the token only in the header', async () => {
  answer = (url, init) => {
    if (init.method === 'POST' && url.includes('keep_alive')) return Response.json({ sessionId: 'abcd-1234-efgh', webSocketDebuggerUrl: 'wss://api.cloudflare.com/x' });
    if (init.method === 'PUT') return Response.json({ id: 'TARGET1', type: 'page', url: 'https://example.com/' });
    if (url.endsWith('/live_view')) return Response.json({ id: 'lv', webSocketDebuggerUrl: 'wss://live.browser.run/api/devtools/browser/abcd/page/TARGET1?jwt=x', devtoolsFrontendUrl: 'https://live.browser.run/ui/view?x' });
    return Response.json({ status: 'closing' });
  };
  const { sessionId } = await cfOpen(conn, 999_999);
  assert.equal(sessionId, 'abcd-1234-efgh');
  assert.match(sent.at(-1).url, /\/accounts\/0123456789abcdef0123456789abcdef\/browser-run\/devtools\/browser\?keep_alive=600000$/);
  assert.equal(sent.at(-1).auth, `Bearer ${conn.token}`);
  const tab = await cfTab(conn, sessionId, 'https://example.com/?a=1&b=2');
  assert.equal(tab.id, 'TARGET1');
  assert.match(sent.at(-1).url, /\/abcd-1234-efgh\/json\/new\?url=https%3A%2F%2Fexample\.com%2F%3Fa%3D1%26b%3D2$/);
  const pass = await cfPass(conn, sessionId, tab.id, true, 1000);
  assert.deepEqual(JSON.parse(sent.at(-1).body), { mode: 'tab', expiresInMs: 60000, targetId: 'TARGET1', guardrails: { mode: 'readonly' } });
  assert.equal(pass.readonly, true);
  assert.ok(pass.ws.startsWith('wss://live.browser.run/'));
  assert.ok(!sent.some((s) => s.url.includes(conn.token)));
  await cfClose(conn, sessionId);
  assert.equal(sent.at(-1).method, 'DELETE');
});

await ok('a pass that points anywhere but Cloudflare’s live view is refused', async () => {
  assert.ok(passHost('wss://live.browser.run/x'));
  assert.ok(!passHost('ws://live.browser.run/x'));
  assert.ok(!passHost('wss://evil.example/live.browser.run'));
  answer = () => Response.json({ webSocketDebuggerUrl: 'wss://evil.example/x' });
  await assert.rejects(cfPass(conn, 'abcd-1234-efgh', undefined, false), CfError);
});

await ok('each kind of refusal is worded for the admin', async () => {
  const cases = [[401, '{}', 'token'], [403, '{}', 'token'], [404, '{}', 'account'], [429, 'Browser time limit exceeded for today', 'limit'], [429, 'too many', 'busy'], [503, '', 'down']];
  for (const [status, body, code] of cases) {
    answer = () => new Response(body, { status });
    await assert.rejects(cf(conn, 'POST', ''), (e) => e instanceof CfError && e.code === code);
  }
  answer = () => new Response('', { status: 404 });
  await cfClose(conn, 'gone-session-1'); // a session that already closed is fine
});
