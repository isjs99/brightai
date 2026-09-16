import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { RuleSummary } from '../../../sweep/types';
import { api, fmtDate, fmtRelative } from '../api';
import { StatusBadge } from '../components';

export default function RulesList() {
  const [rules, setRules] = useState<RuleSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const navigate = useNavigate();

  const load = useCallback(async () => {
    try {
      setRules((await api.listRules()).rules);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 30000);
    return () => clearInterval(t);
  }, [load]);

  const replace = (rule: RuleSummary) => setRules((rs) => (rs ?? []).map((r) => (r.id === rule.id ? rule : r)));

  const toggle = async (rule: RuleSummary, key: 'enabled' | 'dry_run') => {
    const next = !rule[key];
    if (key === 'dry_run' && !next) {
      const ok = window.confirm(
        `Take "${rule.name}" LIVE?\n\nFrom the next run on, matched completed tasks in "${rule.asana_project_name || rule.asana_project_gid}" will really be deleted from Asana. Check the last dry run or a preview first.`,
      );
      if (!ok) return;
    }
    setBusy(rule.id);
    try {
      replace((await api.patchRule(rule.id, { [key]: next })).rule);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const runNow = async (rule: RuleSummary) => {
    if (!rule.dry_run && !window.confirm(`Run "${rule.name}" now? This rule is LIVE and will delete matched tasks.`)) return;
    setBusy(rule.id);
    setNotice(null);
    try {
      const { run, rule: updated } = await api.runRule(rule.id);
      replace(updated);
      const what = run.status === 'dry_run' ? `${run.matched_count} would be deleted` : `${run.deleted_count} deleted`;
      setNotice(`${rule.name}: ${run.status === 'error' ? `error: ${run.error_message}` : `${run.scanned_count} scanned, ${what}.`}`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const duplicate = async (rule: RuleSummary) => {
    setBusy(rule.id);
    try {
      const { rule: copy } = await api.duplicateRule(rule.id);
      navigate(`/rules/${copy.id}`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(null);
    }
  };

  const remove = async (rule: RuleSummary) => {
    if (!window.confirm(`Delete the rule "${rule.name}" and its run history? This does not touch Asana.`)) return;
    setBusy(rule.id);
    try {
      await api.deleteRule(rule.id);
      setRules((rs) => (rs ?? []).filter((r) => r.id !== rule.id));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Rules</h1>
          <p className="hint" style={{ margin: 0 }}>One rule per Asana project. Each run deletes completed tasks that have an incomplete twin with the same name.</p>
        </div>
        <Link to="/rules/new" className="btn">+ New rule</Link>
      </div>
      {error && <div className="banner crit">{error}</div>}
      {notice && <div className="banner info">{notice}</div>}
      {rules === null ? (
        <p>Loading…</p>
      ) : rules.length === 0 ? (
        <div className="empty">No rules yet. <Link to="/rules/new">Create one</Link>.</div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Project</th>
              <th className="hide-sm">Schedule</th>
              <th>Enabled</th>
              <th>Mode</th>
              <th className="hide-sm">Last run</th>
              <th className="hide-sm">Next run</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rules.map((r) => (
              <tr key={r.id}>
                <td>
                  <Link to={`/rules/${r.id}`}><b>{r.name}</b></Link>
                  <div className="sub">{r.asana_project_name || <span className="mono">{r.asana_project_gid}</span>}</div>
                </td>
                <td className="hide-sm">
                  {r.schedule_text}
                  <div className="sub mono">{r.cron}</div>
                </td>
                <td>
                  <label className="toggle">
                    <input type="checkbox" checked={r.enabled} disabled={busy === r.id} onChange={() => toggle(r, 'enabled')} />
                    {r.enabled ? 'On' : 'Off'}
                  </label>
                </td>
                <td>
                  <label className="toggle">
                    <input type="checkbox" checked={!r.dry_run} disabled={busy === r.id} onChange={() => toggle(r, 'dry_run')} />
                    {r.dry_run ? <span className="badge warn">Dry run</span> : <span className="badge crit">Live</span>}
                  </label>
                </td>
                <td className="hide-sm">
                  {r.is_running ? (
                    <span className="badge accent">Running…</span>
                  ) : r.last_run ? (
                    <>
                      <StatusBadge status={r.last_run.status} />{' '}
                      <span className="sub">
                        {r.last_run.status === 'error'
                          ? r.last_run.error_message
                          : `${r.last_run.scanned_count} scanned, ${r.last_run.status === 'dry_run' ? `${r.last_run.matched_count} would delete` : `${r.last_run.deleted_count} deleted`}`}
                      </span>
                      <div className="sub" title={fmtDate(r.last_run.started_at)}>{fmtRelative(r.last_run.started_at)} · <Link to={`/rules/${r.id}/runs`}>history</Link></div>
                    </>
                  ) : (
                    <span className="sub">never · <Link to={`/rules/${r.id}/runs`}>history</Link></span>
                  )}
                </td>
                <td className="hide-sm">
                  {r.next_run_at ? (
                    <>
                      {fmtDate(r.next_run_at)}
                      <div className="sub">{fmtRelative(r.next_run_at)}</div>
                    </>
                  ) : (
                    <span className="sub">paused</span>
                  )}
                </td>
                <td>
                  <div className="actions">
                    <button className="small" disabled={busy === r.id || r.is_running} onClick={() => runNow(r)}>
                      {busy === r.id ? 'Working…' : 'Run now'}
                    </button>
                    <Link className="btn small" to={`/rules/${r.id}`}>Edit</Link>
                    <button className="small" disabled={busy === r.id} onClick={() => duplicate(r)}>Duplicate</button>
                    <button className="small danger" disabled={busy === r.id} onClick={() => remove(r)}>Delete</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
