// The weather card on Home (Weather-Card mockup, B): now, the high and low and rain at a glance, one short tip, the
// next hours with how likely rain is in each, and three days. Niko says the full answer; the card shows the numbers.
import { Icon } from '@niko/ui';
import type { WeatherCard as Card, WeatherIcon } from '@niko/shared';

const SKY: Record<WeatherIcon, string> = {
  clear: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M4.6 4.6l1.4 1.4M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4L6 18M18 6l1.4-1.4"/>',
  partly: '<path d="M12 3v1.5M5.6 5.6l1 1M3 12h1.5M18.4 5.6l-1 1"/><path d="M8.5 11a4 4 0 0 1 7.6-1.4"/><path d="M9 20a3.5 3.5 0 0 1-.5-6.96A4.8 4.8 0 0 1 17.6 12 3.5 3.5 0 0 1 18 19.97V20z"/>',
  cloudy: '<path d="M7 18a4 4 0 0 1-.6-7.96A5.5 5.5 0 0 1 17 9a4 4 0 0 1 1 7.87V18z"/>',
  fog: '<path d="M7 13a4 4 0 0 1-.6-7.96A5.5 5.5 0 0 1 17 4a4 4 0 0 1 1 7.87"/><path d="M4 16h16M6 19.5h12"/>',
  drizzle: '<path d="M7 15a4 4 0 0 1-.6-7.96A5.5 5.5 0 0 1 17 6a4 4 0 0 1 1 7.87"/><path d="M9 18.5v.5M13 18.5v.5M17 18.5v.5"/>',
  rain: '<path d="M7 15a4 4 0 0 1-.6-7.96A5.5 5.5 0 0 1 17 6a4 4 0 0 1 1 7.87"/><path d="M8 18l-1 2.5M12 18l-1 2.5M16 18l-1 2.5"/>',
  showers: '<path d="M10 4.5a4 4 0 0 1 7.5 1.6"/><path d="M7 15a4 4 0 0 1-.6-7.96A5.5 5.5 0 0 1 17 6a4 4 0 0 1 1 7.87"/><path d="M8 18l-1 2.5M12 18l-1 2.5M16 18l-1 2.5"/>',
  snow: '<path d="M7 14a4 4 0 0 1-.6-7.96A5.5 5.5 0 0 1 17 5a4 4 0 0 1 1 7.87"/><path d="M8 17.5h.01M12 19h.01M16 17.5h.01M10 21h.01M14 21h.01"/>',
  storm: '<path d="M7 16a4 4 0 0 1-.6-7.96A5.5 5.5 0 0 1 17 7a4 4 0 0 1 1 7.87"/><path d="M12.5 13l-2 3.5h3l-2 3.5"/>',
};
function Sky({ icon, size, label }: { icon: WeatherIcon; size: number; label?: string }) {
  return <svg className="ic wx-sky" viewBox="0 0 24 24" style={{ width: size, height: size }} role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true} dangerouslySetInnerHTML={{ __html: SKY[icon] ?? SKY.cloudy }} />;
}
const Drop = ({ size = 12 }: { size?: number }) => <svg className="ic" viewBox="0 0 24 24" style={{ width: size, height: size }} aria-hidden="true"><path d="M12 3s6 6.4 6 10.5a6 6 0 0 1-12 0C6 9.4 12 3 12 3z" /></svg>;
const t = (v: number | null) => (v === null ? '–' : `${v}°`);
const pct = (v: number | null) => (v === null ? '–' : `${v}%`);

export function WeatherCard({ card, onClose, tabbable }: { card: Card; onClose: () => void; tabbable?: boolean }) {
  const tab = tabbable ? 0 : -1;
  const rain = card.today.rain;
  const rainLine = rain === null ? '' : rain >= 70 ? `Rain likely · ${rain}%` : rain >= 30 ? `Some rain · ${rain}%` : `Little rain · ${rain}%`;
  return (
    <section className="g wx" aria-label={`Weather in ${card.place}`}>
      <div className="wx-head">
        <span className="k wx-place"><Icon name="pin" size={14} />Weather · {card.place}</span>
        <button className="ib" style={{ width: 40, height: 40, margin: '-8px -8px -8px 0' }} onClick={onClose} aria-label="Hide the weather" tabIndex={tab}><Icon name="x" size={18} /></button>
      </div>
      <div className="wx-now">
        <Sky icon={card.now.icon} size={64} label={card.now.sky} />
        <span className="wx-temp">{t(card.now.temp)}</span>
        <span className="wx-facts">
          <b>{card.now.sky}</b>
          <span>H {t(card.today.hi)} · L {t(card.today.lo)}{card.now.feels !== null && <span className="wx-feels"> · Feels {t(card.now.feels)}</span>}</span>
          {rainLine && <span className="wx-rain"><Drop size={13} />{rainLine}</span>}
        </span>
      </div>
      {card.tip && <p className="wx-tip">{card.tip}</p>}
      {card.hours.length > 1 && (
        <div className="wx-block">
          <span className="k wx-sub">Next hours · chance of rain</span>
          <ol className="wx-hours">
            {card.hours.map((h, i) => (
              <li key={i} aria-label={`${h.label}: ${t(h.temp)}, ${pct(h.rain)} chance of rain`}>
                <span className="wx-h-temp">{t(h.temp)}</span>
                <span className="wx-bar" aria-hidden="true"><i style={{ height: `${Math.max(0, Math.min(100, h.rain ?? 0))}%` }} /></span>
                <span className="wx-h-rain">{pct(h.rain)}</span>
                <span className="k wx-h-at">{h.label}</span>
              </li>
            ))}
          </ol>
        </div>
      )}
      {card.days.length > 0 && (
        <ol className="wx-days">
          {card.days.map((d, i) => (
            <li key={i} aria-label={`${d.label}: high ${t(d.hi)}, low ${t(d.lo)}, ${pct(d.rain)} chance of rain`}>
              <span className="k">{d.label}</span>
              <Sky icon={d.icon} size={26} />
              <span className="wx-d-t"><b>{t(d.hi)}</b> <span>{t(d.lo)}</span></span>
              <span className="wx-rain"><Drop />{pct(d.rain)}</span>
            </li>
          ))}
        </ol>
      )}
      <span className="wx-credit">Open-Meteo</span>
    </section>
  );
}
