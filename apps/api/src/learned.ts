// What Niko learned about each person, kept in the Knowledge database (kn_learned). Notes are short and come only from
// the person's own words and taps (see learnAllowed in @niko/shared); answering looks the relevant ones up for each
// question, the same way as files. Every query filters by the account. The admin sees counts only.
import {
  meetingNow, searchWords, habitSure, isHabit, KN_HABIT_AFTER, KN_HABIT_FADE_DAYS, KN_HABITS, KN_LEARNED_MAX, KN_MEANS_CHARS, KN_SAID_CHARS, KN_TAUGHT_MAX, KN_TAUGHT_NEAR, KN_TAUGHT_WORDS, cleanTarget, knHowName, knLevel, looksSecret, wordsAlike,
  type KnHabit, type KnHow, type KnLearnedItem, type KnLearnedKind, type KnTarget,
} from '@niko/shared';
import type { Env } from './env';
import { embed, KnError, vecText, type Kdb } from './knowledge';

type Row = { id: string; kind: KnLearnedKind; subject: string; body: string; source: string; sure: number; uses: number; confirmed: boolean; target: unknown; created_at: string | Date; updated_at: string | Date; last_used: string | Date | null };
type HabitState = { habit: KnHabit; keys: string[]; offered?: boolean; declined?: boolean };
const habitOf = (v: unknown): HabitState | null => {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  return isHabit(o.habit) ? { habit: o.habit, keys: Array.isArray(o.keys) ? o.keys.filter((x): x is string => typeof x === 'string').slice(-20) : [], offered: o.offered === true, declined: o.declined === true } : null;
};
const DAY = 86400_000;
const toItem = (r: Row): KnLearnedItem => {
  const h = r.kind === 'habit' ? habitOf(r.target) : null;
  const unit = h ? KN_HABITS[h.habit].unit : null;
  return {
    id: r.id, kind: r.kind, said: r.subject, means: r.body,
    how: h && !r.confirmed ? `Noticed on ${r.uses} ${r.uses === 1 ? unit![0] : unit![1]} · not confirmed` : knHowName(r.source),
    level: knLevel(Number(r.sure)), uses: r.uses, confirmed: r.confirmed,
    target: r.kind === 'file-match' ? cleanTarget(r.target) : null, createdAt: new Date(r.created_at).toISOString(), lastUsed: r.last_used ? new Date(r.last_used).toISOString() : null,
    ...(h ? { habit: h.habit, suggested: !r.confirmed, ...(r.confirmed ? {} : { fadesIn: Math.max(0, KN_HABIT_FADE_DAYS - Math.floor((Date.now() - new Date(r.updated_at).getTime()) / DAY)) }) } : {}),
  };
};
const COLS = 'id, kind, subject, body, source, sure, uses, confirmed, target, created_at, updated_at, last_used';
/** Habits nobody confirmed fade after KN_HABIT_FADE_DAYS without being seen again (checked when notes are read). */
async function fade(k: Kdb, account: string) {
  await k.q(`delete from kn_learned where account_id = $1 and kind = 'habit' and not confirmed and updated_at < now() - interval '${KN_HABIT_FADE_DAYS} days'`, [account]);
}
const clean = (v: unknown, n: number) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n) : '');
const isId = (id: string) => /^[0-9a-f-]{36}$/.test(id);

export async function learnedCount(k: Kdb, account: string): Promise<number> {
  const [r] = await k.q<{ n: number }>(`select count(*)::int as n from kn_learned where account_id = $1`, [account]);
  return r?.n ?? 0;
}
/** Everything learned, as What Niko learned shows it: habits only once they've been noticed enough to suggest, and
 *  never one the person said no to. */
export async function listLearned(k: Kdb, account: string): Promise<KnLearnedItem[]> {
  await fade(k, account);
  return (await k.q<Row>(`select ${COLS} from kn_learned where account_id = $1
     and not (kind = 'habit' and not confirmed and (uses < ${KN_HABIT_AFTER} or coalesce((target->>'declined')::boolean, false)))
     order by updated_at desc limit ${KN_LEARNED_MAX}`, [account])).map(toItem);
}

