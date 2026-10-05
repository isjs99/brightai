import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { AccountStatusRow, InboxData, MonitorData, OutreachData, PlaybookData } from '../../../sweep/types';
import { api, fmtRelative, useActor, useLiveUpdates } from '../api';

/** The landing page: what needs a person today across the accounts you look after. Built from the monitor, the checklist, the inbox and outreach, nothing new to maintain. */
export default function TodayPage() {
  const [monitor, setMonitor] = useState<MonitorData | null>(null);
  const [rows, setRows] = useState<AccountStatusRow[] | null>(null);
  const [inbox, setInbox] = useState<InboxData | null>(null);
  const [outreach, setOutreach] = useState<OutreachData | null>(null);
  const [cruva, setCruva] = useState<PlaybookData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const actor = useActor();
  const [mine, setMine] = useState(Boolean(actor));
  useEffect(() => { setMine(Boolean(actor)); }, [actor]);
  const load = useCallback(() => {
    api.monitor().then(setMonitor).catch((e) => setError((e as Error).message));
    api.listAccounts().then((r) => setRows(r.accounts)).catch(() => setRows([]));
    api.inbox().then(setInbox).catch(() => setInbox(null));
    api.outreach().then(setOutreach).catch(() => setOutreach(null));
    api.playbook().then(setCruva).catch(() => setCruva(null));
  }, []);
  useEffect(() => { load(); }, [load]);
  useLiveUpdates((e) => { if (['monitor', 'bd', 'inbox', 'checks', 'settings', 'playbook'].includes(e.kind)) load(); });
  if (!monitor || !rows) return <p>{error ?? 'Loading…'}</p>;

  const isMine = (am: string | null, aa: string | null) => !mine || !actor || [am, aa].some((n) => n && n.toLowerCase().startsWith(actor.toLowerCase()));
  const accounts = rows.filter((r) => r.account.enabled && isMine(r.account.am_name, r.account.aa_name));
  const ids = new Set(accounts.map((r) => r.account.id));
  const now = Date.now();
  const today = new Date().toISOString().slice(0, 10);
  const crit = monitor.flags.filter((f) => f.severity === 'crit' && f.account_id !== null && ids.has(f.account_id) && !f.acknowledged_at);
  const ruleTitle = (code: string) => monitor.rules.find((r) => r.code === code)?.title ?? code;
  const checks = accounts.map((r) => ({ r, c: r.live ?? r.check })).filter((x) => x.c && x.c.status !== 'unlinked' && x.c.status !== 'empty');
  const open = checks.filter((x) => !x.c!.combined_complete);
  const linesLeft = open.reduce((n, x) => n + (x.c!.am_total - x.c!.am_done) + (x.c!.aa_total - x.c!.aa_done), 0);
  const waiting = (inbox?.conversations ?? []).filter((c) => c.needs_reply && (c.account_id === null || ids.has(c.account_id)));
  const over24 = waiting.filter((c) => c.last_message_at && now - Date.parse(c.last_message_at) > 24 * 3600000);
  const followups = (outreach?.followups ?? []).filter((f) => !f.done_at && Date.parse(f.due_at) <= now + 12 * 3600000 && (!mine || !actor || (f.created_by ?? '').toLowerCase().startsWith(actor.toLowerCase())));
  const lark = (outreach?.lark_messages ?? []).filter((m) => m.status === 'scheduled' && m.scheduled_for !== null && m.scheduled_for <= today && (!mine || !actor || (m.created_by ?? '').toLowerCase().startsWith(actor.toLowerCase())));
  const nameOf = (id: number | null) => rows.find((r) => r.account.id === id)?.account.name ?? '';
  // Cruva setup gaps per account: core bots missing or paused on a linked shop.
  const coreKeys = new Set((cruva?.items ?? []).filter((i) => i.enabled && i.config.core).map((i) => `${i.kind}:${i.key}`));
  const cruvaGaps = accounts.map((r) => { const shops = (cruva?.shops ?? []).filter((s) => s.account_id === r.account.id).map((s) => s.shop_id); const cells = (cruva?.cells ?? []).filter((c) => shops.includes(c.shop_id) && coreKeys.has(`${c.kind}:${c.playbook_key}`)); return { account: r.account, missing: cells.filter((c) => c.status === 'missing').length, paused: cells.filter((c) => c.status === 'paused').length }; }).filter((g) => g.missing || g.paused);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Today</h1>
          <p className="hint" style={{ margin: 0 }}>{new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })}{actor ? ` · ${actor}` : ''} · {accounts.length} account{accounts.length === 1 ? '' : 's'}</p>
        </div>
        <div className="actions">
          <select value={mine ? 'mine' : 'all'} onChange={(e) => setMine(e.target.value === 'mine')} disabled={!actor} title={actor ? '' : 'Pick your name top right to see only your accounts'}>
            <option value="mine">My accounts</option><option value="all">Everyone</option>
          </select>
        </div>
      </div>
      {error && <div className="banner crit">{error}</div>}
      <div className="kpis" style={{ gridTemplateColumns: 'repeat(4, minmax(0, 1fr))' }}>
        <Link to="/monitor" className="kpi" style={{ textDecoration: 'none' }}><span className="k">Critical flags</span><span className="v">{crit.length}</span><span className="t">{[...new Set(crit.map((f) => f.account_name))].slice(0, 3).join(' · ') || 'nothing critical'}</span></Link>
        <Link to="/checklists" className="kpi" style={{ textDecoration: 'none' }}><span className="k">Checklist lines left</span><span className="v">{linesLeft}</span><span className="t">{open.length} account{open.length === 1 ? '' : 's'} open · {checks.length - open.length} done</span></Link>
        <Link to="/inbox" className="kpi" style={{ textDecoration: 'none' }}><span className="k">Inbox waiting</span><span className="v">{waiting.length}</span><span className="t">{over24.length} over 24h</span></Link>
        <Link to="/outreach?tab=followups" className="kpi" style={{ textDecoration: 'none' }}><span className="k">Outreach due</span><span className="v">{followups.length + lark.length}</span><span className="t">{lark.length} Lark · {followups.length} follow-up{followups.length === 1 ? '' : 's'}</span></Link>
      </div>

      <div className="charts" style={{ gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' }}>
        <div className="card">
          <div className="page-head" style={{ marginBottom: 6 }}><h3 style={{ margin: 0 }}><span className="badge crit">Act now</span> Flags that need someone today</h3></div>
          {crit.length === 0 ? <p className="sub">Nothing critical on {mine && actor ? 'your' : 'any'} account. Warnings live inside each account.</p> : (
            <ul className="flaglist">{crit.slice(0, 12).map((f) => <li key={f.id} className="crit"><span><b>{f.account_name}.</b> {ruleTitle(f.code)}: {f.message.replace(/^[^:]+:\s*/, '')}{f.detail ? <span className="sub"> · {f.detail.slice(0, 120)}</span> : null} <Link to={`/monitor?account=${f.account_id}`}>Open ▸</Link></span></li>)}</ul>
          )}
          {crit.length > 12 && <p className="sub"><Link to="/monitor?tab=flags">{crit.length - 12} more ▸</Link></p>}
        </div>
        <div className="card">
          <div className="page-head" style={{ marginBottom: 6 }}><h3 style={{ margin: 0 }}><span className="badge warn">Due</span> Checklist and outreach</h3></div>
          <ul className="flaglist">
            {open.slice(0, 6).map(({ r, c }) => <li key={r.account.id}><span><b>Checklist · {r.account.name}.</b> {c!.am_total - c!.am_done} AM and {c!.aa_total - c!.aa_done} AA line(s) open <Link to={`/checklists?account=${r.account.id}`}>Tick ▸</Link></span></li>)}
            {lark.map((m) => <li key={`l${m.id}`}><span><b>Lark · {m.brand ?? m.shop_name}</b> → {m.contact_name ?? 'TikTok Shop'}{m.scheduled_for && m.scheduled_for < today ? <span className="badge crit" style={{ marginLeft: 6 }}>overdue</span> : null} <Link to="/outreach?tab=lark">Copy &amp; open ▸</Link></span></li>)}
            {followups.slice(0, 6).map((f) => <li key={`f${f.id}`}><span><b>{f.kind === 'linkedin_check' ? 'LinkedIn' : f.kind === 'linkedin_message' ? 'LinkedIn' : f.kind === 'email_chase' ? 'Chase' : 'Reminder'} · {f.shop_name}.</b> {f.title} <span className="sub">{fmtRelative(f.due_at)}</span> <Link to="/outreach?tab=followups">Open ▸</Link></span></li>)}
            {cruvaGaps.slice(0, 4).map((g) => <li key={`c${g.account.id}`}><span><b>Cruva · {g.account.name}.</b> {g.missing} core bot{g.missing === 1 ? '' : 's'} missing{g.paused ? `, ${g.paused} paused` : ''} <Link to={`/cruva?account=${g.account.id}`}>Prepare ▸</Link></span></li>)}
            {open.length === 0 && lark.length === 0 && followups.length === 0 && cruvaGaps.length === 0 && <li><span className="sub">Nothing due.</span></li>}
          </ul>
        </div>
        <div className="card" style={{ gridColumn: 'span 2' }}>
          <div className="page-head" style={{ marginBottom: 6 }}><h3 style={{ margin: 0 }}><span className="badge muted">Inbox</span> Waiting on a reply</h3><Link to="/inbox" className="sub">Open inbox ▸</Link></div>
          {waiting.length === 0 ? <p className="sub">Nobody is waiting.</p> : (
            <div className="grid-wrap"><table><thead><tr><th>Waiting</th><th>Channel</th><th>Account</th><th>Who</th><th></th></tr></thead><tbody>
              {waiting.sort((a, b) => (a.last_message_at ?? '').localeCompare(b.last_message_at ?? '')).slice(0, 8).map((c) => (
                <tr key={c.id}>
                  <td>{c.last_message_at ? <span className={`badge ${now - Date.parse(c.last_message_at) > 24 * 3600000 ? 'crit' : 'muted'}`}>{fmtRelative(c.last_message_at)}</span> : <span className="sub">–</span>}</td>
                  <td className="sub">{c.channel === 'cs' ? 'CS' : 'Affiliate'}</td>
                  <td><b>{c.account_name ?? nameOf(c.account_id) ?? '–'}</b></td>
                  <td className="sub">{c.counterpart_name ?? c.counterpart_id ?? ''}</td>
                  <td><Link to="/inbox">Reply ▸</Link></td>
                </tr>
              ))}
            </tbody></table></div>
          )}
        </div>
      </div>
    </>
  );
}
