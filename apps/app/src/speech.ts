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

// ---- Opening an item in the list on screen ("open Testing 123021", "open the second one", "next")
const NUM: Record<string, string> = { zero: '0', oh: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9', ten: '10', eleven: '11', twelve: '12' };
const ORD: Record<string, number> = { first: 0, second: 1, third: 2, fourth: 3, fifth: 4, sixth: 5, seventh: 6, eighth: 7, ninth: 8, tenth: 9, '1st': 0, '2nd': 1, '3rd': 2, '4th': 3, '5th': 4, '6th': 5, '7th': 6, '8th': 7, '9th': 8, '10th': 9 };
/** Lower case, no punctuation, spoken digits as digits, and digit runs joined ("one two three" / "1 2 3" → "123"). */
export function normTitle(t: string): string {
  const toks = t.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean).map((w) => NUM[w] ?? w);
  const out: string[] = [];
  for (const w of toks) { if (/^\d+$/.test(w) && out.length && /^\d+$/.test(out[out.length - 1]!)) out[out.length - 1] += w; else out.push(w); }
  return out.join(' ');
}
const OPEN = /^(?:(?:hey|ok|okay|so|now|and|please|niko)\s+)*(?:(?:can|could|would) you\s+|i(?:'d| would) like to\s+|i want to\s+|let me\s+|let'?s\s+)?(?:please\s+)?(?:open( up)?|show( me)?|read( me)?|select|pick|choose|view|display|bring up|pull up|go to|look at|see|check|play)\s+/;
const KIND = /^(?:the\s+|my\s+|that\s+|this\s+)?(?:(?:note|page|event|meeting|appointment|email|e mail|mail|message|chat|conversation|item|entry)\s+)?(?:(?:called|named|titled|about|from|with)\s+)?/;

/** Which item a phrase asks for: an index into titles, or null. `current` is the selected index (for next/previous). */
export function pickItem(raw: string, titles: string[], current = -1): number | null {
  if (!titles.length) return null;
  let t = normTitle(raw).replace(/\b(please|now|for me|thanks|thank you)\b/g, ' ').replace(/\s+/g, ' ').trim();
  if (/^(?:(?:go to|open|show( me)?|select)\s+)?(?:the\s+)?next( one| 1| item| note| event| message)?$/.test(t)) return current + 1 < titles.length ? current + 1 : null;
  if (/^(?:(?:go to|open|show( me)?|select)\s+)?(?:the\s+)?(previous|prior)( one| 1| item| note| event| message)?$/.test(t)) return current > 0 ? current - 1 : null;
  const opened = OPEN.exec(t);
  if (!opened) return null; // only "open/show/read/select … " asks for an item; anything else stays with the AI
  t = t.slice(opened[0].length).replace(KIND, '').trim();
  // "the second one", "number 3", "item 2", "the last one"
  const ord = /^(?:the\s+)?(\w+)(?:\s+(?:one|1|item|note|event|message|email|chat|page|entry))?$/.exec(t); // "one" reads as 1
  if (ord && ORD[ord[1]!] !== undefined) return ORD[ord[1]!]! < titles.length ? ORD[ord[1]!]! : null;
  if (/^(?:the\s+)?last(\s+(one|1|item|note|event|message))?$/.test(t)) return titles.length - 1;
  const n = /^(?:number|no|item|#)\s*(\d+)$/.exec(t);
  if (n) { const i = Number(n[1]) - 1; return i >= 0 && i < titles.length ? i : null; }
  if (!t) return null;
  // By title: exact, then contains, then most words in common. Digits must match when the phrase has any.
  const q = t, qWords = q.split(' '), qDigits: string[] = q.match(/\d+/g) ?? [];
  let best = -1, bestScore = 0;
  titles.forEach((title, i) => {
    const tt = normTitle(title);
    if (!tt) return;
    const tDigits: string[] = tt.match(/\d+/g) ?? [];
    if (qDigits.length && !qDigits.every((d) => tDigits.includes(d))) return;
    const tWords = new Set(tt.split(' '));
    const shared = qWords.filter((w) => tWords.has(w)).length;
    const score = tt === q ? 3 : tt.includes(q) || q.includes(tt) ? 2 + shared / 100 : shared / Math.max(qWords.length, tWords.size) >= 0.6 ? 1 + shared / 100 : 0;
    if (score > bestScore) { best = i; bestScore = score; } // ties keep the first (the list's order)
  });
  return best >= 0 ? best : null;
}

/** The AI can name an item for Niko to open: [[item:notes:Testing 123021]] (inbox, calendar or notes). */
export function takeItemTag(reply: string): { text: string; item: { view: 'inbox' | 'calendar' | 'notes'; title: string } | null } {
  const m = /\[\[\s*item\s*:\s*(inbox|calendar|notes)\s*:\s*([^\]]{1,200})\]\]/i.exec(reply);
  const text = reply.replace(/\s*\[\[\s*item\s*:[^\]]*\]\]\s*/gi, ' ').trim();
  return { text, item: m ? { view: m[1]!.toLowerCase() as 'inbox' | 'calendar' | 'notes', title: m[2]!.trim() } : null };
}

