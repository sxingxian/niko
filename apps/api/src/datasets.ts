// Datasets from data sources, kept in a person's Knowledge (Niko's own Knowledge database) as a table plus one short
// summary piece, so a search finds it and the look-up tool can count and add up its rows. Refreshed when used, if
// older than the action's period; there are no schedules. Only for people whose plan includes Knowledge files kept in
// Niko and dataset imports. A dataset counts toward their Knowledge space like any file.
import { and, eq, inArray } from 'drizzle-orm';
import { dataDatasets, users, type Db } from '@niko/db';
import { aiAllowed, cleanKnowledgePrefs, datasetTable, DATA_REFRESH_MS, knowledgeAccess, knPlaceOf, sampleValues, type DataAction } from '@niko/shared';
import type { Env } from './env';
import { offFor } from './access';
import { DataProblem, fetchWhole, sourcesFor, type SourceRow } from './datasources';
import { accountKnowledge, addPieces, addSheet, deleteFile, finishFile, knowledgeDb, limitsFor, startFile, usage, type Kdb } from './knowledge';
import { sha256 } from './lib/crypto';

type Who = { id: string; role: string; aiAccess?: unknown; dataAccess?: unknown; dataPrefs?: unknown; knowledge?: unknown; knowledgeLimits?: unknown };

/** Whether datasets can be kept for this person: dataset imports allowed, Knowledge files on, kept in Niko. */
export async function datasetsOk(env: Env, db: Db, user: Who): Promise<Kdb | null> {
  const s = await sourcesFor(db, user);
  if (!s.allowed.ds) return null;
  const off = await offFor(db, user as { role: string; aiAccess?: unknown });
  const access = knowledgeAccess((k) => aiAllowed(off, k));
  if (!access.files || !access.niko || knPlaceOf(cleanKnowledgePrefs(user.knowledge), access) !== 'niko') return null;
  return accountKnowledge(env, user.id);
}
export async function datasetsOf(db: Db, userId: string) {
  return db.select().from(dataDatasets).where(eq(dataDatasets.userId, userId));
}
/** Keeps the number of files with the account, so answering asks Knowledge only when there are files. */
async function syncCount(db: Db, k: Kdb, userId: string) {
  const files = (await usage(k, userId)).files;
  const fresh = await db.select({ knowledge: users.knowledge }).from(users).where(eq(users.id, userId)).limit(1);
  await db.update(users).set({ knowledge: { ...cleanKnowledgePrefs(fresh[0]?.knowledge), files } as unknown as Record<string, unknown> }).where(eq(users.id, userId));
}

