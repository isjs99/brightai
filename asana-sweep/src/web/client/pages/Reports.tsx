import { useCallback, useEffect, useState, type ReactElement } from 'react';
import type { ClientReport, ReportSchedule, ReportsData } from '../../../sweep/types';
import { api, fmtRelative, useLiveUpdates } from '../api';
import { useIsAdmin } from '../session';
import { useAccountScope, useAllowedAccounts, useInScope } from '../hubs';
import { AccountGroup, GroupsHead, useOpenGroups, type GroupLight } from '../groups';

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

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const pad = (n: number) => String(n).padStart(2, '0');

/**
 * Accounts > Reports: one collapsible block per account with its weekly schedule, the queue of drafts,
 * the Slack message to edit and approve, the Brightform PDF, and send now or autosend.
 */
export default function ReportsPage() {
  const [data, setData] = useState<ReportsData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const isAdmin = useIsAdmin();
  const scope = useAccountScope();
  const inScope = useInScope();
  const allowed = useAllowedAccounts();
  const groups = useOpenGroups('reports');
  const load = useCallback(() => api.reports().then(setData).catch((e) => setError((e as Error).message)), []);
  useEffect(() => { load(); }, [load]);
  const connected = useLiveUpdates((e) => { if (e.kind === 'reports') load(); });
  const run = async <T extends ReportsData,>(key: string, fn: () => Promise<T>, after?: (r: T) => void) => {
    setBusy(key); setError(null);
    try { const r = await fn(); setData(r); after?.(r); } catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  };
  if (!data) return <p>{error ?? 'Loading…'}</p>;
  const accounts = data.accounts.filter((a) => inScope(a.id));
  const reportsOf = (id: number) => data.reports.filter((r) => r.account_id === id);
  const scheduleOf = (id: number): ReportSchedule => data.schedules.find((s) => s.account_id === id) ?? { account_id: id, enabled: false, weekday: 1, hour: 9, minute: 0, period: 'weekly', kind: 'standard', autosend: false, pdf: true, last_generated_at: null, updated_at: null };
  const lightOf = (id: number): GroupLight => {
    const rs = reportsOf(id);
    const drafts = rs.filter((r) => r.status === 'draft');
    if (drafts.some((r) => Date.now() - Date.parse(r.created_at) > 3 * 86400000)) return 'red';
    if (drafts.length || rs.some((r) => r.status === 'approved')) return 'amber';
    if (rs.some((r) => r.status === 'sent')) return 'green';
    return 'grey';
  };
  const order: GroupLight[] = ['red', 'amber', 'green', 'grey'];
  const sorted = [...accounts].sort((a, b) => order.indexOf(lightOf(a.id)) - order.indexOf(lightOf(b.id)) || a.name.localeCompare(b.name));
  const queue = data.reports.filter((r) => r.status !== 'sent' && accounts.some((a) => a.id === r.account_id));
  const sentWeek = data.reports.filter((r) => r.status === 'sent' && r.sent_at && Date.now() - Date.parse(r.sent_at) < 7 * 86400000 && accounts.some((a) => a.id === r.account_id)).length;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Reports</h1>
          <p className="hint" style={{ margin: 0 }}>Weekly or monthly, per account: GMV and the creator programme from Cruva, TikTok Shop analytics, the market, the calls, what the client said in their channel and by email. Claude writes it, it waits in your queue as a draft with the Slack message ready to edit; approve it and send now or let it go out by itself.</p>
        </div>
        <div className="actions">
          {connected && <span className="badge muted">Live</span>}
          <span className={`badge ${data.llm_configured ? 'good' : 'muted'}`}>{data.llm_configured ? 'Claude writing' : 'Template writing (no ANTHROPIC_API_KEY)'}</span>
          <span className={`badge ${data.slack_configured ? 'good' : 'muted'}`}>{data.slack_configured ? 'Slack bot ready' : 'No SLACK_BOT_TOKEN'}</span>
          <span className={`badge ${data.tldv_configured ? 'good' : 'muted'}`}>{data.tldv_configured ? 'tl;dv' : 'tl;dv not set'}</span>
          {isAdmin && <button className="small" disabled={busy === 'tick'} onClick={() => run('tick', () => api.reportQueueTick(), (r) => setNotice(`Queue run: ${r.generated} generated, ${r.sent} sent${r.errors.length ? `; ${r.errors.join(' · ')}` : ''}.`))}>{busy === 'tick' ? 'Running…' : 'Run queue now'}</button>}
        </div>
      </div>
      {error && <div className="banner crit">{error}</div>}
      {notice && <div className="banner info">{notice}</div>}
      <div className="stats" style={{ marginBottom: 14 }}>
        <div className="stat"><span className="v">{queue.filter((r) => r.status === 'draft').length}</span><span className="k">drafts to review</span></div>
        <div className="stat"><span className="v">{queue.filter((r) => r.status === 'approved').length}</span><span className="k">approved, waiting to go</span></div>
        <div className="stat"><span className="v">{sentWeek}</span><span className="k">sent in the last 7 days</span></div>
        <div className="stat"><span className="v">{data.schedules.filter((s) => s.enabled && accounts.some((a) => a.id === s.account_id)).length}/{accounts.length}</span><span className="k">accounts on a schedule</span></div>
      </div>

      <GroupsHead items={sorted.length} lights={sorted.map((a) => lightOf(a.id))} open={sorted.every((a) => groups.isOpen(a.id))} onAll={(o) => groups.setAll(sorted.map((a) => a.id), o)} />
      <div className="areas">
        {sorted.map((a) => {
          const rs = reportsOf(a.id);
          const s = scheduleOf(a.id);
          const drafts = rs.filter((r) => r.status === 'draft').length;
          const lastSent = rs.filter((r) => r.status === 'sent').map((r) => r.sent_at as string).sort().pop() ?? null;
          return (
            <AccountGroup key={a.id} light={lightOf(a.id)} name={a.name} sub={a.markets ?? undefined} open={groups.isOpen(a.id)} onToggle={() => groups.toggle(a.id)}
              summary={`${drafts ? `${drafts} draft${drafts === 1 ? '' : 's'} to review` : rs.some((r) => r.status === 'approved') ? 'Approved, waiting to send' : lastSent ? `Last sent ${fmtRelative(lastSent)}` : 'No report yet'}${s.enabled ? ` · ${s.period} ${DAYS[s.weekday - 1]} ${pad(s.hour)}:${pad(s.minute)}${s.autosend ? ' autosend' : ''}` : ''}`}
              nums={<><span className="num"><span className="k">Queue</span><span className="v">{rs.filter((r) => r.status !== 'sent').length}</span></span><span className="num"><span className="k">Sent</span><span className="v">{rs.filter((r) => r.status === 'sent').length}</span></span></>}
              right={<>{s.enabled && <span className="badge accent" title="On a schedule">{s.kind === 'cruva' ? 'Cruva ' : ''}{s.period}</span>}{!a.client_slack_channel && <span className="badge muted" title="No client Slack channel on the account">no channel</span>}</>}>
              {groups.isOpen(a.id) && <AccountReports account={a} reports={rs} schedule={s} data={data} busy={busy} run={run} isAdmin={isAdmin} setNotice={setNotice} />}
            </AccountGroup>
          );
        })}
      </div>
    </>
  );
}

