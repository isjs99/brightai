import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import type { Account } from '../../sweep/types';
import { api } from './api';
import { SyncStrip } from './sync';

/**
 * The six hubs of the portal. Each one is a title, a row of tabs and the existing page for that tab,
 * rendered "embedded" (its own title and hint hidden by CSS). Old paths keep working: every tab IS a path,
 * so links from Slack, emails and bookmarks land on the same page as before, now inside its hub.
 */

export interface HubTab { to: string; label: string; aliases?: string[] }

/** The account every page under Accounts is scoped to (from ?account= in the URL), or null for all. */
export const AccountScopeContext = createContext<number | null>(null);
export const useAccountScope = (): number | null => useContext(AccountScopeContext);
/** The accounts of the chosen AM (from ?am= in the URL), or null for everyone's. */
export const AllowedAccountsContext = createContext<Set<number> | null>(null);
export const useAllowedAccounts = (): Set<number> | null => useContext(AllowedAccountsContext);
/** One check for both pickers: the account scope and the AM's accounts. */
export function useInScope(): (accountId: number | null | undefined) => boolean {
  const scope = useAccountScope();
  const allowed = useAllowedAccounts();
  return (id) => (scope === null || id === scope) && (allowed === null || (id !== null && id !== undefined && allowed.has(id)));
}

export function Hub({ title, tabs, children, right }: { title: string; tabs: HubTab[]; children: ReactNode; right?: ReactNode }) {
  const { pathname } = useLocation();
  const [params] = useSearchParams();
  const keepParams = new URLSearchParams(); if (params.get('account')) keepParams.set('account', params.get('account')!); if (params.get('am')) keepParams.set('am', params.get('am')!);
  const keep = keepParams.toString() ? `?${keepParams.toString()}` : '';
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
  { to: '/pnl', label: 'P&L' },
  { to: '/cruva', label: 'Cruva', aliases: ['/playbook'] },
  { to: '/samples', label: 'Samples' },
  { to: '/creators', label: 'Creators' },
  { to: '/customer-service', label: 'Customer service' },
  { to: '/reports', label: 'Reports' },
  { to: '/copilot', label: 'Ask' },
];
export const ONBOARDING_TABS: HubTab[] = [
  { to: '/targets', label: 'Targets' },
  { to: '/onboarding', label: 'Onboarding steps' },
];
export const PITCH_TABS: HubTab[] = [
  { to: '/pitch', label: 'Pitches' },
];
export const INBOX_TABS: HubTab[] = [
  { to: '/inquiries', label: 'Website enquiries' },
];
export const GROWTH_TABS: HubTab[] = [
  { to: '/bd', label: 'Pipeline' },
  { to: '/outreach', label: 'Outreach' },
  { to: '/leads', label: 'Leads' },
  { to: '/competitors', label: 'Competitors' },
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
];

/** Accounts hub: pick the account once; every tab below scopes to it (or shows everything when none is picked). */
export function AccountHub({ children }: { children: ReactNode }) {
  const [params, setParams] = useSearchParams();
  const [accounts, setAccounts] = useState<Account[]>([]);
  useEffect(() => { api.listAccounts().then((r) => setAccounts(r.accounts.map((x) => x.account).filter((a) => a.enabled).sort((a, b) => a.name.localeCompare(b.name)))).catch(() => setAccounts([])); }, []);
  const scope = params.get('account') ? Number(params.get('account')) : null;
  const am = params.get('am') ?? '';
  const ams = [...new Set(accounts.map((a) => a.am_name ?? 'Unassigned'))].sort();
  const mine = am ? accounts.filter((a) => (a.am_name ?? 'Unassigned') === am) : accounts;
  const allowed = am ? new Set(mine.map((a) => a.id)) : null;
  const pick = (id: string) => { const n = new URLSearchParams(params); if (id) n.set('account', id); else n.delete('account'); setParams(n); };
  const pickAm = (name: string) => { const n = new URLSearchParams(params); if (name) n.set('am', name); else n.delete('am'); if (scope !== null && name && !accounts.some((a) => a.id === scope && (a.am_name ?? 'Unassigned') === name)) n.delete('account'); setParams(n); };
  const current = accounts.find((a) => a.id === scope);
  return (
    <AccountScopeContext.Provider value={scope}>
      <AllowedAccountsContext.Provider value={allowed}>
        <Hub title="Accounts" tabs={ACCOUNT_TABS} right={(
          <div className="account-scope">
            <select value={am} onChange={(e) => pickAm(e.target.value)} aria-label="Account manager" className="am" title="Pick your name to see only your accounts on every tab">
              <option value="">All AMs</option>
              {ams.map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
            <select value={scope ?? ''} onChange={(e) => pick(e.target.value)} aria-label="Account">
              <option value="">{am ? `All ${am}'s accounts` : 'All accounts'}</option>
              {mine.map((a) => <option key={a.id} value={a.id}>{a.name}{a.markets ? ` · ${a.markets}` : ''}</option>)}
            </select>
            {current && <span className="sub">{current.am_name ? `AM ${current.am_name}` : ''}{current.aa_name ? ` · AA ${current.aa_name}` : ''}</span>}
          </div>
        )}>
          <SyncStrip />
          {children}
        </Hub>
      </AllowedAccountsContext.Provider>
    </AccountScopeContext.Provider>
  );
}
