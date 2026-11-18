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

/** The AI can also scroll ([[scroll:down]]) or turn the list's page ([[page:next]], [[page:3]]), for phrasings the
 * matching here doesn't know. Returns the reply without the tags, and what was asked. */
export function takeMoveTags(reply: string): { text: string; scroll: 'down' | 'up' | 'top' | 'bottom' | null; page: string | null } {
  const s = /\[\[\s*scroll\s*:\s*(down|up|top|bottom)\s*\]\]/i.exec(reply)?.[1]?.toLowerCase() as 'down' | 'up' | 'top' | 'bottom' | undefined;
  const p = /\[\[\s*page\s*:\s*(next|prev|previous|first|last|\d{1,3})\s*\]\]/i.exec(reply)?.[1]?.toLowerCase();
  const text = reply.replace(/\s*\[\[\s*(scroll|page)\s*:[^\]]*\]\]\s*/gi, ' ').trim();
  return { text, scroll: s ?? null, page: p ? (/^\d+$/.test(p) ? `page ${p}` : p === 'prev' || p === 'previous' ? 'previous page' : `${p} page`) : null };
}

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
  const p = cleanCommand(raw);
  if (!p || p.length > 60) return null;
  const obj = '(?:\\s+(?:the\\s+)?(?:page|list|screen|this|it|view|content|window))?';
  const tail = '(?:\\s+(?:some|more|again|further))*';
  if (new RegExp(`^(?:(?:scroll|go|jump|take me|move|bring me|skip)\\s+)?(?:all the way\\s+)?(?:back\\s+)?(?:up\\s+)?(?:to\\s+)?(?:the\\s+)?(?:very\\s+)?(?:top|start|beginning)(?:\\s+of${obj})?$`).test(p)) return 'top';
  if (new RegExp(`^(?:(?:scroll|go|jump|take me|move|bring me|skip)\\s+)?(?:all the way\\s+)?(?:down\\s+)?(?:to\\s+)?(?:the\\s+)?(?:very\\s+)?(?:bottom|end)(?:\\s+of${obj})?$`).test(p)) return 'bottom';
  if (new RegExp(`^(?:scroll|page|go|move|swipe)${obj}\\s+(?:further\\s+|more\\s+|back\\s+)?(?:down|downwards|lower)${obj}${tail}$|^(?:down|further down|lower|scroll|keep scrolling|keep going|scroll more|continue scrolling|show(?: me)? (?:more|the rest)|see more|next page|more)${obj}${tail}$`).test(p)) return 'down';
  if (new RegExp(`^(?:scroll|page|go|move|swipe)${obj}\\s+(?:further\\s+|more\\s+|back\\s+)?(?:up|upwards|higher)${obj}${tail}$|^(?:up|back up|further up|higher|scroll back|previous page)${obj}${tail}$`).test(p)) return 'up';
  return null;
}

/**
 * What was said, tidied for matching commands: lower case, no punctuation (speech-to-text services add commas and
 * full stops), and without the polite words around a command ("Okay Niko, can you scroll down a bit for me, please?"
 * → "scroll down").
 */
