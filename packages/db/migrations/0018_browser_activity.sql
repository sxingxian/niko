-- "What Niko did" (Settings › Browser): the site and the steps, and the person's choices (OK, their turn).
-- Never what was typed, never page contents, never codes. Kept as long as the person chose (7, 30 or 90 days, at most
-- what the admin allows); older entries are removed by the daily clean-up.
create table if not exists browser_activity (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  session_id uuid references browser_sessions(id) on delete set null,
  at timestamptz not null default now(),
  site text not null default '',
  -- opened, step, handoff, ok, declined, done, download, stopped
  kind text not null,
  text text not null default ''
);
create index if not exists browser_activity_user on browser_activity (user_id, at desc);
