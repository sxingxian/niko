-- Knowledge settings kept with each account in the main database. The files themselves, their search pieces and what
-- Niko learned live in Knowledge's own database (packages/db/knowledge), never here.
alter table users add column if not exists knowledge jsonb not null default '{}'::jsonb;
alter table users add column if not exists knowledge_limits jsonb not null default '{}'::jsonb;
