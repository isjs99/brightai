import { useEffect, useState } from 'react';
import { Link, NavLink, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { api, currentActor, setCurrentActor, type Status } from './api';
import { SessionContext, type Role } from './session';
import type { Person } from '../../sweep/types';
import RulesList from './pages/RulesList';
import RuleEditor from './pages/RuleEditor';
import RunHistory from './pages/RunHistory';
import Accounts from './pages/Accounts';
import Checklists from './pages/Checklists';
import AnalyticsPage from './pages/Analytics';
import CalendarPage from './pages/Calendar';
import GmvPage from './pages/Gmv';
import PeoplePage from './pages/People';
import PromotionsPage from './pages/Promotions';
import GmvMaxPage from './pages/GmvMax';
import LeadsPage from './pages/Leads';
import BdPage from './pages/Bd';
import InboxPage from './pages/Inbox';
import OutreachPage from './pages/Outreach';
import MonitorPage from './pages/Monitor';

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

function Login({ onDone }: { onDone: (role: Role) => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.login(password);
      const me = await api.me();
      onDone(me.role ?? 'admin');
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

const NAV: { section: string; items: { to: string; label: string; end?: boolean }[] }[] = [
  {
    section: 'Operations',
    items: [
      { to: '/checklists', label: 'Checklists' },
      { to: '/calendar', label: 'Calendar' },
      { to: '/', label: 'Sweep rules', end: true },
    ],
  },
  {
    section: 'Performance',
    items: [
      { to: '/gmv', label: 'GMV & bonus' },
      { to: '/analytics', label: 'Analytics & grades' },
    ],
  },
  {
    section: 'Growth',
    items: [
      { to: '/leads', label: 'Leads' },
      { to: '/bd', label: 'BD pipeline' },
      { to: '/outreach', label: 'Outreach emails' },
    ],
  },
  {
    section: 'Account management',
    items: [
      { to: '/promotions', label: 'Promotions' },
      { to: '/gmv-max', label: 'GMV Max' },
      { to: '/inbox', label: 'CS & affiliate inbox' },
      { to: '/monitor', label: 'Account monitor' },
    ],
  },
  {
    section: 'Setup',
    items: [
      { to: '/accounts', label: 'Accounts' },
      { to: '/people', label: 'Team' },
    ],
  },
];

export default function App() {
  const [role, setRole] = useState<Role | null | undefined>(undefined); // undefined = loading, null = signed out
  const [status, setStatus] = useState<Status | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    api.me().then((r) => setRole(r.authenticated ? (r.role ?? 'admin') : null)).catch(() => setRole(null));
    const onUnauth = () => setRole(null);
    window.addEventListener('sweep:unauthenticated', onUnauth);
    return () => window.removeEventListener('sweep:unauthenticated', onUnauth);
  }, []);

  useEffect(() => {
    if (role) api.status().then(setStatus).catch(() => setStatus(null));
  }, [role]);

  useEffect(() => {
    setMenuOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    document.body.dataset.role = role ?? '';
  }, [role]);

  if (role === undefined) return <div className="page">Loading…</div>;
  if (role === null) return <Login onDone={setRole} />;

  const logout = async () => {
    await api.logout();
    setRole(null);
    navigate('/');
  };

  return (
    <SessionContext.Provider value={{ role }}>
      <div className="shell">
        <header className="topbar">
          <div className="brand">
            <button className="small menu-btn" onClick={() => setMenuOpen((o) => !o)} aria-label="Menu">☰</button>
            <Link to="/checklists">Brightform.</Link>
            <span>AM Ops</span>
          </div>
          <nav>
            <ActorPicker />
            {status?.asana_user && <span className="sub hide-sm">Asana: {status.asana_user.name}</span>}
            <span className={`badge ${role === 'admin' ? 'accent' : 'muted'}`} title={role === 'admin' ? 'Admin: can change settings' : 'Account manager: view only'}>
              {role === 'admin' ? 'Admin' : 'View only'}
            </span>
            <ThemeToggle />
            <button className="small" onClick={logout}>Sign out</button>
          </nav>
        </header>
        <div className="body">
          <aside className={`sidebar ${menuOpen ? 'open' : ''}`}>
            {NAV.map((group) => (
              <div className="nav-group" key={group.section}>
                <div className="nav-section">{group.section}</div>
                {group.items.map((item) => (
                  <NavLink key={item.to} to={item.to} end={item.end} className={({ isActive }) => (isActive ? 'active' : '')}>
                    {item.label}
                  </NavLink>
                ))}
              </div>
            ))}
          </aside>
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
              <Route path="/promotions" element={<PromotionsPage />} />
              <Route path="/gmv-max" element={<GmvMaxPage />} />
              <Route path="/leads" element={<LeadsPage />} />
              <Route path="/bd" element={<BdPage />} />
              <Route path="/outreach" element={<OutreachPage />} />
              <Route path="/monitor" element={<MonitorPage />} />
              <Route path="/inbox" element={<InboxPage />} />
              <Route path="*" element={<Navigate to="/checklists" replace />} />
            </Routes>
          </main>
        </div>
      </div>
    </SessionContext.Provider>
  );
}


/** "You are": the shared login has no identity, so each person picks their name once per browser; BD actions are logged under it. */
function ActorPicker() {
  const [people, setPeople] = useState<Person[]>([]);
  const [actor, setActor] = useState(currentActor());
  useEffect(() => { api.listPeople().then((r) => setPeople(r.people)).catch(() => setPeople([])); }, []);
  return (
    <select className="small" value={actor} title="Who is using the dashboard right now (logged on BD outreach)" onChange={(e) => { setActor(e.target.value); setCurrentActor(e.target.value); }} style={{ width: 'auto' }}>
      <option value="">You are…</option>
      <option value="Isaac">Isaac</option>
      {people.filter((p) => p.name !== 'Isaac').map((p) => <option key={p.id} value={p.name}>{p.name}</option>)}
    </select>
  );
}
