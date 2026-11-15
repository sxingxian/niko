// Shared constants and types for the Niko API and front ends.

export type ProviderGroup = 'mail' | 'calendar' | 'notes' | 'automation' | 'messaging' | 'ai';
export type ConnectKind = 'oauth' | 'credentials' | 'token' | 'webhook' | 'builtin' | 'planned';

/** `shown`: not secret (an address, a model, a voice), so it is shown back to its owner after saving. Keys never are. */
export interface ProviderField { key: string; label: string; type: 'text' | 'password' | 'url'; placeholder?: string; optional?: boolean; shown?: boolean; /** tucked away, with this explanation */ advanced?: string }

/** The four providers that need an app registered with them. Each account registers its own and saves its keys. */
export type AppId = 'google' | 'microsoft' | 'notion' | 'slack';
export interface AppStep { text: string; link?: string; linkLabel?: string; /** show the redirect addresses with this step */ redirects?: boolean }
/** `steps`: a guided setup. `file`: the provider offers a key file that fills the fields (read in the browser, never uploaded). */
export interface AppDef { id: AppId; name: string; where: string; fields: ProviderField[]; steps?: AppStep[]; file?: 'google-json' }

/** Catches the usual pasting mistakes before sign-in fails with a vague error from the provider. Returns a message, or null. */
export function checkAppKey(app: AppId, key: string, v: string): string | null {
  const guid = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
  if (app === 'google' && key === 'clientId' && !/^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$/.test(v)) return 'A Google client ID ends in .apps.googleusercontent.com.';
  if (app === 'google' && key === 'clientSecret' && v.endsWith('.apps.googleusercontent.com')) return 'That is the client ID. The client secret usually starts with GOCSPX-.';
  if (app === 'microsoft' && key === 'clientId' && !guid.test(v)) return 'The Application (client) ID looks like 00000000-0000-0000-0000-000000000000. It is on the app’s Overview page.';
  if (app === 'microsoft' && key === 'clientSecret' && guid.test(v)) return 'That looks like the Secret ID. Copy the Value column instead (shown only when the secret is made).';
  if (app === 'microsoft' && key === 'tenant' && v && !/^(common|organizations|consumers)$/i.test(v) && !guid.test(v)) return 'Directory (tenant) ID should be the ID from the app registration, or left empty.';
  return null;
}
export interface ProviderDef {
  id: string;
  name: string;
  group: ProviderGroup;
  how: string;
  kind: ConnectKind;
  /** For sign-in connections: which of the account's own provider apps it signs in through. */
  app?: AppId;
  fields?: ProviderField[];
  /** What the current code can actually do with this connection. */
  can: { read: boolean; send: boolean };
  /** Set on the Engine screen, not listed on Connections. */
  hidden?: boolean;
}

const hostField: ProviderField = { key: 'host', label: 'Server address', type: 'url', placeholder: 'https://' };
const userField: ProviderField = { key: 'username', label: 'Username', type: 'text' };
const passField: ProviderField = { key: 'password', label: 'App password', type: 'password' };

