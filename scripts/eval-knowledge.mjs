// npm run eval:knowledge — the Knowledge release check with a real AI (tests/eval/README.md). Bundles the check like
// tests/run.mjs does, with a local PostgreSQL in place of Neon, and runs it.
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url));
const out = `${root}tests/.out-eval-knowledge.mjs`;
await build({
  entryPoints: [`${root}tests/eval/knowledge.eval.mjs`], bundle: true, platform: 'node', format: 'esm', outfile: out, logLevel: 'error',
  alias: { 'cloudflare:sockets': `${root}tests/cf-sockets-shim.mjs`, '@niko/shared': `${root}packages/shared/src/index.ts`, '@niko/db': `${root}tests/db-node.mjs` },
  plugins: [{ name: 'knowledge-db', setup(b) { b.onResolve({ filter: /^@neondatabase\/serverless$/ }, (a) => (/apps[\\/]api[\\/]src[\\/]knowledge\.ts$/.test(a.importer) ? { path: `${root}tests/eval/neon-shim.mjs` } : undefined)); } }],
  external: ['hoodiecrow-imap', 'smtp-server', 'pg', 'pg-native'],
  banner: { js: "import{createRequire}from'module';const require=createRequire(import.meta.url);" },
});
try { execFileSync(process.execPath, [out], { stdio: 'inherit', env: process.env }); }
catch (e) { process.exit(typeof e.status === 'number' ? e.status : 1); }
