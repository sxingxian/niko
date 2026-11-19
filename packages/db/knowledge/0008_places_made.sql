-- Whether Niko made the page or folder for Knowledge in a place, or the person picked one of their own (a Notion page).
-- Pages Niko made are kept out of the person's Notes in Niko; a page they picked is theirs and stays in their Notes.
alter table kn_places add column if not exists made boolean not null default true;
