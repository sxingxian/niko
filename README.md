# Niko

A voice assistant across your mail, calendars, notes and chat apps. One Cloudflare Worker serves everything on two domains:

| | sxingxian.com | midnightpoetry.studio |
|---|---|---|
| Landing | `niko.sxingxian.com` | `niko.midnightpoetry.studio` |
| Admin | `niko.sxingxian.com/admin` | `niko.midnightpoetry.studio/admin` |
| App | `niko.sxingxian.com/app` | `nikoapp.midnightpoetry.studio` |

Both domains share one Neon database, so an account works on either. Sessions and passkeys are per domain.

**Start with [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).** Security notes are in [docs/SECURITY.md](docs/SECURITY.md).

## Layout

```
apps/api       Cloudflare Worker (Hono): API, host/path routing, static assets
apps/landing   Landing page: scroll-animated particles (vanilla TS + Lenis)
apps/app       The app (React): home core, workspace, connections, engine, appearance, account, auth screens
apps/admin     Admin portal (React): sign-in with second factor, users, registration, audit log
packages/db    Drizzle schema + SQL migration for Neon
packages/shared  Provider list, types, validation
packages/ui    Niko styles, particle core, shared components
```

## Stack (free tiers)

Cloudflare Workers + Static Assets + Workers AI · Neon Postgres · Resend · browser speech recognition and speech synthesis · Workers AI and on-device (Kokoro) voices · optional voice server, ElevenLabs and your own AI key.

## Status: what works, what is untested, what is not built

Nothing here has run against live services yet. The code typechecks, all three front ends build, the Worker bundles, and the password/TOTP/encryption helpers and the host routing were tested locally. Everything that touches Neon, Resend, Workers AI or a provider API is **untested until you deploy**.

| Area | State |
|---|---|
| Landing, sign-in, invite, sign-up, forgot/reset password | Built |
| Passkeys (sign-in only; added from Account) | Built |
| Admin: second factor (authenticator app), users on/off, invites, registration switch, audit log | Built |
| Per-account provider app keys (Google, Microsoft, Notion, Slack), no server-wide keys | Built; not yet run against the providers |
| Database updates applied automatically on deploy (`npm run migrate`) | Built; tested on a local PostgreSQL 16, not yet on Neon |
| Sign-in lockout (doubling), single-use second-factor codes, recovery codes, command-line account recovery | Built; database logic tested on an in-process Postgres, not yet on Neon |
| Home core, voice loop (wake word "Niko", commands, speech), text input | Built |
| Voice navigation ("Niko, open my inbox") | Built |
| "Niko, send it" with the 10-second countdown, enforced on the server, replies only | Built |
| Per-user colour (shifting or fixed, custom picker) | Built |
| AI: Workers AI, or your own key (OpenAI-compatible / Anthropic), with fallback | Built |
| Voices in an order you choose: Cloudflare (free), on-device Kokoro (free), your own voice server, ElevenLabs; device voice always last | Built |
| Gmail, Outlook mail: read unread, open, send replies | Built, untested |
| Personal mail by app password over IMAP/SMTP: Gmail, iCloud, Synology, others (not Outlook.com) | Built; tested against local test servers only |
| Google Calendar, Outlook Calendar: today's events, open an event | Built, untested |
| Calendar links (private iCal address from Google, Outlook, iCloud): read-only | Built; tested with sample calendars only |
| Notion, OneNote: recent pages (trashed pages left out), open a page | Built, untested |
| Telegram bot: receive, reply as often as you like, send files, open received files | Built, untested |
| Slack: receive (Events API), reply | Built, untested |
| Discord: send messages and files to a channel | Built, untested. Receiving needs a gateway connection and is not built |
| Make.com, n8n, Power Automate: signed webhooks out and in | Built, untested |
| Apple Calendar, Synology Calendar (CalDAV) | Credentials can be saved; **reading events is not built** |
| Telegram personal account | **Not built** (shown as "Later") |
| "Respond only to my voice" | **Not built** (switch is disabled). Niko answers anyone who says its name |
| Sending files through Slack | Not built |
| Self-hosted AI model option | Use "Other AI systems" with your server's public https address |
| Tablet/phone layouts | Responsive CSS is in place but has not been checked on devices |

Differences from the plan and mockups:
- The particle core is the mockup's 2D canvas code, ported directly, instead of a Three.js rewrite. GSAP is not used; Lenis smooths the landing scroll.
- The colour setting moved fully to each user's Appearance screen; the whole screen is its live preview.
- Engine settings no longer hold API-key fields; keys are entered once on the Connections screen.
