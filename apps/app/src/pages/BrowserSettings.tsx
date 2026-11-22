// Settings › Browser, as the Settings-Browser mockup draws it: whether Niko may use a browser, what it always asks
// first, the browser services it uses, passwords and sign-in codes, sites kept signed in, "What Niko did" and the
// day's browser time.
import { useCallback, useEffect, useState } from 'react';
import { api, Meter, Segmented, SettingRow, Switch } from '@niko/ui';
import { BROWSER_HISTORY_DAYS, type BrowserPrefs } from '@niko/shared';
import { SettingsPage, NoteLine } from './Settings';

interface Minutes { used: number; cap: number; left: number | null; refillAt: string }
interface BrowserInfo { offered: boolean; allowed: boolean; ready: boolean; prefs: BrowserPrefs; minutes: Minutes; staySignedIn: boolean; maxHistoryDays: number }
interface Signin { site: string; createdAt: string; usedAt: string | null; uses: number }
interface Step { at: string; site: string; kind: string; text: string }
interface Visit { id: string; site: string; at: string; seconds: number; steps: Step[] }
type Note = { ok: boolean; text: string } | null;

const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const day = (iso: string) => {
  const d = new Date(iso), now = new Date();
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (d.toDateString() === now.toDateString()) return 'Today';
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { day: 'numeric', month: 'short' });
};
const mins = (s: number) => (s < 60 ? 'under 1 min' : `${Math.round(s / 60)} min`);
const lower = (t: string) => t.charAt(0).toLowerCase() + t.slice(1);

/** One line for a visit: what Niko finished, or the site it was on. */
function titleOf(v: Visit): string {
  const done = [...v.steps].reverse().find((s) => s.kind === 'done' && !s.text.startsWith('Stayed signed in'));
  if (done) return done.text.replace(/\.$/, '');
  return v.site ? `Browsed ${v.site}` : 'Used the browser';
}
function stepsOf(v: Visit): string {
  const n = (k: string) => v.steps.filter((s) => s.kind === k).length;
  const bits: string[] = [];
  if (v.steps.some((s) => s.text === 'You typed the password')) bits.push('you typed the password');
  if (v.steps.some((s) => s.text.includes('sign-in code'))) bits.push(v.steps.some((s) => s.text.includes('in your Inbox')) ? 'code from Inbox' : 'you entered a code');
  if (n('ok')) bits.push(n('ok') === 1 ? `you OK’d ${lower(v.steps.find((s) => s.kind === 'ok')!.text.replace(/^You OK’d: /, '')).replace(/\?$/, '')}` : `you OK’d ${n('ok')} steps`);
  if (n('declined')) bits.push('you said not now');
  if (n('download')) bits.push(n('download') === 1 ? 'downloaded a file' : `downloaded ${n('download')} files`);
  return bits.join(', ');
}