export interface NewNote { kind: 'person' | 'correction' | 'remembered' | 'file-match' | 'playbook'; said: string; means: string; how: KnHow; target?: KnTarget | null }
/** Saves one note. A name or correction replaces any note about the same words straight away; a taught match replaces
 *  an earlier answer for the same question and file piece. */
export async function saveNote(k: Kdb, env: Pick<Env, 'AI'>, account: string, n: NewNote, how: { cloudflare: boolean }): Promise<KnLearnedItem> {
  const said = clean(n.said, n.kind === 'file-match' || n.kind === 'playbook' ? 200 : n.kind === 'remembered' ? KN_MEANS_CHARS : KN_SAID_CHARS);
  const means = clean(n.means, KN_MEANS_CHARS);
  if (!said || !means) throw new KnError('There’s nothing to keep.');
  if (looksSecret(`${said} ${means}`)) throw new KnError('Niko never keeps passwords, codes, or card and account numbers.');
  const target = n.kind === 'file-match' ? cleanTarget(n.target) : null;
  if (n.kind === 'file-match' && !target) throw new KnError('That file piece isn’t known.');
  if (n.kind === 'playbook') await k.q(`delete from kn_learned where account_id = $1 and kind = 'playbook' and lower(subject) = lower($2)`, [account, said]);
  else if (n.kind === 'person' || n.kind === 'correction') await k.q(`delete from kn_learned where account_id = $1 and kind in ('person', 'correction') and lower(subject) = lower($2)`, [account, said]);
  else if (n.kind === 'remembered') await k.q(`delete from kn_learned where account_id = $1 and kind = 'remembered' and lower(body) = lower($2)`, [account, means]);
  else await k.q(`delete from kn_learned where account_id = $1 and kind = 'file-match' and lower(subject) = lower($2) and target->>'fileId' = $3 and target->>'piece' = $4`, [account, said, target!.fileId, target!.piece]);
  const [c] = await k.q<{ all: number; taught: number }>(`select count(*)::int as all, count(*) filter (where kind = 'file-match')::int as taught from kn_learned where account_id = $1`, [account]);
  if ((c?.all ?? 0) >= KN_LEARNED_MAX) throw new KnError(`Niko keeps up to ${KN_LEARNED_MAX.toLocaleString('en')} notes. Forget some in Settings · Knowledge · What Niko learned.`, 409);
  if (n.kind === 'file-match' && (c?.taught ?? 0) >= KN_TAUGHT_MAX) throw new KnError(`Niko keeps up to ${KN_TAUGHT_MAX} taught matches. Remove some in Settings · Knowledge.`, 409);
  let vec: string | null = null;
  if (how.cloudflare) vec = await embed(env, [n.kind === 'file-match' ? said : `${said} — ${means}`]).then((v) => vecText(v[0]!)).catch(() => null);
  const [r] = await k.q<Row>(
    `insert into kn_learned (account_id, kind, subject, body, source, sure, confirmed, target, embedding) values ($1, $2, $3, $4, $5, 1, true, $6::jsonb, $7::halfvec) returning ${COLS}`,
    [account, n.kind, said, means, n.how, target ? JSON.stringify(target) : null, vec]);
  return toItem(r!);
}

