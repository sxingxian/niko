// The Knowledge database: `npm run migrate` sets up both databases (Knowledge only when KNOWLEDGE_DATABASE_URL is set),
// refuses to use the main database for Knowledge, and the schema supports what Knowledge needs: word search, search
// numbers of both sizes, spreadsheets as tables, deleting a file with everything made from it, and keeping each
// account's rows apart. Runs against a temporary local PostgreSQL with pgvector; skipped where either is missing.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';

function pgBin() {
  if (process.env.PG_BIN && existsSync(join(process.env.PG_BIN, 'initdb'))) return process.env.PG_BIN;
  const root = '/usr/lib/postgresql';
  if (!existsSync(root)) return null;
  for (const v of readdirSync(root).sort((a, b) => Number(b) - Number(a))) if (existsSync(join(root, v, 'bin', 'initdb'))) return join(root, v, 'bin');
  return null;
}
const bin = pgBin();
if (!bin) { console.log('SKIP knowledge database test: PostgreSQL (initdb) is not installed here'); process.exit(0); }
const asRoot = process.getuid?.() === 0;
const dir = mkdtempSync(join(tmpdir(), 'niko-kpg-'));
if (asRoot) execFileSync('chown', ['-R', 'postgres', dir]);
const run = (tool, args) => execFileSync(asRoot ? 'runuser' : join(bin, tool), asRoot ? ['-u', 'postgres', '--', join(bin, tool), ...args] : args, { stdio: 'pipe' });
const port = 20000 + Math.floor(Math.random() * 20000);
run('initdb', ['-D', join(dir, 'data'), '-A', 'trust', '-U', 'niko', '--no-sync']);
run('pg_ctl', ['-D', join(dir, 'data'), '-o', `-p ${port} -k ${dir} -c listen_addresses=127.0.0.1 -c fsync=off`, '-w', '-l', join(dir, 'log'), 'start']);
const base = `postgresql://niko@127.0.0.1:${port}`;
const admin = new pg.Client({ connectionString: `${base}/postgres` });
await admin.connect();
const hasVector = (await admin.query(`select default_version from pg_available_extensions where name = 'vector'`)).rows[0];
if (!hasVector || hasVector.default_version < '0.7') {
  console.log('SKIP knowledge database test: pgvector 0.7 or later is not installed here (Neon has 0.8)');
  await admin.end(); run('pg_ctl', ['-D', join(dir, 'data'), '-m', 'immediate', 'stop']); rmSync(dir, { recursive: true, force: true }); process.exit(0);
}
await admin.query('create database main');
await admin.query('create database knowledge');
await admin.end();
const mainUrl = `${base}/main`, knUrl = `${base}/knowledge`;
const migrate = (env, ...args) => spawnSync(process.execPath, [new URL('../scripts/migrate.mjs', import.meta.url).pathname, ...args], { env: { PATH: process.env.PATH, ...env }, encoding: 'utf8' });

let pass = 0;
const ok = async (name, fn) => { try { await fn(); pass++; console.log('PASS', name); } catch (e) { console.log('FAIL', name, e?.stack ?? e?.message); process.exitCode = 1; } };

await ok('without KNOWLEDGE_DATABASE_URL only the main database is updated, and Knowledge stays off', () => {
  const r = migrate({ DATABASE_URL: mainUrl });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Main database: applied \d+ migration/);
  assert.match(r.stdout, /KNOWLEDGE_DATABASE_URL is not set, so Knowledge stays off/);
});
await ok('the same connection string for both is refused before anything runs', () => {
  const r = migrate({ DATABASE_URL: mainUrl, KNOWLEDGE_DATABASE_URL: mainUrl });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /needs its own Neon project/);
});
await ok('with KNOWLEDGE_DATABASE_URL both are updated; running again changes nothing', () => {
  let r = migrate({ DATABASE_URL: mainUrl, KNOWLEDGE_DATABASE_URL: knUrl });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Main database is up to date/);
  assert.match(r.stdout, /Knowledge database: applied \d+ migrations?/);
  r = migrate({ DATABASE_URL: mainUrl, KNOWLEDGE_DATABASE_URL: knUrl });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Knowledge database is up to date/);
});
await ok('a dry run lists nothing to do and changes nothing', () => {
  const r = migrate({ DATABASE_URL: mainUrl, KNOWLEDGE_DATABASE_URL: knUrl }, '--dry-run');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Knowledge database is up to date/);
});

const kn = new pg.Client({ connectionString: knUrl });
await kn.connect();
const q = async (text, params) => (await kn.query(text, params)).rows;
const A = '00000000-0000-4000-8000-00000000000a', B = '00000000-0000-4000-8000-00000000000b';
const vec = (n, hot) => `[${Array.from({ length: n }, (_, i) => (i === hot ? 1 : 0)).join(',')}]`;

