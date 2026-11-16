-- Payments: pay once for a set time, then a monthly or yearly plan; invite codes; open sign-ups that confirm their
-- email and pay; admin unlocks. Card details never reach Niko: payments run on Stripe Checkout.

-- What gives an account access. Admins always have access. Everyone else needs one of: lifetime, time left
-- (access_until), or a live subscription (sub_*).
alter table users add column if not exists lifetime boolean not null default false;
-- Accounts that existed before payments keep using Niko as before: they become lifetime.
update users set lifetime = true;
alter table users add column if not exists access_until timestamptz;
alter table users add column if not exists access_kind text check (access_kind in ('paid','free','unlocked'));
-- When an admin unlock follows time already paid for, the end of that paid time (shown in the admin portal).
alter table users add column if not exists access_paid_until timestamptz;
-- A paid sign-up's months start when an admin switches the account on, not when they pay.
alter table users add column if not exists access_start_months integer not null default 0;
-- Stripe keeps test and live data apart, so an account has a customer in each mode it has paid in.
alter table users add column if not exists stripe_customer_test text;
alter table users add column if not exists stripe_customer_live text;
-- The mode the pay-once time was paid in ('test' or 'live'), shown in the admin portal.
alter table users add column if not exists paid_mode text check (paid_mode in ('test','live'));
alter table users add column if not exists sub_id text;
alter table users add column if not exists sub_status text;
alter table users add column if not exists sub_plan text check (sub_plan in ('monthly','yearly'));
alter table users add column if not exists sub_period_end timestamptz;
alter table users add column if not exists sub_cancel_at_end boolean not null default false;
alter table users add column if not exists sub_mode text check (sub_mode in ('test','live'));
-- The access end date a reminder email was last sent for, so each end date is reminded once.
alter table users add column if not exists reminded_for timestamptz;
create index if not exists users_sub_id on users (sub_id);

-- Invites: how the person gets access, the price fixed when it was sent, and the 6-character code.
-- Invites sent before payments existed carry no code and no payment (lifetime), as before.
alter table invites add column if not exists access text not null default 'life' check (access in ('paid','free','life'));
alter table invites add column if not exists price_cents integer;
alter table invites add column if not exists months integer;
alter table invites add column if not exists code_hash text;
alter table invites add column if not exists code_tries integer not null default 0;
-- Set after the right code: a random pass kept in a cookie on that browser, stored here only as a hash.
alter table invites add column if not exists pass_hash text;
alter table invites add column if not exists checkout_id text;
alter table invites add column if not exists paid_at timestamptz;
alter table invites add column if not exists payment_intent text;
alter table invites add column if not exists stripe_customer_id text;
alter table invites add column if not exists refunded_at timestamptz;
-- The Stripe mode of the invite's Checkout and payment, so a refund goes to the same mode.
alter table invites add column if not exists stripe_mode text check (stripe_mode in ('test','live'));

-- Open sign-ups in progress: email confirmation, then payment, then waiting for an admin to switch the account on.
create table if not exists signups (
  user_id uuid primary key references users(id) on delete cascade,
  token_hash text not null unique,
  state text not null default 'verify' check (state in ('verify','pay','waiting')),
  code_hash text,
  code_expires_at timestamptz,
  code_tries integer not null default 0,
  price_cents integer,
  months integer,
  checkout_id text,
  paid_at timestamptz,
  payment_intent text,
  stripe_mode text check (stripe_mode in ('test','live')),
  created_at timestamptz not null default now()
);

-- Stripe events already handled, so a resent event is applied once.
create table if not exists stripe_events (
  id text primary key,
  type text not null,
  mode text not null default 'test',
  created_at timestamptz not null default now()
);

-- Which Stripe keys new payments use: 'test' until an admin switches to 'live' (Admin → Payments).
insert into app_settings (key, value) values ('stripe-mode', '"test"') on conflict do nothing;
