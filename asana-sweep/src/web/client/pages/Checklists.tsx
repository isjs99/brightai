import { useCallback, useEffect, useState } from 'react';
import type { AccountStatusRow, Check, CheckSettings, CheckWithItems } from '../../../sweep/types';
import { api, fmtDate, fmtRelative } from '../api';

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
    case 'empty': return <span className="badge muted">No tasks due</span>;
    case 'unlinked': return <span className="badge muted">Not linked</span>;
    case 'error': return <span className="badge crit">Error</span>;
  }
}

function CheckDetail({ checkId }: { checkId: number }) {
  const [check, setCheck] = useState<CheckWithItems | null>(null);
  useEffect(() => { api.getCheck(checkId).then((r) => setCheck(r.check)); }, [checkId]);
  if (!check) return <p className="sub">Loading…</p>;
  const stateLabel: Record<string, string> = { done: 'Done', pending: 'Pending', not_due: 'Not due today', stale: 'Old copy' };
  const flagLabel: Record<string, string> = { no_repeat: 'no new copy: repeat not set?', no_due_date: 'no due date', overdue: 'overdue' };
  return (
    <>
      {check.error_message && <div className="banner crit">{check.error_message}</div>}
      {check.warnings.length > 0 && <div className="banner warn">{check.warnings.map((w, i) => <div key={i}>{w}</div>)}</div>}
      {check.items.length === 0 ? <p className="sub">No tasks found.</p> : (
        <ul className="item-list">
          {check.items.map((it) => (
            <li key={it.task_gid}>
              <span className={`badge ${it.state === 'done' ? 'good' : it.state === 'pending' ? 'crit' : 'muted'}`}>{stateLabel[it.state]}</span>
              <div>
                <b>{it.name}</b> <span className="sub">· {it.role.toUpperCase()} · {it.assignee_name ?? 'unassigned'}{it.section_name ? ` · ${it.section_name}` : ''}{it.due_on ? ` · due ${it.due_on}` : ''}</span>
                {it.flags.map((f) => <span key={f} className="flag">{flagLabel[f]}</span>)}
                {it.subtasks.length > 0 && (
                  <ul>
                    {it.subtasks.map((s) => (
                      <li key={s.task_gid} className="sub">{s.done ? '☑' : '☐'} {s.name} <span className="sub">· {s.role.toUpperCase()} · {s.assignee_name ?? 'unassigned'}</span></li>
                    ))}
                  </ul>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </>
  );
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
    <form className="card inline-form" onSubmit={save} style={{ marginBottom: 16 }}>
      <label className="field"><span className="lbl">Check time (cron)</span><input type="text" className="mono" value={form.check_cron} onChange={(e) => setForm({ ...form, check_cron: e.target.value })} /><span className="help">{settings.schedule_text}</span></label>
      <label className="field"><span className="lbl">Timezone</span><select value={form.check_timezone} onChange={(e) => setForm({ ...form, check_timezone: e.target.value })}>{tzs.map((tz) => <option key={tz}>{tz}</option>)}</select></label>
      <label className="field" style={{ flex: 1, minWidth: 260 }}><span className="lbl">Slack webhook for the daily digest</span><input type="url" value={form.check_slack_webhook} onChange={(e) => setForm({ ...form, check_slack_webhook: e.target.value })} placeholder="https://hooks.slack.com/services/…" /></label>
      <label className="field check"><input type="checkbox" checked={form.check_enabled} onChange={(e) => setForm({ ...form, check_enabled: e.target.checked })} /><span>Scheduled</span></label>
      <button className="primary" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
      {error && <span className="error">{error}</span>}
    </form>
  );
}

export default function Checklists() {
  const [date, setDate] = useState<string | undefined>(undefined);
  const [data, setData] = useState<{ date: string; today: string; rows: AccountStatusRow[]; dates: string[] } | null>(null);
  const [settings, setSettings] = useState<CheckSettings | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [open, setOpen] = useState<number | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [filterAm, setFilterAm] = useState('');

  const load = useCallback(() => {
    api.listChecks(date).then(setData).catch((e) => setError((e as Error).message));
    api.getCheckSettings().then((r) => setSettings(r.settings)).catch(() => undefined);
  }, [date]);
  useEffect(() => { load(); }, [load]);

  const runAll = async () => {
    setRunning(true);
    setError(null);
    try { await api.runChecks(); setDate(undefined); load(); } catch (e) { setError((e as Error).message); } finally { setRunning(false); }
  };

  const checkOne = async (id: number) => {
    setBusy(id);
    try { await api.checkAccount(id); load(); } catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  };

  const order: Record<string, number> = { none: 0, partial: 1, error: 2, complete: 3, empty: 4, unlinked: 5 };
  const rows = (data?.rows ?? [])
    .filter((r) => r.account.enabled && (!filterAm || (r.account.am_name ?? 'Unassigned') === filterAm))
    .sort((a, b) => (a.check ? order[a.check.status] : 6) - (b.check ? order[b.check.status] : 6) || a.account.name.localeCompare(b.account.name));
  const linked = rows.filter((r) => r.check && r.check.status !== 'unlinked');
  const complete = linked.filter((r) => r.check!.combined_complete).length;
  const amDone = linked.filter((r) => r.check!.am_complete).length;
  const aaDone = linked.filter((r) => r.check!.aa_complete).length;
  const ams = [...new Set((data?.rows ?? []).map((r) => r.account.am_name ?? 'Unassigned'))].sort();
  const isToday = data && data.date === data.today;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Checklist status</h1>
          <p className="hint" style={{ margin: 0 }}>
            {settings ? <>Checked automatically {settings.schedule_text}{settings.next_run_at ? `, next ${fmtRelative(settings.next_run_at)}` : ' (paused)'}.</> : ''}{' '}
            <a href="#" onClick={(e) => { e.preventDefault(); setShowSettings((s) => !s); }}>{showSettings ? 'Hide settings' : 'Settings'}</a>
          </p>
        </div>
        <div className="actions">
          <button className="primary" onClick={runAll} disabled={running}>{running ? 'Checking all accounts…' : 'Check all now'}</button>
        </div>
      </div>
      {error && <div className="banner crit">{error}</div>}
      {showSettings && settings && <SettingsPanel settings={settings} onSaved={setSettings} />}

      <div className="toolbar">
        <select value={data?.date ?? ''} onChange={(e) => setDate(e.target.value || undefined)}>
          {data && !data.dates.includes(data.today) && <option value={data.today}>{data.today} (today)</option>}
          {(data?.dates ?? []).map((d) => <option key={d} value={d}>{d}{d === data?.today ? ' (today)' : ''}</option>)}
        </select>
        <select value={filterAm} onChange={(e) => setFilterAm(e.target.value)}>
          <option value="">All AMs</option>
          {ams.map((a) => <option key={a} value={a}>{a}</option>)}
        </select>
      </div>

      <div className="kpis">
        <div className="kpi"><div className="v">{complete}/{linked.length}</div><div className="k">accounts fully complete</div></div>
        <div className="kpi"><div className="v">{amDone}/{linked.length}</div><div className="k">AM checklists complete</div></div>
        <div className="kpi"><div className="v">{aaDone}/{linked.length}</div><div className="k">AA actions complete</div></div>
        <div className="kpi"><div className="v">{rows.length - linked.length}</div><div className="k">not linked or not checked</div></div>
      </div>

      {data === null ? <p>Loading…</p> : (
        <table>
          <thead>
            <tr><th>Account</th><th>AM</th><th>Status</th><th className="num">AM</th><th className="num">AA</th><th className="hide-sm">Flags</th><th className="hide-sm">Checked</th><th></th></tr>
          </thead>
          <tbody>
            {rows.map(({ account: a, check: c }) => (
              <RowGroup key={a.id} a={a} c={c} open={open === a.id} onToggle={() => setOpen(open === a.id ? null : a.id)} onCheck={isToday ? () => checkOne(a.id) : undefined} busy={busy === a.id} />
            ))}
          </tbody>
        </table>
      )}
      <p className="hint" style={{ marginTop: 12 }}>
        AM = tasks assigned to the account manager. AA = everything else, including subtasks. An account is complete when both are. Weekly checks only count on the day they are due.
      </p>
    </>
  );
}

function RowGroup({ a, c, open, onToggle, onCheck, busy }: { a: AccountStatusRow['account']; c: Check | null; open: boolean; onToggle: () => void; onCheck?: () => void; busy: boolean }) {
  const flags = c?.warnings.length ?? 0;
  return (
    <>
      <tr className={c ? 'clickable' : ''} onClick={c ? onToggle : undefined}>
        <td><b>{a.name}</b><div className="sub">{a.asana_project_gid ? a.asana_project_name : 'no project linked'}</div></td>
        <td>{a.am_name ?? <span className="sub">none</span>}</td>
        <td><StatusPill check={c} /></td>
        <td className="num">{c && c.status !== 'unlinked' ? <Frac done={c.am_done} total={c.am_total} complete={c.am_complete} /> : ''}</td>
        <td className="num">{c && c.status !== 'unlinked' ? <Frac done={c.aa_done} total={c.aa_total} complete={c.aa_complete} /> : ''}</td>
        <td className="hide-sm">{flags ? <span className="badge crit">{flags} warning{flags > 1 ? 's' : ''}</span> : c?.error_message ? <span className="sub">{c.error_message}</span> : ''}</td>
        <td className="hide-sm sub" title={c ? fmtDate(c.checked_at) : ''}>{c ? fmtRelative(c.checked_at) : ''}</td>
        <td onClick={(e) => e.stopPropagation()}>{onCheck && a.asana_project_gid && <button className="small" disabled={busy} onClick={onCheck}>{busy ? '…' : 'Check now'}</button>}</td>
      </tr>
      {open && c && (
        <tr className="expand"><td colSpan={8}><CheckDetail checkId={c.id} /></td></tr>
      )}
    </>
  );
}
