// Settings · Knowledge: each person's own files. Mounted under /api/knowledge, after sign-in and the plan check.
// What a person may use comes from their AI options (group "knowledge"): Knowledge files and the Niko place must be
// on to keep files here, Cloudflare reading and search only where allowed. Their screens never mention an admin.
import { eq } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import { users } from '@niko/db';
import { aiAllowed, cleanKnowledgePrefs, knowledgeAccess, type KnowledgeAccess, type KnowledgePrefs } from '@niko/shared';
import type { AppEnv } from '../env';
import { audit, tooMany } from '../lib/session';
import { offFor } from '../access';
import { addPieces, addSheet, addSheetRows, deleteFile, finishFile, keepAsData, KnError, knowledgeDb, knowledgeSettings, limitsFor, listFiles, listSheets, readWithCloudflare, search, startFile, updateSheet, usage, type Kdb } from '../knowledge';

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
    available: !!k && w.access.files, access: w.access, prefs: w.prefs, limits: await limitsFor(c.get('db'), u),
    split: settings.split, usage: k && w.access.niko ? await usage(k, u.id) : { files: 0, bytes: 0 },
  });
});

knowledge.put('/prefs', async (c) => {
  const b = await c.req.json<Record<string, unknown>>().catch(() => ({}));
  const u = c.get('user');
  const { access } = await who(c);
  if (!access.files) return c.json({ error: NOT_ON_ACCOUNT }, 403);
  const prefs = cleanKnowledgePrefs({ ...cleanKnowledgePrefs((u as { knowledge?: unknown }).knowledge), ...b });
  // A choice the account doesn't have is kept to what it does have.
  if (prefs.place === 'niko' && !access.niko && access.device) prefs.place = 'device';
  if (prefs.place === 'device' && !access.device && access.niko) prefs.place = 'niko';
  if (!access.cloudflareRead) prefs.read = 'device';
  if (!access.cloudflareSearch) prefs.search = 'device';
  await c.get('db').update(users).set({ knowledge: prefs as unknown as Record<string, unknown> }).where(eq(users.id, u.id));
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
  if (gone) await audit(c, 'knowledge.file-removed', {}, c.get('user').id);
  return c.json({ ok: true });
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