function AccountReports({ account, reports, schedule, data, busy, run, isAdmin, setNotice }: { account: ReportsData['accounts'][number]; reports: ClientReport[]; schedule: ReportSchedule; data: ReportsData; busy: string | null; run: <T extends ReportsData>(key: string, fn: () => Promise<T>, after?: (r: T) => void) => Promise<void>; isAdmin: boolean; setNotice: (s: string) => void }) {
  const [gen, setGen] = useState({ period: 'weekly' as 'weekly' | 'monthly', kind: 'standard' as 'standard' | 'cruva', end: '', notes: '', instructions: '' });
  const [selected, setSelected] = useState<number | null>(reports.find((r) => r.status !== 'sent')?.id ?? reports[0]?.id ?? null);
  const [showSchedule, setShowSchedule] = useState(false);
  const report = reports.find((r) => r.id === selected) ?? null;
  const sched = (patch: Partial<ReportSchedule>) => run(`sch${account.id}`, () => api.reportSchedule(account.id, patch));
  const status = (r: ClientReport) => <span className={`badge ${r.status === 'sent' ? 'good' : r.status === 'approved' ? 'accent' : 'warn'}`}>{r.status === 'sent' ? `Sent ${fmtRelative(r.sent_at)}` : r.status === 'approved' ? (r.send_at ? `Goes out ${fmtRelative(r.send_at)}` : 'Approved') : 'Draft'}</span>;
  return (
    <div>
      <div className="toolbar" style={{ alignItems: 'flex-end' }}>
        {isAdmin && (
          <>
            <label className="field" style={{ minWidth: 110 }}><span className="lbl">Period</span><select value={gen.period} onChange={(e) => setGen({ ...gen, period: e.target.value as 'weekly' | 'monthly' })}><option value="weekly">Weekly</option><option value="monthly">Monthly</option></select></label>
            <label className="field" style={{ minWidth: 150 }}><span className="lbl">{gen.period === 'weekly' ? 'Week ending (Sun)' : 'Any day in month'}</span><input type="date" value={gen.end} onChange={(e) => setGen({ ...gen, end: e.target.value })} /></label>
            <label className="field" style={{ flex: 1, minWidth: 200 }}><span className="lbl">Notes for the report</span><input type="text" value={gen.notes} onChange={(e) => setGen({ ...gen, notes: e.target.value })} placeholder="e.g. New creative batch shot Tuesday; 3 top creators onboarded" /></label>
            <button className="primary" disabled={busy === `gen${account.id}`} onClick={() => run(`gen${account.id}`, () => api.generateReport({ account_id: account.id, period: gen.period, end: gen.end || undefined, notes: gen.notes || undefined, instructions: gen.instructions || undefined, kind: 'standard' }), (r) => { setSelected(r.report.id); setNotice('Report drafted and added to the queue.'); })}>{busy === `gen${account.id}` ? 'Writing…' : 'Generate report'}</button>
            <button disabled={busy === `genc${account.id}`} title="Creator programme report from Cruva: DMs, samples, videos, views, affiliate GMV, score" onClick={() => run(`genc${account.id}`, () => api.generateReport({ account_id: account.id, period: gen.period, end: gen.end || undefined, notes: gen.notes || undefined, kind: 'cruva' }), (r) => { setSelected(r.report.id); setNotice('Cruva report drafted and added to the queue.'); })}>{busy === `genc${account.id}` ? 'Writing…' : 'Generate Cruva report'}</button>
            <button className="small" onClick={() => setShowSchedule((v) => !v)}>{showSchedule ? 'Hide schedule' : schedule.enabled ? 'Schedule' : 'Schedule weekly report'}</button>
          </>
        )}
      </div>
      {showSchedule && isAdmin && (
        <div className="card" style={{ marginBottom: 10 }}>
          <div className="inline-form" style={{ alignItems: 'flex-end' }}>
            <label className="field check"><input type="checkbox" checked={schedule.enabled} onChange={(e) => sched({ enabled: e.target.checked })} /> Generate on a schedule</label>
            <label className="field" style={{ minWidth: 100 }}><span className="lbl">Day</span><select value={schedule.weekday} onChange={(e) => sched({ weekday: Number(e.target.value) })}>{DAYS.map((d, i) => <option key={d} value={i + 1}>{d}</option>)}</select></label>
            <label className="field" style={{ minWidth: 80 }}><span className="lbl">Hour</span><input type="number" min={0} max={23} defaultValue={schedule.hour} onBlur={(e) => sched({ hour: Number(e.target.value) })} /></label>
            <label className="field" style={{ minWidth: 80 }}><span className="lbl">Minute</span><input type="number" min={0} max={59} step={5} defaultValue={schedule.minute} onBlur={(e) => sched({ minute: Number(e.target.value) })} /></label>
            <label className="field" style={{ minWidth: 110 }}><span className="lbl">Period</span><select value={schedule.period} onChange={(e) => sched({ period: e.target.value as 'weekly' | 'monthly' })}><option value="weekly">Weekly</option><option value="monthly">Monthly</option></select></label>
            <label className="field" style={{ minWidth: 130 }}><span className="lbl">Report</span><select value={schedule.kind} onChange={(e) => sched({ kind: e.target.value as 'standard' | 'cruva' })}><option value="standard">Standard</option><option value="cruva">Cruva report</option></select></label>
            <label className="field check" title="Send to the client channel the moment it is generated; otherwise it waits in the queue for approval"><input type="checkbox" checked={schedule.autosend} onChange={(e) => sched({ autosend: e.target.checked })} /> Autosend</label>
            <label className="field check"><input type="checkbox" checked={schedule.pdf} onChange={(e) => sched({ pdf: e.target.checked })} /> Attach PDF</label>
            <span className="sub">{schedule.last_generated_at ? `Last generated ${fmtRelative(schedule.last_generated_at)}` : 'Not generated yet'} · times in the team timezone</span>
          </div>
        </div>
      )}
      {!account.client_slack_channel && <div className="banner warn">No client Slack channel on {account.name}. Set it under Settings → Accounts so reports can be sent.</div>}
      {reports.length === 0 ? <div className="empty">No reports for {account.name} yet.</div> : (
        <div className="inbox-split">
          <div className="inbox-list">
            {reports.map((r) => (
              <button key={r.id} className={`conv ${selected === r.id ? 'active' : ''}`} onClick={() => setSelected(r.id)}>
                <div className="page-head" style={{ marginBottom: 2 }}><span>{r.kind === 'cruva' ? <span className="badge accent">Cruva</span> : <span className="badge muted">{r.period}</span>}</span> {status(r)}</div>
                <div style={{ fontSize: 13.5 }}>{r.title}</div>
                <div className="sub">{r.period_start} to {r.period_end} · {r.generator === 'claude' ? 'Claude' : 'template'} · {fmtRelative(r.updated_at)}</div>
              </button>
            ))}
          </div>
          <div className="detail card">
            {report ? <ReportDetail key={report.id} report={report} data={data} busy={busy} run={run} isAdmin={isAdmin} setNotice={setNotice} onDeleted={() => setSelected(null)} /> : <p className="sub">Pick a report on the left.</p>}
          </div>
        </div>
      )}
    </div>
  );
}

