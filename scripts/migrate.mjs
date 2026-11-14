// Applies the SQL files in packages/db/migrations to the Neon database, in name order, once each.
//
//   export DATABASE_URL='…'        # Neon connection string; never commit it
//   npm run migrate                # apply anything not applied yet
//   npm run migrate -- --dry-run   # only list what would run
//
// Run by the deploy workflow (and by Cloudflare's Git build) before the Worker is deployed.
// Safe to run again and again: applied files are recorded in the table `schema_migrations`.
// Everything pending is applied in ONE transaction, so a failure leaves the database as it was.
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

const dir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'packages', 'db', 'migrations');
const files = (await readdir(dir)).filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f)).sort();
if (files.length === 0) {
  console.error(`No migration files found in ${dir}.`);
  process.exit(1);
}
const migrations = await Promise.all(files.map(async (name) => {
  const text = await readFile(join(dir, name), 'utf8');
  return { name, text, checksum: createHash('sha256').update(text.replace(/\r\n/g, '\n')).digest('hex') };
}));

// Never print the connection string: errors from the driver can include the host, so keep messages short.
const client = new pg.Client({ connectionString: url, ssl: /localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: true }, application_name: 'niko-migrate' });
let failed = false;
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
  if (unknown.length) console.warn(`Note: the database has migrations this code does not know: ${unknown.join(', ')} (is this an older commit?)`);

  const pending = migrations.filter((m) => !done.has(m.name));
  if (pending.length === 0) {
    console.log(`Database is up to date (${migrations.length} migration${migrations.length === 1 ? '' : 's'} applied).`);
  } else if (dryRun) {
    console.log(`Would apply ${pending.length}: ${pending.map((m) => m.name).join(', ')}`);
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
    console.log(`Applied ${pending.length} migration${pending.length === 1 ? '' : 's'}.`);
  }
  await client.query(dryRun ? 'rollback' : 'commit');
} catch (e) {
  failed = true;
  await client.query('rollback').catch(() => {});
  console.error(`Migration stopped: ${e.message}`);
} finally {
  await client.end().catch(() => {});
}
process.exit(failed ? 1 : 0);
