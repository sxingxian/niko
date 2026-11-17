// /api/admin/setup: services the admin provides to people. Keys are kept once (provided_keys); a person (or an
// invite, until they join) is given some of them per kind, in order, with a rule for whether they may reorder them.
// The setup window also removes Niko's built-in Workers AI for a person (the same switches as AI options) and sets
// their monthly amounts (the same values as Limits). Keys never come back out: only service, model and last 4.
import { and, eq, gt, isNull } from 'drizzle-orm';
import { Hono } from 'hono';
import { invites, providedKeys, users } from '@niko/db';
import { accountLimits, aiHasBrain, aiOff, aiProviderOf, BUILTIN_TOKEN, providedIds, cleanAccountLimits, cleanAiAccess, cleanProvided, NOT_CHAT, USAGE_KINDS, type EnginePrefs, type ProvidedSetup, type UsageKind } from '@niko/shared';
import type { AppEnv } from '../env';
import { audit, requireAdmin } from '../lib/session';
import { publicHttpsUrl } from '../providers';
import { customAi, defaultLabel } from '../brains';
import { defaultVoiceLabel, speakWithKey, voiceKeyProblem } from '../voices';
import { defaultHearLabel, hearKeyProblem } from '../hears';
import { defaultImageLabel, imageKeyProblem } from '../images';
import { mapKeyProblem, testMapKey } from '../maps';
import { mapPreset } from '@niko/shared';
import { aiDefaults } from '../access';
import { accountDefaults } from '../limits';
import { monthUsage } from '../usage';
import { engineWithProvided, keyHint, newProvidedId, sealProvided } from '../provided';
import { hearKeyFrom, imageKeyFrom, mapKeyFrom, voiceKeyFrom } from './app';

export const setup = new Hono<AppEnv>();
setup.use('*', requireAdmin);

const KINDS = USAGE_KINDS as readonly UsageKind[];
const isKind = (k: unknown): k is UsageKind => KINDS.includes(k as UsageKind);
/** The built-in Workers AI switch for each kind (AI options keys). Maps keep OpenStreetMap as the last resort. */
const BUILTIN: Partial<Record<UsageKind, string>> = { brain: 'workers-ai', voice: 'v:workers', hear: 'h:workers', image: 'img:workers' };
const clip = (v: unknown, n: number) => (typeof v === 'string' ? v.trim().slice(0, n) : '');

/** A key from the form, checked for its kind: its secret (sealed) and what may be shown. */
async function keyFromForm(kind: UsageKind, b: any): Promise<{ secret: Record<string, unknown>; info: Record<string, unknown>; label: string } | { error: string }> {
  if (kind === 'brain') {
    const baseUrl = clip(b?.baseUrl, 500), model = clip(b?.model, 200), apiKey = clip(b?.apiKey, 4000);
    if (!publicHttpsUrl(baseUrl)) return { error: 'The base URL must be a public https address.' };
    if (!model) return { error: 'Add the model name, as the provider lists it.' };
    if (NOT_CHAT.test(model)) return { error: `“${model}” is not a chat model, so it can’t answer as Niko.` };
    if (!apiKey) return { error: 'Paste the API key.' };
    return { secret: { baseUrl, model, apiKey }, info: { provider: aiProviderOf(baseUrl), baseUrl, model, hint: keyHint(apiKey) }, label: clip(b?.label, 40) || defaultLabel({ baseUrl, model }) };
  }
  if (kind === 'voice') {
    const k = voiceKeyFrom(b);
    const problem = voiceKeyProblem(k); if (problem) return { error: problem };
    if (!k.apiKey) return { error: 'Paste the API key.' };
    return { secret: { ...k }, info: { provider: k.provider, voice: k.voice, model: k.model, baseUrl: k.baseUrl, region: k.region, hint: keyHint(k.apiKey) }, label: k.label || defaultVoiceLabel(k) };
  }
  if (kind === 'hear') {
    const k = hearKeyFrom(b);
    const problem = hearKeyProblem(k); if (problem) return { error: problem };
    if (!k.apiKey) return { error: 'Paste the API key.' };
    return { secret: { ...k }, info: { provider: k.provider, model: k.model, baseUrl: k.baseUrl, region: k.region, hint: keyHint(k.apiKey) }, label: k.label || defaultHearLabel(k) };
  }
  if (kind === 'image') {
    const k = imageKeyFrom(b);
    const problem = imageKeyProblem(k); if (problem) return { error: problem };
    if (!k.apiKey) return { error: 'Paste the API key.' };
    return { secret: { ...k }, info: { provider: k.provider, model: k.model, baseUrl: k.baseUrl, hint: keyHint(k.apiKey) }, label: k.label || defaultImageLabel(k) };
  }
  const k = mapKeyFrom(b);
  const problem = mapKeyProblem(k); if (problem) return { error: problem };
  return { secret: { ...k }, info: { provider: k.provider, baseUrl: k.baseUrl, hint: keyHint(k.secret || k.password || k.apiKey) }, label: k.label || mapPreset(k.provider)?.name || 'Map service' };
}

