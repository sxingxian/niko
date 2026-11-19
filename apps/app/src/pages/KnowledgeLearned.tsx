// Settings · Knowledge · What Niko learned, and the "Matches you taught" section of the Files tab, as the
// Knowledge-Learned and Knowledge-Settings mockups. Notes are kept where the person chose (in Niko, or on this device);
// matches taught for files are kept with the files.
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, Switch } from '@niko/ui';
import { KN_LEARNED_KIND_NAMES, KN_LEARNED_KINDS_NOW, KN_LEVEL_NAMES, type KnLearnedItem, type KnLearnedKind } from '@niko/shared';
import { declineHabitHere, editNoteHere, forgetAllHere, forgetNoteHere, keepHabitHere, notesHere } from '../knowledgeDevice';
import { Sheet } from './Designs';
import { syncLearnedCopySoon } from '../knowledgeChat';

type Place = 'niko' | 'device';
const LEVEL_FG = { sure: '#a8f0c6', fairly: '#9fdcf3', unsure: '#ffd38a' } as const;
const NEVER_FG = '#8b93a3';

/** Notes, wherever they're kept: most where the person chose (`place`), matches taught for files with the files
 *  (`filesPlace`). `changed` runs after any change (a copy in their own app is rewritten). */
function useNotes(account: string, place: Place, filesPlace: Place = place, changed?: () => void) {
  const [items, setItems] = useState<KnLearnedItem[] | null>(null);
  const [err, setErr] = useState('');
  const from = (p: Place) => (p === 'device' ? notesHere(account) : api<{ items: KnLearnedItem[] }>('/knowledge/learned').then((r) => r.items));
  const load = useCallback(async () => {
    setErr('');
    try {
      if (place === filesPlace) setItems(await from(place));
      else {
        const [notes, matches] = await Promise.all([from(place), from(filesPlace).catch(() => [] as KnLearnedItem[])]);
        setItems([...notes.filter((n) => n.kind !== 'file-match'), ...matches.filter((n) => n.kind === 'file-match')]);
      }
    }
    catch (e) { setErr((e as Error).message); setItems([]); }
  }, [account, place, filesPlace]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { void load(); }, [load]);
  const where = (id: string): Place => ((items ?? []).find((y) => y.id === id)?.kind === 'file-match' ? filesPlace : place);
  const forget = async (id: string) => {
    if (where(id) === 'device') await forgetNoteHere(account, id); else await api(`/knowledge/learned/${id}`, { method: 'DELETE' });
    setItems((x) => x?.filter((y) => y.id !== id) ?? null); changed?.();
  };
  const edit = async (id: string, b: { said: string; means: string }) => {
    const it = where(id) === 'device' ? await editNoteHere(account, id, b) : (await api<{ item: KnLearnedItem }>(`/knowledge/learned/${id}`, { method: 'PATCH', body: b })).item;
    setItems((x) => x?.map((y) => (y.id === id ? it : y)) ?? null); changed?.();
  };
  /** "Yes, keep" / "No" on a habit Niko suggested. */
  const answer = async (id: string, keep: boolean) => {
    if (place === 'device') { if (keep) await keepHabitHere(account, id); else await declineHabitHere(account, id); }
    else await api(`/knowledge/learned/${id}/${keep ? 'keep' : 'decline'}`, { method: 'POST' });
    await load(); changed?.();
  };
  const forgetAll = async () => {
    for (const p of new Set([place, filesPlace])) { if (p === 'device') await forgetAllHere(account); else await api('/knowledge/learned', { method: 'DELETE' }); }
    setItems([]);
  };
  return { items, err, setErr, forget, edit, forgetAll, load, answer };
}

const what = (n: KnLearnedItem) => (n.kind === 'habit' || n.kind === 'playbook' ? n.said : `“${n.said}”`);
const meaning = (n: KnLearnedItem) => n.kind === 'remembered' ? 'Kept as you said it' : n.kind === 'habit' ? n.means : n.kind === 'file-match' ? `${n.target?.answer === 'no' ? '✕' : '→'} ${n.means}` : `→ ${n.means}`;
const used = (n: KnLearnedItem) => (n.suggested ? `Fades in ${n.fadesIn ?? 60} ${n.fadesIn === 1 ? 'day' : 'days'}` : n.kind === 'habit' ? 'Kept' : n.uses ? `Used ${n.uses === 1 ? 'once' : `${n.uses} times`}` : 'Not used yet');

