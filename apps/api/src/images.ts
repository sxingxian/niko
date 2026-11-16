// Pictures: Cloudflare's FLUX.1 schnell is built in (on the free daily allowance); the user's own image server (any
// OpenAI-compatible images API at a public https address) and any number of the user's own image
// keys (OpenAI, Google, Stability AI, Black Forest Labs, fal, Replicate, Ideogram, and any OpenAI-compatible service
// such as xAI, Together AI or Recraft) can come before or after it. Like the brains and voices, a service that reaches
// its limit, refuses its key or doesn't answer rests for a while and the next one is used.
//
// Each service checks every request against its own rules. When one declines a picture on those grounds, that says
// nothing about the service itself, so it does not rest: the next service in the order is asked, and only when every
// service declines does Niko say the picture can't be made.
//
// Pictures are passed straight back to the person and never stored.
import { and, eq } from 'drizzle-orm';
import { connections, users, type Db } from '@niko/db';
import { aiAllowed, imageOption, imageOrder, MAX_IMAGE_KEYS, type BrainRest, type EnginePrefs, type ImageKeyInfo, type ImageProvider, type ImageShape, type ImageSource } from '@niko/shared';
import type { Env } from './env';
import { BrainFail, providerMessage } from './brains';
import { seal } from './lib/crypto';
import { credentials, publicHttpsUrl } from './providers';

export interface ImageKey extends ImageKeyInfo { apiKey: string }
export interface Picture { bytes: Uint8Array; type: string }
export const IMAGE_PROVIDERS_LIST: ImageProvider[] = ['openai', 'google', 'stability', 'fal', 'replicate', 'bfl', 'ideogram'];
export const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
export const MAX_PROMPT = 1500;
const MIN = 60_000, HOUR = 60 * MIN;
const SAFE_MODEL = /^[A-Za-z0-9._:\-/]{1,120}$/;
const WORKERS_IMAGE_MODEL = '@cf/black-forest-labs/flux-1-schnell';

/** The user's own image server, as saved in Connections (or typed on the Engine screen, for Test). An address without
 * a version path gets /v1, as OpenAI-compatible servers expect. */
export const withV1 = (u: string) => { const t = u.trim().replace(/\/+$/, ''); return /\/v\d+(\/|$)/.test(t) ? t : `${t}/v1`; };
export function serverKey(s: { baseUrl?: string; model?: string; apiKey?: string } | null, label: string): ImageKey | null {
  if (!s?.baseUrl) return null;
  return { id: 'self', label, provider: 'openai', baseUrl: withV1(s.baseUrl), model: String(s.model ?? ''), apiKey: String(s.apiKey ?? '') };
}

/** A service declined this particular picture under its own rules. The service itself is fine. */
export class Declined extends Error {
  constructor(readonly detail = '') { super('declined'); }
}

