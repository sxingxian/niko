-- Browser services besides the built-in Cloudflare Browser Run: the account's own browser server and a hosted service
-- with a key (user_id null, one of each), and a person's own service (one per person, when the admin allows it).
-- Addresses are public https/wss only; keys are sealed with ENCRYPTION_KEY and never sent to any device: Niko's server
-- connects to the service and relays the live picture to the person's device.
create table if not exists browser_services (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users(id) on delete cascade,
  kind text not null,
  name text not null default '',
  url text not null,
  key_enc text,
  key_param text not null default 'token',
  created_at timestamptz not null default now(),
  tested_at timestamptz
);
create unique index if not exists browser_services_account on browser_services (kind) where user_id is null;
create unique index if not exists browser_services_person on browser_services (user_id) where user_id is not null;
