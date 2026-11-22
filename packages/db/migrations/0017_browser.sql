-- Niko's browser (Settings › Browser, Admin portal › Browser). The browser itself runs on a browser service
-- (Cloudflare Browser Run, built in); Niko keeps only who opened one, on which service, and for how long.
-- Page contents, what was typed and pictures of pages are never stored.
--
-- The admin's changes for one person (browser on, own service allowed, daily minutes), and the person's own choices.
alter table users add column if not exists browser_access jsonb not null default '{}'::jsonb;
alter table users add column if not exists browser_prefs jsonb not null default '{}'::jsonb;

create table if not exists browser_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  -- cloudflare (built in), server or hosted (the account's), own (the person's own service)
  service text not null,
  service_id uuid,
  -- The service's own id for the browser, used only to close it.
  remote_id text not null,
  -- The site first opened (host name only).
  site text not null default '',
  started_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  ended_at timestamptz,
  seconds integer not null default 0,
  ended_why text not null default ''
);
create index if not exists browser_sessions_user on browser_sessions (user_id, started_at desc);
create index if not exists browser_sessions_open on browser_sessions (service) where ended_at is null;
