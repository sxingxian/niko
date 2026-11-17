// Shared constants and types for the Niko API and front ends.
import type { AccessInfo } from './billing';
export * from './billing';
export * from './maps';
import { MAP_PROVIDERS, mapPreset, type MapProvider, type MapSource } from './maps';

export type ProviderGroup = 'mail' | 'calendar' | 'notes' | 'automation' | 'messaging' | 'weather' | 'ai';
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
  /** A short guided setup, shown when connecting. */
  steps?: AppStep[];
}

const hostField: ProviderField = { key: 'host', label: 'Server address', type: 'url', placeholder: 'https://' };
const userField: ProviderField = { key: 'username', label: 'Username', type: 'text' };
const passField: ProviderField = { key: 'password', label: 'App password', type: 'password' };
const emailField: ProviderField = { key: 'email', label: 'Email address', type: 'text', placeholder: 'you@example.com' };

export const PROVIDERS: ProviderDef[] = [
  { id: 'gmail', name: 'Gmail', group: 'mail', how: 'Google sign-in', kind: 'oauth', app: 'google', can: { read: true, send: true } },
  { id: 'gmail-imap', name: 'Gmail · app password', group: 'mail', how: 'Personal Gmail without registering a Google app · IMAP', kind: 'credentials', fields: [emailField, { ...passField, placeholder: 'xxxx xxxx xxxx xxxx' }], can: { read: true, send: true }, steps: [
    { text: 'Turn on 2-Step Verification for the Google account, if it is not on already.', link: 'https://myaccount.google.com/signinoptions/twosv', linkLabel: '2-Step Verification' },
    { text: 'Create an app password named Niko, and copy the 16 letters Google shows (only once).', link: 'https://myaccount.google.com/apppasswords', linkLabel: 'App passwords' },
    { text: 'Paste your Gmail address and the app password below. Niko reads unread mail and sends your replies; nothing is marked as read by opening it here.' },
  ] },
  { id: 'icloud-mail', name: 'iCloud Mail', group: 'mail', how: 'App-specific password · IMAP', kind: 'credentials', fields: [{ ...emailField, key: 'username', label: 'iCloud Mail address', placeholder: 'you@icloud.com' }, passField], can: { read: true, send: true }, steps: [
    { text: 'Sign in at account.apple.com, open Sign-In and Security → App-Specific Passwords, and create one named Niko.', link: 'https://account.apple.com/account/manage', linkLabel: 'Apple Account' },
    { text: 'Enter your iCloud Mail address (ending in @icloud.com, @me.com or @mac.com) and that password below. If your Apple Account uses another email, such as an Outlook address, still use the @icloud.com one: on iPhone, Settings → your name → iCloud → iCloud Mail shows it.' },
  ] },
  { id: 'outlook-mail', name: 'Outlook', group: 'mail', how: 'Microsoft sign-in', kind: 'oauth', app: 'microsoft', can: { read: true, send: true } },
  { id: 'synology-mail', name: 'Synology Mail', group: 'mail', how: 'Your NAS mail server · IMAP', kind: 'credentials', fields: [{ key: 'host', label: 'Mail server name', type: 'text', placeholder: 'mail.example.com' }, emailField, { ...userField, optional: true, placeholder: 'Only if it differs from the email address' }, passField], can: { read: true, send: true }, steps: [
    { text: 'Use the public name of your Synology MailServer, reachable from the internet with a valid certificate (IMAP on port 993, SMTP on 465). Add :143 or :587 to the name if you use those ports instead.' },
  ] },
  { id: 'imap-mail', name: 'Other email (IMAP)', group: 'mail', how: 'Yahoo, Fastmail, Zoho, your own domain · app password', kind: 'credentials', fields: [emailField, passField, { key: 'imapHost', label: 'Incoming (IMAP) server', type: 'text', placeholder: 'imap.example.com' }, { key: 'smtpHost', label: 'Outgoing (SMTP) server', type: 'text', placeholder: 'smtp.example.com' }], can: { read: true, send: true }, steps: [
    { text: 'Find your provider’s IMAP and SMTP server names in its help pages, and create an app password if it offers them. Ports 993 (IMAP) and 465 (SMTP) are assumed: add :143 or :587 if yours differ. Connections are always encrypted.' },
    { text: 'Outlook.com, Hotmail and Live addresses cannot connect this way: Microsoft switched off app passwords in 2024. Use the Outlook connection.' },
  ] },
  { id: 'google-calendar', name: 'Google Calendar', group: 'calendar', how: 'Google sign-in', kind: 'oauth', app: 'google', can: { read: true, send: false } },
  { id: 'ical', name: 'Calendar links (iCal)', group: 'calendar', how: 'Private or public calendars, no sign-in · read-only', kind: 'credentials', can: { read: true, send: false }, steps: [
    { text: 'Google: on a computer, open Google Calendar → Settings → your calendar → Integrate calendar, and copy “Secret address in iCal format” (not the public address, which only works for public calendars).', link: 'https://calendar.google.com/calendar/r/settings', linkLabel: 'Google Calendar settings' },
    { text: 'Outlook.com: Settings → Calendar → Shared calendars → Publish a calendar, choose “Can view all details”, publish, and copy the ICS link (the HTML link works too).', link: 'https://outlook.live.com/calendar/0/options/calendar/SharedCalendars', linkLabel: 'Outlook calendar settings' },
    { text: 'Public calendars (holidays, a school, a club) work too: paste their iCal address, or a public Google calendar’s ID (Settings → that calendar → Integrate calendar → Calendar ID), and choose Public.' },
    { text: 'Anyone with a private address can see that calendar, so it is stored encrypted and never shown back in full; reset it in Google or Outlook if it ever leaks. New events show within about ten minutes.' },
  ] },
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
  // Free, no key or account (non-commercial use). Your location is sent only with weather questions, rounded to about 1 km.
  { id: 'open-meteo', name: 'Open-Meteo', group: 'weather', how: 'Free forecasts, no key · weather data by Open-Meteo.com', kind: 'token', fields: [
    { key: 'home', label: 'Home place', type: 'text', optional: true, shown: true, placeholder: 'Used when location is off, such as Singapore' },
    { key: 'units', label: 'Temperature', type: 'text', optional: true, shown: true, placeholder: 'C or F · C if left empty' },
  ], steps: [
    { text: 'Ask Niko about the weather, such as “Will it rain this afternoon?” or “What’s the weather in Tokyo this weekend?”. For where you are, your browser asks once to share your location.' },
    { text: 'Your location is sent only with weather questions, rounded to about a kilometre, and is never stored. Without it, Niko uses the home place below.' },
  ], can: { read: true, send: false } },
  { id: 'workers-ai', name: 'Cloudflare Workers AI', group: 'ai', how: 'Free daily allowance', kind: 'builtin', can: { read: true, send: false } },
  { id: 'elevenlabs', name: 'ElevenLabs voice', group: 'ai', how: 'Your API key · your cloned voice', kind: 'token', hidden: true, fields: [{ key: 'apiKey', label: 'API key', type: 'password' }, { key: 'voiceId', label: 'Voice ID', type: 'text', shown: true }], can: { read: false, send: false } },
  // Keys for other AI systems are added, ordered and removed on the Engine screen, where there can be several.
  { id: 'custom-ai', name: 'Other AI systems', group: 'ai', how: 'Your API keys · OpenAI-compatible, Anthropic or Google', kind: 'token', hidden: true, fields: [
    { key: 'baseUrl', label: 'Base URL', type: 'url', placeholder: 'https://', shown: true },
    { key: 'apiKey', label: 'API key', type: 'password' },
    { key: 'model', label: 'Model name', type: 'text', shown: true },
  ], can: { read: true, send: false } },
  { id: 'self-hosted-voice', name: 'Your own voice server', group: 'ai', how: 'A speech server you run · OpenAI-compatible', kind: 'token', hidden: true, fields: [
    { key: 'baseUrl', label: 'Server address', type: 'url', placeholder: 'https://', shown: true },
    { key: 'voice', label: 'Voice name', type: 'text', optional: true, shown: true },
    { key: 'model', label: 'Model name', type: 'text', optional: true, shown: true },
    { key: 'apiKey', label: 'API key', type: 'password', optional: true },
  ], can: { read: false, send: false } },
  { id: 'self-hosted-image', name: 'Your own image server', group: 'ai', how: 'An image model server you run · OpenAI-compatible', kind: 'token', hidden: true, fields: [
    { key: 'baseUrl', label: 'Server address', type: 'url', placeholder: 'https://', shown: true },
    { key: 'model', label: 'Model name', type: 'text', optional: true, shown: true },
    { key: 'apiKey', label: 'API key', type: 'password', optional: true },
  ], can: { read: false, send: false } },
  { id: 'self-hosted-hear', name: 'Your own speech-to-text server', group: 'ai', how: 'A speech-to-text server you run · OpenAI-compatible', kind: 'token', hidden: true, fields: [
    { key: 'baseUrl', label: 'Server address', type: 'url', placeholder: 'https://', shown: true },
    { key: 'model', label: 'Model name', type: 'text', optional: true, shown: true },
    { key: 'apiKey', label: 'API key', type: 'password', optional: true },
  ], can: { read: false, send: false } },
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
  { id: 'weather', name: 'Weather', note: 'Here and anywhere you ask' },
  { id: 'ai', name: 'AI systems', note: '' },
];

