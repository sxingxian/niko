// Fetching from an address a person or the admin typed (data sources): https only, a public host name whose addresses
// are all on the public internet (checked through DNS-over-HTTPS before each request, and again at every redirect),
// GET only, 10 seconds at most, 1 MB at most, JSON or CSV only. A key in a header is never sent on to another site.
import { DATA_MAX_BYTES, DATA_TIMEOUT_MS, hostProblem, privateIp } from '@niko/shared';

export class FetchProblem extends Error { constructor(message: string, readonly status = 0) { super(message); } }

// DNS answers per host, kept briefly in this Worker instance.
const dnsKept = new Map<string, { ok: boolean; at: number }>();
/** Tests replace this to answer DNS without the network. */
export const dns = {
  lookup: async (host: string, type: 'A' | 'AAAA'): Promise<string[]> => {
    const res = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=${type}`, { headers: { accept: 'application/dns-json' }, signal: AbortSignal.timeout(4000) });
    if (!res.ok) throw new Error('dns');
    const j = await res.json() as { Status?: number; Answer?: { type: number; data: string }[] };
    if (j.Status !== 0 && j.Status !== 3) throw new Error('dns');
    // Only address records; CNAMEs along the way are followed by the resolver.
    return (j.Answer ?? []).filter((a) => a.type === (type === 'A' ? 1 : 28)).map((a) => a.data);
  },
};
/** Whether every address the host resolves to is public. A host with no addresses, or any private one, is refused. */
export async function publicHost(host: string): Promise<boolean> {
  if (hostProblem(host)) return false;
  const k = dnsKept.get(host);
  if (k && Date.now() - k.at < 60_000) return k.ok;
  let ok = false;
  try {
    const [a, aaaa] = await Promise.all([dns.lookup(host, 'A'), dns.lookup(host, 'AAAA')]);
    const all = [...a, ...aaaa];
    ok = all.length > 0 && all.every((ip) => !privateIp(ip));
  } catch { ok = false; }
  if (dnsKept.size > 500) dnsKept.delete(dnsKept.keys().next().value!);
  dnsKept.set(host, { ok, at: Date.now() });
  return ok;
}
export const forgetDns = () => dnsKept.clear();

export interface Fetched { body: string; kind: 'json' | 'csv'; status: number; ms: number }
/** One GET with the checks above. `headers` go only to the first site; a redirect elsewhere drops them. */
export async function safeGet(url: string, headers: Record<string, string> = {}, opts: { timeoutMs?: number; maxBytes?: number } = {}): Promise<Fetched> {
  const t0 = Date.now();
  const signal = AbortSignal.timeout(opts.timeoutMs ?? DATA_TIMEOUT_MS);
  const max = opts.maxBytes ?? DATA_MAX_BYTES;
  let at = new URL(url);
  const origin = at.origin;
  for (let hop = 0; ; hop++) {
    if (at.protocol !== 'https:' || at.username || at.password || (at.port && at.port !== '443')) throw new FetchProblem('The address must be a plain https address.');
    if (!(await publicHost(at.hostname))) throw new FetchProblem('That address isn’t on the public internet, so Niko won’t call it.');
    let res: Response;
    try {
      res = await fetch(at.toString(), { method: 'GET', redirect: 'manual', signal, headers: { accept: 'application/json, text/csv;q=0.9', 'user-agent': 'Niko data sources', ...(at.origin === origin ? headers : {}) } });
    } catch (e) {
      throw new FetchProblem((e as Error)?.name === 'TimeoutError' || (e as Error)?.name === 'AbortError' ? 'The source didn’t answer within 10 seconds.' : 'The source couldn’t be reached.');
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      if (hop >= 3) throw new FetchProblem('The source sent Niko to too many other addresses.');
      at = new URL(res.headers.get('location')!, at);
      continue;
    }
    if (!res.ok) throw new FetchProblem(res.status === 401 || res.status === 403 ? 'The source refused the key.' : res.status === 404 ? 'The source says that doesn’t exist.' : res.status === 429 ? 'The source says it’s had too many requests; try again later.' : `The source answered ${res.status}.`, res.status);
    const type = (res.headers.get('content-type') ?? '').toLowerCase();
    const kind = /json/.test(type) ? 'json' : /csv/.test(type) ? 'csv' : null;
    if (!kind) throw new FetchProblem('The source didn’t send JSON or CSV.');
    if (Number(res.headers.get('content-length')) > max) throw new FetchProblem('The answer was larger than 1 MB.');
    const reader = res.body?.getReader();
    const parts: Uint8Array[] = [];
    let size = 0;
    if (reader) for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > max) { await reader.cancel().catch(() => undefined); throw new FetchProblem('The answer was larger than 1 MB.'); }
      parts.push(value);
    }
    const buf = new Uint8Array(size); let o = 0;
    for (const p of parts) { buf.set(p, o); o += p.length; }
    return { body: new TextDecoder().decode(buf), kind, status: res.status, ms: Date.now() - t0 };
  }
}
