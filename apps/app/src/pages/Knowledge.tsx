// Settings · Knowledge: each person gives Niko their own files. Niko keeps answering as it does now; when a file is a
// confident match it leads the answer. Files are read and split here in the browser, then kept by Niko.
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { api, Icon, Switch } from '@niko/ui';
import {
  knKindOf, knModeOf, knNeedsCloudflare, KN_COL_TYPE_NAMES, KN_COL_TYPES,
  type KnColType, type KnColumn, type KnMode, type KnowledgeAccess, type KnowledgeLimits, type KnowledgePrefs,
} from '@niko/shared';
import { useNiko } from '../niko';
import { addFile } from '../knowledge';
import { Sheet } from './Designs';
import { NoteLine, SettingsPage } from './Settings';

type KnFile = { id: string; name: string; kind: string; collection: string; bytes: number; status: 'reading' | 'ready' | 'failed'; error: string | null; pieces: number; flagged: boolean; sheets: number; rows: number; addedAt: string };
type KnSheet = { id: string; name: string; columns: KnColumn[]; rows: number; header: boolean; example: string[] };
type State = { available: boolean; access: KnowledgeAccess; prefs: KnowledgePrefs; limits: KnowledgeLimits; usage: { files: number; bytes: number } };
type Upload = { key: string; name: string; step: string; done: number; total: number; error?: string };