export const COLOURS: Record<string, number> = { cyan: 190, violet: 262, rose: 330, amber: 32, emerald: 158 };
export const SHIFT_ORDER = ['cyan', 'violet', 'rose', 'amber', 'emerald'];

export interface Appearance { mode: 'shift' | 'single'; colours: string[]; single: string; customHue: number; seconds: number; /** Items per page in Inbox, Calendar and Notes. */ pageSize?: number; /** New items on Home. */ glance?: GlancePrefs }
export const PAGE_SIZES = [5, 10, 20, 25, 50];
export type Brain = 'workers-ai' | 'custom-ai' | 'self-hosted-ai';
/** Where Niko's speech can come from: three built in, and any number of the user's voice API keys ("vkey:<id>").
 * The device voice is not listed: it is always the last resort. */
export type VoiceSource = 'workers' | 'kokoro' | 'self-hosted' | `vkey:${string}`;
export const VOICE_SOURCES: VoiceSource[] = ['workers', 'kokoro', 'self-hosted'];
export const VOICE_ENTRY = /^(workers|kokoro|self-hosted|vkey:[a-z0-9]{1,16})$/;
export const MAX_VOICE_KEYS = 10;
/** Short names for the built-in voices, as shown on chips and in the voice list. */
export const VOICE_NAMES: Record<'workers' | 'kokoro' | 'self-hosted' | 'device', string> = { workers: 'Cloudflare voice', kokoro: 'On-device voice', 'self-hosted': 'Your voice server', device: 'Device voice' };
export const voiceName = (v: VoiceSource | 'device' | undefined) => (v && v in VOICE_NAMES ? VOICE_NAMES[v as keyof typeof VOICE_NAMES] : 'Your voice');

