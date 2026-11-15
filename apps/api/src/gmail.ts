// Gmail's batch endpoint: many API reads in one request, which keeps a 50-message inbox to two requests.
/** Several Gmail API reads in one request (Gmail's batch endpoint): one answer per path, null where one failed. */
export async function gmailBatch(token: string, paths: string[]): Promise<any[]> {
  if (!paths.length) return [];
  const boundary = 'niko_' + crypto.randomUUID().replace(/-/g, '');
  const body = paths.map((p, i) => `--${boundary}\r\nContent-Type: application/http\r\nContent-ID: <i${i}>\r\n\r\nGET ${p}\r\n\r\n`).join('') + `--${boundary}--`;
  const res = await fetch('https://gmail.googleapis.com/batch/gmail/v1', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': `multipart/mixed; boundary=${boundary}` }, body });
  if (!res.ok) throw new Error(`Gmail answered ${res.status}`);
  const theirs = /boundary="?([^";]+)"?/i.exec(res.headers.get('content-type') ?? '')?.[1];
  if (!theirs) return paths.map(() => null);
  const out: any[] = paths.map(() => null);
  for (const part of (await res.text()).split(`--${theirs}`)) {
    const n = /Content-ID:\s*<response-i(\d+)>/i.exec(part)?.[1];
    const json = part.slice(part.indexOf('{'), part.lastIndexOf('}') + 1);
    if (n === undefined || !json || !/HTTP\/1\.1 200/.test(part)) continue;
    try { out[Number(n)] = JSON.parse(json); } catch { /* left empty */ }
  }
  return out;
}

