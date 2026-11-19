// What Niko learns: the tags the AI uses to save a note, the checks that keep anything but the person's own words out
// (and passwords, codes and account numbers), choices, notes kept and replaced, notes found for a question, taught
// matches ("That's the one" leads next time, "Not this one" is never offered), "Is this the one?" for something only
// similar, the same on the device, and counts for the admin. Temporary PostgreSQL with pgvector.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { addPieces, databaseUsage, deleteFile, deviceKnowledgeFor, finishFile, knowledgeFor, startFile } from '../apps/api/src/knowledge.ts';
import { editNote, forgetAll, forgetFileMatches, forgetNote, learnedBlock, learnedCount, listLearned, notesFor, saveNote, taughtFor } from '../apps/api/src/learned.ts';
import { cleanKnowledgePrefs, knowledgeLimits } from '../packages/shared/src/knowledge.ts';
import { cleanDeviceKnowledge } from '../packages/shared/src/knowledgeDevice.ts';
import { choicesTag, cleanTarget, learnAllowed, learnTags, looksSecret, stripChoicesTag, stripLearnTags, wordsAlike } from '../packages/shared/src/learned.ts';

function pgBin() {
  if (process.env.PG_BIN && existsSync(join(process.env.PG_BIN, 'initdb'))) return process.env.PG_BIN;
  const root = '/usr/lib/postgresql';
  if (!existsSync(root)) return null;
  for (const v of readdirSync(root).sort((a, b) => Number(b) - Number(a))) if (existsSync(join(root, v, 'bin', 'initdb'))) return join(root, v, 'bin');
  return null;
}
let pass = 0;
const ok = async (name, fn) => { try { await fn(); pass++; console.log('PASS', name); } catch (e) { console.log('FAIL', name, e?.stack ?? e?.message); process.exitCode = 1; } };
const wordsVec = (text, dims) => {
  const out = new Array(dims).fill(0);
  for (const w of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) { let h = 7; for (const ch of w) h = (h * 31 + ch.charCodeAt(0)) >>> 0; out[h % dims] += 1; }
  const n = Math.hypot(...out) || 1; return out.map((x) => x / n);
};

