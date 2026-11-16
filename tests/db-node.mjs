// The real schema, with a local PostgreSQL (node-postgres) in place of Neon's HTTP driver, for the payments test.
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { schema } from '../packages/db/src/index.ts';

export * from '../packages/db/src/index.ts';

const pools = new Map();
export function createDb(url) {
  if (!pools.has(url)) pools.set(url, new pg.Pool({ connectionString: url, max: 4 }));
  return drizzle(pools.get(url), { schema });
}
export async function closePools() { for (const p of pools.values()) await p.end(); pools.clear(); }
