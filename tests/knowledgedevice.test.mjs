// Knowledge kept on "This device": what the browser may send with a question (checked and capped), searching here by
// words and by meaning, the same spreadsheet look-ups as the server (compared row for row), answering from what the
// browser sent (lead, offer, collections, tables), files in Niko searched with this device's numbers, moving files
// (pieces and rows a page at a time), re-reading for search, and the pinned search model's files.
// Temporary PostgreSQL with pgvector for the server parts.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import {
  addCloudflareNumbers, addOwnNumbers, clearOwnNumbers, addPieces, addSheet, deviceKnowledgeFor, filePieces, finishFile, knowledgeFor, listFiles, lookupSheet, setDeviceNumbers, sheetRows, startFile,
} from '../apps/api/src/knowledge.ts';
import { cleanKnowledgePrefs, knowledgeLimits } from '../packages/shared/src/knowledge.ts';
import { cleanDeviceKnowledge, cleanTableAsks, cleanTableResults, knPlaceOf, knSearchOf, lookupRows, KN_DEVICE_HITS_MAX } from '../packages/shared/src/knowledgeDevice.ts';
import { LocalIndex, words } from '../apps/app/src/knowledgeLocal.ts';
import { EMBED_PINNED, embedFileFor } from '../apps/app/src/embedPins.ts';

function pgBin() {
  if (process.env.PG_BIN && existsSync(join(process.env.PG_BIN, 'initdb'))) return process.env.PG_BIN;
  const root = '/usr/lib/postgresql';
  if (!existsSync(root)) return null;
  for (const v of readdirSync(root).sort((a, b) => Number(b) - Number(a))) if (existsSync(join(root, v, 'bin', 'initdb'))) return join(root, v, 'bin');
  return null;
}
let pass = 0;
const ok = async (name, fn) => { try { await fn(); pass++; console.log('PASS', name); } catch (e) { console.log('FAIL', name, e?.stack ?? e?.message); process.exitCode = 1; } };
// Search numbers from the words, so the same words land close together (a stand-in for the real models).
const wordsVec = (text, dims) => {
  const out = new Array(dims).fill(0);
  for (const w of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) { let h = 7; for (const ch of w) h = (h * 31 + ch.charCodeAt(0)) >>> 0; out[h % dims] += 1; }
  const n = Math.hypot(...out) || 1; return out.map((x) => x / n);
};