/**
 * A request to change the reply draft, such as "rewrite the draft", "make it shorter", "more formal please",
 * "say I'll be there at 7" or "tell her thanks". Returns the request as said, or null for anything else.
 * Only used while a conversation with a draft box is open.
 */
export function rewriteRequest(raw: string): string | null {
  const p = raw.toLowerCase().replace(/^(niko|nico|hey niko)[,\s]+/, '').replace(/[.!?]+$/, '').trim();
  if (!p || p.length > 300) return null;
  // Asking for another go at the whole draft.
  if (/^(please\s+)?(re-?write|re-?draft|re-?do|re-?phrase|re-?word|regenerate|try (that )?again|another (version|draft|one)|write (it|the (draft|reply)) again)\b/.test(p)) return raw.trim();
  // Changing how it reads: "make it shorter", "more formal", "less stiff", "friendlier", "fix the grammar".
  if (/^(please\s+)?(make (it|the (draft|reply|message))|can you make (it|the (draft|reply|message)))\b/.test(p)) return raw.trim();
  if (/^(please\s+)?(more|less|a bit more|a bit less|much more)\s+\w+/.test(p) && !/\b(about|on|for)\s+(the\s+)?(weather|calendar|events?|notes?)\b/.test(p)) return raw.trim();
  if (/^(please\s+)?(shorter|longer|friendlier|warmer|firmer|politer|simpler|briefer|nicer|funnier)\b/.test(p)) return raw.trim();
  if (/^(please\s+)?(change|edit|update|fix|tweak|improve|shorten|lengthen|polish|soften|expand|translate)\s+(it|that|the (draft|reply|message|wording|tone|grammar|spelling))\b/.test(p)) return raw.trim();
  if (/\b(the|this|my) (draft|reply)\b/.test(p) && /\b(change|edit|rewrite|shorten|make|add|remove|mention|say|include|drop|tone|formal|casual|friendly)\b/.test(p)) return raw.trim();
  // Saying what the reply should say: "say I'll be late", "tell her thanks", "reply that I'm in", "add that…".
  if (/^(please\s+)?(say|tell (him|her|them)|reply (that|saying|with)|answer (that|saying|with)|add (that|a line|something)|mention|include|remove|drop|take out|don't mention)\b/.test(p)) return raw.trim();
  return null;
}

/**
 * A request to scroll the screen: "scroll down", "page up", "go down a bit", "back to the top", "scroll to the
 * bottom", "keep scrolling", "show me more". Returns which way, or null for anything else.
 */
export function scrollRequest(raw: string): 'down' | 'up' | 'top' | 'bottom' | null {
  const p = raw.toLowerCase().replace(/^(niko|nico|hey niko)[,\s]+/, '').replace(/^(please|can you|could you|would you)\s+/, '').replace(/[.!?]+$/, '').replace(/\s+please$/, '').trim();
  if (!p || p.length > 60) return null;
  const tail = '(\\s+(a bit|a little|some|more|again|further|the page|the list|the screen|this|it))*';
  if (new RegExp(`^((scroll|go|jump|take me|move)\\s+)?(back\\s+)?(up\\s+)?to the (very\\s+)?(top|start|beginning)${tail}$`).test(p)) return 'top';
  if (new RegExp(`^((scroll|go|jump|take me|move)\\s+)?(down\\s+)?to the (very\\s+)?(bottom|end)${tail}$`).test(p)) return 'bottom';
  if (new RegExp(`^(scroll|page|go|move)\\s+(the page\\s+|the list\\s+|it\\s+)?(down|downwards)${tail}$|^(down|further down|scroll|keep scrolling|scroll more|show( me)? more|next page|more please)${tail}$`).test(p)) return 'down';
  if (new RegExp(`^(scroll|page|go|move)\\s+(the page\\s+|the list\\s+|it\\s+)?(back\\s+)?(up|upwards)${tail}$|^(up|back up|further up|previous page)${tail}$`).test(p)) return 'up';
  return null;
}
