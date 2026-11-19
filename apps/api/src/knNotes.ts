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
/** Whether a Notion search result is one of those, or sits directly in one (a page under Niko's page, a database row). */
export function isKnowledgeNotion(p: { id?: unknown; parent?: { page_id?: unknown; database_id?: unknown } }, ids: Set<string>): boolean {
  const n = (v: unknown) => (typeof v === 'string' ? v.replace(/-/g, '').toLowerCase() : '');
  return ids.has(n(p.id)) || ids.has(n(p.parent?.page_id)) || ids.has(n(p.parent?.database_id));
}
