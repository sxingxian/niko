// Niko driving the browser: what the AI is shown of a page (an outline, never password or card values), the one action
// it may answer with, and the rules that decide when Niko must stop and ask, or hand over. The rules run on Niko's
// server after the AI answers, so nothing written on a page can talk Niko out of them.
import { hostBlocked, openableHost, siteOf } from './browser';

/** One thing on the page the AI can act on. `ref` is the page's own number for it (stable for this outline only). */
export interface PageElement {
  ref: number;
  /** a, button, input, select, textarea, or a role such as checkbox, link, button, tab, option. */
  kind: string;
  /** For inputs: text, email, tel, number, search, checkbox, radio, date…; password fields are 'password'. */
  type?: string;
  /** What it says or is labelled (visible text, label, aria-label, placeholder, alt), shortened. */
  name: string;
  /** What is typed in it now (never for password or card fields). */
  value?: string;
  checked?: boolean;
  disabled?: boolean;
  /** Where a link goes (host and path only). */
  href?: string;
  /** For a select: its choices, shortened. */
  options?: string[];
  /** A password field (type password, or a password autocomplete). Its value is never read. */
  password?: boolean;
  /** A card field (card number, expiry, security code, name on card). Its value is never read. */
  card?: boolean;
  /** For password and card fields: something is in it (its length only is known, never its value). */
  filled?: boolean;
  /** Sends its form (a submit button, or the only button of a form). */
  submit?: boolean;
  /** Inside the visible part of the page. */
  visible?: boolean;
}
export interface PageOutline {
  url: string;
  title: string;
  elements: PageElement[];
  /** Headings and visible text, shortened. Untrusted: written by the site. */
  text: string;
  /** What the page contains that Niko never handles itself. */
  frames: { captcha: boolean; payment: boolean };
}

export type BrowserActionKind = 'click' | 'type' | 'choose' | 'check' | 'scroll' | 'go' | 'wait' | 'done' | 'ask';
export interface BrowserAction { do: BrowserActionKind; ref?: number; text?: string; url?: string }
export type HandoffKind = 'password' | 'payment' | 'human';
export type GateKind = 'submit' | 'sign-in' | 'account' | 'terms' | 'download' | 'new-site';
export interface Gate { kind: GateKind; title: string; details: [string, string][]; site: string; /** Signed by the server: the person's OK for exactly this action, once. */ token?: string }
export interface StepAnswer {
  say: string;
  action: BrowserAction | null;
  /** Niko's turn ends here: the person does this part. */
  handoff: { kind: HandoffKind; ref?: number } | null;
  /** Niko waits for the person's OK before doing the action. */
  gate: Gate | null;
  /** The page tried to give Niko instructions; they were ignored. */
  ignored: boolean;
  done: boolean;
}

const MAX_ELEMENTS = 160, MAX_TEXT = 3500, MAX_NAME = 120, MAX_VALUE = 120;
const str = (v: unknown, n: number) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, n) : '');

/** An outline as the server keeps it: lengths capped, password and card values dropped whatever the device sent. */
export function cleanOutline(v: unknown): PageOutline | null {
  const o = (v && typeof v === 'object' ? v : null) as Record<string, any> | null;
  if (!o) return null;
  const url = str(o.url, 2000);
  const elements: PageElement[] = [];
  for (const e of Array.isArray(o.elements) ? o.elements.slice(0, MAX_ELEMENTS) : []) {
    if (!e || typeof e !== 'object' || !Number.isInteger(e.ref) || e.ref < 0 || e.ref > 100_000) continue;
    const type = str(e.type, 20).toLowerCase() || undefined;
    const password = !!e.password || type === 'password';
    const card = !!e.card;
    const el: PageElement = { ref: e.ref, kind: str(e.kind, 20).toLowerCase() || 'element', name: str(e.name, MAX_NAME) };
    if (type) el.type = type;
    if (!password && !card && typeof e.value === 'string' && e.value) el.value = str(e.value, MAX_VALUE);
    if (typeof e.checked === 'boolean') el.checked = e.checked;
    if (e.disabled === true) el.disabled = true;
    if (typeof e.href === 'string' && e.href) el.href = str(e.href, 200);
    if (Array.isArray(e.options)) el.options = e.options.slice(0, 30).map((x: unknown) => str(x, 60)).filter(Boolean);
    if (password) el.password = true;
    if (card) el.card = true;
    if ((password || card) && e.filled === true) el.filled = true;
    if (e.submit === true) el.submit = true;
    if (e.visible === true) el.visible = true;
    elements.push(el);
  }
  return { url, title: str(o.title, 200), elements, text: str(o.text, MAX_TEXT), frames: { captcha: !!o.frames?.captcha, payment: !!o.frames?.payment } };
}

