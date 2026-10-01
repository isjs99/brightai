import { useCallback, useEffect, useState } from 'react';
import type { InquiriesData, InquiryHistory, SiteInquiry } from '../../../sweep/types';
import { api, currentActor, fmtDate, fmtRelative, useLiveUpdates } from '../api';
import { useIsAdmin } from '../session';

const STATUS: Record<SiteInquiry['status'], { label: string; cls: string }> = { new: { label: 'New', cls: 'crit' }, replied: { label: 'Replied', cls: 'good' }, qualified: { label: 'Qualified', cls: 'good' }, closed: { label: 'Closed', cls: 'muted' } };
const KIND: Record<SiteInquiry['kind'], string> = { call: 'Call request', contact: 'Message' };
const EVENT_ICON: Record<string, string> = { created: '📥', forwarded: '📤', assigned: '👤', status: '🏷️', note: '📝', draft: '✉️', slack: '💬' };

/** The row that opens under an enquiry: what was done with it, by whom, and any emails to or from them in Gmail. */
function History({ id, reloadKey }: { id: number; reloadKey: string }) {
  const [h, setH] = useState<InquiryHistory | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { setH(null); setErr(null); api.inquiryHistory(id).then(setH).catch((e) => setErr((e as Error).message)); }, [id, reloadKey]);
  if (err) return <div className="banner crit">{err}</div>;
  if (!h) return <p className="sub">Loading history…</p>;
  return (
    <div className="history" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 18 }}>
      <div>
        <p className="lbl" style={{ marginBottom: 6 }}>What happened</p>
        <ul className="timeline" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {h.events.map((e, i) => (
            <li key={`${e.id}-${i}`} style={{ display: 'flex', gap: 8, padding: '4px 0', borderBottom: '1px solid var(--line, #eee)' }}>
              <span style={{ width: 22 }}>{EVENT_ICON[e.kind] ?? '•'}</span>
              <span style={{ flex: 1 }}>{e.url ? <a href={e.url} target="_blank" rel="noreferrer">{e.detail}</a> : e.detail}{e.actor ? <span className="sub"> · {e.actor}</span> : null}</span>
              <span className="sub" title={e.at}>{fmtDate(e.at)}</span>
            </li>
          ))}
        </ul>
      </div>
      <div>
        <p className="lbl" style={{ marginBottom: 6 }}>Emails with them{h.mail_account ? <span className="sub"> · in {h.mail_account}</span> : null}</p>
        {!h.mail_account ? <p className="sub">Connect Gmail (Growth › Outreach emails › Settings) to see the actual emails exchanged with this person.</p>
          : h.mail_error ? <div className="banner crit">{h.mail_error}</div>
          : h.mail.length === 0 ? <p className="sub">No emails to or from {h.inquiry.email} yet.</p>
          : (
            <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
              {h.mail.map((m) => (
                <li key={m.id} style={{ padding: '4px 0', borderBottom: '1px solid var(--line, #eee)' }}>
                  <div><span className={`badge ${m.direction === 'sent' ? 'good' : 'muted'}`}>{m.direction === 'sent' ? 'Sent' : 'Received'}</span> <a href={m.url} target="_blank" rel="noreferrer"><b>{m.subject}</b></a> <span className="sub" title={m.date ?? ''}>{m.date ? fmtDate(m.date) : ''}</span></div>
                  <div className="sub">{m.snippet}</div>
                </li>
              ))}
            </ul>
          )}
      </div>
    </div>
  );
}

