// New items on Home: only new things, shown once; the first check only learns; reminders once; the person's choice
// never beats the admin's limit; and voice commands for the card on show.
import assert from 'node:assert/strict';
import { cleanGlanceLimits, cleanGlancePrefs, glanceEvery, glanceLimits, GLANCE_PREF_DEFAULTS } from '../packages/shared/src/index.ts';
import { diffGlance } from '../apps/api/src/glance.ts';
import { glanceCommand } from '../apps/app/src/pages/Glance.tsx';

let pass = 0;
const ok = async (name, fn) => { try { await fn(); pass++; console.log('PASS', name); } catch (e) { console.log('FAIL', name, e?.stack ?? e?.message); process.exitCode = 1; } };
const T = Date.UTC(2026, 10, 16, 2, 0); // 10:00 in Singapore
const empty = { mail: [], events: [], notes: [], chats: [], problems: [] };
const mail = (id, from = 'Maya Chen') => ({ id, from, subject: 'Venue', source: 'Gmail', provider: 'gmail' });

await ok('the first check only learns what is there; after that, only new items show, once', () => {
  let st = { checked: {}, seen: {}, upcoming: [] };
  let r = diffGlance(st, { ...empty, mail: [mail('a'), mail('b')] }, ['mail'], T, 0, -480);
  assert.equal(r.items.length, 0); st = r.state;
  r = diffGlance(st, { ...empty, mail: [mail('a'), mail('b'), mail('c', 'Ravi')] }, ['mail'], T + 120_000, 0, -480);
  assert.deepEqual(r.items.map((i) => i.title), ['Ravi']); assert.equal(r.items[0].open, 'Ravi Venue'); st = r.state;
  r = diffGlance(st, { ...empty, mail: [mail('c', 'Ravi')] }, ['mail'], T + 240_000, 0, -480);
  assert.equal(r.items.length, 0);
});
await ok('a kind not checked for two days learns again instead of flooding Home', () => {
  const st = { checked: { mail: T - 3 * 86400_000 }, seen: {}, upcoming: [] };
  assert.equal(diffGlance(st, { ...empty, mail: [mail('x'), mail('y')] }, ['mail'], T, 0, -480).items.length, 0);
});
await ok('messages: a new message in the same chat shows again; notes you changed yourself do not', () => {
  const chat = (lastAt) => ({ provider: 'telegram-bot', chatId: '7', title: 'Sam', last: 'Lunch?', source: 'Telegram', lastAt });
  const note = (edited, byMe) => ({ id: 'n1', provider: 'notion', title: 'Q4 plan', source: 'Notion', edited, ...(byMe ? { byMe } : {}) });
  let st = diffGlance({ checked: {}, seen: {}, upcoming: [] }, { ...empty, chats: [chat(1)], notes: [note(1)] }, ['chats', 'notes'], T, 0, -480).state;
  let r = diffGlance(st, { ...empty, chats: [chat(2)], notes: [note(2, true)] }, ['chats', 'notes'], T + 60_000, 0, -480);
  assert.deepEqual(r.items.map((i) => i.kind), ['chat']); st = r.state;
  r = diffGlance(st, { ...empty, chats: [chat(2)], notes: [note(3)] }, ['chats', 'notes'], T + 120_000, 0, -480);
  assert.deepEqual(r.items.map((i) => i.kind), ['note']);
});
await ok('calendar: a new future event shows; a reminder comes once, within the lead time, without reading the calendar again', () => {
  const ev = (id, start) => ({ id, provider: 'google-calendar', title: 'Design review', time: '10:30', source: 'Google', start });
  let st = diffGlance({ checked: {}, seen: {}, upcoming: [] }, { ...empty, events: [ev('e1', T + 3600_000)] }, ['events'], T, 10, -480).state;
  let r = diffGlance(st, { ...empty, events: [ev('e1', T + 3600_000), ev('e2', T + 7200_000)] }, ['events'], T + 60_000, 10, -480);
  assert.deepEqual(r.items.map((i) => i.kind), ['invite']); st = r.state;
  r = diffGlance(st, empty, [], T + 3600_000 - 9 * 60_000, 10, -480);
  assert.equal(r.items.length, 1); assert.equal(r.items[0].kind, 'reminder'); assert.match(r.items[0].line, /Starts in 9 minutes, at 11:00/); st = r.state;
  assert.equal(diffGlance(st, empty, [], T + 3600_000 - 5 * 60_000, 10, -480).items.length, 0);
});
await ok('what was shown is forgotten after two weeks', () => {
  const st = { checked: { mail: T - 60_000 }, seen: { 'mail:gmail:old': T - 15 * 86400_000, 'mail:gmail:new': T - 86400_000 }, upcoming: [] };
  const r = diffGlance(st, empty, ['mail'], T, 0, -480);
  assert.deepEqual(Object.keys(r.state.seen), ['mail:gmail:new']);
});
await ok('the person’s choice never beats the admin’s limit; off means off', () => {
  const limits = glanceLimits({ mail: 5 }, { notes: 0 });
  const prefs = { ...GLANCE_PREF_DEFAULTS, on: true, mail: 1, notes: 2, events: 15 };
  assert.equal(glanceEvery(prefs, limits, 'mail'), 5);
  assert.equal(glanceEvery(prefs, limits, 'notes'), 0);
  assert.equal(glanceEvery(prefs, limits, 'events'), 15);
  assert.equal(glanceEvery({ ...prefs, on: false }, limits, 'mail'), 0);
  assert.equal(glanceEvery(prefs, { ...limits, allowed: false }, 'events'), 0);
});
await ok('settings are cleaned: unknown values are dropped, defaults are off', () => {
  assert.deepEqual(cleanGlanceLimits({ allowed: 'yes', mail: 3, chats: 0, events: 10, extra: 1 }), { chats: 0, events: 10 });
  const p = cleanGlancePrefs({ on: true, mail: 7, remind: 15 });
  assert.equal(p.on, true); assert.equal(p.mail, GLANCE_PREF_DEFAULTS.mail); assert.equal(p.remind, 15);
  assert.equal(cleanGlancePrefs(undefined).on, false); assert.equal(cleanGlancePrefs(undefined).aloud, false);
});
await ok('voice for the card on show', () => {
  for (const s of ['open it', 'Open that, please.', 'show me']) assert.equal(glanceCommand(s), 'open', s);
  for (const s of ['reply', 'reply to it', 'answer']) assert.equal(glanceCommand(s), 'reply', s);
  for (const s of ['dismiss', 'got it', 'not now', 'hide it']) assert.equal(glanceCommand(s), 'dismiss', s);
  for (const s of ['open my calendar', 'what is new', 'send it']) assert.equal(glanceCommand(s), null, s);
});
console.log(`${pass} new-items checks passed`);
