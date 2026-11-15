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

// ---- Changing screen by voice ("switch to calendar", "can you open my notes please", "back to home")
/** Niko's screens, with the words people use for them. The first name is the one Niko says back. */
export const SCREENS: { path: string; name: string; words: RegExp }[] = [
  { path: '/', name: 'Home', words: /^(home|home ?screen|main( screen| page)?|start( screen)?|the core)$/ },
  { path: '/inbox', name: 'Inbox', words: /^(inbox|in box|mail|e-?mails?|messages?|chats?|conversations?)$/ },
  { path: '/calendar', name: 'Calendar', words: /^(calendars?|schedule|agenda|events?|diary|meetings?)$/ },
  { path: '/notes', name: 'Notes', words: /^(notes?|notebook|notion|one ?note)$/ },
  { path: '/connections', name: 'Connections', words: /^(connections?|integrations?|linked (apps|accounts)|apps)$/ },
  { path: '/engine', name: 'Engine', words: /^(engine|ai( engine| model)?|brain|model)$/ },
  { path: '/voice', name: 'Voice', words: /^(voices?|speech|voice settings)$/ },
  { path: '/appearance', name: 'Appearance', words: /^(appearance|settings|preferences|colou?rs?|theme|look)$/ },
  { path: '/account', name: 'Account', words: /^(account|my account|profile|passkeys?|security|password)$/ },
];

const POLITE = /^(?:(?:hey|hi|ok|okay|so|um|uh|now|and|then|please|niko)[\s,]+)*(?:(?:can|could|would|will) you\s+|i(?:'d| would) like to\s+|i want to\s+|i wanna\s+|let'?s\s+|let me\s+)?(?:please\s+)?/;
const VERB = /^(?:open( up)?|show( me)?|display|view|see|go( back)?( over)?( to)?|get me to|take me( back)?( over)?( to)?|bring( me)?( up)?|pull up|switch( back)?( over)?( to)?|change( the)?( screen| screens| page| view)?( back)?( over)?( to)?|move( over)?( to)?|navigate( back)?( to)?|jump( back)?( to)?|head( back)?( over)?( to)?|back to|return to|launch|visit)\s+/;
const FILLER = /^(?:(?:the|my|our|your|niko'?s)\s+)?(.*?)(?:\s+(?:screen|page|tab|view|section|settings|app))?(?:\s+(?:please|now|for me|thanks|thank you))*$/;

/** The screen a phrase asks for, "back" for "go back", or null when it isn't a request to change screen
 * (questions about what is on a screen, like "what's on my calendar today", stay with the AI). */
export function screenFor(raw: string): string | null {
  let t = raw.toLowerCase().replace(/[.!?,]+/g, ' ').replace(/\s+/g, ' ').trim().replace(POLITE, '');
  if (/^(go|take me|get me|head|navigate|switch|jump) back$|^back$|^previous (screen|page)$/.test(t)) return 'back';
  const verb = VERB.exec(t);
  if (verb) t = t.slice(verb[0].length);
  else if (t.split(' ').length > 4) return null; // a bare screen name ("calendar", "my notes screen") is short
  const target = (FILLER.exec(t)?.[1] ?? '').trim();
  if (!target) return null;
  // "voice settings" / "engine settings": the screen word wins over the generic "settings".
  const hit = SCREENS.find((s) => s.words.test(target)) ?? SCREENS.find((s) => s.words.test(target.replace(/\s+settings$/, '')));
  return hit ? hit.path : null;
}
export const screenName = (path: string) => SCREENS.find((s) => s.path === path)?.name ?? path;

/** The AI can ask for a screen by ending its reply with [[open:calendar]]. Only Niko's own screens are accepted. */
export function takeScreenTag(reply: string): { text: string; path: string | null } {
  const m = /\[\[\s*open\s*:\s*([a-z ]+?)\s*\]\]/i.exec(reply);
  const text = reply.replace(/\s*\[\[\s*open\s*:[^\]]*\]\]\s*/gi, ' ').trim();
  if (!m) return { text, path: null };
  const want = m[1]!.toLowerCase();
  return { text, path: SCREENS.find((s) => s.name.toLowerCase() === want || s.words.test(want))?.path ?? null };
}
