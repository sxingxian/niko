// Settings · Knowledge: each person's own files. Mounted under /api/knowledge, after sign-in and the plan check.
// What a person may use comes from their AI options (group "knowledge"): Knowledge files and the Niko place must be
// on to keep files here, Cloudflare reading and search only where allowed. Their screens never mention an admin.
import { eq } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import { users } from '@niko/db';
import { aiAllowed, cleanKnowledgePrefs, cleanTarget, isHabit, isRemotePlace, KN_HABITS, KN_PLACE_NAMES, KN_REMOTE_PLACES, knowledgeAccess, knLearnPlaceOf, knPlaceOf, cleanFolder, knFolder, knFolderIsPath, KN_DEFAULT_FOLDER, knRemoteOf, knSearchOf, type KnowledgeAccess, type KnowledgePrefs, type KnRemotePlace } from '@niko/shared';
import type { AppEnv } from '../env';
import { audit, tooMany } from '../lib/session';
import { hmacSha256Hex } from '../lib/crypto';
import { binLearnedCopy, learnedCopyOf, markLearnedDirty, setLearnedCopy, syncLearnedCopy } from '../knLearnedCopy';
import { confirmHabit, declineHabit, editNote, forgetAll, forgetAllFileMatches, forgetFileMatches, forgetNote, forgetNotesOnly, habitsOn, keepHabit, learnedCount, listLearned, noticeHabit, saveNote } from '../learned';
import { offFor } from '../access';
import { ownEmbedder, ownSearchSources } from '../ownEmbed';
import { notionPage, notionPages, PlaceError, placeConnections, remoteFor } from '../knPlaces';
import { copiesOf, copyStep, dueForCheck, leavePlaces, notCopied, placeRoot, refreshFile, relocate, roots, rootsMade, setRoot } from '../knPlacesStore';
import { credentials, notionBot } from '../providers';
import { isKnowledgeNotion, knowledgeNotionIds } from '../knNotes';
import { cleanStorage, loadStorage, saveStorage, shownStorage, testStorage } from '../knStorage';
import { cleanObsidian, loadObsidian, saveObsidian, shownObsidian, testObsidian } from '../knObsidian';
import { accountKnowledge, addFromText, addCloudflareNumbers, addOwnNumbers, clearOwnNumbers, addPieces, addSheet, addSheetRows, deleteFile, filePieces, setDeviceNumbers, sheetRows, finishFile, keepAsData, KnError, knowledgeSettings, limitsFor, listFiles, listSheets, readWithCloudflare, search, startFile, updateSheet, usage, type Kdb } from '../knowledge';

export const knowledge = new Hono<AppEnv>();
type C = Context<AppEnv>;

const NOT_HERE = 'Knowledge isn’t available right now.';
const NOT_ON_ACCOUNT = 'That isn’t included in your plan.';

async function who(c: C): Promise<{ access: KnowledgeAccess; prefs: KnowledgePrefs }> {
  const u = c.get('user');
  const off = await offFor(c.get('db'), u);
  return { access: knowledgeAccess((k) => aiAllowed(off, k)), prefs: cleanKnowledgePrefs((u as { knowledge?: unknown }).knowledge) };
}
/** Search numbers come from Cloudflare only when the account is allowed it and the person chose it. */
const useCloudflare = (a: KnowledgeAccess, p: KnowledgePrefs) => a.cloudflareSearch && p.search === 'cloudflare';
const fail = (c: C, e: unknown) => {
  if (e instanceof KnError) return c.json({ error: e.message, ...e.extra }, e.status);
  throw e;
};
/** Keeps the number of files with the account (main database), so answering never asks Knowledge for an account that
 *  has no files. */
async function syncCount(c: C, k: Kdb) {
  const u = c.get('user');
  const files = (await usage(k, u.id)).files;
  const fresh = await c.get('db').select({ knowledge: users.knowledge }).from(users).where(eq(users.id, u.id)).limit(1);
  const prefs = { ...cleanKnowledgePrefs(fresh[0]?.knowledge), files };
  await c.get('db').update(users).set({ knowledge: prefs as unknown as Record<string, unknown> }).where(eq(users.id, u.id));
}
/** Keeps the number of learned notes with the account, so answering only looks notes up for someone who has some. */
export async function syncNotes(c: C, k: Kdb) {
  const u = c.get('user');
  const [notes, habits] = await Promise.all([learnedCount(k, u.id), habitsOn(k, u.id)]);
  const fresh = await c.get('db').select({ knowledge: users.knowledge }).from(users).where(eq(users.id, u.id)).limit(1);
  const prefs = { ...cleanKnowledgePrefs(fresh[0]?.knowledge), notes, habits };
  await c.get('db').update(users).set({ knowledge: prefs as unknown as Record<string, unknown> }).where(eq(users.id, u.id));
  // A copy of what Niko learned in their own app is rewritten on its next sync.
  await markLearnedDirty(k, u.id);
}
/** Notes learned in Niko need the Knowledge database, learning in the person's plan (it works without files), and Kept in
 *  Niko allowed for what Niko learns. */
