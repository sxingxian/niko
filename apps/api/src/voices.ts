// Voice API keys: any number of keys for OpenAI (or any OpenAI-compatible speech API), ElevenLabs, Google Cloud,
// Microsoft Azure, Deepgram and Cartesia, tried in the order set on the Voice screen. Like the brains, a voice that
// reaches its usage limit, refuses its key or stops answering rests for a while and the next one speaks.
import { and, eq } from 'drizzle-orm';
import { connections, users, type Db } from '@niko/db';
import { MAX_VOICE_KEYS, type BrainRest, type EnginePrefs, type VoiceKeyInfo, type VoiceProvider } from '@niko/shared';
import type { Env } from './env';
import { BrainFail, providerMessage } from './brains';
import { seal } from './lib/crypto';
import { credentials, publicHttpsUrl } from './providers';

export interface VoiceKey extends VoiceKeyInfo { apiKey: string }
export const TTS_MAX_BYTES = 8 * 1024 * 1024;
const MIN = 60_000, HOUR = 60 * MIN;
const PROVIDERS: VoiceProvider[] = ['openai', 'elevenlabs', 'google', 'azure', 'deepgram', 'cartesia'];
const CARTESIA_VERSION = '2026-03-01';
/** Names that go into a URL or SSML are kept to safe characters. */
const SAFE_VOICE = /^[A-Za-z0-9._:\-/ ()]{1,120}$/;
export const AZURE_REGION = /^[a-z0-9]{2,30}$/;

// ---------------------------------------------------------------- the saved keys
// All of an account's voice keys live in one encrypted record. An ElevenLabs key saved before there could be
// several (the "elevenlabs" connection) is read as key "el1" until the record is next saved.
export async function loadVoiceKeys(env: Env, db: Db, userId: string): Promise<VoiceKey[]> {
  const s = (await credentials(env, db, userId, 'voice-keys').catch(() => null)) as any;
  const keys: VoiceKey[] = (Array.isArray(s?.keys) ? s.keys : []).filter((k: any) => k && typeof k.id === 'string' && typeof k.apiKey === 'string' && PROVIDERS.includes(k.provider)).map((k: any) => ({
    id: k.id, apiKey: k.apiKey, provider: k.provider, label: String(k.label ?? ''), voice: String(k.voice ?? ''), model: String(k.model ?? ''), baseUrl: String(k.baseUrl ?? ''), region: String(k.region ?? ''),
  }));
  if (!s && !keys.some((k) => k.id === 'el1')) {
    const old = (await credentials(env, db, userId, 'elevenlabs').catch(() => null)) as any;
    if (old?.apiKey) keys.unshift({ id: 'el1', provider: 'elevenlabs', apiKey: old.apiKey, voice: String(old.voiceId ?? ''), model: '', baseUrl: '', region: '', label: 'ElevenLabs' });
  }
  return keys.slice(0, MAX_VOICE_KEYS).map((k) => ({ ...k, label: k.label || defaultVoiceLabel(k) }));
}

export async function saveVoiceKeys(env: Env, db: Db, userId: string, keys: VoiceKey[]): Promise<void> {
  // Saving moves an older ElevenLabs key into the record, so the old connection goes.
  await db.delete(connections).where(and(eq(connections.userId, userId), eq(connections.provider, 'voice-keys')));
  await db.delete(connections).where(and(eq(connections.userId, userId), eq(connections.provider, 'elevenlabs')));
  if (!keys.length) return;
  const secret = { keys: keys.map(({ id, label, provider, voice, model, baseUrl, region, apiKey }) => ({ id, label, provider, voice, model, baseUrl, region, apiKey })) };
  await db.insert(connections).values({ id: crypto.randomUUID(), userId, provider: 'voice-keys', secretEnc: await seal(env.ENCRYPTION_KEY, secret), meta: { label: `${keys.length} voice key${keys.length === 1 ? '' : 's'}` } });
}

