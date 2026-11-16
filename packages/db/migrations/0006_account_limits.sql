-- Account limits, such as how many calendar links an account may keep. The admin's default is in app_settings under
-- 'account-limits'; this column holds one account's changes to it.
alter table users add column if not exists account_limits jsonb not null default '{}'::jsonb;
