-- Plan prices an account keeps for its next plan, when the admin changed prices and chose that accounts which already
-- existed keep theirs. Null: the account follows the current prices.
alter table users add column if not exists plan_prices jsonb;
