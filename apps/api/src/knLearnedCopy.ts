// A copy of what Niko learned, to read in the person's own Notion, Google Drive, OneDrive or storage (their choice of
// where Niko keeps what it learns). Niko keeps the notes in kn_learned as always; this writes one "What Niko learned"
// document there and keeps it up to date. Only Niko writes it: changes made there are never read back, so a shared page
// someone else can edit can't add to what Niko learned.
import { KN_LEARNED_KIND_NAMES, type KnLearnedItem, type KnLearnedKind, type KnRemotePlace } from '@niko/shared';
import type { Kdb } from './knowledge';
import { listLearned } from './learned';
import { PlaceError, type Remote } from './knPlaces';
import { placeRoot } from './knPlacesStore';

export const LEARNED_COPY_TITLE = 'What Niko learned';
/** Niko rewrites the copy at most this often; changes in between are written next time. */
export const LEARNED_COPY_EVERY_MS = 60_000;
const ORDER: KnLearnedKind[] = ['person', 'correction', 'playbook', 'habit', 'remembered'];

export interface LearnedCopy { place: KnRemotePlace; remoteId: string | null; url: string | null; dirty: boolean; syncedAt: string | null; error: string | null }
type Row = { place: KnRemotePlace; remote_id: string | null; remote_url: string | null; dirty: boolean; synced_at: string | Date | null; error: string | null };
const asCopy = (r: Row): LearnedCopy => ({ place: r.place, remoteId: r.remote_id, url: r.remote_url, dirty: r.dirty, syncedAt: r.synced_at ? new Date(r.synced_at).toISOString() : null, error: r.error });

/** The document: one heading per kind, one line per note (each a list item, so nothing people typed becomes a heading).
 *  Matches taught for files and habits only suggested are left out. Notion pages have their own title, so no first
 *  heading there. */
export function learnedMarkdown(items: KnLearnedItem[], titled = true): string {
  const plain = (s: string) => s.replace(/\s+/g, ' ').trim();
  const out = [...(titled ? [`# ${LEARNED_COPY_TITLE}`, ''] : []), 'Kept up to date by Niko. Changes made here aren’t read back: edit in Niko · Settings · Knowledge.'];
  const head = out.length;
  for (const kind of ORDER) {
    const list = items.filter((n) => n.kind === kind && (kind !== 'habit' || n.confirmed));
    if (!list.length) continue;
    out.push('', `## ${KN_LEARNED_KIND_NAMES[kind]}`, '');
    for (const n of list) out.push(kind === 'remembered' || kind === 'habit' ? `- ${plain(n.said)}` : kind === 'person' || kind === 'correction' ? `- “${plain(n.said)}” → ${plain(n.means)}` : `- ${plain(n.said)} → ${plain(n.means)}`);
  }
  if (out.length === head) out.push('', 'Nothing yet.');
  return out.join('\n') + '\n';
}

export async function learnedCopyOf(k: Kdb, account: string): Promise<LearnedCopy | null> {
  const [r] = await k.q<Row>(`select place, remote_id, remote_url, dirty, synced_at, error from kn_learned_copy where account_id = $1`, [account]);
  return r ? asCopy(r) : null;
}
/** Starts keeping a copy in this place (written on the next sync), or stops (null). A copy already made elsewhere
 *  stays where it is; Niko just stops updating it. */
export async function setLearnedCopy(k: Kdb, account: string, place: KnRemotePlace | null): Promise<void> {
  if (!place) { await k.q(`delete from kn_learned_copy where account_id = $1`, [account]); return; }
  await k.q(`insert into kn_learned_copy (account_id, place, dirty) values ($1, $2, true)
             on conflict (account_id) do update set place = excluded.place, dirty = true,
               remote_id = case when kn_learned_copy.place = excluded.place then kn_learned_copy.remote_id end,
               remote_url = case when kn_learned_copy.place = excluded.place then kn_learned_copy.remote_url end, error = null`, [account, place]);
}
/** Something Niko learned changed: the copy (if there is one) is rewritten on the next sync. */
export async function markLearnedDirty(k: Kdb, account: string): Promise<boolean> {
  return (await k.q(`update kn_learned_copy set dirty = true where account_id = $1 returning account_id`, [account])).length > 0;
}

/** Rewrites the copy when something changed (and at most once a minute): a new document, then the old one to the bin
 *  there (or the same file overwritten, for OneDrive and storage). */
export async function syncLearnedCopy(k: Kdb, remote: Remote, account: string, now = Date.now()): Promise<LearnedCopy & { waited?: boolean }> {
  const copy = await learnedCopyOf(k, account);
  if (!copy || copy.place !== remote.place) throw new PlaceError('There’s no copy kept there.', 409);
  if (!copy.dirty && copy.remoteId) return copy;
  if (copy.syncedAt && now - Date.parse(copy.syncedAt) < LEARNED_COPY_EVERY_MS && copy.remoteId) return { ...copy, waited: true };
  try {
    const root = await placeRoot(k, remote, account);
    const md = learnedMarkdown(await listLearned(k, account), remote.place !== 'notion');
    const w = copy.remoteId && remote.replaceDoc ? await remote.replaceDoc(copy.remoteId, LEARNED_COPY_TITLE, md) : await remote.writeDoc(root.id, LEARNED_COPY_TITLE, md);
    if (copy.remoteId && copy.remoteId !== w.id) await remote.trash(copy.remoteId, 'doc').catch(() => undefined);
    const [r] = await k.q<Row>(`update kn_learned_copy set remote_id = $2, remote_url = $3, dirty = false, synced_at = now(), error = null where account_id = $1
       returning place, remote_id, remote_url, dirty, synced_at, error`, [account, w.id, w.url]);
    return asCopy(r!);
  } catch (e) {
    if (e instanceof PlaceError && e.gone) await k.q(`delete from kn_places where account_id = $1 and place = $2`, [account, remote.place]);
    const msg = e instanceof PlaceError ? e.message : 'The copy couldn’t be written.';
    await k.q(`update kn_learned_copy set error = $2 where account_id = $1`, [account, msg.slice(0, 300)]);
    throw e instanceof PlaceError ? e : new PlaceError(msg);
  }
}
/** "Forget everything Niko learned": the copy there goes to the bin too, and Niko stops keeping one there. */
export async function binLearnedCopy(k: Kdb, remote: Remote | null, account: string): Promise<void> {
  const copy = await learnedCopyOf(k, account);
  if (copy?.remoteId && remote && remote.place === copy.place) await remote.trash(copy.remoteId, 'doc').catch(() => undefined);
  if (copy) await k.q(`update kn_learned_copy set remote_id = null, remote_url = null, dirty = true, synced_at = null where account_id = $1`, [account]);
}
