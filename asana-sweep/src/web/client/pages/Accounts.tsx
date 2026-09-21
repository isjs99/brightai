import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { Account, AccountInput, AccountStatusRow } from '../../../sweep/types';
import { api } from '../api';

const EMPTY: AccountInput = { name: '', markets: '', am_name: '', aa_name: '', enabled: true, notes: '', commission_pct: null, commission_basis: 'gmv', settlement_pct: 100, slack_channel: '', client_slack_channel: '', client_domain: '' };

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
        <label className="field"><span className="lbl">Notes</span><input type="text" value={form.notes ?? ''} onChange={(e) => set('notes', e.target.value)} placeholder="e.g. OCT PAUSE" /></label>
        <label className="field"><span className="lbl">Internal Slack channel</span><input type="text" value={form.slack_channel ?? ''} onChange={(e) => set('slack_channel', e.target.value)} placeholder="#acct-kijimea" /><span className="help">Incidents for this account post here. Blank = the default incidents channel.</span></label>
        <label className="field"><span className="lbl">Client Slack channel</span><input type="text" value={form.client_slack_channel ?? ''} onChange={(e) => set('client_slack_channel', e.target.value)} placeholder="#ext-kijimea" /><span className="help">Shared channel with the client: reports go here and client questions are picked up from here.</span></label>
        <label className="field"><span className="lbl">Client email domain</span><input type="text" value={form.client_domain ?? ''} onChange={(e) => set('client_domain', e.target.value)} placeholder="kijimea.com" /><span className="help">Used to recognise client emails and tl;dv calls with them.</span></label>
        <label className="field"><span className="lbl">Agency commission (%)</span><input type="number" min={0} max={100} step={0.5} value={form.commission_pct ?? ''} onChange={(e) => set('commission_pct', e.target.value === '' ? null : Number(e.target.value))} placeholder="e.g. 15" /><span className="help">The deal with this client. Leave blank if there is none.</span></label>
        <label className="field"><span className="lbl">Commission on</span><select value={form.commission_basis} onChange={(e) => set('commission_basis', e.target.value as 'gmv' | 'mor')}><option value="gmv">Actual GMV</option><option value="mor">Net settlement (MoR)</option></select></label>
        {form.commission_basis === 'mor' && (
          <label className="field"><span className="lbl">Estimated settlement (% of GMV)</span><input type="number" min={0} max={200} value={form.settlement_pct} onChange={(e) => set('settlement_pct', Number(e.target.value))} /><span className="help">Used until the month's actual net settlement is entered on the GMV page.</span></label>
        )}
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
    if (!window.confirm(`Remove "${a.name}" and its checklist history?`)) return;
    setBusy(a.id);
    try { await api.deleteAccount(a.id); await load(); } catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  };

  const toggle = async (a: Account) => {
    setBusy(a.id);
    try { await api.patchAccount(a.id, { enabled: !a.enabled }); await load(); } catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  };

  const toInput = (a: Account): AccountInput => ({
    name: a.name,
    markets: a.markets,
    am_name: a.am_name,
    aa_name: a.aa_name,
    enabled: a.enabled,
    notes: a.notes,
    commission_pct: a.commission_pct,
    commission_basis: a.commission_basis,
    settlement_pct: a.settlement_pct,
    slack_channel: a.slack_channel,
    client_slack_channel: a.client_slack_channel,
    client_domain: a.client_domain,
  });

  const custom = rows?.filter((r) => r.checklist_source === 'custom').length ?? 0;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Accounts</h1>
          <p className="hint" style={{ margin: 0 }}>{rows ? `${rows.length} accounts; ${custom ? `${custom} with their own checklist, the rest` : 'all'} on the template.` : ''} Every enabled account is checked against its checklist at the daily lock. Edit the items under <Link to="/checklist-template">Checklist items</Link>.</p>
        </div>
        <button className="admin-only" onClick={() => setEditing("new")}>+ New account</button>
      </div>
      {error && <div className="banner crit">{error}</div>}
      {editing && <AccountForm initial={editing === 'new' ? EMPTY : toInput(editing)} onSave={save} onCancel={() => setEditing(null)} />}
      {rows === null ? <p>Loading…</p> : (
        <table>
          <thead>
            <tr><th>Account</th><th className="hide-sm">Markets</th><th>AM</th><th className="hide-sm">AA</th><th>Checklist</th><th>Checked</th><th></th></tr>
          </thead>
          <tbody>
            {rows.map(({ account: a, checklist_source, checklist_items }) => (
              <tr key={a.id} style={{ opacity: a.enabled ? 1 : 0.55 }}>
                <td><b>{a.name}</b>{a.notes && <div className="sub">{a.notes}</div>}</td>
                <td className="hide-sm sub">{a.markets ?? ''}</td>
                <td>{a.am_name ?? <span className="sub">none</span>}</td>
                <td className="hide-sm">{a.aa_name ?? <span className="sub">any</span>}</td>
                <td><Link to={`/checklist-template?account=${a.id}`}>{checklist_source === 'custom' ? `own list · ${checklist_items} items` : checklist_source === 'template' ? `template · ${checklist_items} items` : 'no items'}</Link></td>
                <td><label className="toggle admin-only"><input type="checkbox" checked={a.enabled} disabled={busy === a.id} onChange={() => toggle(a)} />{a.enabled ? 'Yes' : 'No'}</label></td>
                <td><div className="actions admin-only"><button className="small" onClick={() => setEditing(a)}>Edit</button><button className="small danger" disabled={busy === a.id} onClick={() => remove(a)}>Remove</button></div></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
