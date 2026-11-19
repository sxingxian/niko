// Data sources on the server: who may use which, keys (sealed, never sent to the browser), running one read-only
// action with every value checked, a short shared cache for answers that hold nothing personal, and the monthly number
// of calls. Nothing is built in: a fresh install has no sources until the admin or a person adds one.
import { and, eq, isNull, or, sql } from 'drizzle-orm';
import { appSettings, dataSourceKeys, dataSources, usageCounts, users, type Db } from '@niko/db';
import {
  actionUrl, checkValues, cleanActions, cleanLivePrefs, liveSuggestions, noteSeen, type LivePrefs, cleanWeatherPrefs, OPEN_METEO, weatherOrder, type WeatherPrefs, cleanBaseUrl, cleanDataAccess, cleanDataDefaults, cleanDataPrefs, dataAllowed, DATA_CACHE_S, DATA_LIMITS,
  actionBody, cleanHeaders, cleanToken, type DataHeader, type DataToken,
  resultText, type DataAction, type DataAuth, type DataDefaults, type DataKeyMode, type DataOffer, type DataSourceInfo, type DataUse,
} from '@niko/shared';
import type { Env } from './env';
import { seal, sha256, unseal } from './lib/crypto';
import { FetchProblem, safeFetch } from './safefetch';
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
/** Sealed with a source: secret header values, and the token's ID and secret. */
type Secrets = { h?: Record<string, string>; id?: string; secret?: string };
/** The other headers as saved: plain ones with their value, secret ones by name only. */
const headersOf = (r: SourceRow): DataHeader[] => (Array.isArray(r.headers) ? r.headers : []).flatMap((x) => {
  const h = x as { name?: unknown; secret?: unknown; value?: unknown };
  return typeof h.name === 'string' ? [h.secret === true ? { name: h.name, secret: true } : { name: h.name, secret: false, value: typeof h.value === 'string' ? h.value : '' }] : [];
});
const tokenOf = (r: SourceRow): DataToken | null => { if (r.auth !== 'token' || !r.token) return null; const t = cleanToken(r.token); return 'problem' in t ? null : t; };
export function infoOf(r: SourceRow, hasOwnKey = false): DataSourceInfo {
  return {
    id: r.id, name: r.name, use: r.useAs as DataUse, baseUrl: r.baseUrl, auth: r.auth as DataAuth, authName: r.authName, keyMode: r.keyMode as DataKeyMode,
    actions: actionsOf(r), termsOk: r.termsOk, termsNote: r.termsNote, attribution: r.attribution, offer: r.offer as DataOffer, own: !!r.ownerId,
    hasKey: r.auth === 'token' ? !!r.secretsEnc : r.ownerId || r.keyMode === 'one' ? !!r.keyEnc : hasOwnKey,
    headers: headersOf(r).map((h) => (h.secret ? { ...h, saved: !!r.secretsEnc } : h)), token: tokenOf(r), tokenSaved: r.auth === 'token' && !!r.secretsEnc,
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
export interface SourceInput { headers?: unknown; token?: unknown; tokenId?: unknown; tokenSecret?: unknown; name?: unknown; use?: unknown; baseUrl?: unknown; auth?: unknown; authName?: unknown; keyMode?: unknown; key?: unknown; actions?: unknown; termsOk?: unknown; termsNote?: unknown; attribution?: unknown; offer?: unknown }
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
  const auth: DataAuth = b.auth === 'header' || b.auth === 'query' || b.auth === 'token' ? b.auth : 'none';
  const authName = auth === 'header' || auth === 'query' ? str(b.authName, 60) : '';
  if ((auth === 'header' || auth === 'query') && !/^[A-Za-z0-9_.-]{1,60}$/.test(authName)) throw new DataProblem(auth === 'header' ? 'Enter the header’s name, such as X-Api-Key.' : 'Enter the name the key goes by in the address, such as api_key.');
  // Signing in for a token uses one ID and secret for everyone it's offered to.
  const keyMode: DataKeyMode = opts.admin && b.keyMode === 'own' && auth !== 'token' ? 'own' : 'one';
  const key = str(b.key, 500);
  const moved = opts.before && new URL(opts.before.baseUrl).origin !== new URL(base.url).origin;
  let keyEnc: string | null = opts.before && !moved ? opts.before.keyEnc : null;
  if (key) keyEnc = await seal(env.ENCRYPTION_KEY, key);
  if (auth === 'none' || auth === 'token' || keyMode === 'own') keyEnc = null;
  // Other headers, and signing in for a token. Secret values are kept unless new ones are given, and dropped when the
  // address (or the token address) moves to another site, like the key.
  const hs = cleanHeaders(b.headers, auth === 'header' ? [authName] : []);
  if ('problem' in hs) throw new DataProblem(hs.problem);
  let token: DataToken | null = null;
  if (auth === 'token') { const t = cleanToken(b.token); if ('problem' in t) throw new DataProblem(t.problem); token = t; if (hs.some((h) => h.name.toLowerCase() === t.header.toLowerCase())) throw new DataProblem(`${t.header} is where the token goes, so it can’t be another header too.`); }
  const prev: Secrets = opts.before?.secretsEnc ? (await unseal<Secrets>(env.ENCRYPTION_KEY, opts.before.secretsEnc).catch(() => null)) ?? {} : {};
  const prevToken = opts.before ? tokenOf(opts.before) : null;
  const tokenMoved = !prevToken || !token || new URL(prevToken.url).origin !== new URL(token.url).origin;
  const typed = new Map((Array.isArray(b.headers) ? b.headers : []).map((x) => { const h = x as { name?: unknown; value?: unknown }; return [str(h.name, 60), typeof h.value === 'string' ? h.value.replace(/[\r\n]/g, '').trim().slice(0, 1000) : ''] as const; }));
  const secrets: Secrets = {};
  for (const h of hs) if (h.secret) {
    const v = typed.get(h.name) || (!moved ? prev.h?.[h.name] : undefined);
    if (!v) throw new DataProblem(`Enter the value for ${h.name}.`);
    (secrets.h ??= {})[h.name] = v;
  }
  if (token) {
    const id = str(b.tokenId, 500) || (!tokenMoved ? prev.id ?? '' : '');
    const secret = (typeof b.tokenSecret === 'string' ? b.tokenSecret.replace(/[\r\n]/g, '').slice(0, 500) : '') || (!tokenMoved ? prev.secret ?? '' : '');
    if (!id || !secret) throw new DataProblem(token.style === 'client' ? 'Enter the client ID and secret.' : 'Enter the email and password.');
    secrets.id = id; secrets.secret = secret;
  }
  const secretsEnc = secrets.h || secrets.id ? await seal(env.ENCRYPTION_KEY, secrets) : null;
  const headers = hs.map((h) => (h.secret ? { name: h.name, secret: true } : { name: h.name, secret: false, value: h.value ?? '' }));
  const use: DataUse = b.use === 'live' || b.use === 'weather' ? b.use : 'general';
  const offer: DataOffer = b.offer === 'everyone' || b.offer === 'chosen' ? b.offer : 'nobody';
  return {
    name, useAs: use, baseUrl: base.url, auth, authName, keyMode, keyEnc, headers, token, secretsEnc, actions: actions as unknown as unknown[],
    termsOk: b.termsOk === true, termsNote: str(b.termsNote, DATA_LIMITS.note), attribution: str(b.attribution, 120), offer: opts.admin ? offer : 'nobody', updatedAt: new Date(),
  };
}

// ---------------------------------------------------------------- running an action
async function keyFor(env: Env, db: Db, row: SourceRow, userId: string): Promise<{ key: string | null; personal: boolean }> {
  if (row.auth === 'none' || row.auth === 'token') return { key: null, personal: !!row.ownerId };
  if (row.ownerId || row.keyMode === 'one') return { key: await unseal<string>(env.ENCRYPTION_KEY, row.keyEnc).catch(() => null), personal: !!row.ownerId };
  const k = (await db.select().from(dataSourceKeys).where(and(eq(dataSourceKeys.sourceId, row.id), eq(dataSourceKeys.userId, userId))).limit(1))[0];
  return { key: k ? await unseal<string>(env.ENCRYPTION_KEY, k.keyEnc).catch(() => null) : null, personal: true };
}
const edge = () => (globalThis as { caches?: { default?: Cache } }).caches?.default;

export interface DataResult { text: string; at: number; source: string; attribution: string; cached: boolean }
// ---------------------------------------------------------------- signing in for a token
const tokens = new Map<string, { token: string; until: number }>();
/** A token for a source that signs in: kept until a minute before it runs out (30 minutes if the answer doesn't say),
 *  asked for again after that or when a call is refused. The ID and secret go only to the token address. */
async function tokenFor(row: SourceRow, t: DataToken, secrets: Secrets, fresh = false): Promise<string> {
  const k = `${row.id}|${row.updatedAt.getTime()}`;
  const have = tokens.get(k);
  if (!fresh && have && have.until > Date.now()) return have.token;
  if (!secrets.id || !secrets.secret) throw new DataProblem(`${row.name} has no sign-in saved.`);
  const headers: Record<string, string> = {};
  let body: string;
  if (t.style === 'client') {
    const form = new URLSearchParams({ grant_type: 'client_credentials' });
    if (t.basic) headers.authorization = `Basic ${btoa(`${encodeURIComponent(secrets.id)}:${encodeURIComponent(secrets.secret)}`)}`;
    else { form.set(t.idName, secrets.id); form.set(t.secretName, secrets.secret); }
    if (t.scope) form.set('scope', t.scope);
    headers['content-type'] = 'application/x-www-form-urlencoded'; body = form.toString();
  } else { headers['content-type'] = 'application/json'; body = JSON.stringify({ [t.idName]: secrets.id, [t.secretName]: secrets.secret }); }
  let got;
  try { got = await safeFetch(t.url, { method: 'POST', headers, body, json: true }); }
  catch (e) { throw new DataProblem(e instanceof FetchProblem ? (e.status === 401 || e.status === 403 || e.status === 400 ? 'The token address refused the sign-in.' : `Signing in: ${e.message.charAt(0).toLowerCase()}${e.message.slice(1)}`) : 'The token address couldn’t be reached.', 502); }
  let j: unknown; try { j = JSON.parse(got.body); } catch { j = null; }
  const token = t.tokenPath.split('.').reduce<unknown>((o, p) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[p] : undefined), j);
  if (typeof token !== 'string' || !token || token.length > 8000 || /[\r\n]/.test(token)) throw new DataProblem(`Signed in, but the token wasn’t at “${t.tokenPath}” in the answer.`, 502);
  const secs = Number((j as Record<string, unknown>)?.expires_in);
  const until = Date.now() + Math.min(24 * 3600_000, Math.max(60_000, Number.isFinite(secs) && secs > 0 ? secs * 1000 - 60_000 : 30 * 60_000));
  if (tokens.size > 500) tokens.delete(tokens.keys().next().value!);
  tokens.set(k, { token, until });
  return token;
}

