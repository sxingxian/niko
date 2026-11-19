// Admin · Data sources: the sources the admin adds (keys sealed, never shown again), testing them, and who may use
// each one: a default for everyone, then changes per person, as on AI options. The admin sees counts of people's own
// sources and calls, never what was asked. Mounted under /api/admin/data.
import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import { appSettings, dataSourceKeys, dataSources, users } from '@niko/db';
import { cleanActions, cleanDataAccess, cleanDataDefaults, sampleValues, type DataAction, type DataOffer } from '@niko/shared';
import type { AppEnv } from '../env';
import { audit, requireAdmin } from '../lib/session';
import { cleanInput, DATA_DEFAULTS_KEY, dataCalls, dataDefaults, DataProblem, forgetDataDefaults, infoOf, OM_KEY_SETTING, openMeteoKey, runAction, type SourceInput, type SourceRow } from '../datasources';
import { seal } from '../lib/crypto';
import { testActions } from './data';
import { removeDatasetsForAll } from '../datasets';

export const adminData = new Hono<AppEnv>();
adminData.use('*', requireAdmin);
type C = Context<AppEnv>;
const fail = (c: C, e: unknown) => { if (e instanceof DataProblem) return c.json({ error: e.message }, e.status); throw e; };

adminData.get('/', async (c) => {
  const db = c.get('db');
  const rows = await db.select().from(dataSources).where(isNull(dataSources.ownerId)).orderBy(dataSources.createdAt);
  const own = await db.select({ owner: dataSources.ownerId }).from(dataSources).where(isNotNull(dataSources.ownerId));
  const calls = await dataCalls(db);
  const ownIds = new Set(own.map((o) => o.owner));
  const people = await db.select({ id: users.id, name: users.name, email: users.email, role: users.role, status: users.status, dataAccess: users.dataAccess }).from(users).orderBy(users.createdAt);
  return c.json({
    defaults: await dataDefaults(db, true),
    openMeteo: { key: !!(await openMeteoKey(c.env, db)) },
    sources: rows.map((r) => ({ ...infoOf(r), calls: calls.bySource[r.id] ?? 0 })),
    own: { sources: own.length, people: ownIds.size, calls: Object.entries(calls.bySource).filter(([id]) => !rows.some((r) => r.id === id)).reduce((a, [, n]) => a + n, 0) },
    users: people.map((p) => ({ ...p, dataAccess: cleanDataAccess(p.dataAccess), calls: calls.byUser[p.id] ?? 0 })),
  });
});
async function adminSource(c: C): Promise<SourceRow | null> {
  const r = (await c.get('db').select().from(dataSources).where(eq(dataSources.id, c.req.param('id')!)).limit(1))[0];
  return r && !r.ownerId ? r : null;
}
adminData.post('/sources', async (c) => {
  try {
    const v = await cleanInput(c.env, await c.req.json<SourceInput>(), { admin: true });
    if (v.offer !== 'nobody' && !v.termsOk) v.offer = 'nobody';
    const [row] = await c.get('db').insert(dataSources).values({ ...v, ownerId: null } as typeof dataSources.$inferInsert).returning();
    await audit(c, 'data.source.add', { source: row!.name, offer: row!.offer }, c.get('user').id);
    return c.json({ ok: true, id: row!.id });
  } catch (e) { return fail(c, e); }
});
adminData.put('/sources/:id', async (c) => {
  const before = await adminSource(c);
  if (!before) return c.json({ error: 'No such source.' }, 404);
  try {
    const v = await cleanInput(c.env, await c.req.json<SourceInput>(), { admin: true, before });
    await c.get('db').update(dataSources).set(v).where(eq(dataSources.id, before.id));
    await audit(c, 'data.source.edit', { source: v.name, offer: v.offer, terms: v.termsOk ? 'ok' : 'not yet' }, c.get('user').id);
    return c.json({ ok: true });
  } catch (e) { return fail(c, e); }
});
adminData.delete('/sources/:id', async (c) => {
  const before = await adminSource(c);
  if (!before) return c.json({ error: 'No such source.' }, 404);
  await removeDatasetsForAll(c.env, c.get('db'), before.id);
  await c.get('db').delete(dataSources).where(eq(dataSources.id, before.id));
  await audit(c, 'data.source.remove', { source: before.name }, c.get('user').id);
  return c.json({ ok: true });
});
adminData.post('/test', async (c) => {
  const b = await c.req.json<{ id?: unknown; draft?: SourceInput }>().catch(() => ({} as { id?: unknown; draft?: SourceInput }));
  const db = c.get('db'), u = c.get('user');
  try {
    const before = typeof b.id === 'string' ? (await db.select().from(dataSources).where(eq(dataSources.id, b.id)).limit(1))[0] : undefined;
    if (before?.ownerId) return c.json({ error: 'No such source.' }, 404);
    if (!b.draft && !before) return c.json({ error: 'No such source.' }, 404);
    const row = b.draft ? { ...(before ?? {}), ...(await cleanInput(c.env, b.draft, { admin: true, before })), id: before?.id ?? crypto.randomUUID(), ownerId: null, updatedAt: new Date() } as SourceRow : before!;
    if (row.keyMode === 'own' && row.auth !== 'none') return c.json({ results: [], note: 'Each person adds their own key, so Niko tests it when they turn it on.' });
    const acts = cleanActions(row.actions) as DataAction[];
    return c.json({ results: await testActions((a) => runAction(c.env, db, u.id, row, a, sampleValues(a), 0, { test: true }), acts, { peek: true }) });
  } catch (e) { return fail(c, e); }
});

