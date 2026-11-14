# Security notes

## What the code does

- **Passwords**: PBKDF2-SHA256, 100,000 rounds, per-user salt. Minimum 12 characters.
- **Sessions**: random 256-bit token in an `HttpOnly`, `Secure`, `SameSite=Lax`, `__Host-` cookie; only its SHA-256 hash is stored. App sessions last 30 days, admin sessions 8 hours.
- **Cross-site requests**: every state-changing API call must carry an `Origin` that matches the host. Webhooks and the OAuth return leg are exempt and authenticate by signature, secret or state instead.
- **Admin**: separate session cookie; password then a time-based code from an authenticator app. Admin routes refuse sessions that have not passed the second factor.
- **Invite only by default**: invites and reset links are single-use, stored hashed, and expire (7 days / 30 minutes). With open registration, new accounts stay switched off until an admin enables them.
- **Passkeys**: sign-in only, one per registrable domain (`sxingxian.com`, `midnightpoetry.studio`).
- **Attempt limits**: sign-in, admin sign-in, second-factor, invite, reset and setup attempts are limited per email and per IP.
- **Stored credentials**: connection tokens, API keys and second-factor secrets are encrypted with AES-256-GCM using `ENCRYPTION_KEY` before they reach Neon. Removing a connection deletes the row.
- **Sending**: the server, not the browser, enforces the rule. A voice-initiated send is refused unless the conversation already has an incoming message, and cannot be confirmed before its 10 seconds are up. A send is claimed atomically so it cannot go out twice.
- **Files**: relayed in request memory, 20 MB limit, never written to storage. The audit log records name, size, time and recipient only.
- **Outbound addresses** supplied by users (webhooks, custom AI) must be public `https` URLs; localhost and private ranges are refused.
- **AI prompt**: mail, events, notes and chats are passed to the model inside a block marked as untrusted, with an instruction not to follow anything inside it. The model has no ability to send; it can only draft.
- **Headers**: HSTS, a strict Content-Security-Policy (`script-src 'self'`), `frame-ancestors 'none'`, `nosniff`, and microphone limited to the same origin.

## Known gaps and risks

- **Not reviewed or penetration-tested.** Treat this as a first implementation.
- **Voice is not authentication.** "Respond only to my voice" is not built. Anyone within earshot can say "Niko, send it" for a reply in an existing conversation; the countdown is the only safeguard.
- **Prompt injection** from email or chat content is reduced, not eliminated. Niko never sends without your approval, which is the real control.
- **The repository is public.** No secrets are in it; keep it that way. Anyone can read how the service works.
- **Attempt limits are stored in Postgres** and are approximate under bursts. Add a Cloudflare rate-limiting rule on `/api/auth/*` and `/api/admin/*` for a firmer limit.
- **Telegram bots** see only messages people send to the bot. The Telegram file link is fetched with the bot token on demand; the token never reaches the browser.
- **Audit log and chat history** grow without pruning. Add retention if this runs for long.
- **PBKDF2 cost** is set by what a Worker can afford. If you move to a paid plan, raising the rounds is worthwhile.
