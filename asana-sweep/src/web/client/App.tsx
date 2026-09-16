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
      <h1>Asana Sweep</h1>
      <p className="hint">Enter the dashboard password.</p>
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
          <Link to="/" style={{ color: 'inherit' }}>Asana Sweep</Link>
          <span>AM checklists</span>
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