/** The default for everyone: which admin sources are on (sets who each is offered to), own sources, monthly calls. */
adminData.put('/default', async (c) => {
  const b = await c.req.json<{ own?: unknown; calls?: unknown; om?: unknown; wxFirst?: unknown; ds?: unknown; sources?: Record<string, unknown> }>().catch(() => ({} as Record<string, never>));
  const db = c.get('db');
  const d = cleanDataDefaults({ ...(await dataDefaults(db, true)), ...Object.fromEntries((['own', 'calls', 'om', 'wxFirst', 'ds'] as const).filter((k) => b[k] !== undefined).map((k) => [k, b[k]])) });
  await db.insert(appSettings).values({ key: DATA_DEFAULTS_KEY, value: d }).onConflictDoUpdate({ target: appSettings.key, set: { value: d } });
  forgetDataDefaults();
  const rows = await db.select().from(dataSources).where(isNull(dataSources.ownerId));
  const changed: string[] = [];
  for (const r of rows) {
    const want = b.sources?.[r.id];
    if (typeof want !== 'boolean') continue;
    if (want && !r.termsOk) return c.json({ error: `${r.name} needs its terms confirmed before anyone can use it.` }, 400);
    const offer: DataOffer = want ? 'everyone' : r.offer === 'everyone' ? 'chosen' : (r.offer as DataOffer);
    if (offer !== r.offer) { await db.update(dataSources).set({ offer }).where(eq(dataSources.id, r.id)); changed.push(`${r.name} ${want ? 'on' : 'off'}`); }
  }
  await audit(c, 'data.default', { own: d.own ? 'allowed' : 'not allowed', calls: d.calls || 'no limit', openMeteo: d.om ? 'on' : 'off', weatherFirst: d.wxFirst, sources: changed.join(', ') || 'unchanged' }, c.get('user').id);
  return c.json({ ok: true, defaults: d });
});
adminData.put('/users/:id', async (c) => {
  const b = await c.req.json<{ access?: unknown }>().catch(() => ({} as { access?: unknown }));
  const db = c.get('db');
  const target = (await db.select().from(users).where(eq(users.id, c.req.param('id'))).limit(1))[0];
  if (!target) return c.json({ error: 'No such user.' }, 404);
  const d = await dataDefaults(db, true);
  const rows = await db.select().from(dataSources).where(isNull(dataSources.ownerId));
  // A change that matches the default is not a change: only real differences are kept.
  const own = Object.fromEntries(Object.entries(cleanDataAccess(b.access)).filter(([k, v]) => {
    if (k === 'own') return v !== d.own;
    if (k === 'om') return v !== d.om;
    if (k === 'ds') return v !== d.ds;
    if (k === 'calls') return v !== d.calls;
    const r = rows.find((x) => `src:${x.id}` === k);
    return !!r && v !== (r.offer === 'everyone');
  }));
  await db.update(users).set({ dataAccess: own }).where(eq(users.id, target.id));
  await audit(c, 'data.user', { target: target.email, changes: Object.entries(own).map(([k, v]) => `${rows.find((r) => `src:${r.id}` === k)?.name ?? k} ${typeof v === 'boolean' ? (v ? 'on' : 'off') : v}`).join(', ') || 'follows the default' }, c.get('user').id);
  return c.json({ ok: true, access: own });
});

