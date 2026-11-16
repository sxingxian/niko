// Stand-ins for the database tables and the saved-credentials reader, so the brain order can run without a database.
export const users = { name: 'users', id: 'id' };
export const connections = { name: 'connections', userId: 'userId', provider: 'provider' };
export const store = { creds: {}, engineWrites: [], keyWrites: [] };
export async function credentials(_env, _db, _userId, provider) { return store.creds[provider] ?? null; }
export function publicHttpsUrl(raw) {
  try { const u = new URL(String(raw)); return u.protocol === 'https:' && !/^(localhost|127\.|10\.|192\.168\.)/.test(u.hostname) ? u : null; } catch { return null; }
}
export const fakeDb = {
  update: () => ({ set: (v) => ({ where: async () => { store.engineWrites.push(v.engine); } }) }),
  delete: () => ({ where: async () => {} }),
  insert: () => ({ values: async (v) => { store.keyWrites.push(v); } }),
};
export const appSettings = { name: 'app_settings', key: 'key', value: 'value' };
export const glanceState = { name: 'glance_state', userId: 'user_id' };
