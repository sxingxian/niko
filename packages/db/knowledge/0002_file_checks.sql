-- A file whose text is written as instructions to an AI is flagged when it is added, so the person can remove it or
-- keep it as data. Either way Niko only ever reads file text as data.
alter table kn_documents add column if not exists flagged boolean not null default false;

-- Whether a sheet's first row was taken as its column names (the person can change it under "Check columns").
alter table kn_sheets add column if not exists header boolean not null default true;