// ---------------------------------------------------------------- the saved keys
export async function loadImageKeys(env: Env, db: Db, userId: string): Promise<ImageKey[]> {
  const s = (await credentials(env, db, userId, 'image-keys').catch(() => null)) as any;
  return (Array.isArray(s?.keys) ? s.keys : []).filter((k: any) => k && typeof k.id === 'string' && typeof k.apiKey === 'string' && IMAGE_PROVIDERS_LIST.includes(k.provider)).slice(0, MAX_IMAGE_KEYS).map((k: any) => ({
    id: k.id, apiKey: k.apiKey, provider: k.provider, label: String(k.label ?? '') || defaultImageLabel(k), model: String(k.model ?? ''), baseUrl: String(k.baseUrl ?? ''),
  }));
}
export async function saveImageKeys(env: Env, db: Db, userId: string, keys: ImageKey[]): Promise<void> {
  await db.delete(connections).where(and(eq(connections.userId, userId), eq(connections.provider, 'image-keys')));
  if (!keys.length) return;
  const secret = { keys: keys.map(({ id, label, provider, model, baseUrl, apiKey }) => ({ id, label, provider, model, baseUrl, apiKey })) };
  await db.insert(connections).values({ id: crypto.randomUUID(), userId, provider: 'image-keys', secretEnc: await seal(env.ENCRYPTION_KEY, secret), meta: { label: `${keys.length} image key${keys.length === 1 ? '' : 's'}` } });
}
export const imageKeyInfo = (k: ImageKey): ImageKeyInfo => ({ id: k.id, label: k.label, provider: k.provider, model: k.model, baseUrl: k.baseUrl });
export function defaultImageLabel(k: { provider: ImageProvider; baseUrl: string }): string {
  if (k.provider !== 'openai') return { google: 'Google Gemini', stability: 'Stability AI', fal: 'fal', replicate: 'Replicate', bfl: 'Black Forest Labs', ideogram: 'Ideogram' }[k.provider];
  try {
    const h = new URL(k.baseUrl).hostname.replace(/^(api|external\.api)\./, '');
    return ({ 'openai.com': 'OpenAI', 'x.ai': 'xAI', 'together.xyz': 'Together AI', 'together.ai': 'Together AI', 'recraft.ai': 'Recraft' } as Record<string, string>)[h] ?? h;
  } catch { return 'OpenAI-compatible'; }
}
/** Checks a key's settings before it is saved or used. Returns a message for the person, or null. */
export function imageKeyProblem(k: Pick<ImageKey, 'provider' | 'model' | 'baseUrl'>): string | null {
  if (!IMAGE_PROVIDERS_LIST.includes(k.provider)) return 'Choose an image service.';
  if (k.provider === 'openai' && !publicHttpsUrl(k.baseUrl)) return 'The base URL must be a public https address.';
  if (k.model && !SAFE_MODEL.test(k.model)) return 'That model name has characters a model name can’t have.';
  if (k.provider === 'replicate' && k.model && !/^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/i.test(k.model)) return 'Write the Replicate model as owner/name, such as black-forest-labs/flux-schnell.';
  if (k.provider === 'fal' && k.model && !/^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*){1,4}$/i.test(k.model)) return 'Write the fal model as fal lists it, such as fal-ai/flux/schnell.';
  if (k.provider === 'bfl' && k.model && !/^[a-z0-9][a-z0-9.-]*$/i.test(k.model)) return 'Write the FLUX model as Black Forest Labs lists it, such as flux-pro-1.1.';
  if (k.provider === 'ideogram' && k.model && !['TURBO', 'DEFAULT', 'QUALITY'].includes(k.model.toUpperCase())) return 'Choose Turbo, Default or Quality.';
  return null;
}

// ---------------------------------------------------------------- reading answers
/** Words services use when they decline a picture under their own rules. */
const DECLINED = /moderat|safety|content[ _-]?polic|nsfw|inappropriate|prohibited|not allowed|violat|blocked|responsible ai|filtered|unsafe|explicit/i;

async function fail(res: Response): Promise<BrainFail | Declined> {
  const body = (await res.text().catch(() => '')).slice(0, 2000), text = body.toLowerCase(), detail = providerMessage(body);
  const after = Number(res.headers.get('retry-after'));
  const wait = Number.isFinite(after) && after > 0 ? Math.min(Math.max(after * 1000, 15_000), HOUR) : 0;
  if ([400, 403, 422].includes(res.status) && DECLINED.test(text) && !/api[ _-]?key|unauthori|permission|billing|account/.test(text)) return new Declined(detail);
  const quota = /quota|credit|limit|billing|insufficient|exceeded|payment|balance/.test(text);
  if (res.status === 402 || (quota && [400, 403, 429].includes(res.status))) return new BrainFail(`limit ${res.status}`, 'limit', wait || HOUR, detail);
  if (res.status === 429) return new BrainFail(`rate ${res.status}`, 'limit', wait || MIN, detail);
  if (res.status === 401 || res.status === 403) return new BrainFail(`refused ${res.status}`, 'refused', 6 * HOUR, detail);
  if (res.status === 400 || res.status === 404 || res.status === 422) return new BrainFail(`rejected ${res.status}`, 'refused', 30 * MIN, detail);
  return new BrainFail(`down ${res.status}`, 'down', wait || MIN, detail);
}

