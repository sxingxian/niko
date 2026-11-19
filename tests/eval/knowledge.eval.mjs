// Knowledge release check with a real AI (the plan's "Tests before each release" that need one). Runs the real Worker
// in Node against a temporary PostgreSQL with pgvector, adds the files in knowledge-set.mjs the way the app does, and
// asks every question through /api/chat:
//   · known-answer questions: the right file leads, and the answer holds the facts;
//   · unrelated questions: no file leads;
//   · situations: the files' rules are applied (or Niko asks for the missing fact).
// The answer brain is your own OpenAI-format key (EVAL_AI_BASE_URL, EVAL_AI_KEY, EVAL_AI_MODEL) or, without one,
// Cloudflare Workers AI (CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN, EVAL_CF_MODEL). With Cloudflare details, files
// are found by meaning (bge-m3) as in production; without them, by words only. Writes eval-knowledge-report.md and
// exits 1 when a group is under its pass mark. Only the AI services above are reached; nothing else leaves this machine.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import worker from '../../apps/api/src/index.ts';
import { knKindOf, prepareText, KN_PIECES_PER_CALL, KN_SHEET_ROWS_PER_CALL } from '../../packages/shared/src/index.ts';
import { closePools } from '../db-node.mjs';
import { FILES, KNOWN, PASS_AT, SITUATIONS, UNRELATED } from './knowledge-set.mjs';

const E = process.env;
// EVAL_DRY=1: a stand-in brain that answers with what it was given, so only the search half (which file leads) is
// checked, with no key and no cost. Answers and situations aren't judged in that mode.
const dry = E.EVAL_DRY === '1';
const ai = dry ? { baseUrl: 'https://dry.eval/v1', key: 'dry', model: 'dry' } : E.EVAL_AI_KEY && E.EVAL_AI_BASE_URL && E.EVAL_AI_MODEL ? { baseUrl: E.EVAL_AI_BASE_URL.replace(/\/+$/, ''), key: E.EVAL_AI_KEY, model: E.EVAL_AI_MODEL } : null;
const cf = E.CLOUDFLARE_ACCOUNT_ID && E.CLOUDFLARE_API_TOKEN ? { account: E.CLOUDFLARE_ACCOUNT_ID, token: E.CLOUDFLARE_API_TOKEN } : null;
if (!ai && !cf) { console.error('Set EVAL_AI_BASE_URL, EVAL_AI_KEY and EVAL_AI_MODEL (your own OpenAI-format key), or CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN (Workers AI). See tests/eval/README.md.'); process.exit(2); }
if (!existsSync(join(process.cwd(), 'packages', 'db', 'migrations'))) { console.error('Run this from the repository folder: npm run eval:knowledge'); process.exit(2); }
const only = E.EVAL_ONLY ? new Set(E.EVAL_ONLY.split(',')) : null; // known,unrelated,situations
const limit = E.EVAL_LIMIT ? Number(E.EVAL_LIMIT) : Infinity;

