import { Hono } from 'hono';
import { createDb } from '@niko/db';
import { siteFor, type AppEnv, type Site } from './env';
import { sameOrigin } from './lib/session';
import { admin } from './routes/admin';
import { app as appRoutes, oauthCallback } from './routes/app';
import { auth, myPasskeys } from './routes/auth';
import { hooks } from './routes/hooks';

const api = new Hono<AppEnv>().basePath('/api');

// Secrets the API can't run without. A missing one is a deploy problem, so say so plainly in the
// Worker log and answer 503 instead of failing later inside a database call with a vague 500.
const REQUIRED_SECRETS = ['DATABASE_URL', 'ENCRYPTION_KEY'] as const;

api.use('*', async (c, next) => {
  const missing = REQUIRED_SECRETS.filter((k) => !c.env[k]);
  if (missing.length) {
    console.error(`niko not configured: Worker secret(s) missing: ${missing.join(', ')}. See docs/DEPLOYMENT.md section 2.`);
    return c.json({ error: 'Niko’s server isn’t fully set up yet. Try again in a few minutes.', code: 'not_configured' }, 503, { 'cache-control': 'no-store', 'retry-after': '60' });
  }
  c.set('db', createDb(c.env.DATABASE_URL));
  c.set('site', siteFor(new URL(c.req.url)));
  await next();
  c.header('cache-control', 'no-store');
});

// Webhooks and the OAuth return leg come from other sites, so they sit before the same-origin check.
api.route('/hooks', hooks);
api.get('/oauth/callback', oauthCallback);

api.use('*', sameOrigin);
api.route('/auth', auth);
api.route('/me/passkeys', myPasskeys);
api.route('/admin', admin);
api.route('/', appRoutes);

api.notFound((c) => c.json({ error: 'Not found.' }, 404));
/** One log line with the real reason. Drizzle wraps the Postgres error as `cause`, and logging only the
 * wrapper prints a bare stack. Query text and parameters are left out (they can hold emails and hashes). */
function describe(err: unknown): string {
  const parts: string[] = [];
  let e: any = err;
  for (let depth = 0; e && depth < 4; depth++, e = e.cause) {
    const msg = typeof e.message === 'string' ? e.message.replace(/^Failed query:[\s\S]*?(\nparams:[\s\S]*)?$/, 'Failed query') : String(e);
    parts.push([e.name, e.code && `code ${e.code}`, msg.slice(0, 300)].filter(Boolean).join(' · '));
  }
  return parts.join(' ← caused by ');
}

api.onError((err, c) => {
  console.error(`api error ${c.req.method} ${new URL(c.req.url).pathname}: ${describe(err)}`, err);
  return c.json({ error: 'Something went wrong on the server.' }, 500);
});

const SECURITY_HEADERS: Record<string, string> = {
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'permissions-policy': 'microphone=(self), camera=(), geolocation=()',
  'content-security-policy': [
    "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "font-src 'self'",
    "img-src 'self' data:", "media-src 'self' blob:", "connect-src 'self'", "frame-ancestors 'none'", "base-uri 'self'", "form-action 'self'", "object-src 'none'",
  ].join('; '),
};

/** Which built front end, and which file in it, a request maps to. */
function assetPath(site: Site, pathname: string): { path: string; spa: string } {
  const under = (prefix: string) => pathname === prefix || pathname.startsWith(prefix + '/');
  if (site.kind === 'app') {
    // nikoapp.*: the app lives at the root. Its built files still sit under /app/.
    return under('/app') ? { path: pathname, spa: '/app/index.html' } : { path: '/app' + pathname, spa: '/app/index.html' };
  }
  if (under('/admin')) return { path: pathname, spa: '/admin/index.html' };
  if (under('/app')) {
    return { path: pathname, spa: '/app/index.html' };
  }
  if (under('/landing')) return { path: pathname, spa: '/landing/index.html' };
  return { path: '/landing' + pathname, spa: '/landing/index.html' };
}

function manifest(site: Site): Response {
  const start = site.kind === 'app' ? '/' : '/app/';
  return Response.json({
    name: 'Niko', short_name: 'Niko', description: 'Your voice assistant across mail, calendars, notes and chats.',
    start_url: start, scope: start, display: 'standalone', orientation: 'any', background_color: '#05070d', theme_color: '#05070d',
    icons: [{ src: '/app/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' }],
  }, { headers: { 'content-type': 'application/manifest+json' } });
}

export default {
  async fetch(request: Request, env: AppEnv['Bindings'], ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return api.fetch(request, env, ctx);

    const site = siteFor(url);
    // On the second domain the app has its own host: send /app there instead of serving it twice.
    if (site.kind === 'main' && site.appUrl !== url.origin + '/app' && (url.pathname === '/app' || url.pathname.startsWith('/app/')) && !/\.[a-z0-9]+$/i.test(url.pathname)) {
      return Response.redirect(site.appUrl + url.pathname.slice(4) + url.search, 302);
    }
    if (url.pathname === '/app/manifest.webmanifest') return manifest(site);

    const { path, spa } = assetPath(site, url.pathname);
    const isFile = /\.[a-z0-9]+$/i.test(path);
    let res = await env.ASSETS.fetch(new Request(new URL(isFile ? path : spa, url.origin), request));
    if (res.status === 404 && !isFile) res = await env.ASSETS.fetch(new Request(new URL(spa, url.origin), request));
    const out = new Response(res.body, res);
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) out.headers.set(k, v);
    if (path.endsWith('/sw.js')) out.headers.set('service-worker-allowed', '/');
    if (!isFile || path.endsWith('.html')) out.headers.set('cache-control', 'no-cache');
    return out;
  },
};
