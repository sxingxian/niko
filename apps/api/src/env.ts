import type { Db, User } from '@niko/db';

export interface Env {
  ASSETS: Fetcher;
  AI: Ai;
  DATABASE_URL: string;
  ENCRYPTION_KEY: string;
  BOOTSTRAP_TOKEN?: string;
  RESEND_API_KEY?: string;
  EMAIL_FROM: string;
  AI_MODEL: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  MICROSOFT_CLIENT_ID?: string;
  MICROSOFT_CLIENT_SECRET?: string;
  NOTION_CLIENT_ID?: string;
  NOTION_CLIENT_SECRET?: string;
  SLACK_CLIENT_ID?: string;
  SLACK_CLIENT_SECRET?: string;
  SLACK_SIGNING_SECRET?: string;
}

export interface Vars {
  db: Db;
  user: User;
  sessionId: string;
  site: Site;
}

export type AppEnv = { Bindings: Env; Variables: Vars };

/** How one hostname maps onto the three front ends. */
export interface Site {
  host: string;
  /** Registrable domain, used as the passkey relying-party ID. */
  rpId: string;
  /** 'main' hosts serve landing at /, admin at /admin, and (on sxingxian) the app at /app. 'app' hosts serve only the app at /. */
  kind: 'main' | 'app';
  /** Absolute URL of the app for links in emails and redirects. */
  appUrl: string;
  adminUrl: string;
  landingUrl: string;
}

const SITES: Record<string, Omit<Site, 'host'>> = {
  'niko.sxingxian.com': {
    rpId: 'sxingxian.com', kind: 'main',
    appUrl: 'https://niko.sxingxian.com/app', adminUrl: 'https://niko.sxingxian.com/admin', landingUrl: 'https://niko.sxingxian.com',
  },
  'niko.midnightpoetry.studio': {
    rpId: 'midnightpoetry.studio', kind: 'main',
    appUrl: 'https://nikoapp.midnightpoetry.studio', adminUrl: 'https://niko.midnightpoetry.studio/admin', landingUrl: 'https://niko.midnightpoetry.studio',
  },
  'nikoapp.midnightpoetry.studio': {
    rpId: 'midnightpoetry.studio', kind: 'app',
    appUrl: 'https://nikoapp.midnightpoetry.studio', adminUrl: 'https://niko.midnightpoetry.studio/admin', landingUrl: 'https://niko.midnightpoetry.studio',
  },
};

export function siteFor(url: URL): Site {
  const known = SITES[url.hostname];
  if (known) return { host: url.hostname, ...known };
  // Local development and preview deployments: behave like the first domain.
  const origin = url.origin;
  return { host: url.hostname, rpId: url.hostname, kind: 'main', appUrl: origin + '/app', adminUrl: origin + '/admin', landingUrl: origin };
}

export const ALLOWED_HOSTS = Object.keys(SITES);
