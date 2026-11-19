// When someone's paid (or free, or unlocked) time has ended: choose a monthly or yearly plan to keep going.
// Also the Billing card in Account, where a plan can be chosen ahead of time and Stripe's billing page opened.
import { useEffect, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, Icon } from '@niko/ui';
import { money, type AccessInfo, type Plan } from '@niko/shared';
import { useNiko } from '../niko';
import { Shell, TestNote } from './Auth';
import { voiceForgetAll } from '../voiceMatch';

const fmtDate = (d: string | null | undefined) => (d ? new Date(d).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '');
const per = (p: Plan) => (p === 'monthly' ? '/ month' : '/ year');

/** Returning from Stripe with ?plan=<checkout id>: asks the server (which asks Stripe) until the plan is on. */
function usePlanReturn(onDone: (a: AccessInfo) => void, enabled = true) {
  const [params, setParams] = useSearchParams();
  const plan = enabled ? params.get('plan') : null;
  const [state, setState] = useState<'idle' | 'confirming' | 'slow' | 'cancelled'>(plan === 'cancelled' ? 'cancelled' : plan ? 'confirming' : 'idle');
  useEffect(() => {
    if (plan === 'cancelled') { setParams({}, { replace: true }); return; }
    if (!plan) return;
    let stop = false;
    let tries = 0;
    const tick = async () => {
      if (stop) return;
      tries++;
      const a = await api<AccessInfo>(`/billing/status?session=${encodeURIComponent(plan)}`).catch(() => null);
      if (stop) return;
      if (a && a.sub && ['active', 'trialing'].includes(a.sub.status)) { setParams({}, { replace: true }); setState('idle'); onDone(a); return; }
      if (tries >= 30) { setState('slow'); return; }
      window.setTimeout(tick, tries < 5 ? 1500 : 3000);
    };
    void tick();
    return () => { stop = true; };
  }, [plan]); // eslint-disable-line react-hooks/exhaustive-deps
  return state;
}

function PlanChoice({ access, pick, setPick }: { access: AccessInfo; pick: Plan; setPick: (p: Plan) => void }) {
  return (
    <fieldset className="plans">
      <legend className="k">Plan</legend>
      {access.plans.map((p) => (
        <label key={p.plan} className={'plan-opt' + (pick === p.plan ? ' on' : '')}>
          <input type="radio" name="plan" value={p.plan} checked={pick === p.plan} onChange={() => setPick(p.plan)} />
          <span className="plan-txt"><b>{p.plan === 'monthly' ? 'Monthly' : 'Yearly'}</b><span className="sub">{p.plan === 'monthly' ? 'Renews every month' : 'Renews every year'}</span></span>
          <span className="plan-price"><b>{money(p.cents)}</b><span className="sub">{per(p.plan)}</span></span>
        </label>
      ))}
    </fieldset>
  );
}

async function checkout(plan: Plan, setErr: (s: string) => void, from?: 'account') {
  try { const r = await api<{ url: string }>('/billing/checkout', { body: { plan, from } }); location.href = r.url; } catch (x: any) { setErr(x.message); }
}

/** Shown instead of Niko when the account has no time left. */
export function PlanGate({ children }: { children: ReactNode }) {
  const { me, refreshMe } = useNiko();
  const access = me?.access;
  const [pick, setPick] = useState<Plan>('monthly');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const ret = usePlanReturn(() => setDone(true), !!access && !access.has);
  useEffect(() => { if (access?.plans.length && !access.plans.some((p) => p.plan === pick)) setPick(access.plans[0]!.plan); }, [access]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!access || (access.has && !done)) return <>{children}</>;
  const signOut = async () => { await api('/auth/sign-out', { method: 'POST' }).catch(() => undefined); await voiceForgetAll(); await refreshMe(); };
  if (done) {
    return (
      <><div className="bg" /><Shell tag="Good to have you." label="Subscribed">
        <div className="hd"><Icon name="check" size={40} /><h1>Subscription active</h1><p className="sub">Your receipt is on its way by email. Manage or cancel any time in Account.</p></div>
        <button type="button" className="pri" onClick={async () => { await refreshMe(); setDone(false); }}>Back to Niko</button>
      </Shell></>
    );
  }
  if (ret === 'confirming' || ret === 'slow') {
    return (
      <><div className="bg" /><Shell tag="One moment." label="Confirming" mode="thinking">
        <div className="hd"><h1>Confirming your payment</h1><p className="sub">Back from Stripe. Waiting for Stripe to confirm with Niko, usually a few seconds.</p></div>
        <div role="progressbar" aria-label="Confirming payment" className="waitbar"><span /></div>
        <p className="sub small">{ret === 'slow' ? 'Stripe hasn’t confirmed it yet. If you paid, it’s safe: reload this page in a minute.' : 'You can close this page. Niko opens as soon as Stripe confirms.'}</p>
      </Shell></>
    );
  }
  const offer = access.plans.find((p) => p.plan === pick) ?? access.plans[0];
  return (
    <><div className="bg" /><Shell tag="Welcome back." label="Time ended">
      <div className="hd">
        <h1>Your time with Niko has ended</h1>
        <p className="sub">Thanks for using Niko since {fmtDate(access.since)}. {access.plans.length > 1 ? 'Choose a plan to keep going.' : access.plans.length ? 'Subscribe to keep going.' : ''} Everything is kept as you left it.</p>
      </div>
      {ret === 'cancelled' && <p className="ok" role="status">Payment cancelled. Nothing was charged.</p>}
      {err && <p className="err" role="alert">{err}</p>}
      {access.plans.length && access.payments ? <>
        {access.testMode && <TestNote />}
        <PlanChoice access={access} pick={offer!.plan} setPick={setPick} />
        <button type="button" className="pri" disabled={busy} onClick={async () => { setBusy(true); await checkout(offer!.plan, setErr); setBusy(false); }}>
          <Icon name="lock" size={18} />{busy ? 'Opening Stripe…' : `Subscribe · ${money(offer!.cents)} ${per(offer!.plan)}`}
        </button>
        <p className="sub small">Renews every {offer!.plan === 'monthly' ? 'month' : 'year'} until you cancel in Account. You keep access to the end of the paid {offer!.plan === 'monthly' ? 'month' : 'year'}. You’ll pay on Stripe’s secure page.</p>
      </> : <p className="sub">Plans aren’t available right now. Try again later.</p>}
      <button type="button" className="lnk" style={{ alignSelf: 'flex-start' }} onClick={signOut}>Sign out</button>
    </Shell></>
  );
}

