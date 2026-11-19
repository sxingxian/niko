// What a question carries for Knowledge: for files kept on this device, the best matches found here; for files kept in
// Niko and searched on this device, the question's search numbers. And when Niko asks to count or add up in a table
// kept here, the look-ups run here and the question is asked again with their results.
import { api } from '@niko/ui';
import { cleanTableAsks, type Me } from '@niko/shared';
import { embedReady, embedTexts } from './embed';
import { forgetDeviceKnowledge, lookupHere, searchHere } from './knowledgeDevice';

export async function knowledgeFor(me: Me | null | undefined, text: string): Promise<Record<string, unknown> | null> {
  const k = me?.knowledge;
  if (!me || !k) return null;
  try {
    if (k.place === 'device') return (await searchHere(me.id, text)) as unknown as Record<string, unknown> | null;
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
