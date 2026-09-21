import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { Account, AccountStatusRow, ChecklistItem, ChecklistItemInput } from '../../../sweep/types';
import { api } from '../api';
import { useIsAdmin } from '../session';

const DAYS: { v: number; l: string }[] = [{ v: 1, l: 'Monday' }, { v: 2, l: 'Tuesday' }, { v: 3, l: 'Wednesday' }, { v: 4, l: 'Thursday' }, { v: 5, l: 'Friday' }];
type Form = { id: number | null; parent_id: number | null; section: string; name: string; guidance: string; role: 'am' | 'aa'; frequency: 'daily' | 'weekly'; weekday: number; enabled: boolean };
const blank = (parent: ChecklistItem | null = null, section = ''): Form => ({ id: null, parent_id: parent?.id ?? null, section: parent?.section ?? section, name: '', guidance: '', role: parent ? 'aa' : 'am', frequency: 'daily', weekday: 1, enabled: true });

function ItemForm({ form, setForm, onSave, onCancel, busy }: { form: Form; setForm: (f: Form) => void; onSave: () => void; onCancel: () => void; busy: boolean }) {
  return (
    <div className="card inline-form" style={{ margin: '8px 0', background: 'var(--surface-2)' }}>
      {form.parent_id === null && <label className="field" style={{ minWidth: 150 }}><span className="lbl">Section</span><input type="text" value={form.section} onChange={(e) => setForm({ ...form, section: e.target.value })} placeholder="Orders" /></label>}
      <label className="field" style={{ flex: 2, minWidth: 260 }}><span className="lbl">{form.parent_id === null ? 'Check' : 'Action item'}</span><input type="text" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder={form.parent_id === null ? 'Orders - AM daily checks' : 'Escalate stuck orders to AM with order IDs'} autoFocus /></label>
      <label className="field" style={{ minWidth: 90 }}><span className="lbl">Who</span><select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as 'am' | 'aa' })}><option value="am">AM</option><option value="aa">AA</option></select></label>
      <label className="field" style={{ minWidth: 110 }}><span className="lbl">How often</span><select value={form.frequency} onChange={(e) => setForm({ ...form, frequency: e.target.value as 'daily' | 'weekly' })}><option value="daily">Every workday</option><option value="weekly">Weekly</option></select></label>
      {form.frequency === 'weekly' && <label className="field" style={{ minWidth: 120 }}><span className="lbl">On</span><select value={form.weekday} onChange={(e) => setForm({ ...form, weekday: Number(e.target.value) })}>{DAYS.map((d) => <option key={d.v} value={d.v}>{d.l}</option>)}</select></label>}
      {form.parent_id === null && <label className="field" style={{ flexBasis: '100%' }}><span className="lbl">What to look at (shown under the line)</span><textarea rows={2} value={form.guidance} onChange={(e) => setForm({ ...form, guidance: e.target.value })} /></label>}
      <label className="field check"><input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} /> Enabled</label>
      <button className="primary" disabled={busy || !form.name.trim()} onClick={onSave}>{form.id ? 'Save' : 'Add'}</button>
      <button onClick={onCancel}>Cancel</button>
    </div>
  );
}

