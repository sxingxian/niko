-- Datasets from data sources, kept in a person's Knowledge as tables and refreshed when used (no schedules). The
-- table itself is in Knowledge's own database; this links it to the source and says when it was fetched.
create table if not exists data_datasets (
  user_id uuid not null references users(id) on delete cascade,
  source_id uuid not null references data_sources(id) on delete cascade,
  action_id text not null,
  document_id uuid,
  fetched_at timestamptz,
  rows integer not null default 0,
  problem text,
  primary key (user_id, source_id, action_id)
);