/** Checks a key with its service where that costs (almost) nothing: a one-word answer, a one-word voice line, a map search. */
async function tryKey(kind: UsageKind, secret: any): Promise<string | null> {
  try {
    if (kind === 'brain') await customAi(secret, [{ role: 'system', content: 'Reply with the single word: ready' }, { role: 'user', content: 'Are you there?' }]);
    else if (kind === 'voice') await speakWithKey({ ...secret, id: 'test', label: '' }, 'Ready.');
    else if (kind === 'map') await testMapKey({ ...secret, id: 'test', label: '' });
    return null;
  } catch (e) {
    const d = (e as { detail?: string })?.detail;
    return `The service didn’t accept it${d ? `: “${String(d).slice(0, 160)}”` : '.'} Check the key and its settings.`;
  }
}

async function setupOfUser(db: any, id: string) { return (await db.select().from(users).where(eq(users.id, id)).limit(1))[0]; }
async function setupOfInvite(db: any, id: string) {
  return (await db.select().from(invites).where(and(eq(invites.id, id), isNull(invites.usedAt), isNull(invites.revokedAt), gt(invites.expiresAt, new Date()))).limit(1))[0];
}
const inviteSetup = (v: unknown) => (v && typeof v === 'object' ? v : {}) as { provided?: unknown; aiAccess?: unknown; limits?: unknown; engine?: unknown };

/** Gives one person or invite a provided key (at the top of that kind), keeping the rest of their setup. */
async function giveKey(db: any, who: 'user' | 'invite', id: string, kind: UsageKind, keyId: string) {
  if (who === 'user') {
    const u = await setupOfUser(db, id); if (!u) return;
    const s = cleanProvided(u.provided);
    s.keys[kind] = [keyId, ...(s.keys[kind] ?? []).filter((x) => x !== keyId)];
    await db.update(users).set({ provided: { ...s, setAt: new Date().toISOString() }, engine: engineWithProvided(u.engine as Partial<EnginePrefs>, s) as any }).where(eq(users.id, u.id));
  } else {
    const inv = await setupOfInvite(db, id); if (!inv) return;
    const cur = inviteSetup(inv.setup), s = cleanProvided(cur.provided);
    s.keys[kind] = [keyId, ...(s.keys[kind] ?? []).filter((x) => x !== keyId)];
    await db.update(invites).set({ setup: { ...cur, provided: s, engine: engineWithProvided((cur.engine ?? {}) as Partial<EnginePrefs>, s) } }).where(eq(invites.id, inv.id));
  }
}
/** Takes a provided key away from everyone who has it (when the key is removed). */
async function takeKeyFromAll(db: any, keyId: string) {
  for (const u of await db.select({ id: users.id, provided: users.provided, engine: users.engine }).from(users)) {
    const s = cleanProvided(u.provided);
    if (!KINDS.some((k) => s.keys[k]?.includes(keyId))) continue;
    for (const k of KINDS) if (s.keys[k]) { s.keys[k] = s.keys[k]!.filter((x) => x !== keyId); if (!s.keys[k]!.length) delete s.keys[k]; }
    await db.update(users).set({ provided: s, engine: engineWithProvided(u.engine as Partial<EnginePrefs>, s) as any }).where(eq(users.id, u.id));
  }
  for (const inv of await db.select({ id: invites.id, setup: invites.setup }).from(invites).where(isNull(invites.usedAt))) {
    const cur = inviteSetup(inv.setup), s = cleanProvided(cur.provided);
    if (!KINDS.some((k) => s.keys[k]?.includes(keyId))) continue;
    for (const k of KINDS) if (s.keys[k]) { s.keys[k] = s.keys[k]!.filter((x) => x !== keyId); if (!s.keys[k]!.length) delete s.keys[k]; }
    await db.update(invites).set({ setup: { ...cur, provided: s, engine: engineWithProvided((cur.engine ?? {}) as Partial<EnginePrefs>, s) } }).where(eq(invites.id, inv.id));
  }
}

