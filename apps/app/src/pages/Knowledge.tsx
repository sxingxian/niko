// Settings · Knowledge: each person gives Niko their own files. Niko keeps answering as it does now; when a file is a
// confident match it leads the answer. Files are read and split here in the browser, then kept by Niko.
// Laid out as the Knowledge-Settings mockup, with the shared controls (Segmented, SettingRow, Status, Meter).
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { api, Meter, Segmented, SettingRow, Status, Switch } from '@niko/ui';
import {
  knKindOf, knModeOf, knNeedsCloudflare, KN_COL_TYPE_NAMES, KN_COL_TYPES,
  type KnColType, type KnColumn, type KnMode, type KnowledgeAccess, type KnowledgeLimits, type KnowledgePrefs,
} from '@niko/shared';
import { useNiko } from '../niko';
import { addFile } from '../knowledge';
import { Sheet } from './Designs';
import { NoteLine, SettingsPage } from './Settings';

type KnFile = { id: string; name: string; kind: string; collection: string; bytes: number; status: 'reading' | 'ready' | 'failed'; error: string | null; pieces: number; flagged: boolean; sheets: number; rows: number; columns: number; addedAt: string };
type KnSheet = { id: string; name: string; columns: KnColumn[]; rows: number; header: boolean; example: string[] };
type State = { available: boolean; access: KnowledgeAccess; prefs: KnowledgePrefs; limits: KnowledgeLimits; usage: { files: number; bytes: number } };
type Upload = { key: string; name: string; bytes: number; step: string; done: number; total: number; error?: string };

const MB = 1024 * 1024;
const size = (b: number) => (b < MB ? `${Math.max(1, Math.round(b / 1024))} KB` : `${(b / MB).toFixed(b < 10 * MB ? 1 : 0)} MB`);
const n = (x: number, one: string, many: string) => `${x.toLocaleString()} ${x === 1 ? one : many}`;
const TEXT_TYPES = 'JSON, XML, MD, TXT, CSV, TSV, HTML';
const ALL_TYPES = 'JSON, XML, MD, TXT, CSV, TSV, XLSX, XLS, PDF, DOCX';
const MODES: readonly (readonly [KnMode, string])[] = [['files', 'Files first'], ['only', 'Only my files'], ['off', 'Off']];
const MODE_HINT: Record<KnMode, string> = {
  files: 'When a file here is a confident match, it leads the answer, with what Niko knows, finds online and sees in your apps added after.',
  only: 'Niko uses these files only when you say “from my files”.',
  off: 'Niko doesn’t use these files. They’re kept until you remove them.',
};
const TYPE_LABEL: Record<string, string> = { md: 'MD', txt: 'TXT', csv: 'CSV', tsv: 'TSV', json: 'JSON', xml: 'XML', html: 'HTML', pdf: 'PDF', docx: 'DOCX', xlsx: 'XLSX', xls: 'XLS', ods: 'ODS', odt: 'ODT' };
const ACCEPT_TEXT = '.json,.xml,.md,.markdown,.txt,.csv,.tsv,.html,.htm';
const ACCEPT_ALL = `${ACCEPT_TEXT},.xlsx,.xls,.ods,.pdf,.docx,.odt`;

const IconNiko = () => <svg className="kn-ic" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="3" /></svg>;
const IconUpload = () => <svg className="kn-ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 16V4M7 9l5-5 5 5M4 20h16" /></svg>;
const IconFile = () => <svg className="kn-ic big" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h9l3 3v15H6z" /><path d="M12 10v6M9 13h6" /></svg>;
const IconPlus = () => <svg className="kn-ic sm" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>;