async function call(url: string, init: RequestInit, seconds = 90): Promise<Response> {
  let res: Response;
  try {
    // Redirects are not followed, so an address cannot bounce the request (and the key) somewhere else.
    res = await fetch(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(seconds * 1000) });
  } catch (e) {
    throw new BrainFail('unreachable', 'down', MIN, (e as Error)?.name === 'TimeoutError' ? `It took longer than ${seconds} seconds to answer.` : 'Its address could not be reached.');
  }
  if (res.status >= 300 && res.status < 400) throw new BrainFail('redirect', 'refused', 30 * MIN, 'It tried to redirect the request. Use its final https address.');
  if (!res.ok) throw await fail(res);
  return res;
}
async function json(url: string, init: RequestInit, seconds?: number): Promise<any> {
  const res = await call(url, init, seconds);
  return res.json().catch(() => { throw new BrainFail('not json', 'down', MIN, 'It answered with something other than the expected data.'); });
}

/** What kind of picture the bytes are, from their first bytes. Anything else is refused. */
export function sniffImage(b: Uint8Array): string | null {
  if (b.length < 12) return null;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (String.fromCharCode(b[0]!, b[1]!, b[2]!, b[3]!) === 'RIFF' && String.fromCharCode(b[8]!, b[9]!, b[10]!, b[11]!) === 'WEBP') return 'image/webp';
  return null;
}
function picture(bytes: Uint8Array): Picture {
  if (!bytes.length) throw new BrainFail('empty', 'down', MIN, 'It sent back no picture.');
  if (bytes.length > MAX_IMAGE_BYTES) throw new BrainFail('too big', 'down', MIN, 'It sent back a larger picture than expected.');
  const type = sniffImage(bytes);
  if (!type) throw new BrainFail('not an image', 'down', MIN, 'It sent back something that is not a picture.');
  return { bytes, type };
}
const unb64 = (s: string) => { const bin = atob(s.replace(/^data:[^,]*,/, '').replace(/\s+/g, '')); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; };
const fromB64 = (s: unknown) => { if (typeof s !== 'string' || !s) throw new BrainFail('no image', 'down', MIN, 'It answered without a picture.'); try { return picture(unb64(s)); } catch (e) { if (e instanceof BrainFail) throw e; throw new BrainFail('bad base64', 'down', MIN, 'Its picture could not be read.'); } };

/** Downloads a finished picture from where the service left it. No key is sent; only https addresses on the
 * service's own hosts are fetched (or any public https address for OpenAI-compatible services). */
async function download(raw: unknown, hosts: RegExp | null): Promise<Picture> {
  if (typeof raw === 'string' && raw.startsWith('data:image/')) return fromB64(raw);
  const u = publicHttpsUrl(raw);
  if (!u || (hosts && !hosts.test(u.hostname))) throw new BrainFail('odd address', 'down', MIN, 'It left the picture somewhere unexpected.');
  let res: Response;
  try { res = await fetch(u.toString(), { signal: AbortSignal.timeout(30_000) }); }
  catch { throw new BrainFail('download', 'down', MIN, 'Its picture could not be downloaded.'); }
  if (!res.ok) throw new BrainFail(`download ${res.status}`, 'down', MIN, 'Its picture could not be downloaded.');
  const len = Number(res.headers.get('content-length'));
  if (len > MAX_IMAGE_BYTES) throw new BrainFail('too big', 'down', MIN, 'It sent back a larger picture than expected.');
  return picture(new Uint8Array(await res.arrayBuffer()));
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- shapes
const RATIO: Record<ImageShape, string> = { square: '1:1', wide: '16:9', tall: '9:16' };
const OPENAI_SIZE: Record<ImageShape, string> = { square: '1024x1024', wide: '1536x1024', tall: '1024x1536' };
const PIXELS: Record<ImageShape, [number, number]> = { square: [1024, 1024], wide: [1344, 768], tall: [768, 1344] };

// ---------------------------------------------------------------- making a picture
/** Cloudflare's FLUX.1 schnell, on Niko's own account (shares the free daily allowance with the brain and voices). */
export async function workersImage(env: Env, prompt: string): Promise<Picture> {
  let msg = '';
  try {
    const out: any = await env.AI.run(WORKERS_IMAGE_MODEL as any, { prompt, steps: 4, seed: Math.floor(Math.random() * 2_000_000_000) } as any);
    if (out?.image) return fromB64(out.image);
    msg = 'no image';
  } catch (e) { if (e instanceof BrainFail) throw e; msg = String((e as Error)?.message ?? e); }
  if (/4006|daily free allocation|neurons/i.test(msg)) {
    const d = new Date(); const midnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) + 30_000;
    throw new BrainFail('workers daily allowance', 'limit', midnight - Date.now(), 'Cloudflare’s free allowance for today is used up; it resets at midnight UTC.');
  }
  if (DECLINED.test(msg)) throw new Declined('Cloudflare’s image model declined it.');
  throw new BrainFail(`workers image: ${msg.slice(0, 120)}`, 'down', MIN, 'Cloudflare’s image model did not answer just now.');
}

