# Deploying Niko

Everything runs on free tiers at launch: **Neon** (PostgreSQL database), **Cloudflare Workers** (one Worker serves the API, the landing page, the app and the admin portal, plus Workers AI for the built-in brain) and **Resend** (email). Allow about an hour the first time.

You do these steps yourself. None of the keys below should ever be committed (this repository is public) or pasted into a chat.

| Host | Serves | Worker | Built from |
| --- | --- | --- | --- |
| `niko.sxingxian.com` | Landing page, the app at `/app`, the admin portal at `/admin` | `niko` | `apps/landing`, `apps/app`, `apps/admin` |
| `niko.midnightpoetry.studio` | Landing page, the admin portal at `/admin` (`/app` forwards to the address below) | `niko` | the same build |
| `nikoapp.midnightpoetry.studio` | The app (PWA) | `niko` | the same build |

All three hosts are the same Niko: one Worker, one database, shared accounts. The API is at `/api` on each host.

## 1. Neon database

1. Create a project at neon.tech. Choose the region nearest you (**AWS Asia Pacific (Singapore)**) and PostgreSQL 16 or later.
2. Dashboard → **Connect** → copy the **pooled** connection string (the host contains `-pooler`). This is `DATABASE_URL`.

That is all you do in Neon. The tables are created and updated for you on every deploy: `npm run migrate` (`scripts/migrate.mjs`) applies the files in `packages/db/migrations` in name order, once each, before the Worker is deployed. Section 3 shows where it runs.

| File | Adds |
| --- | --- |
| `0001_init.sql` | Accounts, sessions, invites, passkeys, connections, messages, sends, audit log, and the `pgcrypto` extension used for password hashing |
| `0002_signin_protections.sql` | Sign-in lockout, single-use second-factor codes, recovery codes |
| `0003_provider_apps.sql` | Each account's own Google, Microsoft, Notion and Slack app keys |

How it behaves:

- Applied files are recorded in the table `schema_migrations`, so running it again does nothing.
- Everything pending is applied in one transaction. If any statement fails, nothing is changed and the deploy stops before the Worker is touched.
- Two runs at the same time wait for each other.
- A file that has been applied must not be edited; the run refuses if it was. Put every change in a new file (`0003_…sql`), and only add things (new tables, new columns with defaults) so the code that is still live keeps working while the deploy finishes.
- If you already ran the files by hand in the SQL Editor, the first automatic run simply records them (they are written to be safe to repeat).

`DATABASE_URL` is the master key: anyone who has it can read every account and reset any password (see "Account recovery" below). Keep it in two places only: your password manager and the deploy secret (Cloudflare build, or GitHub) that updates the database. Each deploy copies that same value to the Worker as its runtime secret, so you never set it on the Worker by hand and the two can't drift apart.

## 1b. Email (Resend)

1. Create a Resend account, add the domain `app.midnightpoetry.studio` and the DNS records it asks for (SPF/DKIM) in the `midnightpoetry.studio` zone. If that domain is already verified in Resend, skip this.
2. Create an API key with **sending access only** → `RESEND_API_KEY`.
3. The sender is the `EMAIL_FROM` variable in `apps/api/wrangler.jsonc` (`Niko <niko-noreply@app.midnightpoetry.studio>`). Change it there if you want another address; it must be on the verified domain.

Niko sends two kinds of email: invitations and password-reset links. Until `RESEND_API_KEY` is set, invites are still created in the admin portal but no email goes out, and "Forgot password" sends nothing.

## 2. Secrets

Make the two random values once, on your own computer (nothing is written to disk):

```bash
openssl rand -base64 32   # ENCRYPTION_KEY
openssl rand -hex 24      # BOOTSTRAP_TOKEN
```

Then set the Worker secrets from `apps/api` (not `DATABASE_URL`: the deploy sets that one, see the table):

```bash
npx wrangler login
npx wrangler secret put ENCRYPTION_KEY
npx wrangler secret put BOOTSTRAP_TOKEN
npx wrangler secret put RESEND_API_KEY
```

