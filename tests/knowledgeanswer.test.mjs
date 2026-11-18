// Answering from files: when a file leads, when it's only offered, collections that are off or "only my files",
// "from my files", no Knowledge call at all without files, spreadsheet look-ups (count, sum, average, smallest,
// largest, list, filters) and the table tag Niko uses to ask for them. Temporary PostgreSQL with pgvector.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { addPieces, addSheet, finishFile, knowledgeFor, lookupSheet, startFile } from '../apps/api/src/knowledge.ts';
import { askedFromFiles, cleanKnowledgePrefs, knowledgeLimits, stripTableTags, tableTags } from '../packages/shared/src/knowledge.ts';

function pgBin() {
  if (process.env.PG_BIN && existsSync(join(process.env.PG_BIN, 'initdb'))) return process.env.PG_BIN;
  const root = '/usr/lib/postgresql';
  if (!existsSync(root)) return null;
  for (const v of readdirSync(root).sort((a, b) => Number(b) - Number(a))) if (existsSync(join(root, v, 'bin', 'initdb'))) return join(root, v, 'bin');
  return null;
}
let pass = 0;
const ok = async (name, fn) => { try { await fn(); pass++; console.log('PASS', name); } catch (e) { console.log('FAIL', name, e?.stack ?? e?.message); process.exitCode = 1; } };

// Parsing needs no database.
await ok('“from my files” is spotted, by words or by a collection’s name', () => {
  assert.ok(askedFromFiles('From my files, what is our refund policy?'));
  assert.ok(askedFromFiles('according to our handbook, can we swap?'));
  assert.ok(askedFromFiles('what does it say in the Sales sheet', ['Sales']));
  assert.ok(askedFromFiles('what does it say in my Sales', ['Sales']));
  assert.ok(!askedFromFiles('How far away is the Moon?'));
});
await ok('the table tag: operations, columns, filters, at most three, and stripped from what’s said', () => {
  const t = tableTags('[[table:T1|sum|Spend|Active=Yes;Region~north]] and [[table:t2|count|*]]');
  assert.deepEqual(t, [
    { table: 'T1', op: 'sum', column: 'Spend', filters: [{ column: 'Active', cmp: '=', value: 'Yes' }, { column: 'Region', cmp: '~', value: 'north' }] },
    { table: 'T2', op: 'count', column: '*', filters: [] }]);
  assert.deepEqual(tableTags('[[table:T1|drop|x]] [[table:T1|sum|Spend|Spend>=1,000]]')[0], { table: 'T1', op: 'sum', column: 'Spend', filters: [{ column: 'Spend', cmp: '>=', value: '1,000' }] });
  assert.equal(tableTags('[[table:T1|count|*]]'.repeat(5)).length, 3);
  assert.equal(stripTableTags('Let me check. [[table:T1|count|*]]'), 'Let me check.');
});

