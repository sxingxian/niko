-- Knowledge kept in the person's own Notion, Google Drive, OneDrive or S3 storage. Niko writes a copy of each file
-- there (a page or database in Notion; a Google Doc or Sheet; .md and .csv files in OneDrive and their storage) and
-- still keeps the search pieces and rows here, so search and totals work the same. remote_version is what the place
-- says the copy's version is (edited time or ETag): when it changes, the copy is read again the next time it's used.
alter table kn_documents
  add column if not exists place text not null default 'niko' check (place in ('niko', 'notion', 'gdrive', 'onedrive', 's3')),
  add column if not exists remote_id text,
  add column if not exists remote_url text,
  add column if not exists remote_version text,
  add column if not exists remote_checked_at timestamptz,
  add column if not exists remote_error text;
-- A spreadsheet's sheets are copied one by one (a database in Notion, a Google Sheet, a .csv file). remote_rows counts
-- the rows already written, for places that take rows a few at a time (Notion).
alter table kn_sheets
  add column if not exists remote_id text,
  add column if not exists remote_url text,
  add column if not exists remote_version text,
  add column if not exists remote_rows integer not null default 0;

-- Each person's folder or page in each place ("Niko Knowledge"), made once, or a Notion page they chose.
create table if not exists kn_places (
  account_id uuid not null,
  place text not null check (place in ('notion', 'gdrive', 'onedrive', 's3')),
  root_id text not null check (char_length(root_id) between 1 and 300),
  root_name text not null default '' check (char_length(root_name) <= 200),
  created_at timestamptz not null default now(),
  primary key (account_id, place)
);