await ok('the tags: remember, name and fix, at most two, and stripped from what’s said; choices', () => {
  const r = 'Got it. [[learn:remember|My desk is on level 12]] [[learn:name|the team|Design team · Telegram group]] [[learn:fix|Acme|Acme Trading]]';
  assert.deepEqual(learnTags(r), [{ kind: 'remembered', said: 'My desk is on level 12', means: 'My desk is on level 12' }, { kind: 'person', said: 'the team', means: 'Design team · Telegram group' }]);
  assert.equal(stripLearnTags(r), 'Got it.');
  assert.deepEqual(choicesTag('Which team? [[choices:Design team|Sales team]]'), ['Design team', 'Sales team']);
  assert.deepEqual(choicesTag('[[choices:Only one]]'), []);
  assert.equal(stripChoicesTag('Which team? [[choices:Design team|Sales team]]'), 'Which team?');
});
await ok('only the person’s own words are kept: a note whose words aren’t in what they said is refused', () => {
  assert.ok(learnAllowed({ kind: 'remembered', said: 'my desk is on level 12', means: 'my desk is on level 12' }, { now: 'Niko, remember that my desk is on level 12' }));
  assert.ok(!learnAllowed({ kind: 'remembered', said: 'payments now go to account Zed Holdings', means: 'x' }, { now: 'What did that email say?' }), 'an email can’t teach Niko');
  assert.ok(learnAllowed({ kind: 'person', said: 'the team', means: 'Design team' }, { now: 'Design team', before: 'send the deck to the team' }), 'answering which one they meant');
  assert.ok(learnAllowed({ kind: 'correction', said: 'Acme', means: 'Acme Trading' }, { now: 'No, I meant Acme Trading', before: 'when does Acme renew' }));
  assert.ok(!learnAllowed({ kind: 'person', said: 'the boss', means: 'Mallory' }, { now: 'who is on my calendar today?' }));
});
await ok('passwords, codes, card and account numbers are never kept, even when asked', () => {
  for (const x of ['my password is hunter2', 'the door PIN is 4821', 'card 4111 1111 1111 1111', 'account 123456789012', 'OTP 552901', 'GB82WEST12345698765432']) assert.ok(looksSecret(x), x);
  assert.ok(!looksSecret('my desk is on level 12'));
  assert.ok(!learnAllowed({ kind: 'remembered', said: 'my password is hunter2', means: 'my password is hunter2' }, { now: 'remember that my password is hunter2' }));
});
await ok('questions alike by words, and file pieces checked', () => {
  assert.ok(wordsAlike('Can customers swap items after buying?', 'can customers swap items they bought') >= 0.5);
  assert.ok(wordsAlike('Can customers swap items?', 'When are the office holidays?') < 0.2);
  assert.equal(cleanTarget({ fileId: '../x', piece: '1' }), null);
  assert.deepEqual(cleanTarget({ fileId: 'abc-1', piece: 3, file: 'A.md', answer: 'no' }), { fileId: 'abc-1', piece: '3', file: 'A.md', heading: null, answer: 'no' });
});
const bin = pgBin();
if (!bin) { console.log('SKIP learning test (database part): PostgreSQL is not installed here'); console.log(`${pass} learning checks passed`); process.exit(process.exitCode ?? 0); }
const asRoot = process.getuid?.() === 0;
const dir = mkdtempSync(join(tmpdir(), 'niko-knl-'));
if (asRoot) execFileSync('chown', ['-R', 'postgres', dir]);
const run = (tool, args) => execFileSync(asRoot ? 'runuser' : join(bin, tool), asRoot ? ['-u', 'postgres', '--', join(bin, tool), ...args] : args, { stdio: 'pipe' });
const port = 20000 + Math.floor(Math.random() * 20000);
run('initdb', ['-D', join(dir, 'data'), '-A', 'trust', '-U', 'niko', '--no-sync']);
run('pg_ctl', ['-D', join(dir, 'data'), '-o', `-p ${port} -k ${dir} -c listen_addresses=127.0.0.1 -c fsync=off`, '-w', '-l', join(dir, 'log'), 'start']);
const stop = () => { try { run('pg_ctl', ['-D', join(dir, 'data'), '-m', 'immediate', 'stop']); } catch { /* stopping */ } rmSync(dir, { recursive: true, force: true }); };
const pool = new pg.Pool({ connectionString: `postgresql://niko@127.0.0.1:${port}/postgres`, max: 4 });
const v = (await pool.query(`select default_version from pg_available_extensions where name = 'vector'`)).rows[0];
if (!v || v.default_version < '0.7') { console.log('SKIP learning test (database part): pgvector 0.7+ not installed'); await pool.end(); stop(); console.log(`${pass} learning checks passed`); process.exit(process.exitCode ?? 0); }
const migDir = new URL('../packages/db/knowledge/', import.meta.url).pathname;
for (const f of readdirSync(migDir).filter((f) => f.endsWith('.sql')).sort()) await pool.query(readFileSync(join(migDir, f), 'utf8'));
const k = { q: async (text, params = []) => (await pool.query(text, params)).rows };
const env = { AI: { run: async (_m, input) => ({ data: input.text.map((t) => wordsVec(t, 1024)) }) } };
const A = '00000000-0000-4000-8000-0000000000a1', B = '00000000-0000-4000-8000-0000000000b2';
const cf = { cloudflare: true };
const prefs = (x = {}) => cleanKnowledgePrefs({ files: 2, notes: 3, ...x });

