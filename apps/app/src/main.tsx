import { StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { appBase } from '@niko/ui';
import '@niko/ui/src/styles.css';
import './app.css';
import { NikoProvider, useNiko } from './niko';
import { Forgot, Invite, Reset, SignIn, SignUp } from './pages/Auth';
import { Home, Workspace } from './pages/Core';
import { Account, Appearance, Connections, Engine } from './pages/Settings';

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

function App() {
  return (
    <NikoProvider>
      <Routes>
        <Route path="/sign-in" element={<Public><SignIn /></Public>} />
        <Route path="/invite" element={<Public><Invite /></Public>} />
        <Route path="/sign-up" element={<Public><SignUp /></Public>} />
        <Route path="/forgot" element={<Public><Forgot /></Public>} />
        <Route path="/reset" element={<Public><Reset /></Public>} />
        <Route path="/" element={<Private><Home /></Private>} />
        {['/inbox', '/calendar', '/notes'].map((p) => <Route key={p} path={p} element={<Private><Workspace /></Private>} />)}
        <Route path="/connections" element={<Private><Connections /></Private>} />
        <Route path="/engine" element={<Private><Engine /></Private>} />
        <Route path="/appearance" element={<Private><Appearance /></Private>} />
        <Route path="/account" element={<Private><Account /></Private>} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
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
