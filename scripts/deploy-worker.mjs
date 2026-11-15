// Deploys the Worker and gives it the same DATABASE_URL the build just used to update the database.
//
//   npm run release            # tests, migrate, then this (deploy + live check, rollback if it fails)
//
// Why: Cloudflare build variables (and GitHub secrets) are only visible while building. The running
// Worker needs its own copy as a runtime secret, and keeping two copies by hand drifts: the build
// migrates one database while the Worker has none, or a different one. Here the build's value is the
// single source, uploaded with the new version via `wrangler deploy --secrets-file`.
//
// Other secrets (ENCRYPTION_KEY, BOOTSTRAP_TOKEN, RESEND_API_KEY) are not touched: --secrets-file is
// additive, so anything not in the file is kept as it is.
//
// The value goes into a JSON file (not .env, which would expand $ signs) in a private temporary folder
// that only this user can read, and the folder is removed when wrangler exits, whatever happens.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set where this deploy runs. Add it as a build secret (never commit it).');
  process.exit(1);
}
if (!/^postgres(ql)?:\/\//.test(url)) {
  console.error('DATABASE_URL does not look like a Postgres connection string (it should start with postgresql://). Paste only the URL, without "psql" or quotes.');
  process.exit(1);
}

const apiDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'apps', 'api');
const dir = mkdtempSync(join(tmpdir(), 'niko-secrets-'));
const file = join(dir, 'secrets.json');
const args = process.argv.slice(2);
let status = 1;
try {
  writeFileSync(file, JSON.stringify({ DATABASE_URL: url }), { mode: 0o600 });
  const r = spawnSync('npx', ['wrangler', 'deploy', '--secrets-file', file, ...args], { cwd: apiDir, stdio: 'inherit' });
  status = r.status ?? 1;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
if (status !== 0 || args.includes('--dry-run')) process.exit(status);

// ---- After the deploy: check the live site answers, and put the previous version back if it doesn't.
// Only a wrong answer from the site rolls back. If this build machine can't reach the site at all, that says
// nothing about the release, so it only warns.
const SITES = (process.env.SMOKE_URLS || 'https://niko.sxingxian.com,https://nikoapp.midnightpoetry.studio').split(',').map((s) => s.trim()).filter(Boolean);
const checks = SITES.flatMap((base) => [
  { url: `${base}/api/auth/config`, ok: (r, body) => r.status === 200 && /"registration"\s*:/.test(body), what: 'sign-in settings (database)' },
  { url: `${base}/`, ok: (r) => r.status === 200, what: 'page' },
]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let broken = null;
let unreachable = 0;
for (const c of checks) {
  let last = '';
  let passed = false;
  for (let attempt = 1; attempt <= 5 && !passed; attempt++) {
    try {
      const r = await fetch(c.url, { headers: { 'cache-control': 'no-cache', 'user-agent': 'niko-release-check' }, signal: AbortSignal.timeout(10_000) });
      const body = await r.text();
      passed = c.ok(r, body);
      last = `answered ${r.status}`;
    } catch (e) {
      last = `unreachable (${e?.cause?.code || e?.name || 'error'})`;
    }
    if (!passed && attempt < 5) await sleep(4000); // a new version can take a few seconds to reach every location
  }
  console.log(`${passed ? 'ok  ' : 'FAIL'} ${c.url} (${c.what}): ${passed ? 'answered as expected' : last}`);
  if (!passed && last.startsWith('unreachable')) unreachable++;
  else if (!passed) broken ??= `${c.url} ${last}`;
}
if (broken) {
  console.error(`Release check failed: ${broken}. Putting the previous version back.`);
  const rb = spawnSync('npx', ['wrangler', 'rollback', '--yes', '--message', `Release check failed: ${broken}`.slice(0, 100)], { cwd: apiDir, stdio: 'inherit' });
  console.error(rb.status === 0 ? 'Rolled back. The site is on the previous version; see the check above for what failed.' : 'Rollback failed: roll back by hand in Cloudflare → niko → Deployments.');
  process.exit(1);
}
if (unreachable) console.warn(`Release check: ${unreachable} check(s) could not reach the site from this build machine; not treated as a failure.`);
