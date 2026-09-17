import { useCallback, useEffect, useState, type ReactElement } from 'react';
import type { ClientReport, ReportsData } from '../../../sweep/types';
import { api, fmtRelative, useLiveUpdates } from '../api';
import { useIsAdmin } from '../session';

/** Tiny markdown renderer for the preview: headings, bullets, bold, tables, paragraphs. */
export function renderMarkdown(md: string): ReactElement {
  const out: ReactElement[] = [];
  const lines = md.split('\n');
  let i = 0;
  const inline = (t: string) => t.split(/(\*\*[^*]+\*\*)/g).map((p, k) => (p.startsWith('**') && p.endsWith('**') ? <b key={k}>{p.slice(2, -2)}</b> : <span key={k}>{p}</span>));
  while (i < lines.length) {
    const l = lines[i];
    if (/^\s*\|.*\|\s*$/.test(l)) {
      const rows: string[][] = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) { const cells = lines[i].trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim()); if (!cells.every((c) => /^:?-+:?$/.test(c))) rows.push(cells); i += 1; }
      out.push(<table key={out.length} style={{ marginBottom: 12 }}><thead><tr>{rows[0]?.map((c, k) => <th key={k}>{c}</th>)}</tr></thead><tbody>{rows.slice(1).map((r, k) => <tr key={k}>{r.map((c, j) => <td key={j}>{inline(c)}</td>)}</tr>)}</tbody></table>);
      continue;
    }
    const h = l.match(/^(#{1,6})\s+(.*)$/);
    if (h) { const level = h[1].length; out.push(level <= 2 ? <h3 key={out.length} style={{ marginBottom: 6 }}>{h[2]}</h3> : <h4 key={out.length} style={{ marginBottom: 4 }}>{h[2]}</h4>); i += 1; continue; }
    if (/^\s*[-*]\s+/.test(l)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*[-*]\s+/, '')); i += 1; }
      out.push(<ul key={out.length} style={{ marginTop: 0 }}>{items.map((it, k) => <li key={k}>{inline(it)}</li>)}</ul>);
      continue;
    }
    if (!l.trim()) { i += 1; continue; }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|\s*[-*]\s|\s*\|)/.test(lines[i])) { para.push(lines[i]); i += 1; }
    out.push(<p key={out.length} style={{ marginTop: 0 }}>{inline(para.join(' '))}</p>);
  }
  return <div>{out}</div>;
}