export const voiceKeyInfo = (k: VoiceKey): VoiceKeyInfo => ({ id: k.id, label: k.label, provider: k.provider, voice: k.voice, model: k.model, baseUrl: k.baseUrl, region: k.region });
export function defaultVoiceLabel(k: { provider: VoiceProvider; baseUrl: string }): string {
  if (k.provider !== 'openai') return { elevenlabs: 'ElevenLabs', google: 'Google Cloud', azure: 'Microsoft Azure', deepgram: 'Deepgram', cartesia: 'Cartesia' }[k.provider];
  try { const h = new URL(k.baseUrl).hostname.replace(/^api\./, ''); return h === 'openai.com' ? 'OpenAI' : h === 'groq.com' ? 'Groq' : h; } catch { return 'OpenAI-compatible'; }
}

/** Checks a key's settings before it is saved or used. Returns a message for the person, or null. */
export function voiceKeyProblem(k: Pick<VoiceKey, 'provider' | 'voice' | 'baseUrl' | 'region'>): string | null {
  if (!PROVIDERS.includes(k.provider)) return 'Choose a voice service.';
  if (k.provider === 'openai' && !publicHttpsUrl(k.baseUrl)) return 'The base URL must be a public https address.';
  if (k.provider === 'azure' && !AZURE_REGION.test(k.region)) return 'Add the region of your Azure Speech resource, such as eastus or southeastasia.';
  if (k.voice && !SAFE_VOICE.test(k.voice)) return 'That voice name has characters a voice name can’t have.';
  if (k.provider !== 'openai' && !k.voice) return 'Choose a voice.';
  return null;
}

// ---------------------------------------------------------------- speaking
async function fail(res: Response): Promise<BrainFail> {
  const body = (await res.text().catch(() => '')).slice(0, 2000);
  const text = body.toLowerCase();
  const detail = providerMessage(body);
  const after = Number(res.headers.get('retry-after'));
  const wait = Number.isFinite(after) && after > 0 ? Math.min(Math.max(after * 1000, 15_000), HOUR) : 0;
  const quota = /quota|credit|limit|billing|insufficient|exceeded|payment|character/.test(text);
  // ElevenLabs' free plan refuses cloud servers: nothing changes that until the plan does.
  if (/detected_unusual_activity|unusual activity|free tier usage disabled/.test(text)) return new BrainFail('elevenlabs free plan', 'refused', 6 * HOUR, 'ElevenLabs’ free plan refuses requests from cloud servers such as Niko’s; a paid plan works.');
  if (res.status === 402 || (quota && [400, 403, 429].includes(res.status))) return new BrainFail(`limit ${res.status}`, 'limit', wait || HOUR, detail);
  if (res.status === 429) return new BrainFail(`rate ${res.status}`, 'limit', wait || MIN, detail);
  if (res.status === 401 || res.status === 403) return new BrainFail(`refused ${res.status}`, 'refused', 6 * HOUR, detail);
  if (res.status === 400 || res.status === 404 || res.status === 422) return new BrainFail(`rejected ${res.status}`, 'refused', 30 * MIN, detail);
  return new BrainFail(`down ${res.status}`, 'down', wait || MIN, detail);
}

async function call(url: string, init: RequestInit): Promise<Response> {
  try {
    // Redirects are not followed, so an address cannot bounce the request (and the key) somewhere else.
    return await fetch(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(20_000) });
  } catch (e) {
    throw new BrainFail('unreachable', 'down', MIN, (e as Error)?.name === 'TimeoutError' ? 'It took longer than 20 seconds to answer.' : 'Its address could not be reached.');
  }
}

