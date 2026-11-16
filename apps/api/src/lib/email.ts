import type { Env } from '../env';

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);

function layout(heading: string, body: string, button?: { label: string; url: string }, extra = ''): string {
  const btn = button
    ? `<p style="margin:28px 0"><a href="${esc(button.url)}" style="background:#ffffff;color:#05070d;text-decoration:none;font-weight:600;padding:14px 26px;border-radius:999px;display:inline-block">${esc(button.label)}</a></p>`
    : '';
  return `<div style="background:#05070d;color:#ffffff;font-family:system-ui,sans-serif;padding:40px 28px"><div style="max-width:480px;margin:0 auto">
<p style="letter-spacing:.32em;font-weight:600;font-size:14px;margin:0 0 28px">NIKO</p>
<h1 style="font-size:26px;font-weight:500;margin:0 0 14px">${esc(heading)}</h1>
<p style="color:#c3cad6;line-height:1.5;margin:0">${body}</p>${extra}${btn}
<p style="color:#8f98a8;font-size:13px;line-height:1.5;margin:0">If you were not expecting this, you can ignore it.</p></div></div>`;
}

/** `extra` is HTML placed under the text; build it with the helpers below so everything in it is escaped. */
export async function sendEmail(env: Env, to: string, subject: string, heading: string, body: string, button?: { label: string; url: string }, extra?: string): Promise<boolean> {
  if (!env.RESEND_API_KEY) {
    console.warn('RESEND_API_KEY is not set; email not sent:', subject);
    return false;
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ from: env.EMAIL_FROM, to: [to], subject, html: layout(heading, body, button, extra) }),
  });
  if (!res.ok) console.error('Resend error', res.status, await res.text());
  return res.ok;
}

/** A code shown large in a dashed box, e.g. an invite code. */
export function codeBlock(label: string, code: string): string {
  return `<div style="margin:24px 0 0;padding:20px;border:1px dashed rgba(255,255,255,.4);border-radius:18px;text-align:center">
<p style="margin:0 0 8px;font:500 12px monospace;letter-spacing:.14em;text-transform:uppercase;color:#b9c2cf">${esc(label)}</p>
<p style="margin:0;font:500 34px monospace;letter-spacing:.3em">${esc(code)}</p></div>`;
}
/** Label and value rows in a box, e.g. a price. */
export function rowsBlock(rows: [string, string][]): string {
  return `<table role="presentation" style="margin:16px 0 0;width:100%;border-collapse:collapse;border:1px solid rgba(127,227,255,.3);border-radius:16px">${rows.map(([a, b], i) =>
    `<tr><td style="padding:12px 16px;color:#c3cad6;${i ? 'border-top:1px solid rgba(127,227,255,.2);' : ''}">${esc(a)}</td><td style="padding:12px 16px;text-align:right;font-weight:600;${i ? 'border-top:1px solid rgba(127,227,255,.2);' : ''}">${esc(b)}</td></tr>`).join('')}</table>`;
}

export { esc };
