-- Screen lock: each account's settings (the 6-digit code kept only as a peppered bcrypt hash), and per sign-in whether
-- it is locked, when it was last in use, and wrong codes since the last unlock.
alter table users add column if not exists screen_lock jsonb;
alter table sessions add column if not exists locked boolean not null default false;
alter table sessions add column if not exists seen_at timestamptz;
alter table sessions add column if not exists lock_fails integer not null default 0;