async function notesStore(c: C): Promise<{ k: Kdb; access: KnowledgeAccess; prefs: KnowledgePrefs } | Response> {
  const k = accountKnowledge(c.env, c.get('user').id);
  if (!k) return c.json({ error: NOT_HERE }, 503);
  const w = await who(c);
  // Notes are kept in Niko only while their plan allows it; otherwise they're on their device, or nowhere.
  if (!w.access.learnPlaces.niko) return c.json({ error: NOT_ON_ACCOUNT }, 403);
  return { k, ...w };
}
/** A place for files or for what Niko learns: the Knowledge database, and either allowed by their plan. */
async function placeStore(c: C, place: KnRemotePlace): Promise<{ k: Kdb; access: KnowledgeAccess; prefs: KnowledgePrefs } | Response> {
  const k = accountKnowledge(c.env, c.get('user').id);
  if (!k) return c.json({ error: NOT_HERE }, 503);
  const w = await who(c);
  if (!w.access[place] && !w.access.learnPlaces[place]) return c.json({ error: NOT_ON_ACCOUNT }, 403);
  return { k, ...w };
}
/** Keeps the name of Niko's page or folder in a place with their Knowledge settings. */
async function saveFolder(c: C, place: KnRemotePlace, name: string) {
  const u = c.get('user');
  const [fresh] = await c.get('db').select({ knowledge: users.knowledge }).from(users).where(eq(users.id, u.id)).limit(1);
  const prefs = cleanKnowledgePrefs(fresh?.knowledge);
  const folders = { ...prefs.folders, [place]: name };
  if (name === KN_DEFAULT_FOLDER[place]) delete folders[place];
  await c.get('db').update(users).set({ knowledge: { ...prefs, folders } as unknown as Record<string, unknown> }).where(eq(users.id, u.id));
}
/** Files kept in Niko need the Knowledge database, Knowledge files and the Niko place. */
async function store(c: C): Promise<{ k: Kdb; access: KnowledgeAccess; prefs: KnowledgePrefs } | Response> {
  const k = accountKnowledge(c.env, c.get('user').id);
  if (!k) return c.json({ error: NOT_HERE }, 503);
  const w = await who(c);
  if (!w.access.niko) return c.json({ error: NOT_ON_ACCOUNT }, 403);
  return { k, ...w };
}

/** For each place their plan allows: whether it's connected (and as whom), and the name of Niko's folder or page. */
async function placesInfo(c: C, k: Kdb, access: KnowledgeAccess) {
  const allowed = KN_REMOTE_PLACES.filter((p) => access[p]);
  if (!allowed.length) return {};
  const [conn, made, storage, vault] = await Promise.all([placeConnections(c.get('db'), c.get('user').id), rootsMade(k, c.get('user').id), access.s3 ? loadStorage(c.env, c.get('db'), c.get('user').id) : null, access.obsidian ? loadObsidian(c.env, c.get('db'), c.get('user').id) : null]);
  return Object.fromEntries(allowed.map((p) => [p, { ...conn[p], root: made[p]?.name ?? null, picked: made[p]?.made === false, ...(p === 's3' && storage ? { storage: shownStorage(storage) } : {}), ...(p === 'obsidian' && vault ? { obsidian: shownObsidian(vault) } : {}) }]));
}
/** The places their plan allows for a copy of what Niko learns: connected or not. Their own storage is offered only
 *  when it's saved, or when they can set it up on the Files tab. */
async function learnPlacesInfo(c: C, k: Kdb, access: KnowledgeAccess) {
  const allowed = KN_REMOTE_PLACES.filter((p) => access.learnPlaces[p]);
  if (!allowed.length) return {};
  const [conn, made] = await Promise.all([placeConnections(c.get('db'), c.get('user').id), rootsMade(k, c.get('user').id)]);
  return Object.fromEntries(allowed.filter((p) => (p !== 's3' && p !== 'obsidian') || conn[p]?.connected || access[p]).map((p) => [p, { ...conn[p], root: made[p]?.name ?? null, picked: made[p]?.made === false }]));
}
/** Their chosen place, signed in, for copying; a plain problem when it can't be used. */
async function placeFor(c: C, s: { access: KnowledgeAccess; prefs: KnowledgePrefs }, place?: KnRemotePlace) {
  const p = place ?? knRemoteOf(s.prefs, s.access);
  if (!p || !s.access[p]) return { error: c.json({ error: NOT_ON_ACCOUNT }, 403) };
  const remote = await remoteFor(c.env, c.get('db'), c.get('user').id, p);
  if (!remote) return { error: c.json({ error: (p === 's3' ? 'Add your storage first.' : p === 'obsidian' ? 'Set up Obsidian first.' : `Connect ${KN_PLACE_NAMES[p]} first.`), connect: p }, 409) };
  return { remote };
}
const placeFail = (c: C, e: unknown) => (e instanceof PlaceError ? c.json({ error: e.message }, e.status === 401 || e.status === 403 ? 409 : 502) : fail(c, e));

// Everything the Knowledge screen needs at once.
knowledge.get('/', async (c) => {
  const u = c.get('user'), k = accountKnowledge(c.env, c.get('user').id);
  const w = await who(c);
  const settings = await knowledgeSettings(c.get('db'));
  return c.json({
    available: !!k && (w.access.files || w.access.learning), access: w.access, prefs: w.prefs, limits: await limitsFor(c.get('db'), u),
    split: settings.split, usage: k && w.access.niko ? await usage(k, u.id) : { files: 0, bytes: 0 },
    // The places their plan allows besides Niko and this device: connected or not, and Niko's folder or page there.
    places: k && w.access.niko ? await placesInfo(c, k, w.access) : {},
    // Where what Niko learns can be kept besides Niko and this device, and the copy kept there now.
    learnPlaces: k && w.access.learning ? await learnPlacesInfo(c, k, w.access) : {},
    learnedCopy: k && w.access.learning ? await learnedCopyOf(k, u.id) : null,
    // Their own services that can make search numbers (only those their plan allows).
    ownSearch: w.access.ownKey || w.access.ownServer ? (await ownSearchSources(c.env, c.get('db'), u)).filter((x) => (x.ref === 'self-hosted-ai' ? w.access.ownServer : w.access.ownKey)) : [],
  });
});

