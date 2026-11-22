// A copy of what Niko learned, to read and edit in the person's own Notion, Google Drive, OneDrive, storage or vault
// (their choice of where Niko keeps what it learns). Niko keeps the notes in kn_learned as always; this keeps one
// "What Niko learned" document there: the same document is updated in place (never deleted and made again), one
// bullet per note, and a bullet added, changed or removed there is picked up by Niko the next time it looks. The same
// code runs for every place. A change someone else made on a shared page is ignored, and what is picked up goes through
// the same checks as anything the person tells Niko (no passwords or codes, the same limits).
import { KN_LEARNED_KIND_NAMES, type KnLearnedItem, type KnLearnedKind, type KnRemotePlace } from '@niko/shared';
import type { Env } from './env';
import type { Kdb } from './knowledge';
import { KnError } from './knowledge';
import { forgetNote, listLearned, saveNote } from './learned';
import { PlaceError, type Remote } from './knPlaces';
import { placeRoot } from './knPlacesStore';

export const LEARNED_COPY_TITLE = 'What Niko learned';
export const LEARNED_INTRO = 'Kept up to date by Niko. One bullet for each note: add, change or remove a bullet here and Niko picks it up. You can also edit in Niko · Settings · Knowledge.';
/** Niko rewrites the copy at most this often; changes in between are written next time. */
export const LEARNED_COPY_EVERY_MS = 60_000;
const ORDER: KnLearnedKind[] = ['person', 'correction', 'playbook', 'habit', 'remembered'];

/** What the last look at the copy picked up from it (edits made there). */
export interface PickedUp { added: number; removed: number; skipped: number; ignored?: boolean; refused?: boolean; at: string }
export interface LearnedCopy { place: KnRemotePlace; remoteId: string | null; url: string | null; dirty: boolean; syncedAt: string | null; error: string | null; picked: PickedUp | null }
type Row = { place: KnRemotePlace; remote_id: string | null; remote_url: string | null; dirty: boolean; synced_at: string | Date | null; error: string | null; picked: PickedUp | null; written: string | null; checked_at: string | Date | null };
const COLS = 'place, remote_id, remote_url, dirty, synced_at, error, picked, written, checked_at';
const asCopy = (r: Row): LearnedCopy => ({ place: r.place, remoteId: r.remote_id, url: r.remote_url, dirty: r.dirty, syncedAt: r.synced_at ? new Date(r.synced_at).toISOString() : null, error: r.error, picked: r.picked ?? null });

/** The document: one heading per kind, one line per note (each a list item, so nothing people typed becomes a heading).
 *  Matches taught for files and habits only suggested are left out. Notion pages have their own title, so no first
 *  heading there. */
