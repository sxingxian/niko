import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import { bigint, bigserial, boolean, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

const ts = (name: string) => timestamp(name, { withTimezone: true });

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull(),
  name: text('name').notNull().default(''),
  passwordHash: text('password_hash'),
  role: text('role').notNull().default('member'),
  status: text('status').notNull().default('active'),
  isOwner: boolean('is_owner').notNull().default(false),
  totpSecretEnc: text('totp_secret_enc'),
  totpEnabled: boolean('totp_enabled').notNull().default(false),
  totpLastStep: bigint('totp_last_step', { mode: 'number' }).notNull().default(0),
  appearance: jsonb('appearance').notNull().default({}).$type<Record<string, unknown>>(),
  engine: jsonb('engine').notNull().default({}).$type<Record<string, unknown>>(),
  permissions: jsonb('permissions').notNull().default({}).$type<Record<string, unknown>>(),
  /** This account's changes to the admin's default AI options ({ option: on }). Set by an admin only. */
  aiAccess: jsonb('ai_access').notNull().default({}).$type<Record<string, boolean>>(),
  createdAt: ts('created_at').notNull().defaultNow(),
  lastActiveAt: ts('last_active_at'),
});

export const sessions = pgTable('sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull(),
  tokenHash: text('token_hash').notNull(),
  kind: text('kind').notNull().default('app'),
  mfaOk: boolean('mfa_ok').notNull().default(false),
  createdAt: ts('created_at').notNull().defaultNow(),
  expiresAt: ts('expires_at').notNull(),
  ip: text('ip'),
  userAgent: text('user_agent'),
});

export const invites = pgTable('invites', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull(),
  tokenHash: text('token_hash').notNull(),
  role: text('role').notNull().default('member'),
  invitedBy: uuid('invited_by'),
  createdAt: ts('created_at').notNull().defaultNow(),
  expiresAt: ts('expires_at').notNull(),
  usedAt: ts('used_at'),
  revokedAt: ts('revoked_at'),
});

export const passwordResets = pgTable('password_resets', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull(),
  tokenHash: text('token_hash').notNull(),
  expiresAt: ts('expires_at').notNull(),
  usedAt: ts('used_at'),
});

export const passkeys = pgTable('passkeys', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull(),
  credentialId: text('credential_id').notNull(),
  publicKey: text('public_key').notNull(),
  counter: bigint('counter', { mode: 'number' }).notNull().default(0),
  rpId: text('rp_id').notNull(),
  transports: text('transports'),
  label: text('label').notNull().default('Passkey'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const webauthnChallenges = pgTable('webauthn_challenges', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id'),
  challenge: text('challenge').notNull(),
  rpId: text('rp_id').notNull(),
  kind: text('kind').notNull(),
  expiresAt: ts('expires_at').notNull(),
});

export const appSettings = pgTable('app_settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
});

export const connections = pgTable('connections', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull(),
  provider: text('provider').notNull(),
  status: text('status').notNull().default('linked'),
  secretEnc: text('secret_enc'),
  meta: jsonb('meta').notNull().default({}).$type<Record<string, unknown>>(),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const oauthStates = pgTable('oauth_states', {
  state: text('state').primaryKey(),
  userId: uuid('user_id').notNull(),
  provider: text('provider').notNull(),
  host: text('host').notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const messages = pgTable('messages', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull(),
  provider: text('provider').notNull(),
  chatId: text('chat_id').notNull(),
  chatTitle: text('chat_title').notNull().default(''),
  sender: text('sender').notNull().default(''),
  body: text('body').notNull().default(''),
  direction: text('direction').notNull(),
  fileName: text('file_name'),
  externalId: text('external_id'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const pendingSends = pgTable('pending_sends', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull(),
  provider: text('provider').notNull(),
  chatId: text('chat_id').notNull(),
  body: text('body').notNull(),
  via: text('via').notNull(),
  status: text('status').notNull().default('pending'),
  createdAt: ts('created_at').notNull().defaultNow(),
  notBefore: ts('not_before').notNull(),
});

export const chatTurns = pgTable('chat_turns', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull(),
  role: text('role').notNull(),
  content: text('content').notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const auditLog = pgTable('audit_log', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id'),
  action: text('action').notNull(),
  detail: jsonb('detail').notNull().default({}).$type<Record<string, unknown>>(),
  ip: text('ip'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const authAttempts = pgTable('auth_attempts', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  key: text('key').notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const recoveryCodes = pgTable('recovery_codes', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull(),
  codeHash: text('code_hash').notNull(),
  usedAt: ts('used_at'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const providerApps = pgTable('provider_apps', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull(),
  app: text('app').notNull(),
  secretEnc: text('secret_enc').notNull(),
  clientIdHint: text('client_id_hint').notNull().default(''),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const schema = {
  users, sessions, invites, passwordResets, passkeys, webauthnChallenges, appSettings,
  connections, oauthStates, messages, pendingSends, chatTurns, auditLog, authAttempts, recoveryCodes, providerApps,
};

export function createDb(databaseUrl: string) {
  return drizzle(neon(databaseUrl), { schema });
}
export type Db = ReturnType<typeof createDb>;
export type User = typeof users.$inferSelect;
