// What Niko learns about each person: short notes it looks up when they ask something, like their files. No AI is
// trained. Notes come only from the person's own words and taps in Niko, never from emails, messages, files or pages
// others wrote. These are the shared rules: kinds, how sure Niko is, the tags the AI uses to save a note, and the checks
// that keep anything else from being saved.

/** Kinds kept in the Knowledge database. Habits and playbooks come with situations (stage 2e). */
export type KnLearnedKind = 'person' | 'correction' | 'habit' | 'playbook' | 'file-match' | 'remembered';
export const KN_LEARNED_KINDS: KnLearnedKind[] = ['person', 'correction', 'habit', 'playbook', 'file-match', 'remembered'];
/** Kinds shown in What Niko learned, in order. */
export const KN_LEARNED_KINDS_NOW: KnLearnedKind[] = ['person', 'correction', 'habit', 'playbook', 'file-match', 'remembered'];
export const KN_LEARNED_KIND_NAMES: Record<KnLearnedKind, string> = {
  person: 'People and names', correction: 'Corrections', habit: 'Habits', playbook: 'Playbooks', 'file-match': 'File matches', remembered: 'Remembered',
};
export const KN_LEARNED_MAX = 1000;
export const KN_TAUGHT_MAX = 500;
export const KN_SAID_CHARS = 120;
export const KN_MEANS_CHARS = 300;

/** How sure Niko is about a note: sure, it acts; fairly sure, it acts and says what it assumed; not sure, it asks. */
export type KnLevel = 'sure' | 'fairly' | 'unsure';
export const knLevel = (sure: number): KnLevel => (sure >= 0.85 ? 'sure' : sure >= 0.6 ? 'fairly' : 'unsure');
export const KN_LEVEL_NAMES: Record<KnLevel, string> = { sure: 'Sure', fairly: 'Fairly sure', unsure: 'Not sure' };

/** A file piece the person said is (or isn't) the answer to questions like one they asked. `piece` is the piece's
 *  number in a file kept in Niko, or its key in a file kept on the device. */
export interface KnTarget { fileId: string; piece: string; file: string; heading: string | null; answer: 'yes' | 'no' }
export interface KnLearnedItem {
  id: string; kind: KnLearnedKind; said: string; means: string; how: string; level: KnLevel; uses: number;
  confirmed: boolean; target: KnTarget | null; createdAt: string; lastUsed: string | null;
  /** A habit Niko noticed: which one, and whether it is waiting for the person's yes (and fades in this many days). */
  habit?: KnHabit; suggested?: boolean; fadesIn?: number;
}

// ---------------------------------------------------------------- habits Niko notices
/** Each habit has its own watcher in the app. Noticed KN_HABIT_AFTER times, it is suggested once and kept only with a
 *  yes; one never confirmed fades after KN_HABIT_FADE_DAYS. */
export type KnHabit = 'walk-short' | 'inbox-morning';
export const KN_HABITS: Record<KnHabit, { said: string; means: string; unit: [string, string]; ask: string }> = {
  'walk-short': { said: 'Walk for trips under 1 km', means: 'Maps opens walking directions', unit: ['trip', 'trips'], ask: 'You usually walk for trips under 1 km. Make walking the default for short trips?' },
  'inbox-morning': { said: 'Inbox summary on weekday mornings', means: 'When you first open Niko', unit: ['morning', 'mornings'], ask: 'You usually check your mail first thing on weekday mornings. Show an inbox summary when you first open Niko then?' },
};
export const KN_HABIT_AFTER = 3;
export const KN_HABIT_FADE_DAYS = 60;
export const isHabit = (v: unknown): v is KnHabit => v === 'walk-short' || v === 'inbox-morning';
/** How sure Niko is about a habit it noticed but nobody confirmed: more sightings, a little surer, never "sure". */
export const habitSure = (seen: number) => Math.min(0.8, 0.4 + 0.1 * seen);

