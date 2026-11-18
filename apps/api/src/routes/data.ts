// Engine · Data sources: what this person's plan includes, turning those on, their own key where a source asks for
// one, switching single actions off, and adding their own sources (only when their plan allows it). Mounted under
// /api/data after sign-in. Keys are never sent back.
import { and, eq } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import { dataSourceKeys, dataSources, users } from '@niko/db';
import { cleanActions, cleanDataPrefs, DATA_LIMITS, sampleValues, type DataAction } from '@niko/shared';
import type { AppEnv } from '../env';
import { audit, tooMany } from '../lib/session';
import { seal } from '../lib/crypto';
import { datasetsOf, datasetsOk, importDataset, removeDatasets } from '../datasets';
import { KnError } from '../knowledge';
import { cleanInput, DataProblem, dataCalls, liveFor, runAction, saveLive, saveWeather, sourcesFor, weatherFor, type SourceInput, type SourceRow } from '../datasources';
import { credentials } from '../providers';
import { geocode } from '../weather';

export const data = new Hono<AppEnv>();
type C = Context<AppEnv>;
const fail = (c: C, e: unknown) => { if (e instanceof DataProblem) return c.json({ error: e.message }, e.status); if (e instanceof KnError) return c.json({ error: e.message }, e.status); throw e; };
const later = (c: C, p: Promise<unknown>) => { try { c.executionCtx.waitUntil(p.catch(() => undefined)); } catch { void p.catch(() => undefined); } };
const NOT_ON = 'That isn’t included in your plan.';

data.get('/', async (c) => {
  const u = c.get('user');
  const s = await sourcesFor(c.get('db'), u);
  const used = (await dataCalls(c.get('db'), u.id)).byUser[u.id] ?? 0;
  const ds = await datasetsOf(c.get('db'), u.id);
  return c.json({
    canAdd: s.allowed.own, calls: { limit: s.allowed.calls, used },
    datasets: { ok: !!(await datasetsOk(c.env, c.get('db'), u).catch(() => null)), kept: ds.map((d) => ({ source: d.sourceId, action: d.actionId, at: d.fetchedAt?.getTime() ?? null, rows: d.rows, problem: d.problem })) },
    offered: s.offered.map((x) => ({ ...x.info, on: x.on })),
    mine: s.allowed.own || s.mine.length ? s.mine.map((x) => ({ ...x.info, on: x.on })) : [],
    actionsOff: s.prefs.actionsOff,
  });
});

async function savePrefs(c: C, change: (p: ReturnType<typeof cleanDataPrefs>) => void) {
  const u = c.get('user');
  const fresh = (await c.get('db').select({ p: users.dataPrefs }).from(users).where(eq(users.id, u.id)).limit(1))[0];
  const p = cleanDataPrefs(fresh?.p);
  change(p);
  await c.get('db').update(users).set({ dataPrefs: p as unknown as Record<string, unknown> }).where(eq(users.id, u.id));
  return p;
}
/** Turns a source included in the plan on or off for this person. A source that asks for their own key takes it here. */
data.put('/included/:id', async (c) => {
  const b = await c.req.json<{ on?: unknown; key?: unknown }>().catch(() => ({} as { on?: unknown; key?: unknown }));
  const u = c.get('user'), db = c.get('db');
  const s = await sourcesFor(db, u);
  const it = s.offered.find((x) => x.row.id === c.req.param('id'));
  if (!it) return c.json({ error: NOT_ON }, 403);
  const key = typeof b.key === 'string' ? b.key.trim().slice(0, 500) : '';
  if (key && it.row.keyMode === 'own' && it.row.auth !== 'none') {
    const keyEnc = await seal(c.env.ENCRYPTION_KEY, key);
    await db.insert(dataSourceKeys).values({ sourceId: it.row.id, userId: u.id, keyEnc }).onConflictDoUpdate({ target: [dataSourceKeys.sourceId, dataSourceKeys.userId], set: { keyEnc } });
  }
  const on = b.on === true;
  if (on && it.row.keyMode === 'own' && it.row.auth !== 'none' && !key && !it.info.hasKey) return c.json({ error: `${it.row.name} needs your key.` }, 400);
  await savePrefs(c, (p) => { p.on = on ? [...new Set([...p.on, it.row.id])] : p.on.filter((x) => x !== it.row.id); });
  // Datasets: fetched into Knowledge when turned on (in the background), removed when turned off.
  if (on) importAll(c, it.row, it.info.actions);
  else await removeDatasets(c.env, db, u.id, it.row.id);
  if (!on && it.row.keyMode === 'own') await db.delete(dataSourceKeys).where(and(eq(dataSourceKeys.sourceId, it.row.id), eq(dataSourceKeys.userId, u.id)));
  await audit(c, on ? 'data.on' : 'data.off', { source: it.row.name }, u.id);
  return c.json({ ok: true });
});
/** Switches one thing Niko can ask a source off (or back on) for this person. */
data.put('/actions', async (c) => {
  const b = await c.req.json<{ source?: unknown; action?: unknown; on?: unknown }>().catch(() => ({} as Record<string, unknown>));
  const s = await sourcesFor(c.get('db'), c.get('user'));
  const src = [...s.offered, ...s.mine].find((x) => x.row.id === b.source);
  const a = src?.info.actions.find((x) => x.id === b.action);
  if (!src || !a) return c.json({ error: 'No such source.' }, 404);
  const k = `${src.row.id}:${a.id}`;
  const p = await savePrefs(c, (p) => { p.actionsOff = b.on === false ? [...new Set([...p.actionsOff, k])] : p.actionsOff.filter((x) => x !== k); });
  return c.json({ ok: true, actionsOff: p.actionsOff });
});

