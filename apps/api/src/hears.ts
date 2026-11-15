// Speech in: turning a recorded request (16 kHz mono WAV from the app) into text. Cloudflare's Whisper is built in;
// any number of the user's own speech-to-text keys can come before or after it. Like the brains and voices, one that
// reaches its limit, refuses its key or doesn't answer rests for a while and the next one is used. The device's own
// recognition, in the browser, is always the last resort.
import { and, eq } from 'drizzle-orm';
import { connections, users, type Db } from '@niko/db';
import { hearOrder, MAX_HEAR_KEYS, type BrainRest, type EnginePrefs, type HearKeyInfo, type HearProvider, type HearSource } from '@niko/shared';
import type { Env } from './env';
import { BrainFail, providerMessage } from './brains';
import { seal } from './lib/crypto';
import { credentials, publicHttpsUrl } from './providers';
import { AZURE_REGION } from './voices';

export interface HearKey extends HearKeyInfo { apiKey: string }
export const MAX_AUDIO_BYTES = 2 * 1024 * 1024; // about a minute of 16 kHz speech
const MIN = 60_000, HOUR = 60 * MIN;
export const HEAR_PROVIDERS_LIST: HearProvider[] = ['openai', 'deepgram', 'elevenlabs', 'fishaudio', 'google', 'azure'];
const SAFE_MODEL = /^[A-Za-z0-9._:\-/]{1,80}$/;

// ---------------------------------------------------------------- the saved keys
export async function loadHearKeys(env: Env, db: Db, userId: string): Promise<HearKey[]> {
  const s = (await credentials(env, db, userId, 'hear-keys').catch(() => null)) as any;
  return (Array.isArray(s?.keys) ? s.keys : []).filter((k: any) => k && typeof k.id === 'string' && typeof k.apiKey === 'string' && HEAR_PROVIDERS_LIST.includes(k.provider)).slice(0, MAX_HEAR_KEYS).map((k: any) => ({
    id: k.id, apiKey: k.apiKey, provider: k.provider, label: String(k.label ?? '') || defaultHearLabel(k), model: String(k.model ?? ''), baseUrl: String(k.baseUrl ?? ''), region: String(k.region ?? ''),
  }));
}
export async function saveHearKeys(env: Env, db: Db, userId: string, keys: HearKey[]): Promise<void> {
  await db.delete(connections).where(and(eq(connections.userId, userId), eq(connections.provider, 'hear-keys')));
  if (!keys.length) return;
  const secret = { keys: keys.map(({ id, label, provider, model, baseUrl, region, apiKey }) => ({ id, label, provider, model, baseUrl, region, apiKey })) };
  await db.insert(connections).values({ id: crypto.randomUUID(), userId, provider: 'hear-keys', secretEnc: await seal(env.ENCRYPTION_KEY, secret), meta: { label: `${keys.length} speech-in key${keys.length === 1 ? '' : 's'}` } });
}
export const hearKeyInfo = (k: HearKey): HearKeyInfo => ({ id: k.id, label: k.label, provider: k.provider, model: k.model, baseUrl: k.baseUrl, region: k.region });
export function defaultHearLabel(k: { provider: HearProvider; baseUrl: string }): string {
  if (k.provider !== 'openai') return { deepgram: 'Deepgram', elevenlabs: 'ElevenLabs', fishaudio: 'Fish Audio', google: 'Google Cloud', azure: 'Microsoft Azure' }[k.provider];
  try { const h = new URL(k.baseUrl).hostname.replace(/^api\./, ''); return h === 'openai.com' ? 'OpenAI' : h === 'groq.com' ? 'Groq' : h; } catch { return 'OpenAI-compatible'; }
}
export function hearKeyProblem(k: Pick<HearKey, 'provider' | 'model' | 'baseUrl' | 'region'>): string | null {
  if (!HEAR_PROVIDERS_LIST.includes(k.provider)) return 'Choose a speech-to-text service.';
  if (k.provider === 'openai' && !publicHttpsUrl(k.baseUrl)) return 'The base URL must be a public https address.';
  if (k.provider === 'azure' && !AZURE_REGION.test(k.region)) return 'Add the region of your Azure Speech resource, such as eastus or southeastasia.';
  if (k.model && !SAFE_MODEL.test(k.model)) return 'That model name has characters a model name can’t have.';
  return null;
}