/** The What Niko learned tab. */
export function LearnedTab({ account, place, filesPlace, where, copied, files, learn, onLearn, situations, onSituations }: { account: string; place: Place; filesPlace?: Place; where?: ReactNode; copied?: boolean; files: boolean; learn: boolean; onLearn: (v: boolean) => void; situations: boolean; onSituations: (v: boolean) => void }) {
  const { items, err, setErr, forget, edit, forgetAll, answer } = useNotes(account, place, filesPlace ?? place, copied ? () => syncLearnedCopySoon() : undefined);
  const [kind, setKind] = useState<'all' | KnLearnedKind>('all');
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<{ id: string; said: string; means: string } | null>(null);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const list = items ?? [];
  const shown = useMemo(() => list.filter((n) => (kind === 'all' || n.kind === kind) && (!q.trim() || `${n.said} ${n.means}`.toLowerCase().includes(q.trim().toLowerCase()))), [list, kind, q]);
  const run = async (fn: () => Promise<void>) => { setBusy(true); setErr(''); try { await fn(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); } };
  return (
    <>
      <section className="g kn-card" aria-label="Learning">
        <div className="kn-learn-top">
          <span className="kn-learn-t"><b className="kn-h">Learn from how I use Niko</b><span className="srow-hint lg">Niko learns from your answers, your corrections, what you ask it to remember and things you do often. Never from what others send you.</span></span>
          <Switch on={learn} onChange={onLearn} label="Learn from how I use Niko" />
        </div>
        <div className="kn-learn-sit">
          <span className="kn-learn-t"><span className="srow-name">Use my calendar, the time and my location to understand situations</span><span className="srow-hint">Read for the question you ask, not stored. Location only where you’ve allowed it for maps. A meeting on your calendar also turns on quiet mode.</span></span>
          <Switch on={situations} onChange={onSituations} label="Use my calendar, the time and my location to understand situations" />
        </div>
        {!learn && <span className="kn-paused">Paused. Niko still uses what it already learned; turn it back on to keep learning. Use Forget to remove anything.</span>}
        <div className="kn-levels">
          <div className="kn-level"><span><i className="dot" style={{ background: LEVEL_FG.sure }} />Sure</span><span className="srow-hint">Niko just does it. Sending still waits 10 seconds.</span></div>
          <div className="kn-level"><span><i className="dot" style={{ background: LEVEL_FG.fairly }} />Fairly sure</span><span className="srow-hint">Niko does it and tells you what it assumed. Say “no” to correct it.</span></div>
          <div className="kn-level"><span><i className="dot" style={{ background: LEVEL_FG.unsure }} />Not sure</span><span className="srow-hint">Niko asks you first, and remembers your answer.</span></div>
        </div>
        {where}
      </section>

      <section className="g kn-card" aria-label="Everything Niko learned">
        <div className="kn-learn-bar">
          <div className="kn-tabs" role="tablist" aria-label="Kinds">
            {/* File matches only with Knowledge files (or when some are still kept from before). */}
            {(['all', ...KN_LEARNED_KINDS_NOW.filter((k) => k !== 'file-match' || files || list.some((n) => n.kind === k))] as const).map((k) => (
              <button key={k} type="button" role="tab" className="ptab" aria-selected={kind === k} onClick={() => setKind(k)}>
                {k === 'all' ? 'All' : KN_LEARNED_KIND_NAMES[k]}<span className="n">{k === 'all' ? list.length : list.filter((n) => n.kind === k).length}</span>
              </button>
            ))}
          </div>
          <input className="in kn-learn-q" placeholder="Search what Niko learned" aria-label="Search what Niko learned" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        {err && <p className="err" role="alert">{err}</p>}
        <div className="kn-lrows">
          {items === null && <p className="srow-hint kn-none">Loading…</p>}
          {shown.map((n) => editing?.id === n.id ? (
            <form key={n.id} className="kn-lrow editing" onSubmit={(e) => { e.preventDefault(); void run(async () => { await edit(n.id, { said: editing.said, means: editing.means }); setEditing(null); }); }}>
              <span className="kn-ledit">
                <input className="in" aria-label={n.kind === 'playbook' ? 'The situation' : 'What you say'} value={editing.said} maxLength={n.kind === 'remembered' ? 300 : n.kind === 'playbook' ? 200 : 120} onChange={(e) => setEditing({ ...editing, said: e.target.value })} />
                {n.kind !== 'remembered' && <input className="in" aria-label={n.kind === 'playbook' ? 'What you do' : 'What it means'} value={editing.means} maxLength={300} onChange={(e) => setEditing({ ...editing, means: e.target.value })} />}
              </span>
              <span className="kn-lacts"><button type="button" className="bt md" onClick={() => setEditing(null)}>Cancel</button><button type="submit" className="pri md" disabled={busy}>Save</button></span>
            </form>
          ) : (
            <div key={n.id} className="kn-lrow">
              <span className="kn-lwhat"><b>{what(n)}</b><span className={'srow-hint' + (n.kind === 'file-match' && n.target?.answer === 'no' ? ' no' : '')}>{meaning(n)}</span></span>
              <span className="srow-hint">{n.how}</span>
              <span className="kn-llevel">
                {n.kind === 'file-match' && n.target?.answer === 'no'
                  ? <span style={{ color: NEVER_FG }}><i className="dot" style={{ background: NEVER_FG }} />Never offered</span>
                  : <span style={{ color: LEVEL_FG[n.level] }}><i className="dot" style={{ background: LEVEL_FG[n.level] }} />{KN_LEVEL_NAMES[n.level]}</span>}
                {!(n.kind === 'file-match' && n.target?.answer === 'no') && <span className="srow-hint sm">{used(n)}</span>}
              </span>
              <span className="kn-lacts">
                {n.suggested ? <>
                  <button type="button" className="pri md" disabled={busy} onClick={() => void run(() => answer(n.id, true))}>Yes, keep</button>
                  <button type="button" className="bt md" disabled={busy} onClick={() => void run(() => answer(n.id, false))}>No</button>
                </> : <>
                  {n.kind !== 'file-match' && n.kind !== 'habit' && <button type="button" className="bt md" onClick={() => setEditing({ id: n.id, said: n.said, means: n.means })}>Edit</button>}
                  <button type="button" className="bt md" disabled={busy} onClick={() => void run(() => forget(n.id))}>Forget</button>
                </>}
              </span>
            </div>
          ))}
          {items !== null && !shown.length && <p className="srow-hint kn-none">{list.length ? 'Nothing matches.' : learn ? 'Nothing here yet. Tell Niko “remember that…”, or correct it, and it shows up here.' : 'Nothing here yet.'}</p>}
        </div>
        <div className="kn-learn-foot">
          <span className="srow-hint">Things you haven’t confirmed fade after 60 days unless Niko keeps seeing them.</span>
          <button type="button" className="bt md danger" disabled={!list.length || busy} onClick={() => setAsking(true)}>Forget everything Niko learned</button>
        </div>
      </section>
      {asking && (
        <Sheet onClose={() => setAsking(false)} labelledBy="kn-forget-h">
          <div className="kn-dlg">
            <b id="kn-forget-h" className="kn-dlg-h">Forget everything Niko learned?</b>
            <span className="srow-hint lg">All {list.length.toLocaleString()} {list.length === 1 ? 'note goes' : 'notes go'}, including matches you taught.{copied ? ' The copy in your own app goes to its bin.' : ''} Your files stay. Niko starts learning again from your next question{learn ? '' : ', once learning is back on'}.</span>
            <div className="kn-dlg-b"><button type="button" className="bt" onClick={() => setAsking(false)}>Cancel</button><button type="button" className="pri md" disabled={busy} onClick={() => void run(async () => { await forgetAll(); setAsking(false); })}>Forget everything</button></div>
          </div>
        </Sheet>
      )}
    </>
  );
}