// ---- the key library
setup.get('/keys', async (c) => {
  const db = c.get('db');
  const rows = await db.select({ id: providedKeys.id, kind: providedKeys.kind, label: providedKeys.label, info: providedKeys.info, createdAt: providedKeys.createdAt }).from(providedKeys).orderBy(providedKeys.createdAt);
  const people = await db.select({ provided: users.provided }).from(users);
  const pending = await db.select({ setup: invites.setup }).from(invites).where(and(isNull(invites.usedAt), isNull(invites.revokedAt), gt(invites.expiresAt, new Date())));
  const uses = (id: string, list: unknown[]) => list.filter((p) => KINDS.some((k) => cleanProvided(p).keys[k]?.includes(id))).length;
  return c.json({ keys: rows.map((r) => ({ ...r, users: uses(r.id, people.map((p) => p.provided)), invites: uses(r.id, pending.map((p) => inviteSetup(p.setup).provided)) })) });
});

setup.post('/keys', async (c) => {
  const b = await c.req.json<{ kind?: string; key?: any; give?: { users?: unknown; invites?: unknown } }>().catch(() => ({} as any));
  if (!isKind(b.kind)) return c.json({ error: 'Choose what the key is for.' }, 400);
  const db = c.get('db');
  if ((await db.select({ id: providedKeys.id }).from(providedKeys)).length >= 60) return c.json({ error: 'Up to 60 keys can be kept here. Remove one you no longer use.' }, 400);
  const k = await keyFromForm(b.kind, b.key);
  if ('error' in k) return c.json({ error: k.error }, 400);
  const bad = await tryKey(b.kind, k.secret);
  if (bad) return c.json({ error: bad }, 400);
  const id = newProvidedId();
  await db.insert(providedKeys).values({ id, kind: b.kind, label: k.label, info: k.info, secretEnc: await sealProvided(c.env, { ...k.secret, label: k.label }), createdBy: c.get('user').id });
  const toUsers = Array.isArray(b.give?.users) ? (b.give.users as unknown[]).map(String).slice(0, 200) : [];
  const toInvites = Array.isArray(b.give?.invites) ? (b.give.invites as unknown[]).map(String).slice(0, 200) : [];
  for (const uid of toUsers) await giveKey(db, 'user', uid, b.kind, id);
  for (const iid of toInvites) await giveKey(db, 'invite', iid, b.kind, id);
  await audit(c, 'provided-key.added', { kind: b.kind, service: String(k.info.provider ?? ''), label: k.label, given: toUsers.length + toInvites.length }, c.get('user').id);
  return c.json({ ok: true, key: { id, kind: b.kind, label: k.label, info: k.info } });
});