// ---------------------------------------------------------------- their own sources
async function mineOr404(c: C): Promise<SourceRow | null> {
  return (await c.get('db').select().from(dataSources).where(and(eq(dataSources.id, c.req.param('id')!), eq(dataSources.ownerId, c.get('user').id))).limit(1))[0] ?? null;
}
const canAdd = async (c: C) => (await sourcesFor(c.get('db'), c.get('user'))).allowed.own;
data.post('/sources', async (c) => {
  if (!(await canAdd(c))) return c.json({ error: NOT_ON }, 403);
  if (await tooMany(c, `data-add:${c.get("user").id}`, 20, 60)) return c.json({ error: 'Too many sources added in an hour. Try again later.' }, 429);
  const db = c.get('db'), u = c.get('user');
  const count = (await db.select({ id: dataSources.id }).from(dataSources).where(eq(dataSources.ownerId, u.id))).length;
  if (count >= DATA_LIMITS.sources) return c.json({ error: `You can add up to ${DATA_LIMITS.sources} sources.` }, 400);
  try {
    const v = await cleanInput(c.env, await c.req.json<SourceInput>(), { admin: false });
    if (v.termsOk !== true) return c.json({ error: 'Confirm that the source’s terms let you use it this way.' }, 400);
    const [row] = await db.insert(dataSources).values({ ...v, ownerId: u.id } as typeof dataSources.$inferInsert).returning();
    importAll(c, row!, cleanActions(row!.actions) as DataAction[]);
    await audit(c, 'data.own.add', { source: row!.name }, u.id);
    return c.json({ ok: true, id: row!.id });
  } catch (e) { return fail(c, e); }
});
data.put('/sources/:id', async (c) => {
  if (!(await canAdd(c))) return c.json({ error: NOT_ON }, 403);
  const before = await mineOr404(c);
  if (!before) return c.json({ error: 'No such source.' }, 404);
  try {
    const v = await cleanInput(c.env, await c.req.json<SourceInput>(), { admin: false, before });
    await c.get('db').update(dataSources).set(v).where(eq(dataSources.id, before.id));
    await audit(c, 'data.own.edit', { source: v.name }, c.get('user').id);
    return c.json({ ok: true });
  } catch (e) { return fail(c, e); }
});
data.delete('/sources/:id', async (c) => {
  const before = await mineOr404(c);
  if (!before) return c.json({ error: 'No such source.' }, 404);
  await removeDatasets(c.env, c.get('db'), c.get('user').id, before.id);
  await c.get('db').delete(dataSources).where(eq(dataSources.id, before.id));
  await audit(c, 'data.own.remove', { source: before.name }, c.get('user').id);
  return c.json({ ok: true });
});

/** Tests each action with its sample values: a saved source (`id`, admin sources included in their plan or their
 *  own), or a draft of their own before it is saved. The answers themselves aren't sent back, only whether it worked. */
export async function testActions(run: (a: DataAction) => Promise<unknown>, actions: DataAction[]) {
  return Promise.all(actions.slice(0, 10).map(async (a) => {
    const t0 = Date.now();
    try { await run(a); return { action: a.id, name: a.name, ok: true, ms: Date.now() - t0 }; }
    catch (e) { return { action: a.id, name: a.name, ok: false, problem: e instanceof DataProblem ? e.message : 'The test didn’t work.' }; }
  }));
}
data.post('/test', async (c) => {
  const u = c.get('user'), db = c.get('db');
  if (await tooMany(c, `data-test:${u.id}`, 30, 10)) return c.json({ error: 'Too many tests. Try again in a few minutes.' }, 429);
  const b = await c.req.json<{ id?: unknown; draft?: SourceInput }>().catch(() => ({} as { id?: unknown; draft?: SourceInput }));
  try {
    if (b.draft) {
      if (!(await canAdd(c))) return c.json({ error: NOT_ON }, 403);
      const before = typeof b.id === 'string' ? (await db.select().from(dataSources).where(and(eq(dataSources.id, b.id), eq(dataSources.ownerId, u.id))).limit(1))[0] : undefined;
      const v = await cleanInput(c.env, { ...b.draft, termsOk: true }, { admin: false, before });
      const row = { ...(before ?? {}), ...v, id: before?.id ?? crypto.randomUUID(), ownerId: u.id, updatedAt: new Date() } as SourceRow;
      const acts = cleanActions(v.actions) as DataAction[];
      return c.json({ results: await testActions((a) => runAction(c.env, db, u.id, row, a, sampleValues(a), 0, { test: true }), acts) });
    }
    const s = await sourcesFor(db, u);
    const src = [...s.offered, ...s.mine].find((x) => x.row.id === b.id);
    if (!src) return c.json({ error: 'No such source.' }, 404);
    return c.json({ results: await testActions((a) => runAction(c.env, db, u.id, src.row, a, sampleValues(a), 0, { test: true }), src.info.actions) });
  } catch (e) { return fail(c, e); }
});

