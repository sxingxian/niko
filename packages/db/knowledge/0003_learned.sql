-- What Niko learned: the file piece a taught match points at, when a note was last used, and word search over notes.
alter table kn_learned add column if not exists target jsonb;
alter table kn_learned add column if not exists last_used timestamptz;
alter table kn_learned add column if not exists tsv tsvector generated always as (to_tsvector('simple', coalesce(subject, '') || ' ' || coalesce(body, ''))) stored;
create index if not exists kn_learned_tsv on kn_learned using gin (tsv);
