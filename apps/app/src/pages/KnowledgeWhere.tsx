// "Where in …" for Knowledge kept in someone's own app, as the Knowledge-Location mockup: in Notion a page Niko makes
// (named by them) or one of their own pages; in Google Drive and OneDrive the name of Niko's folder (the narrow access
// chosen lets Niko see only its own folder); in their storage or vault any folder. Changing it copies files and what
// Niko learned to the new place; copies in the old one stay there.
import { useEffect, useState } from 'react';
import { api } from '@niko/ui';
import { KN_DEFAULT_FOLDER, type KnRemotePlace } from '@niko/shared';

export type Relocated = { files: number; learned: boolean };
const HINT: Record<KnRemotePlace, string> = {
  notion: '',
  gdrive: 'At the top of your Drive. Niko can only see the folder and files it makes.',
  onedrive: 'In Apps › Niko in your OneDrive.',
  s3: 'A folder in your bucket, such as niko-knowledge or notes/niko.',
  obsidian: 'A folder in your vault, such as Niko Knowledge or Areas/Niko Knowledge.',
};
const LABEL: Record<KnRemotePlace, string> = { notion: 'Where in Notion', gdrive: 'Folder name', onedrive: 'Folder name', s3: 'Folder in the bucket', obsidian: 'Folder in the vault' };

export function PlaceWhere({ place, folder, root, picked, workspace, busy, onRelocated }: {
  place: KnRemotePlace; folder?: string; root?: string | null; picked?: boolean; workspace?: string | null; busy: boolean;
  onRelocated: (r: Relocated, text: string) => Promise<void>;
}) {
  const now = folder ?? KN_DEFAULT_FOLDER[place];
  const [name, setName] = useState(now);
  const [mine, setMine] = useState(!!picked);
  const [page, setPage] = useState('');
  const [pages, setPages] = useState<{ id: string; title: string }[] | null>(null);
  const [err, setErr] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => { setName(now); }, [now]);
  useEffect(() => { setMine(!!picked); }, [picked]);
  // Their Notion pages load when the panel opens, so the choice is there straight away.
  useEffect(() => {
    if (place !== 'notion') return;
    void api<{ pages: { id: string; title: string }[] }>('/knowledge/places/notion/pages').then((r) => setPages(r.pages)).catch((e) => setErr((e as Error).message));
  }, [place]);
  const off = busy || saving;
  const run = async (fn: () => Promise<{ relocated?: Relocated }>, text: string) => {
    setErr(''); setSaving(true);
    try { const r = await fn(); await onRelocated(r.relocated ?? { files: 0, learned: false }, text); }
    catch (e) { setErr((e as Error).message); } finally { setSaving(false); }
  };
  if (place === 'notion') {
    const changed = mine ? !!page : picked || name.trim() !== now;
    return (
      <div className="kn-where">
        <span className="kn-k">{LABEL.notion}</span>
        <div className="kn-opts" role="radiogroup" aria-label="Where in Notion">
          <label className={'kn-opt' + (!mine ? ' on' : '')}><input type="radio" name="kn-where-notion" checked={!mine} onChange={() => setMine(false)} disabled={off} />
            <span className="kn-where-b"><span className="kn-opt-t">A page Niko makes in {workspace ? `${workspace}’s workspace` : 'your workspace'}</span>
              <input className="in" aria-label="Page name" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} onFocus={() => setMine(false)} disabled={off} /></span></label>
          <label className={'kn-opt' + (mine ? ' on' : '')}><input type="radio" name="kn-where-notion" checked={mine} onChange={() => setMine(true)} disabled={off} />
            <span className="kn-where-b"><span className="kn-opt-t">On one of your pages</span>
              <select className="in" aria-label="Your page" value={page} onFocus={() => setMine(true)} onChange={(e) => { setPage(e.target.value); setMine(true); }} disabled={off}>
                <option value="">{picked && root ? `Now: ${root}` : pages ? (pages.length ? 'Choose a page' : 'No pages shared with Niko yet') : 'Loading your pages…'}</option>
                {(pages ?? []).map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
              </select>
              <span className="srow-hint">Only pages you shared with Niko are listed. That page becomes Knowledge’s: it and everything on it stay out of your Notes in Niko.</span></span></label>
        </div>
        <div className="kn-where-acts">
          <span className="srow-hint">{err ? <span className="no">{err}</span> : 'Changing it copies your files and what Niko learned there. Copies already made stay where they are.'}</span>
          <button type="button" className="pri md" disabled={off || !changed || (!mine && !name.trim())}
            onClick={() => void run(() => api('/knowledge/places/notion', { method: 'PUT', body: mine ? { page } : { page: null, name: name.trim() } }), mine ? `Done. Knowledge now goes on “${pages?.find((p) => p.id === page)?.title ?? 'your page'}”.` : `Done. Knowledge now goes on “${name.trim()}”.`)}>{saving ? 'Saving…' : 'Use this'}</button>
        </div>
      </div>
    );
  }
  return (
    <div className="kn-where">
      <label className="kn-field kn-where-f"><span className="kn-k">{LABEL[place]}</span>
        <span className="kn-where-row">
          <input className="in" value={name} maxLength={place === 's3' || place === 'obsidian' ? 200 : 80} onChange={(e) => setName(e.target.value)} disabled={off} spellCheck={false} />
          <button type="button" className="bt md" disabled={off || !name.trim() || name.trim() === now}
            onClick={() => void run(() => api(`/knowledge/places/${place}/folder`, { method: 'PUT', body: { name: name.trim() } }), `Done. Knowledge now goes in “${name.trim()}”.`)}>{saving ? 'Saving…' : 'Save'}</button>
        </span>
      </label>
      <span className="srow-hint">{err ? <span className="no">{err}</span> : `${HINT[place]} Changing it copies your files and what Niko learned there; copies already made stay where they are.`}</span>
    </div>
  );
}
