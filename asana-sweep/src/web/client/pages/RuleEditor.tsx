import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { PreviewResult, RuleInput } from '../../../sweep/types';
import { api, fmtDate, fmtRelative } from '../api';
import { ItemsTable, Warnings } from '../components';

const EMPTY: RuleInput = {
  name: '',
  asana_project_gid: '',
  asana_project_name: '',
  enabled: true,
  cron: '30 6 * * 1-5',
  timezone: 'Europe/Madrid',
  dry_run: true,
  min_age_hours: 12,
  require_section_match: true,
  max_deletes_per_run: 50,
  notify_slack_webhook: null,
};

function ProjectPicker({ gid, name, onPick }: { gid: string; name: string; onPick: (gid: string, name: string) => void }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<{ gid: string; name: string; workspace?: { name: string } }[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    if (timer.current) window.clearTimeout(timer.current);
    if (q.trim().length < 2) {
      setResults([]);
      return;
    }
    timer.current = window.setTimeout(async () => {
      setSearching(true);
      setError(null);
      try {
        setResults((await api.searchProjects(q.trim())).projects);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setSearching(false);
      }
    }, 300);
  }, [q]);

  if (gid) {
    return (
      <div className="picker">
        <div className="chosen">
          <b>{name || '(name unknown yet)'}</b>
          <span className="sub mono">{gid}</span>
          <span style={{ flex: 1 }} />
          <button type="button" className="small" onClick={() => onPick('', '')}>Change</button>
        </div>
      </div>
    );
  }
  return (
    <div className="picker">
      <input type="text" placeholder="Type a project name to search Asana…" value={q} onChange={(e) => setQ(e.target.value)} autoComplete="off" />
      {error && <div className="help error">{error}</div>}
      {searching && <div className="help">Searching…</div>}
      {results.length > 0 && (
        <ul>
          {results.map((p) => (
            <li key={p.gid} onMouseDown={() => onPick(p.gid, p.name)}>
              {p.name}
              <span className="sub">{p.workspace?.name} · <span className="mono">{p.gid}</span></span>
            </li>
          ))}
        </ul>
      )}
      {/^\d{6,}$/.test(q.trim()) && (
        <div className="help">
          Looks like a GID. <a href="#" onClick={(e) => { e.preventDefault(); onPick(q.trim(), ''); }}>Use it directly</a> (the name is filled in on the first run or preview).
        </div>
      )}
    </div>
  );
}

