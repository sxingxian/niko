// Niko's brains: Workers AI, the user's own model server, and any number of the user's AI keys, tried in the order
// set on the Engine screen. When one reaches its usage limit, refuses its key or stops answering, it is set to rest
// for a while and the next one answers; it is tried again once its rest is over.
import { and, eq } from 'drizzle-orm';
import { connections, users, type Db } from '@niko/db';
import { aiProviderOf, brainOrder, MAX_AI_KEYS, NOT_CHAT, WORKERS_MODELS, type AiKeyInfo, type BrainEntry, type BrainRest, type EnginePrefs } from '@niko/shared';
import type { Env } from './env';
import { seal } from './lib/crypto';
import { credentials, publicHttpsUrl } from './providers';

export type Msg = { role: string; content: string };
interface AiKey extends AiKeyInfo { apiKey: string }

/** Why a brain did not answer, sorted into what to do about it. */
export class BrainFail extends Error {
  /** `detail`: the provider's own short message, with anything like a key removed. Shown only to the key's owner on Test. */
  constructor(message: string, readonly why: BrainRest['why'], readonly restMs: number, readonly detail = '') { super(message); }
}

/** The provider's error message, short, with anything that looks like a key or token removed. */
export function providerMessage(body: string): string {
  let m = '';
  try { const j = JSON.parse(body); m = String(j?.error?.message ?? j?.error ?? j?.message ?? j?.detail ?? ''); } catch { m = body; }
  if (typeof m !== 'string') m = '';
  return m.replace(/<[^>]*>/g, ' ')
    .replace(/\b(sk|gsk|xai|pk|rk|AIza)[-_A-Za-z0-9*]{6,}/g, '[key]')
    .replace(/[A-Za-z0-9_\-*]{32,}/g, '[key]')
    .replace(/\s+/g, ' ').trim().slice(0, 220);
}

export { NOT_CHAT } from '@niko/shared';
const MIN = 60_000, HOUR = 60 * MIN;
const nextUtcMidnight = (now: number) => { const d = new Date(now); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) - now + 30_000; };

/** Sorts a provider's error answer: usage limits, refused keys, or a passing fault. The text is only matched, never shown. */
function classify(status: number, body: string, retryAfter: string | null): BrainFail {
  const text = body.toLowerCase();
  const quota = /insufficient_quota|quota|billing|credit balance|credits|exceeded your|resource_exhausted|payment|spend limit|usage limit/.test(text);
  const after = Number(retryAfter);
  const wait = Number.isFinite(after) && after > 0 ? Math.min(Math.max(after * 1000, 15_000), HOUR) : 0;
  const detail = providerMessage(body);
  if (status === 402 || (quota && (status === 429 || status === 403 || status === 400))) return new BrainFail(`limit ${status}`, 'limit', wait || HOUR, detail);
  if (status === 429) return new BrainFail(`rate ${status}`, 'limit', wait || MIN, detail);
  if (status === 401 || status === 403) return new BrainFail(`refused ${status}`, 'refused', 6 * HOUR, detail);
  // A wrong model name, or a model that can't chat, is a setting to fix rather than a passing fault.
  if (status === 400 || status === 404 || status === 422) return new BrainFail(`rejected ${status}`, 'refused', 30 * MIN, detail);
  return new BrainFail(`down ${status}`, 'down', wait || MIN, detail);
}

/** Workers AI models to try, in order. Cloudflare retires models from time to time; with more than one listed,
 * a retirement or outage of the first falls through instead of breaking Niko.
 * fast  = AI_MODEL (comma-separated, set in wrangler.jsonc), else the shared default.
 * large = the larger model first, then the fast list as a fallback. */
function aiModels(env: Env, size: 'fast' | 'large'): string[] {
  const list = (v: string) => v.split(',').map((m) => m.trim()).filter(Boolean);
  const fast = list(String(env.AI_MODEL ?? '')).length ? list(String(env.AI_MODEL)) : list(WORKERS_MODELS.fast);
  return [...new Set(size === 'large' ? [...list(WORKERS_MODELS.large), ...fast] : fast)];
}

