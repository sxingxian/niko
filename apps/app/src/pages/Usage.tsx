// This month's use, for the Engine and Voice pages: what the plan includes (and how much of it is left), what the
// person's own keys handled (never counted, no cap), and what a service itself reports for a key where it lets apps ask.
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { USAGE_NAMES, USAGE_UNITS, type UsageInfo, type UsageKind } from '@niko/shared';
import { api } from '@niko/ui';

export function useUsage() {
  const [usage, setUsage] = useState<UsageInfo | null>(null);
  const reload = useCallback(async () => { try { setUsage(await api<UsageInfo>('/usage')); } catch { /* the page works without it */ } }, []);
  useEffect(() => { void reload(); }, [reload]);
  return { usage, reload };
}

const n = (v: number) => v.toLocaleString('en');
/** Listening is counted in seconds and shown in minutes. */
const shown = (k: UsageKind, v: number) => (k === 'hear' ? Math.ceil(v / 60) : v);
const unit = (k: UsageKind, v: number) => USAGE_UNITS[k][v === 1 ? 0 : 1];
export function meter(u: UsageInfo, k: UsageKind) {
  const { limit, included, own } = u.kinds[k];
  const used = shown(k, included), ownN = shown(k, own);
  const pct = limit ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  return {
    used, limit, pct, hot: !!limit && pct >= 90, out: !!limit && used >= limit,
    text: limit ? `${n(used)} of ${n(limit)} ${unit(k, limit)}${used >= limit ? ' · used up' : pct >= 90 ? ' · nearly' : ''}` : `${n(used)} ${unit(k, used)} · no limit`,
    own: ownN ? `+ ${n(ownN)} with your own keys · not counted` : '',
  };
}

/** "Your Niko account information": closed, one line; open, what's included, the monthly amounts, own keys, the order. */
export function AccountInfo({ usage }: { usage: UsageInfo }) {
  const [open, setOpen] = useState(false);
  const kinds: UsageKind[] = ['brain', 'voice', 'hear', 'image', 'map'];
  const provided = [...new Set(kinds.flatMap((k) => usage.plan.provided[k] ?? []))];
  const builtins = [usage.plan.builtins.brain || usage.plan.builtins.voice || usage.plan.builtins.hear || usage.plan.builtins.image ? 'Workers AI' : '', usage.plan.builtins.map ? 'OpenStreetMap' : ''].filter(Boolean);
  const own = kinds.flatMap((k) => usage.own[k]);
  const limited = kinds.filter((k) => usage.kinds[k].limit);
  const included = provided.length ? `${listOf(provided)}${builtins.length ? `, and Niko’s built-in services (${builtins.join(', ')})` : ''}` : builtins.length ? `Niko’s built-in services (${builtins.join(', ')})` : 'Nothing; Niko uses your own keys';
  const summary = `${provided.length ? `${listOf(provided)} included` : 'Niko’s built-in services included'}${own.length ? ` · ${own.length} of your own ${own.length === 1 ? 'key' : 'keys'}` : ''} · ${limited.length ? `resets ${usage.resets}` : 'no monthly limit'}`;
  const rows: [string, string][] = [
    ['Included with your plan', included],
    ['Included each month', limited.length ? `${listOf(limited.map((k) => `${n(usage.kinds[k].limit)} ${k === 'hear' ? 'minutes of listening' : USAGE_UNITS[k][1]}`))} · resets ${usage.resets}${limited.length < kinds.length ? ' · no limit on the rest' : ''}` : 'No limit · the counts are just for you to see'],
    ['Your own keys', own.length ? `${own.length} ${own.length === 1 ? 'key' : 'keys'} · never counted, no cap` : 'None yet · add one to any list; it is never counted and has no cap'],
    ['Order', usage.plan.order === 'fixed' && provided.length ? 'Included services first, then your keys' : 'You choose the order of everything here'],
  ];
  return (
    <section className={'g acct-info' + (open ? ' open' : '')} aria-label="Your Niko account information">
      <button type="button" className="acct-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="acct-txt"><b>Your Niko account information</b><span className="sub">{summary}</span></span>
        <span className="sub acct-hint">{open ? 'Hide' : 'Details'}</span>
        <svg className="acct-chev" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
      </button>
      {open && <dl className="acct-rows">{rows.map(([k, v]) => <div key={k}><dt className="k">{k}</dt><dd>{v}</dd></div>)}</dl>}
    </section>
  );
}
const listOf = (l: string[]) => (l.length <= 1 ? l.join('') : `${l.slice(0, -1).join(', ')} and ${l[l.length - 1]}`);