export default function ChecklistTemplatePage() {
  const isAdmin = useIsAdmin();
  const [params, setParams] = useSearchParams();
  const accountId = params.get('account') ? Number(params.get('account')) : null;
  const [accounts, setAccounts] = useState<AccountStatusRow[]>([]);
  const [data, setData] = useState<{ account: Account | null; source: 'template' | 'custom' | 'none'; items: ChecklistItem[] } | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(() => {
    api.checklistItems(accountId).then((r) => setData({ account: r.account, source: r.source, items: r.items })).catch((e) => setError((e as Error).message));
  }, [accountId]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { api.listAccounts().then((r) => setAccounts(r.accounts)).catch(() => undefined); }, [data?.source]);

  const run = async (fn: () => Promise<unknown>, msg?: string) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try { await fn(); if (msg) setNotice(msg); load(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };

  const save = () => {
    if (!form) return;
    const input: Partial<ChecklistItemInput> = { section: form.section, name: form.name.trim(), guidance: form.guidance.trim() || null, role: form.role, frequency: form.frequency, weekday: form.weekday, enabled: form.enabled };
    void run(async () => {
      if (form.id) await api.updateChecklistItem(form.id, input);
      else await api.createChecklistItem({ ...input, name: form.name.trim(), parent_id: form.parent_id, account_id: accountId });
      setForm(null);
    });
  };

  const edit = (i: ChecklistItem) => setForm({ id: i.id, parent_id: i.parent_id, section: i.section, name: i.name, guidance: i.guidance ?? '', role: i.role, frequency: i.frequency, weekday: i.weekday ?? 1, enabled: i.enabled });
  const move = (list: ChecklistItem[], i: ChecklistItem, dir: -1 | 1) => {
    const idx = list.findIndex((x) => x.id === i.id);
    const j = idx + dir;
    if (j < 0 || j >= list.length) return;
    const ids = list.map((x) => x.id);
    [ids[idx], ids[j]] = [ids[j], ids[idx]];
    void run(() => api.reorderChecklistItems(ids));
  };

  const items = data?.items ?? [];
  const tops = items.filter((i) => i.parent_id === null);
  const children = (id: number) => items.filter((i) => i.parent_id === id);
  const readOnlyTemplate = accountId !== null && data?.source === 'template';
  const dayName = (w: number | null) => DAYS.find((d) => d.v === w)?.l ?? 'Monday';

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Checklist items</h1>
          <p className="hint" style={{ margin: 0 }}>
            The AM daily checklist lives here. The template applies to every account; give an account its own list to add or drop lines for it alone. Weekly lines show up on their day only. Ticks happen on <Link to="/checklists">Checklists</Link>.
          </p>
        </div>
        <div className="toolbar" style={{ margin: 0 }}>
          <select value={accountId ?? ''} onChange={(e) => { setForm(null); setParams(e.target.value ? { account: e.target.value } : {}); }}>
            <option value="">Template (all accounts)</option>
            {accounts.map((r) => <option key={r.account.id} value={r.account.id}>{r.account.name}{r.checklist_source === 'custom' ? ' · own list' : ''}</option>)}
          </select>
        </div>
      </div>
      {error && <div className="banner crit">{error}</div>}
      {notice && <div className="banner info">{notice}</div>}
      {data && accountId !== null && (
        <div className={`banner ${data.source === 'custom' ? 'info' : 'warn'}`} style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          {data.source === 'custom'
            ? <><span><b>{data.account?.name}</b> has its own list ({tops.length} checks). Changes here affect only this account.</span>{isAdmin && <button className="small" disabled={busy} onClick={() => { if (window.confirm(`Drop ${data.account?.name}'s own list and follow the template again? Its ticks on the custom lines are removed.`)) void run(() => api.resetChecklist(accountId), 'Back on the template.'); }}>Back to the template</button>}</>
            : <><span><b>{data.account?.name}</b> follows the template. To add or remove lines for this account only, give it its own copy first.</span>{isAdmin && <button className="small primary" disabled={busy} onClick={() => run(() => api.customiseChecklist(accountId), 'This account now has its own copy of the template.')}>Give it its own list</button>}</>}
        </div>
      )}
      {isAdmin && !readOnlyTemplate && !form && <div className="actions" style={{ marginBottom: 10 }}><button className="primary" onClick={() => setForm(blank())}>+ Add a check</button></div>}
      {form && form.parent_id === null && !form.id && <ItemForm form={form} setForm={setForm} onSave={save} onCancel={() => setForm(null)} busy={busy} />}
      {data === null ? <p>Loading…</p> : tops.length === 0 ? <div className="empty">No items yet.</div> : (
        <div className="tpl">
          {tops.map((t) => (
            <div key={t.id} className={`card tpl-item ${t.enabled ? '' : 'off'}`}>
              {form?.id === t.id ? <ItemForm form={form} setForm={setForm} onSave={save} onCancel={() => setForm(null)} busy={busy} /> : (
                <div className="tpl-head">
                  <div style={{ flex: 1 }}>
                    <div className="sub" style={{ textTransform: 'uppercase', letterSpacing: '.04em', fontSize: 11 }}>{t.section || 'No section'}</div>
                    <b>{t.name}</b> <span className={`badge ${t.role === 'am' ? 'accent' : 'muted'}`}>{t.role.toUpperCase()}</span> <span className="badge muted">{t.frequency === 'weekly' ? `weekly · ${dayName(t.weekday)}` : 'every workday'}</span>{!t.enabled && <span className="badge crit">off</span>}
                    {t.guidance && <div className="guidance">{t.guidance}</div>}
                  </div>
                  {isAdmin && !readOnlyTemplate && (
                    <div className="actions">
                      <button className="small" disabled={busy} onClick={() => move(tops, t, -1)} title="Move up">↑</button>
                      <button className="small" disabled={busy} onClick={() => move(tops, t, 1)} title="Move down">↓</button>
                      <button className="small" disabled={busy} onClick={() => edit(t)}>Edit</button>
                      <button className="small" disabled={busy} onClick={() => setForm(blank(t))}>+ Action item</button>
                      <button className="small danger" disabled={busy} onClick={() => { if (window.confirm(`Delete "${t.name}" and its action items?`)) void run(() => api.deleteChecklistItem(t.id)); }}>×</button>
                    </div>
                  )}
                </div>
              )}
              {(children(t.id).length > 0 || (form && form.parent_id === t.id && !form.id)) && (
                <ul className="tpl-subs">
                  {children(t.id).map((c) => (
                    <li key={c.id} className={c.enabled ? '' : 'off'}>
                      {form?.id === c.id ? <ItemForm form={form} setForm={setForm} onSave={save} onCancel={() => setForm(null)} busy={busy} /> : (
                        <div className="tpl-head">
                          <span style={{ flex: 1 }}>☐ {c.name} <span className="sub">· {c.role.toUpperCase()}{c.frequency === 'weekly' ? ` · weekly, ${dayName(c.weekday)}` : ''}{!c.enabled ? ' · off' : ''}</span></span>
                          {isAdmin && !readOnlyTemplate && (
                            <div className="actions">
                              <button className="small" disabled={busy} onClick={() => move(children(t.id), c, -1)} title="Move up">↑</button>
                              <button className="small" disabled={busy} onClick={() => move(children(t.id), c, 1)} title="Move down">↓</button>
                              <button className="small" disabled={busy} onClick={() => edit(c)}>Edit</button>
                              <button className="small danger" disabled={busy} onClick={() => { if (window.confirm(`Delete "${c.name}"?`)) void run(() => api.deleteChecklistItem(c.id)); }}>×</button>
                            </div>
                          )}
                        </div>
                      )}
                    </li>
                  ))}
                  {form && form.parent_id === t.id && !form.id && <li><ItemForm form={form} setForm={setForm} onSave={save} onCancel={() => setForm(null)} busy={busy} /></li>}
                </ul>
              )}
            </div>
          ))}
        </div>
      )}
    </>
  );
}
