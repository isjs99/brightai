import { useEffect, useState } from 'react';
import { Link, NavLink, Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import { api, type Status } from './api';
import RulesList from './pages/RulesList';
import RuleEditor from './pages/RuleEditor';
import RunHistory from './pages/RunHistory';
import Accounts from './pages/Accounts';
import Checklists from './pages/Checklists';
import AnalyticsPage from './pages/Analytics';
import CalendarPage from './pages/Calendar';
import GmvPage from './pages/Gmv';
import PeoplePage from './pages/People';

type Theme = 'system' | 'light' | 'dark';

function readTheme(): Theme {
  try {
    const t = localStorage.getItem('theme');
    return t === 'light' || t === 'dark' ? t : 'system';
  } catch {
    return 'system';
  }
}

function applyTheme(t: Theme) {
  if (t === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', t);
  try {
    if (t === 'system') localStorage.removeItem('theme');
    else localStorage.setItem('theme', t);
  } catch {
    /* private mode or blocked storage: the choice just does not persist */
  }
}

/** System → Light → Dark cycle. Stored per browser. */
function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(readTheme);
  const next: Record<Theme, Theme> = { system: 'light', light: 'dark', dark: 'system' };
  const label: Record<Theme, string> = { system: 'Auto', light: 'Light', dark: 'Dark' };
  const icon: Record<Theme, string> = { system: '◐', light: '○', dark: '●' };
  const change = () => {
    const t = next[theme];
    setTheme(t);
    applyTheme(t);
  };
  return (
    <button className="small theme-toggle" onClick={change} title={`Theme: ${label[theme]}. Click to change.`} aria-label={`Theme: ${label[theme]}`}>
      <span aria-hidden="true">{icon[theme]}</span> {label[theme]}
    </button>
  );
}

function Login({ onDone }: { onDone: () => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.login(password);
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="login card">
      <h1>Brightform.</h1>
      <p className="hint">AM Ops dashboard. Enter the team password.</p>
      <form onSubmit={submit}>
        <label className="field">
          <span className="lbl">Password</span>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />
        </label>
        {error && <p className="error">{error}</p>}
        <div className="form-foot">
          <button className="primary" disabled={busy || !password}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </div>
      </form>
    </div>
  );
}

export default function App() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    api.me().then((r) => setAuthed(r.authenticated)).catch(() => setAuthed(false));
    const onUnauth = () => setAuthed(false);
    window.addEventListener('sweep:unauthenticated', onUnauth);
    return () => window.removeEventListener('sweep:unauthenticated', onUnauth);
  }, []);

  useEffect(() => {
    if (authed) api.status().then(setStatus).catch(() => setStatus(null));
  }, [authed]);

  if (authed === null) return <div className="page">Loading…</div>;
  if (!authed) return <Login onDone={() => setAuthed(true)} />;

  const logout = async () => {
    await api.logout();
    setAuthed(false);
    navigate('/');
  };

  return (
    <>
      <header className="topbar">
        <div className="brand">
          <Link to="/checklists">Brightform.</Link>
          <span>AM Ops</span>
        </div>
        <nav>
          {status?.asana_user && <span className="sub">Asana: {status.asana_user.name}</span>}
          <NavLink to="/checklists" className={({ isActive }) => (isActive ? 'active' : '')}>Checklists</NavLink>
          <NavLink to="/calendar" className={({ isActive }) => (isActive ? 'active' : '')}>Calendar</NavLink>
          <NavLink to="/gmv" className={({ isActive }) => (isActive ? 'active' : '')}>GMV</NavLink>
          <NavLink to="/analytics" className={({ isActive }) => (isActive ? 'active' : '')}>Analytics</NavLink>
          <NavLink to="/accounts" className={({ isActive }) => (isActive ? 'active' : '')}>Accounts</NavLink>
          <NavLink to="/people" className={({ isActive }) => (isActive ? 'active' : '')}>Team</NavLink>
          <NavLink to="/" end className={({ isActive }) => (isActive ? 'active' : '')}>Sweep rules</NavLink>
          <ThemeToggle />
          <button className="small" onClick={logout}>Sign out</button>
        </nav>
      </header>
      <main className="page">
        {status?.asana_error && (
          <div className="banner crit">
            <b>Asana is not reachable.</b> {status.asana_error} Runs and previews will fail until this is fixed.
          </div>
        )}
        <Routes>
          <Route path="/" element={<RulesList />} />
          <Route path="/rules/new" element={<RuleEditor />} />
          <Route path="/rules/:id" element={<RuleEditor />} />
          <Route path="/rules/:id/runs" element={<RunHistory />} />
          <Route path="/accounts" element={<Accounts />} />
          <Route path="/checklists" element={<Checklists />} />
          <Route path="/analytics" element={<AnalyticsPage />} />
          <Route path="/calendar" element={<CalendarPage />} />
          <Route path="/gmv" element={<GmvPage />} />
          <Route path="/people" element={<PeoplePage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </>
  );
}