export const PROVIDERS: ProviderDef[] = [
  { id: 'gmail', name: 'Gmail', group: 'mail', how: 'Google sign-in', kind: 'oauth', app: 'google', can: { read: true, send: true } },
  { id: 'icloud-mail', name: 'iCloud Mail', group: 'mail', how: 'App-specific password · IMAP', kind: 'credentials', fields: [userField, passField], can: { read: false, send: false } },
  { id: 'outlook-mail', name: 'Outlook', group: 'mail', how: 'Microsoft sign-in', kind: 'oauth', app: 'microsoft', can: { read: true, send: true } },
  { id: 'synology-mail', name: 'Synology Mail', group: 'mail', how: 'Your NAS address · IMAP', kind: 'credentials', fields: [hostField, userField, passField], can: { read: false, send: false } },
  { id: 'google-calendar', name: 'Google Calendar', group: 'calendar', how: 'Google sign-in', kind: 'oauth', app: 'google', can: { read: true, send: false } },
  { id: 'apple-calendar', name: 'Apple Calendar', group: 'calendar', how: 'App-specific password · CalDAV', kind: 'credentials', fields: [userField, passField], can: { read: false, send: false } },
  { id: 'outlook-calendar', name: 'Outlook Calendar', group: 'calendar', how: 'Microsoft sign-in', kind: 'oauth', app: 'microsoft', can: { read: true, send: false } },
  { id: 'synology-calendar', name: 'Synology Calendar', group: 'calendar', how: 'Your NAS address · CalDAV', kind: 'credentials', fields: [hostField, userField, passField], can: { read: false, send: false } },
  { id: 'notion', name: 'Notion', group: 'notes', how: 'Notion sign-in · pages you pick', kind: 'oauth', app: 'notion', can: { read: true, send: false } },
  { id: 'onenote', name: 'OneNote', group: 'notes', how: 'Microsoft sign-in', kind: 'oauth', app: 'microsoft', can: { read: true, send: false } },
  { id: 'make', name: 'Make.com', group: 'automation', how: 'Signed webhooks, in and out', kind: 'webhook', fields: [{ key: 'url', label: 'Webhook URL', type: 'url', placeholder: 'https://hook.' }], can: { read: false, send: true } },
  { id: 'n8n', name: 'n8n', group: 'automation', how: 'Webhooks · your n8n server', kind: 'webhook', fields: [{ key: 'url', label: 'Webhook URL', type: 'url', placeholder: 'https://' }], can: { read: false, send: true } },
  { id: 'power-automate', name: 'Power Automate', group: 'automation', how: 'HTTP trigger URL · your flows', kind: 'webhook', fields: [{ key: 'url', label: 'HTTP trigger URL', type: 'url', placeholder: 'https://' }], can: { read: false, send: true } },
  { id: 'telegram-bot', name: 'Telegram bot', group: 'messaging', how: 'Bot token · chats with your Niko bot', kind: 'token', fields: [{ key: 'token', label: 'Bot token', type: 'password' }], can: { read: true, send: true } },
  { id: 'telegram-user', name: 'Telegram personal account', group: 'messaging', how: 'Sign in with your number · all your chats', kind: 'planned', can: { read: false, send: false } },
  { id: 'slack', name: 'Slack', group: 'messaging', how: 'Slack sign-in · channels you pick', kind: 'oauth', app: 'slack', can: { read: true, send: true } },
  { id: 'discord', name: 'Discord', group: 'messaging', how: 'Bot token · servers you pick', kind: 'token', fields: [{ key: 'token', label: 'Bot token', type: 'password' }, { key: 'channelId', label: 'Default channel ID', type: 'text', shown: true }], can: { read: false, send: true } },
  { id: 'workers-ai', name: 'Cloudflare Workers AI', group: 'ai', how: 'Free daily allowance', kind: 'builtin', can: { read: true, send: false } },
  { id: 'elevenlabs', name: 'ElevenLabs voice', group: 'ai', how: 'Your API key · your cloned voice', kind: 'token', fields: [{ key: 'apiKey', label: 'API key', type: 'password' }, { key: 'voiceId', label: 'Voice ID', type: 'text', shown: true }], can: { read: false, send: false } },
  { id: 'custom-ai', name: 'Other AI systems', group: 'ai', how: 'Your API key · OpenAI-compatible or Anthropic', kind: 'token', fields: [
    { key: 'baseUrl', label: 'Base URL', type: 'url', placeholder: 'https://', shown: true },
    { key: 'apiKey', label: 'API key', type: 'password' },
    { key: 'model', label: 'Model name', type: 'text', shown: true },
  ], can: { read: true, send: false } },
  { id: 'self-hosted-ai', name: 'Self-hosted model', group: 'ai', how: 'A model server you run · OpenAI-compatible', kind: 'token', hidden: true, fields: [
    { key: 'baseUrl', label: 'Server address', type: 'url', placeholder: 'https://', shown: true },
    { key: 'model', label: 'Model name', type: 'text', optional: true, shown: true },
    { key: 'apiKey', label: 'API key', type: 'password', optional: true },
  ], can: { read: true, send: false } },
];