await ok('Knowledge tables are not in the main database', async () => {
  const m = new pg.Client({ connectionString: mainUrl }); await m.connect();
  const t = (await m.query(`select count(*)::int as n from information_schema.tables where table_name like 'kn\\_%'`)).rows[0].n;
  await m.end();
  assert.equal(t, 0);
});
await ok('a file, its pieces with both sizes of search numbers, and word search', async () => {
  const [d] = await q(`insert into kn_documents (account_id, name, kind, bytes, sha256, status) values ($1, 'Team handbook.md', 'md', 1200, $2, 'ready') returning id`, [A, 'a'.repeat(64)]);
  await q(`insert into kn_chunks (account_id, document_id, ord, heading, body, embedding) values ($1, $2, 0, 'Returns and exchanges', 'Swaps are allowed within 30 days with the receipt.', $3)`, [A, d.id, vec(1024, 3)]);
  await q(`insert into kn_chunks (account_id, document_id, ord, heading, body, embedding_device) values ($1, $2, 1, 'Warranty', 'Faulty items are repaired or replaced within 12 months.', $3)`, [A, d.id, vec(384, 5)]);
  const words = await q(`select ord from kn_chunks where account_id = $1 and tsv @@ websearch_to_tsquery('simple', 'receipt days')`, [A]);
  assert.deepEqual(words.map((r) => r.ord), [0]);
  const near = await q(`select ord from kn_chunks where account_id = $1 and embedding is not null order by embedding <=> $2::halfvec limit 1`, [A, vec(1024, 3)]);
  assert.equal(near[0].ord, 0);
  const nearDevice = await q(`select ord from kn_chunks where account_id = $1 and embedding_device is not null order by embedding_device <=> $2::halfvec limit 1`, [A, vec(384, 5)]);
  assert.equal(nearDevice[0].ord, 1);
});
await ok('the same file twice for one account is refused; another account may have it', async () => {
  await assert.rejects(q(`insert into kn_documents (account_id, name, kind, bytes, sha256) values ($1, 'copy.md', 'md', 1, $2)`, [A, 'a'.repeat(64)]), /duplicate key/);
  await q(`insert into kn_documents (account_id, name, kind, bytes, sha256) values ($1, 'theirs.md', 'md', 1, $2)`, [B, 'a'.repeat(64)]);
});
await ok('bad values are refused by the database itself', async () => {
  await assert.rejects(q(`insert into kn_documents (account_id, name, kind, bytes, sha256) values ($1, 'x.exe', 'exe', 1, $2)`, [A, 'b'.repeat(64)]), /check constraint/);
  await assert.rejects(q(`insert into kn_documents (account_id, name, kind, bytes, sha256) values ($1, 'x.md', 'md', 1, 'not-a-hash')`, [A]), /check constraint/);
  await assert.rejects(q(`insert into kn_learned (account_id, kind, body, sure) values ($1, 'person', 'x', 1.5)`, [A]), /check constraint/);
  await assert.rejects(q(`insert into kn_learned (account_id, kind, body) values ($1, 'gossip', 'x')`, [A]), /check constraint/);
});
await ok('a spreadsheet is kept as a table, and deleting the file removes its pieces, sheets and rows', async () => {
  const [d] = await q(`insert into kn_documents (account_id, name, kind, bytes, sha256, status) values ($1, 'Contracts.xlsx', 'xlsx', 9000, $2, 'ready') returning id`, [A, 'c'.repeat(64)]);
  const [sh] = await q(`insert into kn_sheets (account_id, document_id, name, columns, row_count) values ($1, $2, 'Sheet1', '["Client","Renews"]', 1) returning id`, [A, d.id]);
  await q(`insert into kn_sheet_rows (sheet_id, ord, cells) values ($1, 0, '["Acme Trading","2026-12-31"]')`, [sh.id]);
  await q(`insert into kn_chunks (account_id, document_id, ord, body) values ($1, $2, 0, 'Acme Trading renews on 31 Dec 2026.')`, [A, d.id]);
  await q(`delete from kn_documents where id = $1`, [d.id]);
  const left = await q(`select (select count(*) from kn_sheets where document_id = $1)::int as s, (select count(*) from kn_sheet_rows where sheet_id = $2)::int as r, (select count(*) from kn_chunks where document_id = $1)::int as c`, [d.id, sh.id]);
  assert.deepEqual(left[0], { s: 0, r: 0, c: 0 });
});
await ok('an account’s search never sees another account’s pieces', async () => {
  const [d] = await q(`select id from kn_documents where account_id = $1 limit 1`, [B]);
  await q(`insert into kn_chunks (account_id, document_id, ord, body, embedding) values ($1, $2, 0, 'Secret receipt rules of account B.', $3)`, [B, d.id, vec(1024, 3)]);
  const words = await q(`select account_id from kn_chunks where account_id = $1 and tsv @@ websearch_to_tsquery('simple', 'receipt')`, [A]);
  assert.ok(words.every((r) => r.account_id === A) && words.length === 1);
  const near = await q(`select account_id from kn_chunks where account_id = $1 and embedding is not null order by embedding <=> $2::halfvec limit 5`, [A, vec(1024, 3)]);
  assert.ok(near.every((r) => r.account_id === A));
});

await kn.end();
try { run('pg_ctl', ['-D', join(dir, 'data'), '-m', 'immediate', 'stop']); } catch { /* already stopping */ }
rmSync(dir, { recursive: true, force: true });
console.log(`${pass} knowledge database checks passed`);