knowledge.put('/prefs', async (c) => {
  const b = await c.req.json<Record<string, unknown>>().catch(() => ({}));
  const u = c.get('user');
  const { access } = await who(c);
  if (!access.files && !access.learning) return c.json({ error: NOT_ON_ACCOUNT }, 403);
  const before = cleanKnowledgePrefs((u as { knowledge?: unknown }).knowledge);
  // With learning but not files, only the learning settings can change.
  const asked = access.files ? b : Object.fromEntries(Object.entries(b).filter(([key]) => key === 'learn' || key === 'situations' || key === 'learnPlace'));
  // The file count is kept by the server, never taken from the request.
  // Where in each app changes only through Where in … (which copies things there), never here.
  const prefs = { ...cleanKnowledgePrefs({ ...before, ...asked }), files: before.files, notes: before.notes, habits: before.habits, folders: before.folders };
  // Where what Niko learns is kept: Niko, or a place their plan allows. A copy in their own app needs it connected and
  // Niko's page or folder made there now, so a connection problem shows straight away.
  // A choice that isn't allowed can't be made; one made earlier and no longer allowed stays as it was (where notes go then
  // follows what is allowed, the same before and after, so nothing moves).
  if (prefs.learnPlace !== before.learnPlace && !access.learnPlaces[prefs.learnPlace]) return c.json({ error: NOT_ON_ACCOUNT }, 403);
  const learnTo = knLearnPlaceOf(prefs, access), learnFrom = knLearnPlaceOf(before, access);
  if (learnTo !== learnFrom) {
    const k = accountKnowledge(c.env, u.id);
    if (!k && learnTo !== 'device') return c.json({ error: NOT_HERE }, 503);
    if (isRemotePlace(learnTo)) {
      const remote = await remoteFor(c.env, c.get('db'), u.id, learnTo);
      if (!remote) return c.json({ error: (learnTo === 's3' ? 'Add your storage first, on the Files tab.' : learnTo === 'obsidian' ? 'Set up Obsidian first, on the Files tab.' : `Connect ${KN_PLACE_NAMES[learnTo]} first.`), connect: learnTo }, 409);
      try { await placeRoot(k!, remote, u.id); } catch (e) { return placeFail(c, e); }
    }
    if (k) {
      await setLearnedCopy(k, u.id, isRemotePlace(learnTo) ? learnTo : null);
      // Moving to the device: the app has copied the notes there first; Niko keeps only the matches taught for files.
      if (learnTo === 'device') await forgetNotesOnly(k, u.id);
    }
    await audit(c, 'knowledge.learned-place', { place: learnTo }, u.id);
  }
  // A choice the account doesn't have is kept to what it does have.
  if (access.files) {
  if (prefs.place === 'niko' && !access.niko && access.device) prefs.place = 'device';
  if (prefs.place === 'device' && !access.device && access.niko) prefs.place = 'niko';
  if (!access.cloudflareRead) prefs.read = 'device';
  // One of their own apps or storage: allowed by the plan, connected, and with Niko's folder or page made there now,
  // so a connection problem shows straight away. Moving back to Niko: Niko stops using the copies (they stay there).
  if (isRemotePlace(prefs.place) && prefs.place !== before.place) {
    if (!access[prefs.place]) return c.json({ error: NOT_ON_ACCOUNT }, 403);
    const k = accountKnowledge(c.env, c.get('user').id);
    if (!k) return c.json({ error: NOT_HERE }, 503);
    const remote = await remoteFor(c.env, c.get('db'), u.id, prefs.place);
    if (!remote) return c.json({ error: (prefs.place === 's3' ? 'Add your storage first.' : prefs.place === 'obsidian' ? 'Set up Obsidian first.' : `Connect ${KN_PLACE_NAMES[prefs.place]} first.`), connect: prefs.place }, 409);
    try { await placeRoot(k, remote, u.id); } catch (e) { return placeFail(c, e); }
  }
  if (prefs.place === 'niko' && isRemotePlace(before.place)) { const k = accountKnowledge(c.env, c.get('user').id); if (k) await leavePlaces(k, u.id); }
  if (prefs.search === 'cloudflare' && !access.cloudflareSearch) prefs.search = 'device';
  // Their own service: allowed by the plan, and tried once before it's saved, so a wrong model is caught now.
  if (prefs.search === 'own') {
    if (!prefs.own || !(prefs.own.ref === 'self-hosted-ai' ? access.ownServer : access.ownKey)) return c.json({ error: NOT_ON_ACCOUNT }, 403);
    const changed = before.search !== 'own' || before.own?.ref !== prefs.own.ref || before.own?.model !== prefs.own.model;
    if (changed) {
      if (await tooMany(c, 'kn-own-try:' + u.id, 30, 3600)) return c.json({ error: 'That’s a lot of tries. Try again in a little while.' }, 429);
      try { await (await ownEmbedder(c.env, c.get('db'), u, prefs.own))(['Niko']); }
      catch (e) { return c.json({ error: (e as Error).message }, 400); }
      const k = accountKnowledge(c.env, c.get('user').id);
      if (k) await clearOwnNumbers(k, u.id);
    }
  }
  }
  await c.get('db').update(users).set({ knowledge: prefs as unknown as Record<string, unknown> }).where(eq(users.id, u.id));
  if (learnTo === 'device' && learnFrom !== 'device') { const k = accountKnowledge(c.env, u.id); if (k) await syncNotes(c, k); }
  if (prefs.learn !== before.learn) await audit(c, prefs.learn ? 'knowledge.learning-on' : 'knowledge.learning-paused', {}, u.id);
  return c.json({ ok: true, prefs });
});

knowledge.get('/files', async (c) => {
  const s = await store(c); if (s instanceof Response) return s;
  return c.json({ files: await listFiles(s.k, c.get('user').id) });
});

knowledge.post('/files', async (c) => {
  const s = await store(c); if (s instanceof Response) return s;
  const u = c.get('user');
  if (await tooMany(c, 'kn-add:' + u.id, 120, 60)) return c.json({ error: 'That’s a lot of files at once. Try again in a little while.' }, 429);
  const b = await c.req.json<Record<string, unknown>>().catch(() => ({}));
  try {
    const r = await startFile(s.k, u.id, await limitsFor(c.get('db'), u), b);
    return c.json({ ok: true, id: r.id, cloudflare: useCloudflare(s.access, s.prefs) });
  } catch (e) { return fail(c, e); }
});

