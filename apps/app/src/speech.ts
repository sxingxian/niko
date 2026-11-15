// Matching what the microphone heard: Niko's name, and Niko's own voice coming back through the speaker.
// Kept free of React and browser APIs so the release tests can run it in Node.

/** "Niko" as speech recognisers write it: Niko, Nico, Nikko, Nicko, Neko, Neeko, Nicco, optionally after "hey"/"ok".
 * Returns what was said after the name (empty if the name was said alone), or null if the name wasn't heard. */
const WAKE = /(?:^|[^a-z])(?:(?:hey|hi|ok|okay)[\s,]+)?n(?:i|ee|e|y)(?:k|c|ck|kk|cc|q)h?o[h]?(?![a-z])[\s,.!?:;-]*(.*)$/i;
export function matchWake(text: string): { command: string } | null {
  const m = WAKE.exec(text);
  return m ? { command: (m[1] ?? '').trim() } : null;
}

/** Words of a phrase, for comparing what the mic heard with what Niko said. */
const words = (t: string) => t.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}\s']/gu, ' ').split(/\s+/).filter(Boolean);
/** True when what the mic heard is (mostly) Niko's own last line coming back through the speaker. */
export function isEcho(heard: string, spoken: string): boolean {
  const h = words(heard), said = new Set(words(spoken));
  if (!h.length || !said.size) return false;
  const shared = h.filter((w) => said.has(w)).length;
  return h.length >= 2 ? shared / h.length >= 0.6 : said.has(h[0]!) && said.size <= 3;
}
