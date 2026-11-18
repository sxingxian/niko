-- Search numbers from a person's own AI key or model server (Settings · Knowledge · "Find things by meaning with").
-- Models differ in size, so the column has no fixed length; one account uses one model at a time, and changing the
-- model clears these numbers before the files are re-read.
alter table kn_chunks add column if not exists embedding_own halfvec;
