// Browser services other than Cloudflare: what is entered is checked, relay passes are signed, and the relay itself,
// against a real Chrome (headless): each browser gets its own context (no shared sign-ins), a device sees only its own
// tab, commands for the whole browser are refused, and closing throws the context away. Chrome parts are skipped where
// Chrome isn't installed.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanServiceUrl, keyParamFor, isServiceKey, BROWSER_SERVICE_ORDER } from '../packages/shared/src/browser.ts';
import { cleanServiceInput } from '../apps/api/src/browserServices.ts';
import { relayPass, checkRelayPass } from '../apps/api/src/browser.ts';
import { Upstream } from '../apps/api/src/browserRelay.ts';

const ok = async (name, fn) => { try { await fn(); console.log('PASS', name); } catch (e) { console.log('FAIL', name, e?.stack ?? e?.message); process.exitCode = 1; } };

await ok('service addresses: public https or wss only, no sign-in in the address, no home network', () => {
  assert.deepEqual(cleanServiceUrl('wss://browser.example.com'), { url: 'wss://browser.example.com/' });
  assert.ok('url' in cleanServiceUrl('https://production-sfo.browserless.io'));
  assert.ok('problem' in cleanServiceUrl('ws://browser.example.com'));
  assert.ok('problem' in cleanServiceUrl('wss://user:pw@browser.example.com'));
  assert.ok('problem' in cleanServiceUrl('wss://192.168.1.20:3000'));
  assert.match(cleanServiceUrl('wss://nas.local').problem ?? '', /Home network addresses|public/);
  assert.ok('problem' in cleanServiceUrl('wss://nas.local'));
});
await ok('what is entered for a service is checked; a hosted service needs its key', () => {
  assert.equal(cleanServiceInput({ kind: 'server', url: 'wss://browser.example.com' }, false).kind, 'server');
  assert.equal(cleanServiceInput({ kind: 'server', url: 'wss://browser.example.com' }, false).name, 'Own browser server');
  assert.equal(cleanServiceInput({ kind: 'hosted', url: 'wss://production-sfo.browserless.io' }, false).field, 'key');
  const h = cleanServiceInput({ kind: 'hosted', url: 'wss://production-sfo.browserless.io', key: 'abcdefgh1234' }, false);
  assert.equal(h.name, 'Browserless'); assert.equal(h.key, 'abcdefgh1234');
  assert.equal(cleanServiceInput({ kind: 'hosted', url: 'wss://x.example.com', key: 'has spaces in it' }, false).field, 'key');
  assert.equal(cleanServiceInput({ kind: 'other', url: 'wss://x.example.com' }, false).field, 'kind');
  assert.equal(keyParamFor('wss://connect.steel.dev'), 'apiKey');
  assert.equal(keyParamFor('wss://production-sfo.browserless.io'), 'token');
  assert.ok(isServiceKey('k'.repeat(20)) && !isServiceKey('short'));
  assert.deepEqual([...BROWSER_SERVICE_ORDER], ['own', 'cloudflare', 'server', 'hosted']);
});
await ok('a relay pass covers one tab of one browser, for a minute', async () => {
  const k = 'k'.repeat(44), sid = '11111111-2222-3333-4444-555555555555';
  const p = await relayPass(k, sid, 'TAB1234');
  assert.ok(await checkRelayPass(k, sid, 'TAB1234', p));
  assert.ok(!(await checkRelayPass(k, sid, 'TAB9999', p)), 'another tab');
  assert.ok(!(await checkRelayPass(k, '11111111-2222-3333-4444-555555555556', 'TAB1234', p)), 'another browser');
  assert.ok(!(await checkRelayPass('x'.repeat(44), sid, 'TAB1234', p)), 'another key');
  assert.ok(!(await checkRelayPass(k, sid, 'TAB1234', p, Date.now() + 61_000)), 'run out');
  assert.ok(!(await checkRelayPass(k, sid, 'TAB1234', 'nonsense')));
});

const chrome = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'].find((c) => { try { execFileSync('which', [c], { stdio: 'ignore' }); return true; } catch { return false; } });
if (!chrome) { console.log('SKIP relay tests: Chrome isn’t installed here'); process.exit(); }

