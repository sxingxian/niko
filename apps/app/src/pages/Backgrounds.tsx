// Choose a background: every background the account can see, live behind its own Niko. Any background can be
// previewed in each state for free; paid ones unlock once (or all at once), bundle owners add new ones at a pro-rated
// price, and on an active monthly or yearly plan Niko Pro (one add-on with designs) gives every background. The server
// works out every price and checks every choice.
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, BackgroundPreview, DesignPreview, Icon, type CoreMode } from '@niko/ui';
import { money, type BackgroundOffer, type BackgroundsView } from '@niko/shared';
import { useNiko } from '../niko';
import { Sheet } from './Designs';

type View = BackgroundsView & { current: string; payments: boolean; testMode: boolean };
type Buy = 'one' | 'all' | 'topup' | 'topupall' | 'pro';
type Bought = { kind: Buy; name: string };
type Returned = View & { paid: boolean; bought: { kind: Buy; backgrounds: string[] } | null };

const STATES: [CoreMode, string][] = [['idle', 'Standing by'], ['listening', 'Listening'], ['thinking', 'Thinking'], ['speaking', 'Speaking']];

function metaOf(d: BackgroundOffer): string {
  if (d.state === 'included') return 'Included';
  if (d.state === 'owned') return d.retired ? 'Retired · yours' : 'Yours';
  if (d.state === 'pro') return 'With Pro';
  if (d.back) return 'Back · new';
  if (d.fresh) return 'New';
  return d.cents ? money(d.cents) : '';
}

