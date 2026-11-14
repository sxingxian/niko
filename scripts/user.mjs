// Manage Niko accounts from your own computer (also the way back in if you are locked out).
//
//   export DATABASE_URL='…'            # Neon connection string; never commit it
//   npm run user -- list
//   npm run user -- reset-password  you@example.com
//   npm run user -- reset-2fa       you@example.com
//   npm run user -- unlock          you@example.com
//   npm run user -- disable | enable  you@example.com
//
// Passwords are typed at a hidden prompt, never as an argument, so they stay out of shell history.
// Uses the same hashing code as the Worker (apps/api/src/lib/password.ts).
import { build } from 'esbuild';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { neon } from '@neondatabase/serverless';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set. Export it in your shell (never commit it).');
  process.exit(1);
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dir = await mkdtemp(join(tmpdir(), 'niko-user-'));
const entry = join(dir, 'entry.ts');
const out = join(dir, 'auth.mjs');
await writeFile(entry, `export { prehashPassword } from ${JSON.stringify(join(root, 'apps/api/src/lib/password.ts'))};\nexport { passwordProblem } from ${JSON.stringify(join(root, 'packages/shared/src/index.ts'))};\n`);
await build({ entryPoints: [entry], bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'error', absWorkingDir: root });
const { prehashPassword, passwordProblem } = await import(out);
await rm(dir, { recursive: true, force: true });

const sql = neon(url);
const [cmd, emailArg] = process.argv.slice(2);
const email = (emailArg ?? '').toLowerCase();

function hiddenPrompt(question) {
  return new Promise((done) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => { if (s.includes(question)) rl.output.write(s); };
    rl.question(question, (answer) => { rl.close(); process.stdout.write('\n'); done(answer); });
  });
}

async function findUser() {
  if (!email) { console.error('Give the account email.'); process.exit(1); }
  const rows = await sql`select id, email, role, status, is_owner, totp_enabled from users where lower(email) = ${email}`;
  if (!rows[0]) { console.error(`No account with the email ${email}.`); process.exit(1); }
  return rows[0];
}
const log = (userId, action) => sql`insert into audit_log (user_id, action, detail) values (${userId}, ${action}, ${JSON.stringify({ via: 'command line' })}::jsonb)`;

switch (cmd) {
  case 'list': {
    const rows = await sql`select email, name, role, status, is_owner, totp_enabled, last_active_at from users order by created_at`;
    console.table(rows.map((r) => ({ email: r.email, name: r.name, role: r.is_owner ? 'owner' : r.role, status: r.status, '2-step': r.totp_enabled ? 'on' : 'off', 'last active': r.last_active_at ? new Date(r.last_active_at).toISOString().slice(0, 10) : 'never' })));
    break;
  }
  case 'reset-password': {
    const u = await findUser();
    if (!process.stdin.isTTY) { console.error('Run this in a terminal so the password can be typed at a hidden prompt.'); process.exit(1); }
    const a = await hiddenPrompt('New password: ');
    const problem = passwordProblem(a, u.email);
    if (problem) { console.error(problem); process.exit(1); }
    if ((await hiddenPrompt('Type it again: ')) !== a) { console.error('The two entries do not match. Nothing was changed.'); process.exit(1); }
    const pre = await prehashPassword(a);
    await sql`update users set password_hash = crypt(${pre}, gen_salt('bf', 12)) where id = ${u.id}`;
    await sql`delete from sessions where user_id = ${u.id}`;
    await log(u.id, 'password.reset');
    console.log(`Password changed for ${u.email}. They are signed out everywhere.`);
    break;
  }
  case 'reset-2fa': {
    const u = await findUser();
    await sql`update users set totp_enabled = false, totp_secret_enc = null, totp_last_step = 0 where id = ${u.id}`;
    await sql`delete from recovery_codes where user_id = ${u.id}`;
    await sql`delete from sessions where user_id = ${u.id} and kind = 'admin'`;
    await log(u.id, 'admin.2fa.reset');
    console.log(`Second factor removed for ${u.email}. They set it up again at the next admin sign-in.`);
    break;
  }
  case 'unlock': {
    if (!email) { console.error('Give the account email.'); process.exit(1); }
    const rows = await sql`delete from login_throttle where email = ${email} returning ip`;
    console.log(rows.length ? `Cleared ${rows.length} sign-in lock(s) for ${email}.` : `No sign-in locks for ${email}.`);
    break;
  }
  case 'disable':
  case 'enable': {
    const u = await findUser();
    if (cmd === 'disable' && u.is_owner) { console.error('The owner cannot be switched off.'); process.exit(1); }
    await sql`update users set status = ${cmd === 'enable' ? 'active' : 'off'} where id = ${u.id}`;
    if (cmd === 'disable') await sql`delete from sessions where user_id = ${u.id}`;
    await log(u.id, 'user.status');
    console.log(`${u.email} is now ${cmd === 'enable' ? 'active' : 'switched off'}.`);
    break;
  }
  default:
    console.log('Usage: npm run user -- list | reset-password <email> | reset-2fa <email> | unlock <email> | disable <email> | enable <email>');
}
