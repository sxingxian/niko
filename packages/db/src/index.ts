import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import { bigint, bigserial, boolean, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

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
  /** This account's changes to the admin's default limits for new items on Home. Set by an admin only. */
  glanceLimits: jsonb('glance_limits').notNull().default({}).$type<Record<string, unknown>>(),
  accountLimits: jsonb('account_limits').notNull().default({}).$type<Record<string, unknown>>(),
  /** Plan prices this account keeps when it next chooses a plan; null follows the current prices. */
  planPrices: jsonb('plan_prices').$type<{ plan: 'monthly' | 'yearly'; cents: number }[] | null>(),
  /** 'kept' (kept when the default changed for new people only) or 'admin' (set for this person), and when. */
  planPricesFrom: text('plan_prices_from'),
  planPricesAt: ts('plan_prices_at'),
  /** Screen lock settings, with the code as a peppered bcrypt hash. */
  screenLock: jsonb('screen_lock'),
  /** Services the admin provides: { keys: { brain: [ids], voice: [...], ... }, order: 'free' | 'fixed' }. */
  provided: jsonb('provided'),
  // ---- access and payments (see migration 0007)
  lifetime: boolean('lifetime').notNull().default(false),
  accessUntil: ts('access_until'),
  accessKind: text('access_kind'),
  accessPaidUntil: ts('access_paid_until'),
  accessStartMonths: integer('access_start_months').notNull().default(0),
  stripeCustomerTest: text('stripe_customer_test'),
  stripeCustomerLive: text('stripe_customer_live'),
  paidMode: text('paid_mode'),
  subId: text('sub_id'),
  subStatus: text('sub_status'),
  subPlan: text('sub_plan'),
  subPeriodEnd: ts('sub_period_end'),
  subCancelAtEnd: boolean('sub_cancel_at_end').notNull().default(false),
  subMode: text('sub_mode'),
  remindedFor: ts('reminded_for'),
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
  /** Screen lock, per sign-in: locked now, last in use (sent by the app while someone uses it), wrong codes. */
  locked: boolean('locked').notNull().default(false),
  seenAt: ts('seen_at'),
  lockFails: integer('lock_fails').notNull().default(0),
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
  access: text('access').notNull().default('life'),
  priceCents: integer('price_cents'),
  months: integer('months'),
  codeHash: text('code_hash'),
  codeTries: integer('code_tries').notNull().default(0),
  passHash: text('pass_hash'),
  checkoutId: text('checkout_id'),
  paidAt: ts('paid_at'),
  paymentIntent: text('payment_intent'),
  stripeCustomerId: text('stripe_customer_id'),
  refundedAt: ts('refunded_at'),
  stripeMode: text('stripe_mode'),
  /** Set up before they join: provided services, order rule, AI option changes and monthly amounts, copied on accepting. */
  setup: jsonb('setup'),
});

/** Open sign-ups in progress: confirm email, pay, then wait for an admin. */
export const signups = pgTable('signups', {
  userId: uuid('user_id').primaryKey(),
  tokenHash: text('token_hash').notNull(),
  state: text('state').notNull().default('verify'),
  codeHash: text('code_hash'),
  codeExpiresAt: ts('code_expires_at'),
  codeTries: integer('code_tries').notNull().default(0),
  priceCents: integer('price_cents'),
  months: integer('months'),
  checkoutId: text('checkout_id'),
  paidAt: ts('paid_at'),
  paymentIntent: text('payment_intent'),
  stripeMode: text('stripe_mode'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const stripeEvents = pgTable('stripe_events', {
  id: text('id').primaryKey(),
  type: text('type').notNull(),
  mode: text('mode').notNull().default('test'),
  createdAt: ts('created_at').notNull().defaultNow(),
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
  connections, oauthStates, messages, pendingSends, chatTurns, auditLog, authAttempts, recoveryCodes, providerApps, signups, stripeEvents,
};

export function createDb(databaseUrl: string) {
  return drizzle(neon(databaseUrl), { schema });
}
export type Db = ReturnType<typeof createDb>;
export type User = typeof users.$inferSelect;
export type Invite = typeof invites.$inferSelect;
export type Signup = typeof signups.$inferSelect;

/** New items on Home: per account, when each kind was last checked, what has been shown, and the next few events. */
export const glanceState = pgTable('glance_state', {
  userId: uuid('user_id').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  checked: jsonb('checked').notNull().default({}).$type<Record<string, number>>(),
  seen: jsonb('seen').notNull().default({}).$type<Record<string, number>>(),
  upcoming: jsonb('upcoming').notNull().default([]).$type<{ id: string; provider: string; title: string; start: number; source: string }[]>(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

/** A key the admin provides to people. The secret is sealed; info holds what may be shown (service, model, last 4). */
export const providedKeys = pgTable('provided_keys', {
  id: text('id').primaryKey(),
  kind: text('kind').notNull(),
  label: text('label').notNull().default(''),
  info: jsonb('info').notNull().default({}).$type<Record<string, unknown>>(),
  secretEnc: text('secret_enc').notNull(),
  createdBy: uuid('created_by'),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});
/** How much each person used each month, per kind and service: one number, never what was said. */
export const usageCounts = pgTable('usage_counts', {
  userId: uuid('user_id').notNull(),
  month: text('month').notNull(),
  kind: text('kind').notNull(),
  entry: text('entry').notNull(),
  n: integer('n').notNull().default(0),
});