knowledge.post('/files/:id/pieces', async (c) => {
  const s = await store(c); if (s instanceof Response) return s;
  const b = await c.req.json<Record<string, unknown>>().catch(() => ({}));
  try {
    const own = knSearchOf(s.prefs, s.access, 'niko') === 'own' ? await ownEmbedder(c.env, c.get('db'), c.get('user'), s.prefs.own!) : undefined;
    return c.json({ ok: true, ...(await addPieces(s.k, c.env, c.get('user').id, c.req.param('id'), b, { cloudflare: useCloudflare(s.access, s.prefs), own })) });
  }
  catch (e) { return fail(c, e); }
});

// Splitting on Niko's server, when the admin has switched it on (Workers Paid): the whole file's text in one request.
knowledge.post('/files/:id/text', async (c) => {
  const s = await store(c); if (s instanceof Response) return s;
  const u = c.get('user');
  if ((await knowledgeSettings(c.get('db'))).split !== 'server') return c.json({ error: 'Files are split in your browser.' }, 409);
  if (await tooMany(c, 'kn-text:' + u.id, 60, 60)) return c.json({ error: 'That’s a lot of files at once. Try again in a little while.' }, 429);
  const b = await c.req.json<Record<string, unknown>>().catch(() => ({}));
  try {
    const own = knSearchOf(s.prefs, s.access, 'niko') === 'own' ? await ownEmbedder(c.env, c.get('db'), u, s.prefs.own!) : undefined;
    const lim = await limitsFor(c.get('db'), u);
    return c.json({ ok: true, ...(await addFromText(s.k, c.env, u.id, c.req.param('id'), b, { cloudflare: useCloudflare(s.access, s.prefs), own }, lim.mbPerFile * 2 * 1024 * 1024)) });
  } catch (e) { return fail(c, e); }
});

knowledge.post('/files/:id/sheets', async (c) => {
  const s = await store(c); if (s instanceof Response) return s;
  const b = await c.req.json<Record<string, unknown>>().catch(() => ({}));
  try { return c.json({ ok: true, ...(await addSheet(s.k, c.get('user').id, c.req.param('id'), b)) }); }
  catch (e) { return fail(c, e); }
});

knowledge.post('/files/:id/sheets/:sheet/rows', async (c) => {
  const s = await store(c); if (s instanceof Response) return s;
  const b = await c.req.json<Record<string, unknown>>().catch(() => ({}));
  try { return c.json({ ok: true, ...(await addSheetRows(s.k, c.get('user').id, c.req.param('id'), c.req.param('sheet'), b)) }); }
  catch (e) { return fail(c, e); }
});

knowledge.post('/files/:id/done', async (c) => {
  const s = await store(c); if (s instanceof Response) return s;
  try {
    const r = await finishFile(s.k, c.get('user').id, c.req.param('id'));
    await syncCount(c, s.k);
    await audit(c, 'knowledge.file-added', { pieces: r.pieces }, c.get('user').id);
    return c.json({ ok: true, ...r });
  } catch (e) { return fail(c, e); }
});

knowledge.get('/files/:id/sheets', async (c) => {
  const s = await store(c); if (s instanceof Response) return s;
  try { return c.json({ sheets: await listSheets(s.k, c.get('user').id, c.req.param('id')) }); }
  catch (e) { return fail(c, e); }
});

// "Check columns": names, what each column holds, and whether the first row is the header.
knowledge.put('/files/:id/sheets/:sheet', async (c) => {
  const s = await store(c); if (s instanceof Response) return s;
  const b = await c.req.json<Record<string, unknown>>().catch(() => ({}));
  try { return c.json({ ok: true, sheet: await updateSheet(s.k, c.get('user').id, c.req.param('id'), c.req.param('sheet'), b) }); }
  catch (e) { return fail(c, e); }
});

// "Keep as data" on a file whose text reads like instructions to an AI.
knowledge.patch('/files/:id', async (c) => {
  const s = await store(c); if (s instanceof Response) return s;
  const b = await c.req.json<{ flagged?: unknown }>().catch(() => ({} as { flagged?: unknown }));
  if (b.flagged !== false) return c.json({ error: 'Nothing to change.' }, 400);
  return (await keepAsData(s.k, c.get('user').id, c.req.param('id'))) ? c.json({ ok: true }) : c.json({ error: 'No such file.' }, 404);
});

knowledge.delete('/files/:id', async (c) => {
  const s = await store(c); if (s instanceof Response) return s;
  // Its copies in Notion, Drive, OneDrive or their storage stay unless the person chose to remove them too
  // (?copy=bin): Notion, Drive and OneDrive keep them in their bin a while; their own storage deletes them.
  const copies = c.req.query('copy') === 'bin' ? await copiesOf(s.k, c.get('user').id, c.req.param('id')) : null;
  if (copies) {
    const remote = await remoteFor(c.env, c.get('db'), c.get('user').id, copies.place).catch(() => null);
    if (remote) for (const it of copies.items) await remote.trash(it.id, it.kind).catch((e) => console.warn(`knowledge copy not removed: ${String((e as Error)?.message ?? e).slice(0, 120)}`));
  }
  const gone = await deleteFile(s.k, c.get('user').id, c.req.param('id'));
  if (gone) { await forgetFileMatches(s.k, c.get('user').id, c.req.param('id')); await syncCount(c, s.k); await syncNotes(c, s.k); await audit(c, 'knowledge.file-removed', {}, c.get('user').id); }
  return c.json({ ok: true });
});

