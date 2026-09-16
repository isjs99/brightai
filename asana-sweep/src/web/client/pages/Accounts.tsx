import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { Account, AccountInput, AccountStatusRow } from '../../../sweep/types';
import { api } from '../api';

const EMPTY: AccountInput = { name: '', markets: '', am_name: '', aa_name: '', asana_project_gid: null, asana_project_name: '', enabled: true, notes: '' };

function ProjectSearch({ value, onPick }: { value: { gid: string | null; name: string }; onPick: (gid: string | null, name: string) => void }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<{ gid: string; name: string }[]>([]);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (q.trim().length < 2) return setResults([]);
    const t = window.setTimeout(() => {
      api.searchProjects(q.trim()).then((r) => { setResults(r.projects); setErr(null); }).catch((e) => setErr((e as Error).message));
    }, 300);
    return () => window.clearTimeout(t);
  }, [q]);
  if (value.gid) {
    return (
      <div className="picker">
        <div className="chosen">
          <b>{value.name || '(name filled on first check)'}</b>
          <span className="sub mono">{value.gid}</span>
          <span style={{ flex: 1 }} />
          <button type="button" className="small" onClick={() => onPick(null, '')}>Unlink</button>
        </div>
      </div>
    );
  }
  return (
    <div className="picker">
      <input type="text" placeholder="Search Asana projects…" value={q} onChange={(e) => setQ(e.target.value)} />
      {err && <div className="help error">{err}</div>}
      {results.length > 0 && (
        <ul>
          {results.map((p) => (
            <li key={p.gid} onMouseDown={() => onPick(p.gid, p.name)}>{p.name}<span className="sub mono">{p.gid}</span></li>
          ))}
        </ul>
      )}
    </div>
  );
}

function AccountForm({ initial, onSave, onCancel }: { initial: AccountInput; onSave: (a: AccountInput) => Promise<void>; onCancel: () => void }) {
  const [form, setForm] = useState<AccountInput>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof AccountInput>(k: K, v: AccountInput[K]) => setForm((f) => ({ ...f, [k]: v }));
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onSave(form);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="card" onSubmit={submit} style={{ marginBottom: 16 }}>
      <div className="grid">
        <label className="field"><span className="lbl">Account</span><input type="text" value={form.name} onChange={(e) => set('name', e.target.value)} required /></label>
        <label className="field"><span className="lbl">Markets</span><input type="text" value={form.markets ?? ''} onChange={(e) => set('markets', e.target.value)} placeholder="DE/IT/FR" /></label>
        <label className="field"><span className="lbl">AM (account manager)</span><input type="text" value={form.am_name ?? ''} onChange={(e) => set('am_name', e.target.value)} placeholder="Elena" /><span className="help">Tasks assigned to this person count as AM work. First name is enough.</span></label>
        <label className="field"><span className="lbl">AA (account assistant)</span><input type="text" value={form.aa_name ?? ''} onChange={(e) => set('aa_name', e.target.value)} placeholder="DM" /><span className="help">Optional. Anyone who is not the AM counts as AA anyway; unassigned subtasks count as AA.</span></label>
        <label className="field"><span className="lbl">Asana checklist project</span><ProjectSearch value={{ gid: form.asana_project_gid, name: form.asana_project_name }} onPick={(gid, name) => setForm((f) => ({ ...f, asana_project_gid: gid, asana_project_name: name }))} /></label>
        <label className="field"><span className="lbl">Notes</span><input type="text" value={form.notes ?? ''} onChange={(e) => set('notes', e.target.value)} placeholder="e.g. OCT PAUSE" /></label>
        <label className="field check"><input type="checkbox" checked={form.enabled} onChange={(e) => set('enabled', e.target.checked)} /><span>Included in the daily check</span></label>
      </div>
      {error && <p className="error">{error}</p>}
      <div className="form-foot">
        <button className="primary" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
        <button type="button" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

export default function Accounts() {
  const [rows, setRows] = useState<AccountStatusRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Account | 'new' | null>(null);
  const [busy, setBusy] = useState<number | null>(null);

  const load = useCallback(() => api.listAccounts().then((r) => setRows(r.accounts)).catch((e) => setError((e as Error).message)), []);
  useEffect(() => { load(); }, [load]);

  const save = async (input: AccountInput) => {
    if (editing === 'new') await api.createAccount(input);
    else if (editing) await api.updateAccount(editing.id, input);
    setEditing(null);
    await load();
  };

  const remove = async (a: Account) => {
    if (!window.confirm(`Remove "${a.name}" and its check history? This does not touch Asana.`)) return;
    setBusy(a.id);
    try { await api.deleteAccount(a.id); await load(); } catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  };

  const addRule = async (a: Account) => {
    setBusy(a.id);
    try { await api.createSweepRule(a.id); await load(); } catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  };

  const toggle = async (a: Account) => {
    setBusy(a.id);
    try { await api.patchAccount(a.id, { enabled: !a.enabled }); await load(); } catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  };

  const toInput = (a: Account): AccountInput => ({ name: a.name, markets: a.markets, am_name: a.am_name, aa_name: a.aa_name, asana_project_gid: a.asana_project_gid, asana_project_name: a.asana_project_name, enabled: a.enabled, notes: a.notes });

  const linked = rows?.filter((r) => r.account.asana_project_gid).length ?? 0;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Accounts</h1>
          <p className="hint" style={{ margin: 0 }}>{rows ? `${rows.length} accounts, ${linked} linked to an Asana checklist project.` : ''} Link a project to include an account in the 16:00 check.</p>
        </div>
        <button onClick={() => setEditing('new')}>+ New account</button>
      </div>
      {error && <div className="banner crit">{error}</div>}
      {editing && <AccountForm initial={editing === 'new' ? EMPTY : toInput(editing)} onSave={save} onCancel={() => setEditing(null)} />}
      {rows === null ? <p>Loading…</p> : (
        <table>
          <thead>
            <tr><th>Account</th><th className="hide-sm">Markets</th><th>AM</th><th className="hide-sm">AA</th><th>Checklist project</th><th className="hide-sm">Sweep rule</th><th>Checked</th><th></th></tr>
          </thead>
          <tbody>
            {rows.map(({ account: a, has_sweep_rule }) => (
              <tr key={a.id} style={{ opacity: a.enabled ? 1 : 0.55 }}>
                <td><b>{a.name}</b>{a.notes && <div className="sub">{a.notes}</div>}</td>
                <td className="hide-sm sub">{a.markets ?? ''}</td>
                <td>{a.am_name ?? <span className="sub">none</span>}</td>
                <td className="hide-sm">{a.aa_name ?? <span className="sub">any</span>}</td>
                <td>{a.asana_project_gid ? <span>{a.asana_project_name || <span className="mono">{a.asana_project_gid}</span>}</span> : <span className="badge muted">not linked</span>}</td>
                <td className="hide-sm">
                  {!a.asana_project_gid ? <span className="sub">–</span> : has_sweep_rule ? <Link to="/">yes</Link> : <button className="small" disabled={busy === a.id} onClick={() => addRule(a)}>Add (dry run)</button>}
                </td>
                <td><label className="toggle"><input type="checkbox" checked={a.enabled} disabled={busy === a.id} onChange={() => toggle(a)} />{a.enabled ? 'Yes' : 'No'}</label></td>
                <td><div className="actions"><button className="small" onClick={() => setEditing(a)}>Edit</button><button className="small danger" disabled={busy === a.id} onClick={() => remove(a)}>Remove</button></div></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