/** Account management > Client reports: weekly / monthly reports from Cruva, TikTok Shop, the market and the calls, written by Claude, edited here, posted to the client channel. */
export default function ReportsPage() {
  const [data, setData] = useState<ReportsData | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [edit, setEdit] = useState<{ title: string; body: string; slack_channel: string } | null>(null);
  const [preview, setPreview] = useState(true);
  const [gen, setGen] = useState({ account_id: '', period: 'weekly' as 'weekly' | 'monthly', end: '', instructions: '', notes: '' });
  const [bounds, setBounds] = useState<{ start: string; end: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const isAdmin = useIsAdmin();
  const load = useCallback(() => api.reports().then(setData).catch((e) => setError((e as Error).message)), []);
  useEffect(() => { load(); }, [load]);
  const connected = useLiveUpdates((e) => { if (e.kind === 'reports') load(); });
  useEffect(() => { api.reportPeriod(gen.period, gen.end || undefined).then(setBounds).catch(() => setBounds(null)); }, [gen.period, gen.end]);
  const report = data?.reports.find((r) => r.id === selected) ?? null;
  useEffect(() => { setEdit(report ? { title: report.title, body: report.body, slack_channel: report.slack_channel ?? '' } : null); }, [report?.id, report?.updated_at]); // eslint-disable-line react-hooks/exhaustive-deps
  const dirty = report && edit && (edit.title !== report.title || edit.body !== report.body || edit.slack_channel !== (report.slack_channel ?? ''));
  const run = async <T extends ReportsData,>(key: string, fn: () => Promise<T>, after?: (r: T) => void) => {
    setBusy(key);
    setError(null);
    try { const r = await fn(); setData(r); after?.(r); } catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  };
  const save = () => report && edit && run('save', () => api.updateReport(report.id, { title: edit.title, body: edit.body, slack_channel: edit.slack_channel || null }), () => setNotice('Saved.'));
  if (!data) return <p>{error ?? 'Loading…'}</p>;
  const status = (r: ClientReport) => <span className={`badge ${r.status === 'sent' ? 'good' : 'muted'}`}>{r.status === 'sent' ? `Sent ${fmtRelative(r.sent_at)}` : 'Draft'}</span>;
  const acct = data.accounts.find((a) => String(a.id) === gen.account_id);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Client reports</h1>
          <p className="hint" style={{ margin: 0 }}>Weekly or monthly, per account: GMV from the Cruva sync, TikTok Shop analytics, what the market is doing (FastMoss pulls), the tl;dv calls with the client, promotions and incidents. Claude writes it, you edit it, then it goes to the client's Slack channel.</p>
        </div>
        <div className="actions">
          {connected && <span className="badge muted">Live</span>}
          <span className={`badge ${data.llm_configured ? 'good' : 'muted'}`}>{data.llm_configured ? 'Claude writing' : 'Template writing (no ANTHROPIC_API_KEY)'}</span>
          <span className={`badge ${data.slack_configured ? 'good' : 'muted'}`}>{data.slack_configured ? 'Slack bot ready' : 'No SLACK_BOT_TOKEN'}</span>
          <span className={`badge ${data.tldv_configured ? 'good' : 'muted'}`} title="Calls with the client feed the What we did section">{data.tldv_configured ? 'tl;dv' : 'tl;dv not set'}</span>
        </div>
      </div>
      {error && <div className="banner crit">{error}</div>}
      {notice && <div className="banner info">{notice}</div>}

      {isAdmin && (
        <div className="card" style={{ marginBottom: 14 }}>
          <div className="inline-form" style={{ alignItems: 'flex-end' }}>
            <label className="field" style={{ minWidth: 200 }}><span className="lbl">Account</span><select value={gen.account_id} onChange={(e) => setGen({ ...gen, account_id: e.target.value })}><option value="">Pick an account…</option>{data.accounts.map((a) => <option key={a.id} value={a.id}>{a.name}{a.client_slack_channel ? ` (${a.client_slack_channel})` : ''}</option>)}</select></label>
            <label className="field" style={{ minWidth: 120 }}><span className="lbl">Period</span><select value={gen.period} onChange={(e) => setGen({ ...gen, period: e.target.value as 'weekly' | 'monthly' })}><option value="weekly">Weekly</option><option value="monthly">Monthly</option></select></label>
            <label className="field" style={{ minWidth: 150 }}><span className="lbl">{gen.period === 'weekly' ? 'Week ending (Sunday)' : 'Any day in the month'}</span><input type="date" value={gen.end} onChange={(e) => setGen({ ...gen, end: e.target.value })} /><span className="help">{bounds ? `${bounds.start} to ${bounds.end}` : 'Blank = last full period'}</span></label>
            <label className="field" style={{ flex: 1, minWidth: 220 }}><span className="lbl">Notes for the report (one per line)</span><textarea rows={2} value={gen.notes} onChange={(e) => setGen({ ...gen, notes: e.target.value })} placeholder="e.g. New creative batch shot on Tuesday; 3 top creators onboarded" /></label>
            <label className="field" style={{ flex: 1, minWidth: 220 }}><span className="lbl">Instructions (optional)</span><input type="text" value={gen.instructions} onChange={(e) => setGen({ ...gen, instructions: e.target.value })} placeholder="e.g. keep it short, mention the Q4 plan" /></label>
            <button className="primary" disabled={!gen.account_id || busy === 'gen'} onClick={() => run('gen', () => api.generateReport({ account_id: Number(gen.account_id), period: gen.period, end: gen.end || undefined, instructions: gen.instructions || undefined, notes: gen.notes || undefined }), (r) => { setSelected(r.report.id); setNotice(`Report drafted (${r.report.generator}). Review, edit, then send.`); })}>{busy === 'gen' ? 'Writing…' : 'Generate report'}</button>
          </div>
          {acct && !acct.client_slack_channel && <p className="sub" style={{ marginBottom: 0 }}>No client Slack channel on {acct.name} yet. <input type="text" placeholder="#ext-client" style={{ width: 160 }} onKeyDown={(e) => { if (e.key === 'Enter') run('chan', () => api.reportAccount(acct.id, { client_slack_channel: (e.target as HTMLInputElement).value })); }} /> <span className="sub">(Enter to save; also on the Accounts page)</span></p>}
        </div>
      )}

      <div className="inbox-split">
        <div className="inbox-list">
          {data.reports.length === 0 ? <div className="empty">No reports yet.</div> : data.reports.map((r) => (
            <button key={r.id} className={`conv ${selected === r.id ? 'active' : ''}`} onClick={() => setSelected(r.id)}>
              <div className="page-head" style={{ marginBottom: 2 }}><b>{r.account_name}</b> {status(r)}</div>
              <div style={{ fontSize: 13.5 }}>{r.title}</div>
              <div className="sub">{r.period} · {r.period_start} to {r.period_end} · {r.generator === 'claude' ? 'Claude' : 'template'} · {fmtRelative(r.updated_at)}</div>
            </button>
          ))}
        </div>
        <div className="detail card">
          {!report || !edit ? <p className="sub">Pick a report on the left or generate a new one.</p> : (
            <>
              <div className="page-head" style={{ marginBottom: 8 }}>
                <div><b>{report.account_name}</b> <span className="badge muted">{report.period}</span> {status(report)}</div>
                <div className="actions">
                  <button className="small" onClick={() => setPreview(!preview)}>{preview ? 'Edit text' : 'Preview'}</button>
                  <a className="button small" href={api.reportExportUrl(report.id)} download>Download .md</a>
                  {isAdmin && <button className="small" disabled={busy === 'regen'} onClick={() => run('regen', () => api.regenerateReport(report.id, { instructions: window.prompt('Instructions for the rewrite (optional)', '') ?? undefined }), () => setNotice('Rewritten with fresh data.'))}>{busy === 'regen' ? 'Rewriting…' : 'Regenerate'}</button>}
                  {isAdmin && <button className="small danger" onClick={() => window.confirm('Delete this report?') && run('del', () => api.deleteReport(report.id), () => setSelected(null))}>Delete</button>}
                </div>
              </div>
              <div className="inline-form" style={{ marginBottom: 8 }}>
                <label className="field" style={{ flex: 1, minWidth: 260 }}><span className="lbl">Title</span><input type="text" value={edit.title} disabled={!isAdmin} onChange={(e) => setEdit({ ...edit, title: e.target.value })} /></label>
                <label className="field" style={{ minWidth: 180 }}><span className="lbl">Client Slack channel</span><input type="text" value={edit.slack_channel} disabled={!isAdmin} placeholder="#ext-client" onChange={(e) => setEdit({ ...edit, slack_channel: e.target.value })} /></label>
              </div>
              {preview
                ? <div className="card" style={{ background: 'var(--surface-2)', minHeight: 200, cursor: isAdmin ? 'text' : 'default' }} onClick={() => isAdmin && setPreview(false)} title={isAdmin ? 'Click to edit' : ''}>{renderMarkdown(edit.body)}</div>
                : <textarea rows={22} style={{ width: '100%', fontFamily: 'inherit' }} value={edit.body} disabled={!isAdmin} onChange={(e) => setEdit({ ...edit, body: e.target.value })} />}
              {isAdmin && (
                <div className="actions" style={{ marginTop: 10 }}>
                  <button disabled={!dirty || busy === 'save'} onClick={save}>{busy === 'save' ? 'Saving…' : dirty ? 'Save changes' : 'Saved'}</button>
                  <button className="primary" disabled={busy === 'send' || !data.slack_configured} title={data.slack_configured ? 'Post to the client channel (long reports continue in the thread)' : 'Set SLACK_BOT_TOKEN first'} onClick={() => { if (!window.confirm(`Post this report to ${edit.slack_channel || 'the client channel'}?`)) return; run('send', async () => { if (dirty) await api.updateReport(report.id, { title: edit.title, body: edit.body, slack_channel: edit.slack_channel || null }); return api.sendReport(report.id, edit.slack_channel || undefined); }, () => setNotice('Posted to the client channel.')); }}>{busy === 'send' ? 'Posting…' : report.status === 'sent' ? 'Post again' : 'Send to client channel'}</button>
                </div>
              )}
              <details style={{ marginTop: 12 }}>
                <summary className="sub" style={{ cursor: 'pointer' }}>Data behind this report</summary>
                <div className="sub" style={{ marginTop: 6 }}>
                  <div>GMV: {Math.round(report.data.gmv?.total ?? 0).toLocaleString('en-GB')} {report.data.gmv?.currency} this period vs {Math.round(report.data.gmv?.prev_total ?? 0).toLocaleString('en-GB')} previous · affiliate {Math.round(report.data.gmv?.affiliate ?? 0).toLocaleString('en-GB')} · {report.data.gmv?.days_with_data ?? 0} days of data</div>
                  <div>TikTok analytics: {report.data.tts?.length ? report.data.tts.map((t) => `${t.shop_name}: ${t.error ? `error (${t.error.slice(0, 60)})` : `GMV ${t.gmv ?? 'n/a'}, orders ${t.orders ?? 'n/a'}`}`).join(' · ') : 'none'}</div>
                  <div>Calls: {report.data.calls?.length ? report.data.calls.map((c) => `${c.happened_at.slice(0, 10)} ${c.title}`).join(' · ') : 'none matched (set the client domain on the account)'}</div>
                  <div>Promotions: {report.data.promotions?.length ?? 0} · Incidents: {report.data.incidents?.length ?? 0} · Checklist: {report.data.checklist?.complete ?? 0}/{report.data.checklist?.days ?? 0} days</div>
                  <div>Market: {report.data.market?.map((m) => `${m.market} ${m.surging}/${m.prospects} surging`).join(' · ') || 'no markets on the account'}</div>
                </div>
              </details>
            </>
          )}
        </div>
      </div>
    </>
  );
}
