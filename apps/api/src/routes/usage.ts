// /api/usage: this month's use for the person's Engine and Voice pages. Niko's own count covers every service; for
// own keys at services that let an app ask (ElevenLabs, OpenRouter), what the service itself reports is added. The key
// goes only to that service, at most every five minutes, and only when the person opens the page.
import { Hono } from 'hono';
import { aiAllowed, brainOption, imageOption, mapsOn, voiceOption, hearOption, USAGE_KINDS, type UsageInfo, type UsageKind } from '@niko/shared';
import type { AppEnv } from '../env';
import { offFor } from '../access';
import { accountLimitsFor } from '../limits';
import { loadKeys } from '../brains';
import { loadVoiceKeys } from '../voices';
import { loadHearKeys } from '../hears';
import { loadImageKeys } from '../images';
import { loadMapKeys } from '../maps';
import { providedFor, providedMode } from '../provided';
import { monthOf, monthUsage, resetText } from '../usage';

export const usage = new Hono<AppEnv>();

type Report = UsageInfo['reports'][string];
const cache = new Map<string, { at: number; r: Report | null }>();
const money = (n: number) => `$${n.toFixed(2)}`;

async function ask(url: string, headers: Record<string, string>): Promise<any> {
  const res = await fetch(url, { headers, redirect: 'manual', signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`status ${res.status}`);
  return res.json();
}
/** ElevenLabs: characters used and allowed this billing period. */
async function elevenReport(apiKey: string): Promise<Report> {
  const j = await ask('https://api.elevenlabs.io/v1/user/subscription', { 'xi-api-key': apiKey });
  const used = Number(j?.character_count) || 0, limit = Number(j?.character_limit) || 0;
  const reset = Number(j?.next_character_count_reset_unix);
  const when = reset ? new Date(reset * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }) : '';
  return { service: 'ElevenLabs', head: `ElevenLabs says: ${used.toLocaleString('en')}${limit ? ` of ${limit.toLocaleString('en')}` : ''} characters`, sub: `This billing period${when ? ` · resets ${when}` : ''} · includes use outside Niko`, ...(limit ? { pct: Math.min(100, Math.round((used / limit) * 100)) } : {}), at: Date.now() };
}
/** OpenRouter: credits used this month, and what is left on the key. */
async function openRouterReport(apiKey: string): Promise<Report> {
  const j = (await ask('https://openrouter.ai/api/v1/key', { authorization: `Bearer ${apiKey}` }))?.data ?? {};
  const month = Number(j.usage_monthly) || 0, limit = typeof j.limit === 'number' ? j.limit : null, left = typeof j.limit_remaining === 'number' ? j.limit_remaining : null;
  const per = j.limit_reset ? ` ${j.limit_reset}` : '';
  return { service: 'OpenRouter', head: `OpenRouter says: ${money(month)} used this month`, sub: limit !== null && left !== null ? `${money(left)} left of this key’s ${money(limit)}${per} limit · includes use outside Niko` : 'No spending limit on this key · includes use outside Niko', ...(limit ? { pct: Math.min(100, Math.round(((limit - (left ?? limit)) / limit) * 100)) } : {}), at: Date.now() };
}
const hostOf = (u: string) => { try { return new URL(u).hostname.toLowerCase(); } catch { return ''; } };

async function reportsFor(c: import('hono').Context<AppEnv>): Promise<UsageInfo['reports']> {
  const u = c.get('user'), db = c.get('db');
  const jobs: { entry: string; cacheKey: string; run: () => Promise<Report> }[] = [];
  for (const k of await loadVoiceKeys(c.env, db, u.id)) if (k.provider === 'elevenlabs') jobs.push({ entry: `vkey:${k.id}`, cacheKey: `${u.id}|vkey:${k.id}|${k.apiKey.slice(-6)}`, run: () => elevenReport(k.apiKey) });
  for (const k of await loadKeys(c.env, db, u.id)) if (hostOf(k.baseUrl) === 'openrouter.ai') jobs.push({ entry: `key:${k.id}`, cacheKey: `${u.id}|key:${k.id}|${k.apiKey.slice(-6)}`, run: () => openRouterReport(k.apiKey) });
  const out: UsageInfo['reports'] = {};
  await Promise.all(jobs.slice(0, 8).map(async (j) => {
    const hit = cache.get(j.cacheKey);
    if (hit && Date.now() - hit.at < 5 * 60_000) { if (hit.r) out[j.entry] = hit.r; return; }
    const r = await j.run().catch(() => null);
    if (cache.size > 500) cache.delete(cache.keys().next().value!);
    cache.set(j.cacheKey, { at: Date.now(), r });
    if (r) out[j.entry] = r;
  }));
  return out;
}

usage.get('/', async (c) => {
  const u = c.get('user'), db = c.get('db');
  const [limits, used, off] = await Promise.all([accountLimitsFor(db, u), monthUsage(db, u.id), offFor(db, u)]);
  const provided: Partial<Record<UsageKind, string[]>> = {};
  for (const k of USAGE_KINDS) {
    const list = await providedFor<{ label?: string }>(c.env, db, u, k);
    if (list.length) provided[k] = list.map((x) => x.label);
  }
  const [bk, vk, hk, ik, mk] = await Promise.all([loadKeys(c.env, db, u.id), loadVoiceKeys(c.env, db, u.id), loadHearKeys(c.env, db, u.id), loadImageKeys(c.env, db, u.id), loadMapKeys(c.env, db, u.id)]);
  const names = (prefix: string, l: { id: string; label?: string; provider?: string }[]) => l.map((k) => ({ entry: prefix + k.id, label: String(k.label || k.provider || 'Key') }));
  const info: UsageInfo = {
    month: monthOf(), resets: resetText(),
    kinds: Object.fromEntries(USAGE_KINDS.map((k) => [k, { limit: limits[k], included: used.kinds[k].included, own: used.kinds[k].own }])) as UsageInfo['kinds'],
    entries: used.entries,
    plan: {
      order: providedMode(u), provided,
      builtins: { brain: aiAllowed(off, brainOption('workers-ai')), voice: aiAllowed(off, voiceOption('workers')), hear: aiAllowed(off, hearOption('workers')), image: aiAllowed(off, imageOption('workers')), map: mapsOn(off) && aiAllowed(off, 'map:osm') },
    },
    reports: c.req.query('reports') === '0' ? {} : await reportsFor(c),
    own: { brain: names('key:', bk), voice: names('vkey:', vk), hear: names('skey:', hk), image: names('ikey:', ik), map: names('mkey:', mk) },
  };
  return c.json(info);
});
