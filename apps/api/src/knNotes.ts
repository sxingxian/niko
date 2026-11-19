// Keeping Knowledge out of the person's Notes in Niko: the Notion pages Niko made for Knowledge (copies of their files,
// those files' databases and rows, "What Niko learned", and Niko's own "Niko Knowledge" page) are left out of Notes, the
// glance and the briefing. A page the person picked for Knowledge is theirs and stays.
import type { Kdb } from './knowledge';

/** The Notion pages and databases Niko made for Knowledge (copies of files, their databases, what Niko learned, and its
 *  own "Niko Knowledge" page, not a page the person picked), so Niko's Notes leaves them out. Ids without dashes. */
export async function knowledgeNotionIds(k: Kdb, account: string): Promise<Set<string>> {
  const rows = await k.q<{ id: string }>(
    `select remote_id as id from kn_documents where account_id = $1 and place = 'notion' and remote_id is not null
     union select s.remote_id from kn_sheets s join kn_documents d on d.id = s.document_id where s.account_id = $1 and d.place = 'notion' and s.remote_id is not null
     union select root_id from kn_places where account_id = $1 and place = 'notion' and made
     union select remote_id from kn_learned_copy where account_id = $1 and place = 'notion' and remote_id is not null`, [account]);
  return new Set(rows.map((r) => r.id.replace(/-/g, '').toLowerCase()));
}
type NPage = { id?: unknown; created_by?: { id?: unknown }; parent?: { page_id?: unknown; database_id?: unknown } };
const nid = (v: unknown) => (typeof v === 'string' ? v.replace(/-/g, '').toLowerCase() : '');

/** Whether a Notion search result is one of those, or sits directly in one (a page under Niko's page, a database row).
 *  `bot` is Niko's own Notion connection: Niko's Notes never makes Notion pages, so anything Notion says that connection
 *  created is Knowledge's, even a page Niko no longer keeps track of (after a change of place, or a copy kept). */
export function isKnowledgeNotion(p: NPage, ids: Set<string>, bot = ''): boolean {
  return ids.has(nid(p.id)) || ids.has(nid(p.parent?.page_id)) || ids.has(nid(p.parent?.database_id)) || (!!bot && nid(p.created_by?.id) === nid(bot));
}

/** Leaves out of a list of Notion pages everything Niko made for Knowledge and everything sitting in it: what Niko keeps
 *  track of, what Notion says Niko's connection created, and pages whose page or database is one of those. A parent that
 *  isn't in the list is looked up (a few per list, remembered), so rows of Niko's databases and pages the person added
 *  on Niko's page go too. `creator` gives who created a page or database, or null if it can't be read. */
export async function withoutKnowledge<T extends NPage>(pages: T[], ids: Set<string>, bot: string, creator: (id: string, kind: 'page' | 'database') => Promise<string | null>): Promise<T[]> {
  const made = new Set(ids), b = nid(bot), seen = new Set(pages.map((p) => nid(p.id)));
  if (b) for (const p of pages) if (nid(p.created_by?.id) === b) made.add(nid(p.id));
  if (b) {
    const ask = new Map<string, 'page' | 'database'>();
    for (const p of pages) {
      const pid = nid(p.parent?.page_id), did = nid(p.parent?.database_id);
      if (pid && !made.has(pid) && !seen.has(pid)) ask.set(pid, 'page');
      if (did && !made.has(did)) ask.set(did, 'database');
    }
    const look = [...ask].slice(0, LOOKUPS);
    const who = await Promise.all(look.map(([id, kind]) => creator(id, kind).catch(() => null)));
    look.forEach(([id], i) => { if (who[i] && nid(who[i]) === b) made.add(id); });
  }
  return pages.filter((p) => !isKnowledgeNotion(p, made));
}
/** The most parents looked up for one list. */
const LOOKUPS = 8;
