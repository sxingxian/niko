-- Edits made to the copy of what Niko learned (in Notion, Drive, OneDrive, storage or Obsidian) are picked up by Niko,
-- and the copy is updated in place instead of being replaced. `written` is the page as Niko last wrote it, so a change
-- made there can be told from a note Niko learned since; `checked_at` is when the copy was last read for edits.
alter table kn_learned_copy add column if not exists written text check (char_length(written) <= 600000);
alter table kn_learned_copy add column if not exists checked_at timestamptz;
alter table kn_learned_copy add column if not exists picked jsonb;
