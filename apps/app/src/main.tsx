import { StrictMode, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { appBase } from '@niko/ui';
import '@niko/ui/src/styles.css';
import './app.css';
import { NikoProvider, useNiko } from './niko';
import { FLOW_SECONDS, FlowLayer, LEAVE_MS } from './flow';
import { Forgot, Invite, Reset, SignIn, SignUp } from './pages/Auth';
import { Home, Workspace } from './pages/Core';
import { Account, Appearance, Connections, Engine, SettingsLayout, Voice } from './pages/Settings';

function Private({ children }: { children: ReactNode }) {
  const { me } = useNiko();
  if (me === undefined) return <div className="bg" />;
  return me ? <>{children}</> : <Navigate to="/sign-in" replace />;
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
function HudSweep({ pathname, skip }: { pathname: string; skip: boolean }) {
  const [n, setN] = useState(0);
  const first = useRef(true);
  useEffect(() => { if (first.current) { first.current = false; return; } if (!skip) setN((x) => x + 1); }, [pathname]); // eslint-disable-line react-hooks/exhaustive-deps
  if (n === 0) return null;
  return (
    <div key={n} className="hud-sweep" aria-hidden="true">
      <i className="hud-ring" /><i className="hud-ring two" /><i className="hud-scan" />
      <i className="hud-corner tl" /><i className="hud-corner tr" /><i className="hud-corner bl" /><i className="hud-corner br" />
    </div>
  );
}

const kindOf = (p: string) => (p === '/' ? 'home' : WORKSPACE_PATHS.includes(p) ? 'ws' : 'other');
const reduced = () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function Screens() {
  const loc = useLocation();
  // The screen on display can lag the address for a moment: between Home and the workspace the old screen
  // fades out while the particles start to flow, then the new one is mounted and builds itself in.
  const [shown, setShown] = useState(loc);
  const [flow, setFlow] = useState<{ dir: 'in' | 'out'; at: number } | null>(null);
  const [leaving, setLeaving] = useState(false);
  useEffect(() => {
    if (loc.pathname === shown.pathname) { setShown(loc); return; }
    const a = kindOf(shown.pathname), b = kindOf(loc.pathname);
    if (!reduced() && ((a === 'home' && b === 'ws') || (a === 'ws' && b === 'home'))) {
      setFlow({ dir: b === 'ws' ? 'in' : 'out', at: performance.now() });
      setLeaving(true);
      const t = window.setTimeout(() => { setLeaving(false); setShown(loc); }, LEAVE_MS);
      return () => window.clearTimeout(t);
    }
    setFlow(null);
    setShown(loc);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loc]);
  // Settings keep their sidebar and the workspace keeps its rail, so those animate inside, not as a whole screen.
  const group = SETTINGS_PATHS.includes(shown.pathname) ? 'settings' : WORKSPACE_PATHS.includes(shown.pathname) ? 'workspace' : shown.pathname;
  const flowing = !!flow;
  // How a screen arrives is fixed when it mounts, so the end of the flow never restarts an entrance animation.
  const entry = useMemo(() => (flow ? 'flow flow-' + flow.dir : 'hud-in'), [group]); // eslint-disable-line react-hooks/exhaustive-deps
  // Once the flow has finished, its arrival styles come off, so they never hold back later animations on that screen.
  const [settled, setSettled] = useState<string | null>(null);
  const groupNow = useRef(group);
  groupNow.current = group;
  const cls = 'route ' + (leaving ? 'leaving' : settled === group && entry !== 'hud-in' ? '' : entry);
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
        <Route element={<Private><SettingsLayout /></Private>}>
          <Route path="/appearance" element={<Appearance />} />
          <Route path="/voice" element={<Voice />} />
          <Route path="/connections" element={<Connections />} />
          <Route path="/engine" element={<Engine />} />
          <Route path="/account" element={<Account />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      </div>
      {flow && <FlowLayer key={flow.at} dir={flow.dir} startedAt={flow.at} onDone={() => { setFlow(null); setSettled(groupNow.current); }} />}
      <HudSweep pathname={shown.pathname} skip={flowing} />
    </>
  );
}


function App() {
  return (
    <NikoProvider>
      <Screens />
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
