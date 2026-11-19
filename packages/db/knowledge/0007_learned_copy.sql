-- A copy of what Niko learned, to read in the person's own Notion, Google Drive, OneDrive or storage (their choice).
-- Niko keeps the notes in kn_learned as always; this records the copy there. The copy is only ever written by Niko:
-- changes made there are never read back, so nobody else can add to what Niko learned.
create table if not exists kn_learned_copy (
  account_id uuid primary key,
  place text not null check (place in ('notion', 'gdrive', 'onedrive', 's3')),
  remote_id text check (char_length(remote_id) <= 300),
  remote_url text check (char_length(remote_url) <= 1000),
  dirty boolean not null default true,
  synced_at timestamptz,
  error text check (char_length(error) <= 300)
);
alter table kn_learned_copy enable row level security;
alter table kn_learned_copy force row level security;
drop policy if exists kn_own on kn_learned_copy;
create policy kn_own on kn_learned_copy using (
    current_setting('niko.all', true) = 'on' or account_id = nullif(current_setting('niko.account', true), '')::uuid)
  with check (
    current_setting('niko.all', true) = 'on' or account_id = nullif(current_setting('niko.account', true), '')::uuid);
grant select, insert, update, delete on kn_learned_copy to niko_kn_app;