// ---------------------------------------------------------------- a temporary PostgreSQL with pgvector
function pgBin() {
  if (E.PG_BIN && existsSync(join(E.PG_BIN, 'initdb'))) return E.PG_BIN;
  const root = '/usr/lib/postgresql';
  if (!existsSync(root)) return null;
  for (const v of readdirSync(root).sort((a, b) => Number(b) - Number(a))) if (existsSync(join(root, v, 'bin', 'initdb'))) return join(root, v, 'bin');
  return null;
}
const bin = pgBin();
if (!bin) { console.error('PostgreSQL (initdb) with pgvector is needed to run this check.'); process.exit(2); }
const asRoot = process.getuid?.() === 0;
const dir = mkdtempSync(join(tmpdir(), 'niko-eval-'));
if (asRoot) execFileSync('chown', ['-R', 'postgres', dir]);
const run = (tool, args) => execFileSync(asRoot ? 'runuser' : join(bin, tool), asRoot ? ['-u', 'postgres', '--', join(bin, tool), ...args] : args, { stdio: 'pipe' });
const port = 20000 + Math.floor(Math.random() * 20000);
run('initdb', ['-D', join(dir, 'data'), '-A', 'trust', '-U', 'niko', '--no-sync']);
run('pg_ctl', ['-D', join(dir, 'data'), '-o', `-p ${port} -k ${dir} -c listen_addresses=127.0.0.1 -c fsync=off`, '-w', '-l', join(dir, 'log'), 'start']);
const stop = () => { try { run('pg_ctl', ['-D', join(dir, 'data'), '-m', 'immediate', 'stop']); } catch { /* stopping */ } rmSync(dir, { recursive: true, force: true }); };
const url = `postgresql://niko@127.0.0.1:${port}/postgres`, knUrl = `postgresql://niko@127.0.0.1:${port}/kn`;
const main = new pg.Client({ connectionString: url }); await main.connect();
await main.query('create database kn');
for (const [u, folder] of [[url, 'migrations'], [knUrl, 'knowledge']]) {
  const c = new pg.Client({ connectionString: u }); await c.connect();
  const d = join(process.cwd(), 'packages', 'db', folder);
  for (const f of readdirSync(d).filter((f) => f.endsWith('.sql')).sort()) await c.query(readFileSync(join(d, f), 'utf8'));
  await c.end();
}