/** The text from a Workers AI answer: most models return `response`; OpenAI-style ones return `choices`. */
function aiText(out: any): string {
  const r = out?.response ?? out?.choices?.[0]?.message?.content ?? out?.result?.response ?? '';
  return (typeof r === 'string' ? r : JSON.stringify(r)).trim();
}

export async function workersAi(env: Env, msgs: Msg[], size: 'fast' | 'large' = 'fast'): Promise<string> {
  let last: unknown = new Error('No Workers AI model is configured.');
  for (const model of aiModels(env, size === 'large' ? 'large' : 'fast')) {
    try {
      const text = aiText(await env.AI.run(model as any, { messages: msgs, max_tokens: 400 } as any));
      if (text) return text;
      last = new Error('empty answer');
    } catch (e) {
      last = e;
      // The free daily allowance is shared by every model on the account, so the other models will not answer either.
      if (/4006|daily free allocation|neurons/i.test(String((e as Error)?.message ?? e))) {
        throw new BrainFail('workers-ai daily allowance used', 'limit', nextUtcMidnight(Date.now()));
      }
    }
    console.warn(`workers-ai: ${model} failed: ${String((last as Error)?.message ?? last).slice(0, 300)}`);
  }
  throw new BrainFail(String((last as Error)?.message ?? last).slice(0, 200), 'down', MIN);
}