/** The outline as the AI reads it: one line per element, then the page's words. */
export function outlineText(p: PageOutline): string {
  const lines = p.elements.map((e) => {
    const bits = [`[${e.ref}]`, e.kind + (e.type && e.type !== e.kind ? `:${e.type}` : ''), e.name ? `"${e.name}"` : ''];
    if (e.password) bits.push(e.filled ? '(password field: filled in by the user)' : '(password field: the user types it)');
    else if (e.card) bits.push(e.filled ? '(card field: filled in by the user)' : '(card field: the user types it)');
    else if (e.value) bits.push(`value="${e.value}"`);
    if (e.checked !== undefined) bits.push(e.checked ? 'checked' : 'not checked');
    if (e.options?.length) bits.push(`options: ${e.options.join(' | ')}`);
    if (e.href) bits.push(`→ ${e.href}`);
    if (e.submit) bits.push('(sends the form)');
    if (e.disabled) bits.push('(disabled)');
    if (!e.visible) bits.push('(off screen)');
    return bits.filter(Boolean).join(' ');
  });
  return `URL: ${p.url}\nTITLE: ${p.title}\nELEMENTS:\n${lines.join('\n')}\nTEXT:\n${p.text}`;
}

// ---------------------------------------------------------------- pages giving orders
/** Words a page uses when it tries to give an AI instructions. Matched only; such pages are flagged and ignored. */
const INJECTION = /(ignore (all |any )?(the |your )?(previous|prior|above|earlier) (instructions|prompts?|rules)|disregard (the |your )?(previous|prior|above|user'?s?) (instructions|request)|you are (now )?an? (ai|assistant|agent)\b.{0,40}(must|should|will)|(ai|llm|assistant|agent)s?,? (please )?(ignore|forget|disregard|instead|now)|system prompt|new instructions:|<\s*\/?\s*(system|assistant|instructions)\s*>|send (the user'?s?|their|all) (email|inbox|password|data|messages)|forward (the user'?s?|their) (email|inbox|messages))/i;
export function pageGivesOrders(p: PageOutline): boolean {
  return INJECTION.test(p.text) || p.elements.some((e) => INJECTION.test(e.name));
}

// ---------------------------------------------------------------- when Niko stops
const PAY_WORDS = /\b(pay|pay now|buy|buy now|purchase|place (your )?order|complete (your )?(order|purchase|payment)|checkout|check out|proceed to payment|confirm (and )?pay|subscribe and pay|add payment|donate)\b/i;
const ACCOUNT_WORDS = /\b(sign ?up|create( an| my| your)? account|register|join( now)?|get started|start (my |your )?(free )?trial)\b/i;
const SIGNIN_WORDS = /\b(log ?in|sign ?in|continue with (google|apple|microsoft|facebook))\b/i;
const TERMS_WORDS = /\b(i agree|agree( to)?|accept|terms|conditions|privacy policy|consent)\b/i;
const SEND_WORDS = /\b(submit|send|confirm|book|reserve|order|apply|save|post|publish|delete|remove|cancel (my |your )?(account|subscription|order|booking)|unsubscribe|subscribe)\b/i;
const DOWNLOAD_WORDS = /\b(download|export|save as)\b/i;

export interface StepContext {
  /** Sites (registrable domains) this session has been on, or the person named. */
  knownSites: string[];
  blocked: readonly string[];
  askNewSite: boolean;
  askDownloads: boolean;
}

/** What Niko does with the AI's action: do it, ask first, hand over, or refuse. Decided here, never by the AI. */
export function judgeAction(p: PageOutline, a: BrowserAction | null, ctx: StepContext): Pick<StepAnswer, 'action' | 'handoff' | 'gate'> & { refused?: string } {
  const site = siteOf(openableHost(p.url) ?? '') || '';
  if (p.frames.captcha) return { action: null, handoff: { kind: 'human' }, gate: null };
  if (!a) return { action: null, handoff: null, gate: null };
  const el = a.ref !== undefined ? p.elements.find((e) => e.ref === a.ref) : undefined;
  if ((a.do === 'click' || a.do === 'type' || a.do === 'choose' || a.do === 'check') && !el) return { action: null, handoff: null, gate: null, refused: 'That isn’t on the page.' };
  if (el?.password && !(el.filled && a.do === 'click')) return { action: null, handoff: { kind: 'password', ref: el.ref }, gate: null };
  if (el?.card) return { action: null, handoff: { kind: 'payment', ref: el.ref }, gate: null };
  const label = el ? `${el.name} ${el.value ?? ''}` : '';
  if (el && (a.do === 'click' || a.do === 'check') && (PAY_WORDS.test(label) || (p.frames.payment && el.submit))) return { action: null, handoff: { kind: 'payment', ref: el.ref }, gate: null };
  if (a.do === 'go') {
    const host = openableHost(a.url ?? '');
    if (!host) return { action: null, handoff: null, gate: null, refused: 'That isn’t a website Niko can open.' };
    if (hostBlocked(host, ctx.blocked)) return { action: null, handoff: null, gate: null, refused: 'Niko can’t open this site.' };
    const there = siteOf(host);
    if (ctx.askNewSite && !ctx.knownSites.includes(there)) return { action: a, handoff: null, gate: { kind: 'new-site', title: `Go to ${there}?`, details: [['Site', there], ['Address', (a.url ?? '').slice(0, 120)]], site: there } };
    return { action: a, handoff: null, gate: null };
  }
  if (el && (a.do === 'click' || a.do === 'check')) {
    const fields = p.elements.filter((e) => (e.kind === 'input' || e.kind === 'textarea' || e.kind === 'select') && !e.password && !e.card && e.value && e.type !== 'hidden' && e.type !== 'search').slice(0, 6)
      .map((e): [string, string] => [e.name || e.type || 'Field', e.value!]);
    const pwFilled = p.elements.some((e) => e.password);
    if (a.do === 'check' || el.type === 'checkbox' || el.kind === 'checkbox') {
      if (TERMS_WORDS.test(label) && !el.checked) return { action: a, handoff: null, gate: { kind: 'terms', title: `Agree to ${site}’s terms?`, details: [['Agreeing to', el.name || 'their terms']], site } };
      return { action: a, handoff: null, gate: null };
    }
    if (DOWNLOAD_WORDS.test(label) && ctx.askDownloads) return { action: a, handoff: null, gate: { kind: 'download', title: `Download from ${site}?`, details: [['File', el.name || 'A file'], ['Goes to', 'This device only']], site } };
    if (ACCOUNT_WORDS.test(label) && (el.submit || fields.length)) return { action: a, handoff: null, gate: { kind: 'account', title: `Create your ${site} account?`, details: fields, site } };
    if (SIGNIN_WORDS.test(label) && (el.submit || pwFilled)) return { action: a, handoff: null, gate: { kind: 'sign-in', title: `Sign in to ${site}?`, details: fields, site } };
    if (el.submit && (fields.length || SEND_WORDS.test(label) || TERMS_WORDS.test(label))) return { action: a, handoff: null, gate: { kind: 'submit', title: `Send this to ${site}?`, details: fields.length ? fields : [['Button', el.name || 'Send']], site } };
    if (SEND_WORDS.test(label) && /\b(delete|remove|cancel|unsubscribe|book|reserve|order|apply|post|publish)\b/i.test(label)) return { action: a, handoff: null, gate: { kind: 'submit', title: `${el.name.slice(0, 60)} on ${site}?`, details: [['Button', el.name]], site } };
  }
  if (a.do === 'type' && el && !(el.kind === 'input' || el.kind === 'textarea' || el.kind === 'textbox' || el.kind === 'combobox' || el.kind === 'searchbox')) return { action: null, handoff: null, gate: null, refused: 'Niko can only type into a text box.' };
  return { action: a, handoff: null, gate: null };
}

/** Reads the AI's answer: a JSON object with say and action, possibly wrapped in other words or a code block. */
export function parseStep(reply: string): { say: string; action: BrowserAction | null } {
  const m = /\{[\s\S]*\}/.exec(reply);
  let j: any = null;
  if (m) { try { j = JSON.parse(m[0]); } catch { j = null; } }
  if (!j || typeof j !== 'object') return { say: str(reply.replace(/```[\s\S]*?```/g, ''), 240) || 'I’m not sure what to do next here.', action: { do: 'ask' } };
  const a = (j.action && typeof j.action === 'object' ? j.action : j) as Record<string, unknown>;
  const kinds: BrowserActionKind[] = ['click', 'type', 'choose', 'check', 'scroll', 'go', 'wait', 'done', 'ask'];
  const kind = kinds.includes(String(a.do ?? a.type ?? '').toLowerCase() as BrowserActionKind) ? String(a.do ?? a.type).toLowerCase() as BrowserActionKind : 'ask';
  const ref = Number.isInteger(Number(a.ref)) && a.ref !== null && a.ref !== '' ? Number(a.ref) : undefined;
  const action: BrowserAction = { do: kind, ...(ref !== undefined ? { ref } : {}), ...(typeof a.text === 'string' ? { text: a.text.slice(0, 500) } : {}), ...(typeof a.url === 'string' ? { url: a.url.slice(0, 2000) } : {}) };
  return { say: str(j.say, 240), action };
}