/** The aside beside What Niko learned. */
export function LearnedAside({ files }: { files: boolean }) {
  return (
    <aside className="kn-aside" aria-label="About what Niko learns">
      <span className="k">How Niko learns</span>
      <p>Each thing Niko learns is a short note it looks up when you ask something{files ? ', like your files' : ''}. No AI is trained on it.</p>
      <p>Your answers and corrections count most. A correction replaces the old note straight away.</p>
      <p>Things you do often are only suggested, and kept once you say yes.</p>
      <p>Playbooks are how you handle situations.{files ? ' They’re used before your files, and Niko mentions when a file says otherwise.' : ''}</p>
      {files && <p>Say “that’s the one” to something similar from your files, and Niko uses it for questions like that from then on.</p>}
      <span className="k">Never learned</span>
      <p>Anything from emails, messages, files or pages others wrote: a message saying “remember that…” changes nothing.</p>
      <p>Passwords, codes, card or account numbers.</p>
      <p>Guesses about your health or beliefs, or judgements about other people. Notes about people are facts you confirmed.</p>
      <span className="k">Private</span>
      <p>Only you can see this list. Learned notes never approve sending, paying or deleting on their own.</p>
    </aside>
  );
}

/** "Matches you taught", on the Files tab. */
export function TaughtSection({ account, place }: { account: string; place: Place }) {
  const { items, err, forget } = useNotes(account, place);
  const taught = (items ?? []).filter((n) => n.kind === 'file-match');
  return (
    <section className="g kn-card" aria-label="Matches you taught">
      <div className="kn-head"><b className="kn-h">Matches you taught</b><span className="srow-hint">{taught.length === 1 ? '1 match' : `${taught.length} matches`}</span></div>
      <span className="srow-hint">When Niko finds something similar and you say “that’s the one”, it uses that file for questions like it from then on. “Not this one” stops it being offered again. Everything else Niko learned is under What Niko learned.</span>
      {err && <p className="err" role="alert">{err}</p>}
      <div className="kn-taught">
        {taught.map((t) => (
          <div key={t.id} className="kn-trow">
            <span className="kn-lwhat"><b>“{t.said}”</b><span className="srow-hint">→ {t.means}</span></span>
            <span className="kn-llevel"><span style={{ color: t.target?.answer === 'no' ? '#ffd38a' : '#a8f0c6' }}><i className="dot" style={{ background: t.target?.answer === 'no' ? '#ffd38a' : '#a8f0c6' }} />{t.target?.answer === 'no' ? 'Not this one' : 'That’s the one'}</span></span>
            <button type="button" className="bt md" onClick={() => void forget(t.id)}>Remove</button>
          </div>
        ))}
        {items !== null && !taught.length && <p className="srow-hint kn-none">Nothing taught yet.</p>}
      </div>
    </section>
  );
}