/** Returning from Stripe with ?bought=<checkout id>: asks the server (which asks Stripe) until the payment counts. */
function useReturn(onPaid: (v: Returned) => void) {
  const [params, setParams] = useSearchParams();
  const id = params.get('bought');
  const [state, setState] = useState<'idle' | 'confirming' | 'slow'>(id && id !== 'cancelled' ? 'confirming' : 'idle');
  useEffect(() => {
    if (id === 'cancelled') { setParams({}, { replace: true }); return; }
    if (!id) return;
    let stop = false, tries = 0;
    const tick = async () => {
      if (stop) return;
      tries++;
      const r = await api<Returned>(`/backgrounds/status?session=${encodeURIComponent(id)}`).catch(() => null);
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

export function Backgrounds() {
  const { me, refreshMe } = useNiko();
  const [v, setV] = useState<View | null>(null);
  const [sel, setSel] = useState<string>('');
  const [mode, setMode] = useState<CoreMode>('idle');
  const [sheet, setSheet] = useState<Buy | null>(null);
  const [plan, setPlan] = useState<Buy>('one');
  const [done, setDone] = useState<Bought | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const load = async () => { const r = await api<View>('/backgrounds'); setV(r); setSel((s) => s || r.current); return r; };
  useEffect(() => { void load().catch((x) => setErr(x.message)); }, []);
  const returning = useReturn((r) => {
    setV(r);
    const first = r.bought?.backgrounds[0];
    if (first) setSel(r.bought!.kind === 'one' || r.bought!.kind === 'topup' ? first : sel || first);
    if (r.bought) setDone({ kind: r.bought.kind, name: r.backgrounds.find((d) => d.id === first)?.name ?? '' });
  });

  if (!v) return <div className="dz"><div className="bg" />{err && <p className="err dz-err" role="alert">{err}</p>}</div>;
  const cur = v.backgrounds.find((d) => d.id === sel) ?? v.backgrounds[0]!;
  const locked = cur.state === 'locked';
  const anyPaid = v.backgrounds.some((d) => d.full) || v.backgrounds.some((d) => d.state === 'owned' && d.id !== 'glow');
  const inUse = (me?.background ?? v.current) === cur.id;
  const perShort = v.pro.plan === 'yearly' ? '/yr' : '/mo';
  const stateLabel = STATES.find((s) => s[0] === mode)![1];

  const use = async (id: string) => {
    setErr(''); setBusy(true);
    try { await api('/backgrounds/use', { body: { background: id } }); await refreshMe(); setV({ ...v, current: id }); }
    catch (x: any) { setErr(x.message); } finally { setBusy(false); }
  };
  const open = (what: Buy) => { setErr(''); setDone(null); setPlan(what); setSheet(what); };
  const pay = async () => {
    setErr(''); setBusy(true);
    try {
      if (plan === 'pro') {
        // One add-on for designs and backgrounds, added where designs add it.
        await api('/designs/pro', { method: 'POST' });
        await load(); await refreshMe();
        setDone({ kind: 'pro', name: cur.name }); setSheet(null);
      } else {
        const r = await api<{ url: string }>('/backgrounds/checkout', { body: { what: plan, background: cur.id } });
        location.href = r.url;
        return;
      }
    } catch (x: any) { setErr(x.message); }
    setBusy(false);
  };

  const plans: { id: Buy; name: string; note: string; price: string; was?: string; badge?: string }[] = [];
  if (v.bundleOwner) {
    plans.push({ id: 'topup', name: `Add ${cur.name}`, note: cur.back ? 'It came back after you bought your bundle, so it counts as new.' : 'New since your bundle. Owners pay less.', price: money(cur.cents), was: cur.full && cur.full !== cur.cents ? money(cur.full) : undefined, badge: 'Bundle price' });
    if (v.topupAll) plans.push({ id: 'topupall', name: `All ${v.topupAll.count} new backgrounds`, note: 'Everything added since your bundle, including backgrounds that came back.', price: money(v.topupAll.cents), badge: 'Best value' });
  } else {
    plans.push({ id: 'one', name: `${cur.name} only`, note: 'Just this background. Yours to keep.', price: money(cur.cents) });
    if (v.bundle) plans.push({ id: 'all', name: 'All backgrounds', note: `All ${v.bundle.count} backgrounds available today. Yours to keep.`, price: money(v.bundle.cents), badge: 'Best value' });
  }
  if (v.pro.offered) plans.push({ id: 'pro', name: 'Niko Pro add-on', note: `Every background and design, new ones included, added on top of your ${v.pro.plan} plan.`, price: `+${money(v.pro.cents)}${perShort}`, badge: 'Add-on' });
  const chosen = plans.find((p) => p.id === plan) ?? plans[0];
  const bullets: Record<Buy, string[]> = {
    one: ['One-time payment, no subscription.', 'Yours on every device, even if it’s retired later.', 'Switch back to Glow anytime.'],
    all: ['One payment for every background available today.', 'New backgrounds later: add them for less than their full price.', 'Yours on every device, even if one is retired later.'],
    topup: ['One-time payment, at the bundle’s reduced price.', 'Joins the rest of your backgrounds on every device.', 'Yours to keep, even if it’s retired later.'],
    topupall: ['One payment for every background added since your bundle.', 'Joins the rest of your backgrounds on every device.', 'Yours to keep, even if any are retired later.'],
    pro: ['Added on top of your current plan, billed with it until you remove it.', 'Every background and design, including new ones as they arrive.', 'Anything you bought once stays yours if you remove it.'],
  };
  const doneTitle = (b: Bought) => (b.kind === 'pro' ? 'Niko Pro is on' : b.kind === 'all' ? 'Every background is yours' : b.kind === 'topupall' ? 'Your collection is complete' : `${b.name} is yours`);
  const doneLine = (b: Bought) => ({
    one: `${b.name} is unlocked on every device you sign in to. Switch back to Glow anytime in Settings.`,
    all: 'Every background available today is unlocked on every device you sign in to.',
    topup: `${b.name} joins your backgrounds on every device you sign in to.`,
    topupall: 'Every new background joins your collection on every device you sign in to.',
    pro: 'Niko Pro is added to your plan. Every background and design is yours while it’s on, including new ones as they arrive.',
  })[b.kind];
  const note = cur.retired && !locked ? 'Paid by you. No longer offered.' : cur.back && locked ? 'Back after a break. It counts as a new background.' : '';
  const close = () => { setSheet(null); setDone(null); };

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
          <div className="bz-frame">
            <BackgroundPreview key={cur.id} background={cur.id} mode={mode} label={`Niko on the ${cur.name} background, ${stateLabel}`} />
            <div className="bz-core"><DesignPreview design={me?.design ?? 'nebula'} mode={mode} particles={!me?.design || me.design === 'nebula' ? 700 : undefined} /></div>
          </div>
          <div className="dz-cap bz-cap">
            <div className="dz-row"><span className="k accent" role="status">{stateLabel}</span>{locked && <span className="dz-tag k">Preview</span>}</div>
            <h1>{cur.name}</h1>
            <p className="sub">{cur.note}</p>
            {note && <p className="dz-note accent"><Icon name="info" size={16} />{note}</p>}
          </div>
          <div className="dz-pills" role="group" aria-label="Preview state">
            {STATES.map(([m, label]) => <button key={m} type="button" className="map-opt" aria-pressed={mode === m} onClick={() => setMode(m)}>{label}</button>)}
          </div>
        </section>

        <aside className="dz-side">
          <div className="dz-head">
            <h2>Choose a background</h2>
            <p className="sub">{anyPaid ? 'Try any background free. Unlock one once and it’s yours on every device.' : 'Change it anytime in Settings.'}</p>
          </div>
          <fieldset className="dz-grid bz-grid">
            <legend className="sr">Background</legend>
            {v.backgrounds.map((d) => (
              <label key={d.id} className="dz-opt">
                <input type="radio" name="niko-background" value={d.id} checked={d.id === cur.id} onChange={() => { setSel(d.id); setErr(''); }} />
                <span className={'dz-card' + (d.id === cur.id ? ' on' : '')}>
                  <span className="dz-thumb wide"><BackgroundPreview background={d.id} paused={d.id !== cur.id} /></span>
                  <span className="dz-name">{d.name}</span>
                  <span className={'dz-meta' + (d.state !== 'locked' || d.fresh ? ' accent' : '')}>{d.state === 'locked' && <Icon name="lock" size={11} />}<span>{metaOf(d)}</span></span>
                </span>
              </label>
            ))}
          </fieldset>
          {err && !sheet && <p className="err" role="alert">{err}</p>}
          {returning === 'confirming' && <p className="sub" role="status">Confirming your payment with Stripe…</p>}
          {returning === 'slow' && <p className="sub" role="status">Stripe hasn’t confirmed the payment yet. It will appear here as soon as it does.</p>}
          {locked ? (
            <div className="dz-acts">
              {cur.cents ? <button type="button" className="pri accent-bg" disabled={busy || !v.payments} onClick={() => open(v.bundleOwner ? 'topup' : 'one')}><Icon name="lock" size={18} />{v.bundleOwner ? `Add ${cur.name}` : `Unlock ${cur.name}`} · {money(cur.cents)}</button> : null}
              {!v.bundleOwner && v.bundle && <button type="button" className="sec dz-sec" disabled={!v.payments} onClick={() => open('all')}>Or unlock all {v.bundle.count} · {money(v.bundle.cents)}</button>}
              {v.bundleOwner && v.topupAll && <button type="button" className="sec dz-sec" disabled={!v.payments} onClick={() => open('topupall')}>Or add all {v.topupAll.count} new · {money(v.topupAll.cents)}</button>}
              {v.pro.offered && <button type="button" className="dz-link" onClick={() => open('pro')}>Or every background and design, new ones too, with the Niko Pro add-on</button>}
              {!v.payments && <p className="sub">Payments aren’t open right now. You can still preview every background.</p>}
            </div>
          ) : (
            <div className="dz-acts">
              <button type="button" className="pri accent-bg" disabled={busy || inUse} onClick={() => use(cur.id)}>{inUse ? `Using ${cur.name}` : `Use ${cur.name}`}</button>
            </div>
          )}
          {v.pro.active && v.pro.covers && <p className="sub dz-pro">Niko Pro is on: every background is yours while it’s on. Manage it in Choose your Niko.</p>}
        </aside>
      </main>

      {(sheet || done) && (
        <Sheet onClose={close} labelledBy="bz-sheet-title">
          <div className="dz-sheet-head">
            <span className="dz-sheet-thumb wide"><BackgroundPreview background={cur.id} /></span>
            <div className="dz-sheet-t">
              <span className="k accent">{done ? (done.kind === 'pro' ? 'Add-on active' : 'Unlocked') : v.bundleOwner ? (cur.back ? 'Back as new' : 'New background') : 'Unlock'}</span>
              <h3 id="bz-sheet-title">{done ? doneTitle(done) : cur.name}</h3>
            </div>
            <button type="button" className="ib g" aria-label="Close" onClick={close}><Icon name="x" size={18} /></button>
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
                    <input type="radio" name="bz-plan" value={p.id} checked={p.id === chosen.id} onChange={() => setPlan(p.id)} />
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