const server = createServer((req, res) => {
  if (req.url.startsWith('/signin')) { res.setHeader('set-cookie', 'sid=alex; Path=/'); res.end('<title>Signed in</title>'); return; }
  res.setHeader('content-type', 'text/html; charset=utf-8'); res.end(`<title>${/sid=alex/.test(req.headers.cookie ?? '') ? 'Hello Alex' : 'Please sign in'}</title>`);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const profile = mkdtempSync(join(tmpdir(), 'niko-relay-'));
const proc = spawn(chrome, ['--headless=new', '--no-sandbox', '--disable-gpu', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
const wsUrl = await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('Chrome didn’t start')), 20_000);
  let buf = '';
  proc.stderr.on('data', (d) => { buf += d; const m = /DevTools listening on (ws:\/\/\S+)/.exec(buf); if (m) { clearTimeout(t); resolve(m[1]); } });
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function upstream() {
  const ws = new WebSocket(wsUrl);
  await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j); });
  const up = new Upstream(ws);
  up.context = (await up.send('Target.createBrowserContext', { disposeOnDetach: true })).browserContextId;
  return up;
}
/** A device socket, as the keeper sees it. */
class Device extends EventTarget {
  got = []; closed = false; n = 0;
  send(t) { this.got.push(JSON.parse(t)); }
  close() { this.closed = true; }
  ask(method, params = {}) {
    const id = ++this.n;
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ id, method, params }) }));
    return (async () => { for (let i = 0; i < 100; i++) { const m = this.got.find((x) => x.id === id); if (m) return m; await sleep(50); } throw new Error(`no answer to ${method}`); })();
  }
}
async function device(up, url) {
  const target = await up.newTab(url);
  const sid = await up.attach(target);
  const d = new Device();
  up.connect(target, sid, d);
  return { d, target };
}
const title = async (d) => (await d.ask('Runtime.evaluate', { expression: 'document.title', returnByValue: true })).result.result.value;

try {
  await ok('a device talks to its own tab through the relay, and gets that tab’s events', async () => {
    const up = await upstream();
    const { d } = await device(up, base + '/');
    await sleep(600);
    await d.ask('Page.enable');
    assert.equal(await title(d), 'Please sign in');
    const answer = await d.ask('Runtime.evaluate', { expression: '1 + 1', returnByValue: true });
    assert.equal(answer.sessionId, undefined, 'the device never sees the service’s session ids');
    await d.ask('Page.navigate', { url: base + '/next' });
    for (let i = 0; i < 60 && !d.got.some((m) => m.method === 'Page.loadEventFired'); i++) await sleep(50);
    assert.ok(d.got.some((m) => m.method === 'Page.loadEventFired'));
    await up.shutdown();
  });

  await ok('commands for the whole browser are refused (other tabs, contexts, closing it)', async () => {
    const up = await upstream();
    const { d } = await device(up, 'about:blank');
    for (const m of ['Target.getTargets', 'Target.createTarget', 'Browser.close', 'Target.disposeBrowserContext']) {
      const r = await d.ask(m, { url: 'about:blank' });
      assert.equal(r.error?.message, 'Not allowed', m);
    }
    await up.shutdown();
  });

  await ok('two people on the same server never share sign-ins: each browser has its own context', async () => {
    const a = await upstream(), b = await upstream();
    const A = await device(a, base + '/signin');
    await sleep(800);
    const B = await device(b, base + '/');
    await sleep(800);
    await A.d.ask('Page.navigate', { url: base + '/' }); await sleep(800);
    assert.equal(await title(A.d), 'Hello Alex');
    await B.d.ask('Page.reload'); await sleep(800);
    assert.equal(await title(B.d), 'Please sign in');
    const cookies = (await B.d.ask('Network.getAllCookies')).result.cookies;
    assert.ok(!cookies.some((c) => c.name === 'sid'));
    await a.shutdown(); await b.shutdown();
  });

  await ok('closing throws the browser away: its tabs and sign-ins are gone', async () => {
    const up = await upstream();
    const { d, target } = await device(up, base + '/signin');
    await sleep(800);
    await up.shutdown();
    assert.ok(d.closed, 'the device was told');
    const check = await upstream();
    const targets = (await check.send('Target.getTargets')).targetInfos;
    assert.ok(!targets.some((t) => t.targetId === target));
    const fresh = await device(check, base + '/');
    await sleep(800);
    assert.equal(await title(fresh.d), 'Please sign in');
    await check.shutdown();
  });

  await ok('when the service goes away, the devices are told and waiting commands fail', async () => {
    const up = await upstream();
    const { d } = await device(up, 'about:blank');
    let told = false; up.onClosed = () => { told = true; };
    up.ws.close();
    for (let i = 0; i < 40 && !told; i++) await sleep(50);
    assert.ok(told && d.closed && up.closed);
    await assert.rejects(up.send('Browser.getVersion'));
  });
} finally {
  proc.kill(); server.close();
  await sleep(300);
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* left for the OS */ }
}
