-- Designs: how the core looks. Nebula is everyone's; the admin offers others (Admin → Designs), included or as a
-- one-time unlock. The admin's prices live in app_settings under 'designs'.

-- Designs an account owns. Kept after a design stops being offered: whoever paid keeps using it.
-- source: 'single' (bought on its own), 'bundle' (in "All designs"), 'topup' (added later by a bundle owner),
-- 'gift' (given by an admin, no payment). cents: what was paid for this design on its own (single only), so it can
-- count toward the bundle.
create table if not exists design_owned (
  user_id uuid not null references users(id) on delete cascade,
  design text not null,
  source text not null check (source in ('single','bundle','topup','gift')),
  cents integer,
  checkout_id text,
  mode text check (mode in ('test','live')),
  created_at timestamptz not null default now(),
  primary key (user_id, design)
);

-- Each design Checkout: what it covers and costs, fixed by the server when it was made, so a payment is applied
-- exactly once and only for the amount Niko asked for.
create table if not exists design_checkouts (
  id text primary key,
  user_id uuid not null references users(id) on delete cascade,
  kind text not null check (kind in ('one','all','topup','topupall')),
  designs text[] not null,
  cents integer not null,
  mode text not null check (mode in ('test','live')),
  paid_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists design_checkouts_user on design_checkouts (user_id);

-- When the account bought "All designs" (null: never). Designs offered after that are new for them.
alter table users add column if not exists design_bundle_at timestamptz;
-- The Niko Pro add-on: the item Niko added to the account's plan subscription, and whether it is live.
alter table users add column if not exists pro_item text;
alter table users add column if not exists pro_on boolean not null default false;
