import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { AccountStatusRow, Check, CheckItem, CheckSettings, CheckWithItems, MonitorData, MonitorFlag } from '../../../sweep/types';
import { api, currentActor, fmtDate, fmtRelative, useLiveUpdates } from '../api';
import { useIsAdmin } from '../session';

function Frac({ done, total, complete }: { done: number; total: number; complete: boolean }) {
  if (total === 0) return <span className="frac sub">0/0</span>;
  return <span className={`frac ${complete ? 'ok' : 'bad'}`}>{done}/{total}</span>;
}

export function StatusPill({ check }: { check: Check | null }) {
  if (!check) return <span className="badge muted">not checked</span>;
  switch (check.status) {
    case 'complete': return <span className="badge good">✓ Complete</span>;
    case 'partial': return <span className="badge warn">◐ Partial</span>;
    case 'none': return <span className="badge crit">○ Nothing done</span>;
    case 'empty': return <span className="badge muted">No items due</span>;
    case 'unlinked': return <span className="badge muted">No items</span>;
    case 'error': return <span className="badge crit">Error</span>;
  }
}

const DAY_NAMES = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/**
 * The checklist itself: every line due on the date with a checkbox, the AA action items underneath.
 * Ticks go straight to the server and the status updates live for everyone.
 */
/** Open monitor flags for one account, keyed by the checklist section their rule belongs to. */
type SectionFlags = Map<string, { flag: MonitorFlag; title: string }[]>;

function flagsBySection(monitor: MonitorData | null, accountId: number): SectionFlags {
  const out: SectionFlags = new Map();
  if (!monitor) return out;
  for (const f of monitor.flags) {
    if (f.account_id !== accountId) continue;
    const rule = monitor.rules.find((r) => r.code === f.code);
    const section = rule?.section ?? 'Account health';
    out.set(section, [...(out.get(section) ?? []), { flag: f, title: rule?.title ?? f.code }]);
  }
  return out;
}

function SectionFlagList({ items }: { items: { flag: MonitorFlag; title: string }[] }) {
  return (
    <ul className="flaglist">
      {items.map(({ flag, title }) => (
        <li key={flag.id} className={flag.severity}>
          <span className={`badge ${flag.severity === 'crit' ? 'crit' : flag.severity === 'warn' ? 'warn' : 'muted'}`}>{flag.severity === 'crit' ? 'Critical' : flag.severity === 'warn' ? 'Warning' : 'Info'}</span>
          <span><b>{title}.</b> {flag.message}{flag.detail ? <span className="sub"> · {flag.detail}</span> : null}</span>
        </li>
      ))}
    </ul>
  );
}

