// Runs the mail (IMAP/SMTP), calendar-link, voice-matching, brain-order, weather and voice-key tests in Node against local test servers.
// cloudflare:sockets is stood in for by a plain-TCP shim; the code under test only allows that for 127.0.0.1 in tests.
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const here = fileURLToPath(new URL('.', import.meta.url));
let failed = false;
for (const name of ['mail', 'ical', 'voice', 'brains', 'weather', 'voices', 'lists', 'hears']) {
  const out = `${here}.out-${name}.mjs`;
  await build({
    entryPoints: [`${here}${name}.test.mjs`], bundle: true, platform: 'node', format: 'esm', outfile: out, logLevel: 'error',
    alias: { 'cloudflare:sockets': `${here}cf-sockets-shim.mjs`, '@niko/shared': `${here}../packages/shared/src/index.ts`, ...(['brains', 'voices', 'hears'].includes(name) ? { '@niko/db': `${here}brains-stubs.mjs` } : {}) },
    // The brain tests read saved keys from a stand-in instead of the database.
    plugins: ['brains', 'voices', 'hears'].includes(name) ? [{ name: 'stub-providers', setup(b) { b.onResolve({ filter: /^\.\/providers$/ }, () => ({ path: `${here}brains-stubs.mjs` })); } }] : [],
    external: ['hoodiecrow-imap', 'smtp-server'],
    banner: { js: "import{createRequire}from'module';const require=createRequire(import.meta.url);" },
  });
  try { execFileSync(process.execPath, [out], { stdio: 'inherit', timeout: 60_000 }); } catch { failed = true; }
}
process.exit(failed ? 1 : 0);
