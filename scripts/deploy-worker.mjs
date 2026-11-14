// Deploys the Worker and gives it the same DATABASE_URL the build just used to update the database.
//
//   npm run release            # migrate, then this
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
let status = 1;
try {
  writeFileSync(file, JSON.stringify({ DATABASE_URL: url }), { mode: 0o600 });
  const r = spawnSync('npx', ['wrangler', 'deploy', '--secrets-file', file, ...process.argv.slice(2)], { cwd: apiDir, stdio: 'inherit' });
  status = r.status ?? 1;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
process.exit(status);
