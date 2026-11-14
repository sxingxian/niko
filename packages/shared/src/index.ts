// Shared constants and types for the Niko API and front ends.

export type ProviderGroup = 'mail' | 'calendar' | 'notes' | 'automation' | 'messaging' | 'ai';
export type ConnectKind = 'oauth' | 'credentials' | 'token' | 'webhook' | 'builtin' | 'planned';

export interface ProviderField { key: string; label: string; type: 'text' | 'password' | 'url'; placeholder?: string }
export interface ProviderDef {
  id: string;
  name: string;
  group: ProviderGroup;
  how: string;
  kind: ConnectKind;
  fields?: ProviderField[];
  /** What the current code can actually do with this connection. */
  can: { read: boolean; send: boolean };
}

const hostField: ProviderField = { key: 'host', label: 'Server address', type: 'url', placeholder: 'https://' };
const userField: ProviderField = { key: 'username', label: 'Username', type: 'text' };
const passField: ProviderField = { key: 'password', label: 'App password', type: 'password' };

export const PROVIDERS: ProviderDef[] = [
  { id: 'gmail', name: 'Gmail', group: 'mail', how: 'Google sign-in', kind: 'oauth', can: { read: true, send: true } },
  { id: 'icloud-mail', name: 'iCloud Mail', group: 'mail', how: 'App-specific password · IMAP', kind: 'credentials', fields: [userField, passField], can: { read: false, send: false } },
  { id: 'outlook-mail', name: 'Outlook', group: 'mail', how: 'Microsoft sign-in', kind: 'oauth', can: { read: true, send: true } },
  { id: 'synology-mail', name: 'Synology Mail', group: 'mail', how: 'Your NAS address · IMAP', kind: 'credentials', fields: [hostField, userField, passField], can: { read: false, send: false } },
  { id: 'google-calendar', name: 'Google Calendar', group: 'calendar', how: 'Google sign-in', kind: 'oauth', can: { read: true, send: false } },
  { id: 'apple-calendar', name: 'Apple Calendar', group: 'calendar', how: 'App-specific password · CalDAV', kind: 'credentials', fields: [userField, passField], can: { read: false, send: false } },
  { id: 'outlook-calendar', name: 'Outlook Calendar', group: 'calendar', how: 'Microsoft sign-in', kind: 'oauth', can: { read: true, send: false } },
  { id: 'synology-calendar', name: 'Synology Calendar', group: 'calendar', how: 'Your NAS address · CalDAV', kind: 'credentials', fields: [hostField, userField, passField], can: { read: false, send: false } },
  { id: 'notion', name: 'Notion', group: 'notes', how: 'Notion sign-in · pages you pick', kind: 'oauth', can: { read: true, send: false } },
  { id: 'onenote', name: 'OneNote', group: 'notes', how: 'Microsoft sign-in', kind: 'oauth', can: { read: true, send: false } },
  { id: 'make', name: 'Make.com', group: 'automation', how: 'Signed webhooks, in and out', kind: 'webhook', fields: [{ key: 'url', label: 'Webhook URL', type: 'url', placeholder: 'https://hook.' }], can: { read: false, send: true } },
  { id: 'n8n', name: 'n8n', group: 'automation', how: 'Webhooks · your n8n server', kind: 'webhook', fields: [{ key: 'url', label: 'Webhook URL', type: 'url', placeholder: 'https://' }], can: { read: false, send: true } },
  { id: 'power-automate', name: 'Power Automate', group: 'automation', how: 'HTTP trigger URL · your flows', kind: 'webhook', fields: [{ key: 'url', label: 'HTTP trigger URL', type: 'url', placeholder: 'https://' }], can: { read: false, send: true } },
  { id: 'telegram-bot', name: 'Telegram bot', group: 'messaging', how: 'Bot token · chats with your Niko bot', kind: 'token', fields: [{ key: 'token', label: 'Bot token', type: 'password' }], can: { read: true, send: true } },
  { id: 'telegram-user', name: 'Telegram personal account', group: 'messaging', how: 'Sign in with your number · all your chats', kind: 'planned', can: { read: false, send: false } },
  { id: 'slack', name: 'Slack', group: 'messaging', how: 'Slack sign-in · channels you pick', kind: 'oauth', can: { read: true, send: true } },
  { id: 'discord', name: 'Discord', group: 'messaging', how: 'Bot token · servers you pick', kind: 'token', fields: [{ key: 'token', label: 'Bot token', type: 'password' }, { key: 'channelId', label: 'Default channel ID', type: 'text' }], can: { read: false, send: true } },
  { id: 'workers-ai', name: 'Cloudflare Workers AI', group: 'ai', how: 'Free daily allowance', kind: 'builtin', can: { read: true, send: false } },
  { id: 'elevenlabs', name: 'ElevenLabs voice', group: 'ai', how: 'Your API key · your cloned voice', kind: 'token', fields: [{ key: 'apiKey', label: 'API key', type: 'password' }, { key: 'voiceId', label: 'Voice ID', type: 'text' }], can: { read: false, send: false } },
  { id: 'custom-ai', name: 'Other AI systems', group: 'ai', how: 'Your API key · OpenAI-compatible or Anthropic', kind: 'token', fields: [
    { key: 'baseUrl', label: 'Base URL', type: 'url', placeholder: 'https://' },
    { key: 'apiKey', label: 'API key', type: 'password' },
    { key: 'model', label: 'Model name', type: 'text' },
  ], can: { read: true, send: false } },
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
export interface EnginePrefs { brain: 'workers-ai' | 'custom-ai'; voice: 'elevenlabs' | 'device'; wake: boolean; onlyMyVoice: boolean; fallback: boolean; listen: 'device' }
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
export function passwordProblem(v: unknown): string | null {
  if (typeof v !== 'string') return 'Enter a password.';
  if (v.length < 12) return 'Use 12 or more characters.';
  // bcrypt reads at most 72 bytes; refuse anything longer so no part of a password is silently ignored.
  if (new TextEncoder().encode(v).length > 72) return 'Use 72 characters or fewer.';
  return null;
}