/** One picture through one key. */
export async function paintWithKey(k: ImageKey, prompt: string, shape: ImageShape): Promise<Picture> {
  const problem = imageKeyProblem(k);
  if (problem) throw new BrainFail('settings', 'refused', 30 * MIN, problem);
  if (k.provider === 'openai') return openaiImage(k, prompt, shape);
  if (k.provider === 'google') return googleImage(k, prompt, shape);
  if (k.provider === 'stability') return stabilityImage(k, prompt, shape);
  if (k.provider === 'fal') return falImage(k, prompt, shape);
  if (k.provider === 'replicate') return replicateImage(k, prompt, shape);
  if (k.provider === 'bfl') return bflImage(k, prompt, shape);
  return ideogramImage(k, prompt, shape);
}

/** OpenAI's images API, and services that copy it. They differ in how they are asked for base64. */
async function openaiImage(k: ImageKey, prompt: string, shape: ImageShape): Promise<Picture> {
  const root = publicHttpsUrl(k.baseUrl)!;
  const host = root.hostname.toLowerCase();
  const url = `${root.toString().replace(/\/+$/, '').replace(/\/images\/generations$/, '')}/images/generations`;
  const model = k.model || (host === 'api.openai.com' ? 'gpt-image-1-mini' : '');
  const body: Record<string, unknown> = { prompt, n: 1, ...(model ? { model } : {}) };
  if (/^gpt-image/i.test(model)) Object.assign(body, { size: OPENAI_SIZE[shape], quality: 'medium', output_format: 'jpeg' }); // always base64; refuses response_format
  else if (/(^|\.)together\.(xyz|ai)$/.test(host)) Object.assign(body, { response_format: 'base64', width: PIXELS[shape][0], height: PIXELS[shape][1] });
  else if (host === 'api.x.ai') Object.assign(body, { response_format: 'b64_json', aspect_ratio: RATIO[shape] });
  else Object.assign(body, { response_format: 'b64_json', size: shape === 'square' ? '1024x1024' : shape === 'wide' ? '1792x1024' : '1024x1792' });
  // A server of the user's own may have no key at all.
  const send = (b: Record<string, unknown>) => json(url, { method: 'POST', headers: { ...(k.apiKey ? { authorization: `Bearer ${k.apiKey}` } : {}), 'content-type': 'application/json' }, body: JSON.stringify(b) });
  let j: any;
  try { j = await send(body); }
  catch (e) {
    // Some compatible services don't know response_format or the size asked for: ask once more with only the prompt.
    if (!(e instanceof BrainFail) || e.why !== 'refused' || !/response_format|size|aspect|width|unknown|unrecognized|invalid/i.test(e.detail)) throw e;
    j = await send({ prompt, n: 1, ...(model ? { model } : {}) });
  }
  const d = j?.data?.[0];
  if (d?.b64_json) return fromB64(d.b64_json);
  if (d?.url) return download(d.url, null);
  throw new BrainFail('no image', 'down', MIN, 'It answered without a picture.');
}

