import { useEffect, useState } from 'react';
import { Link, NavLink, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { api, currentActor, setCurrentActor, type Status } from './api';
import { SessionContext, type Role } from './session';
import type { Person } from '../../sweep/types';
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
import InquiriesPage from './pages/Inquiries';
import MonitorPage from './pages/Monitor';
import StockPage from './pages/Stock';
import ReportsPage from './pages/Reports';
import CruvaPage from './pages/Cruva';
import CopilotPage from './pages/Copilot';
import ChecklistTemplatePage from './pages/ChecklistTemplate';
import ConnectionsPage from './pages/Connections';
import TodayPage from './pages/Today';
import { AccountHub, GROWTH_TABS, Hub, INBOX_TABS, PERFORMANCE_TABS, SETTINGS_TABS } from './hubs';

type Theme = 'system' | 'light' | 'dark';

function readTheme(): Theme {
  try {
    const t = localStorage.getItem('theme');
    return t === 'system' || t === 'dark' ? t : 'light';
  } catch {
    return 'light';
  }
}

function applyTheme(t: Theme) {
  document.documentElement.setAttribute('data-theme', t);
  try {
    if (t === 'light') localStorage.removeItem('theme');
    else localStorage.setItem('theme', t);
  } catch {
    /* private mode or blocked storage: the choice just does not persist */
  }
}

/** Light (the default, like the website) → Dark → Auto (follow the OS). Stored per browser. */
function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(readTheme);
  const next: Record<Theme, Theme> = { light: 'dark', dark: 'system', system: 'light' };
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

/** Six entries. Each hub owns several paths (its tabs), so the link is active on any of them. */
const NAV: { to: string; label: string; paths: string[] }[] = [
  { to: '/today', label: 'Today', paths: ['/today'] },
  { to: '/monitor', label: 'Accounts', paths: ['/monitor', '/checklists', '/calendar', '/promotions', '/gmv-max', '/stock', '/cruva', '/playbook', '/reports', '/copilot'] },
  { to: '/inbox', label: 'Inbox', paths: ['/inbox', '/inquiries'] },
  { to: '/bd', label: 'Growth', paths: ['/bd', '/outreach', '/leads'] },
  { to: '/gmv', label: 'Performance', paths: ['/gmv', '/analytics'] },
  { to: '/accounts', label: 'Settings', paths: ['/accounts', '/people', '/checklist-template', '/connections'] },
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
    navigate('/checklists');
  };

  return (
    <SessionContext.Provider value={{ role }}>
      <div className="shell">
        <header className="topbar">
          <div className="brand">
            <button className="small menu-btn" onClick={() => setMenuOpen((o) => !o)} aria-label="Menu">☰</button>
            <Link to="/today">Brightform<span className="dot">.</span></Link>
            <span>AM Ops</span>
          </div>
          <nav>
            <ActorPicker />
            <span className={`badge ${role === 'admin' ? 'accent' : 'muted'}`} title={role === 'admin' ? 'Admin: can change settings' : 'Account manager: view only'}>
              {role === 'admin' ? 'Admin' : 'View only'}
            </span>
            <ThemeToggle />
            <button className="small" onClick={logout}>Sign out</button>
          </nav>
        </header>
        <div className="body">
          <aside className={`sidebar ${menuOpen ? 'open' : ''}`}>
            <div className="nav-group">
              {NAV.map((item) => (
                <NavLink key={item.to} to={item.to} className={() => (item.paths.includes(location.pathname) ? 'active' : '')}>
                  {item.label}
                </NavLink>
              ))}
            </div>
          </aside>
          <main className="page">
            <Routes>
              <Route path="/today" element={<TodayPage />} />
              <Route path="/monitor" element={<AccountHub><MonitorPage /></AccountHub>} />
              <Route path="/checklists" element={<AccountHub><Checklists /></AccountHub>} />
              <Route path="/calendar" element={<AccountHub><CalendarPage /></AccountHub>} />
              <Route path="/promotions" element={<AccountHub><PromotionsPage /></AccountHub>} />
              <Route path="/gmv-max" element={<AccountHub><GmvMaxPage /></AccountHub>} />
              <Route path="/stock" element={<AccountHub><StockPage /></AccountHub>} />
              <Route path="/reports" element={<AccountHub><ReportsPage /></AccountHub>} />
              <Route path="/copilot" element={<AccountHub><CopilotPage /></AccountHub>} />
              <Route path="/inbox" element={<Hub title="Inbox" tabs={INBOX_TABS}><InboxPage /></Hub>} />
              <Route path="/inquiries" element={<Hub title="Inbox" tabs={INBOX_TABS}><InquiriesPage /></Hub>} />
              <Route path="/bd" element={<Hub title="Growth" tabs={GROWTH_TABS}><BdPage /></Hub>} />
              <Route path="/outreach" element={<Hub title="Growth" tabs={GROWTH_TABS}><OutreachPage /></Hub>} />
              <Route path="/leads" element={<Hub title="Growth" tabs={GROWTH_TABS}><LeadsPage /></Hub>} />
              <Route path="/gmv" element={<Hub title="Performance" tabs={PERFORMANCE_TABS}><GmvPage /></Hub>} />
              <Route path="/analytics" element={<Hub title="Performance" tabs={PERFORMANCE_TABS}><AnalyticsPage /></Hub>} />
              <Route path="/accounts" element={<Hub title="Settings" tabs={SETTINGS_TABS}><Accounts /></Hub>} />
              <Route path="/people" element={<Hub title="Settings" tabs={SETTINGS_TABS}><PeoplePage /></Hub>} />
              <Route path="/checklist-template" element={<Hub title="Settings" tabs={SETTINGS_TABS}><ChecklistTemplatePage /></Hub>} />
              <Route path="/connections" element={<Hub title="Settings" tabs={SETTINGS_TABS}><ConnectionsPage /></Hub>} />
              <Route path="/cruva" element={<AccountHub><CruvaPage /></AccountHub>} />
              <Route path="/playbook" element={<AccountHub><CruvaPage /></AccountHub>} />
              <Route path="*" element={<Navigate to="/today" replace />} />
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
