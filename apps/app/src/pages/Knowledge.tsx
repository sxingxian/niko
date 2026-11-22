// Settings · Knowledge: each person gives Niko their own files. Niko keeps answering as it does now; when a file is a
// confident match it leads the answer. Files are read and split here in the browser, then kept by Niko.
// Laid out as the Knowledge-Settings mockup, with the shared controls (Segmented, SettingRow, Status, Meter).
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type ReactElement } from 'react';
import { api, Meter, Segmented, SettingRow, Status, Switch } from '@niko/ui';
import { knLearnPlaceOf,
  isRemotePlace, knKindOf, knModeOf, knNeedsCloudflare, knPlaceOf, knSearchOf, knShownPlace, KN_COL_TYPE_NAMES, KN_COL_TYPES, KN_DEVICE_MODEL_MB, KN_PLACE_NAMES,
  type KnColType, type KnColumn, type KnMode, type KnowledgeAccess, type KnowledgeLimits, type KnowledgePrefs, type KnPlace, type KnRemotePlace,
} from '@niko/shared';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useNiko } from '../niko';
import { LearnedAside, LearnedTab, TaughtSection } from './KnowledgeLearned';
import { syncLearnedCopySoon } from '../knowledgeChat';
import { ObsidianPanel, type ObsidianShown } from './KnowledgeObsidian';
import { PlaceWhere, type Relocated } from './KnowledgeWhere';
import { addFile, addNumbersInNiko } from '../knowledge';
import {
  addFileHere, addNumbersHere, deviceFiles, keepHereAsData, missingNumbersHere, moveNotesToDevice, moveNotesToNiko, moveToDevice, moveToNiko, removeHere, sheetsHere, updateSheetHere,
} from '../knowledgeDevice';
import { embedDownload, embedReady, embedRemove, embedSupported } from '../embed';
import { Sheet } from './Designs';
import { NoteLine, SettingsPage } from './Settings';

type KnFile = { id: string; name: string; kind: string; collection: string; bytes: number; status: 'reading' | 'ready' | 'failed'; error: string | null; pieces: number; flagged: boolean; sheets: number; rows: number; columns: number; numbers: { cloudflare: number; device: number; own?: number }; sha256: string; addedAt: string;
  /** Files kept in their own Notion, Drive or OneDrive: where the copy is, a link to it, whether it's all there, any problem. */
  place?: string; url?: string | null; copied?: boolean; copyError?: string | null };
type KnSheet = { id: string; name: string; columns: KnColumn[]; rows: number; header: boolean; example: string[] };
type OwnSource = { ref: string; name: string; example: string };
type StorageShown = { endpoint: string; bucket: string; region: string; access: boolean };
type PlaceInfo = { connected: boolean; label: string | null; root: string | null; picked?: boolean; storage?: StorageShown; obsidian?: ObsidianShown };
type StorageForm = { endpoint: string; bucket: string; accessKeyId: string; secretAccessKey: string; accessId: string; accessSecret: string };
const EMPTY_STORAGE: StorageForm = { endpoint: '', bucket: '', accessKeyId: '', secretAccessKey: '', accessId: '', accessSecret: '' };
type PickedUp = { added: number; removed: number; skipped: number; ignored?: boolean; refused?: boolean; at: string };
type LearnedCopy = { place: KnRemotePlace; url: string | null; dirty: boolean; syncedAt: string | null; error: string | null; picked?: PickedUp | null };
type State = { available: boolean; access: KnowledgeAccess; prefs: KnowledgePrefs; limits: KnowledgeLimits; usage: { files: number; bytes: number }; ownSearch?: OwnSource[]; places?: Partial<Record<KnRemotePlace, PlaceInfo>>; split?: 'browser' | 'server';
  /** Where what Niko learns can be kept besides Niko and this device, and the copy kept there now. */
  learnPlaces?: Partial<Record<KnRemotePlace, PlaceInfo>>; learnedCopy?: LearnedCopy | null };
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
const IconNotion = () => <svg className="kn-ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h9l3 3v15H6z" /><path d="M9 10h6M9 14h6M9 18h4" /></svg>;
const IconDrive = () => <svg className="kn-ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7h6l2 2h10v10H3z" /></svg>;
const IconCloud = () => <svg className="kn-ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 18h10a4 4 0 0 0 .5-8A6 6 0 0 0 6 9.5 4.3 4.3 0 0 0 7 18z" /></svg>;
const IconVault = () => <svg className="kn-ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.5l7 4.5-1.5 9.5L12 21.5l-5.5-5L5 7z" /><path d="M12 2.5L9 12l3 9.5M9 12l-4-5M9 12l8.5 4.5" /></svg>;
const IconServer = () => <svg className="kn-ic" viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="16" height="7" rx="2" /><rect x="4" y="13" width="16" height="7" rx="2" /><path d="M8 7.5h.01M8 16.5h.01" /></svg>;
const PLACE_ICON: Record<KnPlace, () => ReactElement> = { niko: IconNiko, notion: IconNotion, gdrive: IconDrive, onedrive: IconCloud, s3: IconServer, obsidian: IconVault, device: IconDevice };
/** The places in the order the mockup shows them. */
const SPOTS: KnPlace[] = ['niko', 'notion', 'gdrive', 'onedrive', 'obsidian', 's3', 'device'];
/** The connection each place uses, for its Connect button. */
const CONNECT: Partial<Record<KnRemotePlace, string>> = { notion: 'notion', gdrive: 'google-drive', onedrive: 'onedrive' };
/** "in Niko", "in Google Drive", "on this device". */
const inPlace = (p: KnPlace) => (p === 'device' ? 'on this device' : p === 's3' ? 'in your own storage' : p === 'obsidian' ? 'in your Obsidian vault' : `in ${KN_PLACE_NAMES[p]}`);
const PLACE_NAME = KN_PLACE_NAMES;
/** Links to a copy: https pages, or obsidian:// to open the note in the app (no new tab for that one). Anything else
 *  isn't shown as a link. */
