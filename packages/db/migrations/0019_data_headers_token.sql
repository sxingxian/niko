-- Data sources for most APIs: other headers sent with every call (plain ones kept here, secret ones only as names, their
-- values sealed in secrets_enc), and signing in for a token (where and how, in token; the client ID and secret, or email
-- and password, sealed in secrets_enc). POST actions and XML answers need no new columns.
alter table data_sources add column if not exists headers jsonb not null default '[]';
alter table data_sources add column if not exists token jsonb;
alter table data_sources add column if not exists secrets_enc text;
