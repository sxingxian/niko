// What a question carries for Knowledge: for files kept on this device, the best matches found here; for files kept in
// Niko and searched on this device, the question's search numbers. And when Niko asks to count or add up in a table
// kept here, the look-ups run here and the question is asked again with their results.
import { api } from '@niko/ui';
import { cleanTableAsks, type KnHow, type KnTarget, type Me } from '@niko/shared';
import { embedReady, embedTexts } from './embed';
import { forgetDeviceKnowledge, keepNoteHere, lookupHere, searchHere } from './knowledgeDevice';

export async function knowledgeFor(me: Me | null | undefined, text: string, opts: { pin?: KnTarget | null } = {}): Promise<Record<string, unknown> | null> {
  const k = me?.knowledge;
  if (!me || !k) return null;
  try {
    if (k.place === 'device') return (await searchHere(me.id, text, { pin: opts.pin })) as unknown as Record<string, unknown> | null;
    if (k.search === 'device' && embedReady()) { const v = (await embedTexts([text], 'query'))?.[0]; return v ? { vector: v } : null; }
  } catch { /* Knowledge never stops an answer: Niko answers without files */ }
  return null;
}

export async function chatWithTables<T>(me: Me | null | undefined, body: Record<string, unknown>): Promise<T> {
  const r = await api<T & { pending?: boolean; tableAsks?: unknown }>('/chat', { body });
  if (!r.pending) return r;
  const results = me ? await lookupHere(me.id, cleanTableAsks(r.tableAsks)).catch(() => [] as string[]) : [];
  return api<T>('/chat', { body: { ...body, tableResults: results.length ? results : ['The look-up couldn’t be done on this device.'] } });
}

/** Forgets the unlocked files when a different person (or nobody) is signed in. */
let lastAccount: string | null = null;
export function knowledgeAccount(id: string | null | undefined) {
  if ((id ?? null) !== lastAccount) { if (lastAccount) forgetDeviceKnowledge(); lastAccount = id ?? null; }
}

/** Notes the answer asked to keep, when the person's Knowledge is on this device: kept here, and returned with their ids
 *  so "Undo" can forget them. */
export async function keepDeviceNotes(me: Me | null | undefined, learn: unknown): Promise<{ id: string; kind: string; said: string; means: string }[]> {
  if (!me || me.knowledge?.place !== 'device' || !Array.isArray(learn)) return [];
  const out: { id: string; kind: string; said: string; means: string }[] = [];
  for (const raw of learn.slice(0, 2)) {
    const x = (raw && typeof raw === 'object' ? raw : {}) as { kind?: unknown; said?: unknown; means?: unknown; how?: unknown };
    const kind = x.kind === 'person' || x.kind === 'correction' || x.kind === 'remembered' ? x.kind : null;
    if (!kind || typeof x.said !== 'string' || typeof x.means !== 'string') continue;
    const how = (['told', 'corrected', 'chose', 'remember'] as const).find((h) => h === x.how) ?? 'told';
    try { const it = await keepNoteHere(me.id, { kind, said: x.said, means: x.means, how: how as KnHow }); out.push({ id: it.id, kind: it.kind, said: it.said, means: it.means }); } catch { /* not kept */ }
  }
  return out;
}
