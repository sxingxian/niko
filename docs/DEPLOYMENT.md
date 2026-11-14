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
2. Open the **SQL Editor** and run these files once each, in order (paste the whole file):

   | File | Adds |
   | --- | --- |
   | `packages/db/migrations/0001_init.sql` | Accounts, sessions, invites, passkeys, connections, messages, sends, audit log, and the `pgcrypto` extension used for password hashing |
   | `packages/db/migrations/0002_signin_protections.sql` | Sign-in lockout, single-use second-factor codes, recovery codes |

3. Dashboard → **Connect** → copy the **pooled** connection string (the host contains `-pooler`). This is `DATABASE_URL`.

There is no migration runner yet: each new file in `packages/db/migrations` is run by hand in the SQL Editor, once, before the code that needs it is deployed. The release notes for a change say when there is one.

`DATABASE_URL` is the master key: anyone who has it can read every account and reset any password (see "Account recovery" below). Store it in your password manager and nowhere else except the Worker secret.

## 1b. Email (Resend)

1. Create a Resend account, add the domain `sxingxian.com` and the DNS records it asks for (SPF/DKIM). If the domain is already verified for another project, skip this.
2. Create an API key with **sending access only** → `RESEND_API_KEY`.
3. The sender is the `EMAIL_FROM` variable in `apps/api/wrangler.jsonc` (`Niko <niko@sxingxian.com>`). Change it there if you want another address; it must be on the verified domain.

Niko sends two kinds of email: invitations and password-reset links. Until `RESEND_API_KEY` is set, invites are still created in the admin portal but no email goes out, and "Forgot password" sends nothing.

## 2. Secrets

Make the two random values once, on your own computer (nothing is written to disk):

```bash
openssl rand -base64 32   # ENCRYPTION_KEY
openssl rand -hex 24      # BOOTSTRAP_TOKEN
```

Then set the Worker secrets from `apps/api`:

```bash
npx wrangler login
npx wrangler secret put DATABASE_URL      # Neon pooled connection string
npx wrangler secret put ENCRYPTION_KEY
npx wrangler secret put BOOTSTRAP_TOKEN
npx wrangler secret put RESEND_API_KEY
```