// ---------------------------------------------------------------- copies in their own place
// The files not yet copied to their place (the screen copies them one at a time, with a progress line).
knowledge.get('/copies', async (c) => {
  const s = await store(c); if (s instanceof Response) return s;
  const place = knRemoteOf(s.prefs, s.access);
  return c.json({ place, files: place ? await notCopied(s.k, c.get('user').id, place) : [] });
});
// One step of copying a file there: a document, or one sheet (in Notion, the next rows of it).
knowledge.post('/files/:id/copy', async (c) => {
  const s = await store(c); if (s instanceof Response) return s;
  const u = c.get('user');
  if (await tooMany(c, 'kn-copy:' + u.id, 900, 60)) return c.json({ error: 'That’s a lot at once. Try again in a little while.' }, 429);
  const r = await placeFor(c, s); if (r.error) return r.error;
  try { return c.json({ ok: true, ...(await copyStep(s.k, r.remote, u.id, c.req.param('id'))) }); }
  catch (e) { return fail(c, e); }
});
// After an answer used files kept elsewhere: their copies are checked (every ten minutes at most) and read again when
// they were changed there. The app calls this once the answer is shown, so the answer is never held up.
knowledge.post('/check', async (c) => {
  const s = await store(c); if (s instanceof Response) return s;
  const u = c.get('user');
  if (await tooMany(c, 'kn-check:' + u.id, 120, 60)) return c.json({ ok: true, updated: 0 });
  const b = await c.req.json<{ files?: unknown }>().catch(() => ({} as { files?: unknown }));
  const due = await dueForCheck(s.k, u.id, Array.isArray(b.files) ? b.files.filter((x): x is string => typeof x === 'string') : []);
  let updated = 0;
  for (const f of due) {
    const remote = s.access[f.place] ? await remoteFor(c.env, c.get('db'), u.id, f.place).catch(() => null) : null;
    if (!remote) continue;
    const search = knSearchOf(s.prefs, s.access, 'niko');
    const own = search === 'own' ? await ownEmbedder(c.env, c.get('db'), u, s.prefs.own!).catch(() => undefined) : undefined;
    const r = await refreshFile(s.k, c.env, remote, u.id, f.id, { cloudflare: search === 'cloudflare', own }).catch((e) => { console.warn(`knowledge check: ${String((e as Error)?.message ?? e).slice(0, 160)}`); return 'same' as const; });
    if (r === 'updated') updated++;
  }
  return c.json({ ok: true, updated });
});
// Notion: the pages Niko can see, to pick one for the copies; or Niko's own page (made the first time it's needed).
knowledge.get('/places/notion/pages', async (c) => {
  const s = await placeStore(c, 'notion'); if (s instanceof Response) return s;
  const cred = await credentials(c.env, c.get('db'), c.get('user').id, 'notion').catch(() => null);
  if (!cred?.accessToken) return c.json({ error: 'Connect Notion first.', connect: 'notion' }, 409);
  // Niko's own copies aren't offered as the page to keep Knowledge on.
  // The page they chose stays in the list, so it shows as chosen.
  const ids = await knowledgeNotionIds(s.k, c.get('user').id, { picked: false }).catch(() => new Set<string>());
  const bot = await notionBot(c.get('user').id, cred.accessToken);
  try { return c.json({ pages: await notionPages(cred.accessToken, (p) => isKnowledgeNotion(p, ids, bot)) }); } catch (e) { return placeFail(c, e); }
});
// Where in Notion: a page Niko makes (with the name they choose), or one of their own pages. Either way, files and what
// Niko learned are copied to the new page; copies on the old one stay there.
knowledge.put('/places/notion', async (c) => {
  const s = await placeStore(c, 'notion'); if (s instanceof Response) return s;
  const b = await c.req.json<{ page?: unknown; name?: unknown }>().catch(() => ({} as { page?: unknown; name?: unknown }));
  const u = c.get('user');
  // Choosing what's already in use changes nothing: nothing is copied again, so nothing is duplicated there.
  const [now] = await s.k.q<{ root_id: string; root_name: string; made: boolean }>(`select root_id, root_name, made from kn_places where account_id = $1 and place = 'notion'`, [u.id]);
  const nid = (v: string) => v.replace(/-/g, '').toLowerCase();
  if (b.page === null) {
    const name = b.name === undefined ? KN_DEFAULT_FOLDER.notion : cleanFolder('notion', b.name);
    if (!name) return c.json({ error: 'Give the page a name.' }, 400);
    if (now && now.made !== false && now.root_name === name) return c.json({ ok: true, root: null, relocated: { files: 0, learned: false } });
    await saveFolder(c, 'notion', name);
    await setRoot(s.k, u.id, 'notion', null);
    return c.json({ ok: true, root: null, relocated: await relocate(s.k, u.id, 'notion') });
  }
  const cred = await credentials(c.env, c.get('db'), u.id, 'notion').catch(() => null);
  if (!cred?.accessToken) return c.json({ error: 'Connect Notion first.', connect: 'notion' }, 409);
  try {
    const p = await notionPage(cred.accessToken, typeof b.page === 'string' ? b.page : '');
    if (now && now.made === false && nid(now.root_id) === nid(p.id)) return c.json({ ok: true, root: p.title, relocated: { files: 0, learned: false } });
    const relocated = await relocate(s.k, u.id, 'notion');
    await setRoot(s.k, u.id, 'notion', { id: p.id, name: p.title });
    return c.json({ ok: true, root: p.title, relocated });
  } catch (e) { return placeFail(c, e); }
});
// Where in Google Drive, OneDrive, their storage or their vault: the name of Niko's folder (with the narrow access
// chosen, Drive and OneDrive only let Niko see the folder it makes), or a folder path in the bucket or vault.
knowledge.put('/places/:place/folder', async (c) => {
  const place = c.req.param('place');
  if (!isRemotePlace(place) || place === 'notion') return c.json({ error: 'Not found.' }, 404);
  const s = await placeStore(c, place); if (s instanceof Response) return s;
  const b = await c.req.json<{ name?: unknown }>().catch(() => ({} as { name?: unknown }));
  const name = cleanFolder(place, b.name);
  if (!name) return c.json({ error: knFolderIsPath(place) ? 'Enter a folder, such as Areas/Niko Knowledge.' : 'Give the folder a name.' }, 400);
  const before = knFolder(s.prefs, place);
  await saveFolder(c, place, name);
  return c.json({ ok: true, folder: name, relocated: name === before ? { files: 0, learned: false } : await relocate(s.k, c.get('user').id, place) });
});