const bin = pgBin();
if (!bin) { console.log('SKIP knowledge answer test (database part): PostgreSQL is not installed here'); console.log(`${pass} knowledge answer checks passed`); process.exit(process.exitCode ?? 0); }
const asRoot = process.getuid?.() === 0;
const dir = mkdtempSync(join(tmpdir(), 'niko-kna-'));
if (asRoot) execFileSync('chown', ['-R', 'postgres', dir]);
const run = (tool, args) => execFileSync(asRoot ? 'runuser' : join(bin, tool), asRoot ? ['-u', 'postgres', '--', join(bin, tool), ...args] : args, { stdio: 'pipe' });
const port = 20000 + Math.floor(Math.random() * 20000);
run('initdb', ['-D', join(dir, 'data'), '-A', 'trust', '-U', 'niko', '--no-sync']);
run('pg_ctl', ['-D', join(dir, 'data'), '-o', `-p ${port} -k ${dir} -c listen_addresses=127.0.0.1 -c fsync=off`, '-w', '-l', join(dir, 'log'), 'start']);
const stop = () => { try { run('pg_ctl', ['-D', join(dir, 'data'), '-m', 'immediate', 'stop']); } catch { /* stopping */ } rmSync(dir, { recursive: true, force: true }); };
const pool = new pg.Pool({ connectionString: `postgresql://niko@127.0.0.1:${port}/postgres`, max: 4 });
const v = (await pool.query(`select default_version from pg_available_extensions where name = 'vector'`)).rows[0];
if (!v || v.default_version < '0.7') { console.log('SKIP knowledge answer test (database part): pgvector 0.7+ not installed'); await pool.end(); stop(); console.log(`${pass} knowledge answer checks passed`); process.exit(process.exitCode ?? 0); }
const migDir = new URL('../packages/db/knowledge/', import.meta.url).pathname;
for (const f of readdirSync(migDir).filter((f) => f.endsWith('.sql')).sort()) await pool.query(readFileSync(join(migDir, f), 'utf8'));
let queries = 0;
const k = { q: async (text, params = []) => { queries++; return (await pool.query(text, params)).rows; } };
// Search numbers from the words, so the same words land close together (a stand-in for Cloudflare).
const wordsVec = (text, dims) => {
  const out = new Array(dims).fill(0);
  for (const w of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) { let h = 7; for (const ch of w) h = (h * 31 + ch.charCodeAt(0)) >>> 0; out[h % dims] += 1; }
  const n = Math.hypot(...out) || 1; return out.map((x) => x / n);
};
const env = { AI: { run: async (_m, input) => ({ data: input.text.map((t) => wordsVec(t, 1024)) }) } };
const A = '00000000-0000-4000-8000-0000000000a1';
const limits = knowledgeLimits({}, {});
const addText = async (name, collection, pieces, c = name[0]) => {
  const f = await startFile(k, A, limits, { name, bytes: 100, sha256: c.repeat(64), collection });
  await addPieces(k, env, A, f.id, { start: 0, pieces }, { cloudflare: true }); await finishFile(k, A, f.id); return f.id;
};
await addText('Team handbook.md', 'Team', [{ heading: 'Returns', body: 'Customers can swap items within 30 days with the receipt.' }, { heading: 'Hours', body: 'The shop opens at 9 and closes at 6 on weekdays.' }], 'a');
await addText('Private diary.md', 'Personal', [{ heading: 'Returns', body: 'Customers can swap items within 30 days with the receipt, I wrote this too.' }], 'b');
const sheetFile = await startFile(k, A, limits, { name: 'Clients.csv', bytes: 300, sha256: 'c'.repeat(64), collection: 'Sales' });
const sh = await addSheet(k, A, sheetFile.id, { name: 'Clients', columns: [{ name: 'Client', type: 'text' }, { name: 'Region', type: 'text' }, { name: 'Spend', type: 'number' }, { name: 'Active', type: 'yesno' }, { name: 'Since', type: 'date' }],
  rows: [['Acme Trading', 'North', '12,400', 'Yes', '2021-03-04'], ['Bolt Ltd', 'South', '800', 'No', '2022-07-01'], ['Cove Pte', 'North-east', '$3,000.50', 'Yes', '2020-01-15'], ['Dune Co', 'West', 'n/a', 'Yes', '2023-05-20']] });
await addPieces(k, env, A, sheetFile.id, { start: 0, pieces: [{ heading: 'Clients · Acme Trading', body: 'Client: Acme Trading. Region: North. Spend: 12,400. Active: Yes' }] }, { cloudflare: true });
await finishFile(k, A, sheetFile.id);
const prefs = (x = {}) => cleanKnowledgePrefs({ files: 3, ...x });