export function Knowledge() {
  const { me } = useNiko();
  const [st, setSt] = useState<State | null>(null);
  const [files, setFiles] = useState<KnFile[]>([]);
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [col, setCol] = useState('General');
  const [newCol, setNewCol] = useState<string | null>(null);
  const [extraCols, setExtraCols] = useState<string[]>([]);
  const [menu, setMenu] = useState<string | null>(null);
  const [checking, setChecking] = useState<KnFile | null>(null);
  const [drag, setDrag] = useState(false);
  const picker = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const s = await api<State>('/knowledge');
      setSt(s);
      if (s.available && s.access.niko) setFiles((await api<{ files: KnFile[] }>('/knowledge/files')).files);
    } catch (e) { setNote({ ok: false, text: (e as Error).message }); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  // The ⋯ menu closes when you click anywhere else.
  useEffect(() => { if (!menu) return; const close = () => setMenu(null); window.addEventListener('click', close); return () => window.removeEventListener('click', close); }, [menu]);

  const collections = useMemo(() => {
    const counts = new Map<string, number>();
    for (const f of files) counts.set(f.collection, (counts.get(f.collection) ?? 0) + 1);
    for (const c of [...extraCols, 'General']) if (!counts.has(c)) counts.set(c, 0);
    return [...counts.entries()].sort((a, b) => (a[0] === 'General' ? -1 : b[0] === 'General' ? 1 : a[0].localeCompare(b[0])));
  }, [files, extraCols]);

  if (!me) return null;
  const sub = 'Give Niko your own files. Niko keeps doing everything it does now, and when a file is a confident match it leads the answer, with what Niko knows, finds online and sees in your apps added after.';
  if (!st) return <SettingsPage title="Knowledge" sub={sub}><NoteLine note={note} /></SettingsPage>;
  const { access, prefs, limits } = st;
  const readCf = access.cloudflareRead && prefs.read === 'cloudflare';

  const savePrefs = async (change: Partial<KnowledgePrefs>) => {
    setNote(null);
    try { const r = await api<{ prefs: KnowledgePrefs }>('/knowledge/prefs', { method: 'PUT', body: change }); setSt({ ...st, prefs: r.prefs }); }
    catch (e) { setNote({ ok: false, text: (e as Error).message }); }
  };

  // Files are added one after another, so a slow connection never has dozens of requests at once.
  const add = async (list: FileList | File[]) => {
    setNote(null);
    const chosen = [...list];
    const queue: Upload[] = chosen.map((f, i) => ({ key: `${Date.now()}-${i}`, name: f.name, bytes: f.size, step: 'Waiting', done: 0, total: 1 }));
    setUploads((u) => [...queue, ...u]);
    const update = (key: string, x: Partial<Upload>) => setUploads((u) => u.map((y) => (y.key === key ? { ...y, ...x } : y)));
    for (let i = 0; i < chosen.length; i++) {
      const f = chosen[i]!, key = queue[i]!.key;
      const kind = knKindOf(f.name);
      if (!kind) { update(key, { error: 'Knowledge can’t read this kind of file.' }); continue; }
      if (knNeedsCloudflare(kind) && !readCf) { update(key, { error: access.cloudflareRead ? 'Choose Cloudflare under “Read files with” to add PDF, Word and spreadsheet files.' : 'PDF, Word and spreadsheet files aren’t included in your plan. Save it as CSV, MD or TXT instead.' }); continue; }
      if (f.size > limits.mbPerFile * MB) { update(key, { error: `Each file can be up to ${limits.mbPerFile} MB.` }); continue; }
      try {
        await addFile(f, col, { readWithCloudflare: readCf, onStep: (step, done, total) => update(key, { step, done, total }) });
        setUploads((u) => u.filter((y) => y.key !== key));
      } catch (e) { update(key, { error: (e as Error).message }); }
    }
    await load();
  };
  const remove = async (f: KnFile) => {
    setMenu(null);
    try { await api(`/knowledge/files/${f.id}`, { method: 'DELETE' }); setFiles((x) => x.filter((y) => y.id !== f.id)); await load(); }
    catch (e) { setNote({ ok: false, text: (e as Error).message }); }
  };
  const keep = async (f: KnFile) => {
    try { await api(`/knowledge/files/${f.id}`, { method: 'PATCH', body: { flagged: false } }); setFiles((x) => x.map((y) => (y.id === f.id ? { ...y, flagged: false } : y))); }
    catch (e) { setNote({ ok: false, text: (e as Error).message }); }
  };
  const dropProps = { onDragOver: (e: DragEvent) => { e.preventDefault(); setDrag(true); }, onDragLeave: () => setDrag(false), onDrop: (e: DragEvent) => { e.preventDefault(); setDrag(false); if (e.dataTransfer.files.length) void add(e.dataTransfer.files); } };

  const here = files.filter((f) => f.collection === col);
  const mode = knModeOf(prefs, col);
  const types = `${readCf ? ALL_TYPES : TEXT_TYPES} · up to ${limits.mbPerFile} MB each`;
  const detail = (f: KnFile) => [
    f.sheets === 0 ? n(f.pieces, 'piece', 'pieces') : f.kind === 'json' ? n(f.rows, 'record', 'records') : f.sheets === 1 ? `${n(f.rows, 'row', 'rows')} · ${n(f.columns, 'column', 'columns')}` : `${n(f.sheets, 'sheet', 'sheets')} · ${n(f.rows, 'row', 'rows')}`,
    size(f.bytes),
  ].join(' · ');
  const empty = files.length === 0 && uploads.length === 0;
  const picked = <input ref={picker} type="file" multiple hidden accept={readCf ? ACCEPT_ALL : ACCEPT_TEXT} onChange={(e) => { if (e.target.files?.length) void add(e.target.files); e.target.value = ''; }} />;
  const choose = <button type="button" className="pri md" onClick={() => picker.current?.click()}>Choose files</button>;

  return (
    <SettingsPage title="Knowledge" sub={sub}>
      <NoteLine note={note} />
      {!st.available ? (
        <div className="kn-page"><div className="kn-main"><section className="g kn-card"><b className="kn-h">Knowledge</b><p className="srow-hint">Knowledge isn’t available right now. Try again later.</p></section></div></div>
      ) : (
      <div className="kn-page">
        <div className="kn-main">
          <section className="g kn-card" aria-label="Where your Knowledge is kept">
            <div className="kn-head"><b className="kn-h">Where it’s kept</b><span className="srow-hint">{access.niko ? 'Kept in Niko' : 'Not included in your plan'}</span></div>
            {access.niko && <>
              <div className="kn-places">
                <button type="button" className="kn-place" aria-pressed="true">
                  <span className="kn-place-top"><IconNiko /><b>Niko</b><span className="kn-pill rec">Recommended</span></span>
                  <span className="srow-hint ready">In use</span>
                </button>
              </div>
              <div className="kn-inset">
                <span className="kn-lead">Kept by Niko, apart from your account details. Works on all your devices and for Telegram replies.</span>
                <div className="kn-use">
                  <span className="kn-use-l"><span>{size(st.usage.bytes)} of {limits.mbTotal} MB included in your plan</span><span className="srow-hint">{n(st.usage.files, 'file', 'files')} of {limits.files.toLocaleString()}</span></span>
                  <Meter value={st.usage.bytes / (limits.mbTotal * MB)} label="Space used" />
                </div>
              </div>
            </>}
          </section>

          {access.niko && picked}
          {access.niko && empty && (
            <section className={'g kn-card kn-empty' + (drag ? ' drag' : '')} aria-label="No files yet" {...dropProps}>
              <IconFile />
              <b className="kn-h">No files yet</b>
              <span className="srow-hint big">Right now Niko answers from what it knows and finds online, and from your connected apps. Add files and it answers from them too, when they fit.</span>
              <span className="srow-hint">{types}</span>
              {choose}
            </section>
          )}
          {access.niko && !empty && (
            <section className="g kn-card" aria-label="Your files" {...dropProps}>
              <div className="kn-tabs" role="tablist" aria-label="Collections">
                {collections.map(([name, count]) => <button key={name} type="button" role="tab" className="ptab" aria-selected={name === col} onClick={() => setCol(name)}>{name}<span className="n">{count}</span></button>)}
                {newCol === null
                  ? <button type="button" className="ptab add" onClick={() => setNewCol('')}><IconPlus />Collection</button>
                  : <form className="kn-newcol" onSubmit={(e) => { e.preventDefault(); const name = newCol.trim().slice(0, 80); if (name) { setExtraCols((x) => [...new Set([...x, name])]); setCol(name); } setNewCol(null); }}>
                      <input className="in" autoFocus value={newCol} maxLength={80} placeholder="Collection name" aria-label="New collection name" onChange={(e) => setNewCol(e.target.value)} onBlur={() => { if (!newCol.trim()) setNewCol(null); }} />
                    </form>}
              </div>
              <div className="kn-inset kn-mode">
                <span className="kn-mode-t"><span className="k">How Niko answers from {col}</span><span className="kn-lead sm">{MODE_HINT[mode]}</span></span>
                <Segmented value={mode} options={MODES} label="Answer mode" onChange={(m) => void savePrefs({ modes: { ...prefs.modes, [col]: m } })} />
              </div>
              <div className={'kn-drop' + (drag ? ' drag' : '')}>
                <span className="kn-drop-t"><IconUpload /><span><span className="kn-drop-h">Drop files here</span><span className="srow-hint">{types}</span></span></span>
                {choose}
              </div>
              <div className="kn-files">
                {uploads.map((u) => (
                  <div key={u.key} className="kn-frow">
                    <span className="kn-badge">{TYPE_LABEL[knKindOf(u.name) ?? ''] ?? '?'}</span>
                    <span className="kn-ft"><b>{u.name}</b><span className="srow-hint">{u.error ?? size(u.bytes)}</span></span>
                    <span className="kn-fs">
                      {u.error ? <Status tone="bad">Couldn’t add</Status> : <Status tone="busy">{u.step}{u.total > 1 ? ` · ${Math.round((u.done / u.total) * 100)}%` : '…'}</Status>}
                      {!u.error && u.total > 1 && <Meter value={u.done / u.total} warnAt={2} label={`Adding ${u.name}`} />}
                    </span>
                    {u.error ? <button type="button" className="more-b" aria-label={`Dismiss ${u.name}`} onClick={() => setUploads((x) => x.filter((y) => y.key !== u.key))}>×</button> : <span />}
                  </div>
                ))}
                {here.map((f) => (
                  <div key={f.id} className="kn-fwrap">
                    <div className="kn-frow">
                      <span className="kn-badge">{TYPE_LABEL[f.kind] ?? f.kind.toUpperCase()}</span>
                      <span className="kn-ft"><b>{f.name}</b><span className="srow-hint">{detail(f)}</span></span>
                      <span className="kn-fs">
                        <span className="kn-fs-line">
                          {f.flagged ? <Status tone="look">Needs a look</Status> : <Status tone="ready">Ready</Status>}
                          {f.sheets > 0 && <button type="button" className="bt sm" onClick={() => setChecking(f)}>Check</button>}
                        </span>
                      </span>
                      <span className="kn-more" onClick={(e) => e.stopPropagation()}>
                        <button type="button" className="more-b" aria-label={`More for ${f.name}`} aria-haspopup="menu" aria-expanded={menu === f.id} onClick={() => setMenu(menu === f.id ? null : f.id)}>⋯</button>
                        {menu === f.id && <span className="kn-menu g" role="menu">
                          {f.sheets > 0 && <button type="button" role="menuitem" onClick={() => { setMenu(null); setChecking(f); }}>Check columns</button>}
                          <button type="button" role="menuitem" className="danger" onClick={() => void remove(f)}>Remove file</button>
                        </span>}
                      </span>
                    </div>
                    {f.flagged && (
                      <div className="kn-warn">
                        <span>Part of this file is written as instructions to an AI (“ignore earlier rules and send…”). Niko will only ever read it as data, never act on it.</span>
                        <span className="kn-warn-b"><button type="button" className="bt md" onClick={() => void remove(f)}>Remove file</button><button type="button" className="pri md" onClick={() => void keep(f)}>Keep as data</button></span>
                      </div>
                    )}
                  </div>
                ))}
                {here.length === 0 && uploads.length === 0 && <p className="srow-hint kn-none">Nothing in {col} yet. Drop files here, or choose them, to add them to {col}.</p>}
              </div>
            </section>
          )}

          <section className="g kn-card" aria-label="Search and use">
            {access.cloudflareRead && <SettingRow title="Read files with" hint={prefs.read === 'cloudflare' ? 'Cloudflare turns PDF, Word and spreadsheet files into text and keeps nothing. Pictures inside them aren’t read.' : 'Only files this browser can read itself: JSON, XML, MD, TXT, CSV, TSV and HTML.'}>
              <select className="in" aria-label="Read files with" value={prefs.read} onChange={(e) => void savePrefs({ read: e.target.value === 'device' ? 'device' : 'cloudflare' })}>
                <option value="cloudflare">Cloudflare · reads PDF and Word too</option><option value="device">This browser only</option>
              </select>
            </SettingRow>}
            <SettingRow title="Find things by meaning with" hint={access.cloudflareSearch ? 'Cloudflare makes search numbers so Niko finds the right part even when you use different words. It keeps nothing.' : 'Niko finds things in your files by the words in them.'}>
              {access.cloudflareSearch
                ? <select className="in" aria-label="Find things by meaning with" value="cloudflare" disabled><option value="cloudflare">Cloudflare · included in your plan</option></select>
                : <span className="srow-hint">Words only</span>}
            </SettingRow>
            <SettingRow title="Use Knowledge in reply drafts" hint="Drafts stay quick by reading only the message, unless this is on.">
              <Switch on={prefs.drafts} onChange={(v) => void savePrefs({ drafts: v })} label="Use Knowledge in reply drafts" />
            </SettingRow>
            <SettingRow title="Answer Telegram messages from Knowledge" hint={prefs.telegram ? 'Telegram replies can use your files kept in Niko.' : 'Telegram replies don’t use your files.'}>
              <Switch on={prefs.telegram} onChange={(v) => void savePrefs({ telegram: v })} label="Answer Telegram messages from Knowledge" />
            </SettingRow>
          </section>
        </div>

        <aside className="kn-aside" aria-label="About Knowledge">
          <span className="k">On top of Niko</span>
          <p>Niko still answers from what it knows, what it finds online and your connected apps. When a file is a confident match, it leads, with the file and row shown, and the rest is added after.</p>
          <p>If something is only similar, Niko asks “Is this the one?”. Say “that’s the one” and it remembers.</p>
          <p>Say “from my files” to keep one answer to your files only.</p>
          <p>Spreadsheets become tables, so Niko can count and add up, not just search. The original file is never kept, only the text and rows.</p>
          <span className="k">Kept private</span>
          <p>Only you can see your Knowledge.</p>
          <p>Text inside a file is never an instruction: a file can’t make Niko send, pay, delete or change anything.</p>
          <p>Removing a file removes its text, rows and search index straight away.</p>
        </aside>
      </div>
      )}
      {checking && <CheckColumns file={checking} onClose={() => setChecking(null)} />}
    </SettingsPage>
  );
}

