-- Services the admin provides to people: each key is kept once, encrypted, in provided_keys; a person's account
-- (users.provided) or an invite (invites.setup) lists which ones they get, in order. usage_counts keeps one number per
-- person, month, kind and service (never what was said), for the monthly included amounts.
create table if not exists provided_keys (
  id text primary key,
  kind text not null check (kind in ('brain', 'voice', 'hear', 'image', 'map')),
  label text not null default '',
  info jsonb not null default '{}'::jsonb,
  secret_enc text not null,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table users add column if not exists provided jsonb;
alter table invites add column if not exists setup jsonb;
create table if not exists usage_counts (
  user_id uuid not null references users(id) on delete cascade,
  month text not null,
  kind text not null,
  entry text not null,
  n integer not null default 0,
  primary key (user_id, month, kind, entry)
);