export default function RuleEditor() {
  const { id } = useParams();
  const isNew = !id;
  const navigate = useNavigate();
  const [form, setForm] = useState<RuleInput>(EMPTY);
  const [loading, setLoading] = useState(!isNew);
  const [meta, setMeta] = useState<{ cron_presets: { label: string; cron: string }[]; timezones: string[] } | null>(null);
  const [cronInfo, setCronInfo] = useState<{ error: string | null; text: string | null; next_run_at: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  useEffect(() => {
    api.meta().then(setMeta).catch(() => setMeta({ cron_presets: [], timezones: ['Europe/Madrid', 'UTC'] }));
  }, []);

  useEffect(() => {
    if (isNew) return;
    api
      .getRule(Number(id))
      .then(({ rule }) => {
        const { id: _i, created_at: _c, updated_at: _u, schedule_text: _s, next_run_at: _n, last_run: _l, is_running: _r, ...input } = rule;
        setForm(input);
      })
      .catch((err) => setError((err as Error).message))
      .finally(() => setLoading(false));
  }, [id, isNew]);

  useEffect(() => {
    const t = window.setTimeout(() => {
      api.describeCron(form.cron, form.timezone).then(setCronInfo).catch(() => setCronInfo(null));
    }, 250);
    return () => window.clearTimeout(t);
  }, [form.cron, form.timezone]);

  const set = <K extends keyof RuleInput>(key: K, value: RuleInput[K]) => setForm((f) => ({ ...f, [key]: value }));

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      if (!form.dry_run && isNew && !window.confirm('Create this rule LIVE (not in dry run)? It will delete matched tasks on its first scheduled run.')) {
        setSaving(false);
        return;
      }
      if (isNew) await api.createRule(form);
      else await api.updateRule(Number(id), form);
      navigate('/');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const runPreview = async () => {
    setPreviewing(true);
    setPreviewError(null);
    setPreview(null);
    try {
      const result = await api.preview({
        asana_project_gid: form.asana_project_gid,
        min_age_hours: form.min_age_hours,
        require_section_match: form.require_section_match,
        max_deletes_per_run: form.max_deletes_per_run,
      });
      setPreview(result);
      if (!form.asana_project_name && result.project_name) set('asana_project_name', result.project_name);
    } catch (err) {
      setPreviewError((err as Error).message);
    } finally {
      setPreviewing(false);
    }
  };

  if (loading) return <p>Loading…</p>;

  return (
    <>
      <div className="page-head">
        <h1>{isNew ? 'New rule' : 'Edit rule'}</h1>
        <div className="actions">
          {!isNew && <Link className="btn" to={`/rules/${id}/runs`}>Run history</Link>}
          <Link className="btn" to="/">Back to rules</Link>
        </div>
      </div>
      {form.dry_run ? (
        <div className="banner warn"><b>Dry run.</b> This rule logs what it would delete and deletes nothing. Untick "Dry run" below when the previews look right.</div>
      ) : (
        <div className="banner crit"><b>Live.</b> This rule really deletes matched tasks from Asana on each run.</div>
      )}
      {error && <div className="banner crit">{error}</div>}

      <form onSubmit={save} className="card">
        <div className="grid">
          <label className="field">
            <span className="lbl">Rule name</span>
            <input type="text" value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="e.g. GreatVita AM Daily Checklist" required />
          </label>
          <label className="field">
            <span className="lbl">Asana project</span>
            <ProjectPicker gid={form.asana_project_gid} name={form.asana_project_name} onPick={(gid, name) => setForm((f) => ({ ...f, asana_project_gid: gid, asana_project_name: name, name: f.name || name }))} />
            <span className="help">Only tasks in this project are ever read or deleted.</span>
          </label>
        </div>

        <h2>Schedule</h2>
        <div className="grid">
          <label className="field">
            <span className="lbl">Cron expression</span>
            <div className="presets">
              {(meta?.cron_presets ?? []).map((p) => (
                <button type="button" key={p.cron} className={`small ${form.cron === p.cron ? 'active' : ''}`} onClick={() => set('cron', p.cron)}>
                  {p.label}
                </button>
              ))}
            </div>
            <input type="text" className="mono" value={form.cron} onChange={(e) => set('cron', e.target.value)} placeholder="30 6 * * 1-5" required />
            <span className={`help ${cronInfo?.error ? 'error' : ''}`}>
              {cronInfo?.error
                ? cronInfo.error
                : cronInfo?.text
                  ? `${cronInfo.text}${cronInfo.next_run_at ? ` · next ${fmtDate(cronInfo.next_run_at)} (${fmtRelative(cronInfo.next_run_at)})` : ''}`
                  : 'minute hour day-of-month month day-of-week'}
            </span>
          </label>
          <label className="field">
            <span className="lbl">Timezone</span>
            <select value={form.timezone} onChange={(e) => set('timezone', e.target.value)}>
              {(meta?.timezones ?? [form.timezone]).map((tz) => (
                <option key={tz} value={tz}>{tz}</option>
              ))}
            </select>
          </label>
        </div>

        <h2>Safeguards</h2>
        <div className="grid">
          <label className="field">
            <span className="lbl">Minimum age (hours)</span>
            <input type="number" min={0} value={form.min_age_hours} onChange={(e) => set('min_age_hours', Number(e.target.value))} />
            <span className="help">Only delete if the task was completed more than this many hours ago. Protects against fat-finger completions.</span>
          </label>
          <label className="field">
            <span className="lbl">Max deletes per run</span>
            <input type="number" min={1} value={form.max_deletes_per_run} onChange={(e) => set('max_deletes_per_run', Number(e.target.value))} />
            <span className="help">Hard stop. If a run would delete more than this, it errors out and deletes nothing.</span>
          </label>
          <label className="field check">
            <input type="checkbox" checked={form.require_section_match} onChange={(e) => set('require_section_match', e.target.checked)} />
            <span>
              Require the incomplete twin to be in the same section
              <div className="help">Off: a twin anywhere in the project counts.</div>
            </span>
          </label>
          <label className="field check">
            <input type="checkbox" checked={form.dry_run} onChange={(e) => set('dry_run', e.target.checked)} />
            <span>
              Dry run (log only, delete nothing)
              <div className="help">Leave on until you have checked a few previews or dry-run reports.</div>
            </span>
          </label>
          <label className="field check">
            <input type="checkbox" checked={form.enabled} onChange={(e) => set('enabled', e.target.checked)} />
            <span>
              Enabled
              <div className="help">Off: the schedule is paused. "Run now" still works.</div>
            </span>
          </label>
        </div>

        <h2>Notifications</h2>
        <div className="grid">
          <label className="field">
            <span className="lbl">Slack incoming webhook URL (optional)</span>
            <input type="url" value={form.notify_slack_webhook ?? ''} onChange={(e) => set('notify_slack_webhook', e.target.value || null)} placeholder="https://hooks.slack.com/services/…" />
            <span className="help">A one-line summary is posted after each run, and the error text if a run fails.</span>
          </label>
        </div>

        <div className="form-foot admin-only">
          <button type="submit" className="primary" disabled={saving}>{saving ? 'Saving…' : isNew ? 'Create rule' : 'Save changes'}</button>
          <button type="button" onClick={runPreview} disabled={previewing || !form.asana_project_gid}>
            {previewing ? 'Checking Asana…' : 'Preview what would be deleted'}
          </button>
          <span className="sub">Preview runs the matching logic live against Asana with the settings above. Nothing is saved or deleted.</span>
        </div>
      </form>

      {previewError && <div className="banner crit" style={{ marginTop: 16 }}>{previewError}</div>}
      {preview && (
        <section style={{ marginTop: 20 }}>
          <h2>Preview: {preview.project_name}</h2>
          <div className="stats">
            <div className="stat"><span className="v">{preview.scanned_count}</span><span className="k">tasks scanned</span></div>
            <div className="stat"><span className="v">{preview.items.length}</span><span className="k">completed</span></div>
            <div className="stat"><span className="v">{preview.matched_count}</span><span className="k">would be deleted</span></div>
            <div className="stat"><span className="v">{preview.items.length - preview.matched_count}</span><span className="k">left alone</span></div>
          </div>
          {preview.cap_exceeded && <div className="banner crit">This would exceed the max deletes cap. A real run would error out and delete nothing.</div>}
          <Warnings warnings={preview.warnings.filter((w) => !w.startsWith('Would delete'))} />
          <ItemsTable items={preview.items} projectGid={form.asana_project_gid} />
        </section>
      )}
    </>
  );
}
