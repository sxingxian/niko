// Data sources on the server: who may use which, keys (sealed, never sent to the browser), running one read-only
// action with every value checked, a short shared cache for answers that hold nothing personal, and the monthly number
// of calls. Nothing is built in: a fresh install has no sources until the admin or a person adds one.
import { and, eq, isNull, or, sql } from 'drizzle-orm';
import { appSettings, dataSourceKeys, dataSources, usageCounts, type Db } from '@niko/db';
import {
  actionUrl, checkValues, cleanActions, cleanBaseUrl, cleanDataAccess, cleanDataDefaults, cleanDataPrefs, dataAllowed, DATA_CACHE_S, DATA_LIMITS,
  resultText, type DataAction, type DataAuth, type DataDefaults, type DataKeyMode, type DataOffer, type DataSourceInfo, type DataUse,
} from '@niko/shared';
import type { Env } from './env';
import { seal, sha256, unseal } from './lib/crypto';
import { FetchProblem, safeGet } from './safefetch';
import { monthOf, resetText } from './usage';

export type SourceRow = typeof dataSources.$inferSelect;
export const DATA_DEFAULTS_KEY = 'data-defaults';
export class DataProblem extends Error { constructor(message: string, readonly status: 400 | 403 | 404 | 429 | 502 = 400) { super(message); } }

let kept: { at: number; v: DataDefaults } | null = null;
export async function dataDefaults(db: Db, fresh = false): Promise<DataDefaults> {
  if (!fresh && kept && Date.now() - kept.at < 30_000) return kept.v;
  const row = (await db.select().from(appSettings).where(eq(appSettings.key, DATA_DEFAULTS_KEY)).limit(1).catch(() => []))[0];
  kept = { at: Date.now(), v: cleanDataDefaults(row?.value) };
  return kept.v;
}
export const forgetDataDefaults = () => { kept = null; };

const actionsOf = (r: SourceRow): DataAction[] => { const a = cleanActions(r.actions); return 'problem' in a ? [] : a; };
export function infoOf(r: SourceRow, hasOwnKey = false): DataSourceInfo {
  return {
    id: r.id, name: r.name, use: r.useAs as DataUse, baseUrl: r.baseUrl, auth: r.auth as DataAuth, authName: r.authName, keyMode: r.keyMode as DataKeyMode,
    actions: actionsOf(r), termsOk: r.termsOk, termsNote: r.termsNote, attribution: r.attribution, offer: r.offer as DataOffer, own: !!r.ownerId,
    hasKey: r.ownerId || r.keyMode === 'one' ? !!r.keyEnc : hasOwnKey,
  };
}

type Who = { id: string; role: string; dataAccess?: unknown; dataPrefs?: unknown };
/** Every source this person can see, with what they may do: admin sources allowed to them, and their own sources. */
export async function sourcesFor(db: Db, user: Who) {
  const rows = await db.select().from(dataSources).where(or(isNull(dataSources.ownerId), eq(dataSources.ownerId, user.id))).orderBy(dataSources.createdAt);
  const admin = rows.filter((r) => !r.ownerId), mine = rows.filter((r) => r.ownerId === user.id);
  const allowed = dataAllowed(await dataDefaults(db), cleanDataAccess(user.dataAccess), admin.map((r) => ({ id: r.id, offer: r.offer as DataOffer, termsOk: r.termsOk })), user.role === 'admin');
  const prefs = cleanDataPrefs(user.dataPrefs);
  const ownKeys = new Set((await db.select({ id: dataSourceKeys.sourceId }).from(dataSourceKeys).where(eq(dataSourceKeys.userId, user.id))).map((k) => k.id));
  const offered = admin.filter((r) => allowed.src[r.id]);
  return {
    allowed, prefs,
    /** Admin sources in their plan: turned on by them, or not yet. */
    offered: offered.map((r) => ({ row: r, info: infoOf(r, ownKeys.has(r.id)), on: prefs.on.includes(r.id) })),
    /** Their own sources: usable only while the plan lets them add their own. */
    mine: mine.map((r) => ({ row: r, info: infoOf(r), on: allowed.own })),
  };
}
/** The sources a question may use, with only the actions that are on, numbered D1, D2… for the AI. */
export async function usableFor(db: Db, user: Who) {
  const s = await sourcesFor(db, user);
  const list = [...s.offered.filter((x) => x.on && (x.info.auth === 'none' || x.info.hasKey)), ...s.mine.filter((x) => x.on)];
  const sources = list.map((x) => ({ row: x.row, name: x.info.name, attribution: x.info.attribution, actions: x.info.actions.filter((a) => a.on && !s.prefs.actionsOff.includes(`${x.row.id}:${a.id}`)) }))
    .filter((x) => x.actions.length).slice(0, DATA_LIMITS.sources).map((x, i) => ({ ...x, tag: `D${i + 1}` }));
  return { sources, calls: s.allowed.calls };
}

