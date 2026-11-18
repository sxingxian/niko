-- Backgrounds behind Niko. Glow is everyone's; the admin offers others (Admin → Backgrounds), included or as a
-- one-time unlock. The admin's prices live in app_settings under 'backgrounds'. Same shape as designs (0013).

-- Backgrounds an account owns. Kept after a background stops being offered: whoever paid keeps using it.
-- source: 'single', 'bundle', 'topup' (added later by a bundle owner) or 'gift' (given by an admin, no payment).
-- cents: what was paid for this background on its own (single only), so it can count toward the bundle.
create table if not exists background_owned (
  user_id uuid not null references users(id) on delete cascade,
  background text not null,
  source text not null check (source in ('single','bundle','topup','gift')),
  cents integer,
  checkout_id text,
  mode text check (mode in ('test','live')),
  created_at timestamptz not null default now(),
  primary key (user_id, background)
);

-- Each background Checkout: what it covers and costs, fixed by the server when it was made, so a payment is applied
-- exactly once and only for the amount Niko asked for.
create table if not exists background_checkouts (
  id text primary key,
  user_id uuid not null references users(id) on delete cascade,
  kind text not null check (kind in ('one','all','topup','topupall')),
  backgrounds text[] not null,
  cents integer not null,
  mode text not null check (mode in ('test','live')),
  paid_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists background_checkouts_user on background_checkouts (user_id);

-- When the account bought "All backgrounds" (null: never). Backgrounds offered after that are new for them.
alter table users add column if not exists bg_bundle_at timestamptz;