const copyLink = (url: string | null | undefined) => (!url ? null : /^https:\/\//i.test(url) ? { href: url, target: '_blank', rel: 'noopener noreferrer' } : /^obsidian:\/\/open\?/i.test(url) ? { href: url } : null);
/** A place's name inside a sentence (“Move to your own storage”). */
const toName = (p: KnPlace) => (p === 's3' ? 'your own storage' : p === 'device' ? 'this device' : PLACE_NAME[p]);
/** Where files are read and searched: Niko (files in their own apps too) or this device. */
type Place = 'niko' | 'device';
/** What the screen does with files, wherever they're kept. */
interface Ops {
  list: () => Promise<KnFile[]>;
  add: (f: File, collection: string, onStep: (step: string, done: number, total: number) => void) => Promise<unknown>;
  remove: (id: string, copy?: 'bin') => Promise<void>;
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
  const [picked, setPicked] = useState<KnPlace | null>(null);
  const [copying, setCopying] = useState<{ done: number; total: number; name: string; rows?: { done: number; total: number } } | null>(null);
  const [storage, setStorage] = useState<StorageForm | null>(null);
  const [removing, setRemoving] = useState<{ file: KnFile; bin: boolean } | null>(null);
  const [storageNote, setStorageNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [moving, setMoving] = useState<{ done: number; total: number; name: string } | null>(null);
  // Where what Niko learns is kept: the place picked (before moving) and moving progress.
  const [lPicked, setLPicked] = useState<KnPlace | null>(null);
  const [lMoving, setLMoving] = useState<{ done: number; total: number } | null>(null);
  const [model, setModel] = useState<{ ready: boolean; p: number | null }>({ ready: embedReady(), p: null });
  // A search service of their own picked in the list, waiting for its model name before it's saved.
  const [ownPick, setOwnPick] = useState<{ ref: string; model: string } | null>(null);
  const [trying, setTrying] = useState(false);
  const [missing, setMissing] = useState(0);
  const [reread, setReread] = useState<{ done: number; total: number } | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
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
    add: (f, c, onStep) => addFile(f, c, { readWithCloudflare: s.access.cloudflareRead && s.prefs.read === 'cloudflare', serverSplit: s.split === 'server', onStep }),
    remove: async (id, copy) => { await api(`/knowledge/files/${id}${copy ? '?copy=bin' : ''}`, { method: 'DELETE' }); },
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
  // Back from Connections after connecting a place.
  useEffect(() => {
    if (params.get('linked') === null) return;
    setNote({ ok: true, text: 'Connected. You can move your files there now.' });
    setParams({}, { replace: true });
  }, [params, setParams]);
  // The ⋯ menu closes when you click anywhere else.
  useEffect(() => { if (!menu) return; const close = () => setMenu(null); window.addEventListener('click', close); return () => window.removeEventListener('click', close); }, [menu]);

  const collections = useMemo(() => {
    const counts = new Map<string, number>();
    for (const f of files) counts.set(f.collection, (counts.get(f.collection) ?? 0) + 1);
    for (const c of [...extraCols, 'General']) if (!counts.has(c)) counts.set(c, 0);
    return [...counts.entries()].sort((a, b) => (a[0] === 'General' ? -1 : b[0] === 'General' ? 1 : a[0].localeCompare(b[0])));
  }, [files, extraCols]);

  // Hooks stay above the early returns below: the number of them must not change between renders.
  // The copy is looked at once when this page opens (a bullet added, changed or removed there becomes a note), and a copy
  // that was never written, with no problem recorded (a write that was cut off), is written now instead of saying
  // "Writing the copy…" for ever. If that fails the problem shows, with a button to try again.
  const [lWriting, setLWriting] = useState(false);
  const lLooked = useRef('');
  const lTries = useRef(0);
  const [notesKey, setNotesKey] = useState(0);
  const writeCopy = useCallback(async () => {
    setLWriting(true);
    try {
      const r = await api<{ copy?: { picked?: PickedUp | null } }>('/knowledge/learned/copy', { method: 'POST' });
      const pk = r.copy?.picked;
      if (pk && (pk.added || pk.removed) && Date.now() - Date.parse(pk.at) < 60_000) setNotesKey((n) => n + 1);
    } catch (e) { setNote({ ok: false, text: (e as Error).message }); }
    finally { setLWriting(false); await load(); }
  }, [load]);
  useEffect(() => {
    const lCopy = st?.learnedCopy && st.learnedCopy.place === knLearnPlaceOf(st.prefs, st.access) ? st.learnedCopy : null;
    if (!lCopy || lWriting || lMoving) return;
    const open = lLooked.current !== lCopy.place;
    const stuck = !lCopy.syncedAt && !lCopy.error && lTries.current < 4;
    if (!open && !stuck) return;
    if (open) { lLooked.current = lCopy.place; lTries.current = 0; } else lTries.current++;
    void writeCopy();
  }, [st, lWriting, lMoving, writeCopy]);
  if (!me) return null;
  const filesSub = 'Give Niko your own files. Niko keeps doing everything it does now, and when a file is a confident match it leads the answer, with what Niko knows, finds online and sees in your apps added after.';
  if (!st) return <SettingsPage title="Knowledge" sub={filesSub}><NoteLine note={note} /></SettingsPage>;
  const { access, prefs, limits } = st;
  // Learning without files: the page says nothing about files.
  const sub = access.files || !access.learning ? filesSub : 'Niko learns from how you use it: the names you use, your corrections and what you ask it to remember. Only you can see what it keeps.';
  const place = placeOf(st);
  const spot = knShownPlace(prefs, access);
  const shown: KnPlace = picked ?? spot;
  const remote = isRemotePlace(spot) ? spot : null;
  const ops = opsFor(place, st);
  const canKeep = place === 'device' ? access.device : access.niko;
  const search = knSearchOf(prefs, access, place);
  const readCf = place === 'niko' && access.cloudflareRead && prefs.read === 'cloudflare';
  const busy = !!moving || !!reread || trying || !!copying;
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
        const added = await ops.add(f, col, (step, done, total) => update(key, { step, done, total })) as { id?: string } | undefined;
        // Kept in Notion, Drive or OneDrive: the copy is made there now. If that fails, the file is still in Niko and
        // can be copied later from "Where it's kept".
        if (remote && added?.id) {
          update(key, { step: `Copying ${inPlace(remote)}`, done: 0, total: 1 });
          try { await copyOne(added.id, (r) => update(key, { done: r.done, total: r.total })); }
          catch (e) { setNote({ ok: false, text: `${f.name} was added, but its copy ${inPlace(remote)} wasn’t made: ${(e as Error).message}` }); }
        }
        setUploads((u) => u.filter((y) => y.key !== key));
      } catch (e) { update(key, { error: (e as Error).message }); }
    }
    await load();
  };
  // A file with a copy in Notion, Drive, OneDrive or their storage asks first what to do with the copy there.
  const remove = async (f: KnFile, copy?: 'keep' | 'bin') => {
    setMenu(null);
    if (!copy && f.copied && f.place && isRemotePlace(f.place)) { setRemoving({ file: f, bin: false }); return; }
    try {
      await ops.remove(f.id, copy === 'bin' ? 'bin' : undefined);
      setFiles((x) => x.filter((y) => y.id !== f.id));
      if (copy) setNote({ ok: true, text: copy === 'bin' ? (f.place === 's3' ? `Removed. Its file in your storage was deleted too.` : `Removed. Its copy is in ${PLACE_NAME[f.place as KnPlace]}’s bin.`) : `Removed. Its copy is still ${inPlace(f.place as KnPlace)}.` });
      await load();
    } catch (e) { setNote({ ok: false, text: (e as Error).message }); }
  };
  const keep = async (f: KnFile) => {
    try { await ops.keep(f.id); setFiles((x) => x.map((y) => (y.id === f.id ? { ...y, flagged: false } : y))); }
    catch (e) { setNote({ ok: false, text: (e as Error).message }); }
  };

  // Copies one file to their own place, a step at a time (a document, a sheet, or in Notion the next rows of a sheet).
  const copyOne = async (id: string, onRows?: (rows: { done: number; total: number }) => void) => {
    for (let i = 0; i < 2000; i++) {
      const r = await api<{ done: boolean; rows?: { done: number; total: number } }>(`/knowledge/files/${id}/copy`, { method: 'POST' });
      if (r.rows) onRows?.(r.rows);
      if (r.done) return;
    }
  };
  // Copies every file not yet in their place, one at a time, with a progress line. Stops at the first problem.
  const copyAll = async (to: KnRemotePlace) => {
    const r = await api<{ files: string[] }>('/knowledge/copies');
    const names = new Map(files.map((f) => [f.id, f.name]));
    for (let i = 0; i < r.files.length; i++) {
      const id = r.files[i]!, name = names.get(id) ?? '';
      setCopying({ done: i, total: r.files.length, name });
      await copyOne(id, (rows) => setCopying({ done: i, total: r.files.length, name, rows }));
    }
    return { count: r.files.length, to };
  };
  // Moving: to the device, every file's pieces come here and leave Niko; to Niko from the device, the other way. To
  // Notion, Drive or OneDrive, Niko keeps the pieces and makes a copy of each file there. Copies in the place left stay.
  const move = async (to: KnPlace) => {
    setNote(null);
    try {
      setMoving({ done: 0, total: Math.max(1, files.length), name: '' });
      const step = (done: number, total: number, name: string) => setMoving({ done, total, name });
      if (to === 'device') await moveToDevice(account, files, step);
      else if (place === 'device') await moveToNiko(account, step);
      setMoving(null);
      if (!(await savePrefs({ place: to }))) return;
      setPicked(null);
      await refreshMe();
      if (isRemotePlace(to)) {
        await load();
        await copyAll(to);
      }
      setNote({ ok: true, text: files.length ? `Your files are now kept ${inPlace(to)}.` : `New files will be kept ${inPlace(to)}.` });
    } catch (e) {
      setNote({ ok: false, text: `${(e as Error).message} ${isRemotePlace(to) ? 'Files not copied yet are still in Niko; copy them later from here.' : 'Files already moved stay where they are now; the rest weren’t changed.'}` });
    } finally { setMoving(null); setCopying(null); await load(); }
  };
  const copyNow = async () => {
    if (!remote) return;
    setNote(null);
    try { await copyAll(remote); setNote({ ok: true, text: `Your files are all ${inPlace(remote)} now.` }); }
    catch (e) { setNote({ ok: false, text: (e as Error).message }); }
    finally { setCopying(null); await load(); }
  };
  // Connecting happens on Connections; once linked, it comes back here.
  const connect = (p: KnRemotePlace) => {
    try { sessionStorage.setItem('kn-return', CONNECT[p] ?? ''); } catch { /* storage off */ }
    navigate(`/connections?connect=${CONNECT[p]}`);
  };
  // Their own storage: Test tries it without saving; Save tries it and keeps it (keys are never shown again).
  const storageForm = (): StorageForm => storage ?? { ...EMPTY_STORAGE, endpoint: st?.places?.s3?.storage?.endpoint ?? '', bucket: st?.places?.s3?.storage?.bucket ?? '' };
  const storageSend = async (save: boolean) => {
    setStorageNote(null); setTrying(true);
    const f = storageForm();
    try {
      await api(save ? '/knowledge/places/storage' : '/knowledge/places/storage/test', { method: save ? 'PUT' : 'POST', body: f });
      setStorageNote({ ok: true, text: save ? 'Saved. Niko can keep your files there.' : 'Niko wrote a test file there, read it back and removed it.' });
      if (save) { setStorage(null); await load(); }
    } catch (e) { setStorageNote({ ok: false, text: (e as Error).message }); }
    finally { setTrying(false); }
  };
  const storageRemove = async () => {
    setStorageNote(null);
    try { await api('/knowledge/places/storage', { method: 'DELETE' }); setStorage(null); await load(); }
    catch (e) { setStorageNote({ ok: false, text: (e as Error).message }); }
  };
  // Another page or folder in a place: files kept there and what Niko learned are copied to it.
  const relocated = async (p: KnRemotePlace, r: Relocated, text: string) => {
    setNote(null);
    await load();
    try {
      if (r.files && spot === p) await copyAll(p);
      if (r.learned) await api('/knowledge/learned/copy', { method: 'POST' });
      setNote({ ok: true, text });
    } catch (e) { setNote({ ok: false, text: `${(e as Error).message} Copies not made yet can be made from here later.` }); }
    finally { setCopying(null); await load(); }
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
  const info = (p: KnPlace) => (isRemotePlace(p) ? st.places?.[p] : undefined);
  const places: KnPlace[] = SPOTS.filter((p) => (p === 'niko' ? access.niko : p === 'device' ? access.device : !!info(p)));
  const placeStatus = (p: KnPlace) => p === spot ? `In use · ${n(files.length, 'file', 'files')}` : p === 'niko' ? 'All your devices' : p === 'device' ? 'Stays on this computer'
    : info(p)?.connected ? `${p === 's3' || p === 'obsidian' ? 'Set up' : 'Connected'}${info(p)?.label ? ` · ${info(p)!.label}` : ''}` : p === 's3' ? 'Add your storage' : p === 'obsidian' ? 'Set it up below' : 'Not connected yet';
  const shownInfo = info(shown);
  const canMoveTo = !isRemotePlace(shown) || !!shownInfo?.connected;
  const notCopied = remote ? files.filter((f) => f.status === 'ready' && !f.copied) : [];
  const copyProblem = remote ? files.find((f) => f.copyError)?.copyError ?? null : null;
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

  // ---------------------------------------------------------------- where what Niko learns is kept
  const learnNow = knLearnPlaceOf(prefs, access);
  const lInfo = (p: KnPlace) => (isRemotePlace(p) ? st.learnPlaces?.[p] : undefined);
  const learnSpots: KnPlace[] = SPOTS.filter((p) => (p === 'niko' || p === 'device' ? access.learnPlaces[p] : !!lInfo(p)));
  const lShown: KnPlace = lPicked ?? learnNow;
  const notesPlace: Place = learnNow === 'device' ? 'device' : 'niko';
  const lCopy = st.learnedCopy && st.learnedCopy.place === learnNow ? st.learnedCopy : null;
  const lStatus = (p: KnPlace) => p === learnNow ? 'In use' : p === 'niko' ? 'All your devices' : p === 'device' ? 'Stays on this computer'
    : lInfo(p)?.connected ? `${p === 's3' || p === 'obsidian' ? 'Set up' : 'Connected'}${lInfo(p)?.label ? ` · ${lInfo(p)!.label}` : ''}` : p === 's3' || p === 'obsidian' ? 'Set it up on the Files tab' : 'Not connected yet';
  const lCanMove = !isRemotePlace(lShown) || !!lInfo(lShown)?.connected;
  const pickedLine = (p: PickedUp, where: string) => p.ignored ? 'A change someone else made there was ignored.'
    : [p.added || p.removed ? `Picked up ${[p.added ? `${p.added} new` : '', p.removed ? `${p.removed} removed` : ''].filter(Boolean).join(' and ')} from ${where} (${ago(p.at)}).` : '',
      p.skipped ? `${p.skipped} line${p.skipped === 1 ? '' : 's'} couldn’t be used: a bullet Niko couldn’t read, or something that looks like a password or code.` : '',
      p.refused ? 'Most notes were missing from the page at once, so Niko kept them. Forget notes in Niko if you meant to.' : ''].filter(Boolean).join(' ');
  const ago = (iso: string) => { const m = Math.round((Date.now() - Date.parse(iso)) / 60000); return m < 1 ? 'just now' : m === 1 ? '1 minute ago' : m < 60 ? `${m} minutes ago` : m < 120 ? 'an hour ago' : `${Math.round(m / 60)} hours ago`; };
  const moveLearned = async (to: KnPlace) => {
    setNote(null);
    const from = learnNow;
    let refused = false;
    const commit = async () => { if (!(await savePrefs({ learnPlace: to }))) { refused = true; throw new Error('not saved'); } };
    try {
      setLMoving({ done: 0, total: 1 });
      const step = (done: number, total: number) => setLMoving({ done, total: Math.max(1, total) });
      if (to === 'device' && from !== 'device') await moveNotesToDevice(account, commit, step);
      else if (from === 'device' && to !== 'device') await moveNotesToNiko(account, commit, step);
      else await commit();
      setLPicked(null);
      await refreshMe();
      if (isRemotePlace(to)) await api('/knowledge/learned/copy', { method: 'POST' }).catch((e) => setNote({ ok: false, text: (e as Error).message }));
      setNote((x) => x ?? { ok: true, text: isRemotePlace(to) ? `Done. A copy of what Niko learned is ${inPlace(to)}.` : to === 'device' ? 'Done. What Niko learned is on this computer only.' : 'Done. What Niko learned is kept in Niko.' });
    } catch (e) {
      if (!refused) setNote({ ok: false, text: `${(e as Error).message} Nothing was moved.` });
    } finally { setLMoving(null); await load(); }
  };
  const learnWhere = learnSpots.length > 1 || learnNow !== 'niko' ? (
    <div className="kn-learn-where">
      <div className="kn-head"><span className="srow-name">Where Niko keeps what it learns</span><span className="srow-hint">Now: {PLACE_NAME[learnNow]}</span></div>
      <div className="kn-places">
        {learnSpots.map((p) => (
          <button key={p} type="button" className="kn-place" aria-pressed={lShown === p} disabled={!!lMoving} onClick={() => setLPicked(p === learnNow ? null : p)}>
            <span className="kn-place-top">{PLACE_ICON[p]()}<b>{PLACE_NAME[p]}</b></span>
            <span className={'srow-hint' + (p === learnNow ? ' ready' : isRemotePlace(p) && !lInfo(p)?.connected ? ' wait' : '')}>{lStatus(p)}</span>
          </button>
        ))}
      </div>
      <div className="kn-inset">
        {lShown === 'niko' ? <span className="kn-lead">Kept by Niko, apart from your account details. Works on all your devices and for Telegram replies.</span>
          : lShown === 'device' ? <>
            <span className="kn-devwarn"><IconWarn />Only on this computer. Your phone won’t use what Niko learned here, Telegram replies can’t either, and clearing this site’s data deletes it.</span>
            <span className="srow-hint">Never kept on Niko’s server. Locked to your account on this computer. Only the notes that fit a question go with it to the AI.</span>
          </> : <>
            <span className="kn-lead">{lShown === 'notion' ? 'A “What Niko learned” page on your Niko Knowledge page in Notion, kept up to date.' : lShown === 'gdrive' ? 'A “What Niko learned” Google Doc in your Niko Knowledge folder, kept up to date.' : lShown === 'onedrive' ? 'A “What Niko learned.md” file in Niko’s own folder in your OneDrive, kept up to date.' : lShown === 'obsidian' ? 'A “What Niko learned” note in the Niko Knowledge folder of your vault, kept up to date.' : 'A “What Niko learned.md” file in the niko-knowledge folder of your storage, kept up to date.'}</span>
            <span className="srow-hint">Niko keeps the notes too, so it can look them up on every question. Each note is one bullet: add, change or remove a bullet there and Niko picks it up the next time it looks (when you open this page, and when it learns something). It never asks for passwords or codes, and a change someone else makes on a shared page is ignored.</span>
            {lShown === learnNow && isRemotePlace(lShown) && lInfo(lShown)?.connected && <PlaceWhere place={lShown} folder={prefs.folders?.[lShown]} root={lInfo(lShown)!.root} picked={lInfo(lShown)!.picked} workspace={lInfo(lShown)!.label} busy={!!lMoving} onRelocated={(r, text) => relocated(lShown as KnRemotePlace, r, text)} />}
            {lShown === learnNow && lCopy && <div className="kn-move">
              <span className={'srow-hint' + (lCopy.error ? ' bad' : lWriting || lCopy.syncedAt ? ' ready' : ' wait')}>{lWriting ? 'Looking at the copy…' : lCopy.error ?? (lCopy.syncedAt ? `Copy updated ${ago(lCopy.syncedAt)}` : 'Not written yet.')}{!lWriting && !lCopy.error && lCopy.picked ? ` ${pickedLine(lCopy.picked, PLACE_NAME[learnNow])}` : ''}</span>
              {lCopy.error || (!lCopy.syncedAt && !lWriting) ? <button type="button" className="bt md" disabled={lWriting} onClick={() => void writeCopy()}>{lCopy.error ? 'Try again' : 'Write it now'}</button>
                : copyLink(lCopy.url) && <a className="bt md" {...copyLink(lCopy.url)!}>Open in {PLACE_NAME[learnNow]}</a>}
            </div>}
            {lShown !== learnNow && isRemotePlace(lShown) && !lInfo(lShown)?.connected && (lShown === 's3' || lShown === 'obsidian'
              ? <span className="srow-hint wait">{lShown === 's3' ? 'Add your storage first' : 'Set up Obsidian first'}, on the Files tab under Where it’s kept.</span>
              : <button type="button" className="bt md" style={{ alignSelf: 'flex-start' }} onClick={() => connect(lShown as KnRemotePlace)}>Connect {PLACE_NAME[lShown]}</button>)}
          </>}
        {(lShown !== learnNow || lMoving) && (
          <div className="kn-move">
            {lMoving ? <span className="kn-move-t"><Status tone="busy">Moving {Math.min(lMoving.done + 1, lMoving.total)} of {lMoving.total}</Status><Meter value={lMoving.done / lMoving.total} warnAt={2} label="Moving what Niko learned" /></span> : <>
              <span className="srow-hint">{lShown === 'device' ? 'Moves what Niko learned to this computer, then removes it from Niko.'
                : learnNow === 'device' ? `Moves what Niko learned from this computer into Niko${isRemotePlace(lShown) ? `, with a copy ${inPlace(lShown)}` : ''}, then removes it here.`
                : isRemotePlace(lShown) ? `Writes a copy of what Niko learned ${inPlace(lShown)}. It stays in Niko too.${isRemotePlace(learnNow) ? ` The copy ${inPlace(learnNow)} stays there and isn’t updated any more.` : ''}`
                : `Niko stops updating the copy ${inPlace(learnNow)}. The copy stays there.`}{lShown === 'device' || learnNow === 'device' ? ' Habits Niko only suggested start again there.' : ''}</span>
              <span className="kn-acts"><button type="button" className="bt md" onClick={() => setLPicked(null)}>Cancel</button>
                <button type="button" className="pri md" disabled={!lCanMove} onClick={() => void moveLearned(lShown)}>{lShown === 'device' || learnNow === 'device' ? 'Move notes' : isRemotePlace(lShown) ? 'Keep a copy there' : 'Use Niko'}</button></span>
            </>}
          </div>
        )}
      </div>
    </div>
  ) : null;

  return (
    <SettingsPage title="Knowledge" sub={sub}>
      <NoteLine note={note} />
      {!st.available ? (
        <div className="kn-page"><div className="kn-main"><section className="g kn-card"><b className="kn-h">Knowledge</b><p className="srow-hint">{access.files || access.learning ? 'Knowledge isn’t available right now. Try again later.' : 'Knowledge isn’t included in your plan.'}</p></section></div></div>
      ) : tab === 'learned' ? (
      <div className="kn-page">
        <div className="kn-main">
          {tabs}
          <LearnedTab key={notesKey} account={account} place={notesPlace} filesPlace={access.learnPlaces.niko ? place : notesPlace} where={learnWhere} copied={isRemotePlace(learnNow)} files={access.files} learn={prefs.learn} onLearn={(v) => void savePrefs({ learn: v }).then(() => refreshMe())} situations={prefs.situations} onSituations={(v) => void savePrefs({ situations: v }).then(() => refreshMe())} />
        </div>
        <LearnedAside files={access.files} />
      </div>
      ) : (
      <div className="kn-page">
        <div className="kn-main">
          {tabs}
          <section className="g kn-card" aria-label="Where your Knowledge is kept">
            <div className="kn-head"><b className="kn-h">Where it’s kept</b><span className="srow-hint">{!places.length ? 'Not included in your plan' : files.length ? `Now: ${PLACE_NAME[spot]} · ${n(files.length, 'file', 'files')}` : 'Nothing kept yet'}</span></div>
            {places.length > 0 && <>
              <div className="kn-places">
                {places.map((p) => (
                  <button key={p} type="button" className="kn-place" aria-pressed={shown === p} disabled={busy} onClick={() => setPicked(p === spot ? null : p)}>
                    <span className="kn-place-top">{PLACE_ICON[p]()}<b>{PLACE_NAME[p]}</b>{p === 'niko' && <span className="kn-pill rec">Recommended</span>}</span>
                    <span className={'srow-hint' + (p === spot ? ' ready' : isRemotePlace(p) && !info(p)?.connected ? ' wait' : '')}>{placeStatus(p)}</span>
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
                </> : shown === 'device' ? <>
                  <span className="kn-devwarn"><IconWarn />Only on this computer. Your phone won’t see these files, Telegram replies can’t use them, and clearing this site’s data deletes them.</span>
                  <span className="srow-hint">Niko reads, stores and searches everything here, locked to your account. Only the parts that match a question go with it to the AI.</span>
                  {place === 'device' && files.length > 0 && <span className="srow-hint">{n(files.length, 'file', 'files')} · {size(bytes)} on this computer · up to {limits.files.toLocaleString()} files</span>}
                </> : <>
                  {shown === 'notion' && <>
                    <span className="kn-lead">Your files go on a page in Notion: documents as pages, spreadsheets as databases. Edit them in Notion; Niko picks up changes the next time it uses them.</span>
                    <span className="srow-hint">Niko also keeps the search pieces and rows, so answers stay quick and totals still work. Niko can only see the pages it puts there. Big spreadsheets take a while the first time, about 3 rows a second.</span>
                  </>}
                  {shown === 'gdrive' && <>
                    <span className="kn-lead">A folder in your Drive: documents as Google Docs, spreadsheets as Google Sheets. Edit them in Drive; Niko picks up changes the next time it uses them.</span>
                    <span className="srow-hint">Niko also keeps the search pieces and rows, so answers stay quick and totals still work. Niko can only see the files it puts there, nothing else in your Drive.</span>
                  </>}
                  {shown === 'onedrive' && <>
                    <span className="kn-lead">{shownInfo?.connected ? '' : 'Connect OneDrive first. Personal and work Microsoft accounts both work. '}Files go in Niko’s own folder in your OneDrive (in Apps › Niko): documents as .md, spreadsheets as .csv.</span>
                    <span className="srow-hint">Niko can only see its own folder. It also keeps the search pieces and rows.</span>
                  </>}
                  {shown === 's3' && (() => {
                    const f = storageForm(), saved = shownInfo?.storage;
                    const set = (k: keyof StorageForm) => (e: { target: { value: string } }) => setStorage({ ...f, [k]: e.target.value });
                    const keyHint = saved ? 'Saved · type to change' : '';
                    return <>
                      <span className="kn-lead">Storage you run or rent that speaks S3, such as a NAS behind your own Cloudflare Tunnel, Cloudflare R2 or MinIO. Files go in a folder of your bucket: documents as .md, spreadsheets as .csv. Niko also keeps the search pieces and rows.</span>
                      <form className="kn-store" autoComplete="off" onSubmit={(e) => { e.preventDefault(); void storageSend(true); }}>
                        <div className="kn-grid2">
                          <label className="kn-field"><span className="kn-k">Address</span><input className="in" value={f.endpoint} onChange={set('endpoint')} placeholder="https://s3.example.com" inputMode="url" spellCheck={false} maxLength={300} disabled={busy} /></label>
                          <label className="kn-field"><span className="kn-k">Bucket</span><input className="in" value={f.bucket} onChange={set('bucket')} placeholder="knowledge" spellCheck={false} maxLength={63} disabled={busy} /></label>
                          <label className="kn-field"><span className="kn-k">Access key ID</span><input className="in" value={f.accessKeyId} onChange={set('accessKeyId')} placeholder={keyHint} spellCheck={false} maxLength={128} disabled={busy} /></label>
                          <label className="kn-field"><span className="kn-k">Secret key</span><input className="in" type="password" value={f.secretAccessKey} onChange={set('secretAccessKey')} placeholder={keyHint} maxLength={256} disabled={busy} /></label>
                        </div>
                        <details className="kn-details" open={saved?.access || undefined}>
                          <summary>Behind Cloudflare Access (optional)</summary>
                          <div className="kn-grid2">
                            <label className="kn-field"><span className="kn-k">Client ID</span><input className="in" value={f.accessId} onChange={set('accessId')} placeholder={saved?.access ? 'Saved · type to change' : ''} spellCheck={false} maxLength={128} disabled={busy} /></label>
                            <label className="kn-field"><span className="kn-k">Client secret</span><input className="in" type="password" value={f.accessSecret} onChange={set('accessSecret')} placeholder={saved?.access ? 'Saved · type to change' : ''} maxLength={256} disabled={busy} /></label>
                          </div>
                        </details>
                        <div className="kn-store-b">
                          <span className="srow-hint">Must use https and a public address. Keys are locked in Niko and never shown again. Changing the address clears them.</span>
                          <span className="kn-store-acts">
                            {saved && spot !== 's3' && <button type="button" className="bt md" disabled={busy} onClick={() => void storageRemove()}>Remove</button>}
                            <button type="button" className="bt md" disabled={busy || !f.endpoint || !f.bucket} onClick={() => void storageSend(false)}>Test</button>
                            <button type="submit" className="pri md" disabled={busy || !f.endpoint || !f.bucket || (!!saved && !storage)}>Save</button>
                          </span>
                        </div>
                        {storageNote && <span role="status" className={'srow-hint ' + (storageNote.ok ? 'ready' : 'no')}>{storageNote.text}</span>}
                      </form>
                    </>;
                  })()}
                  {shown === 'obsidian' && <ObsidianPanel saved={shownInfo?.obsidian} busy={busy} inUse={spot === 'obsidian' || learnNow === 'obsidian'} onSaved={load} />}
                  {isRemotePlace(shown) && shownInfo?.connected && <PlaceWhere place={shown} folder={prefs.folders?.[shown]} root={shownInfo.root} picked={shownInfo.picked} workspace={shownInfo.label} busy={busy} onRelocated={(r, text) => relocated(shown as KnRemotePlace, r, text)} />}
                  {isRemotePlace(shown) && !shownInfo?.connected && CONNECT[shown] && <span><button type="button" className="bt md" disabled={busy} onClick={() => connect(shown)}>Connect {PLACE_NAME[shown]}</button></span>}
                  {shown === spot && copying && <span className="kn-move-t"><Status tone="busy">Copying {Math.min(copying.done + 1, copying.total)} of {copying.total}{copying.name ? ` · ${copying.name}` : ''}{copying.rows && copying.rows.total > 20 ? ` · ${copying.rows.done.toLocaleString()} of ${copying.rows.total.toLocaleString()} rows` : ''}</Status><Meter value={copying.total ? (copying.done + (copying.rows ? copying.rows.done / Math.max(1, copying.rows.total) : 0)) / copying.total : 0} warnAt={2} label="Copying files" /></span>}
                  {shown === spot && !copying && notCopied.length > 0 && <div className="kn-move">
                    <span className="srow-hint">{copyProblem ?? `${n(notCopied.length, 'file isn’t', 'files aren’t')} ${inPlace(shown)} yet.`}</span>
                    <button type="button" className="bt md" disabled={busy} onClick={() => void copyNow()}>{copyProblem ? 'Try again' : 'Copy now'}</button>
                  </div>}
                </>}
                {(shown !== spot || moving) && (
                  <div className="kn-move">
                    {moving ? <>
                      <span className="kn-move-t"><Status tone="busy">Moving {Math.min(moving.done + 1, moving.total)} of {moving.total}{moving.name ? ` · ${moving.name}` : ''}</Status><Meter value={moving.total ? moving.done / moving.total : 0} warnAt={2} label="Moving files" /></span>
                    </> : <>
                      <span className="srow-hint">{files.length
                        ? isRemotePlace(shown) ? `Moving copies your ${n(files.length, 'file', 'files')} to ${toName(shown)}. Niko keeps their search pieces, so answers don’t change.${remote ? ' Copies in the place you leave stay there.' : ''}`
                          : shown === 'device' || place === 'device' ? `Moving copies your ${n(files.length, 'file', 'files')} to ${toName(shown)}, then removes the copy ${inPlace(spot)}. Nothing is lost.${remote ? ` Copies ${inPlace(spot)} stay there.` : ''}`
                          : `Niko stops using the copies ${inPlace(spot)}; they stay there. Your files and their search pieces are already in Niko.`
                        : `New files will be kept ${inPlace(shown)}.`}</span>
                      <button type="button" className="pri md" disabled={busy || !canMoveTo} onClick={() => void move(shown)}>{files.length ? `Move to ${toName(shown)}` : `Use ${toName(shown)}`}</button>
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
                          {copyLink(f.url) && f.place && isRemotePlace(f.place) && <a role="menuitem" {...copyLink(f.url)!} onClick={() => setMenu(null)}>Open in {PLACE_NAME[f.place]}</a>}
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
      {removing && <RemoveCopy file={removing.file} bin={removing.bin} onBin={(bin) => setRemoving({ ...removing, bin })} onClose={() => setRemoving(null)} onRemove={() => { const r = removing; setRemoving(null); void remove(r.file, r.bin ? 'bin' : 'keep'); }} />}
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

/** Removing a file kept elsewhere: keep its copy there (the default) or remove that too. */
function RemoveCopy({ file, bin, onBin, onClose, onRemove }: { file: KnFile; bin: boolean; onBin: (bin: boolean) => void; onClose: () => void; onRemove: () => void }) {
  const place = (file.place ?? 'gdrive') as KnRemotePlace;
  const what = place === 'gdrive' ? (file.sheets ? 'Google Sheet' : 'Google Doc') : place === 'notion' ? (file.sheets ? 'Notion database' : 'Notion page') : place === 'obsidian' ? 'note in Obsidian' : 'copy';
  const keepSub = place === 'gdrive' ? 'It stays in your Niko Knowledge folder in Drive.' : place === 'notion' ? 'It stays on your Niko Knowledge page in Notion.' : place === 'onedrive' ? 'It stays in Niko’s folder in your OneDrive.' : place === 'obsidian' ? 'It stays in the Niko Knowledge folder of your vault.' : 'It stays in the niko-knowledge folder of your storage.';
  const binLabel = place === 's3' ? 'Also delete the file in your storage' : place === 'obsidian' ? 'Also delete the note in your vault' : `Also move the ${what} to the bin`;
  const binSub = place === 's3' ? 'It can’t be brought back.' : place === 'obsidian' ? 'Obsidian’s File recovery may still have a copy.' : place === 'gdrive' ? 'You can get it back from Drive’s bin for 30 days.' : place === 'notion' ? 'You can get it back from Notion’s trash.' : 'You can get it back from OneDrive’s recycle bin.';
  return (
    <Sheet onClose={onClose} labelledBy="kn-rm-h">
      <div className="kn-dlg">
        <b id="kn-rm-h" className="kn-dlg-h">Remove “{file.name}”?</b>
        <span className="kn-lead">Niko removes its text, rows and search index straight away.</span>
        <div className="kn-opts" role="radiogroup" aria-label="Its copy">
          <label className={'kn-opt' + (!bin ? ' on' : '')}><input type="radio" name="kn-rm" checked={!bin} onChange={() => onBin(false)} /><span><span className="kn-opt-t">Keep the {what}</span><span className="srow-hint">{keepSub}</span></span></label>
          <label className={'kn-opt' + (bin ? ' on' : '')}><input type="radio" name="kn-rm" checked={bin} onChange={() => onBin(true)} /><span><span className="kn-opt-t">{binLabel}</span><span className="srow-hint">{binSub}</span></span></label>
        </div>
        <div className="kn-dlg-b"><button type="button" className="bt" onClick={onClose}>Cancel</button><button type="button" className="pri md danger" onClick={onRemove}>Remove file</button></div>
      </div>
    </Sheet>
  );
}
