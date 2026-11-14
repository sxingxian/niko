-- Niko initial schema. Run once against your Neon database (see docs/SETUP.md).
create extension if not exists pgcrypto;

create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  name text not null default '',
  password_hash text,
  role text not null default 'member' check (role in ('admin','member')),
  status text not null default 'active' check (status in ('active','off','pending')),
  is_owner boolean not null default false,
  totp_secret_enc text,
  totp_enabled boolean not null default false,
  appearance jsonb not null default '{"mode":"shift","colours":["cyan","violet","rose","amber","emerald"],"single":"cyan","customHue":210,"seconds":8}',
  engine jsonb not null default '{"brain":"workers-ai","voice":"device","wake":true,"onlyMyVoice":false,"fallback":true,"listen":"device"}',
  permissions jsonb not null default '{"draft":true,"chatReply":true,"files":true}',
  created_at timestamptz not null default now(),
  last_active_at timestamptz
);
create unique index if not exists users_email_lower on users (lower(email));

create table if not exists sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  token_hash text not null unique,
  kind text not null default 'app' check (kind in ('app','admin')),
  mfa_ok boolean not null default false,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  ip text,
  user_agent text
);
create index if not exists sessions_user on sessions (user_id);

create table if not exists invites (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  token_hash text not null unique,
  role text not null default 'member',
  invited_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz,
  revoked_at timestamptz
);

create table if not exists password_resets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  used_at timestamptz
);

create table if not exists passkeys (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  credential_id text not null unique,
  public_key text not null,
  counter bigint not null default 0,
  rp_id text not null,
  transports text,
  label text not null default 'Passkey',
  created_at timestamptz not null default now()
);

create table if not exists webauthn_challenges (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users(id) on delete cascade,
  challenge text not null,
  rp_id text not null,
  kind text not null check (kind in ('register','login')),
  expires_at timestamptz not null
);

create table if not exists app_settings (
  key text primary key,
  value jsonb not null
);
insert into app_settings (key, value) values ('registration', '"invite"') on conflict do nothing;

create table if not exists connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  provider text not null,
  status text not null default 'linked',
  secret_enc text,
  meta jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, provider)
);

create table if not exists oauth_states (
  state text primary key,
  user_id uuid not null references users(id) on delete cascade,
  provider text not null,
  host text not null,
  created_at timestamptz not null default now()
);

create table if not exists messages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  provider text not null,
  chat_id text not null,
  chat_title text not null default '',
  sender text not null default '',
  body text not null default '',
  direction text not null check (direction in ('in','out')),
  file_name text,
  external_id text,
  created_at timestamptz not null default now()
);
create index if not exists messages_user_chat on messages (user_id, provider, chat_id, created_at desc);

create table if not exists pending_sends (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  provider text not null,
  chat_id text not null,
  body text not null,
  via text not null check (via in ('voice','tap')),
  status text not null default 'pending' check (status in ('pending','sent','cancelled','failed')),
  created_at timestamptz not null default now(),
  not_before timestamptz not null
);

create table if not exists chat_turns (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  role text not null check (role in ('user','assistant')),
  content text not null,
  created_at timestamptz not null default now()
);
create index if not exists chat_turns_user on chat_turns (user_id, created_at desc);

create table if not exists audit_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users(id) on delete set null,
  action text not null,
  detail jsonb not null default '{}',
  ip text,
  created_at timestamptz not null default now()
);
create index if not exists audit_log_time on audit_log (created_at desc);

create table if not exists auth_attempts (
  id bigserial primary key,
  key text not null,
  created_at timestamptz not null default now()
);
create index if not exists auth_attempts_key on auth_attempts (key, created_at desc);