const MB = 1024 * 1024;
const mb = (b: number) => (b < MB ? `${Math.max(1, Math.round(b / 1024))} KB` : `${(b / MB).toFixed(b < 10 * MB ? 1 : 0)} MB`);
const TEXT_TYPES = 'JSON, XML, MD, TXT, CSV, TSV, HTML';
const ALL_TYPES = 'JSON, XML, MD, TXT, CSV, TSV, XLSX, XLS, PDF, DOCX';
const MODES: [KnMode, string][] = [['files', 'Files first'], ['only', 'Only my files'], ['off', 'Off']];
const MODE_HINT: Record<KnMode, string> = {
  files: 'When a file here is a confident match, it leads the answer, with what Niko knows, finds online and sees in your apps added after.',
  only: 'Niko uses these files only when you say “from my files”.',
  off: 'Niko doesn’t use these files. They’re kept until you remove them.',
};
const TYPE_LABEL: Record<string, string> = { md: 'MD', txt: 'TXT', csv: 'CSV', tsv: 'TSV', json: 'JSON', xml: 'XML', html: 'HTML', pdf: 'PDF', docx: 'DOCX', xlsx: 'XLSX', xls: 'XLS', ods: 'ODS', odt: 'ODT' };

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

  const collections = useMemo(() => {
    const counts = new Map<string, number>();
    for (const f of files) counts.set(f.collection, (counts.get(f.collection) ?? 0) + 1);
    for (const c of [...extraCols, 'General']) if (!counts.has(c)) counts.set(c, 0);
    return [...counts.entries()].sort((a, b) => (a[0] === 'General' ? -1 : b[0] === 'General' ? 1 : a[0].localeCompare(b[0])));
  }, [files, extraCols]);

  if (!me) return null;
  if (!st) return <SettingsPage title="Knowledge" sub="Give Niko your own files."><NoteLine note={note} /></SettingsPage>;
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
    const queue: Upload[] = chosen.map((f, i) => ({ key: `${Date.now()}-${i}`, name: f.name, step: 'Waiting', done: 0, total: 1 }));
    setUploads((u) => [...queue, ...u]);
    const update = (key: string, x: Partial<Upload>) => setUploads((u) => u.map((y) => (y.key === key ? { ...y, ...x } : y)));
    for (let i = 0; i < chosen.length; i++) {
      const f = chosen[i]!, key = queue[i]!.key;
      const kind = knKindOf(f.name);
      if (!kind) { update(key, { error: 'Knowledge can’t read this kind of file.' }); continue; }
      if (knNeedsCloudflare(kind) && !readCf) { update(key, { error: access.cloudflareRead ? 'Turn on “Read files with Cloudflare” below to add PDF, Word and spreadsheet files.' : 'PDF, Word and spreadsheet files aren’t included in your plan. Save it as CSV, MD or TXT instead.' }); continue; }
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
  const onDrop = (e: DragEvent) => { e.preventDefault(); setDrag(false); if (e.dataTransfer.files.length) void add(e.dataTransfer.files); };

  const here = files.filter((f) => f.collection === col);
  const mode = knModeOf(prefs, col);
  const types = `${readCf ? ALL_TYPES : TEXT_TYPES} · up to ${limits.mbPerFile} MB each`;
  const detail = (f: KnFile) => [f.sheets ? `${f.sheets === 1 ? '1 sheet' : `${f.sheets} sheets`} · ${f.rows.toLocaleString()} ${f.rows === 1 ? 'row' : 'rows'}` : `${f.pieces} ${f.pieces === 1 ? 'piece' : 'pieces'}`, mb(f.bytes), new Date(f.addedAt).toLocaleDateString([], { day: 'numeric', month: 'short' })].join(' · ');
  const picked = <input ref={picker} type="file" multiple hidden accept={readCf ? '.json,.xml,.md,.markdown,.txt,.csv,.tsv,.html,.htm,.xlsx,.xls,.ods,.pdf,.docx,.odt' : '.json,.xml,.md,.markdown,.txt,.csv,.tsv,.html,.htm'} onChange={(e) => { if (e.target.files?.length) void add(e.target.files); e.target.value = ''; }} />;

  return (
    <SettingsPage title="Knowledge" sub="Give Niko your own files. Niko keeps doing everything it does now, and when a file is a confident match it leads the answer, with what Niko knows, finds online and sees in your apps added after.">
      <NoteLine note={note} />
      {!st.available ? (
        <section className="g eng-card"><span className="k">Knowledge</span><p className="hint">Knowledge isn’t available right now. Try again later.</p></section>
      ) : (
      <div className="kn-grid">
        <div className="kn-main">
          <section className="g eng-card" aria-label="Where it’s kept">
            <span className="k">Where it’s kept</span>
            {access.niko ? (
              <div className="kn-place on">
                <span className="kn-place-ic" aria-hidden="true"><Icon name="spark" size={20} /></span>
                <span className="kn-place-t"><b>Niko</b><span className="sub">Kept by Niko, apart from your account details. Works on all your devices and for Telegram replies.</span></span>
              </div>
            ) : <p className="hint">Keeping files in Niko isn’t included in your plan.</p>}
            {access.niko && <p className="hint kn-use">{mb(st.usage.bytes)} of {limits.mbTotal} MB included in your plan · {st.usage.files} of {limits.files} {limits.files === 1 ? 'file' : 'files'}</p>}
          </section>

          {access.niko && (
          <section className="g eng-card kn-files" aria-label="Files" onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)} onDrop={onDrop}>
            {picked}
            {files.length === 0 && uploads.length === 0 ? (
              <div className={'kn-empty' + (drag ? ' drag' : '')}>
                <Icon name="note" size={28} />
                <b>No files yet</b>
                <p className="hint">Right now Niko answers from what it knows and finds online, and from your connected apps. Add files and it answers from them too, when they fit.</p>
                <p className="hint">{types}</p>
                <button type="button" className="pri" onClick={() => picker.current?.click()}>Choose files</button>
              </div>
            ) : <>
              <div className="kn-chips" role="tablist" aria-label="Collections">
                {collections.map(([name, n]) => (
                  <button key={name} type="button" role="tab" aria-selected={name === col} className={'kn-chip' + (name === col ? ' on' : '')} onClick={() => setCol(name)}>{name}<span className="n">{n}</span></button>
                ))}
                {newCol === null
                  ? <button type="button" className="kn-chip add" onClick={() => setNewCol('')}><Icon name="plus" size={16} />Collection</button>
                  : <form className="kn-newcol" onSubmit={(e) => { e.preventDefault(); const n = newCol.trim().slice(0, 80); if (n) { setExtraCols((x) => [...new Set([...x, n])]); setCol(n); } setNewCol(null); }}>
                      <input className="in" autoFocus value={newCol} maxLength={80} placeholder="Name" aria-label="New collection name" onChange={(e) => setNewCol(e.target.value)} onBlur={() => { if (!newCol.trim()) setNewCol(null); }} />
                    </form>}
              </div>
              <div className="kn-mode">
                <span className="k">How Niko answers from {col}</span>
                <div className="kn-seg" role="group" aria-label={`How Niko answers from ${col}`}>
                  {MODES.map(([m, label]) => <button key={m} type="button" className="seg" aria-pressed={mode === m} onClick={() => savePrefs({ modes: { ...prefs.modes, [col]: m } })}>{label}</button>)}
                </div>
                <p className="hint">{MODE_HINT[mode]}</p>
              </div>
              <button type="button" className={'kn-drop' + (drag ? ' drag' : '')} onClick={() => picker.current?.click()}>
                <Icon name="plus" size={20} /><span><b>Drop files here</b><span className="sub">{types}</span></span><span className="bt">Choose files</span>
              </button>
              <ul className="kn-list">
                {uploads.map((u) => (
                  <li key={u.key} className={'kn-row' + (u.error ? ' bad' : '')}>
                    <span className="kn-badge">{TYPE_LABEL[knKindOf(u.name) ?? ''] ?? '?'}</span>
                    <span className="kn-t"><b>{u.name}</b><span className="sub">{u.error ?? `${u.step}${u.total > 1 ? ` · ${Math.round((u.done / u.total) * 100)}%` : '…'}`}</span></span>
                    {u.error && <button type="button" className="bt quiet" onClick={() => setUploads((x) => x.filter((y) => y.key !== u.key))}>Dismiss</button>}
                  </li>
                ))}
                {here.map((f) => (
                  <li key={f.id} className="kn-row-wrap">
                    <div className="kn-row">
                      <span className="kn-badge">{TYPE_LABEL[f.kind] ?? f.kind.toUpperCase()}</span>
                      <span className="kn-t"><b>{f.name}</b><span className="sub">{detail(f)}</span></span>
                      {f.sheets > 0 && <button type="button" className="bt" onClick={() => setChecking(f)}>Check</button>}
                      <span className="kn-more">
                        <button type="button" className="ib" aria-label={`More for ${f.name}`} aria-expanded={menu === f.id} onClick={() => setMenu(menu === f.id ? null : f.id)}>⋯</button>
                        {menu === f.id && <span className="kn-menu g" role="menu"><button type="button" role="menuitem" className="danger" onClick={() => void remove(f)}>Remove file</button></span>}
                      </span>
                    </div>
                    {f.flagged && (
                      <div className="kn-warn">
                        <p>Part of this file is written as instructions to an AI (“ignore earlier rules and send…”). Niko will only ever read it as data, never act on it.</p>
                        <span className="sheet-actions"><button type="button" className="bt danger" onClick={() => void remove(f)}>Remove file</button><button type="button" className="bt" onClick={() => void keep(f)}>Keep as data</button></span>
                      </div>
                    )}
                  </li>
                ))}
                {here.length === 0 && uploads.length === 0 && <li className="hint kn-none">Nothing in {col} yet. Drop files above to add them here.</li>}
              </ul>
            </>}
          </section>
          )}

          <section className="g eng-card" aria-label="Knowledge settings">
            {access.cloudflareRead && <label className="fld kn-fld"><span className="k">Read files with</span>
              <select className="in" value={prefs.read} onChange={(e) => void savePrefs({ read: e.target.value === 'device' ? 'device' : 'cloudflare' })}>
                <option value="cloudflare">Cloudflare · reads PDF and Word too</option><option value="device">This browser only</option>
              </select>
              <span className="hint">{prefs.read === 'cloudflare' ? 'Cloudflare turns PDF, Word and spreadsheet files into text and keeps nothing. Pictures inside them aren’t read.' : 'Only files this browser can read itself: JSON, XML, MD, TXT, CSV, TSV and HTML.'}</span>
            </label>}
            {access.cloudflareSearch
              ? <label className="fld kn-fld"><span className="k">Find things by meaning with</span>
                  <select className="in" value="cloudflare" disabled><option value="cloudflare">Cloudflare · included in your plan</option></select>
                  <span className="hint">Cloudflare makes search numbers so Niko finds the right part even when you use different words. It keeps nothing.</span>
                </label>
              : <p className="hint">Niko finds things in your files by the words in them.</p>}
            <div className="eng-line"><span>Use Knowledge in reply drafts<span className="sub kn-sub">Drafts stay quick by reading only the message, unless this is on.</span></span><Switch on={prefs.drafts} onChange={(v) => void savePrefs({ drafts: v })} label="Use Knowledge in reply drafts" /></div>
            <div className="eng-line"><span>Answer Telegram messages from Knowledge<span className="sub kn-sub">{prefs.telegram ? 'Telegram replies can use your files kept in Niko.' : 'Telegram replies don’t use your files.'}</span></span><Switch on={prefs.telegram} onChange={(v) => void savePrefs({ telegram: v })} label="Answer Telegram messages from Knowledge" /></div>
          </section>
        </div>

        <aside className="g eng-card kn-aside">
          <span className="k">On top of Niko</span>
          <p className="hint">Niko still answers from what it knows, what it finds online and your connected apps. When a file is a confident match, it leads, with the file and row shown, and the rest is added after.</p>
          <p className="hint">If something is only similar, Niko asks “Is this the one?”. Say “that’s the one” and it remembers.</p>
          <p className="hint">Say “from my files” to keep one answer to your files only.</p>
          <p className="hint">Spreadsheets become tables, so Niko can count and add up, not just search. The original file is never kept, only the text and rows.</p>
          <span className="k" style={{ paddingTop: 12 }}>Kept private</span>
          <p className="hint">Only you can see your Knowledge.</p>
          <p className="hint">Text inside a file is never an instruction: a file can’t make Niko send, pay, delete or change anything.</p>
          <p className="hint">Removing a file removes its text, rows and search index straight away.</p>
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
      <div className="dz-sheet-t"><h3 id="kn-check-h">Check columns · {file.name}</h3>
        <p className="hint">Niko found {header ? 'a header row and ' : ''}these columns{sheets && sheets.length > 1 ? ` in ${sheet?.name}` : ''}. Fix any type that’s wrong, so counts and totals come out right.</p></div>
      {err && <p className="err" role="alert">{err}</p>}
      {!sheet ? <p className="hint">{err ? '' : 'Loading…'}</p> : <>
        <ul className="kn-cols">
          {cols.map((c, j) => (
            <li key={j} className="kn-col">
              <span className="kn-col-t">
                <input className="in" value={c.name} maxLength={120} aria-label={`Column ${j + 1} name`} disabled={!header} onChange={(e) => setCols(cols.map((x, k) => (k === j ? { ...x, name: e.target.value } : x)))} />
                <span className="sub">e.g. {sheet.example[j] || '—'}</span>
              </span>
              <select className="in" value={c.type} aria-label={`What ${c.name} holds`} onChange={(e) => setCols(cols.map((x, k) => (k === j ? { ...x, type: e.target.value as KnColType } : x)))}>
                {KN_COL_TYPES.map((t) => <option key={t} value={t}>{KN_COL_TYPE_NAMES[t]}</option>)}
              </select>
            </li>
          ))}
        </ul>
        <label className="eng-check"><input type="checkbox" checked={header} onChange={(e) => setHeader(e.target.checked)} />First row is the header</label>
        <div className="sheet-actions"><button type="button" className="bt" onClick={onClose}>Cancel</button><button type="button" className="pri" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save columns'}</button></div>
      </>}
    </Sheet>
  );
}