// Renames a key, or replaces it (a renewed key): everyone who has it moves to the new one at once.
setup.patch('/keys/:id', async (c) => {
  const db = c.get('db');
  const row = (await db.select().from(providedKeys).where(eq(providedKeys.id, c.req.param('id'))).limit(1))[0];
  if (!row) return c.json({ error: 'That key is no longer kept.' }, 404);
  const b = await c.req.json<{ label?: string; apiKey?: string }>().catch(() => ({} as any));
  const label = clip(b.label, 40) || row.label;
  const set: Record<string, unknown> = { label, updatedAt: new Date() };
  if (clip(b.apiKey, 4000)) {
    const { unseal } = await import('../lib/crypto');
    // The secret part of the key: OneMap signs in with a password, Naver with a client secret.
    const field = row.kind === 'map' && (row.info as { provider?: string })?.provider === 'onemap' ? 'password' : row.kind === 'map' && (row.info as { provider?: string })?.provider === 'naver' ? 'secret' : 'apiKey';
    const secret = { ...((await unseal<Record<string, unknown>>(c.env.ENCRYPTION_KEY, row.secretEnc)) ?? {}), [field]: clip(b.apiKey, 4000), label };
    const bad = await tryKey(row.kind as UsageKind, secret);
    if (bad) return c.json({ error: bad }, 400);
    set.secretEnc = await sealProvided(c.env, secret);
    set.info = { ...(row.info as object), hint: keyHint(String(secret[field])) };
  }
  await db.update(providedKeys).set(set).where(eq(providedKeys.id, row.id));
  await audit(c, set.secretEnc ? 'provided-key.replaced' : 'provided-key.renamed', { kind: row.kind, label }, c.get('user').id);
  return c.json({ ok: true });
});

setup.delete('/keys/:id', async (c) => {
  const db = c.get('db');
  const row = (await db.select().from(providedKeys).where(eq(providedKeys.id, c.req.param('id'))).limit(1))[0];
  if (!row) return c.json({ ok: true });
  await takeKeyFromAll(db, row.id);
  await db.delete(providedKeys).where(eq(providedKeys.id, row.id));
  await audit(c, 'provided-key.removed', { kind: row.kind, label: row.label }, c.get('user').id);
  return c.json({ ok: true });
});

// ---- one person's (or invite's) setup
setup.get('/:who/:id', async (c) => {
  const who = c.req.param('who'), db = c.get('db');
  if (who !== 'user' && who !== 'invite') return c.json({ error: 'Not found.' }, 404);
  const defaults = await aiDefaults(db), limitDefaults = accountLimits(await accountDefaults(db, true), {});
  if (who === 'user') {
    const u = await setupOfUser(db, c.req.param('id'));
    if (!u) return c.json({ error: 'No such user.' }, 404);
    const off = aiOff(defaults, cleanAiAccess(u.aiAccess));
    return c.json({ setup: cleanProvided(u.provided), builtins: Object.fromEntries(KINDS.map((k) => [k, BUILTIN[k] ? !off.includes(BUILTIN[k]!) : true])), off, limits: cleanAccountLimits(u.accountLimits), limitDefaults, usage: (await monthUsage(db, u.id)).kinds, joined: true });
  }
  const inv = await setupOfInvite(db, c.req.param('id'));
  if (!inv) return c.json({ error: 'That invite is no longer open.' }, 404);
  const cur = inviteSetup(inv.setup), off = aiOff(defaults, cleanAiAccess(cur.aiAccess));
  return c.json({ setup: cleanProvided(cur.provided), builtins: Object.fromEntries(KINDS.map((k) => [k, BUILTIN[k] ? !off.includes(BUILTIN[k]!) : true])), off, limits: cleanAccountLimits(cur.limits), limitDefaults, usage: null, joined: false });
});

