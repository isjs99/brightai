import { useCallback, useEffect, useState } from 'react';
import type { AirtableData, AirtableRecordRow, AirtableTableSchema, CrmLink } from '../../../sweep/types';
import { api, fmtRelative, useLiveUpdates } from '../api';
import { useIsAdmin } from '../session';

/**
 * Growth > CRM: Sofía's Airtable leads pipeline mirrored into the platform. Sync health per table, a
 * browser per table with search, and every record openable in Airtable. The matching and the panels on
 * the other pages come next; this page is where the mirror itself is checked.
 */
type Row = AirtableRecordRow & { resolved: Record<string, string[]> };
const SKIP = new Set(['formula', 'rollup', 'count', 'multipleLookupValues', 'autoNumber', 'createdTime', 'lastModifiedTime', 'button']);

function cell(v: unknown, resolved?: string[]): string {
  if (resolved) return resolved.join(', ');
  if (v === undefined || v === null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return v.map((x) => (x && typeof x === 'object' ? String((x as { name?: unknown; filename?: unknown; email?: unknown }).name ?? (x as { filename?: unknown }).filename ?? (x as { email?: unknown }).email ?? '') : String(x))).join(', ');
  if (typeof v === 'object') { const o = v as { name?: unknown; email?: unknown }; return String(o.name ?? o.email ?? JSON.stringify(v)); }
  return String(v);
}

export default function CrmPage() {
  const [data, setData] = useState<AirtableData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [table, setTable] = useState<string>('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(0);
  const [rows, setRows] = useState<{ rows: Row[]; total: number; schema: AirtableTableSchema | null } | null>(null);
  const [open, setOpen] = useState<Row | null>(null);
  const isAdmin = useIsAdmin();
  const load = useCallback(() => api.airtable().then((d) => { setData(d); setTable((t) => t || d.tables.find((x) => x.name === 'Deals')?.table_id || d.tables[0]?.table_id || ''); }).catch((e) => setError((e as Error).message)), []);
  useEffect(() => { load(); }, [load]);
  useLiveUpdates((e) => { if (e.kind === 'airtable') load(); });
  const setLink = async (l: CrmLink, status: 'confirmed' | 'rejected') => { setError(null); try { setData(await api.airtableLink(l.id, status)); } catch (e) { setError((e as Error).message); } };
  useEffect(() => { if (!table) return; const id = setTimeout(() => api.airtableRecords(table, { q, limit: 50, offset: page * 50 }).then(setRows).catch((e) => setError((e as Error).message)), 200); return () => clearTimeout(id); }, [table, q, page, data?.last_sync_at]);
  if (!data) return <p>{error ?? 'Loading…'}</p>;
  const t = data.tables.find((x) => x.table_id === table) ?? null;
  const fields = (rows?.schema?.fields ?? []).filter((f) => !SKIP.has(f.type));
  const shown = fields.slice(0, 8);
  return (
    <div className="page">
      <div className="page-head">
        <div><h2>CRM{data.base_name ? ` · ${data.base_name}` : ''}</h2><p className="hint" style={{ margin: 0 }}>Sofía's Airtable base mirrored every {data.interval_minutes} minutes (changed records only; everything twice a day). Read-only here; open a record in Airtable to edit it.</p></div>
        <div className="actions">
          <span className={`badge ${data.configured ? (data.last_error ? 'warn' : 'good') : 'muted'}`} title={data.last_error ?? ''}>{data.configured ? data.last_sync_at ? `Synced ${fmtRelative(data.last_sync_at)}` : 'Not synced yet' : 'AIRTABLE_TOKEN not set'}</span>
          {isAdmin && <button className="small" disabled={busy !== null || data.syncing} onClick={async () => { setBusy('sync'); setError(null); try { const r = await api.airtableSync(false); setNotice(`${r.records} changed record(s) across ${r.tables.length} table(s)${r.errors.length ? ` · ${r.errors.join(' | ')}` : ''}`); setData(r); } catch (e) { setError((e as Error).message); } finally { setBusy(null); } }}>{busy === 'sync' || data.syncing ? 'Syncing…' : 'Sync now'}</button>}
          {isAdmin && <button className="small" disabled={busy !== null || data.syncing} onClick={async () => { setBusy('full'); setError(null); try { const r = await api.airtableSync(true); setNotice(`Full sync: ${r.records} record(s), ${r.removed} removed${r.errors.length ? ` · ${r.errors.join(' | ')}` : ''}`); setData(r); } catch (e) { setError((e as Error).message); } finally { setBusy(null); } }}>Full sync</button>}
          <a className="button small" href={`https://airtable.com/${data.base_id}`} target="_blank" rel="noopener">Open base ↗</a>
        </div>
      </div>
      {error && <div className="banner crit">{error}</div>}
      {notice && <div className="banner">{notice}</div>}
      {data.last_error && <div className="banner warn">Last sync: {data.last_error}</div>}
      <div className="card" style={{ marginBottom: 12, padding: '8px 12px' }}>
        <div className="actions" style={{ flexWrap: 'wrap' }}>
          <b>Overlap with our pipeline</b>
          <span className="badge accent" title="BD prospects (Growth › BD pipeline) that are also an account, deal, target, enquiry or Apollo intake in her base, matched by web domain or exact brand name">{data.matches.prospects} BD prospect{data.matches.prospects === 1 ? '' : 's'} labelled</span>
          <span className="badge accent" title="Leads (Growth › Leads) that are also in her base">{data.matches.leads} lead{data.matches.leads === 1 ? '' : 's'} labelled</span>
          {data.matches.review > 0 && <span className="badge warn">{data.matches.review} to check</span>}
          <span className="sub">{data.matches.matched_at ? `Matched ${fmtRelative(data.matches.matched_at)}` : 'Not matched yet'} · her base never adds rows to the pipeline, it only labels the ones that already exist, so a lead is never counted twice.</span>
          <span style={{ flex: 1 }} />
          {isAdmin && <button className="small" disabled={busy !== null} onClick={async () => { setBusy('match'); setError(null); try { const r = await api.airtableMatch(); setNotice(`Matched: ${r.prospects} prospects and ${r.leads} leads carry a label, ${r.review} to check, ${r.changed} link(s) changed.`); setData(r); } catch (e) { setError((e as Error).message); } finally { setBusy(null); } }}>{busy === 'match' ? 'Matching…' : 'Re-match now'}</button>}
        </div>
        <div className="actions" style={{ flexWrap: 'wrap', marginTop: 8 }}>
          <b>Write-back</b>
          <label className="field check" title="Every website enquiry becomes a record in her Website Enquiries table the moment it lands; status, owner and note follow as they change. Formula and link fields are never written."><input type="checkbox" checked={data.write_enquiries} disabled={!isAdmin} onChange={(e) => api.airtableSettings({ write_enquiries: e.target.checked }).then(setData).catch((err) => setError((err as Error).message))} /> Website enquiries → her base</label>
          <span className="sub">{data.writes} field{data.writes === 1 ? '' : 's'} written so far, each logged with what it replaced.</span>
          {isAdmin && data.write_enquiries && <button className="small" disabled={busy !== null} onClick={async () => { setBusy('push'); setError(null); try { const r = await api.airtablePushEnquiries(); setNotice(`Enquiries: ${r.created} added, ${r.updated} updated, ${r.skipped} already there${r.notes.length ? ` · ${r.notes.join(' | ')}` : ''}`); setData(r); } catch (e) { setError((e as Error).message); } finally { setBusy(null); } }} title="Send every enquiry not yet in her base (after the switch goes on, or when the table first appears)">{busy === 'push' ? 'Pushing…' : 'Push enquiries'}</button>}
        </div>
        {data.review.length > 0 && (
          <table className="compact" style={{ marginTop: 8 }}>
            <thead><tr><th>Ours</th><th>Hers</th><th>Why</th><th /></tr></thead>
            <tbody>
              {data.review.slice(0, 40).map((l) => (
                <tr key={l.id}>
                  <td><b>{l.local_name ?? `#${l.local_id}`}</b> <span className="sub">{l.kind === 'prospect' ? 'BD prospect' : 'lead'}</span></td>
                  <td><a href={l.url} target="_blank" rel="noopener">{l.primary ?? l.record_id} ↗</a> <span className="sub">{l.table}{l.stage ? ` · ${l.stage}` : ''}</span></td>
                  <td className="sub">{l.how}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>{isAdmin && <><button className="small" onClick={() => setLink(l, 'confirmed')}>Same company</button> <button className="small" onClick={() => setLink(l, 'rejected')}>Not the same</button></>}</td>
                </tr>
              ))}
              {data.review.length > 40 && <tr><td colSpan={4} className="sub">and {data.review.length - 40} more</td></tr>}
            </tbody>
          </table>
        )}
      </div>
      <div className="presets" style={{ marginBottom: 10, flexWrap: 'wrap' }}>
        {data.tables.map((x) => <button key={x.table_id} className={x.table_id === table ? 'active' : ''} onClick={() => { setTable(x.table_id); setPage(0); setQ(''); }} title={x.error ?? (x.synced_at ? `Synced ${fmtRelative(x.synced_at)}` : 'Not synced')}>{x.name} <span className="sub">{x.records}</span>{x.error ? ' ⚠' : ''}</button>)}
        {data.tables.length === 0 && <span className="sub">No tables yet. {data.configured ? 'Press Sync now.' : 'Set AIRTABLE_TOKEN on the server first.'}</span>}
      </div>
      {t && (
        <>
          <div className="actions" style={{ marginBottom: 8 }}>
            <input placeholder={`Search ${t.name}`} value={q} onChange={(e) => { setQ(e.target.value); setPage(0); }} style={{ width: 300 }} />
            <span className="sub">{rows ? `${rows.total} record${rows.total === 1 ? '' : 's'}` : '…'}{t.schema.description ? ` · ${t.schema.description.slice(0, 160)}` : ''}</span>
            <span style={{ flex: 1 }} />
            {rows && rows.total > 50 && <><button className="small" disabled={page === 0} onClick={() => setPage(page - 1)}>‹</button><span className="sub">{page + 1} / {Math.ceil(rows.total / 50)}</span><button className="small" disabled={(page + 1) * 50 >= rows.total} onClick={() => setPage(page + 1)}>›</button></>}
          </div>
          <div className="grid-wrap"><table><thead><tr>{shown.map((f) => <th key={f.id}>{f.name}</th>)}<th>Modified</th><th /></tr></thead><tbody>
            {(rows?.rows ?? []).map((r) => <tr key={r.record_id} className="clickable" onClick={() => setOpen(r)}>
              {shown.map((f, i) => <td key={f.id} className={i === 0 ? '' : 'sub'} style={{ maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={cell(r.fields[f.name], r.resolved[f.name])}>{i === 0 ? <b>{cell(r.fields[f.name], r.resolved[f.name]) || r.primary || '(blank)'}</b> : cell(r.fields[f.name], r.resolved[f.name]).slice(0, 80)}</td>)}
              <td className="sub">{r.modified_at ? fmtRelative(r.modified_at) : ''}</td>
              <td><a href={`https://airtable.com/${data.base_id}/${t.table_id}/${r.record_id}`} target="_blank" rel="noopener" className="small" onClick={(e) => e.stopPropagation()}>↗</a></td>
            </tr>)}
            {rows && rows.rows.length === 0 && <tr><td colSpan={shown.length + 2} className="sub">Nothing here{q ? ' for that search' : ''}.</td></tr>}
          </tbody></table></div>
        </>
      )}
      {open && t && (
        <div className="modal-backdrop" onClick={() => setOpen(null)}>
          <div className="modal wide" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head"><h3>{open.primary ?? open.record_id}</h3><div className="actions"><a className="button small" href={`https://airtable.com/${data.base_id}/${t.table_id}/${open.record_id}`} target="_blank" rel="noopener">Open in Airtable ↗</a><button className="small" onClick={() => setOpen(null)}>Close</button></div></div>
            <div className="modal-body">
              <table><tbody>
                {(rows?.schema?.fields ?? []).filter((f) => open.fields[f.name] !== undefined && open.fields[f.name] !== null && open.fields[f.name] !== '').map((f) => <tr key={f.id}><td className="sub" style={{ width: 240, verticalAlign: 'top' }}>{f.name}{SKIP.has(f.type) ? <span className="sub"> · computed</span> : null}</td><td style={{ whiteSpace: 'pre-wrap' }}>{cell(open.fields[f.name], open.resolved[f.name])}</td></tr>)}
              </tbody></table>
              <p className="sub">Modified {open.modified_at ? fmtRelative(open.modified_at) : 'unknown'} · synced {fmtRelative(open.synced_at)}</p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
