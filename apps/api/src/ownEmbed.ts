// Search numbers from a person's own service (Settings · Knowledge): an embedding model on one of their own AI keys
// (OpenAI-style "embeddings" endpoint), or on their own model server (Ollama and others serve the same endpoint
// under /v1). Never the admin's included keys. One model per account; numbers from two models are never compared.
import type { Db } from '@niko/db';
import type { Env } from './env';
import { brainKeys } from './brains';
import { credentials, publicHttpsUrl } from './providers';
import { KnError } from './knowledge';

const BATCH = 32, MAX_DIMS = 4000;
export type Embedder = (texts: string[]) => Promise<number[][]>;

/** Their own services that can make search numbers: their AI keys that speak the OpenAI format, and their server. */
export async function ownSearchSources(env: Env, db: Db, user: { id: string; provided?: unknown }): Promise<{ ref: string; name: string; example: string }[]> {
  const keys = (await brainKeys(env, db, user).catch(() => [])).filter((k) => !(k as { provided?: boolean }).provided && (k.provider === 'openai' || k.provider === 'google'));
  const server = await credentials(env, db, user.id, 'self-hosted-ai').catch(() => null) as { baseUrl?: string } | null;
  return [
    ...keys.map((k) => ({ ref: `key:${k.id}`, name: k.label || new URL(k.baseUrl).hostname, example: /openai\.com/.test(k.baseUrl) ? 'text-embedding-3-small' : /googleapis/.test(k.baseUrl) ? 'gemini-embedding-001' : /mistral/.test(k.baseUrl) ? 'mistral-embed' : '' })),
    ...(server?.baseUrl ? [{ ref: 'self-hosted-ai', name: 'Your own model server', example: 'nomic-embed-text' }] : []),
  ];
}

/** Makes search numbers with their chosen service and model. Problems are said plainly; the key is never echoed. */
export async function ownEmbedder(env: Env, db: Db, user: { id: string; provided?: unknown }, own: { ref: string; model: string }): Promise<Embedder> {
  let baseUrl = '', apiKey = '';
  if (own.ref === 'self-hosted-ai') {
    const s = await credentials(env, db, user.id, 'self-hosted-ai') as { baseUrl?: string; apiKey?: string } | null;
    if (!s?.baseUrl) throw new KnError('Your own model server isn’t set up on the Engine page.', 400);
    baseUrl = s.baseUrl; apiKey = s.apiKey ?? '';
  } else {
    const k = (await brainKeys(env, db, user)).find((x) => `key:${x.id}` === own.ref && !(x as { provided?: boolean }).provided);
    if (!k) throw new KnError('That AI key isn’t on your Engine page any more.', 400);
    baseUrl = k.baseUrl; apiKey = k.apiKey;
  }
  // Same rule as answering: a public https address only, and the key never follows a redirect.
  const base = publicHttpsUrl(baseUrl);
  if (!base) throw new KnError('That service’s address isn’t a public https address.', 400);
  const url = `${base.toString().replace(/\/+$/, '')}/embeddings`;
  let dims = 0;
  return async (texts) => {
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += BATCH) {
      const batch = texts.slice(i, i + BATCH).map((t) => t.slice(0, 8000));
      let res: Response;
      try {
        res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) }, body: JSON.stringify({ model: own.model, input: batch }), redirect: 'error', signal: AbortSignal.timeout(20_000) });
      } catch { throw new KnError('Your search service didn’t answer in time. Try again in a moment.', 502); }
      if (res.status === 401 || res.status === 403) throw new KnError('Your search service refused the key.', 502);
      if (res.status === 404) throw new KnError(`Your search service doesn’t know the model “${own.model}”, or has no embeddings.`, 502);
      if (!res.ok) throw new KnError(`Your search service answered ${res.status}.`, 502);
      const j = await res.json().catch(() => null) as { data?: { embedding?: unknown; index?: number }[] } | null;
      const data = Array.isArray(j?.data) ? [...j!.data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0)) : [];
      if (data.length !== batch.length) throw new KnError('Your search service gave back search numbers that don’t match.', 502);
      for (const d of data) {
        const v = d.embedding;
        if (!Array.isArray(v) || !v.length || v.length > MAX_DIMS || !v.every((x) => typeof x === 'number' && Number.isFinite(x))) throw new KnError('Your search service gave back search numbers Niko can’t use.', 502);
        if (dims && v.length !== dims) throw new KnError('Your search service changed the size of its search numbers.', 502);
        dims = v.length;
        out.push(v as number[]);
      }
    }
    return out;
  };
}
