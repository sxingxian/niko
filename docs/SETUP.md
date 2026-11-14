# Setting up Niko

You do these steps yourself; none of the keys below should ever be committed or pasted into a chat.

## 1. Neon (database)

1. Create a project at neon.tech and copy its **pooled** connection string.
2. Open the SQL editor and run the whole of `packages/db/migrations/0001_init.sql` once.

## 2. Cloudflare (hosting)

1. Both domains (`sxingxian.com`, `midnightpoetry.studio`) must be zones in the same Cloudflare account. The three hostnames in `apps/api/wrangler.jsonc` are attached as custom domains on deploy.
2. From `apps/api`, set the secrets:

```
npx wrangler login
npx wrangler secret put DATABASE_URL       # the Neon connection string
npx wrangler secret put ENCRYPTION_KEY     # openssl rand -base64 32
npx wrangler secret put BOOTSTRAP_TOKEN    # openssl rand -hex 24  (keep it; you need it once)
npx wrangler secret put RESEND_API_KEY
```

Keep a copy of `ENCRYPTION_KEY` somewhere safe. If it is lost, every saved connection and admin second factor becomes unreadable.

3. Deploy from the repository root: `npm ci && npm run deploy`.

To deploy from GitHub instead, add the repository secrets `CLOUDFLARE_API_TOKEN` (a token with "Edit Cloudflare Workers" permission) and `CLOUDFLARE_ACCOUNT_ID`. Pushes to `main` then deploy automatically.

## 3. Resend (email)

1. Verify a sending domain in Resend.
2. Set `EMAIL_FROM` in `apps/api/wrangler.jsonc` to an address on that domain.

Without Resend, invites are still created but no email goes out.

## 4. First sign-in

1. Open `https://niko.sxingxian.com/app`. Because there are no users yet, it shows **Set up Niko**.
2. Enter the `BOOTSTRAP_TOKEN`, your name, email and a password. This creates the owner account. The setup page stops working once one user exists.
3. Open `https://niko.sxingxian.com/admin`, sign in with the same email and password, and add the setup key to an authenticator app. Admin needs that 6-digit code every time.
4. Invite other people from **Users**. Registration is invite-only until you switch it.

Passkeys: after signing in, go to **Account → Add a passkey**. A passkey works on one domain only, so add one on each address you use.

## 5. Connections that need a provider app

The Connect button for these stays unavailable until you register an app with the provider and add its keys as Worker secrets. For each one, register **both** redirect addresses:

```
https://niko.sxingxian.com/api/oauth/callback
https://nikoapp.midnightpoetry.studio/api/oauth/callback
```

| Connections | Where to register | Secrets |
|---|---|---|
| Gmail, Google Calendar | Google Cloud Console → OAuth client (Web). Enable Gmail API and Calendar API | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` |
| Outlook, Outlook Calendar, OneNote | Microsoft Entra → App registration | `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET` |
| Notion | notion.so/my-integrations → public integration | `NOTION_CLIENT_ID`, `NOTION_CLIENT_SECRET` |
| Slack | api.slack.com/apps. Event request URL: `https://niko.sxingxian.com/api/hooks/slack`, subscribe to `message.channels` and `message.im` | `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `SLACK_SIGNING_SECRET` |

Google keeps an app in "Testing" until it is verified; in that state only test users you list can link, and Google expires their access after a short period. Gmail scopes are restricted and need Google's review before general use.

These need no server setup; each user pastes their own key on the Connections screen: Telegram bot (token from @BotFather), Discord (bot token and channel ID), ElevenLabs (API key and voice ID), Other AI systems (base URL, key, model), Make.com / n8n / Power Automate (webhook URL).

## Local development

```
cp apps/api/.dev.vars.example apps/api/.dev.vars   # fill it in
npm run build:web
npm run dev:api          # Worker on http://localhost:8787
npm run dev -w @niko/app # app with hot reload, proxying /api
```

## Free-tier limits to know

- **Workers AI** has a daily free allowance; once it is used up, requests fail until the next day. Change the model with the `AI_MODEL` variable.
- **Password hashing** runs in Neon (bcrypt via `pgcrypto`, over a SHA-256 pre-hash made in the Worker), the same as sxingxian.com. It does not count against the Worker's CPU limit.
- **Wake word** works only while Niko is open in a browser that supports speech recognition (Chrome, Edge, Safari) and the microphone is allowed.