// ---------------------------------------------------------------- transcribing
async function fail(res: Response): Promise<BrainFail> {
  const body = (await res.text().catch(() => '')).slice(0, 2000), text = body.toLowerCase(), detail = providerMessage(body);
  const after = Number(res.headers.get('retry-after'));
  const wait = Number.isFinite(after) && after > 0 ? Math.min(Math.max(after * 1000, 15_000), HOUR) : 0;
  const quota = /quota|credit|limit|billing|insufficient|exceeded|payment/.test(text);
  if (/detected_unusual_activity|unusual activity|free tier usage disabled/.test(text)) return new BrainFail('elevenlabs free plan', 'refused', 6 * HOUR, 'ElevenLabs’ free plan refuses requests from cloud servers such as Niko’s; a paid plan works.');
  if (res.status === 402 || (quota && [400, 403, 429].includes(res.status))) return new BrainFail(`limit ${res.status}`, 'limit', wait || HOUR, detail);
  if (res.status === 429) return new BrainFail(`rate ${res.status}`, 'limit', wait || MIN, detail);
  if (res.status === 401 || res.status === 403) return new BrainFail(`refused ${res.status}`, 'refused', 6 * HOUR, detail);
  if (res.status === 400 || res.status === 404 || res.status === 422) return new BrainFail(`rejected ${res.status}`, 'refused', 30 * MIN, detail);
  return new BrainFail(`down ${res.status}`, 'down', wait || MIN, detail);
}
async function call(url: string, init: RequestInit): Promise<any> {
  let res: Response;
  try { res = await fetch(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(20_000) }); }
  catch (e) { throw new BrainFail('unreachable', 'down', MIN, (e as Error)?.name === 'TimeoutError' ? 'It took longer than 20 seconds to answer.' : 'Its address could not be reached.'); }
  if (res.status >= 300 && res.status < 400) throw new BrainFail('redirect', 'refused', 30 * MIN, 'It tried to redirect the request. Use its final https address.');
  if (!res.ok) throw await fail(res);
  return res.json().catch(() => { throw new BrainFail('not json', 'down', MIN, 'It answered with something other than text.'); });
}
const b64 = (u8: Uint8Array) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000)); return btoa(s); };
const wavFile = (audio: Uint8Array) => new File([audio], 'speech.wav', { type: 'audio/wav' });

/** Cloudflare's Whisper, on Niko's own account (shares the free daily allowance with the brain and voice). */
export async function workersStt(env: Env, audio: Uint8Array, lang: string): Promise<string> {
  let msg = '';
  try {
    const out: any = await env.AI.run('@cf/openai/whisper-large-v3-turbo' as any, { audio: b64(audio), ...(lang ? { language: lang } : {}) } as any);
    const text = String(out?.text ?? '').trim();
    if (text || out) return text;
  } catch (e) { msg = String((e as Error)?.message ?? e); }
  if (/4006|daily free allocation|neurons/i.test(msg)) {
    const d = new Date(); const midnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) + 30_000;
    throw new BrainFail('workers daily allowance', 'limit', midnight - Date.now(), 'Cloudflare’s free allowance for today is used up; it resets at midnight UTC.');
  }
  throw new BrainFail(`workers stt: ${msg.slice(0, 120)}`, 'down', MIN, 'Cloudflare’s speech recognition did not answer just now.');
}