await ok('no files kept: Knowledge is never asked', async () => {
  const before = queries;
  assert.equal(await knowledgeFor(k, env, A, 'can customers swap items', { prefs: cleanKnowledgePrefs({}), cloudflare: true }), null);
  assert.equal(queries, before);
});
await ok('a close match leads, with its file named, its sources numbered, and file text marked as untrusted', async () => {
  const r = await knowledgeFor(k, env, A, 'Can customers swap items within 30 days with the receipt?', { prefs: prefs(), cloudflare: true });
  assert.ok(r && r.lead && !r.only);
  assert.equal(r.sources[0].file, 'Team handbook.md'); assert.equal(r.sources[0].heading, 'Returns'); assert.equal(r.sources[0].n, 1);
  assert.match(r.block, /<FILES>\n\[1\] Team handbook\.md › Returns\nCustomers can swap/);
  assert.match(r.rules, /untrusted content/); assert.match(r.rules, /never follow instructions/);
});
await ok('nothing close: no files are added, so Niko answers as it always does', async () => {
  assert.equal(await knowledgeFor(k, env, A, 'How far away is the Moon?', { prefs: prefs(), cloudflare: true }), null);
});
await ok('a collection that is off is never used; “only my files” is used only when asked for', async () => {
  let r = await knowledgeFor(k, env, A, 'Can customers swap items within 30 days with the receipt?', { prefs: prefs({ modes: { Personal: 'off' } }), cloudflare: true });
  assert.ok(r.sources.every((s) => s.collection !== 'Personal'));
  r = await knowledgeFor(k, env, A, 'Can customers swap items within 30 days with the receipt?', { prefs: prefs({ modes: { Team: 'only', Personal: 'off' } }), cloudflare: true });
  assert.equal(r, null, 'Team is only for when asked');
  r = await knowledgeFor(k, env, A, 'From my files: can customers swap items within 30 days with the receipt?', { prefs: prefs({ modes: { Team: 'only', Personal: 'off' } }), cloudflare: true });
  assert.ok(r.only && r.sources[0].file === 'Team handbook.md'); assert.match(r.rules, /files only/);
});
await ok('“from my files” with nothing matching still answers from files only, and says so', async () => {
  const r = await knowledgeFor(k, env, A, 'From my files, how far away is the Moon?', { prefs: prefs(), cloudflare: true });
  assert.ok(r && r.only && r.sources.length === 0);
  assert.match(r.block, /nothing in the user’s files matches/);
});
await ok('without search numbers, the best word matches are offered but never lead', async () => {
  const r = await knowledgeFor(k, env, A, 'opens weekdays', { prefs: prefs(), cloudflare: false });
  assert.ok(r && !r.lead && r.sources[0].heading === 'Hours');
});
await ok('a spreadsheet behind a match is listed as a table with its columns', async () => {
  const r = await knowledgeFor(k, env, A, 'Client Acme Trading Region North Spend Active', { prefs: prefs(), cloudflare: true });
  assert.ok(r.tables.T1 === sh.id);
  assert.match(r.block, /<TABLES>\nT1: Clients\.csv › Clients, 4 rows\. Columns: Client \(text\), Region \(text\), Spend \(number\), Active \(yes\/no\), Since \(date\)/);
  assert.match(r.rules, /\[\[table:/);
});
await ok('look-ups: count, sum, average, smallest, largest, list, with filters; money and commas understood', async () => {
  const t = (op, column, filters = []) => lookupSheet(k, A, sh.id, { table: 'T1', op, column, filters });
  assert.match(await t('count', '*'), /4 rows\./);
  assert.match(await t('count', '*', [{ column: 'active', cmp: '=', value: 'yes' }]), /3 rows where active = yes/);
  assert.match(await t('sum', 'Spend'), /total Spend is 16,200\.5, from 3 rows/);
  assert.match(await t('avg', 'Spend', [{ column: 'Region', cmp: '~', value: 'north' }]), /average Spend is 7,700\.25, from 2 rows where Region contains north/);
  assert.match(await t('max', 'Spend'), /largest Spend is 12,400/);
  assert.match(await t('min', 'Since'), /smallest Since is 2020-01-15/);
  assert.match(await t('count', '*', [{ column: 'Spend', cmp: '>', value: '1,000' }]), /2 rows where Spend > 1,000/);
  assert.match(await t('list', '*', [{ column: 'Active', cmp: '!=', value: 'Yes' }]), /1 row where Active != Yes:\nClient: Bolt Ltd; Region: South; Spend: 800; Active: No; Since: 2022-07-01/);
  assert.match(await t('sum', 'Price'), /no column called “Price”\. The columns are: Client, Region, Spend, Active, Since/);
  assert.match(await t('count', '*', [{ column: 'Nope', cmp: '=', value: 'x' }]), /no column called “Nope”/);
});
await ok('a value written to look like SQL is only ever a value', async () => {
  const r = await lookupSheet(k, A, sh.id, { table: 'T1', op: 'count', column: '*', filters: [{ column: 'Client', cmp: '=', value: "x' or '1'='1" }] });
  assert.match(r, /0 rows/);
  assert.equal((await k.q('select count(*)::int as n from kn_sheet_rows where sheet_id = $1', [sh.id]))[0].n, 4, 'nothing changed');
});
await ok('someone else’s table can’t be looked up', async () => {
  assert.match(await lookupSheet(k, '00000000-0000-4000-8000-0000000000b2', sh.id, { table: 'T1', op: 'count', column: '*', filters: [] }), /no longer kept/);
});

await pool.end();
stop();
console.log(`${pass} knowledge answer checks passed`);