const clientId: ProviderField = { key: 'clientId', label: 'Client ID', type: 'text' };
const clientSecret: ProviderField = { key: 'clientSecret', label: 'Client secret', type: 'password' };

export const APPS: AppDef[] = [
  { id: 'google', name: 'Google', where: 'Register Niko once in Google Cloud. It takes about five minutes and is free.', file: 'google-json', steps: [
    { text: 'Create a project called Niko.', link: 'https://console.cloud.google.com/projectcreate', linkLabel: 'Create project' },
    { text: 'Turn on the Gmail and Calendar APIs for it.', link: 'https://console.cloud.google.com/flows/enableapi?apiid=gmail.googleapis.com,calendar-json.googleapis.com', linkLabel: 'Turn on APIs' },
    { text: 'Set up sign-in: app name Niko, your email, audience External (that is what lets personal Gmail accounts in).', link: 'https://console.cloud.google.com/auth/overview', linkLabel: 'Set up sign-in' },
    { text: 'Under Audience, press Publish app. Left in Testing, Google signs Niko out every 7 days. When you connect, Google warns the app is unverified once: choose Advanced, then Go to Niko.', link: 'https://console.cloud.google.com/auth/audience', linkLabel: 'Open Audience' },
    { text: 'Create a client: type Web application, and add each address below under Authorised redirect URIs.', link: 'https://console.cloud.google.com/auth/clients/create', linkLabel: 'Create client', redirects: true },
    { text: 'On the screen that follows, press Download JSON (Google shows the secret only this once) and drop the file here.' },
  ], fields: [{ ...clientId, placeholder: '…apps.googleusercontent.com' }, { ...clientSecret, placeholder: 'GOCSPX-…' }] },
  { id: 'microsoft', name: 'Microsoft', where: 'Register Niko once with Microsoft. It works for Outlook.com and Hotmail as well as work accounts, and registering is free.', steps: [
    { text: 'Registering needs a Microsoft directory. A work or school account already has one. With only Outlook.com or Hotmail, create a free Azure account first: it asks for a card to confirm who you are.', link: 'https://azure.microsoft.com/free', linkLabel: 'Free Azure account' },
    { text: 'New registration: name Niko; supported accounts “Any Entra ID tenant + personal Microsoft accounts”; redirect URI type Web, with the first address below. Add any others under Authentication.', link: 'https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade', linkLabel: 'App registrations', redirects: true },
    { text: 'Certificates & secrets → New client secret. Copy its Value, not the Secret ID; it is shown only once.' },
    { text: 'From Overview, copy the Application (client) ID. Paste both below.' },
  ], fields: [
    { ...clientId, label: 'Application (client) ID', placeholder: '00000000-0000-0000-0000-000000000000' },
    { ...clientSecret, label: 'Client secret value' },
    { key: 'tenant', label: 'Directory (tenant) ID', type: 'text', placeholder: 'Leave empty', optional: true, advanced: 'Only to limit Niko to one organisation’s accounts. Leave empty for personal and work accounts.' },
  ] },
  { id: 'notion', name: 'Notion', where: 'notion.so/my-integrations → New integration → type Public.', fields: [{ ...clientId, label: 'OAuth client ID' }, { ...clientSecret, label: 'OAuth client secret' }] },
  { id: 'slack', name: 'Slack', where: 'api.slack.com/apps → Create New App → OAuth & Permissions.', fields: [clientId, clientSecret, { key: 'signingSecret', label: 'Signing secret (to receive messages)', type: 'password', optional: true }] },
];