/** Calls an OpenAI-compatible, Anthropic or Google endpoint with one saved key. */
export async function customAi(secret: { baseUrl?: string; apiKey?: string; model?: string }, msgs: Msg[]): Promise<string> {
  const base = publicHttpsUrl(secret.baseUrl);
  if (!base) throw new BrainFail('address not valid', 'refused', 6 * HOUR);
  const root = base.toString().replace(/\/+$/, '');
  const anthropic = base.hostname.endsWith('anthropic.com');
  let res: Response;
  try {
    res = anthropic
      ? await fetch(`${root.replace(/\/v1$/, '')}/v1/messages`, {
        method: 'POST', signal: AbortSignal.timeout(30_000),
        headers: { 'x-api-key': secret.apiKey ?? '', 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({ model: secret.model, max_tokens: 400, system: msgs[0]!.content, messages: msgs.slice(1) }),
      })
      : await fetch(`${root}/chat/completions`, {
        method: 'POST', signal: AbortSignal.timeout(30_000),
        headers: { ...(secret.apiKey ? { authorization: `Bearer ${secret.apiKey}` } : {}), 'content-type': 'application/json' },
        body: JSON.stringify({ ...(secret.model ? { model: secret.model } : {}), max_tokens: 400, messages: msgs }),
      });
  } catch (e) {
    const timeout = (e as Error)?.name === 'TimeoutError';
    throw new BrainFail(`unreachable: ${String((e as Error)?.message ?? e).slice(0, 120)}`, 'down', MIN, timeout ? 'It took longer than 30 seconds to answer.' : 'Its address could not be reached.');
  }
  if (!res.ok) throw classify(res.status, (await res.text().catch(() => '')).slice(0, 2000), res.headers.get('retry-after'));
  const j: any = await res.json().catch(() => null);
  const text = String((anthropic ? j?.content?.[0]?.text : j?.choices?.[0]?.message?.content) ?? '').trim();
  if (!text) throw new BrainFail('empty answer', 'down', MIN, 'It answered with nothing. Check that the model is a chat model.');
  return text;
}

/** The chat models a key can use, from the provider's own list (safety, speech and embedding models left out). */
export async function listModels(secret: { baseUrl?: string; apiKey?: string }): Promise<string[]> {
  const base = publicHttpsUrl(secret.baseUrl);
  if (!base) throw new BrainFail('address not valid', 'refused', 0, 'The base URL must be a public https address.');
  const root = base.toString().replace(/\/+$/, '');
  const anthropic = base.hostname.endsWith('anthropic.com');
  let res: Response;
  try {
    res = await fetch(anthropic ? `${root.replace(/\/v1$/, '')}/v1/models?limit=100` : `${root}/models`, {
      signal: AbortSignal.timeout(15_000),
      headers: anthropic ? { 'x-api-key': secret.apiKey ?? '', 'anthropic-version': '2023-06-01' } : { ...(secret.apiKey ? { authorization: `Bearer ${secret.apiKey}` } : {}) },
    });
  } catch { throw new BrainFail('unreachable', 'down', 0, 'Its address could not be reached.'); }
  if (!res.ok) throw classify(res.status, (await res.text().catch(() => '')).slice(0, 2000), null);
  const j: any = await res.json().catch(() => null);
  const ids: string[] = (Array.isArray(j?.data) ? j.data : Array.isArray(j?.models) ? j.models : [])
    .map((m: any) => String(m?.id ?? m?.name ?? '').replace(/^models\//, ''))
    .filter((id: string) => id && id.length <= 200 && !NOT_CHAT.test(id));
  return [...new Set(ids)].sort().slice(0, 300);
}

// ---------------------------------------------------------------- the saved keys
// All of an account's AI keys live in one encrypted record (the "custom-ai" connection). A record saved before
// there could be several holds one key at its top level; it is read as key "k1".
const PROVIDER_NAMES: Record<AiKeyInfo['provider'], string> = { openai: 'OpenAI-compatible', anthropic: 'Anthropic', google: 'Google' };
export const defaultLabel = (k: { baseUrl: string; model: string }) => {
  const p = aiProviderOf(k.baseUrl);
  let host = '';
  try { host = new URL(k.baseUrl).hostname.replace(/^api\./, ''); } catch { /* shown as the provider */ }
  const known: Record<string, string> = { 'openai.com': 'OpenAI', 'groq.com': 'Groq', 'openrouter.ai': 'OpenRouter', 'mistral.ai': 'Mistral', 'deepseek.com': 'DeepSeek', 'together.xyz': 'Together AI', 'x.ai': 'xAI' };
  return p === 'openai' ? (known[host] ?? (host || PROVIDER_NAMES.openai)) : PROVIDER_NAMES[p];
};

export async function loadKeys(env: Env, db: Db, userId: string): Promise<AiKey[]> {
  const s = (await credentials(env, db, userId, 'custom-ai').catch(() => null)) as any;
  if (!s) return [];
  const raw: any[] = Array.isArray(s.keys) ? s.keys : s.apiKey ? [{ id: 'k1', baseUrl: s.baseUrl, apiKey: s.apiKey, model: s.model }] : [];
  return raw.filter((k) => k && typeof k.id === 'string' && typeof k.apiKey === 'string').slice(0, MAX_AI_KEYS).map((k) => ({
    id: k.id, apiKey: k.apiKey, baseUrl: String(k.baseUrl ?? ''), model: String(k.model ?? ''),
    provider: aiProviderOf(k.baseUrl), label: String(k.label ?? '') || defaultLabel({ baseUrl: String(k.baseUrl ?? ''), model: String(k.model ?? '') }),
  }));
}

export async function saveKeys(env: Env, db: Db, userId: string, keys: AiKey[]): Promise<void> {
  await db.delete(connections).where(and(eq(connections.userId, userId), eq(connections.provider, 'custom-ai')));
  if (!keys.length) return;
  const secret = { keys: keys.map(({ id, label, baseUrl, model, apiKey }) => ({ id, label, baseUrl, model, apiKey })) };
  await db.insert(connections).values({ id: crypto.randomUUID(), userId, provider: 'custom-ai', secretEnc: await seal(env.ENCRYPTION_KEY, secret), meta: { label: `${keys.length} key${keys.length === 1 ? '' : 's'}` } });
}

export const keyInfo = (k: AiKey): AiKeyInfo => ({ id: k.id, label: k.label, provider: k.provider, baseUrl: k.baseUrl, model: k.model });

// ---------------------------------------------------------------- running a brain, and the order
async function runEntry(env: Env, db: Db, userId: string, entry: BrainEntry, size: EnginePrefs['model'], msgs: Msg[], keys: () => Promise<AiKey[]>): Promise<string> {
  if (entry === 'workers-ai') return workersAi(env, msgs, size === 'large' ? 'large' : 'fast');
  if (entry === 'self-hosted-ai') {
    const s = await credentials(env, db, userId, 'self-hosted-ai');
    if (!s) throw new BrainFail('no server address saved', 'refused', 6 * HOUR);
    return customAi(s as any, msgs);
  }
  const k = (await keys()).find((x) => `key:${x.id}` === entry);
  if (!k) throw new BrainFail('key not found', 'refused', 6 * HOUR);
  return customAi(k, msgs);
}

/** Tries one brain on its own (the Engine screen's Test button). A success ends its rest. */
export async function testEntry(env: Env, db: Db, user: { id: string; engine: unknown }, entry: BrainEntry, size: EnginePrefs['model']): Promise<number> {
  const t0 = Date.now();
  await runEntry(env, db, user.id, entry, size, [{ role: 'system', content: 'Reply with the single word: ready' }, { role: 'user', content: 'Are you there?' }], () => loadKeys(env, db, user.id));
  const engine = (user.engine ?? {}) as EnginePrefs;
  if (engine.rest?.[entry]) { const rest = { ...engine.rest }; delete rest[entry]; await db.update(users).set({ engine: { ...engine, rest } as any }).where(eq(users.id, user.id)); }
  return Date.now() - t0;
}

/**
 * Answers with the first brain in the order that works. Brains that are resting are skipped while any other is
 * available, and tried last otherwise (a limit may have reset early). Each failure sets that brain's rest; an
 * answer ends it. Returns the reply and which brain gave it.
 */
export async function think(env: Env, db: Db, user: { id: string; engine: unknown }, msgs: Msg[]): Promise<{ reply: string; used: BrainEntry; first: BrainEntry }> {
  const engine = (user.engine ?? {}) as EnginePrefs;
  const order = brainOrder(engine);
  if (!order.length) order.push('workers-ai');
  const now = Date.now();
  const rest: Record<string, BrainRest> = {};
  for (const [k, v] of Object.entries(engine.rest ?? {})) if (v && v.until > now && order.includes(k as BrainEntry)) rest[k] = v;
  const ready = order.filter((b) => !rest[b]);
  const resting = order.filter((b) => rest[b]).sort((a, b) => rest[a]!.until - rest[b]!.until);
  let keyList: Promise<AiKey[]> | null = null;
  const keys = () => (keyList ??= loadKeys(env, db, user.id));
  let changed = Object.keys(rest).length !== Object.keys(engine.rest ?? {}).length;
  let last: unknown = null;
  try {
    for (const entry of [...ready, ...resting]) {
      try {
        const reply = await runEntry(env, db, user.id, entry, engine.model, msgs, keys);
        if (rest[entry]) { delete rest[entry]; changed = true; }
        return { reply, used: entry, first: order[0]! };
      } catch (e) {
        last = e;
        const f = e instanceof BrainFail ? e : new BrainFail(String((e as Error)?.message ?? e).slice(0, 200), 'down', MIN);
        rest[entry] = { until: Date.now() + f.restMs, why: f.why };
        changed = true;
        // The provider's own error text stays in the Worker log: it can name internal models, accounts or limits.
        console.warn(`brain ${entry} failed (${f.why}): ${f.message.slice(0, 200)}`);
      }
    }
    throw last ?? new Error('No brain answered.');
  } finally {
    if (changed) await db.update(users).set({ engine: { ...engine, rest } as any }).where(eq(users.id, user.id)).catch(() => undefined);
  }
}