/** "Check columns": what Niko found in a spreadsheet, so counts and totals come out right. */
function CheckColumns({ file, onClose }: { file: KnFile; onClose: () => void }) {
  const [sheets, setSheets] = useState<KnSheet[] | null>(null);
  const [i, setI] = useState(0);
  const [cols, setCols] = useState<KnColumn[]>([]);
  const [header, setHeader] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => { void api<{ sheets: KnSheet[] }>(`/knowledge/files/${file.id}/sheets`).then((r) => setSheets(r.sheets)).catch((e) => setErr((e as Error).message)); }, [file.id]);
  const sheet = sheets?.[i];
  useEffect(() => { if (sheet) { setCols(sheet.columns); setHeader(sheet.header); } }, [sheet]);
  const save = async () => {
    if (!sheet) return;
    setBusy(true); setErr('');
    try {
      const r = await api<{ sheet: KnSheet }>(`/knowledge/files/${file.id}/sheets/${sheet.id}`, { method: 'PUT', body: { columns: cols, header } });
      setSheets((s) => s!.map((x) => (x.id === sheet.id ? r.sheet : x)));
      if (i + 1 < (sheets?.length ?? 0)) setI(i + 1); else onClose();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <Sheet onClose={onClose} labelledBy="kn-check-h">
      <div className="kn-dlg">
        <b id="kn-check-h" className="kn-dlg-h">Check columns · {file.name}</b>
        <span className="srow-hint big">Niko found {sheet?.header === false ? 'no header row, and ' : 'a header row and '}these columns{sheets && sheets.length > 1 ? ` in ${sheet?.name} (${i + 1} of ${sheets.length})` : ''}. Fix any type that’s wrong, so counts and totals come out right.</span>
        {err && <p className="err" role="alert">{err}</p>}
        {!sheet ? <p className="srow-hint">{err ? '' : 'Loading…'}</p> : <>
          <div className="kn-cols">
            {cols.map((c, j) => (
              <div key={j} className="kn-col">
                <b>{c.name}</b>
                <span className="srow-hint">e.g. {sheet.example[j] || '—'}</span>
                <select className="in" value={c.type} aria-label={`Type of ${c.name}`} onChange={(e) => setCols(cols.map((x, k) => (k === j ? { ...x, type: e.target.value as KnColType } : x)))}>
                  {KN_COL_TYPES.map((t) => <option key={t} value={t}>{KN_COL_TYPE_NAMES[t]}</option>)}
                </select>
              </div>
            ))}
          </div>
          <label className="kn-check"><input type="checkbox" checked={header} onChange={(e) => setHeader(e.target.checked)} />First row is the header</label>
          <div className="kn-dlg-b"><button type="button" className="bt" onClick={onClose}>Cancel</button><button type="button" className="pri md" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save columns'}</button></div>
        </>}
      </div>
    </Sheet>
  );
}
