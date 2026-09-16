import type { PreviewItem, RunItem, RunItemAction, RunStatus } from '../../sweep/types';
import { fmtDate, fmtRelative } from './api';

export function StatusBadge({ status }: { status: RunStatus }) {
  const map: Record<RunStatus, { cls: string; label: string }> = {
    ok: { cls: 'good', label: 'OK' },
    dry_run: { cls: 'warn', label: 'Dry run' },
    error: { cls: 'crit', label: 'Error' },
    running: { cls: 'accent', label: 'Running' },
  };
  const m = map[status] ?? { cls: 'muted', label: status };
  return <span className={`badge ${m.cls}`}>{m.label}</span>;
}

const ACTION_LABELS: Record<RunItemAction, { cls: string; label: string }> = {
  deleted: { cls: 'crit', label: 'Deleted' },
  would_delete: { cls: 'warn', label: 'Would delete' },
  delete_failed: { cls: 'crit', label: 'Delete failed' },
  skipped_no_twin: { cls: 'muted', label: 'Skipped: no twin (one-off)' },
  skipped_too_recent: { cls: 'muted', label: 'Skipped: too recent' },
  skipped_section_mismatch: { cls: 'muted', label: 'Skipped: section mismatch' },
};

export function ActionBadge({ action }: { action: RunItemAction }) {
  const m = ACTION_LABELS[action] ?? { cls: 'muted', label: action };
  return <span className={`badge ${m.cls}`}>{m.label}</span>;
}

/** Table of run items / preview items. Same shape for both, so both screens share it. */
export function ItemsTable({ items, projectGid }: { items: (RunItem | PreviewItem)[]; projectGid?: string }) {
  if (!items.length) return <p className="sub">No completed tasks were found in the project, so there was nothing to evaluate.</p>;
  return (
    <table>
      <thead>
        <tr>
          <th>Action</th>
          <th>Task</th>
          <th className="hide-sm">Section</th>
          <th className="hide-sm">Completed</th>
          <th className="num hide-sm">Subtasks</th>
          <th>Why</th>
        </tr>
      </thead>
      <tbody>
        {items.map((it) => (
          <tr key={it.task_gid}>
            <td className="nowrap"><ActionBadge action={it.action} /></td>
            <td>
              {it.task_name || <i className="sub">(untitled)</i>}
              <div className="sub mono">
                {projectGid ? (
                  <a href={`https://app.asana.com/0/${projectGid}/${it.task_gid}`} target="_blank" rel="noreferrer">{it.task_gid}</a>
                ) : (
                  it.task_gid
                )}
              </div>
            </td>
            <td className="hide-sm">{it.section_name ?? <span className="sub">none</span>}</td>
            <td className="hide-sm nowrap">
              {fmtDate(it.completed_at)}
              {it.completed_at && <div className="sub">{fmtRelative(it.completed_at)}</div>}
            </td>
            <td className="num hide-sm">{it.num_subtasks}</td>
            <td className="sub">{it.reason}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function Warnings({ warnings }: { warnings: string[] }) {
  if (!warnings.length) return null;
  return (
    <div className="banner warn">
      {warnings.map((w, i) => (
        <div key={i}>{w}</div>
      ))}
    </div>
  );
}
