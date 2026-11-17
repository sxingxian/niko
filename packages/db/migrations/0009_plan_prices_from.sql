-- Where an account's own plan prices came from: 'kept' (kept when the default changed for new people only) or 'admin'
-- (set for that person in Users), and when.
alter table users add column if not exists plan_prices_from text;
alter table users add column if not exists plan_prices_at timestamptz;