// Their own S3 storage: tried before it's saved, keys never sent back. A new address needs its keys again.
async function storageInput(c: C) {
  const s = await store(c); if (s instanceof Response) return { error: s };
  if (!s.access.s3) return { error: c.json({ error: NOT_ON_ACCOUNT }, 403) };
  const u = c.get('user');
  if (await tooMany(c, 'kn-storage:' + u.id, 30, 3600)) return { error: c.json({ error: 'That’s a lot of tries. Try again in a little while.' }, 429) };
  const saved = await loadStorage(c.env, c.get('db'), u.id);
  const cfg = cleanStorage(await c.req.json().catch(() => ({})), saved);
  if ('problem' in cfg) return { error: c.json({ error: cfg.problem }, 400) };
  return { s, cfg };
}
knowledge.post('/places/storage/test', async (c) => {
  const r = await storageInput(c); if (r.error) return r.error;
  try { await testStorage(r.cfg); return c.json({ ok: true }); } catch (e) { return placeFail(c, e); }
});
knowledge.put('/places/storage', async (c) => {
  const r = await storageInput(c); if (r.error) return r.error;
  try { await testStorage(r.cfg); } catch (e) { return placeFail(c, e); }
  await saveStorage(c.env, c.get('db'), c.get('user').id, r.cfg);
  await audit(c, 'knowledge.storage-saved', { host: new URL(r.cfg.endpoint).hostname }, c.get('user').id);
  return c.json({ ok: true, storage: shownStorage(r.cfg) });
});
knowledge.delete('/places/storage', async (c) => {
  const s = await store(c); if (s instanceof Response) return s;
  if (knRemoteOf(s.prefs, s.access) === 's3') return c.json({ error: 'Your files are kept in your storage. Move them to another place first.' }, 409);
  await saveStorage(c.env, c.get('db'), c.get('user').id, null);
  await setRoot(s.k, c.get('user').id, 's3', null);
  await audit(c, 'knowledge.storage-removed', {}, c.get('user').id);
  return c.json({ ok: true });
});

// Obsidian: set up like their own storage, the vault reached through S3 storage it syncs with or the Local REST API.
// Test tries it without saving; Save tries it and keeps it (keys are never shown again).
async function obsidianInput(c: C) {
  const s = await store(c); if (s instanceof Response) return { error: s };
  if (!s.access.obsidian) return { error: c.json({ error: NOT_ON_ACCOUNT }, 403) };
  const u = c.get('user');
  if (await tooMany(c, 'kn-obsidian:' + u.id, 30, 3600)) return { error: c.json({ error: 'That’s a lot of tries. Try again in a little while.' }, 429) };
  const saved = await loadObsidian(c.env, c.get('db'), u.id);
  const cfg = cleanObsidian(await c.req.json().catch(() => ({})), saved);
  if ('problem' in cfg) return { error: c.json({ error: cfg.problem }, 400) };
  return { s, cfg };
}
knowledge.post('/places/obsidian/test', async (c) => {
  const r = await obsidianInput(c); if (r.error) return r.error;
  try { await testObsidian(r.cfg); return c.json({ ok: true }); } catch (e) { return placeFail(c, e); }
});
knowledge.put('/places/obsidian', async (c) => {
  const r = await obsidianInput(c); if (r.error) return r.error;
  try { await testObsidian(r.cfg); } catch (e) { return placeFail(c, e); }
  await saveObsidian(c.env, c.get('db'), c.get('user').id, r.cfg);
  await audit(c, 'knowledge.obsidian-saved', { way: r.cfg.mode, host: new URL(r.cfg.mode === 's3' ? r.cfg.endpoint : r.cfg.address).hostname }, c.get('user').id);
  return c.json({ ok: true, obsidian: shownObsidian(r.cfg) });
});
knowledge.delete('/places/obsidian', async (c) => {
  const s = await store(c); if (s instanceof Response) return s;
  if (knRemoteOf(s.prefs, s.access) === 'obsidian') return c.json({ error: 'Your files are kept in Obsidian. Move them to another place first.' }, 409);
  if (knLearnPlaceOf(s.prefs, s.access) === 'obsidian') return c.json({ error: 'What Niko learned is kept in Obsidian. Choose another place for it first.' }, 409);
  await saveObsidian(c.env, c.get('db'), c.get('user').id, null);
  await setRoot(s.k, c.get('user').id, 'obsidian', null);
  await audit(c, 'knowledge.obsidian-removed', {}, c.get('user').id);
  return c.json({ ok: true });
});

// Moving a file to the person's device, and making its search numbers again when they change how it's searched.
knowledge.get('/files/:id/pieces', async (c) => {
  const s = await store(c); if (s instanceof Response) return s;
  try { return c.json(await filePieces(s.k, c.get('user').id, c.req.param('id'), c.req.query('start'))); }
  catch (e) { return fail(c, e); }
});
knowledge.get('/files/:id/sheets/:sheet/rows', async (c) => {
  const s = await store(c); if (s instanceof Response) return s;
  try { return c.json(await sheetRows(s.k, c.get('user').id, c.req.param('id'), c.req.param('sheet'), c.req.query('start'))); }
  catch (e) { return fail(c, e); }
});
knowledge.put('/files/:id/numbers', async (c) => {
  const s = await store(c); if (s instanceof Response) return s;
  const b = await c.req.json<Record<string, unknown>>().catch(() => ({}));
  try { return c.json({ ok: true, ...(await setDeviceNumbers(s.k, c.get('user').id, c.req.param('id'), b)) }); }
  catch (e) { return fail(c, e); }
});
knowledge.post('/files/:id/numbers/own', async (c) => {
  const s = await store(c); if (s instanceof Response) return s;
  const u = c.get('user');
  if (knSearchOf(s.prefs, s.access, 'niko') !== 'own') return c.json({ error: NOT_ON_ACCOUNT }, 403);
  if (await tooMany(c, 'kn-own:' + u.id, 600, 60)) return c.json({ error: 'That’s a lot at once. Try again in a little while.' }, 429);
  try { return c.json({ ok: true, ...(await addOwnNumbers(s.k, u.id, c.req.param('id'), await ownEmbedder(c.env, c.get('db'), u, s.prefs.own!))) }); }
  catch (e) { return fail(c, e); }
});
knowledge.post('/files/:id/numbers/cloudflare', async (c) => {
  const s = await store(c); if (s instanceof Response) return s;
  const u = c.get('user');
  if (!useCloudflare(s.access, s.prefs)) return c.json({ error: NOT_ON_ACCOUNT }, 403);
  if (await tooMany(c, 'kn-cf:' + u.id, 600, 60)) return c.json({ error: 'That’s a lot at once. Try again in a little while.' }, 429);
  try { return c.json({ ok: true, ...(await addCloudflareNumbers(s.k, c.env, u.id, c.req.param('id'))) }); }
  catch (e) { return fail(c, e); }
});

