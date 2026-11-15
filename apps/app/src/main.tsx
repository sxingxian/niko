import { StrictMode, useEffect, useRef, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { appBase } from '@niko/ui';
import '@niko/ui/src/styles.css';
import './app.css';
import { NikoProvider, useNiko } from './niko';
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
 * Purely decorative (aria-hidden, no pointer events) and skipped when reduced motion is asked for. */
function HudSweep() {
  const { pathname } = useLocation();
  const [n, setN] = useState(0);
  const first = useRef(true);
  useEffect(() => { if (first.current) { first.current = false; return; } setN((x) => x + 1); }, [pathname]);
  if (n === 0) return null;
  return (
    <div key={n} className="hud-sweep" aria-hidden="true">
      <i className="hud-ring" /><i className="hud-ring two" /><i className="hud-scan" />
      <i className="hud-corner tl" /><i className="hud-corner tr" /><i className="hud-corner bl" /><i className="hud-corner br" />
    </div>
  );
}

function Screens() {
  const loc = useLocation();
  // Settings keep their sidebar and the workspace keeps its rail, so those animate inside, not as a whole screen.
  const group = SETTINGS_PATHS.includes(loc.pathname) ? 'settings' : WORKSPACE_PATHS.includes(loc.pathname) ? 'workspace' : loc.pathname;
  return (
    <>
      <div key={group} className="route hud-in">
      <Routes location={loc}>
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
      <HudSweep />
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
