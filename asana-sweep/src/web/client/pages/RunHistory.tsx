import { useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import type { Run, RunItem, RuleSummary } from '../../../sweep/types';
import { api, fmtDate, fmtRelative } from '../api';
import { ItemsTable, StatusBadge, Warnings } from '../components';

export default function RunHistory() {
  const { id } = useParams();
  const ruleId = Number(id);
  const [params, setParams] = useSearchParams();
  const [rule, setRule] = useState<RuleSummary | null>(null);
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [items, setItems] = useState<Record<number, RunItem[] | 'loading'>>({});
  const openId = params.get('run') ? Number(params.get('run')) : null;

  useEffect(() => {
    Promise.all([api.getRule(ruleId), api.listRuns(ruleId)])
      .then(([r, l]) => {
        setRule(r.rule);
        setRuns(l.runs);
      })
      .catch((err) => setError((err as Error).message));
  }, [ruleId]);

  useEffect(() => {
    if (openId && !items[openId]) {
      setItems((s) => ({ ...s, [openId]: 'loading' }));
      api.getRun(openId).then(({ items: list }) => setItems((s) => ({ ...s, [openId]: list }))).catch((err) => setError((err as Error).message));
    }
  }, [openId, items]);

  const toggle = (runId: number) => {
    if (openId === runId) setParams({});
    else setParams({ run: String(runId) });
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Run history</h1>
          {rule && (
            <p className="hint" style={{ margin: 0 }}>
              <b>{rule.name}</b> · {rule.asana_project_name || rule.asana_project_gid} · {rule.schedule_text}
              {rule.dry_run ? <> · <span className="badge warn">Dry run</span></> : <> · <span className="badge crit">Live</span></>}
            </p>
          )}
        </div>
        <div className="actions">
          <Link className="btn" to={`/rules/${ruleId}`}>Edit rule</Link>
          <Link className="btn" to="/">Back to rules</Link>
        </div>
      </div>
      {error && <div className="banner crit">{error}</div>}
      <p className="hint">Click a run to see every task it looked at and what it did with it. Runs are kept for 90 days.</p>
      {runs === null ? (
        <p>Loading…</p>
      ) : runs.length === 0 ? (
        <div className="empty">No runs yet. Use "Run now" on the rules list, or wait for the schedule.</div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Started</th>
              <th>Status</th>
              <th className="hide-sm">Trigger</th>
              <th className="num">Scanned</th>
              <th className="num">Matched</th>
              <th className="num">Deleted</th>
              <th className="hide-sm">Notes</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((run) => {
              const open = openId === run.id;
              const loaded = items[run.id];
              return (
                <RunRows key={run.id} run={run} open={open} loaded={loaded} onToggle={() => toggle(run.id)} projectGid={rule?.asana_project_gid} />
              );
            })}
          </tbody>
        </table>
      )}
    </>
  );
}

function RunRows({ run, open, loaded, onToggle, projectGid }: { run: Run; open: boolean; loaded: RunItem[] | 'loading' | undefined; onToggle: () => void; projectGid?: string }) {
  return (
    <>
      <tr className="clickable" onClick={onToggle}>
        <td className="nowrap">
          {fmtDate(run.started_at)}
          <div className="sub">{fmtRelative(run.started_at)}</div>
        </td>
        <td><StatusBadge status={run.status} /></td>
        <td className="hide-sm">{run.trigger === 'manual' ? 'Run now' : 'Schedule'}</td>
        <td className="num">{run.scanned_count}</td>
        <td className="num">{run.matched_count}</td>
        <td className="num">{run.deleted_count}</td>
        <td className="hide-sm sub">
          {run.error_message && <div className="error">{run.error_message}</div>}
          {run.warnings.length > 0 && <div>{run.warnings.length} warning{run.warnings.length > 1 ? 's' : ''}</div>}
          {run.status === 'dry_run' && <div>{run.matched_count} would have been deleted</div>}
        </td>
      </tr>
      {open && (
        <tr className="expand">
          <td colSpan={7}>
            <Warnings warnings={run.warnings} />
            {loaded === 'loading' || loaded === undefined ? <p className="sub">Loading items…</p> : <ItemsTable items={loaded} projectGid={projectGid} />}
          </td>
        </tr>
      )}
    </>
  );
}
