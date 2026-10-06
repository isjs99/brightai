import { useCallback, useEffect, useState } from 'react';
import type { ClientTask, ClientTasksData } from '../../../sweep/types';
import { api, fmtRelative, useLiveUpdates } from '../api';
import { useIsAdmin } from '../session';
import { useAccountScope, useAllowedAccounts, useInScope } from '../hubs';
import { AccountGroup, GroupsHead, useOpenGroups, type GroupLight } from '../groups';

/**
 * Checklist > Client tasks: the ad hoc asks agreed with each client, pulled from their Slack channel, the
 * emails and the calls (plus anything added by hand), one short bullet each with the full context behind
 * it, a due date, tick done, dismiss. Today by default; the date range shows history.
 */
const SOURCE: Record<ClientTask['source'], string> = { slack: 'Slack', email: 'Email', call: 'Call', manual: 'Added' };
const iso = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (date: string, n: number) => iso(new Date(Date.parse(`${date}T12:00:00Z`) + n * 86400000));

export default function ClientTasksView({ amFilter }: { amFilter: string }) {
  const [data, setData] = useState<ClientTasksData | null>(null);
  const [preset, setPreset] = useState<'today' | '7' | '30' | 'month' | 'custom'>('today');
  const [range, setRange] = useState<{ from: string; to: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const isAdmin = useIsAdmin();
  const scope = useAccountScope();
  const inScope = useInScope();
  const allowed = useAllowedAccounts();
  const groups = useOpenGroups('client-tasks');
  const load = useCallback(() => api.clientTasks(range?.from, range?.to).then(setData).catch((e) => setError((e as Error).message)), [range]);
  useEffect(() => { load(); }, [load]);
  useLiveUpdates((e) => { if (e.kind === 'check' || e.kind === 'copilot') load(); });
  const run = async <T extends ClientTasksData,>(key: string, fn: () => Promise<T>, after?: (r: T) => void) => {
    setBusy(key); setError(null);
    try { const r = await fn(); setData(r); after?.(r); } catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  };
  if (!data) return <p>{error ?? 'Loading…'}</p>;
  const today = data.today;
  const pick = (p: typeof preset) => {
    setPreset(p);
    if (p === 'today') setRange(null);
    if (p === '7') setRange({ from: addDays(today, -6), to: today });
    if (p === '30') setRange({ from: addDays(today, -29), to: today });
    if (p === 'month') setRange({ from: `${today.slice(0, 7)}-01`, to: today });
    if (p === 'custom') setRange(range ?? { from: addDays(today, -6), to: today });
  };
  const isToday = data.from === today && data.to === today;
  const accounts = data.accounts.filter((a) => inScope(a.id) && (!amFilter || (a.am_name ?? 'Unassigned') === amFilter));
  const real = data.tasks.filter((t) => !t.title.startsWith('(nothing actionable'));
  const tasksOf = (id: number) => real.filter((t) => t.account_id === id);
  const lightOf = (id: number): GroupLight => {
    const ts = tasksOf(id);
    const open = ts.filter((t) => t.status === 'open');
    if (open.some((t) => t.due_date && t.due_date < today)) return 'red';
    if (open.length) return 'amber';
    if (ts.some((t) => t.status === 'done')) return 'green';
    return 'grey';
  };
  const order: GroupLight[] = ['red', 'amber', 'green', 'grey'];
  const sorted = [...accounts].sort((a, b) => order.indexOf(lightOf(a.id)) - order.indexOf(lightOf(b.id)) || a.name.localeCompare(b.name));
  const visible = real.filter((t) => accounts.some((a) => a.id === t.account_id));
  const open = visible.filter((t) => t.status === 'open');
  return (
    <>
      {error && <div className="banner crit">{error}</div>}
      {notice && <div className="banner info">{notice}</div>}
      <div className="toolbar">
        <div className="presets">
          {(['today', '7', '30', 'month', 'custom'] as const).map((p) => <button key={p} className={preset === p ? 'active' : ''} onClick={() => pick(p)}>{p === 'today' ? 'Today' : p === '7' ? 'Last 7 days' : p === '30' ? 'Last 30 days' : p === 'month' ? 'This month' : 'Custom'}</button>)}
        </div>
        {preset === 'custom' && range && <><input type="date" value={range.from} max={range.to} onChange={(e) => setRange({ ...range, from: e.target.value })} /><span className="sub">to</span><input type="date" value={range.to} min={range.from} onChange={(e) => setRange({ ...range, to: e.target.value })} /></>}
        <span className="sub">{isToday ? 'Open tasks and anything that moved today' : `${data.from} to ${data.to}: open tasks plus everything created, due, done or dismissed in the range`}</span>
        <span style={{ marginLeft: 'auto' }} className="sub">{data.last_scan_at ? `Scanned ${fmtRelative(data.last_scan_at)}` : 'Not scanned yet'}{data.last_scan_error ? ` · ${data.last_scan_error}` : ''}{data.llm_configured ? '' : ' · pattern matching only (no ANTHROPIC_API_KEY)'}</span>
        {isAdmin && <button className="small" disabled={busy === 'scan' || data.scanning} onClick={() => run('scan', () => api.clientTasksScan({ since_days: 14, from: data.from, to: data.to }), (r) => setNotice(`Scanned ${r.scanned} source(s), ${r.added} task(s) added.`))}>{busy === 'scan' || data.scanning ? 'Scanning…' : 'Scan now'}</button>}
      </div>
      <div className="kpis">
        <div className="kpi"><div className="v">{open.length}</div><div className="k">open client tasks</div></div>
        <div className="kpi"><div className={`v ${open.some((t) => t.due_date && t.due_date < today) ? 'crit' : ''}`}>{open.filter((t) => t.due_date && t.due_date < today).length}</div><div className="k">overdue</div></div>
        <div className="kpi"><div className="v">{open.filter((t) => t.due_date === today).length}</div><div className="k">due today</div></div>
        <div className="kpi"><div className="v">{visible.filter((t) => t.status === 'done').length}</div><div className="k">done {isToday ? 'today' : 'in range'}</div></div>
      </div>
      {sorted.length === 0 ? <div className="empty">No accounts{amFilter ? ` for ${amFilter}` : ''}.</div> : (
        <>
          <GroupsHead items={sorted.length} lights={sorted.map((a) => lightOf(a.id))} open={sorted.every((a) => groups.isOpen(a.id))} onAll={(o) => groups.setAll(sorted.map((a) => a.id), o)} />
          <div className="areas">
            {sorted.map((a) => {
              const ts = tasksOf(a.id);
              const o = ts.filter((t) => t.status === 'open');
              const overdue = o.filter((t) => t.due_date && t.due_date < today).length;
              return (
                <AccountGroup key={a.id} light={lightOf(a.id)} name={a.name} sub={a.am_name ? `AM ${a.am_name}` : undefined} open={groups.isOpen(a.id)} onToggle={() => groups.toggle(a.id)}
                  summary={o.length ? `${o.length} open${overdue ? ` · ${overdue} overdue` : ''}${o[0] ? ` · next: ${o[0].title}` : ''}` : ts.length ? `All done${ts.some((t) => t.status === 'done') ? ` (${ts.filter((t) => t.status === 'done').length})` : ''}` : 'Nothing from the client'}
                  nums={<><span className="num"><span className="k">Open</span><span className="v">{o.length}</span></span><span className={`num ${overdue ? 'crit' : ''}`}><span className="k">Overdue</span><span className="v">{overdue}</span></span></>}
                  right={<>{!a.client_slack_channel && !a.client_domain && <span className="badge muted" title="No client channel or domain on the account: only manual tasks">no sources</span>}{overdue ? <span className="badge crit">{overdue}</span> : o.length ? <span className="badge warn">{o.length}</span> : null}</>}>
                  {groups.isOpen(a.id) && <TaskList accountId={a.id} tasks={ts} today={today} range={{ from: data.from, to: data.to }} busy={busy} run={run} isAdmin={isAdmin} />}
                </AccountGroup>
              );
            })}
          </div>
        </>
      )}
    </>
  );
}

function TaskList({ accountId, tasks, today, range, busy, run, isAdmin }: { accountId: number; tasks: ClientTask[]; today: string; range: { from: string; to: string }; busy: string | null; run: <T extends ClientTasksData>(key: string, fn: () => Promise<T>, after?: (r: T) => void) => Promise<void>; isAdmin: boolean }) {
  const [openId, setOpenId] = useState<number | null>(null);
  const [add, setAdd] = useState({ title: '', detail: '', due_date: '' });
  const [showAdd, setShowAdd] = useState(false);
  const win = { from: range.from, to: range.to };
  const update = (t: ClientTask, patch: Parameters<typeof api.clientTaskUpdate>[1]) => run(`t${t.id}`, () => api.clientTaskUpdate(t.id, { ...patch, ...win }));
  const dueBadge = (t: ClientTask) => {
    if (!t.due_date) return <span className="badge muted" title="No due date yet">no date</span>;
    if (t.status !== 'open') return <span className="badge muted">{t.due_date}</span>;
    if (t.due_date < today) return <span className="badge crit">overdue {t.due_date}</span>;
    if (t.due_date === today) return <span className="badge warn">due today</span>;
    return <span className="badge muted">due {t.due_date}</span>;
  };
  const byStatus = (st: ClientTask['status']) => tasks.filter((t) => t.status === st);
  const row = (t: ClientTask) => (
    <li key={t.id} className={`ctask ${t.status}`}>
      <label className={`tick ${t.status === 'done' ? 'on' : ''}`} title={t.status === 'done' ? `Done by ${t.completed_by ?? 'someone'} ${fmtRelative(t.completed_at)}` : 'Tick when done'}>
        <input type="checkbox" checked={t.status === 'done'} disabled={busy === `t${t.id}` || t.status === 'dismissed'} onChange={(e) => update(t, { status: e.target.checked ? 'done' : 'open' })} />
      </label>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="page-head" style={{ marginBottom: 0, cursor: 'pointer' }} onClick={() => setOpenId(openId === t.id ? null : t.id)}>
          <span><b>{t.title}</b> <span className="sub">· {SOURCE[t.source]}{t.created_by && t.source === 'manual' ? ` by ${t.created_by}` : ''} {fmtRelative(t.created_at)}</span></span>
          <span className="actions" style={{ alignItems: 'center' }}>{dueBadge(t)}{t.due_source === 'context' && t.due_date && <span className="sub" title="Date taken from the conversation">from chat</span>}<span className="sub">{openId === t.id ? '▾' : '▸'}</span></span>
        </div>
        {openId === t.id && (
          <div className="ctask-detail">
            {t.detail ? <p style={{ whiteSpace: 'pre-wrap', margin: '6px 0' }}>{t.detail}</p> : <p className="sub" style={{ margin: '6px 0' }}>No further context.</p>}
            {t.source_url && <p style={{ margin: '0 0 6px' }}><a href={t.source_url} target="_blank" rel="noreferrer">Open the source</a></p>}
            <div className="inline-form" style={{ alignItems: 'flex-end' }}>
              <label className="field" style={{ minWidth: 150 }}><span className="lbl">Due date</span><input type="date" defaultValue={t.due_date ?? ''} disabled={!isAdmin && t.status !== 'open'} onBlur={(e) => { if ((e.target.value || null) !== t.due_date) void update(t, { due_date: e.target.value || null }); }} /></label>
              {t.status === 'open' && <button className="small" disabled={busy === `t${t.id}`} onClick={() => update(t, { status: 'dismissed' })} title="Not a task after all; keeps it out of the list">Dismiss</button>}
              {t.status === 'dismissed' && <button className="small" disabled={busy === `t${t.id}`} onClick={() => update(t, { status: 'open' })}>Reopen</button>}
              {isAdmin && <button className="small danger" disabled={busy === `t${t.id}`} onClick={() => window.confirm('Delete this task?') && run(`t${t.id}`, () => api.clientTaskDelete(t.id, win.from, win.to))}>Delete</button>}
            </div>
          </div>
        )}
      </div>
    </li>
  );
  return (
    <div>
      {tasks.length === 0 ? <p className="sub">No client tasks in this range.</p> : (
        <>
          {byStatus('open').length > 0 && <ul className="ctasks">{byStatus('open').map(row)}</ul>}
          {byStatus('done').length > 0 && <><div className="sub" style={{ margin: '8px 0 4px', fontWeight: 700 }}>Done</div><ul className="ctasks">{byStatus('done').map(row)}</ul></>}
          {byStatus('dismissed').length > 0 && <details style={{ marginTop: 6 }}><summary className="sub" style={{ cursor: 'pointer' }}>Dismissed ({byStatus('dismissed').length})</summary><ul className="ctasks">{byStatus('dismissed').map(row)}</ul></details>}
        </>
      )}
      {showAdd ? (
        <div className="inline-form card" style={{ marginTop: 8, alignItems: 'flex-end' }}>
          <label className="field" style={{ flex: 1, minWidth: 220 }}><span className="lbl">Task</span><input type="text" value={add.title} autoFocus onChange={(e) => setAdd({ ...add, title: e.target.value })} placeholder="e.g. Send the Q4 sample plan to Marta" /></label>
          <label className="field" style={{ flex: 2, minWidth: 220 }}><span className="lbl">Context (optional)</span><input type="text" value={add.detail} onChange={(e) => setAdd({ ...add, detail: e.target.value })} placeholder="what was agreed, where" /></label>
          <label className="field" style={{ minWidth: 150 }}><span className="lbl">Due</span><input type="date" value={add.due_date} onChange={(e) => setAdd({ ...add, due_date: e.target.value })} /></label>
          <button className="primary small" disabled={!add.title.trim() || busy === 'add'} onClick={() => run('add', () => api.clientTaskCreate({ account_id: accountId, title: add.title.trim(), detail: add.detail, due_date: add.due_date || null, ...win }), () => { setAdd({ title: '', detail: '', due_date: '' }); setShowAdd(false); })}>Add</button>
          <button className="small" onClick={() => setShowAdd(false)}>Cancel</button>
        </div>
      ) : <button className="small" style={{ marginTop: 8 }} onClick={() => setShowAdd(true)}>+ Add a task</button>}
    </div>
  );
}