function TickList({ accountId, check, date, editable, onChange, flags }: { accountId: number; check: CheckWithItems; date: string; editable: boolean; onChange: (c: CheckWithItems) => void; flags: SectionFlags }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const toggle = async (itemId: string, done: boolean) => {
    setBusy(itemId);
    setError(null);
    try {
      const r = await api.tick({ account_id: accountId, item_id: Number(itemId), done, date });
      onChange(r.check);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const all = async (done: boolean, role?: 'am' | 'aa') => {
    setBusy('all');
    setError(null);
    try { onChange((await api.tickAll({ account_id: accountId, done, role, date })).check); } catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  };
  const due = check.items.filter((i) => i.state !== 'not_due');
  const later = check.items.filter((i) => i.state === 'not_due');
  const label = (it: CheckItem) => (it.state === 'done' ? 'Done' : it.state === 'pending' && it.completed_at ? 'Waiting on AA' : it.state === 'pending' ? 'To do' : 'Not today');
  const total = check.am_total + check.aa_total;
  const ticked = check.am_done + check.aa_done;
  const box = (id: string, done: boolean, label: React.ReactNode, sub?: React.ReactNode) => (
    <label className={`tick ${done ? 'on' : ''}`}>
      <input type="checkbox" checked={done} disabled={!editable || busy !== null} onChange={(e) => toggle(id, e.target.checked)} />
      <span>{label}{sub}</span>
    </label>
  );
  return (
    <div className="ticklist">
      {error && <div className="banner crit">{error}</div>}
      {check.error_message && <div className="banner crit">{check.error_message}</div>}
      {due.length > 0 && (check.combined_complete
        ? <div className="banner good" style={{ marginBottom: 8 }}><b>List done.</b> Every box is ticked, AM and AA.</div>
        : <p className="sub" style={{ margin: '0 0 8px' }}>{ticked} of {total} boxes ticked. The list is done when every box is ticked, the AM checks and the AA action items underneath.</p>)}
      {editable && due.length > 0 && (
        <div className="actions" style={{ marginBottom: 8 }}>
          <button className="small" disabled={busy !== null} onClick={() => all(true, 'am')}>Tick all AM lines</button>
          <button className="small" disabled={busy !== null} onClick={() => all(true, 'aa')}>Tick all AA actions</button>
          <button className="small" disabled={busy !== null} onClick={() => all(true)}>Tick everything</button>
          <button className="small" disabled={busy !== null} onClick={() => { if (window.confirm('Untick every line for this day?')) void all(false); }}>Clear day</button>
        </div>
      )}
      {due.length === 0 ? <p className="sub">Nothing is due on this day.</p> : (
        <ul className="item-list">
          {due.map((it: CheckItem, idx: number) => (
            <li key={it.task_gid}>
              <span className={`badge ${it.state === 'done' ? 'good' : it.completed_at ? 'warn' : 'crit'}`}>{label(it)}</span>
              <div>
                {box(it.task_gid, Boolean(it.completed_at), <b>{it.name}</b>, <span className="sub"> · {it.role.toUpperCase()}{it.section_name ? ` · ${it.section_name}` : ''}{it.frequency === 'weekly' ? ' · weekly' : ''}{it.completed_at ? ` · ${it.assignee_name ?? 'someone'} ${fmtRelative(it.completed_at)}` : ''}</span>)}
                {it.guidance && <div className="guidance">{it.guidance}</div>}
                {it.section_name && flags.has(it.section_name) && due.findIndex((x) => x.section_name === it.section_name) === idx && <SectionFlagList items={flags.get(it.section_name)!} />}
                {it.subtasks.length > 0 && (
                  <ul>
                    {it.subtasks.map((s) => (
                      <li key={s.task_gid}>{box(s.task_gid, s.done, s.name, <span className="sub"> · {s.role.toUpperCase()}{s.frequency === 'weekly' ? ' · weekly' : ''}{s.completed_at ? ` · ${s.assignee_name ?? 'someone'} ${fmtRelative(s.completed_at)}` : ''}</span>)}</li>
                    ))}
                  </ul>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {later.length > 0 && <p className="sub" style={{ marginTop: 8 }}>Not due today: {later.map((i) => i.name).join(' · ')}</p>}
      {[...flags.entries()].filter(([section]) => !due.some((i) => i.section_name === section)).map(([section, items]) => (
        <div key={section} style={{ marginTop: 8 }}><div className="sub" style={{ fontWeight: 700 }}>Flags · {section}</div><SectionFlagList items={items} /></div>
      ))}
    </div>
  );
}

function CheckDetail({ accountId, checkId, date, isToday, version, editable, monitor }: { accountId: number; checkId: number; date: string; isToday: boolean; version: string; editable: boolean; monitor: MonitorData | null }) {
  const [check, setCheck] = useState<CheckWithItems | null>(null);
  useEffect(() => {
    // Today: the live picture (negative ids are live rows). Past days: the recorded check.
    const p = isToday ? api.getLiveCheck(accountId).catch(() => (checkId > 0 ? api.getCheck(checkId) : Promise.reject(new Error('no live status')))) : api.getCheck(checkId);
    p.then((r) => setCheck(r.check)).catch(() => setCheck(null));
  }, [checkId, accountId, version, isToday]);
  if (!check) return <p className="sub">Loading…</p>;
  return <TickList accountId={accountId} check={check} date={date} editable={editable} onChange={setCheck} flags={isToday ? flagsBySection(monitor, accountId) : new Map()} />;
}

function SettingsPanel({ settings, onSaved }: { settings: CheckSettings; onSaved: (s: CheckSettings) => void }) {
  const [form, setForm] = useState(settings);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tzs, setTzs] = useState<string[]>([settings.check_timezone]);
  useEffect(() => { api.meta().then((m) => setTzs(m.timezones)).catch(() => undefined); }, []);
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api.saveCheckSettings({ check_cron: form.check_cron, check_timezone: form.check_timezone, check_enabled: form.check_enabled, check_slack_webhook: form.check_slack_webhook });
      onSaved(r.settings);
      setForm(r.settings);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="card inline-form admin-only" onSubmit={save} style={{ marginBottom: 16 }}>
      <label className="field"><span className="lbl">Lock time (cron)</span><input type="text" className="mono" value={form.check_cron} onChange={(e) => setForm({ ...form, check_cron: e.target.value })} /><span className="help">{settings.schedule_text}</span></label>
      <label className="field"><span className="lbl">Timezone</span><select value={form.check_timezone} onChange={(e) => setForm({ ...form, check_timezone: e.target.value })}>{tzs.map((tz) => <option key={tz}>{tz}</option>)}</select></label>
      <label className="field" style={{ flex: 1, minWidth: 260 }}><span className="lbl">Slack webhook for the daily digest</span><input type="url" value={form.check_slack_webhook} onChange={(e) => setForm({ ...form, check_slack_webhook: e.target.value })} placeholder="https://hooks.slack.com/services/…" /></label>
      <label className="field check"><input type="checkbox" checked={form.check_enabled} onChange={(e) => setForm({ ...form, check_enabled: e.target.checked })} /><span>Lock the day's record on schedule</span></label>
      <button className="primary" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
      {error && <span className="error">{error}</span>}
    </form>
  );
}

export default function Checklists() {
  const isAdmin = useIsAdmin();
  const [date, setDate] = useState<string | undefined>(undefined);
  const [data, setData] = useState<{ date: string; today: string; rows: AccountStatusRow[]; dates: string[] } | null>(null);
  const [settings, setSettings] = useState<CheckSettings | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [open, setOpen] = useState<Set<number>>(new Set());
  const [filterAm, setFilterAm] = useState(() => currentActor());
  const [version, setVersion] = useState(0);
  const [monitor, setMonitor] = useState<MonitorData | null>(null);

  const load = useCallback(() => {
    api.listChecks(date).then((d) => { setData(d); setVersion((v) => v + 1); }).catch((e) => setError((e as Error).message));
    api.getCheckSettings().then((r) => setSettings(r.settings)).catch(() => undefined);
    // Open monitor flags, shown against the section they belong to so the AM sees the problem while ticking the line.
    api.monitor().then(setMonitor).catch(() => setMonitor(null));
  }, [date]);
  useEffect(() => { load(); }, [load]);
  const connected = useLiveUpdates(() => load());
  const openFlags = (accountId: number) => (monitor?.flags ?? []).filter((f) => f.account_id === accountId);

  const runAll = async () => {
    setRunning(true);
    setError(null);
    try { await api.runChecks(); setDate(undefined); load(); } catch (e) { setError((e as Error).message); } finally { setRunning(false); }
  };

  const isToday = Boolean(data && data.date === data.today);
  const ams = useMemo(() => [...new Set((data?.rows ?? []).map((r) => r.account.am_name ?? 'Unassigned'))].sort(), [data]);
  const amFilter = ams.includes(filterAm) ? filterAm : ams.find((a) => filterAm && a.toLowerCase().startsWith(filterAm.toLowerCase().split(' ')[0])) ?? '';
  // Today shows the live picture (falls back to the recorded check); past days show the record.
  const rows = (data?.rows ?? [])
    .map((r) => ({ ...r, snapshot: r.check, check: isToday ? (r.live ?? r.check) : r.check }))
    .filter((r) => r.account.enabled && (!amFilter || (r.account.am_name ?? 'Unassigned') === amFilter))
    // Stable order (AM, then account) so rows do not jump around while someone is ticking.
    .sort((a, b) => (a.account.am_name ?? 'zz').localeCompare(b.account.am_name ?? 'zz') || a.account.name.localeCompare(b.account.name));
  const counted = rows.filter((r) => r.check && r.check.status !== 'unlinked' && r.check.status !== 'empty');
  const complete = counted.filter((r) => r.check!.combined_complete).length;
  const amDone = counted.filter((r) => r.check!.am_complete).length;
  const aaDone = counted.filter((r) => r.check!.aa_complete).length;
  const lines = rows.reduce((n, r) => n + (r.check ? r.check.am_total + r.check.aa_total : 0), 0);
  const linesDone = rows.reduce((n, r) => n + (r.check ? r.check.am_done + r.check.aa_done : 0), 0);
  const editable = isToday || isAdmin;
  const dayLabel = data ? `${DAY_NAMES[((new Date(data.date + 'T12:00:00Z').getUTCDay() + 6) % 7) + 1]} ${data.date}` : '';

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Checklists</h1>
          <p className="hint" style={{ margin: 0 }}>
            <span className={`badge ${connected ? 'good' : 'muted'}`}>{connected ? '● Live' : '○ Reconnecting'}</span>{' '}
            Tick your lines here as you go; every tick updates the status for everyone. {settings ? <>The day's record is locked {settings.schedule_text}{settings.next_run_at ? ` (next ${fmtRelative(settings.next_run_at)})` : ' (paused)'}.</> : ''}{' '}
            {isAdmin && <a href="#" onClick={(e) => { e.preventDefault(); setShowSettings((s) => !s); }}>{showSettings ? 'Hide settings' : 'Settings'}</a>}
            {isAdmin && <> · <Link to="/checklist-template">Edit the items</Link></>}
          </p>
        </div>
        <div className="actions">
          <button className="small" onClick={() => setOpen(open.size === rows.length ? new Set() : new Set(rows.map((r) => r.account.id)))}>{open.size === rows.length && rows.length ? 'Collapse all' : 'Expand all'}</button>
          <button className="primary admin-only" onClick={runAll} disabled={running}>{running ? 'Recording…' : 'Record status now'}</button>
        </div>
      </div>
      {error && <div className="banner crit">{error}</div>}
      {showSettings && settings && <SettingsPanel settings={settings} onSaved={setSettings} />}

      <div className="toolbar">
        <select value={data?.date ?? ''} onChange={(e) => setDate(e.target.value || undefined)}>
          {data && !data.dates.includes(data.today) && <option value={data.today}>{data.today} (today)</option>}
          {(data?.dates ?? []).map((d) => <option key={d} value={d}>{d}{d === data?.today ? ' (today)' : ''}</option>)}
        </select>
        <select value={amFilter} onChange={(e) => setFilterAm(e.target.value)} title="Pick your name top right and this follows you">
          <option value="">All AMs</option>
          {ams.map((a) => <option key={a} value={a}>{a}</option>)}
        </select>
        {data && <span className="sub">{dayLabel}{!isToday ? ' · past day: the recorded status' : ''}</span>}
      </div>

      <div className="kpis">
        <div className="kpi"><div className="v">{complete}/{counted.length}</div><div className="k">accounts fully complete</div></div>
        <div className="kpi"><div className="v">{amDone}/{counted.length}</div><div className="k">AM checklists complete</div></div>
        <div className="kpi"><div className="v">{aaDone}/{counted.length}</div><div className="k">AA actions complete</div></div>
        <div className="kpi"><div className="v">{linesDone}/{lines}</div><div className="k">lines ticked{amFilter ? ` for ${amFilter}` : ''}</div></div>
      </div>

      {data === null ? <p>Loading…</p> : rows.length === 0 ? <div className="empty">No accounts{amFilter ? ` for ${amFilter}` : ''}.</div> : (
        <table>
          <thead>
            <tr><th></th><th>Account</th><th>AM</th><th>Status</th><th className="num">AM</th><th className="num">AA</th><th className="hide-sm">Updated</th></tr>
          </thead>
          <tbody>
            {rows.map(({ account: a, check: c, snapshot, checklist_source, checklist_items }) => {
              const isOpen = open.has(a.id);
              const toggleOpen = () => { const n = new Set(open); if (isOpen) n.delete(a.id); else n.add(a.id); setOpen(n); };
              return (
                <RowGroup key={a.id} a={a} c={c} source={checklist_source} items={checklist_items} snapshot={isToday && snapshot?.final ? snapshot : null} open={isOpen} onToggle={toggleOpen} flags={isToday ? openFlags(a.id) : []}>
                  {isOpen && c && <CheckDetail accountId={a.id} checkId={c.id} date={data.date} isToday={isToday} version={String(version)} editable={editable} monitor={monitor} />}
                  {isOpen && !c && <p className="sub">No status recorded for this day.</p>}
                </RowGroup>
              );
            })}
          </tbody>
        </table>
      )}
      <p className="hint" style={{ marginTop: 12 }}>
        AM = the account manager's daily checks. AA = the action items underneath (and the Affiliate lines). A check is done only when its box and every action item under it are ticked, and an account is complete when every box is. Weekly lines only appear on their day. Past days can be corrected by an admin.
      </p>
    </>
  );
}

function RowGroup({ a, c, source, items, snapshot, open, onToggle, children, flags }: { a: AccountStatusRow['account']; c: Check | null; source: AccountStatusRow['checklist_source']; items: number; snapshot: Check | null; open: boolean; onToggle: () => void; children?: React.ReactNode; flags: MonitorFlag[] }) {
  const crit = flags.filter((f) => f.severity === 'crit').length;
  const warn = flags.filter((f) => f.severity === 'warn').length;
  return (
    <>
      <tr className="clickable" onClick={onToggle}>
        <td style={{ width: 24 }}><button className="small" onClick={(e) => { e.stopPropagation(); onToggle(); }} aria-label={open ? 'Collapse' : 'Expand'}>{open ? '−' : '+'}</button></td>
        <td><b>{a.name}</b>{crit > 0 && <span className="badge crit" style={{ marginLeft: 6 }} title={flags.filter((f) => f.severity === 'crit').map((f) => f.message).join('\n')}>{crit} critical</span>}{warn > 0 && <span className="badge warn" style={{ marginLeft: 6 }} title={flags.filter((f) => f.severity === 'warn').map((f) => f.message).join('\n')}>{warn} warn</span>}<div className="sub">{source === 'custom' ? `own list · ${items} lines` : source === 'template' ? `${items} lines` : 'no checklist items'}</div></td>
        <td>{a.am_name ?? <span className="sub">none</span>}</td>
        <td>
          <StatusPill check={c} />
          {snapshot && snapshot.status !== c?.status && <div className="sub" title="Status when the day's record was locked">at lock: {snapshot.status.replace('_', ' ')}</div>}
        </td>
        <td className="num">{c && c.status !== 'unlinked' ? <Frac done={c.am_done} total={c.am_total} complete={c.am_complete} /> : ''}</td>
        <td className="num">{c && c.status !== 'unlinked' ? <Frac done={c.aa_done} total={c.aa_total} complete={c.aa_complete} /> : ''}</td>
        <td className="hide-sm sub" title={c ? fmtDate(c.checked_at) : ''}>{c ? fmtRelative(c.checked_at) : ''}</td>
      </tr>
      {open && (
        <tr className="expand"><td colSpan={7}>{children}</td></tr>
      )}
    </>
  );
}