await ok('what the browser sends is checked: capped, trimmed, control characters dropped, bad sheets refused', () => {
  const many = Array.from({ length: 15 }, (_, i) => ({ file: `f${i}.md`, heading: 'H', text: `piece ${i}\u0000`, collection: 'Work', similarity: i === 0 ? 7 : 0.5 }));
  const d = cleanDeviceKnowledge({ hits: [...many, { file: '', text: 'no file' }, 'junk'], numbers: true,
    tables: [{ sheet: 'ok-1', file: 'a.csv', name: 'A', rows: 3, columns: [{ name: 'Spend', type: 'number' }, { name: 'X', type: 'evil' }] }, { sheet: '../x', file: 'b.csv', columns: [{ name: 'Y' }] }, { sheet: 'nocols', file: 'c.csv', columns: [] }] });
  assert.equal(d.hits.length, KN_DEVICE_HITS_MAX);
  assert.equal(d.hits[0].text, 'piece 0'); assert.equal(d.hits[0].similarity, 1);
  assert.equal(cleanDeviceKnowledge({ hits: [{ file: 'a', text: 'x'.repeat(5000) }] }).hits[0].text.length, 2000);
  assert.deepEqual(d.tables, [{ sheet: 'ok-1', file: 'a.csv', name: 'A', rows: 3, columns: [{ name: 'Spend', type: 'number' }, { name: 'X', type: 'text' }] }]);
  assert.equal(d.numbers, true);
  assert.equal(cleanDeviceKnowledge('nope'), null);
  assert.deepEqual(cleanTableResults(['a', 'b', 'c', 'd', 5, 'x'.repeat(9000)]).map((s) => s.length), [1, 1, 1]);
  assert.equal(cleanTableResults(['x'.repeat(9000)])[0].length, 4000);
});
await ok('look-ups handed back to the browser are checked like tags', () => {
  assert.deepEqual(cleanTableAsks([{ sheet: 'abc-1', op: 'sum', column: 'Spend', filters: [{ column: 'Active', cmp: '=', value: 'Yes' }] }, { sheet: 'x y', op: 'sum', column: 'a' }, { sheet: 'ok', op: 'drop', column: 'a' }]),
    [{ table: 'T1', op: 'sum', column: 'Spend', filters: [{ column: 'Active', cmp: '=', value: 'Yes' }], sheet: 'abc-1' }]);
});
await ok('where files are kept and how they are searched follow what the account may use', () => {
  const all = { niko: true, device: true, cloudflareSearch: true };
  assert.equal(knPlaceOf({ place: 'device' }, all), 'device');
  assert.equal(knPlaceOf({ place: 'device' }, { ...all, device: false }), 'niko');
  assert.equal(knPlaceOf({ place: 'niko' }, { ...all, niko: false }), 'device');
  assert.equal(knSearchOf({ search: 'cloudflare' }, all, 'niko'), 'cloudflare');
  assert.equal(knSearchOf({ search: 'cloudflare' }, all, 'device'), 'device', 'files on the device are searched on the device');
  assert.equal(knSearchOf({ search: 'cloudflare' }, { cloudflareSearch: false }, 'niko'), 'device');
});
await ok('searching here: words (Chinese as pairs), then meaning, merged by rank; similarity only from meaning', () => {
  assert.deepEqual(words('Refund policy: 30 days, a'), ['refund', 'policy', '30', 'days']);
  assert.deepEqual(words('退货政策'), ['退货', '货政', '政策']);
  const docs = [
    { id: 'a', text: 'Returns\nCustomers can swap items within 30 days with the receipt.' },
    { id: 'b', text: 'Hours\nThe shop opens at 9 and closes at 6 on weekdays.' },
    { id: 'c', text: '退货政策：三十天内可以退货。' },
  ];
  const ix = new LocalIndex(docs);
  const w = ix.search('when does the shop open on weekdays', null);
  assert.equal(w[0].id, 'b'); assert.equal(w[0].similarity, 0);
  assert.equal(ix.search('退货', null)[0].id, 'c');
  assert.deepEqual(ix.search('zebra', null), []);
  const iv = new LocalIndex(docs.map((d) => ({ ...d, vector: wordsVec(d.text, 384) })));
  const m = iv.search('swap items receipt', wordsVec('Customers can swap items within 30 days with the receipt', 384));
  assert.equal(m[0].id, 'a'); assert.ok(m[0].similarity > 0.86, String(m[0].similarity));
});
const bin = pgBin();
if (!bin) { console.log('SKIP knowledge device test (database part): PostgreSQL is not installed here'); console.log(`${pass} knowledge device checks passed`); process.exit(process.exitCode ?? 0); }
const asRoot = process.getuid?.() === 0;
const dir = mkdtempSync(join(tmpdir(), 'niko-knd-'));
if (asRoot) execFileSync('chown', ['-R', 'postgres', dir]);
const run = (tool, args) => execFileSync(asRoot ? 'runuser' : join(bin, tool), asRoot ? ['-u', 'postgres', '--', join(bin, tool), ...args] : args, { stdio: 'pipe' });
const port = 20000 + Math.floor(Math.random() * 20000);
run('initdb', ['-D', join(dir, 'data'), '-A', 'trust', '-U', 'niko', '--no-sync']);
run('pg_ctl', ['-D', join(dir, 'data'), '-o', `-p ${port} -k ${dir} -c listen_addresses=127.0.0.1 -c fsync=off`, '-w', '-l', join(dir, 'log'), 'start']);
const stop = () => { try { run('pg_ctl', ['-D', join(dir, 'data'), '-m', 'immediate', 'stop']); } catch { /* stopping */ } rmSync(dir, { recursive: true, force: true }); };
const pool = new pg.Pool({ connectionString: `postgresql://niko@127.0.0.1:${port}/postgres`, max: 4 });
const v = (await pool.query(`select default_version from pg_available_extensions where name = 'vector'`)).rows[0];
if (!v || v.default_version < '0.7') { console.log('SKIP knowledge device test (database part): pgvector 0.7+ not installed'); await pool.end(); stop(); console.log(`${pass} knowledge device checks passed`); process.exit(process.exitCode ?? 0); }
const migDir = new URL('../packages/db/knowledge/', import.meta.url).pathname;
for (const f of readdirSync(migDir).filter((f) => f.endsWith('.sql')).sort()) await pool.query(readFileSync(join(migDir, f), 'utf8'));
const k = { q: async (text, params = []) => (await pool.query(text, params)).rows };
const env = { AI: { run: async (_m, input) => ({ data: input.text.map((t) => wordsVec(t, 1024)) }) } };
const A = '00000000-0000-4000-8000-0000000000a1', B = '00000000-0000-4000-8000-0000000000b2';
const limits = knowledgeLimits({}, {});
const prefs = (x = {}) => cleanKnowledgePrefs({ files: 3, ...x });
const sheetCols = [{ name: 'Client', type: 'text' }, { name: 'Region', type: 'text' }, { name: 'Spend', type: 'number' }, { name: 'Active', type: 'yesno' }, { name: 'Since', type: 'date' }];
const sheetData = [['Acme Trading', 'North', '12,400', 'Yes', '2021-03-04'], ['Bolt Ltd', 'South', '800', 'No', '2022-07-01'], ['Cove Pte', 'North-east', '$3,000.50', 'Yes', '2020-01-15'], ['Dune Co', 'West', 'n/a', 'Yes', '2023-05-20'], ['Echo', 'north', '-5', 'yes', '']];

