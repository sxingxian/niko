-- "Stay signed in" (Settings › Browser): sign-ins a person chose to keep for a site, after signing in there in Niko's
-- browser. The site's cookies are sealed with ENCRYPTION_KEY, returned only to that person's own device, and deleted on
-- Forget (one site or all), or when the admin switches "Stay signed in" off.
create table if not exists browser_signins (
  user_id uuid not null references users(id) on delete cascade,
  site text not null,
  cookies_enc text not null,
  created_at timestamptz not null default now(),
  used_at timestamptz,
  uses integer not null default 0,
  primary key (user_id, site)
);
