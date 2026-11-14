-- Sign-in protections ported from sxingxian.com. Run once after 0001_init.sql.

-- Throttle per (email, IP address). Unknown and real emails are tracked identically, so a lock reveals
-- nothing about which accounts exist, and a stranger's failures never lock the owner out from elsewhere.
create table if not exists login_throttle (
  email        text not null,
  ip           text not null,
  failed       integer not null default 0,
  locked_until timestamptz,
  updated_at   timestamptz not null default now(),
  primary key (email, ip)
);

-- Replay protection for the admin second factor: a code's time step is accepted once.
alter table users add column if not exists totp_last_step bigint not null default 0;

-- Single-use backup codes for the admin second factor. Only SHA-256 hashes are stored.
create table if not exists recovery_codes (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references users(id) on delete cascade,
  code_hash  text not null,
  used_at    timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists recovery_codes_user on recovery_codes (user_id);