const clean = (v: unknown, n: number) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n) : '');
export function cleanTarget(v: unknown): KnTarget | null {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const fileId = typeof o.fileId === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(o.fileId) ? o.fileId : '';
  const piece = typeof o.piece === 'string' || typeof o.piece === 'number' ? String(o.piece) : '';
  if (!fileId || !/^[A-Za-z0-9:-]{1,100}$/.test(piece)) return null;
  return { fileId, piece, file: clean(o.file, 200) || 'File', heading: clean(o.heading, 200) || null, answer: o.answer === 'no' ? 'no' : 'yes' };
}

// ---------------------------------------------------------------- never kept
/** Passwords, codes, card and account numbers are never kept, even when the person asks. */
/** One thing to remember on a line: a message that lists several facts (on separate lines, or as bullets) is several
 *  notes, so each gets its own bullet wherever Niko keeps a copy. */
export function splitFacts(text: string): string[] {
  const parts = text.split(/\r?\n+/).map((x) => x.replace(/^\s*(?:[-*•·]|\d+[.)])\s+/, '').trim()).filter(Boolean);
  return parts.length ? parts : [text.trim()].filter(Boolean);
}
export function looksSecret(text: string): boolean {
  return /\b(password|passcode|pass code|pin( code)?|otp|one[- ]time (code|password)|cvv|cvc|security code|verification code|login code|2fa)\b/i.test(text)
    || /\b(?:\d[ -]?){9,}\b/.test(text) // long runs of digits: card, account and ID numbers
    || /\b[A-Z]{2}\d{2}[A-Z0-9]{10,30}\b/.test(text); // IBAN-like
}

// ---------------------------------------------------------------- the tags the AI uses
/** [[learn:remember|<their words>]], [[learn:name|<what they said>|<what it means>]], [[learn:fix|<said>|<means>]],
 *  [[learn:play|<situation>|<what they do>]] (a playbook, after they confirm or correct a situational answer). */
