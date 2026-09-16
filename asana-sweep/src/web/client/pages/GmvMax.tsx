import { useCallback, useEffect, useState } from 'react';
import type { GmvMaxPatch, GmvMaxRow } from '../../../sweep/types';
import { api, fmtMoney, fmtRelative } from '../api';
import { useIsAdmin } from '../session';

export default function GmvMaxPage() {
  const [rows, setRows] = useState<GmvMaxRow[] | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [filterAm, setFilterAm] = useState('');
  const [filterMarket, setFilterMarket] = useState('');
  const [patch, setPatch] = useState<{ daily_budget: string; target_roi: string; bid_strategy: '' | 'MAX_GMV' | 'TARGET_ROI'; status: '' | 'planned' | 'active' | 'paused'; campaign_name: string; notes: string }>({ daily_budget: '', target_roi: '', bid_strategy: '', status: '', campaign_name: '', notes: '' });
  const isAdmin = useIsAdmin();

  const load = useCallback(() => api.listGmvMax().then((r) => setRows(r.rows)).catch((e) => setError((e as Error).message)), []);
  useEffect(() => { load(); }, [load]);

  const visible = (rows ?? []).filter((r) => (!filterAm || (r.am_name ?? 'Unassigned') === filterAm) && (!filterMarket || r.market === filterMarket));
  const ams = [...new Set((rows ?? []).map((r) => r.am_name ?? 'Unassigned'))].sort();
  const markets = [...new Set((rows ?? []).map((r) => r.market))].sort();
  const allVisibleSelected = visible.length > 0 && visible.every((r) => selected.has(r.id));

  const toggleAll = () => {
    const next = new Set(selected);
    if (allVisibleSelected) visible.forEach((r) => next.delete(r.id));
    else visible.forEach((r) => next.add(r.id));
    setSelected(next);
  };

  const generate = async () => {
    setBusy(true);
    try {
      const r = await api.generateGmvMax(['PRODUCT']);
      setRows(r.rows);
      setNotice(`Rows in place for ${r.ensured} account × market combinations.`);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };

  const applyBulk = async () => {
    const p: GmvMaxPatch = {};
    if (patch.daily_budget.trim() !== '') p.daily_budget = Number(patch.daily_budget);
    if (patch.target_roi.trim() !== '') p.target_roi = Number(patch.target_roi);
    if (patch.bid_strategy) p.bid_strategy = patch.bid_strategy;
    if (patch.status) p.status = patch.status;
    if (patch.campaign_name.trim() !== '') p.campaign_name = patch.campaign_name.trim();
    if (patch.notes.trim() !== '') p.notes = patch.notes.trim();
    if (!Object.keys(p).length) return setError('Fill in at least one field to apply.');
    if (!window.confirm(`Apply to ${selected.size} campaign row(s)?`)) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.bulkGmvMax([...selected], p);
      setRows(r.rows);
      setNotice(`Updated ${r.changed} row(s).`);
      setPatch({ daily_budget: '', target_roi: '', bid_strategy: '', status: '', campaign_name: '', notes: '' });
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };

  const editOne = async (row: GmvMaxRow, p: GmvMaxPatch) => {
    try { setRows((await api.bulkGmvMax([row.id], p)).rows); } catch (e) { setError((e as Error).message); }
  };

  const remove = async (row: GmvMaxRow) => {
    if (!window.confirm(`Remove ${row.account_name} ${row.market} ${row.campaign_type}?`)) return;
    try { setRows((await api.deleteGmvMax(row.id)).rows); } catch (e) { setError((e as Error).message); }
  };

  const exportCsv = () => {
    const head = ['Account', 'AM', 'Market', 'Type', 'Campaign', 'Daily budget', 'Currency', 'Bid strategy', 'Target ROI', 'Status', 'Products', 'Notes'];
    const lines = visible.map((r) => [r.account_name, r.am_name ?? '', r.market, r.campaign_type, r.campaign_name ?? '', r.daily_budget ?? '', r.budget_currency, r.bid_strategy, r.target_roi ?? '', r.status, r.product_scope, r.notes ?? ''].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(','));
    const blob = new Blob([[head.join(','), ...lines].join('\n')], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `gmv-max-settings-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>GMV Max</h1>
          <p className="hint" style={{ margin: 0 }}>Campaign settings per account and market, mirroring the TikTok Shop Ads UI: daily budget, bid strategy, target ROI, status. Select rows and apply a change to all of them.</p>
        </div>
        {isAdmin && (
          <div className="actions">
            <button onClick={generate} disabled={busy}>Add rows for every account market</button>
            <button onClick={exportCsv} disabled={!visible.length}>Export CSV</button>
          </div>
        )}
      </div>
      <div className="banner warn">
        <b>Push to TikTok not connected.</b> GMV Max campaigns are managed through the TikTok Marketing API (Business Center), which is a separate app from the Shop OpenAPI used for promotions. Until that app is authorised, this page is the plan of record: apply changes here in bulk, then mirror them in Ads Manager (Export CSV helps).
      </div>
      {error && <div className="banner crit">{error}</div>}
      {notice && <div className="banner info">{notice}</div>}

      <div className="toolbar">
        <select value={filterAm} onChange={(e) => setFilterAm(e.target.value)}><option value="">All AMs</option>{ams.map((a) => <option key={a}>{a}</option>)}</select>
        <select value={filterMarket} onChange={(e) => setFilterMarket(e.target.value)}><option value="">All markets</option>{markets.map((m) => <option key={m}>{m}</option>)}</select>
        <span className="sub">{visible.length} rows · {selected.size} selected</span>
      </div>

      {isAdmin && selected.size > 0 && (
        <div className="card inline-form" style={{ marginBottom: 14 }}>
          <b style={{ alignSelf: 'center' }}>Bulk edit {selected.size} row{selected.size === 1 ? '' : 's'}:</b>
          <label className="field" style={{ minWidth: 120 }}><span className="lbl">Daily budget</span><input type="number" min={0} value={patch.daily_budget} onChange={(e) => setPatch({ ...patch, daily_budget: e.target.value })} placeholder="keep" /></label>
          <label className="field" style={{ minWidth: 140 }}><span className="lbl">Bid strategy</span><select value={patch.bid_strategy} onChange={(e) => setPatch({ ...patch, bid_strategy: e.target.value as typeof patch.bid_strategy })}><option value="">keep</option><option value="MAX_GMV">Maximise GMV</option><option value="TARGET_ROI">Target ROI</option></select></label>
          <label className="field" style={{ minWidth: 100 }}><span className="lbl">Target ROI</span><input type="number" min={0} step="0.1" value={patch.target_roi} onChange={(e) => setPatch({ ...patch, target_roi: e.target.value })} placeholder="keep" /></label>
          <label className="field" style={{ minWidth: 120 }}><span className="lbl">Status</span><select value={patch.status} onChange={(e) => setPatch({ ...patch, status: e.target.value as typeof patch.status })}><option value="">keep</option><option value="active">Active</option><option value="paused">Paused</option><option value="planned">Planned</option></select></label>
          <label className="field" style={{ minWidth: 160 }}><span className="lbl">Campaign name</span><input type="text" value={patch.campaign_name} onChange={(e) => setPatch({ ...patch, campaign_name: e.target.value })} placeholder="keep" /></label>
          <label className="field" style={{ minWidth: 160 }}><span className="lbl">Notes</span><input type="text" value={patch.notes} onChange={(e) => setPatch({ ...patch, notes: e.target.value })} placeholder="keep" /></label>
          <button className="primary" onClick={applyBulk} disabled={busy}>Apply</button>
          <button onClick={() => setSelected(new Set())}>Clear</button>
        </div>
      )}

      {rows === null ? <p>Loading…</p> : rows.length === 0 ? (
        <div className="empty">No campaign rows yet. {isAdmin ? 'Click "Add rows for every account market" to start from the roster.' : ''}</div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>{isAdmin && <input type="checkbox" checked={allVisibleSelected} onChange={toggleAll} />}</th>
              <th>Account</th><th>Market</th><th className="hide-sm">Type</th><th>Campaign</th><th className="num">Daily budget</th><th>Bid</th><th className="num">Target ROI</th><th>Status</th><th className="hide-sm">Notes</th><th className="hide-sm">Updated</th><th></th>
            </tr>
          </thead>
          <tbody>
            {visible.map((r) => (
              <tr key={r.id}>
                <td>{isAdmin && <input type="checkbox" checked={selected.has(r.id)} onChange={(e) => { const n = new Set(selected); e.target.checked ? n.add(r.id) : n.delete(r.id); setSelected(n); }} />}</td>
                <td><b>{r.account_name}</b><div className="sub">{r.am_name ?? ''}</div></td>
                <td>{r.market}</td>
                <td className="hide-sm">{r.campaign_type === 'LIVE' ? 'LIVE' : 'Product'}</td>
                <td>{isAdmin ? <input type="text" defaultValue={r.campaign_name ?? ''} placeholder="—" onBlur={(e) => e.target.value !== (r.campaign_name ?? '') && editOne(r, { campaign_name: e.target.value || null })} style={{ width: 160 }} /> : r.campaign_name ?? <span className="sub">–</span>}</td>
                <td className="num">{isAdmin ? <input type="number" min={0} defaultValue={r.daily_budget ?? ''} onBlur={(e) => Number(e.target.value || 0) !== (r.daily_budget ?? 0) && editOne(r, { daily_budget: e.target.value === '' ? null : Number(e.target.value) })} style={{ width: 100, textAlign: 'right' }} /> : fmtMoney(r.daily_budget, r.budget_currency)}<div className="sub">{r.budget_currency}/day</div></td>
                <td>{isAdmin ? <select value={r.bid_strategy} onChange={(e) => editOne(r, { bid_strategy: e.target.value as GmvMaxRow['bid_strategy'] })} style={{ width: 'auto' }}><option value="MAX_GMV">Max GMV</option><option value="TARGET_ROI">Target ROI</option></select> : r.bid_strategy === 'MAX_GMV' ? 'Max GMV' : 'Target ROI'}</td>
                <td className="num">{isAdmin ? <input type="number" min={0} step="0.1" defaultValue={r.target_roi ?? ''} disabled={r.bid_strategy !== 'TARGET_ROI'} onBlur={(e) => Number(e.target.value || 0) !== (r.target_roi ?? 0) && editOne(r, { target_roi: e.target.value === '' ? null : Number(e.target.value) })} style={{ width: 80, textAlign: 'right' }} /> : r.target_roi ?? '–'}</td>
                <td>{isAdmin ? <select value={r.status} onChange={(e) => editOne(r, { status: e.target.value as GmvMaxRow['status'] })} style={{ width: 'auto' }}><option value="planned">Planned</option><option value="active">Active</option><option value="paused">Paused</option></select> : <span className={`badge ${r.status === 'active' ? 'good' : r.status === 'paused' ? 'warn' : 'muted'}`}>{r.status}</span>}</td>
                <td className="hide-sm sub">{r.notes ?? ''}</td>
                <td className="hide-sm sub">{fmtRelative(r.updated_at)}</td>
                <td>{isAdmin && <button className="small danger" onClick={() => remove(r)}>×</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