// ---------------------------------------------------------------- saving
export interface SourceInput { name?: unknown; use?: unknown; baseUrl?: unknown; auth?: unknown; authName?: unknown; keyMode?: unknown; key?: unknown; actions?: unknown; termsOk?: unknown; termsNote?: unknown; attribution?: unknown; offer?: unknown }
const str = (v: unknown, max: number) => (typeof v === 'string' ? v : '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
/** Checks a source as typed. `before` is the saved one: its key is kept unless a new one is given, and dropped when the
 *  address moves to another site (so a key is never sent somewhere it wasn't meant for). */
export async function cleanInput(env: Env, b: SourceInput, opts: { admin: boolean; before?: SourceRow }): Promise<Partial<typeof dataSources.$inferInsert>> {
  const name = str(b.name, DATA_LIMITS.name);
  if (!name) throw new DataProblem('Give it a name.');
  const base = cleanBaseUrl(b.baseUrl);
  if ('problem' in base) throw new DataProblem(base.problem);
  const actions = cleanActions(b.actions);
  if ('problem' in actions) throw new DataProblem(actions.problem);
  if (!actions.length) throw new DataProblem('Add at least one thing Niko can ask.');
  const auth: DataAuth = b.auth === 'header' || b.auth === 'query' ? b.auth : 'none';
  const authName = auth === 'none' ? '' : str(b.authName, 60);
  if (auth !== 'none' && !/^[A-Za-z0-9_.-]{1,60}$/.test(authName)) throw new DataProblem(auth === 'header' ? 'Enter the header’s name, such as X-Api-Key.' : 'Enter the name the key goes by in the address, such as api_key.');
  const keyMode: DataKeyMode = opts.admin && b.keyMode === 'own' ? 'own' : 'one';
  const key = str(b.key, 500);
  const moved = opts.before && new URL(opts.before.baseUrl).origin !== new URL(base.url).origin;
  let keyEnc: string | null = opts.before && !moved ? opts.before.keyEnc : null;
  if (key) keyEnc = await seal(env.ENCRYPTION_KEY, key);
  if (auth === 'none' || keyMode === 'own') keyEnc = null;
  const use: DataUse = b.use === 'live' ? 'live' : 'general';
  const offer: DataOffer = b.offer === 'everyone' || b.offer === 'chosen' ? b.offer : 'nobody';
  return {
    name, useAs: use, baseUrl: base.url, auth, authName, keyMode, keyEnc, actions: actions as unknown as unknown[],
    termsOk: b.termsOk === true, termsNote: str(b.termsNote, DATA_LIMITS.note), attribution: str(b.attribution, 120), offer: opts.admin ? offer : 'nobody', updatedAt: new Date(),
  };
}

// ---------------------------------------------------------------- running an action
async function keyFor(env: Env, db: Db, row: SourceRow, userId: string): Promise<{ key: string | null; personal: boolean }> {
  if (row.auth === 'none') return { key: null, personal: !!row.ownerId };
  if (row.ownerId || row.keyMode === 'one') return { key: await unseal<string>(env.ENCRYPTION_KEY, row.keyEnc).catch(() => null), personal: !!row.ownerId };
  const k = (await db.select().from(dataSourceKeys).where(and(eq(dataSourceKeys.sourceId, row.id), eq(dataSourceKeys.userId, userId))).limit(1))[0];
  return { key: k ? await unseal<string>(env.ENCRYPTION_KEY, k.keyEnc).catch(() => null) : null, personal: true };
}
const edge = () => (globalThis as { caches?: { default?: Cache } }).caches?.default;

export interface DataResult { text: string; at: number; source: string; attribution: string; cached: boolean }
/** Runs one action. `limit` is the person's monthly calls (0: no limit); cached answers aren't counted. */
export async function runAction(env: Env, db: Db, userId: string, row: SourceRow, action: DataAction, given: Record<string, unknown>, limit: number, opts: { test?: boolean } = {}): Promise<DataResult> {
  const checked = checkValues(action, given);
  if ('problem' in checked) throw new DataProblem(checked.problem);
  const { key, personal } = await keyFor(env, db, row, userId);
  if (row.auth !== 'none' && !key) throw new DataProblem(row.keyMode === 'own' && !row.ownerId ? `${row.name} needs your key first.` : `${row.name} has no key saved.`);
  let url = actionUrl(row.baseUrl, action, checked.values);
  const headers: Record<string, string> = {};
  if (row.auth === 'header' && key) headers[row.authName] = key;
  if (row.auth === 'query' && key) { const u = new URL(url); u.searchParams.set(row.authName, key); url = u.toString(); }
  // Answers from the admin's own key (or no key) hold nothing personal and are shared briefly; others are per person.
  const scope = personal ? userId : 'shared';
  const ck = new Request(`https://niko-cache.invalid/data/${await sha256(`${row.id}|${row.updatedAt.getTime()}|${action.id}|${JSON.stringify(checked.values)}|${scope}`)}`);
  if (!opts.test) {
    const hit = await edge()?.match(ck).catch(() => undefined);
    if (hit) { const j = await hit.json() as { text: string; at: number }; return { ...j, source: row.name, attribution: row.attribution, cached: true }; }
    if (limit > 0) {
      const used = (await db.select({ n: sql<number>`coalesce(sum(${usageCounts.n}), 0)` }).from(usageCounts).where(and(eq(usageCounts.userId, userId), eq(usageCounts.month, monthOf()), eq(usageCounts.kind, 'data'))))[0]?.n ?? 0;
      if (Number(used) >= limit) throw new DataProblem(`You’ve used this month’s ${limit.toLocaleString('en')} data calls. They come back on ${resetText()}.`, 429);
    }
  }
  let got;
  try { got = await safeGet(url, headers); }
  catch (e) { throw new DataProblem(e instanceof FetchProblem ? e.message : 'The source couldn’t be reached.', 502); }
  const text = resultText(got.body, got.kind), at = Date.now();
  await db.execute(sql`insert into usage_counts (user_id, month, kind, entry, n) values (${userId}, ${monthOf()}, 'data', ${row.id}, 1)
    on conflict (user_id, month, kind, entry) do update set n = usage_counts.n + 1`).catch(() => undefined);
  if (!opts.test) await edge()?.put(ck, new Response(JSON.stringify({ text, at }), { headers: { 'cache-control': `max-age=${action.live ? DATA_CACHE_S.live : DATA_CACHE_S.other}` } })).catch(() => undefined);
  return { text, at, source: row.name, attribution: row.attribution, cached: false };
}
/** Data calls this month: for one person, or per person (admin), and per source. */
export async function dataCalls(db: Db, userId?: string): Promise<{ byUser: Record<string, number>; bySource: Record<string, number> }> {
  const rows = await db.select().from(usageCounts).where(userId ? and(eq(usageCounts.month, monthOf()), eq(usageCounts.kind, 'data'), eq(usageCounts.userId, userId)) : and(eq(usageCounts.month, monthOf()), eq(usageCounts.kind, 'data'))).catch(() => []);
  const byUser: Record<string, number> = {}, bySource: Record<string, number> = {};
  for (const r of rows) { byUser[r.userId] = (byUser[r.userId] ?? 0) + r.n; bySource[r.entry] = (bySource[r.entry] ?? 0) + r.n; }
  return { byUser, bySource };
}