export const GROUPS: { id: ProviderGroup; name: string; note: string }[] = [
  { id: 'mail', name: 'Mail', note: 'Read · draft · send after approval' },
  { id: 'calendar', name: 'Calendar', note: 'Read · create after approval' },
  { id: 'notes', name: 'Notes', note: 'Only what you share' },
  { id: 'automation', name: 'Automation', note: 'Run and trigger your flows' },
  { id: 'messaging', name: 'Messaging', note: 'Read · reply' },
  { id: 'ai', name: 'AI systems', note: '' },
];

export const COLOURS: Record<string, number> = { cyan: 190, violet: 262, rose: 330, amber: 32, emerald: 158 };
export const SHIFT_ORDER = ['cyan', 'violet', 'rose', 'amber', 'emerald'];

export interface Appearance { mode: 'shift' | 'single'; colours: string[]; single: string; customHue: number; seconds: number }
export type Brain = 'workers-ai' | 'custom-ai' | 'self-hosted-ai';
export interface EnginePrefs { brain: Brain; model?: 'fast' | 'large'; voice: 'elevenlabs' | 'device'; wake: boolean; onlyMyVoice: boolean; fallback: boolean; listen: 'device' }
/** Workers AI models behind the Engine screen's two choices. */
// Fallback defaults; the live fast list is AI_MODEL in apps/api/wrangler.jsonc. Each is a comma-separated, ordered list.
// Check https://developers.cloudflare.com/workers-ai/models/ for retirement dates before changing.
export const WORKERS_MODELS = { fast: '@cf/meta/llama-4-scout-17b-16e-instruct,@cf/mistralai/mistral-small-3.1-24b-instruct', large: '@cf/meta/llama-3.3-70b-instruct-fp8-fast' } as const;
export interface Permissions { draft: boolean; chatReply: boolean; files: boolean }

export interface Me {
  id: string; email: string; name: string; role: 'admin' | 'member';
  appearance: Appearance; engine: EnginePrefs; permissions: Permissions;
}

export const SEND_COUNTDOWN_SECONDS = 10;
export const MAX_RELAY_BYTES = 20 * 1024 * 1024;

export function isEmail(v: unknown): v is string {
  return typeof v === 'string' && v.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}
export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 256;

// The most common passwords that pass a 12-character minimum.
const COMMON = new Set([
  'password1234', 'password12345', 'password123456', '123456789012', '1234567890123', '12345678910', 'qwertyuiop12',
  'qwertyuiopas', 'qwerty123456', '1q2w3e4r5t6y', '1qaz2wsx3edc', 'q1w2e3r4t5y6', 'iloveyou1234', 'administrator',
  'adminadmin12', 'admin1234567', 'welcome12345', 'letmein12345', 'passw0rd1234', 'p@ssw0rd1234', 'p@ssword1234',
  'changeme1234', 'abcdefghijkl', 'abc123456789', 'aaaaaaaaaaaa', '111111111111', '000000000000', '123123123123',
  'qazwsxedcrfv', 'zaq12wsxcde3', 'trustno11234', 'football1234', 'baseball1234', 'superman1234', 'sunshine1234',
  'princess1234', 'starwars1234', 'dragon123456', 'monkey123456', 'master123456', 'whatever1234', 'nikonikoniko',
  'niko12345678', 'correcthorsebatterystaple',
]);

/** Returns a reason the password is not acceptable, or null if it is. Same policy as sxingxian.com admin accounts. */
export function passwordProblem(v: unknown, email = ''): string | null {
  if (typeof v !== 'string') return 'Enter a password.';
  const chars = [...v];
  if (chars.length < PASSWORD_MIN) return `Use at least ${PASSWORD_MIN} characters. A few unrelated words works well.`;
  if (chars.length > PASSWORD_MAX) return `Use at most ${PASSWORD_MAX} characters.`;
  if (new Set(chars).size < 5) return 'Use more varied characters.';
  const lower = v.toLowerCase();
  if (COMMON.has(lower)) return 'That password is too common. Choose another.';
  const local = email.toLowerCase().split('@')[0] ?? '';
  if (local.length >= 4 && lower.includes(local)) return 'Don’t include your email address in the password.';
  return null;
}