/** Changes what a note says. A taught match can't be edited, only removed. */
export async function editNote(k: Kdb, env: Pick<Env, 'AI'>, account: string, id: string, b: { said?: unknown; means?: unknown }, how: { cloudflare: boolean }): Promise<KnLearnedItem> {
  if (!isId(id)) throw new KnError('No such note.', 404);
  const [cur] = await k.q<Row>(`select ${COLS} from kn_learned where id = $1 and account_id = $2`, [id, account]);
  if (!cur) throw new KnError('No such note.', 404);
  if (cur.kind === 'file-match') throw new KnError('A taught match can’t be changed. Remove it instead.');
  if (cur.kind === 'habit') throw new KnError('A habit can’t be changed. Say yes to keep it, or forget it.');
  const said = b.said === undefined ? cur.subject : clean(b.said, cur.kind === 'remembered' ? KN_MEANS_CHARS : cur.kind === 'playbook' ? 200 : KN_SAID_CHARS);
  const means = cur.kind === 'remembered' ? said : b.means === undefined ? cur.body : clean(b.means, KN_MEANS_CHARS);
  if (!said || !means) throw new KnError('A note can’t be empty.');
  if (looksSecret(`${said} ${means}`)) throw new KnError('Niko never keeps passwords, codes, or card and account numbers.');
  let vec: string | null = null;
  if (how.cloudflare) vec = await embed(env, [`${said} — ${means}`]).then((v) => vecText(v[0]!)).catch(() => null);
  const [r] = await k.q<Row>(`update kn_learned set subject = $3, body = $4, embedding = $5::halfvec, sure = 1, confirmed = true, updated_at = now() where id = $1 and account_id = $2 returning ${COLS}`, [id, account, said, means, vec]);
  return toItem(r!);
}
export async function forgetNote(k: Kdb, account: string, id: string): Promise<boolean> {
  if (!isId(id)) return false;
  return (await k.q(`delete from kn_learned where id = $1 and account_id = $2 returning id`, [id, account])).length > 0;
}
export async function forgetAll(k: Kdb, account: string): Promise<number> {
  return (await k.q(`delete from kn_learned where account_id = $1 returning id`, [account])).length;
}
/** Taught matches that point at a file go with it. */
export async function forgetFileMatches(k: Kdb, account: string, fileId: string): Promise<void> {
  await k.q(`delete from kn_learned where account_id = $1 and kind = 'file-match' and target->>'fileId' = $2`, [account, fileId]);
}

// ---------------------------------------------------------------- habits
/** One sighting of a habit (a short trip switched to walking, the inbox opened first thing on a weekday morning),
 *  counted once per `key` (the trip or the day). Returns whether to suggest it now: the first time it reaches
 *  KN_HABIT_AFTER sightings, and never again after that. */
export async function noticeHabit(k: Kdb, account: string, habit: KnHabit, key: string): Promise<{ suggest: boolean; id: string | null }> {
  await fade(k, account);
  const h = KN_HABITS[habit];
  const [row] = await k.q<Row>(`select ${COLS} from kn_learned where account_id = $1 and kind = 'habit' and target->>'habit' = $2 limit 1`, [account, habit]);
  if (row?.confirmed) return { suggest: false, id: row.id };
  const st = habitOf(row?.target) ?? { habit, keys: [] };
  if (st.declined) return { suggest: false, id: row!.id };
  if (st.keys.includes(key)) return { suggest: false, id: row?.id ?? null };
  st.keys = [...st.keys, key].slice(-20);
  const seen = st.keys.length;
  const suggest = seen >= KN_HABIT_AFTER && !st.offered;
  if (suggest) st.offered = true;
  if (!row) {
    const [c] = await k.q<{ n: number }>(`select count(*)::int as n from kn_learned where account_id = $1`, [account]);
    if ((c?.n ?? 0) >= KN_LEARNED_MAX) return { suggest: false, id: null };
    const [r] = await k.q<{ id: string }>(`insert into kn_learned (account_id, kind, subject, body, source, sure, uses, confirmed, target) values ($1, 'habit', $2, $3, 'noticed', $4, $5, false, $6::jsonb) returning id`,
      [account, h.said, h.means, habitSure(seen), seen, JSON.stringify(st)]);
    return { suggest, id: r!.id };
  }
  await k.q(`update kn_learned set uses = $3, sure = $4, target = $5::jsonb, updated_at = now() where id = $1 and account_id = $2`, [row.id, account, seen, habitSure(seen), JSON.stringify(st)]);
  return { suggest, id: row.id };
}
/** "Yes, keep" on a suggested habit. */
export async function confirmHabit(k: Kdb, account: string, id: string): Promise<KnLearnedItem> {
  if (!isId(id)) throw new KnError('No such note.', 404);
  const [r] = await k.q<Row>(`update kn_learned set confirmed = true, sure = 1, source = 'suggested', updated_at = now() where id = $1 and account_id = $2 and kind = 'habit' returning ${COLS}`, [id, account]);
  if (!r) throw new KnError('No such note.', 404);
  return toItem(r);
}
/** "No" on a suggested habit: it isn't suggested again (it fades like any unconfirmed habit). */
export async function declineHabit(k: Kdb, account: string, id: string): Promise<void> {
  if (!isId(id)) return;
  await k.q(`update kn_learned set target = coalesce(target, '{}'::jsonb) || '{"declined": true}'::jsonb, updated_at = now() where id = $1 and account_id = $2 and kind = 'habit' and not confirmed`, [id, account]);
}
/** The habits this person said yes to, which the app applies (walking for short trips, the morning inbox summary). */
export async function habitsOn(k: Kdb, account: string): Promise<KnHabit[]> {
  const rows = await k.q<{ habit: string }>(`select target->>'habit' as habit from kn_learned where account_id = $1 and kind = 'habit' and confirmed`, [account]);
  return rows.map((r) => r.habit).filter(isHabit);
}