/** One request through one key. `lang` is like "en" or "en-SG"; each service gets the form it wants. */
export async function transcribeWithKey(k: HearKey, audio: Uint8Array, lang: string): Promise<string> {
  const problem = hearKeyProblem(k);
  if (problem) throw new BrainFail('settings', 'refused', 30 * MIN, problem);
  const short = lang.split('-')[0]!.toLowerCase(), full = lang.includes('-') ? lang : lang ? `${lang}-${lang.toUpperCase()}` : 'en-US';
  if (k.provider === 'openai') {
    const root = publicHttpsUrl(k.baseUrl)!.toString().replace(/\/+$/, '');
    const form = new FormData();
    form.set('file', wavFile(audio)); form.set('model', k.model || 'gpt-4o-mini-transcribe'); if (short) form.set('language', short);
    return String((await call(`${root}/audio/transcriptions`, { method: 'POST', headers: { authorization: `Bearer ${k.apiKey}` }, body: form }))?.text ?? '').trim();
  }
  if (k.provider === 'deepgram') {
    const j = await call(`https://api.deepgram.com/v1/listen?model=${encodeURIComponent(k.model || 'nova-3')}&smart_format=true${short ? `&language=${encodeURIComponent(short)}` : ''}`, {
      method: 'POST', headers: { authorization: `Token ${k.apiKey}`, 'content-type': 'audio/wav' }, body: audio });
    return String(j?.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? '').trim();
  }
  if (k.provider === 'elevenlabs') {
    const form = new FormData();
    form.set('file', wavFile(audio)); form.set('model_id', k.model || 'scribe_v1'); if (short) form.set('language_code', short);
    return String((await call('https://api.elevenlabs.io/v1/speech-to-text', { method: 'POST', headers: { 'xi-api-key': k.apiKey }, body: form }))?.text ?? '').trim();
  }
  if (k.provider === 'fishaudio') {
    const form = new FormData();
    form.set('audio', wavFile(audio)); if (short) form.set('language', short); form.set('ignore_timestamps', 'true');
    return String((await call('https://api.fish.audio/v1/asr', { method: 'POST', headers: { authorization: `Bearer ${k.apiKey}` }, body: form }))?.text ?? '').trim();
  }
  if (k.provider === 'google') {
    const j = await call(`https://speech.googleapis.com/v1/speech:recognize?key=${encodeURIComponent(k.apiKey)}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ config: { encoding: 'LINEAR16', sampleRateHertz: 16000, languageCode: full, model: k.model || 'latest_short', enableAutomaticPunctuation: true }, audio: { content: b64(audio) } }) });
    return (j?.results ?? []).map((r: any) => r?.alternatives?.[0]?.transcript ?? '').join(' ').trim();
  }
  const j = await call(`https://${k.region}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?language=${encodeURIComponent(full)}&format=simple`, {
    method: 'POST', headers: { 'ocp-apim-subscription-key': k.apiKey, 'content-type': 'audio/wav; codecs=audio/pcm; samplerate=16000', accept: 'application/json' }, body: audio });
  if (j?.RecognitionStatus && j.RecognitionStatus !== 'Success' && j.RecognitionStatus !== 'NoMatch') throw new BrainFail(`azure ${j.RecognitionStatus}`, 'down', MIN, `Azure said: ${j.RecognitionStatus}.`);
  return String(j?.DisplayText ?? '').trim();
}

/** Checks the upload is a WAV file of sensible size. */
export function audioProblem(audio: Uint8Array): string | null {
  if (audio.length < 1000) return 'Nothing was recorded.';
  if (audio.length > MAX_AUDIO_BYTES) return 'That recording is too long.';
  const tag = String.fromCharCode(...audio.subarray(0, 4)) + String.fromCharCode(...audio.subarray(8, 12));
  return tag === 'RIFFWAVE' ? null : 'The recording was not in the expected format.';
}

/**
 * Turns speech into text with the first service in the order that works. Services that are resting are tried last.
 * Each failure sets a rest; an answer ends it. `only` tries one service (the Voice screen's Test).
 */
export async function hear(env: Env, db: Db, user: { id: string; engine: unknown }, audio: Uint8Array, lang: string, only?: { entry: HearSource; key?: HearKey }): Promise<{ text: string; used: HearSource }> {
  const engine = (user.engine ?? {}) as EnginePrefs;
  const order = only ? [only.entry] : hearOrder(engine);
  if (!order.length) throw new BrainFail('no services', 'down', 0, 'No speech-in service is switched on.');
  const now = Date.now();
  const rest: Record<string, BrainRest> = {};
  for (const [k, v] of Object.entries(engine.hearRest ?? {})) if (v && v.until > now) rest[k] = v;
  const ready = order.filter((s) => !rest[s]), resting = order.filter((s) => rest[s]).sort((a, b) => rest[a]!.until - rest[b]!.until);
  let keys: HearKey[] | null = null;
  let changed = Object.keys(rest).length !== Object.keys(engine.hearRest ?? {}).length, last: unknown = null;
  try {
    for (const entry of [...ready, ...resting]) {
      try {
        let text: string;
        if (entry === 'workers') text = await workersStt(env, audio, lang.split('-')[0]!.toLowerCase());
        else {
          const k = only?.key ?? (keys ??= await loadHearKeys(env, db, user.id)).find((x) => `skey:${x.id}` === entry);
          if (!k) throw new BrainFail('key not found', 'refused', 6 * HOUR, 'That key is no longer saved.');
          text = await transcribeWithKey(k, audio, lang);
        }
        if (!only && rest[entry]) { delete rest[entry]; changed = true; }
        return { text, used: entry };
      } catch (e) {
        last = e;
        const f = e instanceof BrainFail ? e : new BrainFail(String((e as Error)?.message ?? e).slice(0, 200), 'down', MIN);
        console.warn(`hear ${entry} failed (${f.why}): ${f.message.slice(0, 200)}`);
        if (!only?.key) { rest[entry] = { until: Date.now() + f.restMs, why: f.why }; changed = true; }
      }
    }
    throw last ?? new Error('Nothing could hear that.');
  } finally {
    if (changed && !only?.key) await db.update(users).set({ engine: { ...engine, hearRest: rest } as any }).where(eq(users.id, user.id)).catch(() => undefined);
  }
}