function ReportDetail({ report, data, busy, run, isAdmin, setNotice, onDeleted }: { report: ClientReport; data: ReportsData; busy: string | null; run: <T extends ReportsData>(key: string, fn: () => Promise<T>, after?: (r: T) => void) => Promise<void>; isAdmin: boolean; setNotice: (s: string) => void; onDeleted: () => void }) {
  const [tab, setTab] = useState<'slack' | 'preview' | 'edit'>(report.status === 'sent' ? 'preview' : 'slack');
  const [edit, setEdit] = useState({ title: report.title, body: report.body, slack_channel: report.slack_channel ?? '', slack_draft: report.slack_draft ?? '' });
  const [sendAt, setSendAt] = useState('');
  const [withPdf, setWithPdf] = useState(true);
  useEffect(() => { setEdit({ title: report.title, body: report.body, slack_channel: report.slack_channel ?? '', slack_draft: report.slack_draft ?? '' }); }, [report.updated_at]); // eslint-disable-line react-hooks/exhaustive-deps
  const dirty = edit.title !== report.title || edit.body !== report.body || edit.slack_channel !== (report.slack_channel ?? '') || edit.slack_draft !== (report.slack_draft ?? '');
  const save = () => run('save', () => api.updateReport(report.id, { title: edit.title, body: edit.body, slack_channel: edit.slack_channel || null, slack_draft: edit.slack_draft || null }), () => setNotice('Saved.'));
  const ctx = report.data.context;
  return (
    <>
      <div className="page-head" style={{ marginBottom: 8 }}>
        <div>
          <b>{report.account_name}</b> {report.kind === 'cruva' ? <span className="badge accent">Cruva report</span> : <span className="badge muted">{report.period}</span>} <span className={`badge ${report.status === 'sent' ? 'good' : report.status === 'approved' ? 'accent' : 'warn'}`}>{report.status === 'sent' ? `Sent ${fmtRelative(report.sent_at)}` : report.status === 'approved' ? `Approved by ${report.approved_by ?? 'someone'}${report.send_at ? `, goes out ${fmtRelative(report.send_at)}` : ''}` : 'Draft'}</span>
          <div className="sub">{report.period_start} to {report.period_end} · written by {report.generator === 'claude' ? 'Claude' : 'the template'} {fmtRelative(report.created_at)}{report.created_by ? ` · ${report.created_by}` : ''}</div>
        </div>
        <div className="actions">
          <div className="presets">
            <button className={tab === 'slack' ? 'active' : ''} onClick={() => setTab('slack')}>Slack message</button>
            <button className={tab === 'preview' ? 'active' : ''} onClick={() => setTab('preview')}>Report</button>
            {isAdmin && <button className={tab === 'edit' ? 'active' : ''} onClick={() => setTab('edit')}>Edit text</button>}
          </div>
          <a className="button small" href={api.reportPdfUrl(report.id)} target="_blank" rel="noreferrer" title="The Brightform PDF">Open PDF</a>
          <a className="button small" href={api.reportPdfUrl(report.id, true)} download>Download PDF</a>
          <a className="button small" href={api.reportExportUrl(report.id)} download>.md</a>
        </div>
      </div>
      {tab === 'slack' && (
        <>
          <p className="sub" style={{ marginTop: 0 }}>This is what goes to <b>{edit.slack_channel || 'the client channel'}</b>{withPdf ? ', with the PDF in the thread' : ''}. Edit it freely; the report itself stays as the PDF.</p>
          <textarea className="slack-text" rows={18} style={{ width: '100%', fontFamily: 'inherit' }} value={edit.slack_draft} disabled={!isAdmin || report.status === 'sent'} onChange={(e) => setEdit({ ...edit, slack_draft: e.target.value })} />
        </>
      )}
      {tab === 'preview' && <div className="card" style={{ background: 'var(--surface-2)', minHeight: 200 }}>{renderMarkdown(`# ${edit.title}\n\n${edit.body}`)}</div>}
      {tab === 'edit' && (
        <>
          <div className="inline-form" style={{ marginBottom: 8 }}>
            <label className="field" style={{ flex: 1, minWidth: 260 }}><span className="lbl">Title</span><input type="text" value={edit.title} onChange={(e) => setEdit({ ...edit, title: e.target.value })} /></label>
            <label className="field" style={{ minWidth: 180 }}><span className="lbl">Client Slack channel</span><input type="text" value={edit.slack_channel} placeholder="#ext-client" onChange={(e) => setEdit({ ...edit, slack_channel: e.target.value })} /></label>
          </div>
          <textarea rows={22} style={{ width: '100%', fontFamily: 'inherit' }} value={edit.body} onChange={(e) => setEdit({ ...edit, body: e.target.value })} />
        </>
      )}
      {isAdmin && (
        <div className="actions" style={{ marginTop: 10, flexWrap: 'wrap' }}>
          <button disabled={!dirty || busy === 'save'} onClick={save}>{busy === 'save' ? 'Saving…' : dirty ? 'Save changes' : 'Saved'}</button>
          {report.status === 'draft' && <>
            <button className="primary" disabled={busy === 'approve'} onClick={() => run('approve', async () => { if (dirty) await api.updateReport(report.id, { title: edit.title, body: edit.body, slack_channel: edit.slack_channel || null, slack_draft: edit.slack_draft || null }); return api.approveReport(report.id, sendAt ? new Date(sendAt).toISOString() : null); }, () => setNotice(sendAt ? 'Approved; it goes out at the time set.' : 'Approved. Send now when ready.'))}>{busy === 'approve' ? 'Approving…' : sendAt ? 'Approve, autosend at time' : 'Approve'}</button>
            <label className="field" style={{ minWidth: 200 }}><span className="lbl">Autosend at (optional)</span><input type="datetime-local" value={sendAt} onChange={(e) => setSendAt(e.target.value)} /></label>
          </>}
          {report.status === 'approved' && <button className="small" onClick={() => run('unapprove', () => api.unapproveReport(report.id))}>Back to draft</button>}
          {report.status !== 'sent' && <>
            <label className="field check"><input type="checkbox" checked={withPdf} onChange={(e) => setWithPdf(e.target.checked)} /> Attach PDF</label>
            <button className="primary" disabled={busy === 'send' || !data.slack_configured} title={data.slack_configured ? 'Post the Slack message to the client channel now' : 'Set SLACK_BOT_TOKEN first'} onClick={() => { if (!window.confirm(`Send this to ${edit.slack_channel || 'the client channel'} now?`)) return; run('send', async () => { if (dirty) await api.updateReport(report.id, { title: edit.title, body: edit.body, slack_channel: edit.slack_channel || null, slack_draft: edit.slack_draft || null }); return api.sendReport(report.id, edit.slack_channel || undefined, { pdf: withPdf, slack_draft: edit.slack_draft || undefined }); }, () => setNotice('Sent to the client channel.')); }}>{busy === 'send' ? 'Sending…' : 'Send now'}</button>
          </>}
          {report.status === 'sent' && <button disabled={busy === 'send'} onClick={() => window.confirm('Post this report again?') && run('send', () => api.sendReport(report.id, edit.slack_channel || undefined, { pdf: withPdf }))}>Post again</button>}
          <button className="small" disabled={busy === 'regen'} onClick={() => run('regen', () => api.regenerateReport(report.id, { instructions: window.prompt('Instructions for the rewrite (optional)', '') ?? undefined }), () => setNotice('Rewritten with fresh data; back in the queue as a draft.'))}>{busy === 'regen' ? 'Rewriting…' : 'Regenerate'}</button>
          <button className="small danger" onClick={() => window.confirm('Delete this report?') && run('del', () => api.deleteReport(report.id), onDeleted)}>Delete</button>
        </div>
      )}
      <details style={{ marginTop: 12 }}>
        <summary className="sub" style={{ cursor: 'pointer' }}>Data behind this report</summary>
        <div className="sub" style={{ marginTop: 6 }}>
          <div>GMV: {Math.round(report.data.gmv?.total ?? 0).toLocaleString('en-GB')} {report.data.gmv?.currency} this period vs {Math.round(report.data.gmv?.prev_total ?? 0).toLocaleString('en-GB')} previous · affiliate {Math.round(report.data.gmv?.affiliate ?? 0).toLocaleString('en-GB')} · {report.data.gmv?.days_with_data ?? 0} days of data</div>
          {report.data.cruva && <div>Cruva: {report.data.cruva.totals.videos_posted} videos · {Math.round(report.data.cruva.totals.video_views).toLocaleString('en-GB')} views · {report.data.cruva.totals.samples_shipped} samples shipped · {report.data.cruva.totals.dms_sent} DMs{report.data.cruva.shops.some((s) => s.sps !== null) ? ` · score ${report.data.cruva.shops.filter((s) => s.sps !== null).map((s) => `${s.shop_name} ${s.sps}`).join(', ')}` : ''}</div>}
          <div>TikTok analytics: {report.data.tts?.length ? report.data.tts.map((t) => `${t.shop_name}: ${t.error ? `error (${t.error.slice(0, 60)})` : `GMV ${t.gmv ?? 'n/a'}, orders ${t.orders ?? 'n/a'}`}`).join(' · ') : 'none'}</div>
          <div>Calls: {report.data.calls?.length ? report.data.calls.map((c) => `${c.happened_at.slice(0, 10)} ${c.title}`).join(' · ') : 'none matched (set the client domain on the account)'}</div>
          <div>Client channel: {ctx?.slack.length ?? 0} day(s) of messages · Emails: {ctx?.emails.length ?? 0}</div>
          <div>Promotions: {report.data.promotions?.length ?? 0} · Incidents: {report.data.incidents?.length ?? 0} · Checklist: {report.data.checklist?.complete ?? 0}/{report.data.checklist?.days ?? 0} days</div>
          <div>Market: {report.data.market?.map((m) => `${m.market} ${m.surging}/${m.prospects} surging`).join(' · ') || 'no markets on the account'}</div>
        </div>
      </details>
    </>
  );
}