// ---------------------------------------------------------------- answering
/** The notes that may help with one question (up to 8): by the words in it, by meaning when there are Cloudflare
 *  numbers, and any note whose words appear in the question. Their use is counted. */
export async function notesFor(k: Kdb, account: string, text: string, how: { vector?: number[] | null; situation?: boolean }): Promise<KnLearnedItem[]> {
  const words = searchWords(text).slice(0, 30).map((w) => w.replace(/[^\p{L}\p{N}]/gu, '')).filter(Boolean);
  const any = words.join(' | ');
  const params: unknown[] = [account, text.slice(0, 500), any || 'zzzz'];
  let near = '';
  if (how.vector) { params.push(vecText(how.vector)); near = ` or id in (select id from kn_learned where account_id = $1 and kind <> 'file-match' and embedding is not null and 1 - (embedding <=> $4::halfvec) >= 0.55 order by embedding <=> $4::halfvec limit 8)`; }
  const rows = await k.q<Row & { hit: boolean }>(
    `select ${COLS}, (char_length(subject) >= 2 and position(lower(subject) in lower($2)) > 0) as hit from kn_learned
     where account_id = $1 and kind <> 'file-match' and not (kind = 'habit' and not confirmed) and (
       (char_length(subject) >= 2 and position(lower(subject) in lower($2)) > 0)
       or tsv @@ to_tsquery('simple', $3)${near})
     order by ${how.situation ? `(kind = 'playbook') desc, ` : ''}hit desc, ts_rank_cd(tsv, to_tsquery('simple', $3)) desc, updated_at desc limit 8`, params);
  if (rows.length) await k.q(`update kn_learned set uses = uses + 1, last_used = now() where account_id = $1 and id = any($2::uuid[])`, [account, rows.map((r) => r.id)]);
  return rows.map(toItem);
}
/** What the person taught for questions like this one: the piece to use, and pieces not to offer. */
export async function taughtFor(k: Kdb, account: string, text: string, how: { vector?: number[] | null }): Promise<{ yes: KnTarget | null; no: KnTarget[] }> {
  let rows: { subject: string; target: unknown; sim: number | null }[];
  if (how.vector) rows = await k.q(`select subject, target, 1 - (embedding <=> $2::halfvec) as sim from kn_learned where account_id = $1 and kind = 'file-match' and embedding is not null order by embedding <=> $2::halfvec limit 10`, [account, vecText(how.vector)]);
  else rows = await k.q(`select subject, target, null::float8 as sim from kn_learned where account_id = $1 and kind = 'file-match' order by updated_at desc limit ${KN_TAUGHT_MAX}`, [account]);
  const alike = rows.filter((r) => (r.sim != null ? Number(r.sim) >= KN_TAUGHT_NEAR.cloudflare : wordsAlike(r.subject, text) >= KN_TAUGHT_WORDS));
  const targets = alike.map((r) => cleanTarget(r.target)).filter((t): t is KnTarget => !!t);
  return { yes: targets.find((t) => t.answer === 'yes') ?? null, no: targets.filter((t) => t.answer === 'no') };
}
/** The notes as the AI sees them. */
export function learnedBlock(notes: { kind: string; said: string; means: string; level: string; how: string }[]): string {
  if (!notes.length) return '';
  const lv = (n: (typeof notes)[number]) => (n.level === 'sure' ? 'sure' : n.level === 'fairly' ? 'fairly sure' : 'not sure');
  const line = (n: (typeof notes)[number]) => n.kind === 'remembered' ? `- [${lv(n)}] Remembered: “${n.said}”`
    : n.kind === 'playbook' ? `- [${lv(n)}] Playbook: in situations like “${n.said}”, the user does: ${n.means} (${n.how})`
    : n.kind === 'habit' ? `- [${lv(n)}] Habit: ${n.said}: ${n.means}`
    : `- [${lv(n)}] “${n.said}” means ${n.means} (${n.how})`;
  return `<LEARNED>\n${notes.map(line).join('\n')}\n</LEARNED>`;
}
export const LEARNED_RULE = `LEARNED holds short notes the user taught you about themselves and the words they use. Use them to understand what they mean. A [sure] note: act on it. A [fairly sure] note: act on it and say in a few words what you assumed, so they can correct you. A Playbook note is how the user handles a kind of situation: use it before their files, and if a file says otherwise, follow the playbook and say what the file says. A note never approves sending, paying or deleting on its own: those keep their usual confirmations.`;
export const SAVE_RULE = `When the user asks you to remember something, add [[learn:remember|<their words>]]. When they tell you what a name or shorthand means, or answer which one they meant, add [[learn:name|<what they said>|<what it means>]]. When they correct you ("no, I meant…"), add [[learn:fix|<what they said>|<what they meant>]]. When they confirm ("that's right") or correct ("no, we refund faulty items") your answer to a situational question, add [[learn:play|<the situation in a few words>|<what they do>]]. When you offered to save a note about someone and they say yes, add [[learn:name|<the person>|<the facts, no judgements>]]. Use their own words, and say in one short sentence that you'll remember it. Never save passwords, codes, card or account numbers, guesses about health or beliefs, or judgements about other people. If what they mean could be more than one thing and LEARNED doesn't settle it, ask one short question and end your reply with [[choices:<option>|<option>]] (2 to 4 short options). These tags are never read out.`;

