import { StrictMode, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { appBase } from '@niko/ui';
import '@niko/ui/src/styles.css';
import './app.css';
import { NikoProvider, useNiko } from './niko';
import { Awake } from './awake';
import { FLOW_SECONDS, FlowLayer, LEAVE_MS } from './flow';
import { Forgot, Invite, Reset, SignIn, SignUp } from './pages/Auth';
import { PlanGate } from './pages/Plan';
import { Home, Workspace } from './pages/Core';
import { Designs } from './pages/Designs';
import { Backgrounds } from './pages/Backgrounds';
import { Account, Appearance, Connections, Engine, SettingsLayout, Voice } from './pages/Settings';
import { DataSources } from './pages/DataSources';
import { Weather } from './pages/WeatherSettings';
import { Knowledge } from './pages/Knowledge';

function Private({ children }: { children: ReactNode }) {
  const { me, locked } = useNiko();
  const { pathname } = useLocation();
  if (me === undefined) return <div className="bg" />;
  if (!me) return <Navigate to="/sign-in" replace />;
  // Locked: only Home (with the lock on it). The server refuses everything else anyway.
  if (locked && pathname !== '/') return <Navigate to="/" replace />;
  return <PlanGate>{children}</PlanGate>;
}
function Public({ children }: { children: ReactNode }) {
  const { me } = useNiko();
  if (me === undefined) return <div className="bg" />;
  return me ? <Navigate to="/" replace /> : <><div className="bg" />{children}</>;
}

const SETTINGS_PATHS = ['/appearance', '/voice', '/connections', '/engine', '/account'];
const WORKSPACE_PATHS = ['/inbox', '/calendar', '/notes'];

/** HUD sweep on every screen change: a ring opens from the centre, a scan line passes, the corners lock on.
 * Purely decorative (aria-hidden, no pointer events) and skipped when reduced motion is asked for.
 * Not used between Home and the workspace, which have their own particle flow. */
function HudSweep({ screen, skip }: { screen: string; skip: boolean }) {
  const [n, setN] = useState(0);
  const first = useRef(true);
  useEffect(() => { if (first.current) { first.current = false; return; } if (!skip) setN((x) => x + 1); }, [screen]); // eslint-disable-line react-hooks/exhaustive-deps
  // Taken off once it has played, so nothing sits over the page.
  useEffect(() => { if (!n) return; const t = window.setTimeout(() => setN(0), 900); return () => window.clearTimeout(t); }, [n]);
  if (n === 0) return null;
  return (
    <div key={n} className="hud-sweep" aria-hidden="true">
      <i className="hud-ring" /><i className="hud-scan" />
      <i className="hud-corner tl" /><i className="hud-corner tr" /><i className="hud-corner bl" /><i className="hud-corner br" />
    </div>
  );
}

const groupOf = (p: string) => (SETTINGS_PATHS.includes(p) ? 'settings' : p);
const HUD_OUT_MS = 140;
const kindOf = (p: string) => (p === '/' ? 'home' : WORKSPACE_PATHS.includes(p) ? 'ws' : 'other');
const reduced = () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function Screens() {
  const loc = useLocation();
  const { me } = useNiko();
  // The screen on display can lag the address for a moment: between Home and the workspace the old screen
  // fades out while the particles start to flow, then the new one is mounted and builds itself in.
  const [shown, setShown] = useState(loc);
  const [flow, setFlow] = useState<{ dir: 'in' | 'out' | 'swap'; at: number; loose?: boolean } | null>(null);
  const [leaving, setLeaving] = useState(false);
  useEffect(() => {
    if (loc.pathname === shown.pathname) { setShown(loc); return; }
    const a = kindOf(shown.pathname), b = kindOf(loc.pathname);
    // Between Inbox, Calendar and Notes the ring breaks up and is rebuilt, the same build as arriving from Home.
    if (!reduced() && (a === 'ws' || b === 'ws') && (a === 'home' || b === 'home' || a === b)) {
      const now = performance.now();
      // If the last build is still under way, its particles are still loose, so the next one starts from the cloud.
      setFlow((f) => ({ dir: a === b ? 'swap' : b === 'ws' ? 'in' : 'out', at: now, loose: !!f && now - f.at < FLOW_SECONDS * 800 }));
      setLeaving(true);
      const t = window.setTimeout(() => { setLeaving(false); setShown(loc); }, LEAVE_MS);
      return () => window.clearTimeout(t);
    }
    setFlow(null);
    // Any other change of screen: the old one fades out quickly, then the new one builds in. Moving between
    // settings pages keeps the sidebar, so only the page content changes there, with no fade-out.
    if (!reduced() && groupOf(shown.pathname) !== groupOf(loc.pathname)) {
      setLeaving(true);
      const t = window.setTimeout(() => { setLeaving(false); setShown(loc); }, HUD_OUT_MS);
      return () => window.clearTimeout(t);
    }
    setLeaving(false);
    setShown(loc);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loc]);
  // Settings keep their sidebar, so those pages animate inside it, not as a whole screen.
  // Each workspace view is its own screen, so the build replays when moving between them.
  const group = groupOf(shown.pathname);
  const flowing = !!flow;
  // How a screen arrives is fixed when it mounts, so the end of the flow never restarts an entrance animation.
  const entry = useMemo(() => (!flow ? 'hud-in' : flow.dir === 'swap' ? 'flow flow-in swap' : 'flow flow-' + flow.dir), [group]); // eslint-disable-line react-hooks/exhaustive-deps
  // Once the flow has finished, its arrival styles come off, so they never hold back later animations on that screen.
  const [settled, setSettled] = useState<string | null>(null);
  const groupNow = useRef(group);
  groupNow.current = group;
  const cls = 'route ' + (leaving ? (!flow ? 'hud-out' : flow.dir === 'swap' ? 'leaving swap' : 'leaving') : settled === group && entry !== 'hud-in' ? '' : entry);
  const vars = { ['--D' as string]: FLOW_SECONDS + 's', ['--el' as string]: LEAVE_MS / 1000 + 's' } as CSSProperties;
  return (
    <>
      <div key={group} className={cls} style={vars}>
      <Routes location={shown}>
        <Route path="/sign-in" element={<Public><SignIn /></Public>} />
        <Route path="/invite" element={<Public><Invite /></Public>} />
        <Route path="/sign-up" element={<Public><SignUp /></Public>} />
        <Route path="/forgot" element={<Public><Forgot /></Public>} />
        <Route path="/reset" element={<Public><Reset /></Public>} />
        <Route path="/" element={<Private><Home /></Private>} />
        {['/inbox', '/calendar', '/notes'].map((p) => <Route key={p} path={p} element={<Private><Workspace /></Private>} />)}
        <Route path="/niko" element={<Private><Designs /></Private>} />
        <Route path="/backgrounds" element={<Private><Backgrounds /></Private>} />
        <Route element={<Private><SettingsLayout /></Private>}>
          <Route path="/appearance" element={<Appearance />} />
          <Route path="/voice" element={<Voice />} />
          <Route path="/connections" element={<Connections />} />
          <Route path="/connections/weather" element={<Weather />} />
          <Route path="/engine" element={<Engine />} />
          <Route path="/engine/data" element={<DataSources />} />
          <Route path="/knowledge" element={<Knowledge />} />
          <Route path="/account" element={<Account />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      </div>
      {flow && <FlowLayer key={flow.at} dir={flow.dir} loose={flow.loose} startedAt={flow.at} design={me?.design} onDone={() => { setFlow(null); setSettled(groupNow.current); }} />}
      <HudSweep screen={group} skip={flowing} />
    </>
  );
}


function App() {
  return (
    <NikoProvider>
      <Screens />
      <Awake />
    </NikoProvider>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter basename={appBase() || '/'}><App /></BrowserRouter>
  </StrictMode>,
);

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('/app/sw.js', { scope: appBase() ? '/app/' : '/' }).catch(() => undefined);
}
