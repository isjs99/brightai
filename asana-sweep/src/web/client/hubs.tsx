import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import type { Account } from '../../sweep/types';
import { api } from './api';

/**
 * The six hubs of the portal. Each one is a title, a row of tabs and the existing page for that tab,
 * rendered "embedded" (its own title and hint hidden by CSS). Old paths keep working: every tab IS a path,
 * so links from Slack, emails and bookmarks land on the same page as before, now inside its hub.
 */

export interface HubTab { to: string; label: string; aliases?: string[] }

/** The account every page under Accounts is scoped to (from ?account= in the URL), or null for all. */
export const AccountScopeContext = createContext<number | null>(null);
export const useAccountScope = (): number | null => useContext(AccountScopeContext);

export function Hub({ title, tabs, children, right }: { title: string; tabs: HubTab[]; children: ReactNode; right?: ReactNode }) {
  const { pathname } = useLocation();
  const [params] = useSearchParams();
  const keep = params.get('account') ? `?account=${params.get('account')}` : '';
  return (
    <div className="hub">
      <div className="hub-head">
        <h1>{title}</h1>
        {right}
      </div>
      <div className="tabs hub-tabs">
        {tabs.map((t) => <Link key={t.to} to={`${t.to}${keep}`} className={`tab ${pathname === t.to || t.aliases?.includes(pathname) ? 'active' : ''}`}>{t.label}</Link>)}
      </div>
      <div className="embedded">{children}</div>
    </div>
  );
}

export const ACCOUNT_TABS: HubTab[] = [
  { to: '/monitor', label: 'Overview' },
  { to: '/checklists', label: 'Checklist' },
  { to: '/calendar', label: 'Calendar' },
  { to: '/promotions', label: 'Promotions' },
  { to: '/gmv-max', label: 'GMV Max' },
  { to: '/stock', label: 'Stock' },
  { to: '/reports', label: 'Reports' },
  { to: '/copilot', label: 'Ask' },
];
export const INBOX_TABS: HubTab[] = [
  { to: '/inbox', label: 'Conversations' },
  { to: '/inquiries', label: 'Website enquiries' },
];
export const GROWTH_TABS: HubTab[] = [
  { to: '/bd', label: 'Pipeline' },
  { to: '/outreach', label: 'Outreach' },
  { to: '/leads', label: 'Leads' },
];
export const PERFORMANCE_TABS: HubTab[] = [
  { to: '/gmv', label: 'GMV & bonus' },
  { to: '/analytics', label: 'Analytics' },
];
export const SETTINGS_TABS: HubTab[] = [
  { to: '/accounts', label: 'Accounts' },
  { to: '/people', label: 'Team' },
  { to: '/checklist-template', label: 'Checklist items' },
  { to: '/connections', label: 'Connections' },
  { to: '/playbook', label: 'Cruva playbook (archived)' },
];

/** Accounts hub: pick the account once; every tab below scopes to it (or shows everything when none is picked). */
export function AccountHub({ children }: { children: ReactNode }) {
  const [params, setParams] = useSearchParams();
  const [accounts, setAccounts] = useState<Account[]>([]);
  useEffect(() => { api.listAccounts().then((r) => setAccounts(r.accounts.map((x) => x.account).filter((a) => a.enabled).sort((a, b) => a.name.localeCompare(b.name)))).catch(() => setAccounts([])); }, []);
  const scope = params.get('account') ? Number(params.get('account')) : null;
  const pick = (id: string) => { const n = new URLSearchParams(params); if (id) n.set('account', id); else n.delete('account'); setParams(n); };
  const current = accounts.find((a) => a.id === scope);
  return (
    <AccountScopeContext.Provider value={scope}>
      <Hub title="Accounts" tabs={ACCOUNT_TABS} right={(
        <div className="account-scope">
          <select value={scope ?? ''} onChange={(e) => pick(e.target.value)} aria-label="Account">
            <option value="">All accounts</option>
            {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}{a.markets ? ` · ${a.markets}` : ''}</option>)}
          </select>
          {current && <span className="sub">{current.am_name ? `AM ${current.am_name}` : ''}{current.aa_name ? ` · AA ${current.aa_name}` : ''}</span>}
        </div>
      )}>
        {children}
      </Hub>
    </AccountScopeContext.Provider>
  );
}
