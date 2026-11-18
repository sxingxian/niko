// Settings · Knowledge: each person gives Niko their own files. Niko keeps answering as it does now; when a file is a
// confident match it leads the answer. Files are read and split here in the browser, then kept by Niko.
// Laid out as the Knowledge-Settings mockup, with the shared controls (Segmented, SettingRow, Status, Meter).
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { api, Meter, Segmented, SettingRow, Status, Switch } from '@niko/ui';
import {
  knKindOf, knModeOf, knNeedsCloudflare, knPlaceOf, knSearchOf, KN_COL_TYPE_NAMES, KN_COL_TYPES, KN_DEVICE_MODEL_MB,
  type KnColType, type KnColumn, type KnMode, type KnowledgeAccess, type KnowledgeLimits, type KnowledgePrefs,
} from '@niko/shared';
import { useSearchParams } from 'react-router-dom';
import { useNiko } from '../niko';
import { LearnedAside, LearnedTab, TaughtSection } from './KnowledgeLearned';
import { addFile, addNumbersInNiko } from '../knowledge';
import {
  addFileHere, addNumbersHere, deviceFiles, keepHereAsData, missingNumbersHere, moveToDevice, moveToNiko, removeHere, sheetsHere, updateSheetHere,
} from '../knowledgeDevice';
import { embedDownload, embedReady, embedRemove, embedSupported } from '../embed';
import { Sheet } from './Designs';
import { NoteLine, SettingsPage } from './Settings';

type KnFile = { id: string; name: string; kind: string; collection: string; bytes: number; status: 'reading' | 'ready' | 'failed'; error: string | null; pieces: number; flagged: boolean; sheets: number; rows: number; columns: number; numbers: { cloudflare: number; device: number; own?: number }; sha256: string; addedAt: string };
type KnSheet = { id: string; name: string; columns: KnColumn[]; rows: number; header: boolean; example: string[] };
type OwnSource = { ref: string; name: string; example: string };
type State = { available: boolean; access: KnowledgeAccess; prefs: KnowledgePrefs; limits: KnowledgeLimits; usage: { files: number; bytes: number }; ownSearch?: OwnSource[] };
type By = 'cloudflare' | 'device' | 'own';
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
const IconDevice = () => <svg className="kn-ic" viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="5" width="16" height="11" rx="2" /><path d="M2 19h20" /></svg>;
const IconWarn = () => <svg className="kn-ic sm" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l9 16H3z" /><path d="M12 10v4M12 17h.01" /></svg>;
const PLACE_NAME = { niko: 'Niko', device: 'This device only' } as const;
type Place = keyof typeof PLACE_NAME;
/** What the screen does with files, wherever they're kept. */
interface Ops {
  list: () => Promise<KnFile[]>;
  add: (f: File, collection: string, onStep: (step: string, done: number, total: number) => void) => Promise<unknown>;
  remove: (id: string) => Promise<void>;
  keep: (id: string) => Promise<void>;
  sheets: (fileId: string) => Promise<KnSheet[]>;
  saveSheet: (fileId: string, sheetId: string, b: { columns: KnColumn[]; header: boolean }) => Promise<KnSheet>;
}
const IconPlus = () => <svg className="kn-ic sm" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>;

