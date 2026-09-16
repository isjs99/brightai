import { useCallback, useEffect, useState } from 'react';
import type { Lead, LeadsData } from '../../../sweep/types';
import { api, fmtMoney, fmtPct, fmtRelative, useLiveUpdates } from '../api';
import { useIsAdmin } from '../session';

type Result = { rows: number; added: number; updated: number; removed: number };

export default function LeadsPage() {
  const [data, setData] = useState<LeadsData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [filterStage, setFilterStage] = useState('');
  const [filterCountry, setFilterCountry] = useState('');
  const [filterAm, setFilterAm] = useState('');
  const [search, setSearch] = useState('');
  const [added, setAdded] = useState<{ preset: '' | '7' | '30' | '90' | 'custom'; from: string; to: string }>({ preset: '', from: '', to: '' });
  const [showSettings, setShowSettings] = useState(false);
  const [csv, setCsv] = useState('');
  const [form, setForm] = useState({ sheet_id: '', sheet_tab: '', sync_enabled: true, sync_seconds: '180', points_signed: '1', points_sourced: '1', currency: 'GBP' });
  const isAdmin = useIsAdmin();

  const absorb = useCallback((d: LeadsData) => {
    setData(d);
    setForm({
      sheet_id: d.settings.sheet_id,
      sheet_tab: d.settings.sheet_tab,
      sync_enabled: d.settings.sync_enabled,
      sync_seconds: String(d.settings.sync_seconds),
      points_signed: String(d.settings.points_signed),
      points_sourced: String(d.settings.points_sourced),
      currency: d.settings.currency,
    });
  }, []);
  const load = useCallback(() => api.leads().then(absorb).catch((e) => setError((e as Error).message)), [absorb]);
  useEffect(() => { load(); }, [load]);
  const connected = useLiveUpdates((e) => { if (e.kind === 'leads' || e.kind === 'settings') load(); });

  const describe = (r: Result) => `${r.rows} rows read: ${r.added} new, ${r.updated} changed, ${r.removed} removed.`;

  const sync = async () => {
    setBusy('sync');
    setError(null);
    try {
      const d = await api.syncLeads();
      absorb(d);
      setNotice(`Synced from the sheet. ${describe(d.result)}`);
    } catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  };

  const importCsv = async () => {
    setBusy('import');
    setError(null);
    try {
      const d = await api.importLeads(csv);
      absorb(d);
      setCsv('');
      setNotice(`Imported. ${describe(d.result)}`);
    } catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  };

  const saveSettings = async () => {
    setBusy('settings');
    setError(null);
    try {
      absorb(await api.saveLeadsSettings({
        sheet_id: form.sheet_id,
        sheet_tab: form.sheet_tab,
        sync_enabled: form.sync_enabled,
        sync_seconds: Number(form.sync_seconds),
        points_signed: Number(form.points_signed),
        points_sourced: Number(form.points_sourced),
        currency: form.currency,
      }));
      setNotice('Leads settings saved.');
    } catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  };

  const setAddedOn = async (lead: Lead, value: string) => {
    try {
      absorb(await api.patchLead(lead.id, { added_on: value || null }));
    } catch (e) { setError((e as Error).message); }
  };

  const assign = async (lead: Lead, field: 'sourced_by_id' | 'onboarding_id', value: string) => {
    try {
      absorb(await api.patchLead(lead.id, { [field]: value ? Number(value) : null }));
    } catch (e) { setError((e as Error).message); }
  };

  if (!data) return <p>{error ?? 'Loading…'}</p>;
  const cur = data.settings.currency;
  const q = search.trim().toLowerCase();
  const dayIso = (daysAgo: number) => new Date(Date.now() - daysAgo * 86400000).toISOString().slice(0, 10);
  const addedFrom = added.preset === 'custom' ? added.from : added.preset ? dayIso(Number(added.preset)) : '';
  const addedTo = added.preset === 'custom' ? added.to : '';
  const visible = data.leads.filter((l) =>
    (!addedFrom || ((l.added_on ?? '') >= addedFrom)) &&
    (!addedTo || ((l.added_on ?? '9999') <= addedTo)) &&
    (!filterStage || (filterStage === '(none)' ? !l.stage : l.stage === filterStage)) &&
    (!filterCountry || l.country === filterCountry) &&
    (!filterAm || String(l.onboarding_id ?? '') === filterAm || String(l.sourced_by_id ?? '') === filterAm) &&
    (!q || [l.name, l.poc, l.notes, l.country, l.stage].some((v) => (v ?? '').toLowerCase().includes(q))));
  const stageClass = (l: Lead) => (l.signed ? 'good' : !l.stage ? 'muted' : /proposal/i.test(l.stage) ? 'warn' : 'accent');
  const personSelect = (lead: Lead, field: 'sourced_by_id' | 'onboarding_id') => {
    const value = lead[field];
    if (!isAdmin) return value ? data.people.find((p) => p.id === value)?.name ?? '–' : <span className="sub">–</span>;
    return (
      <select value={value ?? ''} onChange={(e) => assign(lead, field, e.target.value)} style={{ width: 'auto' }}>
        <option value="">{field === 'sourced_by_id' ? 'Not AM sourced' : 'Unassigned'}</option>
        {data.people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>
    );
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Leads</h1>
          <p className="hint" style={{ margin: 0 }}>
            Mirrors the <b>{data.settings.sheet_tab}</b> tab of the lead sheet{data.settings.sync_enabled ? ` every ${Math.round(data.settings.sync_seconds / 60)} min` : ''}. Log who onboards each account and whether an AM sourced it. A signed deal gives points to those AMs.
          </p>
        </div>
        <div className="actions">
          <span className={`badge ${data.sync.status === 'ok' ? 'good' : data.sync.status === 'error' ? 'crit' : 'muted'}`} title={data.sync.error ?? ''}>
            {data.sync.status === 'never' ? 'Never synced' : `${data.sync.status === 'ok' ? 'Synced' : 'Sync failed'} ${fmtRelative(data.sync.last_sync_at)}`}
          </span>
          {connected && <span className="badge muted" title="Updates arrive live">Live</span>}
          {isAdmin && <button onClick={sync} disabled={busy === 'sync'}>{busy === 'sync' ? 'Syncing…' : 'Sync now'}</button>}
          {isAdmin && <button onClick={() => setShowSettings((s) => !s)}>{showSettings ? 'Hide settings' : 'Settings'}</button>}
        </div>
      </div>

      {data.sync.status === 'error' && (
        <div className="banner crit"><b>Last sync failed.</b> {data.sync.error} {data.settings.csv_url_from_env ? '' : 'The sheet must be shared as "Anyone with the link can view" for the server to read it, or paste the CSV below.'}</div>
      )}
      {error && <div className="banner crit">{error}</div>}
      {notice && <div className="banner info">{notice}</div>}

      {isAdmin && showSettings && (
        <div className="card" style={{ marginBottom: 18 }}>
          <h2 style={{ marginTop: 0 }}>Sheet sync</h2>
          <div className="inline-form">
            <label className="field" style={{ minWidth: 320 }}><span className="lbl">Google Sheet id or URL</span><input type="text" value={form.sheet_id} onChange={(e) => setForm({ ...form, sheet_id: e.target.value })} disabled={data.settings.csv_url_from_env} /></label>
            <label className="field"><span className="lbl">Tab</span><input type="text" value={form.sheet_tab} onChange={(e) => setForm({ ...form, sheet_tab: e.target.value })} disabled={data.settings.csv_url_from_env} /></label>
            <label className="field" style={{ minWidth: 90 }}><span className="lbl">Every (s)</span><input type="number" min={30} value={form.sync_seconds} onChange={(e) => setForm({ ...form, sync_seconds: e.target.value })} /></label>
            <label className="field check"><input type="checkbox" checked={form.sync_enabled} onChange={(e) => setForm({ ...form, sync_enabled: e.target.checked })} /> Auto sync</label>
          </div>
          <p className="sub" style={{ marginTop: 8 }}>
            {data.settings.csv_url_from_env ? 'Source is fixed by LEADS_CSV_URL in .env.' : 'Reads the public CSV export of the tab, so the sheet needs link sharing (view). Columns picked up: Client Name, POC, Stage, Country, Last Contact, Notes, Est. Value P/M, Priorities. Add "Sourced By", "Onboarding AM" and "Date Added" columns to the sheet and they fill in here automatically; otherwise the added date is the day the lead first appeared on the sheet and can be edited.'}
            {data.sync.columns.length > 0 && <> Last sync saw: {data.sync.columns.join(', ')}.</>}
          </p>
          <h2>Points</h2>
          <div className="inline-form">
            <label className="field" style={{ minWidth: 150 }}><span className="lbl">Signed → onboarding AM</span><input type="number" min={0} step="0.5" value={form.points_signed} onChange={(e) => setForm({ ...form, points_signed: e.target.value })} /></label>
            <label className="field" style={{ minWidth: 150 }}><span className="lbl">Signed → sourcing AM</span><input type="number" min={0} step="0.5" value={form.points_sourced} onChange={(e) => setForm({ ...form, points_sourced: e.target.value })} /></label>
            <label className="field" style={{ minWidth: 90 }}><span className="lbl">Sheet currency</span><input type="text" value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value })} /></label>
            <button className="primary" onClick={saveSettings} disabled={busy === 'settings'}>Save</button>
          </div>
          <h2>Paste CSV instead</h2>
          <textarea rows={4} value={csv} onChange={(e) => setCsv(e.target.value)} placeholder="File > Download > CSV of the Core Lead List tab, then paste here" style={{ width: '100%' }} />
          <div className="actions" style={{ marginTop: 8 }}><button onClick={importCsv} disabled={!csv.trim() || busy === 'import'}>Import CSV</button></div>
        </div>
      )}

      <div className="kpis">
        <div className="kpi"><div className="v">{data.totals.leads}</div><div className="k">Leads on the sheet</div></div>
        <div className="kpi"><div className="v">{data.totals.signed}</div><div className="k">Signed</div><div className="d">{fmtMoney(data.totals.signed_value, cur)} / month</div></div>
        <div className="kpi"><div className="v">{data.totals.open}</div><div className="k">Open</div><div className="d">{fmtMoney(data.totals.pipeline_value, cur)} / month in pipeline</div></div>
        <div className="kpi"><div className="v">{data.totals.close_rate === null ? '–' : fmtPct(data.totals.close_rate * 100)}</div><div className="k">Close rate</div><div className="d">signed ÷ leads with a stage</div></div>
      </div>

      <h2>By AM</h2>
      {data.ams.length === 0 ? <div className="empty">Add the team under Setup → Team to score leads per AM.</div> : (
        <table style={{ marginBottom: 24 }}>
          <thead><tr><th>AM</th><th className="num">Points</th><th className="num">Onboarding</th><th className="num">Signed</th><th className="num">Sourced</th><th className="num">Sourced &amp; signed</th><th className="num hide-sm">Signed value</th><th className="num hide-sm">Open pipeline</th></tr></thead>
          <tbody>
            {data.ams.map((a) => (
              <tr key={a.person_id}>
                <td><b>{a.name}</b> <span className="sub">{a.role.toUpperCase()}</span></td>
                <td className="num"><b>{a.points}</b></td>
                <td className="num">{a.onboarding_total}</td>
                <td className="num">{a.onboarding_signed}</td>
                <td className="num">{a.sourced_total}</td>
                <td className="num">{a.sourced_signed}</td>
                <td className="num hide-sm">{fmtMoney(a.signed_value, cur)}</td>
                <td className="num hide-sm">{fmtMoney(a.pipeline_value, cur)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>Lead list</h2>
      <div className="toolbar">
        <input type="text" placeholder="Search" value={search} onChange={(e) => setSearch(e.target.value)} />
        <select value={filterStage} onChange={(e) => setFilterStage(e.target.value)}><option value="">All stages</option>{data.stages.map((s) => <option key={s}>{s}</option>)}<option value="(none)">No stage</option></select>
        <select value={filterCountry} onChange={(e) => setFilterCountry(e.target.value)}><option value="">All countries</option>{data.countries.map((c) => <option key={c}>{c}</option>)}</select>
        <select value={filterAm} onChange={(e) => setFilterAm(e.target.value)}><option value="">All AMs</option>{data.people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
        <select value={added.preset} onChange={(e) => setAdded({ ...added, preset: e.target.value as typeof added.preset })}>
          <option value="">Added any time</option><option value="7">Added last 7 days</option><option value="30">Added last 30 days</option><option value="90">Added last 90 days</option><option value="custom">Added between…</option>
        </select>
        {added.preset === 'custom' && <><input type="date" value={added.from} onChange={(e) => setAdded({ ...added, from: e.target.value })} /><span className="sub">to</span><input type="date" value={added.to} onChange={(e) => setAdded({ ...added, to: e.target.value })} /></>}
        <span className="sub">{visible.length} of {data.leads.length}</span>
      </div>
      {data.leads.length === 0 ? (
        <div className="empty">Nothing synced yet. {isAdmin ? 'Press "Sync now" or paste the CSV under Settings.' : ''}</div>
      ) : (
        <table>
          <thead><tr><th>Client</th><th>Stage</th><th className="hide-sm">Country</th><th className="num">Est. / month</th><th>Added</th><th>Onboarding AM</th><th>Sourced by</th><th className="hide-sm">Notes</th><th className="hide-sm">Signed</th></tr></thead>
          <tbody>
            {visible.map((l) => (
              <tr key={l.id}>
                <td><b>{l.name}</b>{l.poc && <div className="sub">{l.poc}</div>}</td>
                <td><span className={`badge ${stageClass(l)}`}>{l.stage ?? 'No stage'}</span></td>
                <td className="hide-sm">{l.country ?? <span className="sub">–</span>}</td>
                <td className="num">{l.est_value === null ? <span className="sub">–</span> : fmtMoney(l.est_value, cur)}</td>
                <td>{isAdmin ? <input type="date" value={l.added_on ?? ''} onChange={(e) => setAddedOn(l, e.target.value)} style={{ width: 150 }} title="Date this lead was added to the sheet" /> : (l.added_on ?? <span className="sub">–</span>)}</td>
                <td>{personSelect(l, 'onboarding_id')}</td>
                <td>{personSelect(l, 'sourced_by_id')}</td>
                <td className="hide-sm sub" title={l.notes ?? ''}>{(l.notes ?? '').slice(0, 60)}{(l.notes ?? '').length > 60 ? '…' : ''}</td>
                <td className="hide-sm sub">{l.signed ? fmtRelative(l.signed_at) : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
