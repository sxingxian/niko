// Runs the mail (IMAP/SMTP), calendar-link, voice-matching, voice check (respond only to my voice), brain-order, weather, voice-key and payment tests in Node against local test servers
// (payments: a temporary local PostgreSQL, skipped where PostgreSQL isn't installed).
// cloudflare:sockets is stood in for by a plain-TCP shim; the code under test only allows that for 127.0.0.1 in tests.
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const here = fileURLToPath(new URL('.', import.meta.url));
let failed = false;
for (const name of ['mail', 'ical', 'voice', 'brains', 'weather', 'voices', 'lists', 'hears', 'images', 'maps', 'speechtext', 'provided', 'listen', 'rest', 'lock', 'access', 'glance', 'billing', 'designs', 'backgrounds', 'payments', 'knowledgedb', 'knowledge', 'knowledgesplit', 'knowledgeanswer', 'knowledgedevice', 'learned', 'situations', 'voicematch', 'datasources', 'ownsearch']) {
  const out = `${here}.out-${name}.mjs`;
  await build({
    entryPoints: [`${here}${name}.test.mjs`], bundle: true, platform: 'node', format: 'esm', outfile: out, logLevel: 'error',
    alias: { 'cloudflare:sockets': `${here}cf-sockets-shim.mjs`, '@niko/shared': `${here}../packages/shared/src/index.ts`, ...(['brains', 'voices', 'hears', 'images', 'maps', 'access', 'glance', 'rest', 'ownsearch'].includes(name) ? { '@niko/db': `${here}brains-stubs.mjs` } : {}),
      // The payments test runs the real Worker routes against a local PostgreSQL.
      ...(name === 'payments' ? { '@niko/db': `${here}db-node.mjs` } : {}) },
    // The brain tests read saved keys from a stand-in instead of the database.
    plugins: ['brains', 'voices', 'hears', 'images', 'maps', 'access', 'glance', 'ownsearch'].includes(name) ? [{ name: 'stub-providers', setup(b) { b.onResolve({ filter: /^\.\/providers$/ }, () => ({ path: `${here}brains-stubs.mjs` })); } }] : [],
    external: ['hoodiecrow-imap', 'smtp-server', 'pg', 'pg-native'],
    banner: { js: "import{createRequire}from'module';const require=createRequire(import.meta.url);" },
  });
  try { execFileSync(process.execPath, [out], { stdio: 'inherit', timeout: name === 'payments' || name.startsWith('knowledge') || name === 'learned' || name === 'situations' ? 180_000 : 60_000 }); } catch { failed = true; }
}
process.exit(failed ? 1 : 0);