// ---------------------------------------------------------------- the network: only the AI services
const realFetch = globalThis.fetch;
const aiHost = ai ? new URL(ai.baseUrl).hostname : null;
globalThis.fetch = async (input, init = {}) => {
  const u = new URL(String(input instanceof Request ? input.url : input));
  if (dry && u.hostname === aiHost) {
    return Response.json({ choices: [{ message: { role: 'assistant', content: 'Here is what I found.' } }] });
  }
  if (u.hostname === aiHost || u.hostname === 'api.cloudflare.com') return realFetch(input, init);
  if (u.hostname === 'api.resend.com') return Response.json({ id: 'em' });
  throw new Error(`the release check doesn't reach ${u.hostname}`);
};
/** Workers AI through Cloudflare's API, standing in for the Worker's AI binding. */
const AI = {
  run: async (model, input) => {
    if (!cf) throw new Error('Workers AI is not set up for this check');
    const res = await realFetch(`https://api.cloudflare.com/client/v4/accounts/${cf.account}/ai/run/${model}`, { method: 'POST', headers: { authorization: `Bearer ${cf.token}`, 'content-type': 'application/json' }, body: JSON.stringify(input) });
    const j = await res.json();
    if (!res.ok || !j.success) throw new Error(`Workers AI answered ${res.status}`);
    return j.result;
  },
};
const env = {
  DATABASE_URL: url, KNOWLEDGE_DATABASE_URL: knUrl, ENCRYPTION_KEY: randomBytes(32).toString('base64'), BOOTSTRAP_TOKEN: 'boot-' + randomBytes(12).toString('hex'),
  RESEND_API_KEY: 're_eval', EMAIL_FROM: 'Niko <eval@example.com>', AI_MODEL: E.EVAL_CF_MODEL || '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
  ASSETS: { fetch: async () => new Response('page') }, AI,
};
const ctx = { waitUntil: () => {}, passThroughOnException() {} };
const ORIGIN = 'https://niko.eval';
const jar = new Map();
async function call(method, path, body) {
  const headers = { origin: ORIGIN };
  if (jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await worker.fetch(new Request(ORIGIN + '/api' + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env, ctx);
  for (const sc of res.headers.getSetCookie()) { const [pair] = sc.split(';'); const i = pair.indexOf('='); jar.set(pair.slice(0, i), pair.slice(i + 1)); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${data.error ?? ''}`);
  return data;
}

// ---------------------------------------------------------------- set up: an owner, the brain, Knowledge, the files
await call('POST', '/auth/setup', { token: env.BOOTSTRAP_TOKEN, email: 'eval@example.com', name: 'Eval Owner', password: 'correct horse battery staple ' + randomBytes(4).toString('hex') });
// Knowledge is off for everyone until the admin turns it on; this check owns its database, so it turns it on there.
await main.query(`update users set ai_access = '{"kn:files": true}'::jsonb`);
if (ai) {
  const k = await call('POST', '/engine/keys', { baseUrl: ai.baseUrl, model: ai.model, apiKey: ai.key });
  await call('PATCH', '/me', { engine: { brains: [`key:${k.key.id}`] } });
}
await call('PUT', '/knowledge/prefs', { read: 'device', search: cf ? 'cloudflare' : 'device', telegram: false, learn: false, situations: true });
let n = 0;
for (const f of FILES) {
  const p = prepareText(knKindOf(f.name), f.name, f.text);
  const sha = (++n).toString(16).padStart(64, '0');
  const { id } = await call('POST', '/knowledge/files', { name: f.name, bytes: f.text.length, sha256: sha, collection: 'General', flagged: p.flagged });
  for (let i = 0; i < p.pieces.length; i += KN_PIECES_PER_CALL) await call('POST', `/knowledge/files/${id}/pieces`, { start: i, pieces: p.pieces.slice(i, i + KN_PIECES_PER_CALL) });
  for (const s of p.sheets) {
    const sh = await call('POST', `/knowledge/files/${id}/sheets`, { name: s.name, columns: s.columns, rows: s.rows.slice(0, KN_SHEET_ROWS_PER_CALL), header: s.header });
    for (let i = KN_SHEET_ROWS_PER_CALL; i < s.rows.length; i += KN_SHEET_ROWS_PER_CALL) await call('POST', `/knowledge/files/${id}/sheets/${sh.id}/rows`, { start: i, rows: s.rows.slice(i, i + KN_SHEET_ROWS_PER_CALL) });
  }
  await call('POST', `/knowledge/files/${id}/done`);
}

// ---------------------------------------------------------------- asking
const norm = (s) => s.toLowerCase().replace(/[’']/g, "'").replace(/\s+/g, ' ');
const has = (text, forms) => forms.some((f) => norm(text).includes(norm(f)));
async function ask(q) {
  await call('DELETE', '/chat/history').catch(() => undefined); // each question on its own
  const t0 = Date.now();
  const r = await call('POST', '/chat', { message: q, tz: 0 });
  return { reply: String(r.reply ?? ''), lead: !!r.knowledge?.lead, files: (r.knowledge?.sources ?? []).map((s) => s.file), choices: r.choices ?? [], ms: Date.now() - t0 };
}
const rows = { known: [], unrelated: [], situations: [] };
const want = (g) => !only || only.has(g);
if (want('known')) for (const it of KNOWN.slice(0, limit)) {
  const r = await ask(it.q).catch((e) => ({ error: e.message, reply: '' }));
  const missing = r.error || dry ? [] : it.expect.filter((forms) => !has(r.reply, forms)).map((f) => f[0]);
  // By meaning, the file must lead; by words only nothing ever leads (there's no closeness score), so it must come first.
  const first = r.files?.[0], right = first === it.file && (!cf || r.lead);
  const ok = !r.error && right && missing.length === 0;
  rows.known.push({ q: it.q, ok, why: r.error ?? (!right ? (first === it.file ? `${it.file} came first but didn't lead` : `${first ?? 'no file'} came first, not ${it.file}`) : missing.length ? `missing ${missing.join(', ')}` : ''), reply: r.reply, ms: r.ms });
  process.stdout.write(ok ? '.' : 'x');
}
if (want('unrelated')) for (const q of UNRELATED.slice(0, limit)) {
  const r = await ask(q).catch((e) => ({ error: e.message, reply: '' }));
  // By meaning, no file may lead; by words only, no file may be offered at all.
  const wrong = cf ? r.lead : (r.files?.length ?? 0) > 0;
  const ok = !r.error && !wrong;
  rows.unrelated.push({ q, ok, why: r.error ?? (wrong ? `${cf ? 'led' : 'offered'}: ${r.files[0]}` : ''), reply: r.reply, ms: r.ms });
  process.stdout.write(ok ? '.' : 'x');
}
if (want('situations') && !dry) for (const it of SITUATIONS.slice(0, limit)) {
  const r = await ask(it.q).catch((e) => ({ error: e.message, reply: '' }));
  let ok = !r.error, why = r.error ?? '';
  if (ok && it.ask) { ok = r.choices.length > 0 || /\?\s*$/.test(r.reply.trim()) || /\?/.test(r.reply); if (!ok) why = 'decided without asking for the missing fact'; }
  if (ok && it.expect) { const missing = it.expect.filter((forms) => !has(r.reply, forms)).map((f) => f[0]); if (missing.length) { ok = false; why = `missing ${missing.join(', ')}`; } }
  if (ok && it.not) { const bad = it.not.filter((f) => has(r.reply, [f])); if (bad.length) { ok = false; why = `said ${bad.join(', ')}`; } }
  rows.situations.push({ q: it.q, ok, why, reply: r.reply, ms: r.ms });
  process.stdout.write(ok ? '.' : 'x');
}
process.stdout.write('\n');

// ---------------------------------------------------------------- the report
const share = (l) => (l.length ? l.filter((r) => r.ok).length / l.length : 1);
const pct = (x) => `${Math.round(x * 100)}%`;
const groups = [['known', 'Known-answer questions (the right file leads, facts in the answer)'], ['unrelated', 'Unrelated questions (no file leads)'], ['situations', 'Situations (rules applied, or the missing fact asked)']];
const failed = groups.filter(([g]) => rows[g].length && share(rows[g]) < PASS_AT[g]);
const lines = [
  `# Knowledge release check`, '',
  `${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC · answers: ${dry ? 'stand-in (search only; answers not judged)' : ai ? `${ai.model} (your key)` : `${env.AI_MODEL} (Workers AI)`} · search: ${cf ? 'by meaning (Cloudflare bge-m3) and words' : 'words only (no Cloudflare details given)'}`, '',
  '| Group | Passed | Needed |', '|---|---|---|',
  ...groups.filter(([g]) => rows[g].length).map(([g, label]) => `| ${label} | ${rows[g].filter((r) => r.ok).length} of ${rows[g].length} (${pct(share(rows[g]))}) | ${pct(PASS_AT[g])} |`), '',
  failed.length ? `**Not ready:** ${failed.map(([, l]) => l.split(' (')[0]).join(', ')} under the pass mark.` : '**Ready:** every group passed.', '',
];
for (const [g, label] of groups) {
  const bad = rows[g].filter((r) => !r.ok);
  if (!bad.length) continue;
  lines.push(`## ${label} · what failed`, '');
  for (const r of bad) lines.push(`- **${r.q}** — ${r.why}`, `  > ${r.reply.replace(/\n+/g, ' ').slice(0, 300)}`);
  lines.push('');
}
const ms = Object.values(rows).flat().map((r) => r.ms).filter(Boolean).sort((a, b) => a - b);
if (ms.length) lines.push(`Answer time: median ${(ms[Math.floor(ms.length / 2)] / 1000).toFixed(1)} s, slowest ${(ms.at(-1) / 1000).toFixed(1)} s.`);
writeFileSync('eval-knowledge-report.md', lines.join('\n') + '\n');
console.log(lines.slice(0, 12).join('\n'));
console.log('Full report: eval-knowledge-report.md');

await main.end();
await closePools();
stop();
process.exit(failed.length ? 1 : 0);