// The key this account's files on a device are locked with. It is made from the server's own secret and the account,
// so files kept on a shared computer can only be read while that person is signed in. Never stored or logged.
knowledge.get('/device-key', async (c) => {
  const { access } = await who(c);
  if (!access.device && !access.learnPlaces.device) return c.json({ error: NOT_ON_ACCOUNT }, 403);
  c.header('Cache-Control', 'no-store');
  return c.json({ key: await hmacSha256Hex(c.env.ENCRYPTION_KEY, `niko.knowledge.device.v1:${c.get('user').id}`) });
});

// What Niko learned: everything, with what each note says, how it was learned and how sure Niko is. Only the person
// sees this; the admin sees counts.
knowledge.get('/learned', async (c) => {
  const s = await notesStore(c); if (s instanceof Response) return s;
  return c.json({ items: await listLearned(s.k, c.get('user').id) });
});
// Bringing notes kept on the person's device into Niko when they move what Niko learned here: names, corrections,
// playbooks, things to remember and habits said yes to, with the same checks as any note.
knowledge.post('/learned', async (c) => {
  const s = await notesStore(c); if (s instanceof Response) return s;
  const u = c.get('user');
  if (await tooMany(c, 'kn-note:' + u.id, 1200, 60)) return c.json({ error: 'That’s a lot at once. Try again in a little while.' }, 429);
  const b = await c.req.json<{ kind?: unknown; said?: unknown; means?: unknown; how?: unknown; habit?: unknown }>().catch(() => ({} as { kind?: unknown; said?: unknown; means?: unknown; how?: unknown; habit?: unknown }));
  // A habit they said yes to on the device comes over as said yes to.
  if (b.kind === 'habit') {
    if (!isHabit(b.habit)) return c.json({ error: 'Nothing to keep.' }, 400);
    try { await keepHabit(s.k, u.id, b.habit); await syncNotes(c, s.k); return c.json({ ok: true }); } catch (e) { return fail(c, e); }
  }
  const kind = b.kind === 'person' || b.kind === 'correction' || b.kind === 'remembered' || b.kind === 'playbook' ? b.kind : null;
  if (!kind || typeof b.said !== 'string' || typeof b.means !== 'string') return c.json({ error: 'Nothing to keep.' }, 400);
  const how = (['told', 'corrected', 'chose', 'remember', 'confirmed', 'agreed'] as const).find((h) => h === b.how) ?? 'told';
  const place = knPlaceOf(s.prefs, s.access);
  try {
    const item = await saveNote(s.k, c.env, u.id, { kind, said: b.said, means: b.means, how }, { cloudflare: knSearchOf(s.prefs, s.access, place) === 'cloudflare' });
    await syncNotes(c, s.k);
    return c.json({ ok: true, item });
  } catch (e) { return fail(c, e); }
});
knowledge.patch('/learned/:id', async (c) => {
  const s = await notesStore(c); if (s instanceof Response) return s;
  const b = await c.req.json<Record<string, unknown>>().catch(() => ({}));
  const place = knPlaceOf(s.prefs, s.access);
  try { return c.json({ ok: true, item: await editNote(s.k, c.env, c.get('user').id, c.req.param('id'), b, { cloudflare: knSearchOf(s.prefs, s.access, place) === 'cloudflare' }) }); }
  catch (e) { return fail(c, e); }
});
knowledge.delete('/learned/:id', async (c) => {
  const s = await notesStore(c); if (s instanceof Response) return s;
  if (await forgetNote(s.k, c.get('user').id, c.req.param('id'))) await syncNotes(c, s.k);
  return c.json({ ok: true });
});
knowledge.delete('/learned', async (c) => {
  const s = await notesStore(c); if (s instanceof Response) return s;
  const u = c.get('user'), only = c.req.query('only');
  // Moving notes or files elsewhere: only the notes, or only the matches taught for files.
  if (only === 'notes' || only === 'file-matches') {
    const n = only === 'notes' ? await forgetNotesOnly(s.k, u.id) : await forgetAllFileMatches(s.k, u.id);
    await syncNotes(c, s.k);
    return c.json({ ok: true, forgot: n });
  }
  const n = await forgetAll(s.k, u.id);
  const lp = knLearnPlaceOf(s.prefs, s.access);
  if (isRemotePlace(lp)) await binLearnedCopy(s.k, await remoteFor(c.env, c.get('db'), u.id, lp).catch(() => null), u.id);
  await syncNotes(c, s.k);
  await audit(c, 'knowledge.forget-all', { notes: n }, c.get('user').id);
  return c.json({ ok: true, forgot: n });
});
// Rewrites the copy of what Niko learned in their own app, when something changed (at most once a minute). The app
// calls this after a change, so the request that changed a note stays within Cloudflare's limits.
knowledge.post('/learned/copy', async (c) => {
  const s = await notesStore(c); if (s instanceof Response) return s;
  const u = c.get('user'), lp = knLearnPlaceOf(s.prefs, s.access);
  if (!isRemotePlace(lp)) return c.json({ error: 'What Niko learns isn’t copied anywhere.' }, 409);
  if (await tooMany(c, 'kn-lcopy:' + u.id, 60, 3600)) return c.json({ error: 'That’s a lot of updates. Niko will catch up in a little while.' }, 429);
  const remote = await remoteFor(c.env, c.get('db'), u.id, lp);
  if (!remote) return c.json({ error: (lp === 's3' ? 'Add your storage first, on the Files tab.' : lp === 'obsidian' ? 'Set up Obsidian again, on the Files tab.' : `Connect ${KN_PLACE_NAMES[lp]} again.`), connect: lp }, 409);
  try { return c.json({ ok: true, copy: await syncLearnedCopy(s.k, remote, u.id) }); }
  catch (e) { return placeFail(c, e); }
});
// Habits Niko notices: one sighting from the app's watcher (a short trip switched to walking, the inbox opened first
// thing on a weekday morning). Suggested once, after enough sightings; kept only with a yes.
knowledge.post('/notice', async (c) => {
  const s = await notesStore(c); if (s instanceof Response) return s;
  if (!s.prefs.learn) return c.json({ suggest: false });
  const u = c.get('user');
  if (await tooMany(c, 'kn-notice:' + u.id, 60, 60)) return c.json({ suggest: false });
  const b = await c.req.json<{ habit?: unknown; key?: unknown }>().catch(() => ({} as { habit?: unknown; key?: unknown }));
  if (!isHabit(b.habit) || typeof b.key !== 'string' || !/^[\w:.-]{1,60}$/.test(b.key)) return c.json({ error: 'Nothing to notice.' }, 400);
  const r = await noticeHabit(s.k, u.id, b.habit, b.key);
  if (r.id) await syncNotes(c, s.k);
  return c.json({ suggest: r.suggest, id: r.id, ...(r.suggest ? { ask: KN_HABITS[b.habit].ask } : {}) });
});
knowledge.post('/learned/:id/keep', async (c) => {
  const s = await notesStore(c); if (s instanceof Response) return s;
  try { const item = await confirmHabit(s.k, c.get('user').id, c.req.param('id')); await syncNotes(c, s.k); return c.json({ ok: true, item }); }
  catch (e) { return fail(c, e); }
});
knowledge.post('/learned/:id/decline', async (c) => {
  const s = await notesStore(c); if (s instanceof Response) return s;
  await declineHabit(s.k, c.get('user').id, c.req.param('id'));
  await syncNotes(c, s.k);
  return c.json({ ok: true });
});
// "That's the one" / "Not this one" on a similar match, from the person's own tap or voice in the app.
knowledge.post('/taught', async (c) => {
  const s = await notesStore(c); if (s instanceof Response) return s;
  if (!s.prefs.learn) return c.json({ error: 'Learning is paused. Turn it on in Settings · Knowledge · What Niko learned.' }, 409);
  const u = c.get('user');
  if (await tooMany(c, 'kn-taught:' + u.id, 120, 60)) return c.json({ error: 'That’s a lot at once. Try again in a little while.' }, 429);
  const b = await c.req.json<{ question?: unknown; target?: unknown; answer?: unknown }>().catch(() => ({} as { question?: unknown; target?: unknown; answer?: unknown }));
  const target = cleanTarget({ ...(b.target && typeof b.target === 'object' ? b.target : {}), answer: b.answer === 'no' ? 'no' : 'yes' });
  if (!target || typeof b.question !== 'string' || !b.question.trim()) return c.json({ error: 'Nothing to teach.' }, 400);
  const place = knPlaceOf(s.prefs, s.access);
  try {
    const item = await saveNote(s.k, c.env, u.id, { kind: 'file-match', said: b.question, means: `${target.file}${target.heading ? ` › ${target.heading}` : ''}`, how: target.answer, target }, { cloudflare: knSearchOf(s.prefs, s.access, place) === 'cloudflare' });
    await syncNotes(c, s.k);
    return c.json({ ok: true, item });
  } catch (e) { return fail(c, e); }
});

