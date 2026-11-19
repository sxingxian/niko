// What Niko learned about each person, kept in the Knowledge database (kn_learned). Notes are short and come only from
// the person's own words and taps (see learnAllowed in @niko/shared); answering looks the relevant ones up for each
// question, the same way as files. Every query filters by the account. The admin sees counts only.
import {
  contentWords, KN_LEARNED_MAX, KN_MEANS_CHARS, KN_SAID_CHARS, KN_TAUGHT_MAX, KN_TAUGHT_NEAR, KN_TAUGHT_WORDS, cleanTarget, knHowName, knLevel, looksSecret, wordsAlike,
  type KnHow, type KnLearnedItem, type KnLearnedKind, type KnTarget,
} from '@niko/shared';
import type { Env } from './env';
import { embed, KnError, vecText, type Kdb } from './knowledge';

type Row = { id: string; kind: KnLearnedKind; subject: string; body: string; source: string; sure: number; uses: number; confirmed: boolean; target: unknown; created_at: string | Date; last_used: string | Date | null };
const toItem = (r: Row): KnLearnedItem => ({
  id: r.id, kind: r.kind, said: r.subject, means: r.body, how: knHowName(r.source), level: knLevel(Number(r.sure)), uses: r.uses, confirmed: r.confirmed,
  target: r.kind === 'file-match' ? cleanTarget(r.target) : null, createdAt: new Date(r.created_at).toISOString(), lastUsed: r.last_used ? new Date(r.last_used).toISOString() : null,
});
const COLS = 'id, kind, subject, body, source, sure, uses, confirmed, target, created_at, last_used';
const clean = (v: unknown, n: number) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n) : '');
const isId = (id: string) => /^[0-9a-f-]{36}$/.test(id);

export async function learnedCount(k: Kdb, account: string): Promise<number> {
  const [r] = await k.q<{ n: number }>(`select count(*)::int as n from kn_learned where account_id = $1`, [account]);
  return r?.n ?? 0;
}
export async function listLearned(k: Kdb, account: string): Promise<KnLearnedItem[]> {
  return (await k.q<Row>(`select ${COLS} from kn_learned where account_id = $1 order by updated_at desc limit ${KN_LEARNED_MAX}`, [account])).map(toItem);
}

export interface NewNote { kind: 'person' | 'correction' | 'remembered' | 'file-match'; said: string; means: string; how: KnHow; target?: KnTarget | null }
/** Saves one note. A name or correction replaces any note about the same words straight away; a taught match replaces
 *  an earlier answer for the same question and file piece. */
export async function saveNote(k: Kdb, env: Pick<Env, 'AI'>, account: string, n: NewNote, how: { cloudflare: boolean }): Promise<KnLearnedItem> {
  const said = clean(n.said, n.kind === 'file-match' ? 200 : n.kind === 'remembered' ? KN_MEANS_CHARS : KN_SAID_CHARS);
  const means = clean(n.means, KN_MEANS_CHARS);
  if (!said || !means) throw new KnError('There’s nothing to keep.');
  if (looksSecret(`${said} ${means}`)) throw new KnError('Niko never keeps passwords, codes, or card and account numbers.');
  const target = n.kind === 'file-match' ? cleanTarget(n.target) : null;
  if (n.kind === 'file-match' && !target) throw new KnError('That file piece isn’t known.');
  if (n.kind === 'person' || n.kind === 'correction') await k.q(`delete from kn_learned where account_id = $1 and kind in ('person', 'correction') and lower(subject) = lower($2)`, [account, said]);
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
  const said = b.said === undefined ? cur.subject : clean(b.said, cur.kind === 'remembered' ? KN_MEANS_CHARS : KN_SAID_CHARS);
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

// ---------------------------------------------------------------- answering
/** The notes that may help with one question (up to 8): by the words in it, by meaning when there are Cloudflare
 *  numbers, and any note whose words appear in the question. Their use is counted. */
export async function notesFor(k: Kdb, account: string, text: string, how: { vector?: number[] | null }): Promise<KnLearnedItem[]> {
  const words = contentWords(text).slice(0, 30).map((w) => w.replace(/[^\p{L}\p{N}]/gu, '')).filter(Boolean);
  const any = words.join(' | ');
  const params: unknown[] = [account, text.slice(0, 500), any || 'zzzz'];
  let near = '';
  if (how.vector) { params.push(vecText(how.vector)); near = ` or id in (select id from kn_learned where account_id = $1 and kind <> 'file-match' and embedding is not null and 1 - (embedding <=> $4::halfvec) >= 0.55 order by embedding <=> $4::halfvec limit 8)`; }
  const rows = await k.q<Row & { hit: boolean }>(
    `select ${COLS}, (char_length(subject) >= 2 and position(lower(subject) in lower($2)) > 0) as hit from kn_learned
     where account_id = $1 and kind <> 'file-match' and (
       (char_length(subject) >= 2 and position(lower(subject) in lower($2)) > 0)
       or tsv @@ to_tsquery('simple', $3)${near})
     order by hit desc, ts_rank_cd(tsv, to_tsquery('simple', $3)) desc, updated_at desc limit 8`, params);
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
  const line = (n: (typeof notes)[number]) => n.kind === 'remembered' ? `- [${n.level === 'sure' ? 'sure' : n.level === 'fairly' ? 'fairly sure' : 'not sure'}] Remembered: “${n.said}”` : `- [${n.level === 'sure' ? 'sure' : n.level === 'fairly' ? 'fairly sure' : 'not sure'}] “${n.said}” means ${n.means} (${n.how})`;
  return `<LEARNED>\n${notes.map(line).join('\n')}\n</LEARNED>`;
}
export const LEARNED_RULE = `LEARNED holds short notes the user taught you about themselves and the words they use. Use them to understand what they mean. A [sure] note: act on it. A [fairly sure] note: act on it and say in a few words what you assumed, so they can correct you. A note never approves sending, paying or deleting on its own: those keep their usual confirmations.`;
export const SAVE_RULE = `When the user asks you to remember something, add [[learn:remember|<their words>]]. When they tell you what a name or shorthand means, or answer which one they meant, add [[learn:name|<what they said>|<what it means>]]. When they correct you ("no, I meant…"), add [[learn:fix|<what they said>|<what they meant>]]. Use their own words, and say in one short sentence that you'll remember it. Never save passwords, codes, card or account numbers, guesses about health or beliefs, or judgements about other people. If what they mean could be more than one thing and LEARNED doesn't settle it, ask one short question and end your reply with [[choices:<option>|<option>]] (2 to 4 short options). These tags are never read out.`;