export function learnedMarkdown(items: KnLearnedItem[], titled = true): string {
  const plain = (s: string) => s.replace(/\s+/g, ' ').trim();
  const out = [...(titled ? [`# ${LEARNED_COPY_TITLE}`, ''] : []), LEARNED_INTRO];
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


// ---------------------------------------------------------------- reading the copy back
const NAME_KIND = new Map(Object.entries(KN_LEARNED_KIND_NAMES).map(([k, v]) => [v.toLowerCase(), k as KnLearnedKind]));
/** The text of a line as every place keeps it: Markdown escapes and links taken off, quotes and spaces made alike. */
export const tidy = (s: string) => s
  .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
  .replace(/\\([\\`*_{}\[\]()#+\-.!>~|“”])/g, '$1')
  .replace(/[\u0000-\u001f\u007f ]/g, ' ').replace(/[“”„]/g, '"').replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim();
const keyOf = (kind: string, said: string, means: string) => `${kind}\u0001${tidy(said)}\u0001${tidy(means)}`;
export interface ParsedNote { kind: KnLearnedKind; said: string; means: string; key: string }
/** The page back into notes: a heading names the kind, each bullet is one note. `ok` is false when the page isn't the
 *  one Niko wrote any more (its first lines are gone), and then nothing is picked up from it. */
export function parseLearnedMarkdown(md: string): { ok: boolean; notes: ParsedNote[]; skipped: number } {
  const notes: ParsedNote[] = [];
  let kind: KnLearnedKind | null = null, skipped = 0;
  for (const raw of md.split('\n')) {
    const h = /^\s*#{1,6}\s+(.+?)\s*#*\s*$/.exec(raw);
    if (h) { kind = NAME_KIND.get(tidy(h[1]!).toLowerCase()) ?? null; continue; }
    const b = /^\s*(?:[-*•]|\d+[.)])\s+(.*)$/.exec(raw);
    if (!b) continue;
    const text = tidy(b[1]!);
    if (!text) continue;
    if (!kind || kind === 'file-match') { skipped++; continue; }
    if (kind === 'remembered' || kind === 'habit') { notes.push({ kind, said: text, means: text, key: keyOf(kind, text, text) }); continue; }
    const m = /^"(.+?)"\s*(?:→|->|=>)\s*(.+)$/.exec(text) ?? /^(.+?)\s*(?:→|->|=>)\s*(.+)$/.exec(text);
    if (!m) { skipped++; continue; }
    notes.push({ kind, said: m[1]!.trim(), means: m[2]!.trim(), key: keyOf(kind, m[1]!, m[2]!) });
  }
  return { ok: /kept up to date by niko/i.test(md), notes, skipped };
}
/** What Niko keeps, as the page shows it. */
function pageNotes(items: KnLearnedItem[]): { id: string; kind: KnLearnedKind; key: string }[] {
  return ORDER.flatMap((kind) => items.filter((n) => n.kind === kind && (kind !== 'habit' || n.confirmed))
    .map((n) => ({ id: n.id, kind, key: kind === 'remembered' || kind === 'habit' ? keyOf(kind, n.said, n.said) : keyOf(kind, n.said, n.means) })));
}
/** Most notes taken in, or forgotten, in one look at the page. */
const PICK_MAX = 100;
/**
 * Changes made on the page since Niko last wrote it (a bullet there that Niko didn't write is a new note; one Niko wrote
 * that's gone is forgotten), applied to the notes. A note Niko learned since it last wrote the page isn't touched: it
 * isn't on the page yet. If most of the notes vanished at once, nothing is forgotten (a wiped page, not a decision).
 */
export async function pickUpEdits(k: Kdb, env: Pick<Env, 'AI'>, account: string, page: string, written: string, how: { cloudflare: boolean }): Promise<PickedUp | null> {
  const now = parseLearnedMarkdown(page);
  if (!now.ok) return null;
  const before = new Set(parseLearnedMarkdown(written).notes.map((n) => n.key));
  const here = new Set(now.notes.map((n) => n.key));
  const cur = pageNotes(await listLearned(k, account));
  const have = new Set(cur.map((n) => n.key));
  let removed = 0, added = 0, skipped = now.skipped, refused = false;
  const gone = cur.filter((n) => before.has(n.key) && !here.has(n.key));
  if (gone.length > 20 && gone.length > cur.length / 2) refused = true;
  else for (const n of gone.slice(0, PICK_MAX)) if (await forgetNote(k, account, n.id)) removed++;
  const seen = new Set<string>();
  for (const n of now.notes) {
    if (before.has(n.key) || have.has(n.key) || seen.has(n.key) || n.kind === 'habit') continue;
    seen.add(n.key);
    if (added >= PICK_MAX) { skipped++; continue; }
    try { await saveNote(k, env, account, { kind: n.kind as 'person' | 'correction' | 'remembered' | 'playbook', said: n.said, means: n.means, how: 'told' }, how); added++; }
    catch (e) { if (e instanceof KnError) skipped++; else throw e; }
  }
  return { added, removed, skipped, ...(refused ? { refused: true } : {}), at: new Date().toISOString() };
}

export async function learnedCopyOf(k: Kdb, account: string): Promise<LearnedCopy | null> {
  const [r] = await k.q<Row>(`select ${COLS} from kn_learned_copy where account_id = $1`, [account]);
  return r ? asCopy(r) : null;
}
/** Starts keeping a copy in this place (written on the next sync), or stops (null). A copy already made elsewhere
 *  stays where it is; Niko just stops updating it. */
export async function setLearnedCopy(k: Kdb, account: string, place: KnRemotePlace | null): Promise<void> {
  if (!place) { await k.q(`delete from kn_learned_copy where account_id = $1`, [account]); return; }
  await k.q(`insert into kn_learned_copy (account_id, place, dirty) values ($1, $2, true)
             on conflict (account_id) do update set place = excluded.place, dirty = true,
               remote_id = case when kn_learned_copy.place = excluded.place then kn_learned_copy.remote_id end,
               remote_url = case when kn_learned_copy.place = excluded.place then kn_learned_copy.remote_url end,
               written = case when kn_learned_copy.place = excluded.place then kn_learned_copy.written end, picked = null, error = null`, [account, place]);
}
/** Something Niko learned changed: the copy (if there is one) is rewritten on the next sync. */
export async function markLearnedDirty(k: Kdb, account: string): Promise<boolean> {
  return (await k.q(`update kn_learned_copy set dirty = true where account_id = $1 returning account_id`, [account])).length > 0;
}

/** Niko looks at the copy for edits at most this often. */
export const LEARNED_LOOK_EVERY_MS = 20_000;
export interface SyncOptions { /** Look for edits made there first (needs the AI binding for search numbers and how notes are searched). */ look?: { env: Pick<Env, 'AI'>; how: { cloudflare: boolean } } }

/** Looks at the copy for edits, then rewrites it when something changed (and at most once a minute): the same document is
 *  updated in place; only where a place can't, a new one is made and the old one goes to the bin. */
export async function syncLearnedCopy(k: Kdb, remote: Remote, account: string, now = Date.now(), opt: SyncOptions = {}): Promise<LearnedCopy & { waited?: boolean }> {
  const read = async () => (await k.q<Row>(`select ${COLS} from kn_learned_copy where account_id = $1`, [account]))[0];
  let row = await read();
  if (!row || row.place !== remote.place) throw new PlaceError('There’s no copy kept there.', 409);
  let forced = false;
  try {
    if (opt.look && row.remote_id && (!row.checked_at || now - Date.parse(String(row.checked_at)) >= LEARNED_LOOK_EVERY_MS)) {
      const id = row.remote_id;
      const there = await remote.version(id, 'doc');
      if (there === null) {
        // The page is gone (deleted or in the bin there): Niko writes it again.
        await k.q(`update kn_learned_copy set remote_id = null, remote_url = null, written = null, dirty = true, synced_at = null, checked_at = now() where account_id = $1`, [account]);
      } else {
        let picked: PickedUp | null = null;
        if (remote.editedByOther && await remote.editedByOther(id).catch(() => false)) picked = { added: 0, removed: 0, skipped: 0, ignored: true, at: new Date().toISOString() };
        else {
          const base = row.written ?? (row.dirty ? null : learnedMarkdown(await listLearned(k, account), remote.place !== 'notion'));
          if (base !== null) picked = await pickUpEdits(k, opt.look.env, account, await remote.readDoc(id), base, opt.look.how);
        }
        const changed = !!picked && (picked.added > 0 || picked.removed > 0);
        if (changed) forced = true;
        await k.q(`update kn_learned_copy set checked_at = now(), dirty = dirty or $2, picked = case when $3::jsonb is null then picked else $3::jsonb end where account_id = $1`,
          [account, changed, picked && (changed || picked.skipped > 0 || picked.ignored || picked.refused) ? JSON.stringify(picked) : null]);
      }
      row = (await read())!;
    }
    const copy = asCopy(row);
    if (!copy.dirty && copy.remoteId) return copy;
    if (!forced && copy.syncedAt && now - Date.parse(copy.syncedAt) < LEARNED_COPY_EVERY_MS && copy.remoteId) return { ...copy, waited: true };
    const root = await placeRoot(k, remote, account);
    const md = learnedMarkdown(await listLearned(k, account), remote.place !== 'notion');
    // One "What Niko learned" there: one Niko wrote before and lost track of (after a change of place and back) is used
    // again, and any others it finds there go to the bin.
    const found = remote.findDocs ? await remote.findDocs(root.id, LEARNED_COPY_TITLE).catch(() => []) : [];
    const same = (a: string, b: string) => a.replace(/-/g, '').toLowerCase() === b.replace(/-/g, '').toLowerCase();
    const keep = copy.remoteId ?? found[0]?.id ?? null;
    const extra = found.filter((f) => !keep || !same(f.id, keep)).map((f) => f.id);
    const w = keep && remote.replaceDoc ? await remote.replaceDoc(keep, LEARNED_COPY_TITLE, md).catch((e) => { if (e instanceof PlaceError && e.status !== 413 && e.status < 500 && e.status !== 404) throw e; return remote.writeDoc(root.id, LEARNED_COPY_TITLE, md); }) : await remote.writeDoc(root.id, LEARNED_COPY_TITLE, md);
    for (const old of [...(keep && !same(keep, w.id) ? [keep] : []), ...extra]) await remote.trash(old, 'doc').catch(() => undefined);
    // A page only partly updated (a big change, Notion takes a few requests at a time) isn't read for edits until the
    // rest is written: what's missing from it isn't something the person removed.
    const [r] = await k.q<Row>(`update kn_learned_copy set remote_id = $2, remote_url = $3, dirty = $4, synced_at = case when $4 then null else now() end, error = null, written = $5
       where account_id = $1 returning ${COLS}`, [account, w.id, w.url, !!w.more, w.more ? null : md]);
    return asCopy(r!);
  } catch (e) {
    // A page Niko made that's gone is forgotten, so the next copy makes a new one. A page they picked is never swapped
    // for another behind their back: they're told, and choose again.
    let picked = false;
    if (e instanceof PlaceError && e.gone) {
      picked = (await k.q(`select 1 from kn_places where account_id = $1 and place = $2 and made = false`, [account, remote.place])).length > 0;
      if (!picked) await k.q(`delete from kn_places where account_id = $1 and place = $2`, [account, remote.place]);
    }
    const msg = picked ? 'Niko can’t reach the page you picked any more. Share it with Niko in Notion, or choose another page.' : e instanceof PlaceError ? e.message : 'The copy couldn’t be written. Try again in a moment.';
    await k.q(`update kn_learned_copy set error = $2 where account_id = $1`, [account, msg.slice(0, 300)]);
    throw e instanceof PlaceError ? e : new PlaceError(msg);
  }
}
/** Why the copy couldn't be written, when it didn't get as far as trying (the app isn't connected any more). */
export async function noteLearnedError(k: Kdb, account: string, message: string): Promise<void> {
  await k.q(`update kn_learned_copy set error = $2 where account_id = $1`, [account, message.slice(0, 300)]);
}
/** "Forget everything Niko learned": the copy there goes to the bin too, and Niko stops keeping one there. */
export async function binLearnedCopy(k: Kdb, remote: Remote | null, account: string): Promise<void> {
  const copy = await learnedCopyOf(k, account);
  if (copy?.remoteId && remote && remote.place === copy.place) await remote.trash(copy.remoteId, 'doc').catch(() => undefined);
  if (copy) await k.q(`update kn_learned_copy set remote_id = null, remote_url = null, written = null, picked = null, dirty = true, synced_at = null where account_id = $1`, [account]);
}
