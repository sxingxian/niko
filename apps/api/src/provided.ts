// Services the admin provides to people. Each key is stored once, sealed, in provided_keys; a person's account lists
// which they get for each kind (users.provided), and an invite can carry the same (invites.setup) until they join.
// A provided key is added to the person's own keys only where keys are used and listed, never saved into their own
// key store, so they can see it but never read, change or remove it.
import { inArray } from 'drizzle-orm';
import { providedKeys, type Db } from '@niko/db';
import { arrangeOrder, brainOrder, cleanProvided, entryPrefix, hearOrder, imageOrder, mapOrder, PROVIDED_ID, USAGE_KINDS, voiceOrder, type EnginePrefs, type ProvidedSetup, type UsageKind } from '@niko/shared';
import type { Env } from './env';
import { seal, unseal } from './lib/crypto';

export type Provided<T> = T & { id: string; label: string; provided: true };
type UserLike = { provided?: unknown };

/** The entries ("key:px…", "vkey:px…") a person gets for a kind, in the admin's order. */
export function providedEntries(user: UserLike, kind: UsageKind): string[] {
  return (cleanProvided(user.provided).keys[kind] ?? []).map((id) => entryPrefix(kind) + id);
}
export const providedMode = (user: UserLike) => cleanProvided(user.provided).order;

/** The provided keys of one kind for this person, in the shape of that kind's own keys. */
export async function providedFor<T extends object>(env: Env, db: Db, user: UserLike, kind: UsageKind): Promise<Provided<T>[]> {
  const ids = cleanProvided(user.provided).keys[kind] ?? [];
  if (!ids.length) return [];
  const rows = await db.select().from(providedKeys).where(inArray(providedKeys.id, ids)).catch(() => []);
  const out: Provided<T>[] = [];
  for (const id of ids) {
    const r = rows.find((x) => x.id === id && x.kind === kind);
    if (!r) continue;
    const secret = await unseal<T & { label?: string }>(env.ENCRYPTION_KEY, r.secretEnc).catch(() => null);
    if (secret) out.push({ ...secret, id, label: r.label || String(secret.label ?? ''), provided: true });
  }
  return out;
}

/** A person's own keys with the provided ones added (for using and listing keys, never for saving them). */
export async function withProvided<T extends { id: string }>(env: Env, db: Db, user: UserLike, kind: UsageKind, own: T[]): Promise<(T | Provided<T>)[]> {
  const extra = await providedFor<T>(env, db, user, kind);
  return [...own, ...extra.filter((p) => !own.some((o) => o.id === p.id))];
}

/** An order with the provided services where the admin wants them: when the order is fixed, first and in their order. */
export function arranged<T extends string>(user: UserLike, kind: UsageKind, order: T[]): T[] {
  return arrangeOrder(order, providedEntries(user, kind), providedMode(user));
}

export function newProvidedId(): string {
  return 'px' + Array.from(crypto.getRandomValues(new Uint8Array(10)), (n) => 'abcdefghijklmnopqrstuvwxyz0123456789'[n % 36]).join('');
}
export const sealProvided = (env: Env, secret: object) => seal(env.ENCRYPTION_KEY, secret);
/** The last four characters of a key, to tell keys apart in the admin portal. */
export const keyHint = (apiKey: string) => (apiKey.length >= 12 ? apiKey.slice(-4) : '');

/** A person's engine with the provided services in it: ones no longer provided are taken out of every order, and the
 * provided ones go first (in the admin's order), so they are used straight away. Everything else keeps its place. */
export function engineWithProvided(engine: Partial<EnginePrefs>, setup: ProvidedSetup): Partial<EnginePrefs> {
  const e: Partial<EnginePrefs> = { ...engine };
  const cut = (k: UsageKind, list: string[]) => list.filter((x) => !(x.startsWith(entryPrefix(k)) && PROVIDED_ID.test(x.slice(entryPrefix(k).length))));
  const top = (k: UsageKind, list: string[]) => [...(setup.keys[k] ?? []).map((id) => entryPrefix(k) + id), ...cut(k, list)];
  for (const k of USAGE_KINDS) {
    const has = !!setup.keys[k]?.length;
    if (k === 'brain') { const l = top(k, brainOrder(e)); e.brains = (l.length ? l : ['workers-ai']) as EnginePrefs['brains']; }
    if (k === 'voice') e.voices = top(k, voiceOrder(e)) as EnginePrefs['voices'];
    if (k === 'hear') e.hears = top(k, hearOrder(e)) as EnginePrefs['hears'];
    if (k === 'image') { const cur = imageOrder(e); e.images = (has || cur.length ? top(k, cur) : cur) as EnginePrefs['images']; }
    if (k === 'map') e.maps = top(k, mapOrder(e)) as EnginePrefs['maps'];
  }
  return e;
}