async function audioOf(res: Response): Promise<{ bytes: Uint8Array; type: string }> {
  if (res.status >= 300 && res.status < 400) throw new BrainFail('redirect', 'refused', 30 * MIN, 'It tried to redirect the request. Use its final https address.');
  if (!res.ok) throw await fail(res);
  const type = res.headers.get('content-type') ?? '';
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length > TTS_MAX_BYTES) throw new BrainFail('too big', 'down', MIN, 'It sent back more audio than expected.');
  if (/json/.test(type)) {
    // Google answers with JSON holding the audio as base64.
    const j = JSON.parse(new TextDecoder().decode(bytes));
    const b64 = String(j?.audioContent ?? '');
    if (!b64) throw new BrainFail('no audio', 'down', MIN, 'It answered without audio.');
    const bin = atob(b64); const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return { bytes: out, type: 'audio/mpeg' };
  }
  if (!/^audio\//.test(type) && !/octet-stream/.test(type)) throw new BrainFail('not audio', 'refused', 30 * MIN, 'It did not send audio back. Check the address and model.');
  if (!bytes.length) throw new BrainFail('empty', 'down', MIN, 'It sent back no audio.');
  return { bytes, type: /^audio\//.test(type) ? type : 'audio/mpeg' };
}

const xml = (s: string) => s.replace(/[<>&'"]/g, (ch) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[ch]!);

/** One line of speech from one voice key. */
export async function speakWithKey(k: VoiceKey, text: string): Promise<{ bytes: Uint8Array; type: string }> {
  const problem = voiceKeyProblem(k);
  if (problem) throw new BrainFail('settings', 'refused', 30 * MIN, problem);
  if (k.provider === 'openai') {
    const root = publicHttpsUrl(k.baseUrl)!.toString().replace(/\/+$/, '');
    const url = /\/audio\/speech$/.test(root) ? root : /\/v1$/.test(root) ? `${root}/audio/speech` : `${root}/v1/audio/speech`;
    return audioOf(await call(url, { method: 'POST', headers: { authorization: `Bearer ${k.apiKey}`, 'content-type': 'application/json', accept: 'audio/mpeg' },
      body: JSON.stringify({ model: k.model || 'gpt-4o-mini-tts', voice: k.voice || 'alloy', input: text, response_format: 'mp3' }) }));
  }
  if (k.provider === 'elevenlabs') {
    return audioOf(await call(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(k.voice)}/stream`, {
      method: 'POST', headers: { 'xi-api-key': k.apiKey, 'content-type': 'application/json', accept: 'audio/mpeg' },
      body: JSON.stringify({ text, model_id: k.model || 'eleven_flash_v2_5' }) }));
  }
  if (k.provider === 'google') {
    const lang = k.voice.split('-').slice(0, 2).join('-') || 'en-US';
    return audioOf(await call(`https://texttospeech.googleapis.com/v1/text:synthesize?key=${encodeURIComponent(k.apiKey)}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: { text }, voice: { languageCode: lang, name: k.voice }, audioConfig: { audioEncoding: 'MP3' } }) }));
  }
  if (k.provider === 'azure') {
    const lang = k.voice.split('-').slice(0, 2).join('-') || 'en-US';
    return audioOf(await call(`https://${k.region}.tts.speech.microsoft.com/cognitiveservices/v1`, {
      method: 'POST', headers: { 'ocp-apim-subscription-key': k.apiKey, 'content-type': 'application/ssml+xml', 'x-microsoft-outputformat': 'audio-24khz-48kbitrate-mono-mp3', 'user-agent': 'niko' },
      body: `<speak version='1.0' xml:lang='${xml(lang)}'><voice name='${xml(k.voice)}'>${xml(text)}</voice></speak>` }));
  }
  if (k.provider === 'deepgram') {
    return audioOf(await call(`https://api.deepgram.com/v1/speak?model=${encodeURIComponent(k.voice)}&encoding=mp3`, {
      method: 'POST', headers: { authorization: `Token ${k.apiKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ text }) }));
  }
  return audioOf(await call('https://api.cartesia.ai/tts/bytes', {
    method: 'POST', headers: { authorization: `Bearer ${k.apiKey}`, 'cartesia-version': CARTESIA_VERSION, 'content-type': 'application/json' },
    body: JSON.stringify({ model_id: k.model || 'sonic-3.5', transcript: text, voice: { mode: 'id', id: k.voice }, output_format: { container: 'mp3', sample_rate: 44100, bit_rate: 128000 } }) }));
}

/** The voices a key can use, from the service's own list where it has one. */
export async function listVoices(k: VoiceKey): Promise<{ id: string; name: string }[]> {
  const clean = (list: { id: string; name: string }[]) => list.filter((v) => v.id && SAFE_VOICE.test(v.id)).slice(0, 400);
  const json = async (res: Response) => { if (!res.ok) throw await fail(res); return res.json() as Promise<any>; };
  if (k.provider === 'elevenlabs') {
    const j = await json(await call('https://api.elevenlabs.io/v1/voices', { headers: { 'xi-api-key': k.apiKey, accept: 'application/json' } }));
    return clean((j?.voices ?? []).map((v: any) => ({ id: String(v.voice_id), name: `${String(v.name ?? 'Voice').slice(0, 60)}${v.category === 'cloned' || v.category === 'professional' ? ' · your cloned voice' : ''}` })));
  }
  if (k.provider === 'google') {
    const j = await json(await call(`https://texttospeech.googleapis.com/v1/voices?key=${encodeURIComponent(k.apiKey)}`, {}));
    const list = (j?.voices ?? []).map((v: any) => ({ id: String(v.name), name: `${v.name} · ${String(v.ssmlGender ?? '').toLowerCase()}` }));
    return clean(list.sort((a: any, b: any) => Number(!a.id.startsWith('en-')) - Number(!b.id.startsWith('en-')) || a.id.localeCompare(b.id)));
  }
  if (k.provider === 'azure') {
    if (!AZURE_REGION.test(k.region)) throw new BrainFail('region', 'refused', 0, 'Add the region of your Azure Speech resource first.');
    const j = await json(await call(`https://${k.region}.tts.speech.microsoft.com/cognitiveservices/voices/list`, { headers: { 'ocp-apim-subscription-key': k.apiKey } }));
    const list = (Array.isArray(j) ? j : []).map((v: any) => ({ id: String(v.ShortName), name: `${v.DisplayName ?? v.ShortName} · ${v.LocaleName ?? v.Locale ?? ''}` }));
    return clean(list.sort((a: any, b: any) => Number(!a.id.startsWith('en-')) - Number(!b.id.startsWith('en-')) || a.id.localeCompare(b.id)));
  }
  if (k.provider === 'cartesia') {
    const j = await json(await call('https://api.cartesia.ai/voices?limit=100', { headers: { authorization: `Bearer ${k.apiKey}`, 'cartesia-version': CARTESIA_VERSION } }));
    return clean((Array.isArray(j) ? j : j?.data ?? []).map((v: any) => ({ id: String(v.id), name: `${String(v.name ?? 'Voice').slice(0, 60)}${v.language ? ` · ${v.language}` : ''}` })));
  }
  return []; // OpenAI and Deepgram have fixed lists, shown by the screen; other OpenAI-compatible services take a name.
}

// ---------------------------------------------------------------- rests
/** Notes that a voice failed (so it is skipped until its rest is over) or spoke (which ends its rest). */
export async function noteVoice(db: Db, user: { id: string; engine: unknown }, entry: string, f: BrainFail | null): Promise<BrainRest | null> {
  const engine = (user.engine ?? {}) as EnginePrefs;
  const rest = { ...(engine.voiceRest ?? {}) };
  for (const [k, v] of Object.entries(rest)) if (!v || v.until <= Date.now()) delete rest[k];
  let mine: BrainRest | null = null;
  if (f) { mine = { until: Date.now() + f.restMs, why: f.why }; rest[entry] = mine; }
  else if (!rest[entry] && Object.keys(rest).length === Object.keys(engine.voiceRest ?? {}).length) return null;
  else delete rest[entry];
  await db.update(users).set({ engine: { ...engine, voiceRest: rest } as any }).where(eq(users.id, user.id)).catch(() => undefined);
  return mine;
}
