-- Row-level security: each query sees only one account's rows. The Worker sets niko.account (one person's requests)
-- or niko.all (the admin's counts and work across accounts) in the same transaction as every query
-- (apps/api/src/knowledge.ts, knowledgeDb). FORCE makes it apply to the owner role the Worker connects with too, so a
-- query that forgets its "account_id = $1" still can't read or change another person's files, rows or notes.
-- A query with neither setting sees nothing.
do $$
declare t text;
begin
  foreach t in array array['kn_documents', 'kn_chunks', 'kn_sheets', 'kn_learned', 'kn_places'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('drop policy if exists kn_own on %I', t);
    execute format($p$create policy kn_own on %I using (
        current_setting('niko.all', true) = 'on' or account_id = nullif(current_setting('niko.account', true), '')::uuid)
      with check (
        current_setting('niko.all', true) = 'on' or account_id = nullif(current_setting('niko.account', true), '')::uuid)$p$, t);
  end loop;
end $$;
-- Sheet rows have no account of their own: they follow their sheet (whose own policy applies inside the check).
alter table kn_sheet_rows enable row level security;
alter table kn_sheet_rows force row level security;
drop policy if exists kn_own on kn_sheet_rows;
create policy kn_own on kn_sheet_rows
  using (current_setting('niko.all', true) = 'on' or exists (select 1 from kn_sheets s where s.id = kn_sheet_rows.sheet_id))
  with check (current_setting('niko.all', true) = 'on' or exists (select 1 from kn_sheets s where s.id = kn_sheet_rows.sheet_id));

-- Neon's owner role (neondb_owner) can bypass row-level security, so one person's queries switch to this restricted
-- role inside their transaction ("set local role"), which can't. No new login or secret: the owner is a member of it.
-- The owner's own connection (migrations, the admin's counts) is unchanged.
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'niko_kn_app') then create role niko_kn_app nologin nobypassrls; end if;
end $$;
grant niko_kn_app to current_user;
grant usage on schema public to niko_kn_app;
grant select, insert, update, delete on all tables in schema public to niko_kn_app;
grant usage, select on all sequences in schema public to niko_kn_app;
alter default privileges in schema public grant select, insert, update, delete on tables to niko_kn_app;
alter default privileges in schema public grant usage, select on sequences to niko_kn_app;