| Secret | Needed | What it does |
| --- | --- | --- |
| `DATABASE_URL` | Yes | Connects the Worker to Neon. **Set automatically**: `npm run release` uploads the build's `DATABASE_URL` with every deploy (`scripts/deploy-worker.mjs`). Cloudflare *build* variables are not visible to the running Worker, which is why it isn't left to a second copy |
| `ENCRYPTION_KEY` | Yes | Encrypts saved connection tokens and admin second-factor keys before they reach the database |
| `BOOTSTRAP_TOKEN` | Once | Lets you create the owner account on first run (section 4). Useless after one user exists; delete it then |
| `RESEND_API_KEY` | For email | Sends invitations and reset links |

There are no Google, Microsoft, Notion or Slack keys here. Each account adds its own on the Connections screen (section 5).

**Keep a copy of `ENCRYPTION_KEY` in your password manager.** If it is lost or changed, every saved connection, every account's app keys and every admin second factor become unreadable: people add their keys and reconnect and admins run `reset-2fa` (see "Account recovery").

**Without a computer:** let the first deploy run (section 3), then add `ENCRYPTION_KEY`, `BOOTSTRAP_TOKEN` and `RESEND_API_KEY` in Cloudflare → Workers & Pages → `niko` → Settings → **Variables and secrets** → Add → type **Secret**. Secrets set there are kept across deploys. Make the two random values with a password manager's generator (44+ characters for `BOOTSTRAP_TOKEN`; `ENCRYPTION_KEY` must be exactly 32 random bytes in base64, so use the `openssl` line when you can).

**Never put any of these in `wrangler.jsonc`, a committed `.env` or `.dev.vars` file, or a GitHub variable.** Only `EMAIL_FROM` and `AI_MODEL` are plain variables.

## 3. Cloudflare (one Worker with static assets)

The Worker (`apps/api/src/index.ts`) answers `/api/*`, sets the security headers and Content-Security-Policy in code, and serves the three built front ends from `apps/api/public`. Its settings are in `apps/api/wrangler.jsonc`. Workers AI is bound as `AI`; there is nothing to switch on.

Both `sxingxian.com` and `midnightpoetry.studio` must be zones in the **same Cloudflare account** as the Worker.

### Deploy automatically when `main` changes (recommended)

Connect the repository to Cloudflare once. After that, every new commit on `main` is built and deployed by Cloudflare by itself; there is nothing to run and no Cloudflare token to keep in GitHub.

1. Cloudflare → **Workers & Pages** → **Create** → **Import a repository** → choose `sxingxian/niko` (allow the Cloudflare GitHub app access to this one repository only).
2. Set:
   - **Project name:** `niko` (it must match `name` in `apps/api/wrangler.jsonc`)
   - **Production branch:** `main`
   - **Root directory:** `/` (repository root)
   - **Build command:** `npm ci && npm run build:web`
   - **Deploy command:** `npm run release`
   - **Builds for non-production branches:** off
   - **Build variables:** `NODE_VERSION=22`, and `DATABASE_URL` added as a **Secret**
3. Save and deploy. Later, the same settings are under the Worker → Settings → **Build**.

> **Don't keep the default deploy command `npx wrangler deploy`.** The Worker's settings live in `apps/api`, not the repository root, so the default fails. `npm run release` updates the Neon database (`npm run migrate`) and then deploys from the right folder. If the database update fails, the deploy stops and the live site is left as it was.

The build's `DATABASE_URL` is the only copy you keep: `npm run release` migrates with it and then hands the same value to the Worker as a runtime secret. Other branches are never built, so a branch or pull request can't reach the database.

GitHub still runs `.github/workflows/deploy.yml` on every push as a check (type check and build). Its own database and deploy steps stay switched off unless you add a Cloudflare token there (next heading), so nothing deploys twice.

### Alternative: deploy from GitHub Actions

Use this instead of the Cloudflare connection, not as well as it. The same workflow then also updates the database and deploys.