await ok('look-ups on rows kept here give exactly what the server gives', async () => {
  const f = await startFile(k, A, limits, { name: 'Clients.csv', bytes: 300, sha256: 'c'.repeat(64), collection: 'Sales' });
  const sh = await addSheet(k, A, f.id, { name: 'Clients', columns: sheetCols, rows: sheetData });
  await finishFile(k, A, f.id);
  const asks = [
    ['count', '*', []], ['count', '*', [['Active', '=', 'yes']]], ['count', 'Since', []], ['sum', 'Spend', []], ['avg', 'Spend', [['Region', '~', 'north']]],
    ['max', 'Spend', []], ['min', 'Spend', []], ['min', 'Since', []], ['max', 'Client', []], ['count', '*', [['Spend', '>', '1,000']]], ['count', '*', [['Spend', '<=', '$800']]],
    ['list', '*', [['Active', '!=', 'Yes']]], ['list', '*', []], ['sum', 'Price', []], ['count', '*', [['Nope', '=', 'x']]], ['count', '*', [['Client', '=', "x' or '1'='1"]]],
    ['count', '*', [['Region', '=', 'NORTH']]], ['count', '*', [['Client', '~', '']]], ['sum', 'Region', []],
  ];
  for (const [op, column, fs] of asks) {
    const ask = { table: 'T1', op, column, filters: fs.map(([c, cmp, value]) => ({ column: c, cmp, value })) };
    assert.equal(lookupRows({ file: 'Clients.csv', name: 'Clients', columns: sheetCols }, sheetData, ask), await lookupSheet(k, A, sh.id, ask), `${op} ${column} ${JSON.stringify(fs)}`);
  }
});
await ok('answering from what the browser sent: a close match leads (device scale), a weaker one is only offered', () => {
  const dev = cleanDeviceKnowledge({ numbers: true, hits: [
    { file: 'Team handbook.md', heading: 'Returns', text: 'Customers can swap items within 30 days.', collection: 'Team', similarity: 0.9 },
    { file: 'Notes.md', heading: null, text: 'Something else', collection: 'General', similarity: 0.5 }] });
  const r = deviceKnowledgeFor(dev, 'Can customers swap items?', prefs());
  assert.ok(r.lead && r.device && !r.only);
  assert.equal(r.sources.length, 1); assert.equal(r.sources[0].file, 'Team handbook.md');
  assert.match(r.block, /<FILES>\n\[1\] Team handbook\.md › Returns\nCustomers can swap/); assert.match(r.rules, /untrusted content/);
  const weaker = deviceKnowledgeFor(cleanDeviceKnowledge({ numbers: true, hits: [{ ...dev.hits[0], similarity: 0.84 }] }), 'swap?', prefs());
  assert.ok(weaker && !weaker.lead && weaker.sources.length === 1);
  assert.equal(deviceKnowledgeFor(cleanDeviceKnowledge({ numbers: true, hits: [{ ...dev.hits[0], similarity: 0.7 }] }), 'moon?', prefs()), null);
  const byWords = deviceKnowledgeFor(cleanDeviceKnowledge({ numbers: false, hits: dev.hits }), 'swap', prefs());
  assert.ok(byWords && !byWords.lead && byWords.sources.length === 2, 'words only: best matches offered, never lead');
});
await ok('collections that are off or “only my files”, and tables only for files that matched', () => {
  const dev = cleanDeviceKnowledge({ numbers: true, hits: [{ file: 'Clients.csv', heading: 'Clients · Acme', text: 'Client: Acme. Spend: 12,400', collection: 'Sales', similarity: 0.9 }],
    tables: [{ sheet: 's-1', file: 'Clients.csv', name: 'Clients', rows: 5, columns: sheetCols }, { sheet: 's-2', file: 'Other.csv', name: 'Other', rows: 1, columns: [{ name: 'A', type: 'text' }] }] });
  const r = deviceKnowledgeFor(dev, 'How much did Acme spend?', prefs());
  assert.deepEqual(r.tables, { T1: 's-1' }); assert.match(r.block, /T1: Clients\.csv › Clients, 5 rows/); assert.match(r.rules, /\[\[table:/);
  assert.equal(deviceKnowledgeFor(dev, 'How much did Acme spend?', prefs({ modes: { Sales: 'off' } })), null);
  assert.equal(deviceKnowledgeFor(dev, 'How much did Acme spend?', prefs({ modes: { Sales: 'only' } })), null);
  assert.ok(deviceKnowledgeFor(dev, 'From my files, how much did Acme spend?', prefs({ modes: { Sales: 'only' } })).only);
});
let hb;
await ok('files in Niko searched with this device’s numbers: the device scale decides what leads; bad numbers fall back to words', async () => {
  const f = await startFile(k, A, limits, { name: 'Team handbook.md', bytes: 100, sha256: 'a'.repeat(64), collection: 'Team' });
  const pieces = [{ heading: 'Returns', body: 'Customers can swap items within 30 days with the receipt.' }, { heading: 'Hours', body: 'The shop opens at 9 and closes at 6 on weekdays.' }];
  await addPieces(k, env, A, f.id, { start: 0, pieces, vectors: pieces.map((p) => wordsVec(`${p.heading}\n${p.body}`, 384)) }, { cloudflare: false });
  await finishFile(k, A, f.id); hb = f.id;
  const q = 'Returns: customers can swap items within 30 days with the receipt';
  const r = await knowledgeFor(k, env, A, q, { prefs: prefs(), cloudflare: false, vector: wordsVec(q, 384) });
  assert.ok(r && r.lead && !r.device && r.sources[0].heading === 'Returns');
  const words = await knowledgeFor(k, env, A, 'opens weekdays', { prefs: prefs(), cloudflare: false, vector: [1, 2, 3] });
  assert.ok(words && !words.lead && words.sources[0].heading === 'Hours');
});
await ok('the file list says how many pieces have each kind of search numbers, and the file’s fingerprint', async () => {
  const f = (await listFiles(k, A)).find((x) => x.id === hb);
  assert.deepEqual(f.numbers, { cloudflare: 0, device: 2, own: 0 }); assert.equal(f.sha256, 'a'.repeat(64));
});
await ok('re-reading for search: Cloudflare numbers for pieces without them; this device’s numbers by piece number', async () => {
  let r = await addCloudflareNumbers(k, env, A, hb);
  assert.deepEqual(r, { updated: 2, left: 0 });
  r = await addCloudflareNumbers(k, env, A, hb);
  assert.deepEqual(r, { updated: 0, left: 0 });
  assert.deepEqual((await setDeviceNumbers(k, A, hb, { start: 1, vectors: [wordsVec('x', 384)] })), { updated: 1 });
  await assert.rejects(setDeviceNumbers(k, A, hb, { start: 0, vectors: [[1, 2]] }), /search numbers/i);
  await assert.rejects(setDeviceNumbers(k, B, hb, { start: 0, vectors: [wordsVec('x', 384)] }), /No such file/);
  await assert.rejects(addCloudflareNumbers(k, env, B, hb), /No such file/);
});
await ok('moving files: pieces and rows come a page at a time, only for the file’s own account', async () => {
  const f = await startFile(k, A, limits, { name: 'Big.md', bytes: 100, sha256: 'd'.repeat(64), collection: 'General' });
  for (let i = 0; i < 250; i += 48) await addPieces(k, env, A, f.id, { start: i, pieces: Array.from({ length: Math.min(48, 250 - i) }, (_, j) => ({ heading: null, body: `Piece ${i + j}` })) }, { cloudflare: false });
  await finishFile(k, A, f.id);
  const p1 = await filePieces(k, A, f.id, '0');
  assert.equal(p1.pieces.length, 200); assert.equal(p1.pieces[0].body, 'Piece 0'); assert.equal(p1.next, 200);
  const p2 = await filePieces(k, A, f.id, String(p1.next));
  assert.equal(p2.pieces.length, 50); assert.equal(p2.pieces[49].body, 'Piece 249'); assert.equal(p2.next, null);
  await assert.rejects(filePieces(k, B, f.id, 0), /No such file/);
  const s = await startFile(k, A, limits, { name: 'Rows.csv', bytes: 100, sha256: 'e'.repeat(64), collection: 'General' });
  const sh = await addSheet(k, A, s.id, { name: 'Rows', columns: [{ name: 'N', type: 'number' }], rows: Array.from({ length: 1000 }, (_, i) => [String(i)]) });
  const { addSheetRows } = await import('../apps/api/src/knowledge.ts');
  await addSheetRows(k, A, s.id, sh.id, { start: 1000, rows: Array.from({ length: 500 }, (_, i) => [String(1000 + i)]) });
  await finishFile(k, A, s.id);
  const r1 = await sheetRows(k, A, s.id, sh.id, 0);
  assert.equal(r1.rows.length, 1000); assert.equal(r1.next, 1000);
  const r2 = await sheetRows(k, A, s.id, sh.id, 1000);
  assert.equal(r2.rows.length, 500); assert.deepEqual(r2.rows[499], ['1499']); assert.equal(r2.next, null);
  await assert.rejects(sheetRows(k, B, s.id, sh.id, 0), /No such file/);
  await assert.rejects(sheetRows(k, A, hb, sh.id, 0), /No such sheet/);
});
await ok('the search model: only the repository’s own files, by exact address; nothing runs until both fingerprints are pinned', () => {
  const base = 'https://huggingface.co/Xenova/multilingual-e5-small/resolve/main/';
  assert.equal(embedFileFor(`${base}onnx/model_quantized.onnx`)?.name, 'model');
  assert.equal(embedFileFor(`${base}tokenizer.json`)?.name, 'tokenizer');
  assert.equal(embedFileFor(`${base}config.json`)?.json, true);
  for (const bad of [`${base}onnx/model.onnx`, `https://huggingface.co/evil/multilingual-e5-small/resolve/main/tokenizer.json`, `${base}../x/tokenizer.json`, `https://huggingface.co.evil.com/Xenova/multilingual-e5-small/resolve/main/config.json`, `${base}onnx/model_quantizedXonnx`])
    assert.equal(embedFileFor(bad), null, bad);
  assert.equal(EMBED_PINNED, true);
});

await ok('their own search service: numbers kept apart, used with their own scale, cleared when the model changes', async () => {
  const own = async (texts) => texts.map((t) => wordsVec(t, 768));
  const f = await startFile(k, A, limits, { name: 'Garden notes.md', bytes: 100, sha256: 'b'.repeat(64), collection: 'Home' });
  const pieces = [{ heading: 'Tomatoes', body: 'Water the tomatoes every morning in summer.' }, { heading: 'Roses', body: 'Prune the roses in late winter.' }];
  await addPieces(k, env, A, f.id, { start: 0, pieces }, { cloudflare: true, own });
  await finishFile(k, A, f.id);
  let listed = (await listFiles(k, A)).find((x) => x.id === f.id);
  assert.deepEqual(listed.numbers, { cloudflare: 0, device: 0, own: 2 }, 'their own service replaces Cloudflare for new pieces');
  const q = 'Tomatoes: water the tomatoes every morning in summer';
  const r = await knowledgeFor(k, env, A, q, { prefs: prefs(), cloudflare: false, ownVector: wordsVec(q, 768) });
  assert.ok(r && r.lead && r.sources[0].heading === 'Tomatoes');
  await clearOwnNumbers(k, A);
  listed = (await listFiles(k, A)).find((x) => x.id === f.id);
  assert.equal(listed.numbers.own, 0);
  assert.deepEqual(await addOwnNumbers(k, A, f.id, own), { updated: 2, left: 0 });
  assert.deepEqual(await addOwnNumbers(k, A, f.id, own), { updated: 0, left: 0 });
  // Another account's files are never touched.
  await assert.rejects(addOwnNumbers(k, 'someone-else', f.id, own));
});

await pool.end();
stop();
console.log(`${pass} knowledge device checks passed`);