/** The address, headers and body for one call, with the right key (never echoed in errors). */
async function request(env: Env, db: Db, userId: string, row: SourceRow, action: DataAction, values: Record<string, string>, freshToken = false) {
  const { key, personal } = await keyFor(env, db, row, userId);
  if ((row.auth === 'header' || row.auth === 'query') && !key) throw new DataProblem(row.keyMode === 'own' && !row.ownerId ? `${row.name} needs your key first.` : `${row.name} has no key saved.`);
  let url = actionUrl(row.baseUrl, action, values);
  const headers: Record<string, string> = {};
  const extra = headersOf(row);
  const secrets: Secrets = row.secretsEnc && (row.auth === 'token' || extra.some((h) => h.secret)) ? (await unseal<Secrets>(env.ENCRYPTION_KEY, row.secretsEnc).catch(() => null)) ?? {} : {};
  for (const h of extra) { const v = h.secret ? secrets.h?.[h.name] : h.value; if (v) headers[h.name] = v; }
  if (row.auth === 'header' && key) headers[row.authName] = key;
  if (row.auth === 'query' && key) { const u = new URL(url); u.searchParams.set(row.authName, key); url = u.toString(); }
  const t = tokenOf(row);
  if (row.auth === 'token') { if (!t) throw new DataProblem(`${row.name} has no sign-in set up.`); headers[t.header] = `${t.prefix}${await tokenFor(row, t, secrets, freshToken)}`; }
  let body: string | undefined;
  if (action.method === 'POST') {
    const b = actionBody(action, values);
    if ('problem' in b) throw new DataProblem(`${action.name}: ${b.problem}`);
    headers['content-type'] = b.type; body = b.body;
  }
  return { url, headers, personal, method: action.method === 'POST' ? 'POST' as const : 'GET' as const, body };
}
/** One call: a refused call to a source that signs in is tried once more with a new token. */
async function call(env: Env, db: Db, userId: string, row: SourceRow, action: DataAction, values: Record<string, string>) {
  const r = await request(env, db, userId, row, action, values);
  try { return { r, got: await safeFetch(r.url, { method: r.method, headers: r.headers, body: r.body }) }; }
  catch (e) {
    if (row.auth === 'token' && e instanceof FetchProblem && (e.status === 401 || e.status === 403)) {
      const again = await request(env, db, userId, row, action, values, true);
      try { return { r: again, got: await safeFetch(again.url, { method: again.method, headers: again.headers, body: again.body }) }; }
      catch (e2) { throw new DataProblem(e2 instanceof FetchProblem ? e2.message : 'The source couldn’t be reached.', 502); }
    }
    throw new DataProblem(e instanceof FetchProblem ? e.message : 'The source couldn’t be reached.', 502);
  }
}
const countCall = (db: Db, userId: string, sourceId: string) => db.execute(sql`insert into usage_counts (user_id, month, kind, entry, n) values (${userId}, ${monthOf()}, 'data', ${sourceId}, 1)
    on conflict (user_id, month, kind, entry) do update set n = usage_counts.n + 1`).catch(() => undefined);