export function BrowserSettings() {
  const [info, setInfo] = useState<BrowserInfo | null>(null);
  const [signins, setSignins] = useState<Signin[]>([]);
  const [visits, setVisits] = useState<Visit[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [note, setNote] = useState<Note>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [i, s, a] = await Promise.all([
      api<BrowserInfo>('/browser'),
      api<{ signins: Signin[] }>('/browser/signins').catch(() => ({ signins: [] })),
      api<{ sessions: Visit[] }>('/browser/activity').catch(() => ({ sessions: [] })),
    ]);
    setInfo(i); setSignins(s.signins); setVisits(a.sessions);
  }, []);
  useEffect(() => { void load().catch((e) => setNote({ ok: false, text: (e as Error).message })); }, [load]);

  const save = async (p: Partial<BrowserPrefs>) => {
    if (!info) return;
    const before = info;
    setInfo({ ...info, prefs: { ...info.prefs, ...p }, allowed: info.offered && (p.on ?? info.prefs.on) });
    try { const r = await api<{ prefs: BrowserPrefs }>('/browser/prefs', { method: 'PUT', body: { prefs: p } }); setInfo((x) => (x ? { ...x, prefs: r.prefs } : x)); }
    catch (e) { setInfo(before); setNote({ ok: false, text: (e as Error).message }); }
  };
  const forget = async (site?: string) => {
    setBusy(true);
    try {
      await api(site ? `/browser/signins/${encodeURIComponent(site)}` : '/browser/signins', { method: 'DELETE' });
      setSignins((x) => (site ? x.filter((y) => y.site !== site) : []));
      setNote({ ok: true, text: site ? `Niko forgot the sign-in for ${site}.` : 'Niko forgot every kept sign-in.' });
    } catch (e) { setNote({ ok: false, text: (e as Error).message }); } finally { setBusy(false); }
  };
  const clear = async () => {
    setBusy(true);
    try { await api('/browser/activity', { method: 'DELETE' }); setVisits([]); setNote({ ok: true, text: 'The list is cleared.' }); }
    catch (e) { setNote({ ok: false, text: (e as Error).message }); } finally { setBusy(false); }
  };

  if (!info) return <SettingsPage title="Browser" sub="How Niko uses a browser for you: signing up, signing in, and getting things done on websites."><NoteLine note={note} />{!note && <p className="srow-hint">Loading…</p>}</SettingsPage>;
  const { prefs, minutes: m } = info;
  const on = prefs.on;
  const left = m.left === null ? null : Math.floor(m.left / 60);
  const cap = Math.round(m.cap / 60);
  const keepChoices = BROWSER_HISTORY_DAYS.filter((d) => d <= info.maxHistoryDays).map((d) => [String(d), `${d} days`] as const);
  const builtSub = !info.ready ? 'Not available right now.' : left === null ? `Refills at ${time(m.refillAt)}` : `${left} of ${cap} min left today · refills at ${time(m.refillAt)}`;

  return (
    <SettingsPage title="Browser" sub="How Niko uses a browser for you: signing up, signing in, and getting things done on websites.">
      <NoteLine note={note} />
      <div className="kn-page">
        <div className="kn-main">
          <section className="g kn-card" aria-label="Browser">
            <SettingRow title={<span className="bs-big">Let Niko use a browser</span>} hint="Say things like “sign me up at…”, “log in to…” or “find me a table at…”. Off: Niko only looks things up.">
              <Switch on={on} onChange={(v) => void save({ on: v })} label="Let Niko use a browser" />
            </SettingRow>
            {on && <>
              <span className="k bs-k">Niko asks you first before it</span>
              <SettingRow title="Submits a form, signs you in or creates an account" hint="You see what will be sent, then OK it."><span className="bs-fix">Always</span></SettingRow>
              <SettingRow title="Agrees to a site’s terms" hint="With a link to read them first."><span className="bs-fix">Always</span></SettingRow>
              <SettingRow title="Pays for anything" hint="Niko never pays. It hands the payment page to you, and can’t see card fields."><span className="bs-fix">You pay</span></SettingRow>
              <SettingRow title="Downloads a file" hint="Files go straight to this device. Nothing is kept on Niko’s server.">
                <Switch on={prefs.askDownloads} onChange={(v) => void save({ askDownloads: v })} label="Ask before downloading" />
              </SettingRow>
              <SettingRow title="Goes to a site you didn’t name" hint="For example, when a page sends Niko somewhere else to sign in.">
                <Switch on={prefs.askNewSite} onChange={(v) => void save({ askNewSite: v })} label="Ask before going to a new site" />
              </SettingRow>
            </>}
          </section>

          {on && <section className="g kn-card" aria-label="Browser services">
            <span className="bs-head"><span className="k bs-k">Browser services</span><span className="srow-hint">Niko uses the first one that works, and moves to the next if it can’t be reached.</span></span>
            <div className="bs-svc">
              <span className="bs-svc-l"><span className="bs-num">1</span><span className="srow-t"><span className="srow-name">Niko’s browser</span><span className="srow-hint">{builtSub}</span></span></span>
              <span className="bs-fix">Built in</span>
            </div>
          </section>}

          {on && <section className="g kn-card" aria-label="Passwords and codes">
            <span className="k bs-k">Passwords and codes</span>
            <SettingRow title="Passwords" hint="You type them. Niko hands over at every password field, can’t see what you type, and never keeps them."><span className="bs-fix">You type</span></SettingRow>
            <SettingRow title="Offer sign-in codes from my Inbox" hint="When a site emails you a code, Niko finds it and asks before entering it. Codes are used once and not kept.">
              <Switch on={prefs.inboxCodes} onChange={(v) => void save({ inboxCodes: v })} label="Offer sign-in codes from my Inbox" />
            </SettingRow>
          </section>}

          {on && info.staySignedIn && <section className="g kn-card" aria-label="Stay signed in">
            <span className="bs-row-h"><span className="k bs-k">Stay signed in</span>{signins.length > 0 && <button type="button" className="bs-lnk" disabled={busy} onClick={() => void forget()}>Forget all</button>}</span>
            <span className="kn-lead">Every session starts fresh and is forgotten when it closes, unless you chose “Stay signed in” for a site after signing in. Those sign-ins are kept encrypted, for your account only.</span>
            {signins.map((x) => (
              <div key={x.site} className="bs-svc">
                <span className="bs-svc-l"><span className="bs-ini" aria-hidden="true">{x.site.charAt(0).toUpperCase()}</span><span className="srow-t"><span className="srow-name">{x.site}</span><span className="srow-hint">Kept {day(x.createdAt).toLowerCase() === 'today' ? 'today' : `since ${day(x.createdAt)}`}{x.usedAt ? ` · last used ${day(x.usedAt).toLowerCase()}` : ''}</span></span></span>
                <button type="button" className="bt md" disabled={busy} onClick={() => void forget(x.site)}>Forget</button>
              </div>
            ))}
            {signins.length === 0 && <p className="srow-hint bs-none">No sites. Niko signs in fresh each time.</p>}
          </section>}

          <section className="g kn-card" aria-label="What Niko did">
            <span className="k bs-k">What Niko did</span>
            {visits.map((x) => (
              <div key={x.id} className="bs-visit">
                <div className="bs-svc">
                  <span className="srow-t"><span className="srow-name">{titleOf(x)}</span><span className="srow-hint">{day(x.at)}, {time(x.at)} · {mins(x.seconds)}{stepsOf(x) ? ` · ${stepsOf(x)}` : ''}</span></span>
                  <button type="button" className="bs-lnk" aria-expanded={open === x.id} onClick={() => setOpen(open === x.id ? null : x.id)}>{open === x.id ? 'Hide' : 'Details'}</button>
                </div>
                {open === x.id && <ol className="bs-steps">{x.steps.map((s, i) => <li key={i}><span className="bs-st">{time(s.at)}</span><span>{s.text}{s.site && !s.text.includes(s.site) ? <span className="srow-hint"> · {s.site}</span> : null}</span></li>)}</ol>}
              </div>
            ))}
            {visits.length === 0 && <p className="srow-hint bs-none">Nothing yet. When Niko uses the browser for you, each visit is listed here.</p>}
            <div className="bs-keep"><SettingRow title="Keep this list for" hint="Sites and steps only. Never what you typed, never page contents.">
              <Segmented value={String(Math.min(prefs.keepDays, info.maxHistoryDays))} options={keepChoices} label="Keep this list for" onChange={(v) => void save({ keepDays: Number(v) })} />
            </SettingRow></div>
            {visits.length > 0 && <span><button type="button" className="bs-lnk danger" disabled={busy} onClick={() => void clear()}>Clear this list</button></span>}
          </section>
        </div>

        <aside className="kn-aside" aria-label="About Niko’s browser">
          {on && info.ready && <>
            <span className="k">Browser time</span>
            {left !== null ? <>
              <span className="bs-time"><b>{left}</b><span>of {cap} min left today</span></span>
              <Meter value={m.cap ? m.used / m.cap : 0} label="Browser time used today" />
            </> : <span className="bs-time"><span>No daily limit</span></span>}
            <p>Time counts only while Niko’s browser is open. It refills at {time(m.refillAt)}.</p>
          </>}
          <span className="k">How it works</span>
          <p>The browser runs on a secure server, not on this device. You see it live in Niko and can take over at any time.</p>
          <p>Niko reads the page to work out what to click. Password and card fields are hidden from it.</p>
          <p>Niko only takes instructions from you. If a page tries to tell Niko what to do, Niko ignores it and says so.</p>
          <p>Your password manager can’t fill Niko’s browser. Type or paste it at the hand-off.</p>
        </aside>
      </div>
    </SettingsPage>
  );
}