One-time setup (in a browser at github.com; the GitHub app can't edit secrets):

1. Cloudflare → My Profile → **API Tokens** → Create Token → template **Edit Cloudflare Workers**. Limit it to your account and to the two zones.
2. Repository → Settings → Secrets and variables → Actions → **Secrets**: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` and `DATABASE_URL`.

Every push to `main` then deploys. Actions → **Deploy Niko** → **Run workflow** has a *dry run* tick box that only lists the database changes that would run. The database secret is given to the one step that needs it, and the workflow never runs for pull requests or forks.

### Deploy from your computer

From the repository root:

```bash
npm ci
export DATABASE_URL='…'   # only in this terminal; never in a file in the repository
npm run build:web
npm run release    # updates the database, then deploys (npm run migrate -- --dry-run only lists changes)
```

### Custom domains

`wrangler.jsonc` claims `niko.sxingxian.com`, `niko.midnightpoetry.studio` and `nikoapp.midnightpoetry.studio` as Worker custom domains, so the first deploy creates the DNS records and certificates. If a hostname already has a DNS record or belongs to another Worker or Pages project, remove that first or the deploy fails. Keep the orange-cloud proxy on: the audit log and the sign-in lockout read the real client address from `CF-Connecting-IP`.

The Worker answers only on those three hosts: `workers_dev` and `preview_urls` are off.

## Release checks

`npm run release` (what Cloudflare runs on every push to `main`) does this, in order, and stops at the first failure:

1. **`npm test`**: mail (IMAP/SMTP) and calendar-link tests against stand-in servers that behave like Google and Outlook, including their known refusals. If a test fails, nothing is migrated or deployed.
2. **Database update** (`npm run migrate`).
3. **Deploy** (`scripts/deploy-worker.mjs`), then a **live check** of both domains: the page and `/api/auth/config` must answer. If the site answers with an error, the previous version is put back automatically (`wrangler rollback`) and the build is marked failed. If the build machine can't reach the site at all, it only warns.

Run `npm test` locally before pushing to catch the same problems sooner.

## Troubleshooting

| What you see | Cause | Fix |
| --- | --- | --- |
| The app says "Niko can't reach its server", or `/api/...` answers **503** `not_configured` | A required Worker secret is missing. The Worker log (Worker → Observability) names it: `Worker secret(s) missing: …` | `DATABASE_URL`: redeploy (Deployments → Retry build); the deploy sets it. `ENCRYPTION_KEY`: add it as in section 2 |
| `/api/...` answers **500** "Something went wrong on the server" | The Worker log line `api error <method> <path>: …` gives the reason, including the database error code (e.g. `42P01` = a table is missing → the migration didn't run on this database; `28P01` = wrong password in `DATABASE_URL`) | Fix what it names, then redeploy |
| A calendar link (iCal) won't connect | The message names which address (first, second, third) and what to copy instead. Google: use “Secret address in iCal format”, not the public one. Outlook: the ICS or HTML link from Shared calendars → Publish | Copy the address it names again |
| No **Set up Niko** screen on a new install | The app can't read `/api/auth/config` | See the two rows above |

## 4. First owner and admin

Nobody can sign up until an owner exists. Create it once:

1. Open `https://niko.sxingxian.com/app`. Because there are no users yet, it shows **Set up Niko**.
2. Enter the `BOOTSTRAP_TOKEN`, your name, email and a password (12 characters or more). This creates the owner. The setup page stops working as soon as one user exists.
3. Open `https://niko.sxingxian.com/admin`, sign in with the same email and password, and add the key to an authenticator app. The admin portal asks for that 6-digit code every time.
4. **Save the ten recovery codes** it shows next. They are shown once; each works once if you lose the authenticator.
5. Delete the bootstrap secret: `npx wrangler secret delete BOOTSTRAP_TOKEN` (or remove it in the dashboard).

From then on, invite people from the admin portal's **Users** screen. Registration is invite-only until you switch it on the same screen. Invited people get an email, choose a password, and can add a passkey afterwards in **Account**. A passkey works on one domain only, so add one on each address you use (`sxingxian.com` and `midnightpoetry.studio`).

## 5. Connections: every account brings its own keys

Nothing about Google, Microsoft, Notion or Slack is configured on the server. Each account registers its own app with the provider and saves the keys on **Connections → Your app keys**. Two accounts never share a client ID, a secret or a quota, and the admin can't see anyone's keys (they are encrypted with `ENCRYPTION_KEY` and never shown again).

What each person does, once per provider:

1. Open **Connections** and press **Connect** on, say, Gmail. For Google and Microsoft the dialog walks through the registration step by step, with a link to each console page and **Copy** buttons for the redirect addresses:

   ```
   https://niko.sxingxian.com/api/oauth/callback
   https://nikoapp.midnightpoetry.studio/api/oauth/callback
   ```

2. Register an app with the provider, add **both** redirect addresses, and paste the keys back into the dialog:

   | Provider | For | Where to register | What to paste |
   | --- | --- | --- | --- |
   | Google | Gmail, Google Calendar | Google Cloud: create a project, turn on the Gmail and Calendar APIs, set up sign-in with audience **External** (so personal Gmail works), then under Audience press **Publish app**. Create a client of type Web application with the redirect addresses | Drop the JSON file from **Download JSON** (shown once, right after creating the client), or paste the client ID and secret |
   | Microsoft | Outlook, Outlook Calendar, OneNote | Needs a Microsoft directory: a work or school account has one; with only Outlook.com or Hotmail, create a free Azure account first (it asks for a card to confirm identity). Then Entra → App registrations → New registration, supported accounts **Any Entra ID tenant + personal Microsoft accounts**, redirect type Web | Application (client) ID and the client secret **Value** (not the Secret ID). The tenant ID is tucked away; leave it empty unless the app is for one organisation only |
   | Notion | Notion | notion.so/my-integrations → New integration → type Public | OAuth client ID, OAuth client secret |
   | Slack | Slack | api.slack.com/apps → Create New App → OAuth & Permissions. To receive messages, also set the *Event request address* shown in the dialog and subscribe to `message.channels` and `message.im` | Client ID, client secret, signing secret (optional; needed to receive) |

3. Press **Save and sign in**. Niko sends them to the provider to approve access.

Changing or removing keys removes the links made with them, because sign-ins made through one app can't be renewed through another.

Things to know before promising this to people:

- Registering an app takes about five minutes each with the walk-through, but it is still done in Google's and Microsoft's developer consoles.
- **Publish the Google app.** Left in "Testing", Google expires the sign-in after 7 days and Gmail and Calendar disconnect every week. A published app that Google has not reviewed is fine for personal use (up to 100 people): Google shows an "unverified app" warning once at sign-in (Advanced → Go to Niko).
- **Microsoft personal accounts can no longer register apps without a directory**, so someone with only Outlook.com or Hotmail needs the free Azure account first. Registering the app itself is free.
- Google and Microsoft show each client secret only once, when it is made. If it is lost, make a new one and paste it in again.
- Niko checks pasted keys for the usual mix-ups (client ID in the secret field, Microsoft's Secret ID instead of its Value) before saving.

At sign-in Google and Microsoft both show an account picker, so a person signed in to a work account in the browser can still choose a personal one.

**Without registering an app** (personal accounts):

- *Mail:* **Gmail · app password**, **iCloud Mail**, **Synology Mail** and **Other email (IMAP)** sign in with an app password over IMAP (reading) and SMTP (replies). Gmail needs 2-Step Verification on to offer app passwords. Connections are always encrypted (IMAP 993 or 143 with STARTTLS; SMTP 465 or 587 with STARTTLS). Niko opens the inbox read-only, so nothing is marked as read by looking; a reply marks the original as answered and, except on Gmail (which does it itself), keeps a copy in Sent. Details are checked by signing in once before they are saved.
- *Outlook.com, Hotmail and Live mail can't connect this way:* Microsoft switched off app passwords for IMAP, POP and SMTP on personal accounts in September 2024. They need the Outlook connection (a registered Microsoft app). POP3 is not offered at all: IMAP does everything it does, without removing mail from the server.
- *Calendars:* **Calendar link (iCal)** reads up to three private calendar addresses: Google's "Secret address in iCal format", an Outlook.com published calendar's ICS link, iCloud, and so on. Read-only. Repeating events, changed and skipped weeks, and time zones come from the file. Each link is cached for five minutes (under a hash of the address, never the address itself). Anyone holding such an address can read that calendar, so it is stored encrypted like a password; reset it at the source if it leaks.
- *Refresh:* chats are checked every 30 seconds while the inbox is open; mail, calendars and notes every 5 minutes, which keeps IMAP sign-ins well within providers' limits.

These need no app registration either. Each person pastes their own key: on **Connections**, Telegram bot (token from @BotFather), Discord (bot token and channel ID) and Make.com / n8n / Power Automate (webhook URL); on **Voice**, voice API keys for OpenAI (or any OpenAI-compatible service), ElevenLabs, Google Cloud, Azure, Deepgram, Cartesia or Fish Audio (up to 10); on **Engine**, their own AI keys (up to 10) or self-hosted model. Weather (Open-Meteo) needs no key at all: each person switches it on under Connections → Weather. Open-Meteo's free API is for non-commercial use; a commercial deployment needs an Open-Meteo API plan.

- **Telegram groups:** a bot can't list the chats it is in or see messages from before it joined. A group appears in the inbox when the bot is added to it or someone writes there. Bots start with *group privacy* on, which hides ordinary group messages: @BotFather → `/setprivacy` → the bot → **Disable**, then remove and re-add the bot to each group. Connections → Telegram bot → Manage shows the current setting and has **Check again**. Bots connected before this change need **Check again** once so Telegram starts sending group joins.
- **Voices:** on **Voice**, each person switches voices on, puts them in order, and Niko uses the first that works, always ending with the device voice. The default is Cloudflare's voice, then the device voice.
  - *Cloudflare voice* (Workers AI): nothing to set up. *Standard* (MeloTTS) costs almost nothing of the free daily allowance; the *Natural* voices (Deepgram Aura) use about 1,360 Neurons per 1,000 characters, roughly 30 replies a day out of the free 10,000 Neurons, shared with the Workers AI brain. The allowance resets at midnight UTC.
  - *On-device voice* (Kokoro-82M): each device downloads it once (about 115 MB) with **Download to this device**; until then Niko skips it on that device. The speech runtime is served by Niko; the model comes from Hugging Face and is checked against a pinned fingerprint. Keep `@huggingface/transformers` at 3.5.1 and `kokoro-js` at 1.2.1: the build checks the runtime files' hashes and fails if they change.
  - *Your voice server*: any OpenAI-compatible speech server (`/v1/audio/speech`), such as Kokoro-FastAPI, or Chatterbox TTS Server for a cloned voice, at a public https address (Cloudflare Tunnel works for a NAS).
  - *ElevenLabs*: the free plan refuses requests from cloud servers (Niko runs on Cloudflare), so it needs a paid plan, and the key needs the *Text to Speech* and *Voices* permissions.

Incoming addresses the Worker listens on:

| Address | Called by | Checked with |
| --- | --- | --- |
| `/api/hooks/telegram/<connection>` | Telegram | The secret Niko gave Telegram when the bot was connected |
| `/api/hooks/slack/<account>` | Slack | Slack's request signature, checked with that account's own signing secret |
| `/api/hooks/in/<connection>` | Make.com, n8n, Power Automate | A per-connection signing secret (HMAC-SHA256 of the body in an `x-niko-signature` header), shown once on the Connections screen |

## 6. After the first deploy

- [ ] The deploy log shows `Applied 3 migrations.` (or `Database is up to date`).
- [ ] Push a small commit to `main` and check Cloudflare starts a new build by itself (Worker → Deployments).
- [ ] `https://niko.sxingxian.com/api/auth/config` answers with JSON. An error here means the Worker's `DATABASE_URL` secret is missing or wrong.
- [ ] All three hosts load: the landing page on both `niko.` addresses, the app on `/app` and on `nikoapp.midnightpoetry.studio`, the admin portal on both `/admin` addresses.
- [ ] Create the owner (section 4), set up the authenticator and save the recovery codes.
- [ ] Sign out of the admin portal and sign in again with a **recovery code**, then press **New recovery codes** and save the new set.
- [ ] Invite a second email address and check the email arrives; accept it and sign in.
- [ ] Use **Forgot password** and check the reset email arrives and works once only.
- [ ] Type a wrong password 5 times: the fifth answer should say to wait 1 minute, and the right password is refused until then. Clear it with `npm run user -- unlock <email>`.
- [ ] Add a passkey in **Account** on each domain, sign out, and sign in with it.
- [ ] Ask Niko something with the built-in brain (Workers AI) and by voice; say "Niko" to wake it.
- [ ] On **Connections → Your app keys**, add your own Google keys and connect Gmail. Sign in as a second account and check it has no keys and can't see yours.
- [ ] Connect a Telegram bot, send it a message, reply by voice with "Niko, send it" and check the 10-second countdown and the audit log entry.
- [ ] Install the app on an iPhone (Share → Add to Home Screen) and on an Android phone.
- [ ] Run `https://securityheaders.com` against all three hosts. You should get an A.

None of the database, email, AI or provider paths have been run against live services yet, so treat this list as the first real test and report anything that fails.

## Account recovery

If you are locked out, lose your authenticator app and recovery codes, or forget the owner password, use the command-line tool on your own computer. It talks to Neon directly, so it works even when nobody can sign in.

```bash
export DATABASE_URL='…'   # the Neon connection string; never put it in a file in this repository
npm ci
npm run user -- list
npm run user -- reset-password you@example.com   # asks for the new password at a hidden prompt
npm run user -- reset-2fa      you@example.com   # removes the admin second factor and recovery codes
npm run user -- unlock         you@example.com   # clears sign-in locks
npm run user -- disable        someone@example.com
npm run user -- enable         someone@example.com
```

Every change is written to the audit log as "via command line". There is no way over the web to skip the admin second factor.

## Free-tier limits to know

- **Workers AI** has a daily free allowance; once it is used up, the built-in brain fails until the next day. People can add their own AI keys in **Engine** and put them before or after Workers AI; when one brain reaches its limit, Niko moves to the next until it resets. Change the default model with the `AI_MODEL` variable in `wrangler.jsonc`.
- **Workers free plan** allows 100,000 requests a day and a short CPU budget per request. Password hashing runs in Neon (bcrypt through `pgcrypto`), so it does not use that budget.
- **Neon free plan** pauses the database when idle; the first request after a pause takes a second or two longer.
- **Resend free plan** limits emails per day; invitations beyond it fail until the next day.
- **Files** sent or received through Niko pass through the Worker's memory (20 MB each) and are never stored.
- **Wake word** works only while Niko is open in a browser that supports speech recognition (Chrome, Edge, Safari) and the microphone is allowed.

## Local development

```bash
cp apps/api/.dev.vars.example apps/api/.dev.vars   # fill it in; the file is ignored by Git
npm ci
npm run build:web
npm run dev:api            # Worker on http://localhost:8787
npm run dev -w @niko/app   # the app with hot reload, passing /api to the Worker
```

Use a separate Neon branch or project for development, not the live database.

## Release safety

- GitHub Actions are pinned to exact commits (with the version in a comment). To update one, look up the new release's commit and change both.
- The deploy workflow installs only the versions in `package-lock.json` (`npm ci`) and will not deploy a commit that fails the type check or the build.
- The GitHub workflow has read-only access to the repository. Cloudflare builds only `main`.
- The Worker serves only its three custom domains (`workers_dev` and `preview_urls` are off).
- The database is updated before the Worker on every deploy, in one transaction; a failed update stops the deploy. Migrations only add things, so the old code keeps working in between. To undo a change, add a new migration; Neon's point-in-time restore is the fallback.
- Deploys run one at a time, in order.
- Rotating secrets: `RESEND_API_KEY` and `DATABASE_URL` (Neon → reset password) can be replaced at any time with `wrangler secret put` (people replace their own provider keys on the Connections screen). `ENCRYPTION_KEY` cannot be rotated without losing saved connections and second factors.
- There are no automated tests in CI yet beyond the type check; the security notes are in [SECURITY.md](SECURITY.md).
