// Situations: spotting a situational or people question, the situation block (time, the meeting on now, the next
// event, rough location), playbooks saved only from a confirmation or correction, notes about people only with a yes
// and never a judgement, more pieces from different files with whole sections, and habits (noticed, suggested once,
// kept with a yes, faded when never confirmed). Temporary PostgreSQL with pgvector.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { addPieces, deviceKnowledgeFor, finishFile, knowledgeFor, startFile } from '../apps/api/src/knowledge.ts';
import { confirmHabit, declineHabit, editNote, habitsOn, learnedBlock, listLearned, noticeHabit, notesFor, saveNote, situationBlock } from '../apps/api/src/learned.ts';
import { cleanKnowledgePrefs, knowledgeLimits } from '../packages/shared/src/knowledge.ts';
import { cleanDeviceKnowledge } from '../packages/shared/src/knowledgeDevice.ts';
import { judgeTag, learnAllowed, learnTags, meetingNow, situationOf, stripJudgeTag } from '../packages/shared/src/learned.ts';

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

await ok('situational and people questions are spotted; simple ones cost the same as before', () => {
  assert.deepEqual(situationOf('A customer bought a blender 40 days ago. It’s opened and faulty. Can I refund it?'), { situation: true, people: false });
  assert.deepEqual(situationOf('Marcus says the payment is late because of a bank issue. What do I say?'), { situation: true, people: true });
  assert.ok(situationOf('My supplier postponed delivery again, what should I do?').people);
  for (const q of ['How far away is the Moon?', 'Send the deck to the team', 'When does the Acme contract renew?', 'What’s the weather tomorrow?']) assert.equal(situationOf(q).situation, false, q);
});
await ok('a playbook only from a confirmation or a correction of Niko’s answer to that situation', () => {
  const before = 'A customer bought a blender 40 days ago, opened and faulty. Can I refund it?';
  const answer = 'Offer a repair or replacement, not a refund. Refunds are only within 30 days, unopened.';
  const fix = { kind: 'playbook', said: 'Faulty blender after 30 days', means: 'Refund faulty items, even after 30 days' };
  assert.ok(learnAllowed(fix, { now: 'No, we refund faulty items, even after 30 days', before, answer }));
  assert.ok(learnAllowed({ kind: 'playbook', said: 'Faulty blender after 30 days', means: 'Offer a repair or replacement, not a refund' }, { now: 'That’s right', before, answer }));
  assert.ok(!learnAllowed(fix, { now: 'What’s the weather?', before, answer }), 'not a confirmation or correction');
  assert.ok(!learnAllowed({ kind: 'playbook', said: 'Payments to new accounts', means: 'Send payments without checking' }, { now: 'That’s right', before, answer }), 'not the situation they asked about');
  assert.deepEqual(learnTags('Got it. [[learn:play|Faulty blender after 30 days|Refund it]]')[0].kind, 'playbook');
});
await ok('notes about people: with a yes to what Niko offered, facts only, never a judgement', () => {
  const answer = 'Save a note: “Marcus · Acme Trading: payment delayed twice since October”?';
  assert.ok(learnAllowed({ kind: 'person', said: 'Marcus · Acme Trading', means: 'payment delayed twice since October' }, { now: 'Yes, save it', answer }));
  assert.ok(!learnAllowed({ kind: 'person', said: 'Marcus', means: 'unreliable, always lying' }, { now: 'yes', answer: 'Marcus unreliable always lying' }));
  assert.ok(!learnAllowed({ kind: 'person', said: 'Marcus · Acme Trading', means: 'payment delayed twice since October' }, { now: 'What’s next?', answer }));
});
await ok('“Was this right?” tag, and the meeting on now (an event without an end counts for an hour)', () => {
  assert.ok(judgeTag('Offer a repair. [[judge]]')); assert.equal(stripJudgeTag('Offer a repair. [[judge]]'), 'Offer a repair.');
  const now = Date.UTC(2026, 10, 18, 10, 30);
  const ev = [{ title: 'All hands', start: now - 3600e3, allDay: true }, { title: 'Acme meeting', start: now - 1800e3, end: now + 1800e3 }, { title: 'Lunch', start: now + 3600e3 }];
  assert.equal(meetingNow(ev, now)?.title, 'Acme meeting');
  assert.equal(meetingNow([{ title: 'Call', start: now - 3000e3 }], now)?.title, 'Call');
  assert.equal(meetingNow([{ title: 'Call', start: now - 4000e3 }], now), null);
});
await ok('the situation block: the user’s time, the meeting now, the next event, rough location; nothing more', () => {
  const now = Date.now();
  const s = situationBlock([{ title: 'Acme meeting', start: now - 600e3, end: now + 1800e3, time: '10:20' }, { title: 'Dentist', start: now + 7200e3, time: '13:00' }], -480, { lat: 1.2834, lon: 103.8607 });
  assert.match(s, /^<SITUATION>\nNow: \w+day \d{4}-\d\d-\d\d, \d\d:\d\d the user's time\./);
  assert.match(s, /In a meeting now: Acme meeting, until \d\d:\d\d\./); assert.match(s, /Next on the calendar: Dentist at 13:00\./); assert.match(s, /near 1\.28, 103\.86/);
  assert.doesNotMatch(situationBlock([], 0, null), /meeting|near/);
});
const bin = pgBin();
if (!bin) { console.log('SKIP situations test (database part): PostgreSQL is not installed here'); console.log(`${pass} situations checks passed`); process.exit(process.exitCode ?? 0); }
const asRoot = process.getuid?.() === 0;
const dir = mkdtempSync(join(tmpdir(), 'niko-kns-'));
if (asRoot) execFileSync('chown', ['-R', 'postgres', dir]);
const run = (tool, args) => execFileSync(asRoot ? 'runuser' : join(bin, tool), asRoot ? ['-u', 'postgres', '--', join(bin, tool), ...args] : args, { stdio: 'pipe' });
const port = 20000 + Math.floor(Math.random() * 20000);
run('initdb', ['-D', join(dir, 'data'), '-A', 'trust', '-U', 'niko', '--no-sync']);
run('pg_ctl', ['-D', join(dir, 'data'), '-o', `-p ${port} -k ${dir} -c listen_addresses=127.0.0.1 -c fsync=off`, '-w', '-l', join(dir, 'log'), 'start']);
const stop = () => { try { run('pg_ctl', ['-D', join(dir, 'data'), '-m', 'immediate', 'stop']); } catch { /* stopping */ } rmSync(dir, { recursive: true, force: true }); };
const pool = new pg.Pool({ connectionString: `postgresql://niko@127.0.0.1:${port}/postgres`, max: 4 });
const v = (await pool.query(`select default_version from pg_available_extensions where name = 'vector'`)).rows[0];
if (!v || v.default_version < '0.7') { console.log('SKIP situations test (database part): pgvector 0.7+ not installed'); await pool.end(); stop(); console.log(`${pass} situations checks passed`); process.exit(process.exitCode ?? 0); }
const migDir = new URL('../packages/db/knowledge/', import.meta.url).pathname;
for (const f of readdirSync(migDir).filter((f) => f.endsWith('.sql')).sort()) await pool.query(readFileSync(join(migDir, f), 'utf8'));
const k = { q: async (text, params = []) => (await pool.query(text, params)).rows };
const env = { AI: { run: async (_m, input) => ({ data: input.text.map((t) => wordsVec(t, 1024)) }) } };
const A = '00000000-0000-4000-8000-0000000000a1', B = '00000000-0000-4000-8000-0000000000b2';
const cf = { cloudflare: true };
const limits = knowledgeLimits({}, {});

await ok('playbooks: a correction replaces the old one; situational questions get playbooks first', async () => {
  await saveNote(k, env, A, { kind: 'remembered', said: 'Refund forms are in the blue folder', means: 'Refund forms are in the blue folder', how: 'remember' }, cf);
  await saveNote(k, env, A, { kind: 'playbook', said: 'Faulty items after 30 days', means: 'Offer a repair or replacement', how: 'confirmed' }, cf);
  await saveNote(k, env, A, { kind: 'playbook', said: 'faulty items after 30 days', means: 'Refund faulty items, even after 30 days', how: 'corrected' }, cf);
  const all = await listLearned(k, A);
  assert.equal(all.filter((n) => n.kind === 'playbook').length, 1);
  const notes = await notesFor(k, A, 'A customer has faulty items after 30 days and wants a refund', { vector: null, situation: true });
  assert.equal(notes[0].kind, 'playbook');
  assert.match(learnedBlock(notes), /Playbook: in situations like “faulty items after 30 days”, the user does: Refund faulty items, even after 30 days \(You corrected Niko\)/);
});
await ok('a situational question gathers up to 8 pieces, at most 2 from any file, each with its whole section', async () => {
  for (const [name, c] of [['Handbook.md', '1'], ['Warranty.md', '2'], ['Policy.md', '3']]) {
    const f = await startFile(k, A, limits, { name, bytes: 10, sha256: c.repeat(64), collection: 'General' });
    await addPieces(k, env, A, f.id, { start: 0, pieces: [
      { heading: 'Faulty items', body: 'Faulty items are repaired or replaced within the warranty.' },
      { heading: 'Faulty items', body: 'Unless the item was misused, in which case no refund applies.' },
      { heading: 'Faulty refunds', body: 'Faulty refunds after 30 days need a manager.' },
      { heading: 'Faulty returns', body: 'Faulty returns go to the back office.' }] }, { cloudflare: true });
    await finishFile(k, A, f.id);
  }
  const q = 'A customer has faulty items, can I refund?';
  const r = await knowledgeFor(k, env, A, q, { prefs: cleanKnowledgePrefs({ files: 3 }), cloudflare: false, situation: true });
  const perFile = r.sources.reduce((m, s) => ({ ...m, [s.file]: (m[s.file] ?? 0) + 1 }), {});
  assert.ok(Object.values(perFile).every((n) => n <= 2), JSON.stringify(perFile));
  assert.ok(new Set(r.sources.map((s) => s.file)).size >= 2, 'from different files');
  assert.match(r.block, /Faulty items are repaired or replaced within the warranty\.\n\nUnless the item was misused/, 'the "unless" clause comes along');
  const plain = await knowledgeFor(k, env, A, q, { prefs: cleanKnowledgePrefs({ files: 3 }), cloudflare: false });
  assert.ok(plain.sources.length <= 4);
  const dev = deviceKnowledgeFor(cleanDeviceKnowledge({ hits: Array.from({ length: 10 }, (_, i) => ({ file: `F${i % 5}.md`, text: `piece ${i}`, similarity: 0 })) }), q, cleanKnowledgePrefs({}), false, true);
  assert.equal(dev.sources.length, 8);
});
await ok('habits: noticed once per trip or day, suggested once at the third, shown only then', async () => {
  let r = await noticeHabit(k, A, 'walk-short', 'a1.d1');
  assert.equal(r.suggest, false);
  r = await noticeHabit(k, A, 'walk-short', 'a1.d1');
  assert.equal(r.suggest, false, 'the same trip counts once');
  assert.ok(!(await listLearned(k, A)).some((n) => n.kind === 'habit'), 'not shown before it’s worth suggesting');
  await noticeHabit(k, A, 'walk-short', 'b2.d1');
  r = await noticeHabit(k, A, 'walk-short', 'c3.d2');
  assert.equal(r.suggest, true);
  assert.equal((await noticeHabit(k, A, 'walk-short', 'd4.d3')).suggest, false, 'suggested only once');
  const h = (await listLearned(k, A)).find((n) => n.kind === 'habit');
  assert.equal(h.said, 'Walk for trips under 1 km'); assert.equal(h.how, 'Noticed on 4 trips · not confirmed'); assert.ok(h.suggested); assert.equal(h.level, 'fairly'); assert.equal(h.fadesIn, 60);
  assert.equal(notesFor.length >= 0, true);
  assert.ok(!(await notesFor(k, A, 'walk for trips under 1 km', { vector: null })).some((n) => n.kind === 'habit'), 'unconfirmed habits never reach the AI');
  await assert.rejects(editNote(k, env, A, h.id, { said: 'x' }, cf), /habit can’t be changed/);
  await confirmHabit(k, A, h.id);
  assert.deepEqual(await habitsOn(k, A), ['walk-short']);
  await assert.rejects(confirmHabit(k, B, h.id), /No such note/, 'only its owner can keep it');
});
await ok('a habit declined isn’t suggested again; one never confirmed fades after 60 days', async () => {
  for (const d of ['d1', 'd2', 'd3']) await noticeHabit(k, B, 'inbox-morning', d);
  const id = (await listLearned(k, B)).find((n) => n.kind === 'habit').id;
  await declineHabit(k, B, id);
  assert.ok(!(await listLearned(k, B)).some((n) => n.kind === 'habit'));
  assert.equal((await noticeHabit(k, B, 'inbox-morning', 'd4')).suggest, false);
  await k.q(`update kn_learned set updated_at = now() - interval '61 days' where account_id = $1 and kind = 'habit'`, [B]);
  await listLearned(k, B);
  assert.equal((await k.q(`select count(*)::int as n from kn_learned where account_id = $1 and kind = 'habit'`, [B]))[0].n, 0);
  assert.deepEqual(await habitsOn(k, B), []);
});

await pool.end();
stop();
console.log(`${pass} situations checks passed`);