/** Growth > Website enquiries: what the contact form on brightform.agency sends in, who owns it, and a one-click Gmail draft to reply. */
export default function InquiriesPage() {
  const [data, setData] = useState<InquiriesData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [only, setOnly] = useState<'open' | 'all'>('open');
  const [kind, setKind] = useState<'all' | SiteInquiry['kind']>('all');
  const [openId, setOpenId] = useState<number | null>(null);
  const [histKey, setHistKey] = useState('0');
  const [showSettings, setShowSettings] = useState(false);
  const isAdmin = useIsAdmin();
  const load = useCallback(() => api.inquiries().then(setData).catch((e) => setError((e as Error).message)), []);
  useEffect(() => { load(); }, [load]);
  const connected = useLiveUpdates((e) => { if (e.kind === 'inquiries') load(); });
  const run = async <T extends InquiriesData,>(key: string, fn: () => Promise<T>, after?: (r: T) => void) => {
    setBusy(key); setError(null);
    try { const r = await fn(); setData(r); after?.(r); setHistKey(String(Date.now())); } catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  };
  if (!data) return <p>{error ?? 'Loading…'}</p>;
  const list = data.inquiries.filter((i) => (only === 'all' || i.status === 'new' || i.status === 'qualified') && (kind === 'all' || i.kind === kind));
  const forwardOn = Boolean(data.forward_to);
  const me = currentActor();
  const myGmail = data.gmail_accounts.find((a) => a.person && a.person === me) ?? null;
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Website enquiries</h1>
          <p className="hint" style={{ margin: 0 }}>Every message and every "Book a call" request from brightform.agency lands here (and in Slack{data.slack_channel ? ` in ${data.slack_channel}` : ''}){forwardOn ? `, and is emailed to ${data.forward_to}` : ''}. Assign it, draft the reply into Gmail, mark it replied or qualified. Duplicates and bots are dropped before they get here.</p>
        </div>
        <div className="actions">
          {connected && <span className="badge muted">Live</span>}
          <span className={`badge ${data.slack_configured && data.slack_channel ? 'good' : 'muted'}`}>{data.slack_configured ? data.slack_channel ? 'Slack on' : 'No Slack channel set' : 'Slack bot not configured'}</span>
          <span className={`badge ${myGmail || data.gmail_connected ? 'good' : 'muted'}`} title={myGmail ? `Drafts go out from your own Gmail (${myGmail.email})` : data.gmail_connected ? `Drafts go out from the shared Gmail (${data.gmail_email})` : 'Connect Gmail under Growth › Outreach emails › Settings'}>{myGmail ? `Gmail: you (${myGmail.email})` : data.gmail_connected ? `Gmail: shared (${data.gmail_email})` : 'Gmail not connected'}</span>
          <span className={`badge ${forwardOn && data.gmail_connected ? 'good' : forwardOn ? 'warn' : 'muted'}`} title={forwardOn && !data.gmail_connected ? 'Connect Gmail (Growth › Outreach emails › Settings) so enquiries can be emailed' : ''}>{forwardOn ? data.gmail_connected ? `Email forward to ${data.forward_to}` : 'Email forward waiting on Gmail' : 'Email forward off'}</span>
          {isAdmin && <button onClick={() => setShowSettings(!showSettings)}>{showSettings ? 'Hide settings' : 'Settings'}</button>}
        </div>
      </div>
      {error && <div className="banner crit">{error}</div>}
      {notice && <div className="banner info">{notice}</div>}
      {showSettings && (
        <div className="card" style={{ marginBottom: 14 }}>
          <div className="inline-form">
            <label className="field" style={{ minWidth: 220 }}><span className="lbl">Slack channel for new enquiries</span><input type="text" defaultValue={data.slack_channel} placeholder="#sales" onBlur={(e) => e.target.value !== data.slack_channel && run('s', () => api.inquirySettings({ slack_channel: e.target.value }))} /><span className="help">Falls back to the incidents default channel.</span></label>
            <label className="field" style={{ minWidth: 260 }}><span className="lbl">Forward every enquiry by email to</span><input type="email" defaultValue={data.forward_to} placeholder="isaac@brightform.agency" onBlur={(e) => e.target.value.trim() !== data.forward_to && run('f', () => api.inquirySettings({ forward_to: e.target.value }))} /><span className="help">Sent from the connected Gmail account with Reply-To set to the enquirer, so a plain reply goes straight back to them. Empty switches it off.</span></label>
            <label className="field" style={{ minWidth: 360 }}><span className="lbl">Allowed site origins</span><input type="text" defaultValue={data.origins.join(', ')} onBlur={(e) => e.target.value !== data.origins.join(', ') && run('o', () => api.inquirySettings({ origins: e.target.value }))} /><span className="help">Comma separated. Lovable previews, Cloudflare Pages previews and localhost are always allowed.</span></label>
          </div>
          <p className="sub" style={{ marginBottom: 0 }}>The site posts to <code>POST /api/site/contact</code> with <code>{'{ kind: "contact" | "call", name, email, brand, phone, preferred_time, message, language, page }'}</code>. Five messages per hour per network, one per email every two minutes.</p>
        </div>
      )}
      <div className="stats" style={{ marginBottom: 14 }}>
        <div className="stat"><span className="v">{data.inquiries.filter((i) => i.status === 'new').length}</span><span className="k">waiting for a reply</span></div>
        <div className="stat"><span className="v">{data.inquiries.filter((i) => i.kind === 'call' && i.status === 'new').length}</span><span className="k">call requests to schedule</span></div>
        <div className="stat"><span className="v">{data.inquiries.filter((i) => i.status === 'qualified').length}</span><span className="k">qualified</span></div>
        <div className="stat"><span className="v">{data.inquiries.filter((i) => Date.now() - Date.parse(i.created_at) < 7 * 86400000).length}</span><span className="k">this week</span></div>
      </div>
      <div className="toolbar">
        <select value={only} onChange={(e) => setOnly(e.target.value as 'open' | 'all')}><option value="open">Open</option><option value="all">All incl. replied and closed</option></select>
        <select value={kind} onChange={(e) => setKind(e.target.value as 'all' | SiteInquiry['kind'])}><option value="all">Messages and call requests</option><option value="call">Call requests</option><option value="contact">Messages</option></select>
        <span className="sub">{list.length} enquir{list.length === 1 ? 'y' : 'ies'}</span>
      </div>
      <p className="sub" style={{ margin: '0 0 8px' }}>Click an enquiry to see its history: who emailed, assigned, drafted or closed it, and the emails exchanged with them.</p>
      {list.length === 0 ? <div className="empty">Nothing {only === 'open' ? 'open' : 'yet'}. The form on the website posts straight here.</div> : (
        <div className="grid-wrap"><table><thead><tr><th>Status</th><th>From</th><th>Message</th><th>Owner</th><th>When</th><th></th></tr></thead><tbody>
          {list.flatMap((i) => [
            <tr key={i.id} className={`${i.status === 'closed' ? 'dim ' : ''}clickable${openId === i.id ? ' open' : ''}`} style={{ cursor: 'pointer' }} onClick={(e) => { const t = e.target as HTMLElement; if (t.closest('button, select, a, input')) return; setOpenId(openId === i.id ? null : i.id); }}>
              <td><span className={`badge ${STATUS[i.status].cls}`}>{STATUS[i.status].label}</span><div style={{ marginTop: 4 }}><span className={`badge ${i.kind === 'call' ? 'warn' : 'muted'}`}>{KIND[i.kind]}</span></div></td>
              <td><b>{i.name}</b>{i.brand && <div>{i.brand}</div>}<div className="sub"><a href={`mailto:${i.email}`}>{i.email}</a>{i.language ? ` · ${i.language.toUpperCase()}` : ''}{i.gclid ? ' · from Google Ads' : ''}</div>{i.phone && <div className="sub"><a href={`tel:${i.phone.replace(/\s+/g, '')}`}>{i.phone}</a></div>}</td>
              <td style={{ maxWidth: 460, whiteSpace: 'pre-wrap' }}>{i.kind === 'call' && i.preferred_time && <div className="sub" style={{ marginBottom: 4 }}>Prefers: {i.preferred_time.replace(/^[a-z]+:\s*/, '')}</div>}{i.message}{i.note && <div className="sub" style={{ marginTop: 6 }}>Note: {i.note}</div>}</td>
              <td>{isAdmin ? <select value={i.assigned_to ?? ''} onChange={(e) => run(`a${i.id}`, () => api.updateInquiry(i.id, { assigned_to: e.target.value || null }))} style={{ width: 'auto' }}><option value="">Unassigned</option>{data.people.map((p) => <option key={p.id} value={p.name}>{p.name}</option>)}</select> : <span className="sub">{i.assigned_to ?? 'unassigned'}</span>}</td>
              <td className="sub" title={i.created_at}>{fmtRelative(i.created_at)}{i.replied_at ? <div>replied {fmtRelative(i.replied_at)}</div> : null}{i.forwarded_at ? <div title={i.forwarded_at}>emailed {fmtRelative(i.forwarded_at)}</div> : forwardOn ? <div className="warn-text">not emailed</div> : null}</td>
              <td>{isAdmin && <div className="actions">
                {data.gmail_connected && <button className="small primary" disabled={busy !== null} onClick={() => run(`d${i.id}`, () => api.draftInquiryReply(i.id, currentActor() || null), (r) => { setNotice('Draft is in Gmail; edit and send it there.'); window.open(r.draft.url, '_blank'); })}>{busy === `d${i.id}` ? 'Drafting…' : i.kind === 'call' ? 'Draft times' : 'Draft reply'}</button>}
                {data.gmail_connected && forwardOn && !i.forwarded_at && <button className="small" disabled={busy !== null} onClick={() => run(`f${i.id}`, () => api.forwardInquiry(i.id), () => setNotice(`Emailed to ${data.forward_to}.`))}>{busy === `f${i.id}` ? 'Sending…' : 'Email it'}</button>}
                {i.status !== 'replied' && <button className="small" disabled={busy !== null} onClick={() => run(`r${i.id}`, () => api.updateInquiry(i.id, { status: 'replied' }))}>Replied</button>}
                {i.status !== 'qualified' && <button className="small" disabled={busy !== null} onClick={() => run(`q${i.id}`, () => api.updateInquiry(i.id, { status: 'qualified' }))}>Qualified</button>}
                {i.status !== 'closed' && <button className="small" disabled={busy !== null} onClick={() => run(`c${i.id}`, () => api.updateInquiry(i.id, { status: 'closed' }))}>Close</button>}
                <button className="small" disabled={busy !== null} onClick={() => { const note = window.prompt('Note', i.note ?? ''); if (note !== null) void run(`n${i.id}`, () => api.updateInquiry(i.id, { note })); }}>Note</button>
                <button className="small" onClick={() => setOpenId(openId === i.id ? null : i.id)}>{openId === i.id ? 'Hide history' : 'History'}</button>
              </div>}</td>
            </tr>,
            ...(openId === i.id ? [<tr key={`${i.id}-h`} className="detail"><td colSpan={6} style={{ background: 'var(--panel-2, #fafafa)', padding: '12px 16px' }}><History id={i.id} reloadKey={histKey} /></td></tr>] : []),
          ])}
        </tbody></table></div>
      )}
    </>
  );
}