/** Account → Billing: what you have, choosing a plan ahead of time, and Stripe's page to change the card or cancel. */
export function BillingCard() {
  const { me, refreshMe } = useNiko();
  const a = me?.access;
  const [pick, setPick] = useState<Plan>('monthly');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  usePlanReturn(() => { setNote('Plan chosen. Billing starts when your current time ends.'); void refreshMe(); });
  useEffect(() => { if (a?.plans.length && !a.plans.some((p) => p.plan === pick)) setPick(a.plans[0]!.plan); }, [a]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!a) return null;
  const portal = async () => { setErr(''); setBusy(true); try { const r = await api<{ url: string }>('/billing/portal', { method: 'POST' }); location.href = r.url; } catch (x: any) { setErr(x.message); setBusy(false); } };
  const sub = a.sub && ['active', 'trialing', 'past_due', 'unpaid'].includes(a.sub.status) ? a.sub : null;
  const status = a.kind === 'admin' ? 'Admins don’t need a plan.'
    : a.kind === 'life' ? 'Lifetime. There’s nothing to pay.'
    : sub ? `${sub.plan === 'yearly' ? 'Yearly' : 'Monthly'} plan · ${sub.status === 'trialing' ? `billing starts ${fmtDate(sub.periodEnd)}` : sub.cancelAtEnd ? `ends ${fmtDate(sub.periodEnd)}` : sub.status === 'active' ? `renews ${fmtDate(sub.periodEnd)}` : `payment failed: update your card by ${fmtDate(a.until)}`}`
    : a.kind === 'free' ? `Free until ${fmtDate(a.until)}.`
    : a.kind === 'unlocked' ? `Unlocked until ${fmtDate(a.until)}.`
    : a.kind === 'paid' ? `Paid until ${fmtDate(a.until)}.` : 'No time left.';
  const offer = a.plans.find((p) => p.plan === pick) ?? a.plans[0];
  const canChoose = !sub && !a.lifetime && a.kind !== 'admin' && a.payments && a.plans.length > 0;
  return (
    <section className="set-card" aria-label="Billing">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}><span className="k">Billing</span><span className="hint">Payments run on Stripe</span></div>
      {note && <p className="ok" role="status">{note}</p>}
      {err && <p className="err" role="alert">{err}</p>}
      <div className="row"><Icon name="shield" /><span className="txt"><b>{status}</b>{a.until && !sub && !a.lifetime && a.kind !== 'admin' ? <span className="sub">Nothing renews by itself.</span> : null}</span></div>
      {canChoose && offer && <>
        {a.testMode && <TestNote />}
        <p className="sub">{a.until && Date.parse(a.until) - Date.now() > 2 * 86400_000 + 3600_000 ? 'Choose a plan now and billing starts when your current time ends, so you never lose a day.' : 'Your time ends within two days, so billing for a plan starts right away.'}</p>
        <PlanChoice access={a} pick={offer.plan} setPick={setPick} />
        <button className="pri" style={{ alignSelf: 'flex-start' }} disabled={busy} onClick={async () => { setBusy(true); await checkout(offer.plan, setErr, 'account'); setBusy(false); }}>{busy ? 'Opening Stripe…' : `Choose ${offer.plan === 'monthly' ? 'monthly' : 'yearly'} · ${money(offer.cents)} ${per(offer.plan)}`}</button>
      </>}
      {a.portal && <button className="bt" style={{ alignSelf: 'flex-start' }} disabled={busy} onClick={portal}>Manage card, receipts or cancel</button>}
    </section>
  );
}
