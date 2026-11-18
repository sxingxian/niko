-- Data sources (Engine · Data sources, Admin · Data sources): data sites Niko may ask, added by the admin or by a
-- person for themselves. Nothing is built in. Keys are sealed with ENCRYPTION_KEY and never sent to the browser.
create table if not exists data_sources (
  id uuid primary key default gen_random_uuid(),
  -- null: added by the admin and offered to people; otherwise private to this person.
  owner_id uuid references users(id) on delete cascade,
  name text not null,
  use_as text not null default 'general',
  base_url text not null,
  auth text not null default 'none',
  auth_name text not null default '',
  key_mode text not null default 'one',
  key_enc text,
  actions jsonb not null default '[]'::jsonb,
  terms_ok boolean not null default false,
  terms_note text not null default '',
  attribution text not null default '',
  offer text not null default 'nobody',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists data_sources_owner on data_sources (owner_id);
-- Each person's own key for an admin source that asks everyone to add their own.
create table if not exists data_source_keys (
  source_id uuid not null references data_sources(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  key_enc text not null,
  primary key (source_id, user_id)
);
-- The admin's changes for one person (which admin sources, own sources allowed, monthly calls), and the person's own
-- choices (admin sources they turned on, actions they switched off).
alter table users add column if not exists data_access jsonb not null default '{}'::jsonb;
alter table users add column if not exists data_prefs jsonb not null default '{}'::jsonb;
