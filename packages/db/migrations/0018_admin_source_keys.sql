-- A person's key for an admin source can be added by the admin in their setup (Admin · Data sources · Who can use them),
-- so the source is ready for them. by_admin marks those: the admin can change or remove only those, the person's own
-- key always replaces it, and turning the source off keeps it for next time. People never see who added a key.
alter table data_source_keys add column if not exists by_admin boolean not null default false;