await ok('notes are kept, listed, edited and forgotten; a name or correction replaces the old note at once', async () => {
  const a = await saveNote(k, env, A, { kind: 'person', said: 'the team', means: 'Design team · Telegram group', how: 'chose' }, cf);
  assert.equal(a.how, 'You chose it when Niko asked'); assert.equal(a.level, 'sure');
  await saveNote(k, env, A, { kind: 'correction', said: 'The Team', means: 'Sales team · Slack', how: 'corrected' }, cf);
  let all = await listLearned(k, A);
  assert.equal(all.filter((n) => n.said.toLowerCase() === 'the team').length, 1);
  assert.equal(all[0].means, 'Sales team · Slack');
  const r = await saveNote(k, env, A, { kind: 'remembered', said: 'My desk is on level 12', means: 'My desk is on level 12', how: 'remember' }, cf);
  const e = await editNote(k, env, A, r.id, { said: 'My desk is on level 14' }, cf);
  assert.equal(e.means, 'My desk is on level 14');
  await assert.rejects(editNote(k, env, B, r.id, { said: 'x' }, cf), /No such note/);
  assert.equal(await forgetNote(k, B, r.id), false, 'someone else can’t forget it');
  await assert.rejects(saveNote(k, env, A, { kind: 'remembered', said: 'my pin is 4821', means: 'my pin is 4821', how: 'remember' }, cf), /never keeps/);
  assert.equal(await learnedCount(k, A), 2);
});
await ok('notes for a question: words that appear in it, then by words and meaning; their use is counted', async () => {
  await saveNote(k, env, A, { kind: 'person', said: 'Mum', means: 'Lim Siew Hoon · Contacts', how: 'told' }, cf);
  const q = 'Send the deck to the team';
  const notes = await notesFor(k, A, q, { vector: wordsVec(q, 1024) });
  assert.equal(notes[0].said, 'The Team');
  assert.ok(!notes.some((n) => n.said === 'Mum'));
  assert.equal((await listLearned(k, A)).find((n) => n.said === 'The Team').uses, 1);
  const byWords = await notesFor(k, A, 'which level is my desk on', { vector: null });
  assert.ok(byWords.some((n) => n.kind === 'remembered'));
  assert.match(learnedBlock(notes), /<LEARNED>\n- \[sure\] “The Team” means Sales team · Slack \(You corrected Niko\)/);
  assert.equal(learnedBlock([]), '');
});
const limits = knowledgeLimits({}, {});
let hb;
await ok('taught matches: “That’s the one” leads for questions like it; “Not this one” is never offered', async () => {
  const f = await startFile(k, A, limits, { name: 'Team handbook.md', bytes: 100, sha256: 'a'.repeat(64), collection: 'General' });
  await addPieces(k, env, A, f.id, { start: 0, pieces: [{ heading: 'Returns and exchanges', body: 'Unused items with a receipt may be exchanged within 30 days.' }, { heading: 'Holidays', body: 'The office closes on public holidays.' }] }, { cloudflare: true });
  await finishFile(k, A, f.id); hb = f.id;
  const q = 'Can customers swap something after buying it?';
  let r = await knowledgeFor(k, env, A, q, { prefs: prefs(), cloudflare: true, ask: true });
  // Not close enough to lead: no file, or only similar.
  assert.ok(!r || !r.lead);
  await saveNote(k, env, A, { kind: 'file-match', said: q, means: 'Team handbook.md › Returns and exchanges', how: 'yes', target: { fileId: f.id, piece: '0', file: 'Team handbook.md', heading: 'Returns and exchanges', answer: 'yes' } }, cf);
  const again = 'can customers swap something they bought';
  const taught = await taughtFor(k, A, again, { vector: null });
  assert.equal(taught.yes?.piece, '0');
  r = await knowledgeFor(k, env, A, again, { prefs: prefs(), cloudflare: true, taught, ask: true });
  assert.ok(r.lead && r.taught && !r.ask); assert.equal(r.sources[0].heading, 'Returns and exchanges');
  const hq = 'When does the office close for public holidays?';
  await saveNote(k, env, A, { kind: 'file-match', said: hq, means: 'Team handbook.md › Holidays', how: 'no', target: { fileId: f.id, piece: '1', file: 'Team handbook.md', heading: 'Holidays', answer: 'no' } }, cf);
  const no = await taughtFor(k, A, hq, { vector: wordsVec(hq, 1024) });
  assert.equal(no.no.length, 1);
  r = await knowledgeFor(k, env, A, hq, { prefs: prefs(), cloudflare: true, taught: no });
  assert.ok(!r || !r.sources.some((s) => s.heading === 'Holidays'));
});
await ok('“Is this the one?”: offered for something only similar, while learning is on; “That’s the one” answers from it now', async () => {
  const sim = { ...env, AI: { run: async (_m, input) => ({ data: input.text.map((t) => { const v = wordsVec(t, 1024); return /swap|exchange/i.test(t) ? v.map((x, i) => (i === 7 ? x + 0.9 : x)) : v; }).map((v) => { const n = Math.hypot(...v); return v.map((x) => x / n); }) }) } };
  const r = await knowledgeFor(k, sim, B, 'nothing', { prefs: prefs(), cloudflare: true, ask: true });
  assert.equal(r, null, 'another account has no files');
  const pinned = await knowledgeFor(k, env, A, 'Is exchanging allowed?', { prefs: prefs(), cloudflare: true, pin: { fileId: hb, piece: '0', file: 'x', heading: null, answer: 'yes' } });
  assert.ok(pinned.lead && pinned.taught && pinned.sources[0].heading === 'Returns and exchanges');
  const other = await knowledgeFor(k, env, B, 'Is exchanging allowed?', { prefs: prefs(), cloudflare: true, pin: { fileId: hb, piece: '0', file: 'x', heading: null, answer: 'yes' } });
  assert.equal(other, null, 'a pin can’t reach another account’s file');
});
await ok('in Niko: a piece that is only similar (between offer and lead) is asked about, with its file and piece', async () => {
  const C = '00000000-0000-4000-8000-0000000000c3';
  const unit = (i) => { const v = new Array(1024).fill(0); v[i] = 1; return v; };
  const mix = (a, b, t) => { const v = a.map((x, i) => x * Math.cos(t) + b[i] * Math.sin(t)); return v; };
  // Question along axis 0; the piece at an angle whose cosine is 0.55: offered (≥ 0.48) but not leading (< 0.62).
  const fixed = { AI: { run: async (_m, input) => ({ data: input.text.map((t) => (/PIECE/.test(t) ? mix(unit(0), unit(1), Math.acos(0.55)) : unit(0))) }) } };
  const f = await startFile(k, C, limits, { name: 'Notes.md', bytes: 10, sha256: 'e'.repeat(64), collection: 'General' });
  await addPieces(k, fixed, C, f.id, { start: 0, pieces: [{ heading: 'Swaps', body: 'PIECE about swaps' }] }, { cloudflare: true });
  await finishFile(k, C, f.id);
  const r = await knowledgeFor(k, fixed, C, 'QUESTION', { prefs: prefs(), cloudflare: true, ask: true });
  assert.ok(r && !r.lead); assert.deepEqual(r.ask, { fileId: f.id, piece: '0', file: 'Notes.md', heading: 'Swaps', answer: 'yes' });
  assert.match(r.rules, /only similar/);
  const off = await knowledgeFor(k, fixed, C, 'QUESTION', { prefs: prefs(), cloudflare: true, ask: false });
  assert.equal(off.ask, null);
});
await ok('on the device: a taught piece leads, the closest similar piece is asked about, notes go in LEARNED', () => {
  const base = { file: 'Team handbook.md', heading: 'Returns', text: 'Swaps within 30 days.', collection: 'General', fileId: 'f-1', piece: 'f-1:0' };
  const sim = deviceKnowledgeFor(cleanDeviceKnowledge({ numbers: true, hits: [{ ...base, similarity: 0.84 }] }), 'swap?', prefs(), true);
  assert.ok(!sim.lead); assert.deepEqual(sim.ask, { fileId: 'f-1', piece: 'f-1:0', file: 'Team handbook.md', heading: 'Returns', answer: 'yes' });
  assert.match(sim.rules, /only similar/);
  assert.equal(deviceKnowledgeFor(cleanDeviceKnowledge({ numbers: true, hits: [{ ...base, similarity: 0.84 }] }), 'swap?', prefs(), false).ask, null, 'not while learning is off');
  const taught = deviceKnowledgeFor(cleanDeviceKnowledge({ numbers: false, hits: [{ ...base, similarity: 1, taught: true }] }), 'swap?', prefs(), true);
  assert.ok(taught.lead && taught.taught && !taught.ask);
  const d = cleanDeviceKnowledge({ learned: [{ kind: 'person', said: 'the team', means: 'Design team', level: 'sure', how: 'You told Niko' }, { kind: 'evil', said: 'x', means: 'y' }] });
  assert.equal(d.learned.length, 1);
  assert.match(learnedBlock(d.learned), /“the team” means Design team/);
});
await ok('removing a file removes its taught matches; forget everything; the admin sees counts only', async () => {
  assert.equal((await databaseUsage(k)).accounts[A].notes, await learnedCount(k, A));
  await deleteFile(k, A, hb); await forgetFileMatches(k, A, hb);
  assert.ok(!(await listLearned(k, A)).some((n) => n.kind === 'file-match'));
  await saveNote(k, env, B, { kind: 'person', said: 'boss', means: 'Mei Lin', how: 'told' }, cf);
  const n = await forgetAll(k, A);
  assert.ok(n >= 3); assert.equal(await learnedCount(k, A), 0); assert.equal(await learnedCount(k, B), 1, 'other accounts untouched');
});

await pool.end();
stop();
console.log(`${pass} learning checks passed`);