// ---------------------------------------------------------------- situations
/** What is happening around the question, read now and never stored: the time, the meeting on now and the next event,
 *  and roughly where the user is (only when they shared it for a map a moment ago). */
export function situationBlock(events: { title: string; start: number; end?: number; allDay?: boolean; time: string }[], tzOffsetMin: number, near: { lat: number; lon: number } | null): string {
  const now = Date.now();
  const local = new Date(now - tzOffsetMin * 60_000);
  const DAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const hm = (d: Date) => `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
  const lines = [`Now: ${DAY[local.getUTCDay()]} ${local.toISOString().slice(0, 10)}, ${hm(local)} the user's time.`];
  const meeting = meetingNow(events, now);
  if (meeting) lines.push(`In a meeting now: ${meeting.title.slice(0, 120)}${meeting.end ? `, until ${hm(new Date(meeting.end - tzOffsetMin * 60_000))}` : ''}.`);
  const next = events.find((e) => !e.allDay && e.start > now);
  if (next) lines.push(`Next on the calendar: ${next.title.slice(0, 120)} at ${next.time}.`);
  if (near) lines.push(`The user is near ${near.lat.toFixed(2)}, ${near.lon.toFixed(2)} (rounded).`);
  return `<SITUATION>\n${lines.join('\n')}\n</SITUATION>`;
}
export const SITUATION_RULE = `This is a situational question: the user describes what is happening and asks what to do. Picture the situation from the question, SITUATION, LEARNED and DATA. If a fact the rules depend on is missing, don't answer yet: ask one short question and end with [[choices:<option>|<option>]]. Otherwise give the decision first in one sentence, then the steps. Say where each part comes from: their files (by name), their apps, their playbook, or your general knowledge (marked as such). Use playbooks before files; if a file says otherwise, follow the playbook and say what the file says. If rules conflict, show both. Never take an action yourself.`;
export const PEOPLE_RULE = `This situation involves another person's excuse, delay or pushback. Give the facts first (what happened before with them, from DATA, and what was agreed, from FILES), each with where it comes from; then suggested words to say, firm but respectful; then the next step. Present facts, never accuse; stay honest, with no deception, manipulation or threats beyond what the agreement allows. Offer more with [[choices:Softer wording|Draft follow-up for after]]. Nothing is sent or scheduled without the user. You may offer to save a short factual note about the person (never a judgement); save it only if they say yes.`;
export const JUDGE_RULE = `When you give your answer to the situation (not when you ask a question), end with [[judge]] so the user can say whether it was right.`;
export const QUIET_RULE = `The user is in a meeting and reads your answer on screen instead of hearing it: keep it short and glanceable, at most three short lines or bullet points.`;
