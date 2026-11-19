-- Obsidian as a place: a copy of each file, and of what Niko learned, in a "Niko Knowledge" folder of the person's
-- vault (reached through S3 storage it syncs with, or the Local REST API plugin). Only the allowed places change.
alter table kn_documents drop constraint if exists kn_documents_place_check;
alter table kn_documents add constraint kn_documents_place_check check (place in ('niko', 'notion', 'gdrive', 'onedrive', 's3', 'obsidian'));
alter table kn_places drop constraint if exists kn_places_place_check;
alter table kn_places add constraint kn_places_place_check check (place in ('notion', 'gdrive', 'onedrive', 's3', 'obsidian'));
alter table kn_learned_copy drop constraint if exists kn_learned_copy_place_check;
alter table kn_learned_copy add constraint kn_learned_copy_place_check check (place in ('notion', 'gdrive', 'onedrive', 's3', 'obsidian'));