// Cloudflare turns a PDF, Word or spreadsheet file into text and keeps nothing; the browser then splits the text.
// The file is sent as the request body, with its name in ?name=.
knowledge.post('/read', async (c) => {
  if (!accountKnowledge(c.env, c.get('user').id)) return c.json({ error: NOT_HERE }, 503);
  const u = c.get('user');
  const { access, prefs } = await who(c);
  if (!access.cloudflareRead || prefs.read !== 'cloudflare') return c.json({ error: 'Reading PDF and Word files with Cloudflare isn’t on. Choose it in Settings · Knowledge, or add the text as an MD or TXT file.' }, 403);
  if (await tooMany(c, 'kn-read:' + u.id, 60, 60)) return c.json({ error: 'That’s a lot of files at once. Try again in a little while.' }, 429);
  const limits = await limitsFor(c.get('db'), u);
  const declared = Number(c.req.header('content-length') ?? 0);
  if (declared > limits.mbPerFile * 1024 * 1024) return c.json({ error: `Each file can be up to ${limits.mbPerFile} MB.` }, 413);
  try { return c.json({ ok: true, ...(await readWithCloudflare(c.env, c.req.query('name') ?? '', await c.req.arrayBuffer(), limits.mbPerFile * 1024 * 1024)) }); }
  catch (e) { return fail(c, e); }
});

// Searches the person's files: used by the Knowledge screen's "Try a question" and by answers.
knowledge.post('/search', async (c) => {
  const s = await store(c); if (s instanceof Response) return s;
  const u = c.get('user');
  if (await tooMany(c, 'kn-search:' + u.id, 120, 10)) return c.json({ error: 'Too many searches just now. Try again in a few minutes.' }, 429);
  const b = await c.req.json<{ q?: unknown; vector?: unknown }>().catch(() => ({} as { q?: unknown; vector?: unknown }));
  try { return c.json({ hits: await search(s.k, c.env, u.id, typeof b.q === 'string' ? b.q : '', { cloudflare: useCloudflare(s.access, s.prefs), vector: b.vector }) }); }
  catch (e) { return fail(c, e); }
});
