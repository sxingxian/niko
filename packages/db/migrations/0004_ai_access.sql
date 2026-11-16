-- Admin control of the AI options each account can see and use (Engine and Voice screens).
-- The default for everyone is kept in app_settings under 'ai-access'; this column holds one account's changes to it,
-- as { "<option>": true | false }. Empty means the account follows the default.
alter table users add column if not exists ai_access jsonb not null default '{}'::jsonb;