/** Fetches one dataset and keeps it as a table (replacing the copy before it). */
export async function importDataset(env: Env, db: Db, user: Who, k: Kdb, row: SourceRow, action: DataAction): Promise<{ rows: number }> {
  const got = await fetchWhole(env, db, user.id, row, action, sampleValues(action));
  const table = datasetTable(got.body, got.kind);
  const key = { userId: user.id, sourceId: row.id, actionId: action.id };
  const where = and(eq(dataDatasets.userId, user.id), eq(dataDatasets.sourceId, row.id), eq(dataDatasets.actionId, action.id));
  if ('problem' in table) {
    await db.insert(dataDatasets).values({ ...key, problem: table.problem }).onConflictDoUpdate({ target: [dataDatasets.userId, dataDatasets.sourceId, dataDatasets.actionId], set: { problem: table.problem } });
    throw new DataProblem(table.problem);
  }
  const before = (await db.select().from(dataDatasets).where(where).limit(1))[0];
  if (before?.documentId) await deleteFile(k, user.id, before.documentId).catch(() => undefined);
  const name = `${row.name} · ${action.name}`.replace(/[\\/:*?"<>|]+/g, ' ').slice(0, 110) + '.csv';
  const bytes = new TextEncoder().encode(got.body).length;
  const { id } = await startFile(k, user.id, await limitsFor(db, user), { name, bytes, sha256: await sha256(`${row.id}:${action.id}:${got.body}`), collection: 'Data sources' });
  try {
    await addSheet(k, user.id, id, { name: action.name, columns: table.columns, rows: table.rows, header: true });
    const when = new Date().toISOString().slice(0, 10);
    const summary = `${action.name} from ${row.name}${row.attribution ? ` (${row.attribution})` : ''}, fetched ${when}. A table of ${table.rows.length.toLocaleString('en')} rows with columns: ${table.columns.map((c) => c.name).join(', ')}.`.slice(0, 1900);
    await addPieces(k, env, user.id, id, { start: 0, pieces: [{ heading: action.name, body: summary }] }, { cloudflare: false });
    await finishFile(k, user.id, id);
  } catch (e) { await deleteFile(k, user.id, id).catch(() => undefined); throw e; }
  await db.insert(dataDatasets).values({ ...key, documentId: id, fetchedAt: new Date(), rows: table.rows.length, problem: null })
    .onConflictDoUpdate({ target: [dataDatasets.userId, dataDatasets.sourceId, dataDatasets.actionId], set: { documentId: id, fetchedAt: new Date(), rows: table.rows.length, problem: null } });
  await syncCount(db, k, user.id);
  return { rows: table.rows.length };
}
/** Removes a source's datasets from this person's Knowledge (turned off, removed, or no longer in their plan). */
export async function removeDatasets(env: Env, db: Db, userId: string, sourceId: string): Promise<void> {
  const rows = await db.select().from(dataDatasets).where(and(eq(dataDatasets.userId, userId), eq(dataDatasets.sourceId, sourceId)));
  if (!rows.length) return;
  const k = accountKnowledge(env, userId);
  if (k) {
    const ids = rows.map((r) => r.documentId).filter((x): x is string => !!x);
    if (ids.length) await k.q(`delete from kn_documents where account_id = $1 and id = any($2::uuid[])`, [userId, ids]).catch(() => undefined);
    await syncCount(db, k, userId).catch(() => undefined);
  }
  await db.delete(dataDatasets).where(and(eq(dataDatasets.userId, userId), eq(dataDatasets.sourceId, sourceId)));
}
/** Everyone's copies of a source's datasets, when the admin removes the source. */
export async function removeDatasetsForAll(env: Env, db: Db, sourceId: string): Promise<void> {
  const rows = await db.select().from(dataDatasets).where(eq(dataDatasets.sourceId, sourceId));
  const k = knowledgeDb(env);
  if (k) for (const userId of [...new Set(rows.map((r) => r.userId))].slice(0, 40)) {
    const ids = rows.filter((r) => r.userId === userId && r.documentId).map((r) => r.documentId!);
    if (ids.length) await k.q(`delete from kn_documents where account_id = $1 and id = any($2::uuid[])`, [userId, ids]).catch(() => undefined);
  }
}
/** After an answer used Knowledge: datasets among its files that are older than their period are fetched again. */
export async function refreshUsed(env: Env, db: Db, user: Who, documentIds: string[]): Promise<void> {
  if (!documentIds.length) return;
  const used = await db.select().from(dataDatasets).where(and(eq(dataDatasets.userId, user.id), inArray(dataDatasets.documentId, documentIds)));
  if (!used.length) return;
  const k = await datasetsOk(env, db, user);
  if (!k) return;
  const s = await sourcesFor(db, user);
  for (const d of used.slice(0, 2)) {
    const src = [...s.offered.filter((x) => x.on), ...s.mine.filter((x) => x.on)].find((x) => x.row.id === d.sourceId);
    const act = src?.info.actions.find((a) => a.id === d.actionId && a.on && a.dataset);
    if (!src || !act) continue;
    if (d.fetchedAt && Date.now() - d.fetchedAt.getTime() < DATA_REFRESH_MS[act.dataset!]) continue;
    await importDataset(env, db, user, k, src.row, act).catch((e) => console.warn(`dataset refresh: ${String((e as Error)?.message ?? e).slice(0, 160)}`));
  }
}
