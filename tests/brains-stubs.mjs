// Stand-ins for the database tables and the saved-credentials reader, so the brain order can run without a database.
export const users = { name: 'users', id: 'id' };
export const connections = { name: 'connections', userId: 'userId', provider: 'provider' };
export const store = { creds: {}, engineWrites: [], keyWrites: [] };
export async function credentials(_env, _db, _userId, provider) { return store.creds[provider] ?? null; }
export async function getConnection(_db, _userId, provider) { return store.creds[provider] ? { meta: {} } : undefined; }
export async function notionPeople() { return { owner: 'owner-1', bot: 'bot-1' }; }
export function publicHttpsUrl(raw) {
  // The same rule as apps/api/src/providers.ts.
  if (typeof raw !== 'string') return null;
  let u; try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== 'https:' || u.username || u.password) return null;
  const h = u.hostname.toLowerCase();
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal') || h.startsWith('[')) return null;
  if (/^(10\.|127\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h)) return null;
  return u;
}
export const fakeDb = {
  // A skip list is saved as that one field (rest, voiceRest…): recorded as { [field]: list }.
  update: () => ({ set: (v) => ({ where: async () => { store.engineWrites.push(v.engine?.restKey ? { [v.engine.restKey]: v.engine.rest } : v.engine); } }) }),
  delete: () => ({ where: async () => {} }),
  insert: () => ({ values: async (v) => { store.keyWrites.push(v); } }),
  // Reads find nothing (no settings, no usage this month); counting use does nothing.
  select: () => { const q = { from: () => q, where: () => q, limit: () => q, orderBy: () => q, leftJoin: () => q, then: (ok, bad) => Promise.resolve([]).then(ok, bad), catch: (f) => Promise.resolve([]).catch(f) }; return q; },
  execute: async () => ({ rows: [] }),
};
export const appSettings = { name: 'app_settings', key: 'key', value: 'value' };
export const glanceState = { name: 'glance_state', userId: 'user_id' };
export const providedKeys = { name: 'provided_keys', id: 'id', kind: 'kind' };
export const usageCounts = { name: 'usage_counts', userId: 'user_id', month: 'month', kind: 'kind', entry: 'entry', n: 'n' };
