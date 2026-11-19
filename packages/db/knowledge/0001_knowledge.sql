-- Knowledge: each person's files, the pieces Niko searches, spreadsheets kept as tables, and what Niko learned.
-- This runs on its OWN Neon project (KNOWLEDGE_DATABASE_URL), never on the main database, so Knowledge can't fill
-- the main database's storage. There are no foreign keys to the main database: account_id is users.id over there,
-- and every query filters by it. Deleting an account deletes its rows here too (apps/api/src/knowledge).
create extension if not exists vector;

create table if not exists kn_documents (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null,
  collection text not null default 'General' check (char_length(collection) between 1 and 80),
  name text not null check (char_length(name) between 1 and 255),
  kind text not null check (kind in ('md', 'txt', 'csv', 'tsv', 'json', 'xml', 'html', 'pdf', 'docx', 'xlsx', 'xls', 'ods', 'odt')),
  bytes integer not null check (bytes >= 0),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  source text not null default 'upload' check (source in ('upload', 'notion', 'gdrive', 'onedrive')),
  source_ref text,
  status text not null default 'reading' check (status in ('reading', 'ready', 'failed')),
  error text,
  chunk_count integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (account_id, sha256)
);
create index if not exists kn_documents_account on kn_documents (account_id, collection);

-- The searchable pieces. Two kinds of search numbers: Cloudflare's (bge-m3, 1,024 numbers) when Cloudflare search is
-- allowed, otherwise ones made on the person's device (384 numbers). Half-size numbers halve the storage.
create table if not exists kn_chunks (
  id bigint generated always as identity primary key,
  account_id uuid not null,
  document_id uuid not null references kn_documents (id) on delete cascade,
  ord integer not null,
  heading text,
  body text not null check (char_length(body) between 1 and 8000),
  tsv tsvector generated always as (to_tsvector('simple', coalesce(heading, '') || ' ' || body)) stored,
  embedding halfvec(1024),
  embedding_device halfvec(384),
  unique (document_id, ord)
);
create index if not exists kn_chunks_account on kn_chunks (account_id);
create index if not exists kn_chunks_tsv on kn_chunks using gin (tsv);
-- No vector index on purpose: a shared HNSW index picks its candidates across every account and filters by account
-- afterwards, which can leave one person with too few matches. Search reads only that person's rows (by account_id)
-- and compares exactly, which is fast at the sizes Knowledge allows.

-- Spreadsheets are kept as tables and answered with a fixed look-up tool, never with SQL written by the AI.
create table if not exists kn_sheets (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null,
  document_id uuid not null references kn_documents (id) on delete cascade,
  name text not null,
  columns jsonb not null check (jsonb_typeof(columns) = 'array'),
  row_count integer not null default 0
);
create index if not exists kn_sheets_account on kn_sheets (account_id);
create table if not exists kn_sheet_rows (
  sheet_id uuid not null references kn_sheets (id) on delete cascade,
  ord integer not null,
  cells jsonb not null check (jsonb_typeof(cells) = 'array'),
  primary key (sheet_id, ord)
);

-- What Niko learned about how one person works. Notes about people are facts only and are saved only with a yes.
create table if not exists kn_learned (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null,
  kind text not null check (kind in ('person', 'correction', 'habit', 'playbook', 'file-match', 'remembered')),
  subject text not null default '' check (char_length(subject) <= 200),
  body text not null check (char_length(body) between 1 and 2000),
  source text not null default 'you' check (char_length(source) <= 200),
  sure real not null default 0.5 check (sure >= 0 and sure <= 1),
  uses integer not null default 0,
  confirmed boolean not null default false,
  embedding halfvec(1024),
  embedding_device halfvec(384),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists kn_learned_account on kn_learned (account_id, kind);