| Secret | Needed | What it does |
| --- | --- | --- |
| `DATABASE_URL` | Yes | Connects the Worker to Neon |
| `ENCRYPTION_KEY` | Yes | Encrypts saved connection tokens and admin second-factor keys before they reach the database |
| `BOOTSTRAP_TOKEN` | Once | Lets you create the owner account on first run (section 4). Useless after one user exists; delete it then |
| `RESEND_API_KEY` | For email | Sends invitations and reset links |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Optional | Gmail, Google Calendar (section 5) |
| `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET` | Optional | Outlook, Outlook Calendar, OneNote |
| `NOTION_CLIENT_ID`, `NOTION_CLIENT_SECRET` | Optional | Notion |
| `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `SLACK_SIGNING_SECRET` | Optional | Slack |

**Keep a copy of `ENCRYPTION_KEY` in your password manager.** If it is lost or changed, every saved connection and every admin second factor becomes unreadable: people reconnect their accounts and admins run `reset-2fa` (see "Account recovery").

**Without a computer:** let GitHub do the first deploy (section 3), then add the same names in Cloudflare → Workers & Pages → `niko` → Settings → **Variables and secrets** → Add → type **Secret**. Secrets set there are kept across deploys. Make the two random values with a password manager's generator (44+ characters for `BOOTSTRAP_TOKEN`; `ENCRYPTION_KEY` must be exactly 32 random bytes in base64, so use the `openssl` line when you can).

**Never put any of these in `wrangler.jsonc`, a committed `.env` or `.dev.vars` file, or a GitHub variable.** Only `EMAIL_FROM` and `AI_MODEL` are plain variables.

## 3. Cloudflare (one Worker with static assets)

The Worker (`apps/api/src/index.ts`) answers `/api/*`, sets the security headers and Content-Security-Policy in code, and serves the three built front ends from `apps/api/public`. Its settings are in `apps/api/wrangler.jsonc`. Workers AI is bound as `AI`; there is nothing to switch on.

Both `sxingxian.com` and `midnightpoetry.studio` must be zones in the **same Cloudflare account** as the Worker.

### Deploy from GitHub (recommended)

`.github/workflows/deploy.yml` type-checks, builds the three front ends and deploys on every push to `main`. It skips the deploy step until the token below exists.

One-time setup (in a browser at github.com; the GitHub app can't edit secrets):

1. Cloudflare → My Profile → **API Tokens** → Create Token → template **Edit Cloudflare Workers**. Limit it to your account and to the two zones.
2. Repository → Settings → Secrets and variables → Actions → **Secrets**:
   - `CLOUDFLARE_API_TOKEN` (the token)
   - `CLOUDFLARE_ACCOUNT_ID` (Cloudflare dashboard → Workers & Pages → the Account ID in the sidebar)

**Each time:** push to `main`, or GitHub app → the repository → **Actions** → **Deploy Niko** → **Run workflow**.

### Deploy from your computer

From the repository root:

```bash
npm ci
npm run deploy     # builds landing, app and admin, then runs wrangler deploy
```

### Alternative: Cloudflare's own Git build

If you connect the repository in Workers & Pages → Create → Import a repository instead of using GitHub Actions:

- **Root directory:** `/` (repository root)
- **Build command:** `npm ci && npm run build:web`
- **Deploy command:** `npm run deploy -w @niko/api`
- **Build variables:** `NODE_VERSION=22`

The Worker's name must stay `niko` (it matches `name` in `wrangler.jsonc`). Use one way of deploying, not both, or each push deploys twice.

### Custom domains

`wrangler.jsonc` claims `niko.sxingxian.com`, `niko.midnightpoetry.studio` and `nikoapp.midnightpoetry.studio` as Worker custom domains, so the first deploy creates the DNS records and certificates. If a hostname already has a DNS record or belongs to another Worker or Pages project, remove that first or the deploy fails. Keep the orange-cloud proxy on: the audit log and the sign-in lockout read the real client address from `CF-Connecting-IP`.

The Worker answers only on those three hosts: `workers_dev` and `preview_urls` are off.

## 4. First owner and admin

Nobody can sign up until an owner exists. Create it once:

1. Open `https://niko.sxingxian.com/app`. Because there are no users yet, it shows **Set up Niko**.
2. Enter the `BOOTSTRAP_TOKEN`, your name, email and a password (12 characters or more). This creates the owner. The setup page stops working as soon as one user exists.
3. Open `https://niko.sxingxian.com/admin`, sign in with the same email and password, and add the key to an authenticator app. The admin portal asks for that 6-digit code every time.
4. **Save the ten recovery codes** it shows next. They are shown once; each works once if you lose the authenticator.
5. Delete the bootstrap secret: `npx wrangler secret delete BOOTSTRAP_TOKEN` (or remove it in the dashboard).

From then on, invite people from the admin portal's **Users** screen. Registration is invite-only until you switch it on the same screen. Invited people get an email, choose a password, and can add a passkey afterwards in **Account**. A passkey works on one domain only, so add one on each address you use (`sxingxian.com` and `midnightpoetry.studio`).

## 5. Connections that need a provider app (optional)

The Connect button for these stays unavailable until you register an app with the provider and add its keys as Worker secrets. For each one, register **both** redirect addresses:

```
https://niko.sxingxian.com/api/oauth/callback
https://nikoapp.midnightpoetry.studio/api/oauth/callback
```

| Connections | Where to register | Secrets |
| --- | --- | --- |
| Gmail, Google Calendar | Google Cloud Console → OAuth client (Web). Enable the Gmail API and Calendar API | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` |
| Outlook, Outlook Calendar, OneNote | Microsoft Entra → App registration | `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET` |
| Notion | notion.so/my-integrations → public integration | `NOTION_CLIENT_ID`, `NOTION_CLIENT_SECRET` |
| Slack | api.slack.com/apps. Event request URL `https://niko.sxingxian.com/api/hooks/slack`; subscribe to `message.channels` and `message.im` | `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `SLACK_SIGNING_SECRET` |

Google keeps an app in "Testing" until it is verified: only test users you list can connect, and Google expires their access after a short period. Gmail scopes are restricted and need Google's review before general use.

These need no server setup. Each person pastes their own key on the Connections screen: Telegram bot (token from @BotFather; Niko points the bot at its own webhook), Discord (bot token and channel ID), ElevenLabs (API key and voice ID), other AI systems (base URL, key, model), Make.com / n8n / Power Automate (webhook URL).

Incoming addresses the Worker listens on:

| Address | Called by | Checked with |
| --- | --- | --- |
| `/api/hooks/telegram/<connection>` | Telegram | The secret Niko gave Telegram when the bot was connected |
| `/api/hooks/slack` | Slack | Slack's request signature (`SLACK_SIGNING_SECRET`) |
| `/api/hooks/in/<connection>` | Make.com, n8n, Power Automate | A per-connection signing secret (HMAC-SHA256 of the body in an `x-niko-signature` header), shown once on the Connections screen |

## 6. After the first deploy

- [ ] `https://niko.sxingxian.com/api/auth/config` answers with JSON. An error here means `DATABASE_URL` is missing or the migrations were not run.
- [ ] All three hosts load: the landing page on both `niko.` addresses, the app on `/app` and on `nikoapp.midnightpoetry.studio`, the admin portal on both `/admin` addresses.
- [ ] Create the owner (section 4), set up the authenticator and save the recovery codes.
- [ ] Sign out of the admin portal and sign in again with a **recovery code**, then press **New recovery codes** and save the new set.
- [ ] Invite a second email address and check the email arrives; accept it and sign in.
- [ ] Use **Forgot password** and check the reset email arrives and works once only.
- [ ] Type a wrong password 5 times: the fifth answer should say to wait 1 minute, and the right password is refused until then. Clear it with `npm run user -- unlock <email>`.
- [ ] Add a passkey in **Account** on each domain, sign out, and sign in with it.
- [ ] Ask Niko something with the built-in brain (Workers AI) and by voice; say "Niko" to wake it.
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

- **Workers AI** has a daily free allowance; once it is used up, the built-in brain fails until the next day. People can switch to their own AI key in **Engine**. Change the default model with the `AI_MODEL` variable in `wrangler.jsonc`.
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
- The workflow has read-only access to the repository; the Cloudflare token is the only secret it sees.
- The Worker serves only its three custom domains (`workers_dev` and `preview_urls` are off).
- Run a new migration in Neon **before** pushing the code that needs it; migrations only add things, so the old code keeps working in between.
- Rotating secrets: `RESEND_API_KEY`, provider secrets and `DATABASE_URL` (Neon → reset password) can be replaced at any time with `wrangler secret put`. `ENCRYPTION_KEY` cannot be rotated without losing saved connections and second factors.
- There are no automated tests in CI yet beyond the type check; the security notes are in [SECURITY.md](SECURITY.md).
