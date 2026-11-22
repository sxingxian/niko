// The page as Niko reads it: run inside the page (Runtime.evaluate) to list what can be clicked, typed into or chosen,
// and the visible words. Password and card fields are listed without their values, which are never read.
// Each element gets a number (ref); the page keeps the list in window.__nikoEls so Niko can act on the same element.
export const OUTLINE_JS = `(() => {
  const MAX = 160;
  const vw = innerWidth, vh = innerHeight;
  const clip = (s, n) => (s || '').replace(/\\s+/g, ' ').trim().slice(0, n);
  const shown = (el) => { const r = el.getBoundingClientRect(); if (r.width < 2 || r.height < 2) return false; const s = getComputedStyle(el); return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.05; };
  const inView = (el) => { const r = el.getBoundingClientRect(); return r.bottom > 0 && r.right > 0 && r.top < vh && r.left < vw; };
  const labelOf = (el) => {
    const aria = el.getAttribute('aria-label'); if (aria) return aria;
    const by = el.getAttribute('aria-labelledby'); if (by) { const t = by.split(/\\s+/).map((id) => document.getElementById(id)?.innerText || '').join(' '); if (t.trim()) return t; }
    if (el.id) { const l = document.querySelector('label[for="' + CSS.escape(el.id) + '"]'); if (l && l.innerText.trim()) return l.innerText; }
    const wrap = el.closest('label'); if (wrap && wrap.innerText.trim()) return wrap.innerText;
    return el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('alt') || el.getAttribute('name') || '';
  };
  const CARD = /(cc-|card.?num|cardnumber|cc.?num|credit|debit|cvc|cvv|csc|security.?code|expir|exp.?date|exp.?month|exp.?year|name.?on.?card)/i;
  const PW = /(current-password|new-password|one-time-code)/i;
  const els = [];
  const seen = new Set();
  const pick = 'a[href], button, input, select, textarea, [role=button], [role=link], [role=checkbox], [role=radio], [role=tab], [role=option], [role=menuitem], [role=switch], [role=combobox], [role=textbox], [contenteditable=true], summary';
  for (const el of document.querySelectorAll(pick)) {
    if (els.length >= MAX * 2) break;
    if (seen.has(el)) continue; seen.add(el);
    const type = (el.getAttribute('type') || '').toLowerCase();
    if (type === 'hidden' || !shown(el)) continue;
    els.push(el);
  }
  els.sort((a, b) => (inView(b) ? 1 : 0) - (inView(a) ? 1 : 0));
  const out = [];
  window.__nikoEls = [];
  for (const el of els.slice(0, MAX)) {
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute('role');
    const type = (el.getAttribute('type') || '').toLowerCase();
    const auto = el.getAttribute('autocomplete') || '';
    const hint = [el.name, el.id, auto, el.getAttribute('placeholder'), labelOf(el)].join(' ');
    const password = type === 'password' || PW.test(auto);
    const card = !password && (tag === 'input' || tag === 'select') && CARD.test(hint);
    const ref = window.__nikoEls.length; window.__nikoEls.push(el);
    const kind = role || (tag === 'input' ? (type === 'checkbox' || type === 'radio' ? type : 'input') : tag);
    const e = { ref, kind, name: clip(tag === 'input' || tag === 'textarea' || tag === 'select' ? labelOf(el) : (el.innerText || labelOf(el)), 120), visible: inView(el) };
    if (tag === 'input') e.type = type || 'text';
    if (password) e.password = true;
    if (card) e.card = true;
    if ((password || card) && el.value && el.value.length > 0) e.filled = true;
    if (!password && !card && (tag === 'input' || tag === 'textarea') && type !== 'checkbox' && type !== 'radio' && el.value) e.value = clip(el.value, 120);
    if (tag === 'select') { e.options = Array.from(el.options).slice(0, 30).map((o) => clip(o.text, 60)); if (!card) e.value = clip(el.options[el.selectedIndex]?.text || '', 60); }
    if (type === 'checkbox' || type === 'radio' || role === 'checkbox' || role === 'radio' || role === 'switch') e.checked = el.checked ?? el.getAttribute('aria-checked') === 'true';
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') e.disabled = true;
    if (tag === 'a') { try { const u = new URL(el.href); e.href = (u.host + u.pathname).slice(0, 200); } catch (_) {} }
    const form = el.form || el.closest('form');
    if ((tag === 'button' && (type === 'submit' || (!type && form))) || (tag === 'input' && (type === 'submit' || type === 'image'))) e.submit = true;
    out.push(e);
  }
  const words = [];
  for (const h of document.querySelectorAll('h1, h2, h3, h4, p, li, label, td, th, [role=alert], [role=status], .error, .alert')) {
    if (words.join(' ').length > 3500) break;
    if (!shown(h)) continue;
    if (h.closest('input, textarea, select, script, style')) continue;
    const t = clip(h.innerText, 300);
    if (t && !words.includes(t)) words.push(t);
  }
  const frames = Array.from(document.querySelectorAll('iframe')).map((f) => f.src || '');
  const captcha = frames.some((s) => /recaptcha|hcaptcha|challenges\\.cloudflare\\.com|turnstile|arkoselabs|funcaptcha|captcha/i.test(s)) || !!document.querySelector('.g-recaptcha, .h-captcha, .cf-turnstile, [data-sitekey]');
  const payment = frames.some((s) => /js\\.stripe\\.com|checkout\\.stripe\\.com|paypal\\.com|braintreegateway|adyen|checkout\\.com|squareup|klarna|afterpay|2checkout|worldpay/i.test(s));
  return { url: location.href, title: document.title, elements: out, text: words.join('\\n').slice(0, 3500), frames: { captcha, payment } };
})()`;

/** Where an element is on screen, scrolled into view first (page pixels), or null when it's gone. */
export const pointOf = (ref: number) => `(() => { const el = (window.__nikoEls || [])[${ref}]; if (!el || !el.isConnected) return null; el.scrollIntoView({ block: 'center', inline: 'center' }); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height }; })()`;
/** Focuses a text box and selects what's in it, so typing replaces it. */
export const focusOf = (ref: number) => `(() => { const el = (window.__nikoEls || [])[${ref}]; if (!el) return false; el.focus(); if (el.select) el.select(); else if (el.isContentEditable) { const r = document.createRange(); r.selectNodeContents(el); const s = getSelection(); s.removeAllRanges(); s.addRange(r); } return true; })()`;
/** Picks a choice in a select by its words (the closest match). */
export const chooseIn = (ref: number, text: string) => `(() => { const el = (window.__nikoEls || [])[${ref}]; if (!el || el.tagName !== 'SELECT') return false; const want = ${JSON.stringify(text.toLowerCase())}; const opts = Array.from(el.options); const o = opts.find((x) => x.text.trim().toLowerCase() === want) || opts.find((x) => x.text.toLowerCase().includes(want)) || opts.find((x) => x.value.toLowerCase() === want); if (!o) return false; el.value = o.value; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`;