/** Voice services that a key can be added for. "openai" also covers any OpenAI-compatible speech API. */
export type VoiceProvider = 'openai' | 'elevenlabs' | 'google' | 'azure' | 'deepgram' | 'cartesia' | 'fishaudio';
/** A saved voice key as the Voice screen sees it: everything except the key itself. */
export interface VoiceKeyInfo { id: string; label: string; provider: VoiceProvider; voice: string; model: string; baseUrl: string; region: string }
export const VOICE_PROVIDERS: { id: string; provider: VoiceProvider; name: string; baseUrl?: string; models?: string[]; voices?: { id: string; name: string }[]; note: string }[] = [
  { id: 'openai', provider: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', models: ['gpt-4o-mini-tts', 'tts-1', 'tts-1-hd'],
    voices: ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse'].map((v) => ({ id: v, name: v[0]!.toUpperCase() + v.slice(1) })),
    note: 'Natural voices, paid per character. Keys from platform.openai.com.' },
  { id: 'elevenlabs', provider: 'elevenlabs', name: 'ElevenLabs', models: ['eleven_flash_v2_5', 'eleven_turbo_v2_5', 'eleven_multilingual_v2'], note: 'Very natural, and your own cloned voices. Its free plan refuses cloud servers such as Niko’s; a paid plan works. The key needs Text to Speech and Voices permissions.' },
  { id: 'google', provider: 'google', name: 'Google Cloud', note: 'Many languages. Uses an API key with the Cloud Text-to-Speech API enabled; a free monthly allowance applies.' },
  { id: 'azure', provider: 'azure', name: 'Microsoft Azure', note: 'Many languages and neural voices. Uses a Speech resource key and its region; a free monthly allowance applies.' },
  { id: 'deepgram', provider: 'deepgram', name: 'Deepgram', voices: ['thalia', 'andromeda', 'helena', 'apollo', 'arcas', 'aries', 'asteria', 'athena', 'hera', 'luna', 'orion', 'orpheus', 'zeus'].map((v) => ({ id: `aura-2-${v}-en`, name: v[0]!.toUpperCase() + v.slice(1) })),
    note: 'Fast, natural English voices (Aura 2), with free credit when you sign up.' },
  { id: 'fishaudio', provider: 'fishaudio', name: 'Fish Audio', models: ['s2-pro', 's2.1-pro-free', 's1'], note: 'Natural, expressive voices and your own cloned voices; voices are listed from your Fish Audio account (or popular ones if you have none). Leave the voice empty for its default. A new account without credit needs the s2.1-pro-free model.' },
  { id: 'cartesia', provider: 'cartesia', name: 'Cartesia', models: ['sonic-3.5', 'sonic-3', 'sonic-latest'], note: 'Very fast, natural voices, with a free monthly allowance.' },
  { id: 'other', provider: 'openai', name: 'Other (OpenAI-compatible)', note: 'Any speech service with an OpenAI-compatible API, such as Groq or a hosted Kokoro.' },
];
/** Where speech in (your voice, turned into text) can come from: Cloudflare's own, or any number of the user's
 * speech-to-text keys ("skey:<id>"). The device's own speech recognition is always last, and always listens for "Niko". */