// ---------------------------------------------------------------- a person's keys, added in their setup
/** Sources where each person uses their own key: whether this person has one, and whether the admin added it. */
adminData.get('/users/:id/keys', async (c) => {
  const db = c.get('db'), id = c.req.param('id');
  const rows = (await db.select().from(dataSources).where(isNull(dataSources.ownerId))).filter((r) => r.keyMode === 'own' && r.auth !== 'none');
  const keys = await db.select({ sourceId: dataSourceKeys.sourceId, byAdmin: dataSourceKeys.byAdmin }).from(dataSourceKeys).where(eq(dataSourceKeys.userId, id));
  return c.json({ keys: rows.map((r) => { const k = keys.find((x) => x.sourceId === r.id); return { source: r.id, name: r.name, keyName: r.authName ?? 'key', key: k ? (k.byAdmin ? 'admin' : 'theirs') : null }; }) });
});
/** Adds or changes this person's key for a source, tested first. Their own key is never replaced. */
adminData.put('/users/:id/keys/:source', async (c) => {
  const db = c.get('db');
  const target = (await db.select().from(users).where(eq(users.id, c.req.param('id'))).limit(1))[0];
  const row = (await db.select().from(dataSources).where(and(eq(dataSources.id, c.req.param('source')), isNull(dataSources.ownerId))).limit(1))[0];
  if (!target || !row || row.keyMode !== 'own' || row.auth === 'none') return c.json({ error: 'That source doesn’t take a key for each person.' }, 404);
  const b = await c.req.json<{ key?: unknown }>().catch(() => ({} as { key?: unknown }));
  const key = typeof b.key === 'string' ? b.key.trim() : '';
  if (!key || key.length > 500 || /[\u0000-\u001f]/.test(key)) return c.json({ error: 'Enter the key.' }, 400);
  const have = (await db.select().from(dataSourceKeys).where(and(eq(dataSourceKeys.sourceId, row.id), eq(dataSourceKeys.userId, target.id))).limit(1))[0];
  if (have && !have.byAdmin) return c.json({ error: 'They’ve added their own key, so theirs is used.' }, 409);
  const keyEnc = await seal(c.env.ENCRYPTION_KEY, key);
  await db.insert(dataSourceKeys).values({ sourceId: row.id, userId: target.id, keyEnc, byAdmin: true }).onConflictDoUpdate({ target: [dataSourceKeys.sourceId, dataSourceKeys.userId], set: { keyEnc, byAdmin: true } });
  await audit(c, 'data.user-key', { target: target.email, source: row.name, change: have ? 'changed' : 'added' }, c.get('user').id);
  return c.json({ ok: true });
});
/** Tries a key typed for a person on the source's first action, without saving it. */
adminData.post('/users/:id/keys/:source/test', async (c) => {
  const db = c.get('db'), u = c.get('user');
  const row = (await db.select().from(dataSources).where(and(eq(dataSources.id, c.req.param('source')), isNull(dataSources.ownerId))).limit(1))[0];
  if (!row || row.keyMode !== 'own' || row.auth === 'none') return c.json({ error: 'That source doesn’t take a key for each person.' }, 404);
  const b = await c.req.json<{ key?: unknown }>().catch(() => ({} as { key?: unknown }));
  const key = typeof b.key === 'string' ? b.key.trim() : '';
  if (!key || key.length > 500) return c.json({ error: 'Enter the key.' }, 400);
  const acts = (cleanActions(row.actions) as DataAction[]).filter((a) => a.on !== false).slice(0, 1);
  const trial = { ...row, keyMode: 'one', keyEnc: await seal(c.env.ENCRYPTION_KEY, key) } as SourceRow;
  try { return c.json({ results: await testActions((a) => runAction(c.env, db, u.id, trial, a, sampleValues(a), 0, { test: true }), acts) }); }
  catch (e) { return fail(c, e); }
});
adminData.delete('/users/:id/keys/:source', async (c) => {
  const db = c.get('db'), id = c.req.param('id'), source = c.req.param('source');
  const gone = await db.delete(dataSourceKeys).where(and(eq(dataSourceKeys.sourceId, source), eq(dataSourceKeys.userId, id), eq(dataSourceKeys.byAdmin, true))).returning({ s: dataSourceKeys.sourceId });
  if (gone.length) await audit(c, 'data.user-key', { target: id, source, change: 'removed' }, c.get('user').id);
  return c.json({ ok: true });
});

/** Open-Meteo's paid plan key: Niko then uses Open-Meteo's customer API (its terms ask a paid service for it). Empty removes it. */
adminData.put('/open-meteo', async (c) => {
  const b = await c.req.json<{ key?: unknown }>().catch(() => ({} as { key?: unknown }));
  const key = typeof b.key === 'string' ? b.key.trim().slice(0, 200) : '';
  const db = c.get('db');
  if (key) await db.insert(appSettings).values({ key: OM_KEY_SETTING, value: { keyEnc: await seal(c.env.ENCRYPTION_KEY, key) } }).onConflictDoUpdate({ target: appSettings.key, set: { value: { keyEnc: await seal(c.env.ENCRYPTION_KEY, key) } } });
  else await db.delete(appSettings).where(eq(appSettings.key, OM_KEY_SETTING));
  await audit(c, 'data.open-meteo.key', { key: key ? 'added' : 'removed' }, c.get('user').id);
  return c.json({ ok: true, key: !!key });
});
