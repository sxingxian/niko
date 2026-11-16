-- New items on Home. The admin's default limits are in app_settings under 'glance-limits'; this column holds one
-- account's changes to them. glance_state remembers, per account, when each kind was last checked, what has already
-- been shown (so nothing appears twice, on any device), and the next few events (for reminders).
alter table users add column if not exists glance_limits jsonb not null default '{}'::jsonb;
create table if not exists glance_state (
  user_id uuid primary key references users(id) on delete cascade,
  checked jsonb not null default '{}'::jsonb,
  seen jsonb not null default '{}'::jsonb,
  upcoming jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);
