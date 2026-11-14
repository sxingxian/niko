-- Each account registers its own app with Google, Microsoft, Notion and Slack and saves the keys here.
-- Nothing about these providers is configured on the server.

create table if not exists provider_apps (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  app text not null,                       -- google | microsoft | notion | slack
  secret_enc text not null,                -- client ID, client secret and extras, encrypted with ENCRYPTION_KEY
  client_id_hint text not null default '', -- last characters of the client ID, to recognise it on screen
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, app)
);
