// What Niko learns about each person: short notes it looks up when they ask something, like their files. No AI is
// trained. Notes come only from the person's own words and taps in Niko, never from emails, messages, files or pages
// others wrote. These are the shared rules: kinds, how sure Niko is, the tags the AI uses to save a note, and the checks
// that keep anything else from being saved.

/** Kinds kept in the Knowledge database. Habits and playbooks come with situations (stage 2e). */
export type KnLearnedKind = 'person' | 'correction' | 'habit' | 'playbook' | 'file-match' | 'remembered';
export const KN_LEARNED_KINDS: KnLearnedKind[] = ['person', 'correction', 'habit', 'playbook', 'file-match', 'remembered'];
/** Kinds Niko can learn now; the others stay hidden until they work. */
export const KN_LEARNED_KINDS_NOW: KnLearnedKind[] = ['person', 'correction', 'file-match', 'remembered'];
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
}

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
export function looksSecret(text: string): boolean {
  return /\b(password|passcode|pass code|pin( code)?|otp|one[- ]time (code|password)|cvv|cvc|security code|verification code|login code|2fa)\b/i.test(text)
    || /\b(?:\d[ -]?){9,}\b/.test(text) // long runs of digits: card, account and ID numbers
    || /\b[A-Z]{2}\d{2}[A-Z0-9]{10,30}\b/.test(text); // IBAN-like
}

// ---------------------------------------------------------------- the tags the AI uses
/** [[learn:remember|<their words>]], [[learn:name|<what they said>|<what it means>]], [[learn:fix|<said>|<means>]]. */
export interface KnLearnAsk { kind: 'person' | 'correction' | 'remembered'; said: string; means: string }
const LEARN_TAG = /\[\[learn:(remember|name|fix)\|([^|\]\n]{1,400})(?:\|([^\]\n]{1,400}))?\]\]/gi;
export function learnTags(reply: string): KnLearnAsk[] {
  const out: KnLearnAsk[] = [];
  for (const m of reply.matchAll(LEARN_TAG)) {
    if (out.length >= 2) break;
    const kind = m[1]!.toLowerCase() === 'remember' ? 'remembered' : m[1]!.toLowerCase() === 'name' ? 'person' : 'correction';
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
const inText = (part: string, text: string) => {
  const ws = contentWords(part);
  if (!ws.length) return text.toLowerCase().includes(part.toLowerCase().trim());
  const have = new Set(contentWords(text));
  return ws.filter((w) => have.has(w)).length / ws.length >= 0.8;
};
/** Whether a note the AI asked to save really comes from the person: the words must be in what they just said (or,
 *  for a name or correction, one side in what they just said and the other in their message before). Anything that
 *  looks like a password, code or account number is refused. This is what stops an email, message or file from
 *  teaching Niko: their text is never the person's message. */
export function learnAllowed(ask: KnLearnAsk, said: { now: string; before?: string }): boolean {
  if (looksSecret(`${ask.said} ${ask.means}`)) return false;
  if (ask.kind === 'remembered') return inText(ask.said, said.now);
  const before = said.before ?? '';
  return (inText(ask.said, said.now) && (inText(ask.means, said.now) || inText(ask.means, before)))
    || (inText(ask.means, said.now) && inText(ask.said, before));
}

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
export type KnHow = 'told' | 'corrected' | 'chose' | 'yes' | 'no' | 'remember';
export const KN_HOW_NAMES: Record<KnHow, string> = {
  told: 'You told Niko', corrected: 'You corrected Niko', chose: 'You chose it when Niko asked', yes: '“That’s the one”', no: '“Not this one”', remember: 'You asked Niko to remember',
};
export const knHowName = (how: string) => KN_HOW_NAMES[how as KnHow] ?? 'You told Niko';
