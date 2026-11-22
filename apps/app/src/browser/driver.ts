// Niko driving the browser: read the page, ask Niko's server for one action, do it, and again, until the task is done
// or the person is needed. The server decides when Niko must stop (passwords, payments, "are you human?", sending a
// form, agreeing to terms); this side only carries out what the server allows.
import { api, ApiError, settle } from '@niko/ui';
import { hostBlocked, openableHost, siteOf, type BrowserAction, type Gate, type PageOutline, type StepAnswer } from '@niko/shared';
import type { BrowserSession } from './session';
import { chooseIn, focusOf, OUTLINE_JS, pointOf } from './outline';

export interface DriverHooks {
  /** Niko says this (spoken, and on the status line). */
  say: (text: string) => void;
  /** Niko's working line ("Filling in your email…") without speaking. */
  status: (line: string) => void;
}
const MAX_STEPS = 40;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Driver {
  private task = '';
  private history: { say: string; did: string }[] = [];
  private visited = new Set<string>();
  private runId = 0;
  private note = '';

  constructor(private readonly s: BrowserSession, private readonly hooks: DriverHooks) {}

  get running(): boolean { return this.s.view.driver === 'niko'; }
  get currentTask(): string { return this.task; }

  /** Starts (or restarts) Niko on a task. */
  start(task: string, note = '') {
    this.task = task.trim();
    this.note = note;
    if (!this.task) return;
    const id = ++this.runId;
    this.s.setNeed(null);
    this.s.keepBrowsing();
    this.s.setDriver('niko');
    void this.loop(id);
  }
  /** Carries on after the person did their part, or answered Niko's question. */
  resume(note = '') { if (this.task) this.start(this.task, note); }
  /** Stops Niko: the person drives. */
  stop() { this.runId++; this.s.setCursor(null); this.s.setDriver('you'); }

  /** The page as an outline (password and card values are never read). */
  async outline(): Promise<PageOutline | null> {
    const cdp = this.s.connection;
    if (!cdp) return null;
    const r = await cdp.send<{ result?: { value?: PageOutline } }>('Runtime.evaluate', { expression: OUTLINE_JS, returnByValue: true }).catch(() => null);
    return r?.result?.value ?? null;
  }

  private async loop(id: number) {
    for (let n = 0; n < MAX_STEPS; n++) {
      if (id !== this.runId) return;
      const cdp = this.s.connection;
      if (!cdp || this.s.view.phase !== 'live') { await sleep(800); continue; }
      const page = await this.outline();
      if (id !== this.runId) return;
      if (!page) { await sleep(800); continue; }
      const host = openableHost(page.url);
      if (host) this.visited.add(host);
      this.hooks.status(n === 0 ? 'Reading the page…' : 'Thinking…');
      let step: StepAnswer;
      try {
        step = await api<StepAnswer>(`/browser/${this.s.view.id}/step`, { body: { task: this.task, outline: page, history: this.history, note: this.note, visited: [...this.visited] } });
      } catch (e) {
        if (id !== this.runId) return;
        this.stop();
        this.hooks.say(e instanceof ApiError ? e.message : 'I lost the connection, so I stopped. You can carry on yourself.');
        return;
      }
      this.note = '';
      if (id !== this.runId) return;
      if (step.ignored) this.s.flagIgnored();
      if (step.done) { this.s.setCursor(null); this.s.setDriver('you'); this.task = ''; this.s.finish(siteOf(host ?? '')); this.hooks.say(step.say); return; }
      if (step.handoff) {
        this.s.setCursor(null);
        // Their part is lit up on the page (the field is focused for them; Niko never reads what they type).
        const rect = step.handoff.ref !== undefined ? await this.rectOf(step.handoff.ref) : null;
        // A sign-in code: Niko looks in the Inbox (mail from this site in the last 10 minutes) and asks before entering it.
        if (step.handoff.kind === 'code' && step.handoff.ref !== undefined && this.s.inboxCodes) {
          this.hooks.status('Looking for the code in your Inbox…');
          const found = await api<{ code: string | null; from?: string }>(`/browser/${this.s.view.id}/code`, { body: { site: siteOf(host ?? '') } }).catch(() => ({ code: null }));
          if (id !== this.runId) return;
          if (found.code) {
            this.s.setNeed({ kind: 'code', code: found.code, from: found.from ?? '', ref: step.handoff.ref, site: siteOf(host ?? ''), ...(rect ? { rect } : {}) });
            this.s.setDriver('you');
            this.hooks.say('I found the code in your Inbox. Shall I enter it?');
            return;
          }
        }
        if ((step.handoff.kind === 'password' || step.handoff.kind === 'code') && step.handoff.ref !== undefined) await cdp.send('Runtime.evaluate', { expression: focusOf(step.handoff.ref) }).catch(() => undefined);
        this.s.setNeed({ kind: 'handoff', handoff: step.handoff.kind, ref: step.handoff.ref, say: step.say, site: siteOf(host ?? ''), ...(rect ? { rect } : {}) });
        this.s.setDriver('you');
        this.hooks.say(step.say);
        return;
      }
      if (step.gate && step.action) {
        this.s.setNeed({ kind: 'gate', gate: step.gate, action: step.action, say: step.say });
        this.s.setDriver('you');
        this.hooks.say(step.say || step.gate.title);
        return;
      }
      if (!step.action || step.action.do === 'ask') {
        this.s.setCursor(null);
        this.s.setNeed({ kind: 'ask', say: step.say });
        this.s.setDriver('you');
        this.hooks.say(step.say);
        return;
      }
      if (step.say) this.hooks.status(step.say);
      const did = await this.act(step.action);
      this.history.push({ say: step.say, did });
      if (this.history.length > 12) this.history.shift();
    }
    if (id === this.runId) { this.stop(); this.hooks.say('That’s taking more steps than expected, so I stopped. You can carry on, or tell me what to do next.'); }
  }

  /** Where an element is on the page (scrolled into view), for lighting it up. */
  private async rectOf(ref: number): Promise<{ x: number; y: number; w: number; h: number } | null> {
    const cdp = this.s.connection;
    if (!cdp) return null;
    const r = await cdp.send<{ result?: { value?: { x: number; y: number; w: number; h: number } | null } }>('Runtime.evaluate', { expression: pointOf(ref), returnByValue: true }).catch(() => null);
    const p = r?.result?.value;
    return p ? { x: p.x - p.w / 2, y: p.y - p.h / 2, w: p.w, h: p.h } : null;
  }

  /** Moves Niko's cursor to an element (and returns where it is). */
  private async point(ref: number, animate = true): Promise<{ x: number; y: number } | null> {
    const cdp = this.s.connection;
    if (!cdp) return null;
    const r = await cdp.send<{ result?: { value?: { x: number; y: number } | null } }>('Runtime.evaluate', { expression: pointOf(ref), returnByValue: true }).catch(() => null);
    const p = r?.result?.value ?? null;
    if (p) { this.s.setCursor(p); if (animate) await sleep(450); }
    return p;
  }

  private async click(p: { x: number; y: number }) {
    const cdp = this.s.connection!;
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', buttons: 1, clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', buttons: 0, clickCount: 1 });
  }

  /** Does one action the server allowed. Returns a few words for the history. */
  async act(a: BrowserAction): Promise<string> {
    const cdp = this.s.connection;
    if (!cdp) return 'no page';
    try {
      if (a.do === 'click' || a.do === 'check') {
        const p = a.ref !== undefined ? await this.point(a.ref) : null;
        if (!p) return 'element gone';
        await this.click(p);
        await this.afterAction(true);
        return `${a.do}ed [${a.ref}]`;
      }
      if (a.do === 'type') {
        const p = a.ref !== undefined ? await this.point(a.ref) : null;
        if (!p) return 'element gone';
        await this.click(p);
        await cdp.send('Runtime.evaluate', { expression: focusOf(a.ref!) });
        const text = a.text ?? '';
        // Typed a few letters at a time, so the person can follow it.
        for (let i = 0; i < text.length; i += 3) { await cdp.send('Input.insertText', { text: text.slice(i, i + 3) }); await sleep(35); }
        if (!text) await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 }).then(() => cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 }));
        await this.afterAction(false);
        return `typed into [${a.ref}]`;
      }
      if (a.do === 'choose') {
        const p = a.ref !== undefined ? await this.point(a.ref) : null;
        if (!p) return 'element gone';
        const ok = await cdp.send<{ result?: { value?: boolean } }>('Runtime.evaluate', { expression: chooseIn(a.ref!, a.text ?? ''), returnByValue: true });
        if (!ok.result?.value) { await this.click(p); }
        await this.afterAction(false);
        return `chose "${(a.text ?? '').slice(0, 40)}" in [${a.ref}]`;
      }
      if (a.do === 'scroll') {
        if (a.ref !== undefined) await this.point(a.ref);
        else await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 200, y: 200, deltaX: 0, deltaY: 600 });
        await sleep(500);
        return 'scrolled';
      }
      if (a.do === 'go') {
        const host = openableHost(a.url ?? '');
        if (!host || hostBlocked(host, this.s.blocked)) return 'address refused';
        this.s.setCursor(null);
        await cdp.send('Page.navigate', { url: a.url });
        await this.afterAction(true);
        return `went to ${host}`;
      }
      if (a.do === 'wait') { await sleep(1500); return 'waited'; }
    } catch { return 'failed'; }
    return 'nothing';
  }

  /** Lets the page react: a page load (up to a few seconds) after a click, a short pause after typing. */
  private async afterAction(mayNavigate: boolean) {
    const cdp = this.s.connection;
    if (!cdp) return;
    if (!mayNavigate) { await sleep(300); return; }
    await sleep(500);
    await settle(cdp, 5000).catch(() => undefined);
    await sleep(300);
  }

  /** The person said OK to an action Niko was holding: the server checks the OK (once, for exactly this action), then
   * Niko does it and carries on. */
  async approve(a: BrowserAction, gate: Gate) {
    try { await api(`/browser/${this.s.view.id}/ok`, { body: { token: gate.token, action: a, kind: gate.kind, title: gate.title, site: gate.site, allow: true } }); }
    catch (e) { this.s.setNeed(null); this.stop(); this.hooks.say(e instanceof ApiError ? e.message : 'That didn’t go through. Ask me again.'); return; }
    this.s.setNeed(null);
    this.s.setDriver('niko');
    const did = await this.act(a);
    this.history.push({ say: 'The user said OK', did });
    this.resume();
  }

  /** "Enter code": types the code from the Inbox into its field, then carries on. The code isn't kept anywhere. */
  async enterCode(ref: number, code: string) {
    const cdp = this.s.connection;
    this.s.setNeed(null);
    if (!cdp) return;
    this.s.setDriver('niko');
    const p = await this.point(ref);
    if (p) { await this.click(p); await cdp.send('Runtime.evaluate', { expression: focusOf(ref) }).catch(() => undefined); await cdp.send('Input.insertText', { text: code }).catch(() => undefined); }
    this.history.push({ say: 'Entered the sign-in code from the Inbox', did: `typed the code into [${ref}]` });
    this.resume();
  }
  /** "I'll type it": the code field is the person's. */
  async typeCodeYourself(ref: number, site: string, rect?: { x: number; y: number; w: number; h: number }) {
    await this.s.connection?.send('Runtime.evaluate', { expression: focusOf(ref) }).catch(() => undefined);
    this.s.setNeed({ kind: 'handoff', handoff: 'code', ref, say: '', site, ...(rect ? { rect } : {}) });
  }

  /** "Not now": Niko stops; the choice is kept in "What Niko did". */
  decline(gate: Gate) {
    void api(`/browser/${this.s.view.id}/ok`, { body: { kind: gate.kind, title: gate.title, site: gate.site, allow: false } }).catch(() => undefined);
    this.s.setNeed(null);
    this.stop();
    this.task = '';
  }

  /** "Ask about this page": an answer from the page, or a task to start. */
  async ask(question: string): Promise<{ say?: string; task?: string } | null> {
    const page = await this.outline();
    if (!page || !this.s.view.id) return null;
    const r = await api<{ say?: string; task?: string; ignored?: boolean }>(`/browser/${this.s.view.id}/ask`, { body: { question, outline: page } });
    if (r.ignored) this.s.flagIgnored();
    return r;
  }
}
