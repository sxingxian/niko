// Applies the SQL files to the Neon databases, in name order, once each:
//   packages/db/migrations  → DATABASE_URL            (the main database; always)
//   packages/db/knowledge   → KNOWLEDGE_DATABASE_URL  (Knowledge's own Neon project; only when that is set)
//
//   export DATABASE_URL='…'        # Neon connection strings; never commit them
//   npm run migrate                # apply anything not applied yet
//   npm run migrate -- --dry-run   # only list what would run
//
// Run by Cloudflare's Git build (npm run release) before the Worker is deployed.
// Safe to run again and again: applied files are recorded in each database's table `schema_migrations`.
// Everything pending is applied in ONE transaction per database, so a failure leaves that database as it was.
// A lock makes two runs at the same time wait for each other instead of colliding.
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const dryRun = process.argv.includes('--dry-run');
const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set. Add it as a secret where this runs (never commit it).');
  process.exit(1);
}
const knowledgeUrl = process.env.KNOWLEDGE_DATABASE_URL?.trim() || '';
if (knowledgeUrl && knowledgeUrl === url.trim()) {
  console.error('KNOWLEDGE_DATABASE_URL is the same as DATABASE_URL. Knowledge needs its own Neon project, so it can never fill the main database.');
  process.exit(1);
}
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'packages', 'db');

let failed = !(await migrate('Main database', url, join(root, 'migrations')));
if (!failed && knowledgeUrl) failed = !(await migrate('Knowledge database', knowledgeUrl, join(root, 'knowledge')));
else if (!failed) console.log('Knowledge database: KNOWLEDGE_DATABASE_URL is not set, so Knowledge stays off (nothing to update).');
process.exit(failed ? 1 : 0);

/** Applies one folder of migrations to one database. Returns false if it stopped (the database is left as it was). */
async function migrate(label, url, dir) {
const files = (await readdir(dir)).filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f)).sort();
if (files.length === 0) {
  console.error(`${label}: no migration files found in ${dir}.`);
  return false;
}
const migrations = await Promise.all(files.map(async (name) => {
  const text = await readFile(join(dir, name), 'utf8');
  return { name, text, checksum: createHash('sha256').update(text.replace(/\r\n/g, '\n')).digest('hex') };
}));

// Never print the connection string: errors from the driver can include the host, so keep messages short.
const client = new pg.Client({ connectionString: url, ssl: /localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: true }, application_name: 'niko-migrate' });
let ok = true;
try {
  await client.connect();
  await client.query('begin');
  await client.query(`select pg_advisory_xact_lock(hashtext('niko/schema_migrations'))`);
  await client.query(`create table if not exists schema_migrations (
    name text primary key, checksum text not null, applied_at timestamptz not null default now())`);
  const done = new Map((await client.query('select name, checksum from schema_migrations')).rows.map((r) => [r.name, r.checksum]));

  // A file that was already applied must never be edited: a change belongs in a new file.
  for (const m of migrations) {
    if (done.has(m.name) && done.get(m.name) !== m.checksum) {
      throw new Error(`${m.name} was changed after it was applied. Put the change in a new migration file instead.`);
    }
  }
  const unknown = [...done.keys()].filter((n) => !migrations.some((m) => m.name === n));
  if (unknown.length) console.warn(`Note: ${label.toLowerCase()} has migrations this code does not know: ${unknown.join(', ')} (is this an older commit?)`);

  const pending = migrations.filter((m) => !done.has(m.name));
  if (pending.length === 0) {
    console.log(`${label} is up to date (${migrations.length} migration${migrations.length === 1 ? '' : 's'} applied).`);
  } else if (dryRun) {
    console.log(`${label}: would apply ${pending.length}: ${pending.map((m) => m.name).join(', ')}`);
  } else {
    for (const m of pending) {
      console.log(`Applying ${m.name} …`);
      try {
        await client.query(m.text);
      } catch (e) {
        throw new Error(`${m.name} failed: ${e.message}${e.position ? ` (at character ${e.position})` : ''}. Nothing was changed.`);
      }
      await client.query('insert into schema_migrations (name, checksum) values ($1, $2)', [m.name, m.checksum]);
    }
    console.log(`${label}: applied ${pending.length} migration${pending.length === 1 ? '' : 's'}.`);
  }
  await client.query(dryRun ? 'rollback' : 'commit');
} catch (e) {
  ok = false;
  await client.query('rollback').catch(() => {});
  console.error(`${label}: migration stopped: ${e.message}`);
} finally {
  await client.end().catch(() => {});
}
return ok;
}