/** The whole answer to one action (for datasets): checked values, the right key, counted as a call. */
export async function fetchWhole(env: Env, db: Db, userId: string, row: SourceRow, action: DataAction, given: Record<string, unknown>) {
  const checked = checkValues(action, given);
  if ('problem' in checked) throw new DataProblem(checked.problem);
  const { got } = await call(env, db, userId, row, action, checked.values);
  await countCall(db, userId, row.id);
  return got;
}
/** Runs one action. `limit` is the person's monthly calls (0: no limit); cached answers aren't counted. */
export async function runAction(env: Env, db: Db, userId: string, row: SourceRow, action: DataAction, given: Record<string, unknown>, limit: number, opts: { test?: boolean } = {}): Promise<DataResult> {
  const checked = checkValues(action, given);
  if ('problem' in checked) throw new DataProblem(checked.problem);
  const { personal } = await keyFor(env, db, row, userId);
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
  const { got } = await call(env, db, userId, row, action, checked.values);
  const text = resultText(got.body, got.kind), at = Date.now();
  await countCall(db, userId, row.id);
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

// ---------------------------------------------------------------- weather (Connections · Weather)
export const OM_KEY_SETTING = 'open-meteo-key';
/** The admin's Open-Meteo paid plan key (customer API), or null for the free API. */
export async function openMeteoKey(env: Env, db: Db): Promise<string | null> {
  const row = (await db.select().from(appSettings).where(eq(appSettings.key, OM_KEY_SETTING)).limit(1).catch(() => []))[0];
  const sealed = (row?.value as { keyEnc?: string } | undefined)?.keyEnc ?? null;
  return sealed ? await unseal<string>(env.ENCRYPTION_KEY, sealed).catch(() => null) : null;
}
export interface WeatherSource { id: string; name: string; badge: 'Built in' | 'Included in your plan' | 'Added by you'; what: string; on: boolean; tag?: string }
/** This person's weather sources in their order (Open-Meteo if their plan has it, and data sources used as weather that
 *  they turned on or added), their settings, and which are on. The home place and units of an older Open-Meteo
 *  connection carry over until the person saves this page. */
export async function weatherFor(env: Env, db: Db, user: Who, legacy?: () => Promise<{ home?: string; units?: string } | null>) {
  const s = await sourcesFor(db, user);
  const d = await dataDefaults(db);
  const prefs = s.prefs.weather;
  const wxSources = [...s.offered.filter((x) => x.on && (x.info.auth === 'none' || x.info.hasKey)), ...s.mine.filter((x) => x.on)].filter((x) => x.info.use === 'weather');
  const available = [...(s.allowed.om ? [OPEN_METEO] : []), ...wxSources.map((x) => x.row.id)];
  const order = weatherOrder(prefs, available, d.wxFirst);
  const list: WeatherSource[] = order.map((id) => {
    const x = wxSources.find((w) => w.row.id === id);
    return x ? { id, name: x.info.name, badge: x.info.own ? 'Added by you' : 'Included in your plan', what: x.info.actions.filter((a) => a.on).map((a) => a.name).slice(0, 3).join(' · ') || 'Weather', on: !prefs.off.includes(id) }
      : { id, name: 'Open-Meteo', badge: 'Built in', what: 'Forecasts anywhere · no key · credited to Open-Meteo', on: !prefs.off.includes(id) };
  });
  let home = prefs.home, units = prefs.units;
  if (!prefs.saved && legacy) { const old = await legacy().catch(() => null); if (old) { home = old.home ?? home; units = /^\s*°?f/i.test(old.units ?? '') ? 'F' : units; } }
  return { list, on: list.filter((x) => x.on).map((x) => x.id), home, units, location: prefs.location, canAdd: s.allowed.own, omInPlan: s.allowed.om };
}
export async function saveWeather(db: Db, userId: string, w: Partial<WeatherPrefs>) {
  const fresh = (await db.select({ p: users.dataPrefs }).from(users).where(eq(users.id, userId)).limit(1))[0];
  const p = cleanDataPrefs(fresh?.p);
  const weather = cleanWeatherPrefs({ ...p.weather, ...w, saved: true });
  await db.update(users).set({ dataPrefs: { ...p, weather } as unknown as Record<string, unknown> }).where(eq(users.id, userId));
  return weather;
}

// ---------------------------------------------------------------- live info (Engine · Live info)
/** This person's live services (data sources used as live information that they turned on or added), the order for
 *  everywhere and each country, and their places. */
export async function liveFor(db: Db, user: Who) {
  const s = await sourcesFor(db, user);
  const live = [...s.offered.filter((x) => x.on && (x.info.auth === 'none' || x.info.hasKey)), ...s.mine.filter((x) => x.on)].filter((x) => x.info.use === 'live');
  const p = s.prefs.live;
  const ids = live.map((x) => x.row.id);
  const lists = { everywhere: p.everywhere.filter((id) => ids.includes(id)), countries: Object.fromEntries(Object.entries(p.countries).map(([cc, l]) => [cc, l.filter((id) => ids.includes(id))])) };
  const usedIn = (id: string) => [...(lists.everywhere.includes(id) ? ['Everywhere'] : []), ...Object.entries(lists.countries).filter(([, l]) => l.includes(id)).map(([cc]) => cc)];
  return {
    services: live.map((x) => ({ id: x.row.id, name: x.info.name, what: x.info.actions.filter((a) => a.on).map((a) => a.name).slice(0, 4).join(' · '), own: x.info.own, usedIn: usedIn(x.row.id) })),
    ...lists, places: p.places, canAdd: s.allowed.own, offered: s.offered.some((x) => x.info.use === 'live'),
    suggested: liveSuggestions(s.prefs, Date.now()).map((x) => ({ key: x.key, name: x.name, value: x.value, count: x.count })),
  };
}
/** A live question named a place (a stop code, a line): counted, so Live info can offer it as one of their places
 *  once it comes up again and again. Only the first value the action was given is kept, never the question. */
export async function noteLivePlace(db: Db, userId: string, src: { id: string }, action: DataAction, values: Record<string, string>) {
  const param = action.params.find((p) => (values[p.name] ?? '').trim());
  if (!param) return;
  const value = values[param.name]!.trim().slice(0, 80);
  const fresh = (await db.select({ p: users.dataPrefs }).from(users).where(eq(users.id, userId)).limit(1))[0];
  const p = cleanDataPrefs(fresh?.p);
  const liveSeen = noteSeen(p.liveSeen, { key: `${src.id}:${action.id}:${param.name}=${value}`.slice(0, 200), name: action.name, value: `${param.name} ${value}` }, Date.now());
  await db.update(users).set({ dataPrefs: { ...p, liveSeen } as unknown as Record<string, unknown> }).where(eq(users.id, userId));
}
/** Keeps a suggested place (it becomes one of their places) or turns it down (it isn't offered again). */
export async function answerSuggestion(db: Db, userId: string, key: string, keep: boolean, name?: string) {
  const fresh = (await db.select({ p: users.dataPrefs }).from(users).where(eq(users.id, userId)).limit(1))[0];
  const p = cleanDataPrefs(fresh?.p);
  const it = p.liveSeen.find((x) => x.key === key);
  if (!it) return null;
  const live = keep ? cleanLivePrefs({ ...p.live, places: [...p.live.places, { name: (name ?? '').trim() || it.name, value: it.value }] }) : p.live;
  const next = { ...p, live, liveSeen: p.liveSeen.filter((x) => x.key !== key), liveNo: keep ? p.liveNo : [...p.liveNo, key].slice(-50) };
  await db.update(users).set({ dataPrefs: next as unknown as Record<string, unknown> }).where(eq(users.id, userId));
  return live;
}
export async function saveLive(db: Db, userId: string, l: Partial<LivePrefs>) {
  const fresh = (await db.select({ p: users.dataPrefs }).from(users).where(eq(users.id, userId)).limit(1))[0];
  const p = cleanDataPrefs(fresh?.p);
  const live = cleanLivePrefs({ ...p.live, ...l });
  await db.update(users).set({ dataPrefs: { ...p, live } as unknown as Record<string, unknown> }).where(eq(users.id, userId));
  return live;
}
