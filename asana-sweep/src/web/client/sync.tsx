import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import type { SyncFeed, SyncStatus } from '../../sweep/types';
import { api, fmtRelative, useLiveUpdates } from './api';

/**
 * The strip under the Accounts tabs: which feeds this tab reads, when each one runs (team timezone,
 * CET by default), when it last ran and whether it failed. Same component on every tab.
 */
const FEEDS_BY_TAB: Record<string, string[]> = {
  '/monitor': ['monitor', 'health', 'tts', 'cruva', 'gmv'],
  '/checklists': ['checklist', 'reminder', 'monitor', 'client_tasks'],
  '/calendar': ['checklist', 'monitor', 'cruva'],
  '/promotions': ['tts', 'monitor'],
  '/gmv-max': ['tts', 'cruva'],
  '/stock': ['stock', 'cruva', 'tts'],
  '/pnl': ['gmv', 'cruva', 'stock'],
  '/cruva': ['cruva', 'playbook'],
  '/playbook': ['cruva', 'playbook'],
  '/creators': ['cruva_inbox', 'inbox', 'replies_digest', 'cruva'],
  '/customer-service': ['inbox', 'replies_digest'],
  '/reports': ['reports_queue', 'copilot', 'tldv', 'gmv', 'cruva'],
  '/copilot': ['copilot', 'tldv', 'inbox'],
};

const timeIn = (iso: string | null, tz: string): string => {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    const sameDay = new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
    const today = sameDay.format(new Date()) === sameDay.format(d);
    const tomorrow = sameDay.format(new Date(Date.now() + 86400000)) === sameDay.format(d);
    const t = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
    const abbr = new Intl.DateTimeFormat('en-GB', { timeZone: tz, timeZoneName: 'short' }).formatToParts(d).find((p) => p.type === 'timeZoneName')?.value ?? '';
    return `${today ? '' : tomorrow ? 'tomorrow ' : `${new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short' }).format(d)} `}${t} ${abbr}`;
  } catch { return iso; }
};

export function SyncStrip() {
  const { pathname } = useLocation();
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [open, setOpen] = useState(false);
  const load = () => api.syncStatus().then(setStatus).catch(() => undefined);
  useEffect(() => { load(); const t = setInterval(load, 60000); return () => clearInterval(t); }, []);
  useLiveUpdates(() => load(), 2000);
  const keys = FEEDS_BY_TAB[pathname];
  if (!status || !keys) return null;
  const feeds = keys.map((k) => status.feeds.find((f) => f.key === k)).filter((f): f is SyncFeed => Boolean(f));
  const stale = (f: SyncFeed) => f.configured && f.last_run_at && f.next_run_at && Date.parse(f.next_run_at) < Date.now() - 30 * 60000;
  const light = (f: SyncFeed) => (!f.configured ? 'muted' : f.last_error ? 'crit' : f.running ? 'warn' : stale(f) ? 'warn' : f.last_run_at ? 'good' : 'muted');
  const newest = feeds.filter((f) => f.last_run_at).map((f) => f.last_run_at as string).sort().pop() ?? null;
  return (
    <div className={`sync-strip ${open ? 'open' : ''}`}>
      <div className="row" onClick={() => setOpen((v) => !v)} role="button" aria-expanded={open} title="What feeds this tab, when it runs and when it last ran">
        <span className="sub"><b>Scans</b> · {status.timezone.replace('_', ' ')}{newest ? <> · last update {fmtRelative(newest)}</> : null}</span>
        <span className="feeds">
          {feeds.map((f) => <span key={f.key} className="feed" title={`${f.label}: ${f.schedule_text}${f.last_run_at ? ` · last ${timeIn(f.last_run_at, status.timezone)} (${fmtRelative(f.last_run_at)})` : ' · not run yet'}${f.last_error ? ` · ${f.last_error}` : ''}`}><span className={`light ${light(f)}`} />{f.label}<span className="sub"> {f.running ? 'running' : f.last_run_at ? fmtRelative(f.last_run_at) : f.configured ? 'not yet' : 'off'}</span></span>)}
        </span>
        <span className="sub">{open ? '▾' : '▸'}</span>
      </div>
      {open && (
        <div className="grid-wrap"><table className="sync"><thead><tr><th></th><th>Feed</th><th>Fills in</th><th>Runs</th><th>Next</th><th>Last ran</th><th>Status</th></tr></thead><tbody>
          {feeds.map((f) => (
            <tr key={f.key}>
              <td><span className={`light ${light(f)}`} /></td>
              <td><b>{f.label}</b></td>
              <td className="sub">{f.feeds}</td>
              <td>{f.schedule_text}</td>
              <td className="sub">{f.configured ? timeIn(f.next_run_at, status.timezone) || '–' : 'not configured'}</td>
              <td className="sub" title={f.last_run_at ?? ''}>{f.last_run_at ? `${timeIn(f.last_run_at, status.timezone)} · ${fmtRelative(f.last_run_at)}` : 'not run yet'}</td>
              <td>{f.last_error ? <span className="badge crit" title={f.last_error}>error</span> : f.running ? <span className="badge warn">running</span> : stale(f) ? <span className="badge warn">overdue</span> : f.last_run_at ? <span className="badge good">ok</span> : <span className="badge muted">waiting</span>}</td>
            </tr>
          ))}
        </tbody></table></div>
      )}
    </div>
  );
}