setup.put('/:who/:id', async (c) => {
  const who = c.req.param('who'), db = c.get('db');
  if (who !== 'user' && who !== 'invite') return c.json({ error: 'Not found.' }, 404);
  const b = await c.req.json<{ keys?: unknown; order?: unknown; builtins?: Record<string, unknown>; limits?: unknown }>().catch(() => ({} as any));
  // Only keys that are kept, and of the right kind, can be given.
  const kept = await db.select({ id: providedKeys.id, kind: providedKeys.kind }).from(providedKeys);
  const asked = cleanProvided({ keys: b.keys, order: b.order });
  const s: ProvidedSetup = { keys: {}, order: asked.order, setAt: new Date().toISOString() };
  for (const k of KINDS) { const l = (asked.keys[k] ?? []).filter((id) => id === BUILTIN_TOKEN || kept.some((x) => x.id === id && x.kind === k)); if (providedIds(l).length || l.length) s.keys[k] = l; }
  const defaults = await aiDefaults(db), limitDefaults = accountLimits(await accountDefaults(db, true), {});
  const target = who === 'user' ? await setupOfUser(db, c.req.param('id')) : await setupOfInvite(db, c.req.param('id'));
  if (!target) return c.json({ error: who === 'user' ? 'No such user.' : 'That invite is no longer open.' }, 404);
  const curAccess = cleanAiAccess(who === 'user' ? (target as any).aiAccess : inviteSetup((target as any).setup).aiAccess);
  const access: Record<string, boolean> = { ...curAccess };
  for (const k of KINDS) {
    const opt = BUILTIN[k];
    if (!opt || typeof b.builtins?.[k] !== 'boolean') continue;
    const on = b.builtins[k] as boolean;
    if (on === (defaults[opt] ?? true)) delete access[opt]; else access[opt] = on;
  }
  // Something must answer: a provided AI key, or Workers AI.
  if (!providedIds(s.keys.brain).length && aiOff(defaults, access).includes('workers-ai')) return c.json({ error: 'Nothing would be left to answer. Add a service with your key, or keep Workers AI.' }, 400);
  if (!aiHasBrain(aiOff(defaults, access)) && !providedIds(s.keys.brain).length) return c.json({ error: 'Nothing would be left to answer. Keep Workers AI, or add an AI key.' }, 400);
  // The built-in's place means nothing once it is removed.
  for (const k of KINDS) if (s.keys[k] && BUILTIN[k] && aiOff(defaults, access).includes(BUILTIN[k]!)) { s.keys[k] = providedIds(s.keys[k]); if (!s.keys[k]!.length) delete s.keys[k]; }
  const own = Object.fromEntries(Object.entries(cleanAccountLimits(b.limits)).filter(([k, v]) => v !== (limitDefaults as unknown as Record<string, unknown>)[k]));
  if (who === 'user') {
    const u = target as typeof users.$inferSelect;
    // Monthly amounts: different from the default are kept for this person; the rest follow the default.
    const limitsNow = cleanAccountLimits(u.accountLimits) as Record<string, unknown>;
    if (b.limits !== undefined) { for (const k of KINDS) delete limitsNow[k]; Object.assign(limitsNow, own); }
    await db.update(users).set({ provided: s, engine: engineWithProvided(u.engine as Partial<EnginePrefs>, s) as any, aiAccess: access, accountLimits: limitsNow }).where(eq(users.id, u.id));
    await audit(c, 'setup.user', { target: u.email, keys: KINDS.reduce((n, k) => n + providedIds(s.keys[k]).length, 0), order: s.order }, c.get('user').id);
  } else {
    const inv = target as typeof invites.$inferSelect;
    const cur = inviteSetup(inv.setup);
    await db.update(invites).set({ setup: { ...cur, provided: s, aiAccess: access, engine: engineWithProvided((cur.engine ?? {}) as Partial<EnginePrefs>, s), ...(b.limits !== undefined ? { limits: own } : {}) } }).where(eq(invites.id, inv.id));
    await audit(c, 'setup.invite', { target: inv.email, keys: KINDS.reduce((n, k) => n + providedIds(s.keys[k]).length, 0), order: s.order }, c.get('user').id);
  }
  return c.json({ ok: true });
});