/** Gemini image models through generateContent, or Imagen through predict. */
async function googleImage(k: ImageKey, prompt: string, shape: ImageShape): Promise<Picture> {
  const model = k.model || 'gemini-2.5-flash-image';
  const base = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}`;
  const headers = { 'x-goog-api-key': k.apiKey, 'content-type': 'application/json' };
  if (/^imagen/i.test(model)) {
    const j = await json(`${base}:predict`, { method: 'POST', headers, body: JSON.stringify({ instances: [{ prompt }], parameters: { sampleCount: 1, aspectRatio: RATIO[shape] } }) });
    const p = (j?.predictions ?? []).find((x: any) => x?.bytesBase64Encoded);
    if (p) return fromB64(p.bytesBase64Encoded);
    const why = (j?.predictions ?? []).map((x: any) => x?.raiFilteredReason).find(Boolean);
    throw new Declined(why ? providerMessage(String(why)) : 'Imagen made no picture for that request.');
  }
  const j = await json(`${base}:generateContent`, { method: 'POST', headers, body: JSON.stringify({
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: RATIO[shape] } },
  }) });
  if (j?.promptFeedback?.blockReason) throw new Declined(`Gemini declined it (${String(j.promptFeedback.blockReason).toLowerCase().replace(/_/g, ' ')}).`);
  const c = j?.candidates?.[0];
  const part = (c?.content?.parts ?? []).find((p: any) => p?.inlineData?.data || p?.inline_data?.data);
  if (part) return fromB64((part.inlineData ?? part.inline_data).data);
  const reason = String(c?.finishReason ?? '');
  if (/SAFETY|PROHIBITED|BLOCKLIST|SPII|IMAGE_OTHER|RECITATION/i.test(reason)) throw new Declined(`Gemini declined it (${reason.toLowerCase().replace(/_/g, ' ')}).`);
  throw new BrainFail('no image', 'down', MIN, 'Gemini answered without a picture. Check the model is an image model.');
}

/** Stability AI: Stable Image Core, Ultra, or Stable Diffusion 3.5 (by its model name). */
async function stabilityImage(k: ImageKey, prompt: string, shape: ImageShape): Promise<Picture> {
  const model = (k.model || 'core').toLowerCase();
  const path = model === 'core' || model === 'ultra' ? model : 'sd3';
  const form = new FormData();
  form.set('prompt', prompt); form.set('aspect_ratio', RATIO[shape]); form.set('output_format', 'jpeg');
  if (path === 'sd3') form.set('model', model);
  const res = await call(`https://api.stability.ai/v2beta/stable-image/generate/${path}`, { method: 'POST', headers: { authorization: `Bearer ${k.apiKey}`, accept: 'image/*' }, body: form });
  // A picture its filter caught comes back blurred, marked in this header.
  if (/CONTENT_FILTERED/i.test(res.headers.get('finish-reason') ?? '')) throw new Declined('Stability AI’s filter caught the picture.');
  return picture(new Uint8Array(await res.arrayBuffer()));
}