/** "Included this month", for this page's services only, with a link to the other page. */
export function IncludedCard({ usage, kinds, other }: { usage: UsageInfo; kinds: UsageKind[]; other: { to: string; label: string } }) {
  const anyLimit = kinds.some((k) => usage.kinds[k].limit);
  const out = kinds.filter((k) => meter(usage, k).out);
  return (
    <section className="g inc-card" aria-label={anyLimit ? 'Included this month' : 'Your use this month'}>
      <div className="inc-head"><b>{anyLimit ? 'Included this month' : 'Your use this month'}</b>
        <span className="sub">{anyLimit ? `What your plan includes each month · resets ${usage.resets} · your own keys aren’t counted` : `No monthly limit on your plan · shown so you can keep track · resets ${usage.resets}`}</span></div>
      {out.map((k) => <p key={k} className="inc-out" role="status"><b aria-hidden="true">!</b>{outLine(usage, k)}</p>)}
      <div className="inc-meters">
        {kinds.map((k) => {
          const m = meter(usage, k);
          return <div key={k} className={'inc-m' + (m.out ? ' out' : m.hot ? ' hot' : '')}>
            <span className="k">{USAGE_NAMES[k]}</span>
            <span className="inc-big"><b>{n(m.used)}</b><span className="sub">{m.limit ? `of ${n(m.limit)} ${unit(k, m.limit)}` : `${unit(k, m.used)} · no limit`}</span></span>
            {m.limit > 0 && <span className="inc-bar" role="meter" aria-label={`${USAGE_NAMES[k]} used`} aria-valuemin={0} aria-valuemax={m.limit} aria-valuenow={Math.min(m.used, m.limit)}><i style={{ width: `${m.pct}%` }} /></span>}
            {m.own && <span className="sub small">{m.own}</span>}
          </div>;
        })}
      </div>
      <Link className="inc-link" to={other.to}>{other.label} →</Link>
    </section>
  );
}
function outLine(u: UsageInfo, k: UsageKind) {
  const base = `You’ve used this month’s ${n(u.kinds[k].limit)} included ${USAGE_UNITS[k][1]}. `;
  if (u.own[k].length) return `${base}Niko is using your own ${u.own[k].length === 1 ? 'key' : 'keys'} until ${u.resets}.`;
  if (k === 'voice') return `${base}Niko speaks with the on-device voice until ${u.resets}.`;
  if (k === 'hear') return `${base}Niko listens with your device’s own recognition until ${u.resets}.`;
  return `${base}They come back on ${u.resets}. Add your own key to keep going now.`;
}

/** The small "This month" line at the top of a list. */
export function MonthLine({ usage, kind }: { usage: UsageInfo | null; kind: UsageKind }) {
  if (!usage) return null;
  const m = meter(usage, kind);
  return <p className="hint month-line"><span className="k">This month</span> <span className={m.hot ? 'vrow-warn' : ''}>{m.text}</span>{m.own && <span> · {m.own}</span>}</p>;
}

/** Under one service's name: "Included with your plan" or, for an own key, Niko's count and what the service says. */
export function UsageLines({ usage, kind, entry, provided, service }: { usage: UsageInfo | null; kind: UsageKind; entry: string; provided?: boolean; service?: string }) {
  if (!usage) return null;
  const count = shown(kind, usage.entries[`${kind}|${entry}`] ?? 0);
  const out = (provided || entry === 'workers-ai' || entry === 'workers' || entry === 'osm') && meter(usage, kind).out;
  if (provided) return <>
    <span className="sub">Included with your plan · no key to manage · counts towards what’s included</span>
    {out && <span className="sub vrow-warn">This month’s included amount is used up · back on {usage.resets}. Niko skips it until then.</span>}
  </>;
  if (entry === 'workers-ai' || entry === 'workers' || entry === 'osm') return <>
    <span className="sub">{entry === 'osm' ? 'Built in · always last' : 'Built in · no key needed'} · counts towards what’s included</span>
    {out && <span className="sub vrow-warn">This month’s included amount is used up · back on {usage.resets}. Niko skips it until then.</span>}
  </>;
  if (entry.startsWith('self-hosted')) return null;
  const r = usage.reports[entry];
  return <>
    <span className="sub">Niko counted {n(count)} {unit(kind, count)} this month · not counted, no cap</span>
    {r ? <span className="prov"><span className="sub">{r.head} · checked {ago(r.at)}</span>{typeof r.pct === 'number' && <span className="inc-bar sm" aria-hidden="true"><i style={{ width: `${r.pct}%` }} /></span>}<span className="sub small">{r.sub}</span></span>
      : service ? <span className="sub small">{service} doesn’t share usage with apps · see your {service} account for spend</span> : null}
  </>;
}
const ago = (at: number) => { const m = Math.round((Date.now() - at) / 60000); return m < 1 ? 'just now' : `${m} min ago`; };
