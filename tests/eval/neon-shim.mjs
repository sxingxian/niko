// Stands in for Neon's HTTP driver in apps/api/src/knowledge.ts during the release check, with a local PostgreSQL:
// sql.query(text, params) and sql.transaction([...]) as the Worker uses them.
import pg from 'pg';

const pools = new Map();
export function neon(url) {
  if (!pools.has(url)) pools.set(url, new pg.Pool({ connectionString: url, max: 4 }));
  const pool = pools.get(url);
  const query = (text, params = []) => {
    const run = async (client) => (await (client ?? pool).query(text, params)).rows;
    return { run, then: (ok, bad) => run().then(ok, bad) };
  };
  const transaction = async (queries) => {
    const c = await pool.connect();
    try {
      await c.query('begin');
      const out = [];
      for (const q of queries) out.push(await q.run(c));
      await c.query('commit');
      return out;
    } catch (e) { await c.query('rollback').catch(() => {}); throw e; } finally { c.release(); }
  };
  return { query, transaction };
}
export async function closeNeonShim() { for (const p of pools.values()) await p.end(); pools.clear(); }