export function cleanCommand(raw: string): string {
  let t = raw.toLowerCase().replace(/[’']/g, "'").replace(/[.,!?;:"“”()…]+/g, ' ').replace(/\s+/g, ' ').trim();
  const lead = /^(?:(?:okay|ok|alright|all right|right|so|um|uh|erm|hey|hi|hello|now|and|then|just|please|niko|nico|nikko)\s+|(?:can|could|would|will) you(?: please)?\s+|i (?:want|need) you to\s+|i'd like you to\s+|i would like you to\s+|go ahead and\s+|try to\s+)/;
  const trail = /\s+(?:please|now|for me|thanks|thank you|a bit|a little(?: bit)?|a tiny bit|slightly|niko|ok|okay|right now|again)$/;
  for (let i = 0; i < 8; i++) { const n = t.replace(lead, ''); if (n === t) break; t = n; }
  for (let i = 0; i < 8; i++) { const n = t.replace(trail, ''); if (n === t) break; t = n; }
  return t.trim();
}

/**
 * Moving between pages of a list: "next page", "previous page", "page 3", "go to page two", "first page",
 * "last page". Returns where to go, or null for anything else.
 */
export function pageRequest(raw: string): 'next' | 'prev' | 'first' | 'last' | number | null {
  // "…of my inbox", "…of emails", "…of the list": which list is clear from the screen, so it is dropped.
  const p = normTitle(cleanCommand(raw)).replace(/\s+(?:of|in|on|for)\s+(?:the\s+|my\s+|this\s+)?(?:inbox|e ?mails?|mail|messages?|chats?|notes?|calendar|events?|list|results?|items?|screen)$/, '').replace(/\s+(?:of|in)\s+(?:the\s+|my\s+)?(?:inbox|e ?mails?|mail|messages?|chats?|notes?|calendar|events?|list|results?|items?)\s+/, ' ');
  if (!p || p.length > 60) return null;
  const go = '(?:(?:go|move|turn|jump|skip|flip|switch|take me|navigate|bring me|head|show(?: me)?|open|display|load|give me|let me see|i want(?: to see)?)\\s+(?:back\\s+)?(?:over\\s+)?(?:to\\s+)?|(?:can i see|see)\\s+)?(?:the\\s+|a\\s+)?';
  const pg = '(?:page|set|lot|batch)';
  if (new RegExp(`^${go}(?:next|following|another) ${pg}$|^page forward$|^(?:go )?forward a page$|^next one page$`).test(p)) return 'next';
  if (new RegExp(`^${go}(?:previous|prior|earlier|last) ${pg} back$|^${go}(?:previous|prior|earlier) ${pg}$|^page back$|^(?:go )?back (?:a|one) page$`).test(p)) return 'prev';
  if (new RegExp(`^${go}(?:first|1st|opening) ${pg}$`).test(p)) return 'first';
  if (new RegExp(`^${go}(?:last|final) ${pg}$`).test(p)) return 'last';
  const n = new RegExp(`^${go}${pg} (?:number |no )?(\\d{1,3})$`).exec(p);
  return n ? Number(n[1]) : null;
}

// ---- After a stop: carrying on, asking again, or repeating
/** "continue" (carry on from where Niko stopped), "retry" (ask the last question again for a fresh answer),
 * "replay" (say the last answer again from the start), or null. */
export function resumeIntent(raw: string): 'continue' | 'retry' | 'replay' | null {
  const t = raw.toLowerCase().replace(/[.,!?;:"“”…]+/g, ' ').replace(/\s+/g, ' ').trim()
    .replace(/^(?:(?:ok|okay|so|and|um|uh|niko|please)\s+)+/, '').replace(/\s+(?:please|niko)$/, '');
  if (/^(continue|go on|carry on|keep going|resume|proceed|and then|then what|go ahead and finish|finish( that| it| what you were saying)?|where were we|continue (that|it|where you (left off|stopped)|from where you stopped|what you were saying)|you can continue|keep talking|carry on talking)$/.test(t)) return 'continue';
  if (/^(try again|try that again|retry|ask (it |that )?again|answer (it |that )?again|redo( that)?|one more time|give me (a )?(another|new|fresh) answer|can you try again|answer my (last )?question again)$/.test(t)) return 'retry';
  if (/^(repeat( that| it)?|say (that|it) again|start (it )?over|from the (beginning|start)|what did you say|come again|pardon|sorry what|again)$/.test(t)) return 'replay';
  return null;
}

/** Where to pick up a stopped answer: the start of the sentence that was being said at character `pos`. */
export function sentenceStart(text: string, pos: number): number {
  const p = Math.max(0, Math.min(Math.floor(pos), text.length));
  if (p >= text.length - 1) return text.length; // it had finished
  let start = 0;
  const re = /[.!?…]["”’)]*\s+|\n+/g;
  for (let m: RegExpExecArray | null; (m = re.exec(text)) && m.index + m[0].length <= p;) start = m.index + m[0].length;
  return start;
}

// ---- Pictures
/** The AI asks for a picture by ending its reply with [[image:<prompt>]], or [[image:wide: <prompt>]] / tall. */
export function takeImageTag(reply: string): { text: string; image: { prompt: string; shape: 'square' | 'wide' | 'tall' } | null } {
  const m = /\[\[\s*image\s*:\s*([\s\S]+?)\s*\]\]/i.exec(reply);
  const text = reply.replace(/\s*\[\[\s*image\s*:[\s\S]*?\]\]\s*/gi, ' ').replace(/\s+/g, ' ').trim();
  if (!m) return { text, image: null };
  let prompt = m[1]!.replace(/\s+/g, ' ').trim(), shape: 'square' | 'wide' | 'tall' = 'square';
  const s = /^(wide|tall|landscape|portrait)\s*[:,-]\s*/i.exec(prompt);
  if (s) { shape = /wide|landscape/i.test(s[1]!) ? 'wide' : 'tall'; prompt = prompt.slice(s[0].length); }
  return prompt.length >= 3 ? { text, image: { prompt: prompt.slice(0, 1500), shape } } : { text, image: null };
}

/** What to do with the picture on screen: "save it", "share it", "more like this", "close it". */
export function pictureCommand(raw: string): 'save' | 'share' | 'more' | 'close' | null {
  const t = cleanCommand(raw);
  const it = '(?:it|this|that|the (?:picture|image|photo|painting|drawing|one)|this (?:picture|image|one)|that (?:picture|image|one))';
  if (new RegExp(`^(?:save|download|keep)(?: ${it})?(?: to (?:my )?(?:device|phone|computer|photos|downloads))?$`).test(t)) return 'save';
  if (new RegExp(`^share(?: ${it})?$`).test(t)) return 'share';
  if (/^(?:(?:make|paint|draw|show me|give me|do|try) )?(?:(?:one|some|a few) )?more like (?:this|that|it)$|^(?:make |paint |draw |show me |give me )?(?:another|a different) (?:one|version|take|variation)$|^(?:another|one more)(?: one| version)?$|^(?:a )?variation$/.test(t)) return 'more';
  if (new RegExp(`^(?:close|hide|dismiss|put away)(?: ${it})?$`).test(t)) return 'close';
  return null;
}

// ---- Maps
type MapHow = 'drive' | 'transit' | 'walk' | 'cycle' | 'place' | 'fly';
/** The AI asks for a map by ending its reply with [[map:<how>|<destination>]] or [[map:<how>|<destination>|<start>]];
 * [[map:<how>|same]] changes how to travel on the map already showing. */
/** The AI opening the route's steps on screen: [[steps]]. */
export function takeStepsTag(text: string): { text: string; open: boolean } {
  const open = /\[\[\s*steps\s*\]\]/i.test(text);
  return { text: open ? text.replace(/\s*\[\[\s*steps\s*\]\]\s*/gi, ' ').replace(/\s+/g, ' ').trim() : text, open };
}
export function takeMapTag(reply: string): { text: string; map: { how: MapHow | 'any'; to: string; from?: string } | null } {
  const m = /\[\[\s*map\s*:\s*([a-z]+)\s*\|\s*([^|\]]{1,200}?)\s*(?:\|\s*([^\]]{1,200}?)\s*)?\]\]/i.exec(reply);
  const text = reply.replace(/\s*\[\[\s*map\s*:[^\]]*\]\]\s*/gi, ' ').replace(/\s+/g, ' ').trim();
  if (!m) return { text, map: null };
  const h = m[1]!.toLowerCase();
  const how: MapHow | 'any' = h === 'car' || h === 'driving' ? 'drive' : h === 'train' || h === 'bus' || h === 'public' ? 'transit' : h === 'walking' || h === 'foot' ? 'walk' : h === 'bike' || h === 'cycling' ? 'cycle' : h === 'flight' || h === 'plane' || h === 'flying' ? 'fly'
    : (['drive', 'transit', 'walk', 'cycle', 'place', 'fly'] as string[]).includes(h) ? h as MapHow : 'any';
  const to = m[2]!.replace(/\s+/g, ' ').trim(), from = m[3]?.replace(/\s+/g, ' ').trim();
  return to.length >= 2 ? { text, map: { how, to, ...(from && from.length >= 2 ? { from } : {}) } } : { text, map: null };
}

const MODE_WORDS: [Exclude<MapHow, 'place'>, string][] = [
  ['transit', 'trains?|mrt|lrt|subway|metro|buse?s?|public transport|public transit|transit|tube|underground|trams?'],
  ['walk', 'walking|walk|on foot|foot'],
  ['drive', 'driving|drive me|drive|car|taxi|cab|grab'],
  ['cycle', 'bikes?|bicycle|cycling|cycle|biking'],
  ['fly', 'planes?|flight|flights|fly|flying|air|the flight path|flight path|airplane|aeroplane'],
];
/** On a map: "by train", "walking instead", "drive me there", "by bike", "close the map". */
/**
 * The steps of the route on screen: "show me the steps for the direction", "can you open the step by step",
 * "read me the directions", "what are the steps", "hide the steps". `read` asks for them aloud too. A request for a new
 * route ("directions to Changi", "steps to get to the zoo") isn't one: it goes on as a map request.
 */
export function stepsCommand(raw: string): { steps: boolean; read?: boolean } | null {
  let t = cleanCommand(raw).replace(/^(?:how about|what about|maybe|let's|lets|i want to|i'd like to|i wanna)\s+/, '');
  // "…for the direction(s)", "…on the map", "…to show the directions": about the route already shown.
  t = t.replace(/\s+(?:for|of|on|in|from)\s+(?:the|this|that|my)\s+(?:direction|directions|route|map|trip|journey|way|card)$/, '')
    .replace(/\s+(?:to|so (?:i|we) can)\s+(?:show|see|view|read|follow)\s+(?:the|my)\s+(?:direction|directions|route|way)$/, '').trim();
  if (/\b(?:to|towards|from)\s+(?!(?:the|this|my)\s+(?:direction|directions|route|steps)\b)(?!show\b|see\b|view\b|read\b|follow\b|get there\b)[a-z0-9]/.test(t) && !/\b(?:get|getting) there\b/.test(t)) return null;
  const words = '(?:the |those |these |all the |each )?(?:route |transit |travel |bus |train |mrt )?(?:steps?|step by step|step-by-step|turn by turn|turn-by-turn|directions?|instructions|breakdown|details|route details|way to go)(?: directions| instructions| list)?';
  if (new RegExp(`^(?:close|closing|hide|hiding|collapse|fold|put away)(?: up)? ${words}$`).test(t)) return { steps: false };
  if (new RegExp(`^(?:read|reading|say|tell me|tell|walk me through|talk me through|go through|run me through)(?: me| us)?(?: out)? ${words}(?: out| aloud| out loud)?$|^what (?:are|were) ${words}$|^how do (?:i|we) get there step by step$`).test(t)) return { steps: true, read: true };
  if (new RegExp(`^(?:open|opening|show|showing|see|view|display|expand|list|bring up|pull up|give me|give)(?: me| us)?(?: up)? ${words}$|^${words}$|^(?:can i|could i|let me) (?:see|view|have) ${words}$`).test(t)) return { steps: true };
  return null;
}

export function mapCommand(raw: string): { mode: Exclude<MapHow, 'place'> } | { close: true } | { steps: boolean; read?: boolean } | null {
  const t = cleanCommand(raw).replace(/^(?:how about|what about|maybe|let's|lets)\s+/, '');
  const st = stepsCommand(raw);
  if (st) return st;
  if (/^(?:close|hide|dismiss|put away)(?: (?:it|this|that|the map|the route|the directions|map))?$/.test(t)) return { close: true };
  for (const [mode, words] of MODE_WORDS) {
    const re = new RegExp(`^(?:(?:show me|switch to|change to|change it to|go|use|try|what about|how about|and|let's go|i'll go|i'll take|take|get there|make it|instead)\\s+)*(?:(?:by|on|with|via|using|in)\\s+)?(?:the |a )?(?:${words})(?:\\s+(?:instead|there|route|directions|it|then|way|mode))*$`);
    if (re.test(t)) return { mode };
  }
  return null;
}

/** Common names people say for countries, besides the names the browser knows. */
const COUNTRY_ALIASES: Record<string, string> = {
  korea: 'KR', 'south korea': 'KR', 'republic of korea': 'KR', usa: 'US', us: 'US', america: 'US', 'the us': 'US', 'the usa': 'US', 'the states': 'US', 'united states': 'US',
  uk: 'GB', 'the uk': 'GB', britain: 'GB', 'great britain': 'GB', england: 'GB', scotland: 'GB', wales: 'GB', china: 'CN', 'mainland china': 'CN', 'hong kong': 'HK', macau: 'MO', macao: 'MO',
  taiwan: 'TW', uae: 'AE', 'the uae': 'AE', dubai: 'AE', holland: 'NL', 'the netherlands': 'NL', turkey: 'TR', 'türkiye': 'TR', russia: 'RU', vietnam: 'VN', 'czech republic': 'CZ',
  'the philippines': 'PH', 'new zealand': 'NZ', singapore: 'SG', japan: 'JP',
};
let countryNames: Map<string, string> | null = null;
/** A country's two-letter code from what someone said ("Korea", "Japan", "the UK"), or null. */
export function countryFromName(raw: string): string | null {
  const t = raw.toLowerCase().replace(/[.,!?]/g, '').replace(/\s+/g, ' ').trim();
  if (COUNTRY_ALIASES[t]) return COUNTRY_ALIASES[t]!;
  if (!countryNames) {
    countryNames = new Map();
    try {
      const dn = new Intl.DisplayNames(['en'], { type: 'region' }), A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
      for (const a of A) for (const b of A) { const code = a + b, name = dn.of(code); if (name && name !== code && !/unknown/i.test(name) && !countryNames.has(name.toLowerCase())) countryNames.set(name.toLowerCase(), code); }
    } catch { /* names then come from the short list above only */ }
  }
  return countryNames.get(t) ?? countryNames.get(t.replace(/^the /, '')) ?? null;
}
/** "I'm in Korea", "switch to Japan's maps", "use worldwide": which country's map services to use. */
export function countryCommand(raw: string): 'ww' | string | null {
  const t = cleanCommand(raw);
  if (/^(?:(?:use|switch to|change to|go to|set it to|show)\s+)?(?:the\s+)?(?:worldwide|world wide|everywhere|global)(?:\s+(?:list|maps?|services|map services))?$/.test(t)) return 'ww';
  const m = /^(?:(?:i'm|i am|we're|we are)\s+(?:now\s+|currently\s+)?in|(?:i'm|i am)\s+(?:travelling|traveling)\s+in|(?:use|switch to|change to)\s+(?:the\s+)?(?:maps? (?:for|of|in))|(?:switch|change|set)\s+(?:the\s+)?(?:country|map country|region)\s+to)\s+(.{2,40})$/.exec(t);
  if (!m) return null;
  return countryFromName(m[1]!.replace(/\s+(?:now|today|right now|at the moment)$/, '').replace(/'s$/, ''));
}

/** "Full screen", "go full screen", "exit full screen", "back to normal". */
export function fullscreenCommand(raw: string): 'enter' | 'exit' | null {
  const t = cleanCommand(raw).replace(/full-screen|fullscreen/g, 'full screen');
  if (/^(?:exit|leave|close|turn off|stop|end|quit|get out of|come out of|switch off) (?:the )?full screen(?: mode)?$|^(?:go )?(?:back )?(?:to )?(?:normal|small|smaller|windowed)(?: screen| view| mode| size)?$/.test(t)) return 'exit';
  if (/^(?:(?:go|make it|make niko|switch to|turn on|enter|open|use|show|put it in|go into|can you go|can you make it|could you go)\s+)?(?:the )?full screen(?: mode)?$/.test(t)) return 'enter';
  return null;
}