/** fal: any of its image models, answered in one request (sync_mode puts the picture in the answer itself). */
async function falImage(k: ImageKey, prompt: string, shape: ImageShape): Promise<Picture> {
  const model = k.model || 'fal-ai/flux/schnell';
  const flux = /flux|sdxl|stable-diffusion|recraft/i.test(model);
  const size = flux ? { image_size: shape === 'square' ? 'square_hd' : shape === 'wide' ? 'landscape_16_9' : 'portrait_16_9' } : { aspect_ratio: RATIO[shape] };
  const j = await json(`https://fal.run/${model.split('/').map(encodeURIComponent).join('/')}`, {
    method: 'POST', headers: { authorization: `Key ${k.apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ prompt, num_images: 1, enable_safety_checker: true, sync_mode: true, output_format: 'jpeg', ...size }),
  });
  if (Array.isArray(j?.has_nsfw_concepts) && j.has_nsfw_concepts[0] === true) throw new Declined('fal’s safety check caught the picture.');
  const img = j?.images?.[0] ?? j?.image;
  if (!img?.url) throw new BrainFail('no image', 'down', MIN, 'It answered without a picture. Check the model makes pictures from text.');
  return download(img.url, /(^|\.)fal\.(media|ai|run)$/i);
}

/** Replicate: an official model by owner/name. It waits up to a minute for the picture, then Niko asks again. */
async function replicateImage(k: ImageKey, prompt: string, shape: ImageShape): Promise<Picture> {
  const model = k.model || 'black-forest-labs/flux-schnell';
  const headers = { authorization: `Bearer ${k.apiKey}`, 'content-type': 'application/json' };
  let p = await json(`https://api.replicate.com/v1/models/${model.split('/').map(encodeURIComponent).join('/')}/predictions`, {
    method: 'POST', headers: { ...headers, prefer: 'wait=55' }, body: JSON.stringify({ input: { prompt, aspect_ratio: RATIO[shape] } }),
  }, 70);
  const until = Date.now() + 45_000;
  while ((p?.status === 'starting' || p?.status === 'processing') && Date.now() < until) {
    const next = publicHttpsUrl(p?.urls?.get);
    if (!next || next.hostname !== 'api.replicate.com') break;
    await sleep(1500);
    p = await json(next.toString(), { headers });
  }
  if (p?.status === 'failed' || p?.status === 'canceled') {
    const e = providerMessage(String(p?.error ?? ''));
    if (DECLINED.test(e)) throw new Declined(e);
    throw new BrainFail('replicate failed', 'down', MIN, e || 'The model could not make the picture.');
  }
  if (p?.status !== 'succeeded') throw new BrainFail('replicate slow', 'down', MIN, 'It did not finish the picture in time.');
  const out = Array.isArray(p.output) ? p.output[0] : p.output;
  return download(out, /(^|\.)replicate\.delivery$/i);
}

/** Black Forest Labs: asked once, then its answer is collected from the address it gives (on its own hosts). */
async function bflImage(k: ImageKey, prompt: string, shape: ImageShape): Promise<Picture> {
  const model = k.model || 'flux-pro-1.1';
  const size = /ultra|kontext/i.test(model) ? { aspect_ratio: RATIO[shape] } : { width: PIXELS[shape][0], height: PIXELS[shape][1] };
  const headers = { 'x-key': k.apiKey, accept: 'application/json', 'content-type': 'application/json' };
  const start = await json(`https://api.bfl.ai/v1/${encodeURIComponent(model)}`, { method: 'POST', headers, body: JSON.stringify({ prompt, output_format: 'jpeg', ...size }) });
  const poll = publicHttpsUrl(start?.polling_url);
  // The key goes only to Black Forest Labs' own hosts.
  if (!poll || !/(^|\.)bfl\.(ai|ml)$/i.test(poll.hostname)) throw new BrainFail('odd poll', 'down', MIN, 'It answered in an unexpected way.');
  const until = Date.now() + 80_000;
  while (Date.now() < until) {
    await sleep(800);
    const r = await json(poll.toString(), { headers: { 'x-key': k.apiKey, accept: 'application/json' } });
    const st = String(r?.status ?? '');
    if (st === 'Ready') return download(r?.result?.sample, /(^|\.)bfl\.(ai|ml)$/i);
    if (/moderated/i.test(st)) throw new Declined(`Black Forest Labs declined it (${st.toLowerCase()}).`);
    if (/error|failed|not found/i.test(st)) throw new BrainFail(`bfl ${st}`, 'down', MIN, `It said: ${st}.`);
  }
  throw new BrainFail('bfl slow', 'down', MIN, 'It did not finish the picture in time.');
}

/** Ideogram 3.0. The model setting is its speed: Turbo, Default or Quality. */
async function ideogramImage(k: ImageKey, prompt: string, shape: ImageShape): Promise<Picture> {
  const form = new FormData();
  form.set('prompt', prompt); form.set('aspect_ratio', RATIO[shape].replace(':', 'x')); form.set('rendering_speed', (k.model || 'TURBO').toUpperCase());
  const j = await json('https://api.ideogram.ai/v1/ideogram-v3/generate', { method: 'POST', headers: { 'Api-Key': k.apiKey }, body: form });
  const d = j?.data?.[0];
  if (d && d.is_image_safe === false) throw new Declined('Ideogram’s safety check caught the picture.');
  if (!d?.url) throw new BrainFail('no image', 'down', MIN, 'It answered without a picture.');
  return download(d.url, /(^|\.)ideogram\.ai$/i);
}

// ---------------------------------------------------------------- in order, with rests
export interface Painted extends Picture { used: ImageSource; label: string; ms: number }

/**
 * Makes a picture with the first service in the order that will. Resting services are tried last. A failure sets a
 * rest; a picture ends it. A service that declines the request is not rested: the next one is asked instead.
 * `only` tries one service (the Engine screen's Test), with an unsaved key where one is given.
 */
export async function paint(env: Env, db: Db, user: { id: string; engine: unknown }, prompt: string, shape: ImageShape, only?: { entry: ImageSource; key?: ImageKey }, off: readonly string[] = []): Promise<Painted> {
  const engine = (user.engine ?? {}) as EnginePrefs;
  let keys: ImageKey[] | null = null;
  let order = only ? [only.entry] : imageOrder(engine);
  // Services the admin has turned off for this account are skipped; with pictures off altogether, none is asked.
  if (off.includes('sec:images')) throw new BrainFail('not on account', 'refused', 0, 'Pictures aren’t available on your account.');
  if (off.length) {
    keys = await loadImageKeys(env, db, user.id);
    order = order.filter((e) => aiAllowed(off, imageOption(e, only?.key && only.entry === e ? only.key : keys!.find((k) => `ikey:${k.id}` === e))));
    if (!order.length && only) throw new BrainFail('not on account', 'refused', 0, 'That service isn’t available on your account.');
  }
  if (!order.length) throw new BrainFail('no services', 'refused', 0, 'Pictures are switched off on the Engine screen.');
  const now = Date.now();
  const rest: Record<string, BrainRest> = {};
  for (const [k, v] of Object.entries(engine.imageRest ?? {})) if (v && v.until > now) rest[k] = v;
  const ready = order.filter((s) => !rest[s]), resting = order.filter((s) => rest[s]).sort((a, b) => rest[a]!.until - rest[b]!.until);
  let changed = Object.keys(rest).length !== Object.keys(engine.imageRest ?? {}).length, last: unknown = null;
  const declined: string[] = [];
  try {
    for (const entry of [...ready, ...resting]) {
      const t0 = Date.now();
      let label = 'Cloudflare';
      try {
        let pic: Picture;
        if (entry === 'workers') pic = await workersImage(env, prompt);
        else if (entry === 'self-hosted') {
          label = 'Your image server';
          const k = only?.key ?? serverKey((await credentials(env, db, user.id, 'self-hosted-image').catch(() => null)) as any, label);
          if (!k) throw new BrainFail('no server', 'refused', 6 * HOUR, 'Your image server is not set up yet.');
          pic = await paintWithKey(k, prompt, shape);
        } else {
          const k = only?.key ?? (keys ??= await loadImageKeys(env, db, user.id)).find((x) => `ikey:${x.id}` === entry);
          if (!k) throw new BrainFail('key not found', 'refused', 6 * HOUR, 'That key is no longer saved.');
          label = k.label || defaultImageLabel(k);
          pic = await paintWithKey(k, prompt, shape);
        }
        if (!only && rest[entry]) { delete rest[entry]; changed = true; }
        return { ...pic, used: entry, label, ms: Date.now() - t0 };
      } catch (e) {
        if (e instanceof Declined) { declined.push(`${label}${e.detail ? `: ${e.detail}` : ''}`); console.warn(`image ${entry} declined the request`); continue; }
        last = e;
        const f = e instanceof BrainFail ? e : new BrainFail(String((e as Error)?.message ?? e).slice(0, 200), 'down', MIN);
        console.warn(`image ${entry} failed (${f.why}): ${f.message.slice(0, 200)}`);
        if (!only?.key) { rest[entry] = { until: Date.now() + f.restMs, why: f.why }; changed = true; }
      }
    }
    // Every service that answered declined it: that is the answer, rather than whatever else went wrong.
    if (declined.length) throw new Declined(declined.join(' · ').slice(0, 400));
    throw last ?? new Error('No image service could make that picture.');
  } finally {
    if (changed && !only?.key) await db.update(users).set({ engine: { ...engine, imageRest: rest } as any }).where(eq(users.id, user.id)).catch(() => undefined);
  }
}
