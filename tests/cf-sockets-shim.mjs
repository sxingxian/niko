// Stand-in for cloudflare:sockets in Node, for tests: plain TCP only (the tests use 127.0.0.1 without TLS).
import net from 'node:net';
import { Readable, Writable } from 'node:stream';
export function connect(addr, opts = {}) {
  const s = net.connect({ host: addr.hostname, port: addr.port });
  const opened = new Promise((res, rej) => { s.once('connect', () => res({ remoteAddress: `${addr.hostname}:${addr.port}`, localAddress: '127.0.0.1:0' })); s.once('error', rej); });
  const closed = new Promise((res) => s.once('close', res));
  return {
    readable: Readable.toWeb(s), writable: Writable.toWeb(s), opened, closed,
    close: async () => { s.destroy(); },
    startTls: () => { throw new Error('TLS is not available in the test shim'); },
  };
}
