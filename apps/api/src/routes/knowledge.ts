// Settings · Knowledge: each person's own files. Mounted under /api/knowledge, after sign-in and the plan check.
// What a person may use comes from their AI options (group "knowledge"): Knowledge files and the Niko place must be
// on to keep files here, Cloudflare reading and search only where allowed. Their screens never mention an admin.
import { eq } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import { users } from '@niko/db';
import { aiAllowed, cleanKnowledgePrefs, cleanTarget, knowledgeAccess, knPlaceOf, knSearchOf, type KnowledgeAccess, type KnowledgePrefs } from '@niko/shared';
import type { AppEnv } from '../env';
import { audit, tooMany } from '../lib/session';
import { hmacSha256Hex } from '../lib/crypto';
import { editNote, forgetAll, forgetFileMatches, forgetNote, learnedCount, listLearned, saveNote } from '../learned';
import { offFor } from '../access';
import { addCloudflareNumbers, addPieces, addSheet, addSheetRows, deleteFile, filePieces, setDeviceNumbers, sheetRows, finishFile, keepAsData, KnError, knowledgeDb, knowledgeSettings, limitsFor, listFiles, listSheets, readWithCloudflare, search, startFile, updateSheet, usage, type Kdb } from '../knowledge';

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
  const notes = await learnedCount(k, u.id);
  const fresh = await c.get('db').select({ knowledge: users.knowledge }).from(users).where(eq(users.id, u.id)).limit(1);
  const prefs = { ...cleanKnowledgePrefs(fresh[0]?.knowledge), notes };
  await c.get('db').update(users).set({ knowledge: prefs as unknown as Record<string, unknown> }).where(eq(users.id, u.id));
}
/** Notes learned in Niko need the Knowledge database and learning in the person's plan (it works without files). */
async function notesStore(c: C): Promise<{ k: Kdb; access: KnowledgeAccess; prefs: KnowledgePrefs } | Response> {
  const k = knowledgeDb(c.env);
  if (!k) return c.json({ error: NOT_HERE }, 503);
  const w = await who(c);
  if (!w.access.learning) return c.json({ error: NOT_ON_ACCOUNT }, 403);
  return { k, ...w };
}
/** Files kept in Niko need the Knowledge database, Knowledge files and the Niko place. */
async function store(c: C): Promise<{ k: Kdb; access: KnowledgeAccess; prefs: KnowledgePrefs } | Response> {
  const k = knowledgeDb(c.env);
  if (!k) return c.json({ error: NOT_HERE }, 503);
  const w = await who(c);
  if (!w.access.niko) return c.json({ error: NOT_ON_ACCOUNT }, 403);
  return { k, ...w };
}

// Everything the Knowledge screen needs at once.
knowledge.get('/', async (c) => {
  const u = c.get('user'), k = knowledgeDb(c.env);
  const w = await who(c);
  const settings = await knowledgeSettings(c.get('db'));
  return c.json({
    available: !!k && (w.access.files || w.access.learning), access: w.access, prefs: w.prefs, limits: await limitsFor(c.get('db'), u),
    split: settings.split, usage: k && w.access.niko ? await usage(k, u.id) : { files: 0, bytes: 0 },
  });
});

knowledge.put('/prefs', async (c) => {
  const b = await c.req.json<Record<string, unknown>>().catch(() => ({}));
  const u = c.get('user');
  const { access } = await who(c);
  if (!access.files) return c.json({ error: NOT_ON_ACCOUNT }, 403);
  const before = cleanKnowledgePrefs((u as { knowledge?: unknown }).knowledge);
  // The file count is kept by the server, never taken from the request.
  const prefs = { ...cleanKnowledgePrefs({ ...before, ...b }), files: before.files, notes: before.notes };
  // A choice the account doesn't have is kept to what it does have.
  if (prefs.place === 'niko' && !access.niko && access.device) prefs.place = 'device';
  if (prefs.place === 'device' && !access.device && access.niko) prefs.place = 'niko';
  if (!access.cloudflareRead) prefs.read = 'device';
  if (!access.cloudflareSearch) prefs.search = 'device';
  await c.get('db').update(users).set({ knowledge: prefs as unknown as Record<string, unknown> }).where(eq(users.id, u.id));
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
  try { return c.json({ ok: true, ...(await addPieces(s.k, c.env, c.get('user').id, c.req.param('id'), b, { cloudflare: useCloudflare(s.access, s.prefs) })) }); }
  catch (e) { return fail(c, e); }
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
  const gone = await deleteFile(s.k, c.get('user').id, c.req.param('id'));
  if (gone) { await forgetFileMatches(s.k, c.get('user').id, c.req.param('id')); await syncCount(c, s.k); await syncNotes(c, s.k); await audit(c, 'knowledge.file-removed', {}, c.get('user').id); }
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
  if (!access.device) return c.json({ error: NOT_ON_ACCOUNT }, 403);
  c.header('Cache-Control', 'no-store');
  return c.json({ key: await hmacSha256Hex(c.env.ENCRYPTION_KEY, `niko.knowledge.device.v1:${c.get('user').id}`) });
});

// What Niko learned: everything, with what each note says, how it was learned and how sure Niko is. Only the person
// sees this; the admin sees counts.
knowledge.get('/learned', async (c) => {
  const s = await notesStore(c); if (s instanceof Response) return s;
  return c.json({ items: await listLearned(s.k, c.get('user').id) });
});
// Bringing notes kept on the person's device into Niko when they move their Knowledge here. Names, corrections and
// things to remember only, with the same checks as any note.
knowledge.post('/learned', async (c) => {
  const s = await notesStore(c); if (s instanceof Response) return s;
  const u = c.get('user');
  if (await tooMany(c, 'kn-note:' + u.id, 1200, 60)) return c.json({ error: 'That’s a lot at once. Try again in a little while.' }, 429);
  const b = await c.req.json<{ kind?: unknown; said?: unknown; means?: unknown; how?: unknown }>().catch(() => ({} as { kind?: unknown; said?: unknown; means?: unknown; how?: unknown }));
  const kind = b.kind === 'person' || b.kind === 'correction' || b.kind === 'remembered' ? b.kind : null;
  if (!kind || typeof b.said !== 'string' || typeof b.means !== 'string') return c.json({ error: 'Nothing to keep.' }, 400);
  const how = (['told', 'corrected', 'chose', 'remember'] as const).find((h) => h === b.how) ?? 'told';
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
  const n = await forgetAll(s.k, c.get('user').id);
  await syncNotes(c, s.k);
  await audit(c, 'knowledge.forget-all', { notes: n }, c.get('user').id);
  return c.json({ ok: true, forgot: n });
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
  if (!knowledgeDb(c.env)) return c.json({ error: NOT_HERE }, 503);
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
