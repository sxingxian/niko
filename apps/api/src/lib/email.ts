import type { Env } from '../env';

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);

function layout(heading: string, body: string, button?: { label: string; url: string }): string {
  const btn = button
    ? `<p style="margin:28px 0"><a href="${esc(button.url)}" style="background:#ffffff;color:#05070d;text-decoration:none;font-weight:600;padding:14px 26px;border-radius:999px;display:inline-block">${esc(button.label)}</a></p>`
    : '';
  return `<div style="background:#05070d;color:#ffffff;font-family:system-ui,sans-serif;padding:40px 28px"><div style="max-width:480px;margin:0 auto">
<p style="letter-spacing:.32em;font-weight:600;font-size:14px;margin:0 0 28px">NIKO</p>
<h1 style="font-size:26px;font-weight:500;margin:0 0 14px">${esc(heading)}</h1>
<p style="color:#c3cad6;line-height:1.5;margin:0">${body}</p>${btn}
<p style="color:#8f98a8;font-size:13px;line-height:1.5;margin:0">If you were not expecting this, you can ignore it.</p></div></div>`;
}

export async function sendEmail(env: Env, to: string, subject: string, heading: string, body: string, button?: { label: string; url: string }): Promise<boolean> {
  if (!env.RESEND_API_KEY) {
    console.warn('RESEND_API_KEY is not set; email not sent:', subject);
    return false;
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ from: env.EMAIL_FROM, to: [to], subject, html: layout(heading, body, button) }),
  });
  if (!res.ok) console.error('Resend error', res.status, await res.text());
  return res.ok;
}

export { esc };