// ---------------------------------------------------------------- Connections · Weather
const legacy = (c: C) => () => credentials(c.env, c.get('db'), c.get('user').id, 'open-meteo') as Promise<{ home?: string; units?: string } | null>;
data.get('/weather', async (c) => c.json(await weatherFor(c.env, c.get('db'), c.get('user'), legacy(c))));
/** Saves the order, which sources are on, the home place (checked now), units and location. */
data.put('/weather', async (c) => {
  const b = await c.req.json<{ order?: unknown; off?: unknown; home?: unknown; units?: unknown; location?: unknown }>().catch(() => ({} as Record<string, unknown>));
  const u = c.get('user'), db = c.get('db');
  const now = await weatherFor(c.env, db, u, legacy(c));
  const ids = now.list.map((x) => x.id);
  const pick = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && ids.includes(x)) : undefined);
  let home = typeof b.home === 'string' ? b.home.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 120) : now.home;
  if (home && home !== now.home) {
    let place;
    try { place = await geocode(home); } catch { return c.json({ error: 'The weather service couldn’t be reached to check the place. Try again in a moment.' }, 502); }
    if (!place) return c.json({ error: `No place called “${home}” was found. Try a city name, such as Singapore or Paris, France.` }, 400);
    home = place.name;
  }
  const order = pick(b.order) ?? now.list.map((x) => x.id);
  await saveWeather(db, u.id, { order: [...order, ...ids.filter((x) => !order.includes(x))], off: pick(b.off) ?? now.list.filter((x) => !x.on).map((x) => x.id), home, units: b.units === 'F' ? 'F' : b.units === 'C' ? 'C' : now.units, location: typeof b.location === 'boolean' ? b.location : now.location });
  return c.json(await weatherFor(c.env, db, u));
});

// ---------------------------------------------------------------- Engine · Live info
data.get('/live', async (c) => c.json(await liveFor(c.get('db'), c.get('user'))));
/** Saves the order for everywhere and each country (only live services they can use) and their places. */
data.put('/live', async (c) => {
  const b = await c.req.json<{ everywhere?: unknown; countries?: unknown; places?: unknown }>().catch(() => ({} as Record<string, unknown>));
  const db = c.get('db'), u = c.get('user');
  const now = await liveFor(db, u);
  const ids = now.services.map((x) => x.id);
  const keep = (l: unknown) => (Array.isArray(l) ? l.filter((x): x is string => typeof x === 'string' && ids.includes(x)) : []);
  const countries = b.countries && typeof b.countries === 'object' ? Object.fromEntries(Object.entries(b.countries as Record<string, unknown>).map(([cc, l]) => [cc.toUpperCase(), keep(l)])) : now.countries;
  await saveLive(db, u.id, { everywhere: b.everywhere !== undefined ? keep(b.everywhere) : now.everywhere, countries, places: b.places !== undefined ? b.places as never : now.places });
  return c.json(await liveFor(db, u));
});

// ---------------------------------------------------------------- datasets in Knowledge
function importAll(c: C, row: SourceRow, actions: DataAction[]) {
  const sets = actions.filter((a) => a.on && a.dataset);
  if (!sets.length) return;
  const u = c.get('user'), db = c.get('db');
  later(c, (async () => {
    const k = await datasetsOk(c.env, db, u);
    if (!k) return;
    for (const a of sets.slice(0, 3)) await importDataset(c.env, db, u, k, row, a).catch((e) => console.warn(`dataset: ${String((e as Error)?.message ?? e).slice(0, 160)}`));
  })());
}
/** Fetches one dataset into Knowledge now (Import now / Refresh now). */
data.post('/datasets/:source/:action', async (c) => {
  const u = c.get('user'), db = c.get('db');
  if (await tooMany(c, `data-ds:${u.id}`, 20, 60)) return c.json({ error: 'Too many imports in an hour. Try again later.' }, 429);
  const k = await datasetsOk(c.env, db, u);
  if (!k) return c.json({ error: 'Datasets need Knowledge files kept in Niko.' }, 403);
  const s = await sourcesFor(db, u);
  const src = [...s.offered.filter((x) => x.on), ...s.mine.filter((x) => x.on)].find((x) => x.row.id === c.req.param('source'));
  const act = src?.info.actions.find((a) => a.id === c.req.param('action') && a.on && a.dataset);
  if (!src || !act) return c.json({ error: 'No such dataset.' }, 404);
  try { const r = await importDataset(c.env, db, u, k, src.row, act); await audit(c, 'data.dataset', { source: src.row.name, action: act.name, rows: r.rows }, u.id); return c.json({ ok: true, rows: r.rows }); }
  catch (e) { return fail(c, e); }
});