export type HearSource = 'workers' | 'self-hosted' | `skey:${string}`;
export const HEAR_ENTRY = /^(workers|self-hosted|skey:[a-z0-9]{1,16})$/;
export type HearProvider = 'openai' | 'deepgram' | 'elevenlabs' | 'fishaudio' | 'google' | 'azure';
export interface HearKeyInfo { id: string; label: string; provider: HearProvider; model: string; baseUrl: string; region: string }
export const HEAR_PROVIDERS: { id: string; provider: HearProvider; name: string; baseUrl?: string; models?: string[]; note: string }[] = [
  { id: 'openai', provider: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', models: ['gpt-4o-mini-transcribe', 'gpt-4o-transcribe', 'whisper-1'], note: 'Accurate in many languages, paid per minute.' },
  { id: 'groq', provider: 'openai', name: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', models: ['whisper-large-v3-turbo', 'whisper-large-v3'], note: 'Very fast Whisper, with a free allowance.' },
  { id: 'deepgram', provider: 'deepgram', name: 'Deepgram', models: ['nova-3', 'nova-2'], note: 'Fast and accurate, with free credit when you sign up.' },
  { id: 'elevenlabs', provider: 'elevenlabs', name: 'ElevenLabs', models: ['scribe_v1'], note: 'Scribe, accurate in many languages. Needs a paid plan from cloud servers such as Niko’s.' },
  { id: 'fishaudio', provider: 'fishaudio', name: 'Fish Audio', note: 'Fish Audio’s speech recognition, with the same key as its voices.' },
  { id: 'google', provider: 'google', name: 'Google Cloud', models: ['latest_short', 'default'], note: 'Uses an API key with the Cloud Speech-to-Text API enabled; a free monthly allowance applies.' },
  { id: 'azure', provider: 'azure', name: 'Microsoft Azure', note: 'Uses a Speech resource key and its region; a free monthly allowance applies.' },
  { id: 'other', provider: 'openai', name: 'Other (OpenAI-compatible)', note: 'Any speech-to-text service with an OpenAI-compatible API.' },
];
export function hearPresetOf(k: { provider: HearProvider; baseUrl: string }): string {
  if (k.provider !== 'openai') return k.provider;
  const b = k.baseUrl.trim().replace(/\/+$/, '').toLowerCase();
  return HEAR_PROVIDERS.find((p) => p.baseUrl && p.baseUrl.toLowerCase() === b)?.id ?? 'other';
}
export const MAX_HEAR_KEYS = 10;
/** The speech-in services to try, in order, before the device's own recognition. */
export function hearOrder(e: Partial<EnginePrefs> | undefined): HearSource[] {
  return Array.isArray(e?.hears) ? [...new Set(e!.hears.map(String).filter((v) => HEAR_ENTRY.test(v)))] as HearSource[] : [];
}

/** Where Niko's pictures come from: Cloudflare's own (FLUX.1 schnell, on the free daily allowance), or any number of
 * the user's image keys ("ikey:<id>"), tried in the order set on the Engine screen. */
export type ImageSource = 'workers' | 'self-hosted' | `ikey:${string}`;
export const IMAGE_ENTRY = /^(workers|self-hosted|ikey:[a-z0-9]{1,16})$/;
export const MAX_IMAGE_KEYS = 10;
/** Image services a key can be added for. "openai" also covers any service with an OpenAI-compatible images API. */
export type ImageProvider = 'openai' | 'google' | 'stability' | 'fal' | 'replicate' | 'bfl' | 'ideogram';
export interface ImageKeyInfo { id: string; label: string; provider: ImageProvider; model: string; baseUrl: string }
/** The shape of a picture: square unless the user asks for a wide or tall one. */
export type ImageShape = 'square' | 'wide' | 'tall';
export const IMAGE_PROVIDERS: { id: string; provider: ImageProvider; name: string; baseUrl?: string; models: string[]; modelLabel?: string; note: string }[] = [
  { id: 'openai', provider: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', models: ['gpt-image-2', 'gpt-image-1.5', 'gpt-image-1-mini', 'gpt-image-1'], note: 'GPT Image: very good at following detailed requests and drawing text. Paid per image; keys from platform.openai.com.' },
  { id: 'google', provider: 'google', name: 'Google Gemini', models: ['gemini-2.5-flash-image', 'gemini-3.1-flash-image-preview', 'gemini-3-pro-image-preview', 'imagen-4.0-generate-001', 'imagen-4.0-fast-generate-001'], note: 'Gemini image models (“Nano Banana”) and Imagen. Uses a Gemini API key from aistudio.google.com; image models need billing on the key.' },
  { id: 'stability', provider: 'stability', name: 'Stability AI', models: ['core', 'ultra', 'sd3.5-large', 'sd3.5-large-turbo', 'sd3.5-medium'], note: 'Stable Image Core, Ultra and Stable Diffusion 3.5. Paid with credits; keys from platform.stability.ai.' },
  { id: 'bfl', provider: 'bfl', name: 'Black Forest Labs', models: ['flux-2-pro', 'flux-pro-1.1', 'flux-pro-1.1-ultra', 'flux-kontext-pro', 'flux-dev'], note: 'FLUX, from the people who made it. Paid with credits; keys from dashboard.bfl.ai.' },
  { id: 'fal', provider: 'fal', name: 'fal', models: ['fal-ai/flux/schnell', 'fal-ai/flux/dev', 'fal-ai/flux-pro/v1.1', 'fal-ai/flux-pro/v1.1-ultra', 'fal-ai/imagen4/preview'], note: 'Hundreds of image models behind one key: write the model’s id as fal lists it. Keys from fal.ai/dashboard/keys.' },
  { id: 'replicate', provider: 'replicate', name: 'Replicate', models: ['black-forest-labs/flux-schnell', 'black-forest-labs/flux-dev', 'black-forest-labs/flux-1.1-pro', 'ideogram-ai/ideogram-v3-turbo', 'google/imagen-4'], note: 'Many image models behind one key: write the model as owner/name, as Replicate lists it. Tokens from replicate.com/account/api-tokens.' },
  { id: 'ideogram', provider: 'ideogram', name: 'Ideogram', models: ['TURBO', 'DEFAULT', 'QUALITY'], modelLabel: 'Speed', note: 'Ideogram 3.0, strong at posters, logos and lettering. Keys from ideogram.ai’s API settings.' },
  { id: 'xai', provider: 'openai', name: 'xAI', baseUrl: 'https://api.x.ai/v1', models: ['grok-imagine-image', 'grok-imagine-image-2.0'], note: 'Grok Imagine. Keys from console.x.ai.' },
  { id: 'together', provider: 'openai', name: 'Together AI', baseUrl: 'https://api.together.xyz/v1', models: ['black-forest-labs/FLUX.1-schnell', 'black-forest-labs/FLUX.1.1-pro', 'black-forest-labs/FLUX.2-dev'], note: 'FLUX and other open models, paid per image. Keys from api.together.ai.' },
  { id: 'recraft', provider: 'openai', name: 'Recraft', baseUrl: 'https://external.api.recraft.ai/v1', models: ['recraftv3'], note: 'Illustration, icons and design styles. Keys from recraft.ai’s API page.' },
  { id: 'other', provider: 'openai', name: 'Other (OpenAI-compatible)', models: [], note: 'Any image service with an OpenAI-compatible images API.' },
];
export function imagePresetOf(k: { provider: ImageProvider; baseUrl: string }): string {
  if (k.provider !== 'openai') return k.provider;
  const b = k.baseUrl.trim().replace(/\/+$/, '').toLowerCase();
  return IMAGE_PROVIDERS.find((p) => p.provider === 'openai' && p.baseUrl && p.baseUrl.toLowerCase() === b)?.id ?? 'other';
}
/** The image services to try, in order. Cloudflare's alone until the user sets an order. */
export function imageOrder(e: Partial<EnginePrefs> | undefined): ImageSource[] {
  return Array.isArray(e?.images) ? [...new Set(e!.images.map(String).filter((v) => IMAGE_ENTRY.test(v)))] as ImageSource[] : ['workers'];
}

export function voicePresetOf(k: { provider: VoiceProvider; baseUrl: string }): string {
  if (k.provider !== 'openai') return k.provider;
  return k.baseUrl.trim().replace(/\/+$/, '').toLowerCase() === 'https://api.openai.com/v1' ? 'openai' : 'other';
}
/** The default order: Cloudflare's voice, then the device voice. */
export const DEFAULT_VOICES: VoiceSource[] = ['workers'];

/** Cloudflare Workers AI voices. MeloTTS costs almost nothing of the daily allowance; Deepgram Aura sounds more natural but uses far more. */
export const WORKERS_VOICES: { id: string; name: string; model: string; speaker?: string }[] = [
  { id: 'melo', name: 'Standard (MeloTTS)', model: '@cf/myshell-ai/melotts' },
  ...([['asteria', 'Asteria · American'], ['luna', 'Luna · American'], ['stella', 'Stella · American'], ['hera', 'Hera · American'], ['athena', 'Athena · British'],
    ['orion', 'Orion · American'], ['arcas', 'Arcas · American'], ['perseus', 'Perseus · American'], ['orpheus', 'Orpheus · American'], ['zeus', 'Zeus · American'], ['helios', 'Helios · British'], ['angus', 'Angus · Irish']] as const)
    .map(([speaker, name]) => ({ id: 'aura:' + speaker, name: `Natural · ${name} (Aura)`, model: '@cf/deepgram/aura-1', speaker })),
];

/** Kokoro voices that run on the device (the higher-rated English ones). */
export const KOKORO_VOICES: { id: string; name: string }[] = [
  ['af_heart', 'Heart · American'], ['af_bella', 'Bella · American'], ['af_nicole', 'Nicole · American, soft'], ['af_aoede', 'Aoede · American'], ['af_kore', 'Kore · American'], ['af_sarah', 'Sarah · American'],
  ['am_fenrir', 'Fenrir · American'], ['am_michael', 'Michael · American'], ['am_puck', 'Puck · American'],
  ['bf_emma', 'Emma · British'], ['bf_isabella', 'Isabella · British'], ['bm_george', 'George · British'], ['bm_fable', 'Fable · British'],
].map(([id, name]) => ({ id: id!, name: name! }));

/** One way for Niko to think, in the Engine screen's order: Workers AI, your model server, or one of your saved AI keys ("key:<id>"). */
export type BrainEntry = 'workers-ai' | 'self-hosted-ai' | `key:${string}`;
/** Why a brain is being skipped for now, and until when (ms since 1970). Set by the server only. */
export interface BrainRest { until: number; why: 'limit' | 'refused' | 'down' }
/** A saved AI key as the Engine screen sees it: everything except the key itself. */
export interface AiKeyInfo { id: string; label: string; provider: 'openai' | 'anthropic' | 'google'; baseUrl: string; model: string }
export const MAX_AI_KEYS = 10;
/** Model names that are not chat models (safety checkers, speech, embeddings, images), which can't answer as Niko. */
export const NOT_CHAT = /(guard|safeguard|whisper|tts|speech|embed|moderation|playai|orpheus|dall-e|image|imagen|audio|transcri|realtime|rerank|veo)/i;
/** Providers offered on the Engine screen. All but Anthropic and Google speak the OpenAI chat format. */
export const AI_PRESETS: { id: string; name: string; baseUrl: string; example: string }[] = [
  { id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', example: 'gpt-4.1-mini' },
  { id: 'google', name: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', example: 'gemini-2.5-flash' },
  { id: 'anthropic', name: 'Anthropic', baseUrl: 'https://api.anthropic.com/v1', example: 'claude-haiku-4-5' },
  { id: 'groq', name: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', example: 'llama-3.3-70b-versatile' },
  { id: 'openrouter', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', example: 'meta-llama/llama-3.3-70b-instruct' },
  { id: 'mistral', name: 'Mistral', baseUrl: 'https://api.mistral.ai/v1', example: 'mistral-small-latest' },
  { id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', example: 'deepseek-chat' },
  { id: 'other', name: 'Other (OpenAI-compatible)', baseUrl: '', example: '' },
];
export function presetOf(baseUrl: string): string {
  const clean = (u: string) => u.trim().replace(/\/+$/, '').toLowerCase();
  return AI_PRESETS.find((p) => p.baseUrl && clean(p.baseUrl) === clean(baseUrl))?.id ?? 'other';
}
export const BRAIN_ENTRY = /^(workers-ai|self-hosted-ai|key:[a-z0-9]{1,16})$/;

export interface EnginePrefs {
  /** The first brain's kind, kept for older screens; the order in `brains` is what is used. */
  brain: Brain; model?: 'fast' | 'large';
  /** The brains to try, in order. When one reaches its usage limit or fails, the next one answers. */
  brains?: BrainEntry[];
  rest?: Record<string, BrainRest>;
  /** Older single choice, kept so accounts saved before the voice order still work. */
  voice?: 'elevenlabs' | 'device';
  /** The voices to try, in order; the device voice always comes after them. */
  voices?: VoiceSource[];
  /** Voices being skipped for now (usage limit, refused key, no answer), and until when. Set by the server only. */
  voiceRest?: Record<string, BrainRest>;
  /** Speech-in services to try, in order; the device's own recognition comes after them. */
  hears?: HearSource[];
  hearRest?: Record<string, BrainRest>;
  /** Image services to try, in order. Empty: pictures are switched off. */
  images?: ImageSource[];
  imageRest?: Record<string, BrainRest>;
  /** Map services to try, in order, everywhere ("osm" is the built-in OpenStreetMap map). */
  maps?: MapSource[];
  /** Countries with their own map service lists (ISO 3166 two-letter codes), tried before the Everywhere list there. */
  mapCountries?: Record<string, MapSource[]>;
  mapRest?: Record<string, BrainRest>;
  workersVoice?: string;
  kokoroVoice?: string;
  wake: boolean; onlyMyVoice: boolean; fallback: boolean; listen: 'device';
}

/** The order to try voices in, for accounts saved before and after the voice order existed. */
export function voiceOrder(e: Partial<EnginePrefs> | undefined): VoiceSource[] {
  // An ElevenLabs key saved before there could be several is read as voice key "el1".
  const up = (v: string) => (v === 'elevenlabs' ? 'vkey:el1' : v);
  if (Array.isArray(e?.voices)) return [...new Set(e!.voices.map((v) => up(String(v))).filter((v) => VOICE_ENTRY.test(v)))] as VoiceSource[];
  return e?.voice === 'elevenlabs' ? ['vkey:el1', 'workers'] : [...DEFAULT_VOICES];
}
/** The order to try brains in, for accounts saved before and after the order existed. */
export function brainOrder(e: Partial<EnginePrefs> | undefined): BrainEntry[] {
  if (Array.isArray(e?.brains)) return [...new Set(e!.brains.filter((b) => BRAIN_ENTRY.test(String(b))))] as BrainEntry[];
  // Before the order: one chosen brain, then Workers AI unless the fallback was switched off. A key saved then is "k1".
  const first: BrainEntry = e?.brain === 'custom-ai' ? 'key:k1' : e?.brain === 'self-hosted-ai' ? 'self-hosted-ai' : 'workers-ai';
  return first !== 'workers-ai' && e?.fallback !== false ? [first, 'workers-ai'] : [first];
}
export const brainKind = (b: BrainEntry | undefined): Brain => (!b || b === 'workers-ai' ? 'workers-ai' : b === 'self-hosted-ai' ? 'self-hosted-ai' : 'custom-ai');
/** Where a key's address points, which decides how Niko talks to it. */
export function aiProviderOf(baseUrl?: string): AiKeyInfo['provider'] {
  try { const h = new URL(baseUrl ?? '').hostname; return h.endsWith('anthropic.com') ? 'anthropic' : h === 'generativelanguage.googleapis.com' ? 'google' : 'openai'; } catch { return 'openai'; }
}
/** Workers AI models behind the Engine screen's two choices. */
// Fallback defaults; the live fast list is AI_MODEL in apps/api/wrangler.jsonc. Each is a comma-separated, ordered list.
// Check https://developers.cloudflare.com/workers-ai/models/ for retirement dates before changing.
export const WORKERS_MODELS = { fast: '@cf/meta/llama-4-scout-17b-16e-instruct,@cf/mistralai/mistral-small-3.1-24b-instruct', large: '@cf/meta/llama-3.3-70b-instruct-fp8-fast' } as const;
export interface Permissions { draft: boolean; chatReply: boolean; files: boolean }

// ---------------------------------------------------------------- AI options the admin controls
// Every AI option on the Engine and Voice screens has a stable id. The admin sets which are on for everyone (the
// default) and can change that for any one account. Options that are off are hidden from that account's screens and
// refused by the server; keys already saved for them are kept and skipped. Admins always have every option.
// The device's own voice and speech recognition are never listed: they are the last resort and always on.
export interface AiOptionGroup { id: 'brain' | 'images' | 'maps' | 'voices' | 'hears'; name: string; where: string; section?: string; items: { key: string; name: string; sub: string }[] }
const BUILTIN = 'Built in · free daily allowance', THEIRS = 'Their API key', SERVER = 'A server they run';
export const AI_OPTION_GROUPS: AiOptionGroup[] = [
  { id: 'brain', name: 'Brain', where: 'Engine screen', items: [
    { key: 'workers-ai', name: 'Cloudflare Workers AI', sub: BUILTIN }, { key: 'self-hosted-ai', name: 'Their own model server', sub: SERVER },
    ...AI_PRESETS.map((p) => ({ key: `ai:${p.id}`, name: p.name, sub: p.id === 'other' ? 'Any address they enter' : THEIRS })) ] },
  { id: 'images', name: 'Pictures', where: 'Engine screen', section: 'sec:images', items: [
    { key: 'img:workers', name: 'Cloudflare FLUX', sub: BUILTIN }, { key: 'img:self-hosted', name: 'Their own image server', sub: SERVER },
    ...IMAGE_PROVIDERS.map((p) => ({ key: `img:${p.id}`, name: p.name, sub: p.id === 'other' ? 'Any address they enter' : THEIRS })) ] },
  { id: 'maps', name: 'Maps', where: 'Engine screen', section: 'sec:maps', items: [
    { key: 'map:osm', name: 'OpenStreetMap', sub: 'Built in · no key' },
    ...MAP_PROVIDERS.map((p) => ({ key: `map:${p.id}`, name: p.name, sub: p.id === 'self-hosted' ? SERVER : THEIRS })) ] },
  { id: 'voices', name: 'Speech out', where: 'Voice screen', section: 'sec:voices', items: [
    { key: 'v:workers', name: 'Cloudflare voice', sub: BUILTIN }, { key: 'v:kokoro', name: 'On-device voice', sub: 'Runs on their device' }, { key: 'v:self-hosted', name: 'Their own voice server', sub: SERVER },
    ...VOICE_PROVIDERS.map((p) => ({ key: `v:${p.id}`, name: p.name, sub: p.id === 'other' ? 'Any address they enter' : THEIRS })) ] },
  { id: 'hears', name: 'Listening · speech in', where: 'Voice screen', section: 'sec:hears', items: [
    { key: 'h:workers', name: 'Cloudflare speech recognition', sub: BUILTIN }, { key: 'h:self-hosted', name: 'Their own speech-to-text server', sub: SERVER },
    ...HEAR_PROVIDERS.map((p) => ({ key: `h:${p.id}`, name: p.name, sub: p.id === 'other' ? 'Any address they enter' : THEIRS })) ] },
];
export const AI_OPTION_KEYS: string[] = AI_OPTION_GROUPS.flatMap((g) => [...(g.section ? [g.section] : []), ...g.items.map((i) => i.key)]);
/** Keeps only known options with true/false values. */
export function cleanAiAccess(v: unknown): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  if (v && typeof v === 'object') for (const [k, x] of Object.entries(v as Record<string, unknown>)) if (AI_OPTION_KEYS.includes(k) && typeof x === 'boolean') out[k] = x;
  return out;
}
/** The options that are off for an account: its own changes over the default (missing means on). Admins: none. */
export function aiOff(defaults: Record<string, boolean>, own: Record<string, boolean>, isAdmin = false): string[] {
  if (isAdmin) return [];
  return AI_OPTION_KEYS.filter((k) => (k in own ? own[k] : defaults[k] ?? true) === false);
}
/** Whether an option is usable, given the list of options that are off. A section that is off turns off all of it. */
export function aiAllowed(off: readonly string[], key: string): boolean {
  if (off.includes(key)) return false;
  const g = AI_OPTION_GROUPS.find((x) => x.items.some((i) => i.key === key));
  return !(g?.section && off.includes(g.section));
}
/** At least one brain must stay on for an account, or Niko could not answer. */
export const aiHasBrain = (off: readonly string[]) => AI_OPTION_GROUPS[0]!.items.some((i) => !off.includes(i.key));
/** Which option a brain, image, voice or speech-in entry belongs to; keys go by the service they were saved for. */
export const brainOption = (entry: string, baseUrl?: string) => (entry === 'workers-ai' || entry === 'self-hosted-ai' ? entry : `ai:${presetOf(baseUrl ?? '')}`);
export const imageOption = (entry: string, k?: { provider: ImageProvider; baseUrl: string }) => (entry === 'workers' || entry === 'self-hosted' ? `img:${entry}` : `img:${k ? imagePresetOf(k) : 'other'}`);
export const mapOption = (entry: string, k?: { provider: MapProvider }) => (entry === 'osm' ? 'map:osm' : `map:${k && mapPreset(k.provider) ? k.provider : 'self-hosted'}`);
export const voiceOption = (entry: string, k?: { provider: VoiceProvider; baseUrl: string }) => (entry === 'workers' || entry === 'kokoro' || entry === 'self-hosted' ? `v:${entry}` : `v:${k ? voicePresetOf(k) : 'other'}`);
export const hearOption = (entry: string, k?: { provider: HearProvider; baseUrl: string }) => (entry === 'workers' || entry === 'self-hosted' ? `h:${entry}` : `h:${k ? hearPresetOf(k) : 'other'}`);

export interface Me {
  id: string; email: string; name: string; role: 'admin' | 'member';
  appearance: Appearance; engine: EnginePrefs; permissions: Permissions;
  /** A weather service is connected, so weather questions may carry the device's rounded location. */
  weather?: boolean;
  /** AI options the admin has turned off for this account (hidden here, refused by the server). */
  aiOff?: string[];
  /** The admin's limits for new items on Home, as they apply to this account. */
  glanceLimits?: GlanceLimits;
  /** Whether this account may use Niko now (paid time, a plan, lifetime or admin), and the plans it can choose. */
  access?: AccessInfo;
}

/** Whether a message is about the weather. Only then is the device's location asked for and sent. */
export function isWeatherQuestion(text: string): boolean {
  return /\b(weather|forecast|rain(ing|y)?|drizzl(e|ing|y)|showers?|storms?|stormy|thunder(storms?)?|snow(ing)?|sunny|sunshine|cloudy|umbrella|temperature|degrees|hot|cold|warm|chilly|humid(ity)?|wind(y)?|uv|heatwave|typhoon|monsoon|haze|fog(gy)?)\b/i.test(text);
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

// ---------------------------------------------------------------- the brief, and what opens from it
export interface MailItem { id: string; from: string; subject: string; source: string; provider: string }
export interface EventItem { id: string; provider: string; time: string; title: string; source: string; start: number; allDay?: boolean }
export interface NoteItem { id: string; provider: string; title: string; source: string; edited?: number; /** Last changed by the person themselves (where the service says so). */ byMe?: boolean }
export interface ChatItem { provider: string; chatId: string; title: string; last: string; source: string; lastAt?: number }
/** The parts of the briefing, so each screen asks only for its own: Inbox = mail + chats, Calendar = events, Notes = notes. */
export type BriefPart = 'mail' | 'events' | 'notes' | 'chats';
export const BRIEF_PARTS: BriefPart[] = ['mail', 'events', 'notes', 'chats'];
/** A source that couldn't be read, tagged with the part it belongs to so it only shows on that part's screen. */
export interface BriefProblem { part: BriefPart; source: string; text: string }
export interface Brief { mail: MailItem[]; events: EventItem[]; notes: NoteItem[]; chats: ChatItem[]; problems: BriefProblem[] }

/** One block of a note's content, as plain text: Niko never renders a provider's HTML. */
export interface DocBlock { kind: 'h1' | 'h2' | 'h3' | 'p' | 'li' | 'ol' | 'todo' | 'quote' | 'code' | 'hr' | 'prop'; text: string; done?: boolean; depth?: number; label?: string }
export interface NoteDetail { title: string; source: string; url?: string; edited?: number; blocks: DocBlock[]; more?: boolean }
export interface MailDetail { from: string; to: string; subject: string; date?: number; text: string; url?: string }
export interface EventDetail { title: string; source: string; start: number; end?: number; allDay?: boolean; location?: string; description?: string; attendees?: string[]; url?: string }

// ---------------------------------------------------------------- new items on Home ("glance")
// While Home is open and on screen, Niko checks for new email, messages, calendar invitations and changed notes, and
// shows each new one for 30 seconds. Each person chooses how often each kind is checked; the admin sets the most often
// allowed (for everyone, or for one account) and whether the feature is available at all. The server checks a source
// only when it is due under both, so the limits hold whatever the browser sends.
export type GlancePart = 'mail' | 'chats' | 'events' | 'notes';
export const GLANCE_PARTS: GlancePart[] = ['mail', 'chats', 'events', 'notes'];
export const GLANCE_PART_NAMES: Record<GlancePart, string> = { mail: 'Emails', chats: 'Messages', events: 'Calendar', notes: 'Notes' };
// ---- Account limits (set by the admin: a default for everyone, and changes for any one account)
/** Calendar links: each one is downloaded and unpacked when Niko builds the day, so their number is capped. */
export const CALENDAR_LIMIT_DEFAULT = 20, CALENDAR_LIMIT_MAX = 50;
export const CALENDAR_LIMIT_STEPS = [1, 3, 5, 10, 15, 20, 30, 40, 50];
export interface AccountLimits { calendars: number }
export function cleanAccountLimits(v: unknown): Partial<AccountLimits> {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  return typeof o.calendars === 'number' && CALENDAR_LIMIT_STEPS.includes(o.calendars) ? { calendars: o.calendars } : {};
}
export function accountLimits(defaults: Partial<AccountLimits>, own: Partial<AccountLimits>): AccountLimits {
  return { calendars: CALENDAR_LIMIT_DEFAULT, ...defaults, ...own };
}
/** One saved calendar link, as shown to its owner. A private address is shown only as its server and file name. */
export interface CalendarLink { id: string; name: string; kind: 'private' | 'public'; on: boolean; address: string }

/** Check intervals offered, in minutes. */
export const GLANCE_STEPS = [1, 2, 5, 10, 15, 30, 60];
export const GLANCE_REMIND_STEPS = [5, 10, 15, 30];
/** The admin's limits: whether the feature is available, and the most often each kind may be checked (minutes; 0 = not allowed). */
export interface GlanceLimits { allowed: boolean; mail: number; chats: number; events: number; notes: number }
export const GLANCE_LIMIT_DEFAULTS: GlanceLimits = { allowed: true, mail: 2, chats: 1, events: 5, notes: 5 };
/** A person's own choices: off by default; how often each kind is checked (minutes; 0 = off); the reminder lead time. */
export interface GlancePrefs { on: boolean; aloud: boolean; mail: number; chats: number; events: number; notes: number; remind: number }
export const GLANCE_PREF_DEFAULTS: GlancePrefs = { on: false, aloud: false, mail: 5, chats: 1, events: 10, notes: 10, remind: 10 };
const step = (v: unknown, steps: number[], allowZero = true) => (typeof v === 'number' && ((allowZero && v === 0) || steps.includes(v)) ? v : undefined);
/** Keeps only valid admin limits (for a stored default or one account's changes). */
export function cleanGlanceLimits(v: unknown): Partial<GlanceLimits> {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>, out: Partial<GlanceLimits> = {};
  if (typeof o.allowed === 'boolean') out.allowed = o.allowed;
  for (const p of GLANCE_PARTS) { const n = step(o[p], GLANCE_STEPS); if (n !== undefined) out[p] = n; }
  return out;
}
/** The limits that apply to an account: its own changes over the default over the built-in defaults. */
export function glanceLimits(defaults: Partial<GlanceLimits>, own: Partial<GlanceLimits>): GlanceLimits {
  return { ...GLANCE_LIMIT_DEFAULTS, ...defaults, ...own };
}
export function cleanGlancePrefs(v: unknown): GlancePrefs {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>, d = GLANCE_PREF_DEFAULTS;
  return {
    on: typeof o.on === 'boolean' ? o.on : d.on, aloud: typeof o.aloud === 'boolean' ? o.aloud : d.aloud,
    mail: step(o.mail, GLANCE_STEPS) ?? d.mail, chats: step(o.chats, GLANCE_STEPS) ?? d.chats, events: step(o.events, GLANCE_STEPS) ?? d.events, notes: step(o.notes, GLANCE_STEPS) ?? d.notes,
    remind: step(o.remind, GLANCE_REMIND_STEPS) ?? d.remind,
  };
}
/** How often a kind is actually checked, in minutes (0 = not at all): the person's choice, but never more often than the admin allows. */
export function glanceEvery(prefs: GlancePrefs, limits: GlanceLimits, part: GlancePart): number {
  if (!prefs.on || !limits.allowed || !limits[part] || !prefs[part]) return 0;
  return Math.max(prefs[part], limits[part]);
}
/** One new thing to show on Home. `key` identifies it, so it is shown once only. */
export interface GlanceItem {
  key: string; kind: 'mail' | 'chat' | 'invite' | 'reminder' | 'note'; title: string; line: string; source: string; at: number;
  /** Where it opens, and the title to open it by. */ view: 'inbox' | 'calendar' | 'notes'; open: string; canReply?: boolean;
}