export interface KnLearnAsk { kind: 'person' | 'correction' | 'remembered' | 'playbook'; said: string; means: string }
const LEARN_TAG = /\[\[learn:(remember|name|fix|play)\|([^|\]\n]{1,400})(?:\|([^\]\n]{1,400}))?\]\]/gi;
export function learnTags(reply: string): KnLearnAsk[] {
  const out: KnLearnAsk[] = [];
  for (const m of reply.matchAll(LEARN_TAG)) {
    if (out.length >= 2) break;
    const t = m[1]!.toLowerCase();
    const kind = t === 'remember' ? 'remembered' : t === 'name' ? 'person' : t === 'play' ? 'playbook' : 'correction';
    const said = clean(m[2], kind === 'remembered' ? KN_MEANS_CHARS : KN_SAID_CHARS).replace(/^["“'‘]|["”'’]$/g, '');
    const means = kind === 'remembered' ? said : clean(m[3], KN_MEANS_CHARS);
    if (said && means) out.push({ kind, said, means });
  }
  return out;
}
export const stripLearnTags = (reply: string) => reply.replace(LEARN_TAG, '').replace(/[ \t]{2,}/g, ' ').trim();

/** [[choices:Design team|Sales team]]: Niko isn't sure what the person means and offers 2 to 4 answers to tap. */
const CHOICES_TAG = /\[\[choices:([^\]\n]{1,400})\]\]/i;
export function choicesTag(reply: string): string[] {
  const m = CHOICES_TAG.exec(reply);
  if (!m) return [];
  const opts = [...new Set(m[1]!.split('|').map((x) => clean(x, 60)).filter(Boolean))];
  return opts.length >= 2 ? opts.slice(0, 4) : [];
}
export const stripChoicesTag = (reply: string) => reply.replace(new RegExp(CHOICES_TAG.source, 'gi'), '').trim();

// ---------------------------------------------------------------- what may be saved
export const contentWords = (text: string) => [...new Set((text.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => w.length > 2 || /\p{N}/u.test(w) || /[\p{Script=Han}\p{Script=Hangul}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(w)))];
/** Words that say little about what a question is about. Word search in Niko's database ranks by how many of the
 *  question's words a piece has, with no sense of how rare a word is, so "the", "how" and "much" would otherwise count as
 *  much as "blender". The browser's own search weighs rare words already. */
const COMMON_WORDS = new Set(('the and for are but not you your yours our ours his her its they them their this that these those '
  + 'what when where which who whom whose why how much many does did doing done was were been being have has had having '
  + 'can could would should will shall may might must any all some each every from into onto with without about above below '
  + 'than then there here also just only very too out off over under again more most other such own same both few nor '
  + 'let get got please tell know show give want need like one way').split(' '));
/** The words to search for: the question's content words without the common ones (all of them, if that leaves none). */
export const searchWords = (text: string) => { const all = contentWords(text); const some = all.filter((w) => !COMMON_WORDS.has(w)); return some.length ? some : all; };
const inText = (part: string, text: string) => {
  const ws = contentWords(part);
  if (!ws.length) return text.toLowerCase().includes(part.toLowerCase().trim());
  const have = new Set(contentWords(text));
  return ws.filter((w) => have.has(w)).length / ws.length >= 0.8;
};
/** Words that judge a person rather than state a fact: notes about people are facts only. */
const JUDGING = /\b(unreliable|untrustworthy|lazy|liar|lying|dishonest|incompetent|useless|stupid|idiot|rude|difficult person|annoying|shady|crook|cheat(er|ing)?|scam(mer)?|bad (payer|person|client|customer))\b/i;
const YES = /^\s*(yes|yeah|yep|sure|ok(ay)?|please do|do it|save (it|that|the note)|that'?s right|correct|right|exactly)\b/i;
const NO_CORRECTION = /^\s*(no\b|nope\b|actually\b|not quite\b|we (always |usually |actually )?(do|don'?t|refund|replace|repair|give|offer|charge|accept|let|allow)\b|i (always |usually )?(do|don'?t|refund|replace|give|offer|charge|accept|let|allow)\b)/i;
const share = (part: string, text: string) => { const ws = contentWords(part); if (!ws.length) return 0; const have = new Set(contentWords(text)); return ws.filter((w) => have.has(w)).length / ws.length; };
/** Whether a note the AI asked to save really comes from the person. The words must be in what they just said (for a
 *  name or correction, one side may be in their message before), or, when they answered Niko's offer with a yes, in
 *  what Niko had just offered. A playbook needs a confirmation or correction of Niko's last answer, about the situation
 *  they had asked about. Anything that looks like a password, code or account number is refused, and so is a note that
 *  judges a person. Text in an email, message, file or page is never the person's own message, so it can't teach Niko. */
export function learnAllowed(ask: KnLearnAsk, said0: { now: string; before?: string; answer?: string }): boolean {
  const said = { ...said0, now: said0.now.replace(/[’‘]/g, "'") };
  if (looksSecret(`${ask.said} ${ask.means}`) || JUDGING.test(`${ask.said} ${ask.means}`)) return false;
  const before = said.before ?? '', answer = said.answer ?? '';
  if (ask.kind === 'playbook') {
    const confirm = YES.test(said.now), correct = NO_CORRECTION.test(said.now);
    if (!confirm && !correct) return false;
    if (share(ask.said, `${before} ${answer}`) < 0.5) return false;
    return correct ? share(ask.means, said.now) >= 0.5 || (confirm && share(ask.means, answer) >= 0.5) : share(ask.means, answer) >= 0.5;
  }
  if (ask.kind === 'remembered') return inText(ask.said, said.now) || (YES.test(said.now) && inText(ask.said, answer));
  // A note Niko offered ("Save a note: Marcus, payment delayed twice?") and the person said yes to.
  if (YES.test(said.now) && inText(ask.said, answer) && inText(ask.means, answer)) return true;
  return (inText(ask.said, said.now) && (inText(ask.means, said.now) || inText(ask.means, before)))
    || (inText(ask.means, said.now) && inText(ask.said, before));
}

// ---------------------------------------------------------------- situations
/** A situational question describes what is happening and asks what to do. People situations involve someone else's
 *  excuse, delay or pushback. A quick check on the words, so simple questions cost the same as before. */
export function situationOf(text: string): { situation: boolean; people: boolean } {
  const t = text.toLowerCase().replace(/[’‘]/g, "'");
  const asks = /\b(what (do|should|can|would) (i|we) (do|say|tell|reply|offer|answer)|how (do|should|can) (i|we) (handle|deal with|respond|reply|answer)|(can|should|may|must) (i|we) (refund|return|exchange|charge|cancel|give|offer|accept|refuse|let|allow|ask)|should (i|we)\b|is it (ok|okay|fine) (to|if)|am i allowed|are we allowed|what'?s the (rule|policy)|do i have to|do we have to)\b/.test(t);
  const who = /\b(customer|client|supplier|vendor|colleague|boss|manager|tenant|landlord|guest|patient|student|parent|staff|employee|contractor|buyer|seller|someone|he|she|they)\b/.test(t);
  const happened = /\b(says?|said|wants?|asked|is asking|bought|ordered|complain(s|ed|ing)?|late|delay(s|ed)?|postpone(s|d)?|refuses?|refused|missed|cancel(l)?ed|blames?|broke|faulty|damaged|excuse)\b/.test(t);
  // Someone's excuse, delay or pushback (often a person named in the question, so no list of words for who it is).
  const people = /\b(late because|blames?|excuse|delay(s|ed)? (again|the payment|payment)|postpone(s|d)? (again|delivery|the)|missed (the|a|their|his|her) deadline|payment is late|is late (again|because)|pushing back|refuses to pay)\b/.test(t)
    || (who && /\bsays (the|it'?s|that|they|he|she)\b/.test(t));
  return { situation: asks && (who || happened) || people, people };
}
/** [[judge]]: Niko asks "Was this right?" under a situational answer. */
const JUDGE_TAG = /\[\[judge\]\]/gi;
export const judgeTag = (reply: string) => JUDGE_TAG.test(reply);
export const stripJudgeTag = (reply: string) => reply.replace(JUDGE_TAG, '').trim();

/** Two questions are "like each other" for a taught match: by search numbers when there are some, else by words. */
export const KN_TAUGHT_NEAR = { cloudflare: 0.8, device: 0.9 } as const;
export function wordsAlike(a: string, b: string): number {
  const x = new Set(contentWords(a)), y = new Set(contentWords(b));
  if (!x.size || !y.size) return 0;
  let both = 0; for (const w of x) if (y.has(w)) both++;
  return both / (x.size + y.size - both);
}
export const KN_TAUGHT_WORDS = 0.5;

/** How a note was learned, as shown in What Niko learned. */
export type KnHow = 'told' | 'corrected' | 'chose' | 'yes' | 'no' | 'remember' | 'confirmed' | 'agreed' | 'noticed' | 'suggested';
export const KN_HOW_NAMES: Record<KnHow, string> = {
  told: 'You told Niko', corrected: 'You corrected Niko', chose: 'You chose it when Niko asked', yes: '“That’s the one”', no: '“Not this one”', remember: 'You asked Niko to remember',
  confirmed: 'You confirmed Niko’s answer', agreed: 'You said yes when Niko offered', noticed: 'Noticed · not confirmed', suggested: 'You said yes to a suggestion',
};
export const knHowName = (how: string) => KN_HOW_NAMES[how as KnHow] ?? 'You told Niko';

/** The meeting on the calendar right now, if any (not all-day; an event without an end counts for an hour). */
export function meetingNow<T extends { title: string; start: number; end?: number; allDay?: boolean }>(events: T[], now = Date.now()): T | null {
  return events.find((e) => !e.allDay && e.start <= now && now < (e.end && e.end > e.start ? e.end : e.start + 3600_000)) ?? null;
}