export function Knowledge() {
  const { me, refreshMe } = useNiko();
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
  const [picked, setPicked] = useState<Place | null>(null);
  const [moving, setMoving] = useState<{ done: number; total: number; name: string } | null>(null);
  const [model, setModel] = useState<{ ready: boolean; p: number | null }>({ ready: embedReady(), p: null });
  // A search service of their own picked in the list, waiting for its model name before it's saved.
  const [ownPick, setOwnPick] = useState<{ ref: string; model: string } | null>(null);
  const [trying, setTrying] = useState(false);
  const [missing, setMissing] = useState(0);
  const [reread, setReread] = useState<{ done: number; total: number } | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const [params, setParams] = useSearchParams();
  const account = me?.id ?? '';

  const placeOf = (s: State | null): Place => (s ? knPlaceOf(s.prefs, s.access) : 'niko');
  const opsFor = useCallback((place: Place, s: State): Ops => place === 'device' ? {
    list: async () => (await deviceFiles(account)) as KnFile[],
    add: (f, c, onStep) => addFileHere(account, f, c, { limits: s.limits, onStep }),
    remove: (id) => removeHere(account, id),
    keep: (id) => keepHereAsData(account, id),
    sheets: (id) => sheetsHere(account, id),
    saveSheet: (id, sid, b) => updateSheetHere(account, id, sid, b),
  } : {
    list: async () => (await api<{ files: KnFile[] }>('/knowledge/files')).files,
    add: (f, c, onStep) => addFile(f, c, { readWithCloudflare: s.access.cloudflareRead && s.prefs.read === 'cloudflare', onStep }),
    remove: async (id) => { await api(`/knowledge/files/${id}`, { method: 'DELETE' }); },
    keep: async (id) => { await api(`/knowledge/files/${id}`, { method: 'PATCH', body: { flagged: false } }); },
    sheets: async (id) => (await api<{ sheets: KnSheet[] }>(`/knowledge/files/${id}/sheets`)).sheets,
    saveSheet: async (id, sid, b) => (await api<{ sheet: KnSheet }>(`/knowledge/files/${id}/sheets/${sid}`, { method: 'PUT', body: b })).sheet,
  }, [account]);

  const load = useCallback(async () => {
    try {
      const s = await api<State>('/knowledge');
      setSt(s);
      const place = placeOf(s);
      const ok = s.available && (place === 'device' ? s.access.device : s.access.niko);
      const list = ok && account ? await opsFor(place, s).list() : [];
      setFiles(list);
      // Pieces still without search numbers for the way they're searched now.
      if (place === 'device') setMissing(ok && account ? await missingNumbersHere(account) : 0);
      else { const by = knSearchOf(s.prefs, s.access, 'niko'); setMissing(list.reduce((a, f) => a + Math.max(0, f.pieces - (f.numbers?.[by] ?? 0)), 0)); }
    } catch (e) { setNote({ ok: false, text: (e as Error).message }); }
  }, [account, opsFor]);
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
  const place = placeOf(st);
  const shown: Place = picked ?? place;
  const ops = opsFor(place, st);
  const canKeep = place === 'device' ? access.device : access.niko;
  const search = knSearchOf(prefs, access, place);
  const readCf = place === 'niko' && access.cloudflareRead && prefs.read === 'cloudflare';
  const busy = !!moving || !!reread || trying;
  const tab: 'files' | 'learned' = access.learning && (params.get('tab') === 'learned' || !access.files) ? 'learned' : 'files';
  const tabs = access.learning && access.files ? (
    <div className="kn-pagetabs" role="tablist" aria-label="Knowledge">
      <button type="button" role="tab" className="ptab" aria-selected={tab === 'files'} onClick={() => setParams({}, { replace: true })}>Files</button>
      <button type="button" role="tab" className="ptab" aria-selected={tab === 'learned'} onClick={() => setParams({ tab: 'learned' }, { replace: true })}>What Niko learned</button>
    </div>
  ) : null;

  const savePrefs = async (change: Partial<KnowledgePrefs>) => {
    setNote(null);
    try { const r = await api<{ prefs: KnowledgePrefs }>('/knowledge/prefs', { method: 'PUT', body: change }); setSt({ ...st, prefs: r.prefs }); return r.prefs; }
    catch (e) { setNote({ ok: false, text: (e as Error).message }); return null; }
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
      if (knNeedsCloudflare(kind) && !readCf) {
        update(key, { error: place === 'device' ? 'Files kept on this device are read here only, so PDF, Word and spreadsheet files can’t be added. Save it as CSV, MD or TXT instead.' : access.cloudflareRead ? 'Choose Cloudflare under “Read files with” to add PDF, Word and spreadsheet files.' : 'PDF, Word and spreadsheet files aren’t included in your plan. Save it as CSV, MD or TXT instead.' });
        continue;
      }
      if (f.size > limits.mbPerFile * MB) { update(key, { error: `Each file can be up to ${limits.mbPerFile} MB.` }); continue; }
      try {
        await ops.add(f, col, (step, done, total) => update(key, { step, done, total }));
        setUploads((u) => u.filter((y) => y.key !== key));
      } catch (e) { update(key, { error: (e as Error).message }); }
    }
    await load();
  };
  const remove = async (f: KnFile) => {
    setMenu(null);
    try { await ops.remove(f.id); setFiles((x) => x.filter((y) => y.id !== f.id)); await load(); }
    catch (e) { setNote({ ok: false, text: (e as Error).message }); }
  };
  const keep = async (f: KnFile) => {
    try { await ops.keep(f.id); setFiles((x) => x.map((y) => (y.id === f.id ? { ...y, flagged: false } : y))); }
    catch (e) { setNote({ ok: false, text: (e as Error).message }); }
  };

  // Moving copies every file to the new place first, then removes the old copy, one file at a time.
  const move = async (to: Place) => {
    setNote(null);
    try {
      // Files and what Niko learned both move (with no files, only the notes do).
      setMoving({ done: 0, total: Math.max(1, files.length), name: '' });
      const step = (done: number, total: number, name: string) => setMoving({ done, total, name });
      if (to === 'device') await moveToDevice(account, files, step); else await moveToNiko(account, step);
      await savePrefs({ place: to });
      setPicked(null);
      setNote({ ok: true, text: files.length ? `Your files are now kept ${to === 'device' ? 'on this device' : 'in Niko'}.` : `New files will be kept ${to === 'device' ? 'on this device' : 'in Niko'}.` });
      await refreshMe();
    } catch (e) {
      setNote({ ok: false, text: `${(e as Error).message} Files already moved stay where they are now; the rest weren’t changed.` });
    } finally { setMoving(null); await load(); }
  };

  // Making search numbers again: for files in Niko, by Cloudflare, their own service or on this device; for files
  // here, on this device.
  const rereadAll = async (by: By, list = files) => {
    if (by === 'device' && !embedReady()) return;
    setNote(null);
    try {
      if (place === 'device') { setReread({ done: 0, total: 1 }); await addNumbersHere(account, (done, total) => setReread({ done, total })); }
      else {
        const todo = list.filter((f) => f.status === 'ready' && f.pieces > (f.numbers?.[by] ?? 0));
        const total = todo.reduce((a, f) => a + f.pieces, 0);
        let done = 0;
        setReread({ done, total });
        for (const f of todo) {
          if (by !== 'device') {
            for (let left = 1; left > 0;) { const r = await api<{ updated: number; left: number }>(`/knowledge/files/${f.id}/numbers/${by}`, { method: 'POST' }); left = r.left; done += r.updated; setReread({ done, total }); if (!r.updated) break; }
          } else {
            await addNumbersInNiko(f.id, (n) => { done += n; setReread({ done, total }); });
          }
        }
      }
    } catch (e) { setNote({ ok: false, text: (e as Error).message }); }
    finally { setReread(null); await load(); }
  };
  const chooseSearch = async (by: By, own?: { ref: string; model: string }) => {
    setTrying(true);
    const r = await savePrefs(by === 'own' ? { search: by, own } : { search: by });
    setTrying(false);
    if (r) { setOwnPick(null); await refreshMe(); }
    if (r && (by !== 'device' || embedReady())) await rereadAll(by);
    else await load();
  };
  // The list: Cloudflare, each of their own services, then this device. Their own service asks for a model name first.
  const pickSearch = (v: string) => {
    if (!v.startsWith('own:')) { setOwnPick(null); void chooseSearch(v === 'device' ? 'device' : 'cloudflare'); return; }
    const ref = v.slice(4), src = (st.ownSearch ?? []).find((x) => x.ref === ref);
    setOwnPick({ ref, model: prefs.own?.ref === ref ? prefs.own.model : src?.example ?? '' });
  };
  const download = async () => {
    setNote(null);
    setModel({ ready: false, p: 0 });
    try {
      await embedDownload((p) => setModel({ ready: false, p }));
      setModel({ ready: true, p: null });
      await rereadAll('device');
    } catch (e) { setModel({ ready: false, p: null }); setNote({ ok: false, text: (e as Error).message }); }
  };
  const removeModel = async () => { await embedRemove(); setModel({ ready: false, p: null }); };

  const dropProps = { onDragOver: (e: DragEvent) => { e.preventDefault(); setDrag(true); }, onDragLeave: () => setDrag(false), onDrop: (e: DragEvent) => { e.preventDefault(); setDrag(false); if (e.dataTransfer.files.length && !busy) void add(e.dataTransfer.files); } };

  const here = files.filter((f) => f.collection === col);
  const mode = knModeOf(prefs, col);
  const types = `${readCf ? ALL_TYPES : TEXT_TYPES} · up to ${limits.mbPerFile} MB each`;
  const detail = (f: KnFile) => [
    f.sheets === 0 ? n(f.pieces, 'piece', 'pieces') : f.kind === 'json' ? n(f.rows, 'record', 'records') : f.sheets === 1 ? `${n(f.rows, 'row', 'rows')} · ${n(f.columns, 'column', 'columns')}` : `${n(f.sheets, 'sheet', 'sheets')} · ${n(f.rows, 'row', 'rows')}`,
    size(f.bytes),
  ].join(' · ');
  const empty = files.length === 0 && uploads.length === 0;
  const bytes = files.reduce((a, f) => a + f.bytes, 0);
  const pickedInput = <input ref={picker} type="file" multiple hidden accept={readCf ? ACCEPT_ALL : ACCEPT_TEXT} onChange={(e) => { if (e.target.files?.length) void add(e.target.files); e.target.value = ''; }} />;
  const choose = <button type="button" className="pri md" disabled={busy} onClick={() => picker.current?.click()}>Choose files</button>;
  const places: Place[] = (['niko', 'device'] as const).filter((p) => (p === 'niko' ? access.niko : access.device));
  const placeStatus = (p: Place) => p === place ? `In use · ${n(files.length, 'file', 'files')}` : p === 'niko' ? 'All your devices' : 'Stays on this computer';
  const modelRow = search === 'device' && !ownPick && embedSupported();
  const owns = place === 'niko' ? st.ownSearch ?? [] : [];
  const ownNow = ownPick ?? (search === 'own' ? prefs.own : null);
  const ownSrc = ownNow ? owns.find((x) => x.ref === ownNow.ref) : undefined;
  const ownName = ownSrc?.name ?? 'Your own service', ownExample = ownSrc?.example ?? '';
  const searchValue = ownNow ? `own:${ownNow.ref}` : search;
  const searchChoices = (access.cloudflareSearch && place === 'niko' ? 1 : 0) + owns.length + 1;
  const searchHint = place === 'device'
    ? (model.ready ? 'Done on this computer, so Niko finds the right part even when you use different words.' : 'Done on this computer. Until the search model is downloaded, Niko finds things by the words in them.')
    : ownNow
      ? `${ownNow.ref === 'self-hosted-ai' ? 'Your own model server makes the search numbers.' : `Your AI key “${ownName}” makes the search numbers; its own charges apply.`} Works for Telegram replies.${files.length ? ` Changing it re-reads ${files.length === 1 ? 'your file' : `all ${files.length} files`}.` : ''}`
    : search === 'cloudflare'
      ? `Included in your plan, and works for Telegram replies.${files.length ? ` Changing it re-reads ${files.length === 1 ? 'your file' : `all ${files.length} files`}.` : ''}`
      : `Free; the search numbers are made on this computer. Telegram replies then search by words only.${files.length ? ` Changing it re-reads ${files.length === 1 ? 'your file' : `all ${files.length} files`}.` : ''}`;

  return (
    <SettingsPage title="Knowledge" sub={sub}>
      <NoteLine note={note} />
      {!st.available ? (
        <div className="kn-page"><div className="kn-main"><section className="g kn-card"><b className="kn-h">Knowledge</b><p className="srow-hint">Knowledge isn’t available right now. Try again later.</p></section></div></div>
      ) : tab === 'learned' ? (
      <div className="kn-page">
        <div className="kn-main">
          {tabs}
          <LearnedTab account={account} place={place} learn={prefs.learn} onLearn={(v) => void savePrefs({ learn: v }).then(() => refreshMe())} situations={prefs.situations} onSituations={(v) => void savePrefs({ situations: v }).then(() => refreshMe())} />
        </div>
        <LearnedAside />
      </div>
      ) : (
      <div className="kn-page">
        <div className="kn-main">
          {tabs}
          <section className="g kn-card" aria-label="Where your Knowledge is kept">
            <div className="kn-head"><b className="kn-h">Where it’s kept</b><span className="srow-hint">{!places.length ? 'Not included in your plan' : files.length ? `Now: ${PLACE_NAME[place]} · ${n(files.length, 'file', 'files')}` : 'Nothing kept yet'}</span></div>
            {places.length > 0 && <>
              <div className="kn-places">
                {places.map((p) => (
                  <button key={p} type="button" className="kn-place" aria-pressed={shown === p} disabled={busy} onClick={() => setPicked(p === place ? null : p)}>
                    <span className="kn-place-top">{p === 'niko' ? <IconNiko /> : <IconDevice />}<b>{PLACE_NAME[p]}</b>{p === 'niko' && <span className="kn-pill rec">Recommended</span>}</span>
                    <span className={'srow-hint' + (p === place ? ' ready' : '')}>{placeStatus(p)}</span>
                  </button>
                ))}
              </div>
              <div className="kn-inset">
                {shown === 'niko' ? <>
                  <span className="kn-lead">Kept by Niko, apart from your account details. Works on all your devices and for Telegram replies.</span>
                  {place === 'niko' && <div className="kn-use">
                    <span className="kn-use-l"><span>{size(st.usage.bytes)} of {limits.mbTotal} MB included in your plan</span><span className="srow-hint">{n(st.usage.files, 'file', 'files')} of {limits.files.toLocaleString()}</span></span>
                    <Meter value={st.usage.bytes / (limits.mbTotal * MB)} label="Space used" />
                  </div>}
                </> : <>
                  <span className="kn-devwarn"><IconWarn />Only on this computer. Your phone won’t see these files, Telegram replies can’t use them, and clearing this site’s data deletes them.</span>
                  <span className="srow-hint">Niko reads, stores and searches everything here, locked to your account. Only the parts that match a question go with it to the AI.</span>
                  {place === 'device' && files.length > 0 && <span className="srow-hint">{n(files.length, 'file', 'files')} · {size(bytes)} on this computer · up to {limits.files.toLocaleString()} files</span>}
                </>}
                {(shown !== place || moving) && (
                  <div className="kn-move">
                    {moving ? <>
                      <span className="kn-move-t"><Status tone="busy">Moving {Math.min(moving.done + 1, moving.total)} of {moving.total}{moving.name ? ` · ${moving.name}` : ''}</Status><Meter value={moving.total ? moving.done / moving.total : 0} warnAt={2} label="Moving files" /></span>
                    </> : <>
                      <span className="srow-hint">{files.length
                        ? `Moving copies your ${n(files.length, 'file', 'files')} to ${PLACE_NAME[shown]}, then removes the copy ${place === 'niko' ? 'in Niko' : 'on this device'}. Nothing is lost.`
                        : `New files will be kept ${shown === 'niko' ? 'in Niko' : 'on this device'}.`}</span>
                      <button type="button" className="pri md" onClick={() => void move(shown)}>{files.length ? `Move to ${PLACE_NAME[shown]}` : `Use ${PLACE_NAME[shown]}`}</button>
                    </>}
                  </div>
                )}
              </div>
            </>}
          </section>

          {canKeep && pickedInput}
          {canKeep && empty && (
            <section className={'g kn-card kn-empty' + (drag ? ' drag' : '')} aria-label="No files yet" {...dropProps}>
              <IconFile />
              <b className="kn-h">No files yet</b>
              <span className="srow-hint lg">Right now Niko answers from what it knows and finds online, and from your connected apps. Add files and it answers from them too, when they fit.</span>
              <span className="srow-hint">{types}</span>
              {choose}
            </section>
          )}
          {canKeep && !empty && (
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
                          <button type="button" role="menuitem" className="danger" disabled={busy} onClick={() => void remove(f)}>Remove file</button>
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

          {access.learning && canKeep && !empty && <TaughtSection account={account} place={place} />}

          <section className="g kn-card" aria-label="Search and use">
            {(access.cloudflareRead || place === 'device') && <SettingRow title="Read files with" hint={readCf ? 'Cloudflare turns PDF, Word and spreadsheet files into text and keeps nothing. Pictures inside them aren’t read.' : place === 'device' ? 'Everything is read here. PDF and Word are not available.' : 'Only files this browser can read itself: JSON, XML, MD, TXT, CSV, TSV and HTML.'}>
              <select className="in" aria-label="Read files with" value={place === 'device' ? 'device' : prefs.read} disabled={place === 'device' || !access.cloudflareRead} onChange={(e) => void savePrefs({ read: e.target.value === 'device' ? 'device' : 'cloudflare' })}>
                {access.cloudflareRead && place === 'niko' && <option value="cloudflare">Cloudflare · reads PDF and Word too</option>}<option value="device">This browser only</option>
              </select>
            </SettingRow>}
            <SettingRow title="Find things by meaning with" hint={searchHint}>
              <select className="in" aria-label="Find things by meaning with" value={searchValue} disabled={busy || place === 'device' || searchChoices < 2} onChange={(e) => pickSearch(e.target.value)}>
                {access.cloudflareSearch && place === 'niko' && <option value="cloudflare">Cloudflare · included in your plan</option>}
                {owns.map((o) => <option key={o.ref} value={`own:${o.ref}`}>{o.ref === 'self-hosted-ai' ? 'Your own model server' : `${o.name} · your AI key`}</option>)}
                <option value="device">On this device · free</option>
              </select>
            </SettingRow>
            {ownNow && <SettingRow title="Search model name" hint={ownPick ? `The embedding model on that service${ownExample ? `, for example ${ownExample}` : ''}. Niko tries it once before switching.` : `Using “${ownNow.model}”. Changing it re-reads your files.`}>
              <form className="kn-own" onSubmit={(e) => { e.preventDefault(); if (ownPick?.model.trim()) void chooseSearch('own', { ref: ownPick.ref, model: ownPick.model.trim() }); }}>
                <input className="in" aria-label="Search model name" value={ownNow.model} maxLength={100} spellCheck={false} autoComplete="off" disabled={busy}
                  onChange={(e) => setOwnPick({ ref: ownNow.ref, model: e.target.value })} />
                {ownPick && <button type="submit" className="pri md" disabled={busy || !ownPick.model.trim() || (search === 'own' && prefs.own?.ref === ownPick.ref && prefs.own.model === ownPick.model.trim())}>Use this model</button>}
                {ownPick && <button type="button" className="bt md" disabled={busy} onClick={() => setOwnPick(null)}>Cancel</button>}
              </form>
            </SettingRow>}
            {modelRow && <SettingRow title="Search model" hint={model.ready ? 'On this device. Your phone and other computers download their own.' : `Downloaded once to this device, about ${KN_DEVICE_MODEL_MB} MB. Until then, Niko finds things by their words.`}>
              {model.p !== null
                ? <span className="kn-dl"><Status tone="busy">Downloading · {Math.round(model.p * 100)}%</Status><Meter value={model.p} warnAt={2} label="Downloading the search model" /></span>
                : model.ready ? <button type="button" className="bt md" disabled={busy} onClick={() => void removeModel()}>Remove</button>
                : <button type="button" className="pri md" disabled={busy} onClick={() => void download()}>Download to this device</button>}
            </SettingRow>}
            {(reread || (missing > 0 && files.length > 0 && !ownPick && (search !== 'device' || model.ready))) && (
              <SettingRow title="Search numbers" hint={reread ? 'Re-reading your files so Niko can find things by meaning. You can keep using Niko meanwhile; leaving this page pauses it.' : `${n(missing, 'piece isn’t', 'pieces aren’t')} ready to be found by meaning yet.`}>
                {reread
                  ? <span className="kn-dl"><Status tone="busy">Re-reading · {reread.total ? Math.round((reread.done / reread.total) * 100) : 0}%</Status><Meter value={reread.total ? reread.done / reread.total : 0} warnAt={2} label="Re-reading files" /></span>
                  : <button type="button" className="bt md" disabled={busy} onClick={() => void rereadAll(search)}>Re-read now</button>}
              </SettingRow>
            )}
            <SettingRow title="Use Knowledge in reply drafts" hint="Drafts stay quick by reading only the message, unless this is on.">
              <Switch on={prefs.drafts} onChange={(v) => void savePrefs({ drafts: v })} label="Use Knowledge in reply drafts" />
            </SettingRow>
            <SettingRow title="Answer Telegram messages from Knowledge" hint={place === 'device' ? 'Telegram replies can’t use files kept on this device.' : !prefs.telegram ? 'Telegram replies don’t use your files.' : search === 'device' ? 'Replies to your Telegram can use your files. With “On this device”, they search by words only.' : 'Replies to your Telegram can use your files, searching by meaning and by words.'}>
              <Switch on={prefs.telegram && place === 'niko'} disabled={place === 'device'} onChange={(v) => void savePrefs({ telegram: v })} label="Answer Telegram messages from Knowledge" />
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
      {checking && <CheckColumns file={checking} ops={ops} onClose={() => setChecking(null)} />}
    </SettingsPage>
  );
}

/** "Check columns": what Niko found in a spreadsheet, so counts and totals come out right. */
function CheckColumns({ file, ops, onClose }: { file: KnFile; ops: Ops; onClose: () => void }) {
  const [sheets, setSheets] = useState<KnSheet[] | null>(null);
  const [i, setI] = useState(0);
  const [cols, setCols] = useState<KnColumn[]>([]);
  const [header, setHeader] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => { void ops.sheets(file.id).then(setSheets).catch((e) => setErr((e as Error).message)); }, [file.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const sheet = sheets?.[i];
  useEffect(() => { if (sheet) { setCols(sheet.columns); setHeader(sheet.header); } }, [sheet]);
  const save = async () => {
    if (!sheet) return;
    setBusy(true); setErr('');
    try {
      const next = await ops.saveSheet(file.id, sheet.id, { columns: cols, header });
      setSheets((s) => s!.map((x) => (x.id === sheet.id ? next : x)));
      if (i + 1 < (sheets?.length ?? 0)) setI(i + 1); else onClose();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <Sheet onClose={onClose} labelledBy="kn-check-h">
      <div className="kn-dlg">
        <b id="kn-check-h" className="kn-dlg-h">Check columns · {file.name}</b>
        <span className="srow-hint lg">Niko found {sheet?.header === false ? 'no header row, and ' : 'a header row and '}these columns{sheets && sheets.length > 1 ? ` in ${sheet?.name} (${i + 1} of ${sheets.length})` : ''}. Fix any type that’s wrong, so counts and totals come out right.</span>
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
