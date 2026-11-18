// Choose your Niko: every design the account can see, live. Any design can be previewed in each state for free; paid
// ones unlock once (or all at once), bundle owners add new ones at a pro-rated price, and on an active monthly or
// yearly plan the Niko Pro add-on gives every design. The server works out every price and checks every choice.
import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, DesignPreview, Icon, type CoreMode } from '@niko/ui';
import { money, type DesignOffer, type DesignsView } from '@niko/shared';
import { useNiko } from '../niko';

type View = DesignsView & { current: string; payments: boolean; testMode: boolean; proBackgrounds?: boolean };
type Buy = 'one' | 'all' | 'topup' | 'topupall' | 'pro';
type Bought = { kind: Buy; name: string };

const STATES: [CoreMode, string][] = [['idle', 'Standing by'], ['listening', 'Listening'], ['thinking', 'Thinking'], ['speaking', 'Speaking']];

function metaOf(d: DesignOffer): string {
  if (d.state === 'included') return 'Included';
  if (d.state === 'owned') return d.retired ? 'Retired · yours' : 'Yours';
  if (d.state === 'pro') return 'With Pro';
  if (d.back) return 'Back · new';
  if (d.fresh) return 'New';
  return d.cents ? money(d.cents) : '';
}

/** Returning from Stripe with ?design=<checkout id>: asks the server (which asks Stripe) until the payment counts. */
function useDesignReturn(onPaid: (v: View & { bought: { kind: Buy; designs: string[] } | null }) => void) {
  const [params, setParams] = useSearchParams();
  const id = params.get('design');
  const [state, setState] = useState<'idle' | 'confirming' | 'slow'>(id && id !== 'cancelled' ? 'confirming' : 'idle');
  useEffect(() => {
    if (id === 'cancelled') { setParams({}, { replace: true }); return; }
    if (!id) return;
    let stop = false, tries = 0;
    const tick = async () => {
      if (stop) return;
      tries++;
      const r = await api<View & { paid: boolean; bought: { kind: Buy; designs: string[] } | null }>(`/designs/status?session=${encodeURIComponent(id)}`).catch(() => null);
      if (stop) return;
      if (r?.paid) { setParams({}, { replace: true }); setState('idle'); onPaid(r); return; }
      if (tries >= 30) { setState('slow'); return; }
      window.setTimeout(tick, tries < 5 ? 1500 : 3000);
    };
    void tick();
    return () => { stop = true; };
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  return state;
}

export function Designs() {
  const { me, refreshMe } = useNiko();
  const [v, setV] = useState<View | null>(null);
  const [sel, setSel] = useState<string>('');
  const [mode, setMode] = useState<CoreMode>('idle');
  const [sheet, setSheet] = useState<Buy | null>(null);
  const [plan, setPlan] = useState<Buy>('one');
  const [done, setDone] = useState<Bought | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [removing, setRemoving] = useState(false);

  const load = async () => { const r = await api<View>('/designs'); setV(r); setSel((s) => s || r.current); return r; };
  useEffect(() => { void load().catch((x) => setErr(x.message)); }, []);
  const returning = useDesignReturn((r) => {
    setV(r);
    const first = r.bought?.designs[0];
    if (first) setSel(r.bought!.kind === 'one' || r.bought!.kind === 'topup' ? first : sel || first);
    if (r.bought) setDone({ kind: r.bought.kind, name: r.designs.find((d) => d.id === first)?.name ?? '' });
  });

  if (!v) return <div className="dz"><div className="bg" />{err && <p className="err dz-err" role="alert">{err}</p>}</div>;
  const cur = v.designs.find((d) => d.id === sel) ?? v.designs[0]!;
  const locked = cur.state === 'locked';
  const anyPaid = v.designs.some((d) => d.full) || v.designs.some((d) => d.state === 'owned' && d.id !== 'nebula');
  const inUse = (me?.design ?? v.current) === cur.id;
  const perShort = v.pro.plan === 'yearly' ? '/yr' : '/mo';

  const use = async (id: string) => {
    setErr(''); setBusy(true);
    try { await api('/designs/use', { body: { design: id } }); await refreshMe(); setV({ ...v, current: id }); }
    catch (x: any) { setErr(x.message); } finally { setBusy(false); }
  };
  const open = (what: Buy) => { setErr(''); setDone(null); setPlan(what); setSheet(what); };
  const pay = async () => {
    setErr(''); setBusy(true);
    try {
      if (plan === 'pro') {
        const r = await api<View>('/designs/pro', { method: 'POST' });
        setV({ ...r, current: v.current }); await refreshMe();
        setDone({ kind: 'pro', name: cur.name }); setSheet(null);
      } else {
        const r = await api<{ url: string }>('/designs/checkout', { body: { what: plan, design: cur.id } });
        location.href = r.url;
        return;
      }
    } catch (x: any) { setErr(x.message); }
    setBusy(false);
  };
  const removePro = async () => {
    setErr(''); setBusy(true);
    try { const r = await api<View>('/designs/pro', { method: 'DELETE' }); setV({ ...r, current: v.current }); await refreshMe(); setRemoving(false); }
    catch (x: any) { setErr(x.message); } finally { setBusy(false); }
  };

  // The sheet's choices: one design or all of today's, or (bundle owners) this new one or all new ones; and Niko Pro.
  const plans: { id: Buy; name: string; note: string; price: string; was?: string; badge?: string }[] = [];
  if (v.bundleOwner) {
    plans.push({ id: 'topup', name: `Add ${cur.name}`, note: cur.back ? 'It came back after you bought your bundle, so it counts as new.' : 'New since your bundle. Owners pay less.', price: money(cur.cents), was: cur.full && cur.full !== cur.cents ? money(cur.full) : undefined, badge: 'Bundle price' });
    if (v.topupAll) plans.push({ id: 'topupall', name: `All ${v.topupAll.count} new designs`, note: 'Everything added since your bundle, including designs that came back.', price: money(v.topupAll.cents), badge: 'Best value' });
  } else {
    plans.push({ id: 'one', name: `${cur.name} only`, note: 'Just this design. Yours to keep.', price: money(cur.cents) });
    if (v.bundle) plans.push({ id: 'all', name: 'All designs', note: `All ${v.bundle.count} designs available today. Yours to keep.`, price: money(v.bundle.cents), badge: 'Best value' });
  }
  if (v.pro.offered && !v.pro.active) plans.push({ id: 'pro', name: 'Niko Pro add-on', note: `Every design${v.proBackgrounds ? ' and background' : ''}, new ones included, added on top of your ${v.pro.plan} plan.`, price: `+${money(v.pro.cents)}${perShort}`, badge: 'Add-on' });
  const chosen = plans.find((p) => p.id === plan) ?? plans[0];
  const bullets: Record<Buy, string[]> = {
    one: ['One-time payment, no subscription.', 'Yours on every device, even if it’s retired later.', 'Switch back to Nebula anytime.'],
    all: ['One payment for every design available today.', 'New designs later: add them for less than their full price.', 'Yours on every device, even if one is retired later.'],
    topup: ['One-time payment, at the bundle’s reduced price.', 'Joins the rest of your designs on every device.', 'Yours to keep, even if it’s retired later.'],
    topupall: ['One payment for every design added since your bundle.', 'Joins the rest of your designs on every device.', 'Yours to keep, even if any are retired later.'],
    pro: ['Added on top of your current plan, billed with it until you remove it.', v.proBackgrounds ? 'Every design and background, including new ones as they arrive.' : 'Every design, including new ones as they arrive.', 'Anything you bought once stays yours if you remove it.'],
  };
  const doneTitle = (b: Bought) => (b.kind === 'pro' ? 'Niko Pro is on' : b.kind === 'all' ? 'Every design is yours' : b.kind === 'topupall' ? 'Your collection is complete' : `${b.name} is yours`);
  const doneLine = (b: Bought) => ({
    one: `${b.name} is unlocked on every device you sign in to. Switch back to Nebula anytime in Settings.`,
    all: 'Every design available today is unlocked on every device you sign in to.',
    topup: `${b.name} joins your designs on every device you sign in to.`,
    topupall: 'Every new design joins your collection on every device you sign in to.',
    pro: `Niko Pro is added to your plan. Every design${v.proBackgrounds ? ' and background' : ''} is yours while it’s on, including new ones as they arrive.`,
  })[b.kind];
  const note = cur.retired && !locked ? 'Paid by you. No longer offered.' : cur.back && locked ? 'Back after a break. It counts as a new design.' : '';

  return (
    <div className="dz">
      <div className="bg" />
      <header className="dz-top">
        <div className="dz-brand"><span className="wordmark">NIKO</span><span className="k">Appearance</span></div>
        <Link to="/appearance" className="ib g dz-x" aria-label="Close"><Icon name="x" size={20} /></Link>
      </header>
      {v.testMode && anyPaid && <p className="dz-test k">Test mode · no real money is charged</p>}
      <main className="dz-main">
        <section className="dz-stage" aria-label="Live preview">
          <div className="dz-core"><DesignPreview key={cur.id} design={cur.id} mode={mode} label={`${cur.name} preview, ${STATES.find((s) => s[0] === mode)![1]}`} /></div>
          <div className="dz-cap">
            <div className="dz-row"><span className="k accent" role="status">{STATES.find((s) => s[0] === mode)![1]}</span>{locked && <span className="dz-tag k">Preview</span>}</div>
            <h1>{cur.name}</h1>
            <p className="sub">{cur.trait}</p>
            {note && <p className="dz-note accent"><Icon name="info" size={16} />{note}</p>}
          </div>
          <div className="dz-pills" role="group" aria-label="Preview state">
            {STATES.map(([m, label]) => <button key={m} type="button" className="map-opt" aria-pressed={mode === m} onClick={() => setMode(m)}>{label}</button>)}
          </div>
        </section>

        <aside className="dz-side">
          <div className="dz-head">
            <h2>Choose your Niko</h2>
            <p className="sub">{anyPaid ? 'Try any design free. Unlock one once and it’s yours on every device.' : 'Change it anytime in Settings.'}</p>
          </div>
          <fieldset className="dz-grid">
            <legend className="sr">Niko appearance</legend>
            {v.designs.map((d) => (
              <label key={d.id} className="dz-opt">
                <input type="radio" name="niko-design" value={d.id} checked={d.id === cur.id} onChange={() => { setSel(d.id); setErr(''); }} />
                <span className={'dz-card' + (d.id === cur.id ? ' on' : '')}>
                  <span className="dz-thumb"><DesignPreview design={d.id} particles={d.id === 'nebula' ? 420 : undefined} /></span>
                  <span className="dz-name">{d.name}</span>
                  <span className={'dz-meta' + (d.state !== 'locked' || d.fresh ? ' accent' : '')}>{d.state === 'locked' && <Icon name="lock" size={11} />}<span>{metaOf(d)}</span></span>
                </span>
              </label>
            ))}
          </fieldset>
          {err && <p className="err" role="alert">{err}</p>}
          {returning === 'confirming' && <p className="sub" role="status">Confirming your payment with Stripe…</p>}
          {returning === 'slow' && <p className="sub" role="status">Stripe hasn’t confirmed the payment yet. It will appear here as soon as it does.</p>}
          {locked ? (
            <div className="dz-acts">
              <button type="button" className="pri accent-bg" disabled={busy} onClick={() => open(v.bundleOwner ? 'topup' : 'one')}><Icon name="lock" size={18} />{v.bundleOwner ? `Add ${cur.name}` : `Unlock ${cur.name}`} · {money(cur.cents)}</button>
              {!v.bundleOwner && v.bundle && <button type="button" className="sec dz-sec" onClick={() => open('all')}>Or unlock all {v.bundle.count} · {money(v.bundle.cents)}</button>}
              {v.bundleOwner && v.topupAll && <button type="button" className="sec dz-sec" onClick={() => open('topupall')}>Or add all {v.topupAll.count} new · {money(v.topupAll.cents)}</button>}
              {v.pro.offered && !v.pro.active && <button type="button" className="dz-link" onClick={() => open('pro')}>{v.proBackgrounds ? 'Or every design and background, new ones too, with the Niko Pro add-on' : 'Or every design, new ones too, with the Niko Pro add-on'}</button>}
            </div>
          ) : (
            <div className="dz-acts">
              <button type="button" className="pri accent-bg" disabled={busy || inUse} onClick={() => use(cur.id)}>{inUse ? `Using ${cur.name}` : `Use ${cur.name}`}</button>
            </div>
          )}
          {v.pro.active && (
            <div className="dz-pro">
              {!removing ? <><span className="sub">Niko Pro is on, added to your plan.</span><button type="button" className="dz-link" onClick={() => setRemoving(true)}>Remove Niko Pro</button></>
                : <><span className="sub">Remove Niko Pro? Anything you bought once stays yours; other designs go back to Nebula{v.proBackgrounds ? ' and other backgrounds to Glow' : ''}. Unused time is credited to your next bill.</span>
                  <span className="dz-row"><button type="button" className="bt" disabled={busy} onClick={removePro}>Remove</button><button type="button" className="bt" onClick={() => setRemoving(false)}>Keep it</button></span></>}
            </div>
          )}
        </aside>
      </main>

      {(sheet || done) && (
        <Sheet onClose={() => { setSheet(null); setDone(null); }} labelledBy="dz-sheet-title">
          <div className="dz-sheet-head">
            <span className="dz-sheet-thumb"><DesignPreview design={cur.id} /></span>
            <div className="dz-sheet-t">
              <span className="k accent">{done ? (done.kind === 'pro' ? 'Add-on active' : 'Unlocked') : v.bundleOwner ? (cur.back ? 'Back as new' : 'New design') : 'Unlock'}</span>
              <h3 id="dz-sheet-title">{done ? doneTitle(done) : cur.name}</h3>
            </div>
            <button type="button" className="ib g" aria-label="Close" onClick={() => { setSheet(null); setDone(null); }}><Icon name="x" size={18} /></button>
          </div>
          {done ? (
            <>
              <p className="sub">{doneLine(done)}</p>
              <div className="dz-acts">
                <button type="button" className="pri accent-bg" disabled={busy} onClick={async () => { await use(cur.id); setDone(null); }}>Use {cur.name} now</button>
                <button type="button" className="sec dz-plain" onClick={() => setDone(null)}>Keep browsing</button>
              </div>
            </>
          ) : chosen && (
            <>
              <fieldset className="dz-plans">
                <legend className="sr">What to unlock</legend>
                {plans.map((p) => (
                  <label key={p.id} className={'dz-plan' + (p.id === chosen.id ? ' on' : '')}>
                    <input type="radio" name="dz-plan" value={p.id} checked={p.id === chosen.id} onChange={() => setPlan(p.id)} />
                    <span className="dz-plan-t"><span className="dz-row"><b>{p.name}</b>{p.badge && <span className="k accent">{p.badge}</span>}</span><span className="sub">{p.note}</span></span>
                    <span className="dz-plan-p"><b>{p.price}</b>{p.was && <s className="sub">{p.was}</s>}</span>
                  </label>
                ))}
              </fieldset>
              <ul className="dz-bul">{bullets[chosen.id].map((t) => <li key={t}><Icon name="check" size={18} />{t}</li>)}</ul>
              {err && <p className="err" role="alert">{err}</p>}
              <div className="dz-acts">
                <button type="button" className="pri accent-bg" disabled={busy} onClick={pay}>{busy ? (chosen.id === 'pro' ? 'Adding…' : 'Opening Stripe…') : chosen.id === 'pro' ? `Add Niko Pro · ${chosen.price}` : `Continue to payment · ${chosen.price}`}</button>
                <button type="button" className="sec dz-plain" onClick={() => setSheet(null)}>Not now</button>
              </div>
              <p className="dz-secure sub"><Icon name="lock" size={14} />{chosen.id === 'pro' ? 'Charged now to the card on your plan, for the rest of this period. Card details never reach Niko.' : 'You’ll pay on Stripe’s secure page, then come straight back.'}</p>
            </>
          )}
        </Sheet>
      )}
    </div>
  );
}

/** A dialog over the page: Escape closes it, focus moves into it and back out when it closes. */
export function Sheet({ children, onClose, labelledBy }: { children: React.ReactNode; onClose: () => void; labelledBy: string }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    box.current?.querySelector<HTMLElement>('input:checked, button.pri, button')?.focus();
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('keydown', key); before?.focus?.(); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="dz-veil" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={box} className="dz-sheet g" role="dialog" aria-modal="true" aria-labelledby={labelledBy}>{children}</div>
    </div>
  );
}
