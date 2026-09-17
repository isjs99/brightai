import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { BdAlert, BdEmailDraft, BdFollowup, OutreachData, OutreachExample, TtsContact } from '../../../sweep/types';
import { api, fmtRelative, useLiveUpdates } from '../api';
import { useIsAdmin } from '../session';

type Tab = 'drafts' | 'followups' | 'calls' | 'activity' | 'alerts' | 'settings';
const TABS: { key: Tab; label: string }[] = [
  { key: 'drafts', label: 'Email drafts' },
  { key: 'followups', label: 'Follow-ups' },
  { key: 'calls', label: 'Call follow-ups' },
  { key: 'activity', label: 'Team activity' },
  { key: 'alerts', label: 'Alerts' },
  { key: 'settings', label: 'Voice, Gmail & contacts' },
];
const DRAFT_LANGS: Record<string, string> = { en: 'English', de: 'German', fr: 'French', it: 'Italian', es: 'Spanish' };
const MARKETS = ['DE', 'UK', 'FR', 'IT', 'ES', 'IE', 'NL', 'BE', 'PL', 'AT', 'SE'];

/** Same rendering rules as the server's bodyToHtml: paragraphs, "- " bullets, short "Heading:" lines in bold, links clickable. */
function renderBody(body: string) {
  const isHeading = (line: string) => /^[^.!?]{2,48}:$/.test(line.trim());
  const linkify = (t: string) => t.split(/(https?:\/\/[^\s]+)/g).map((part, i) => (/^https?:\/\//.test(part) ? <a key={i} href={part} target="_blank" rel="noreferrer">{part}</a> : part));
  return body.replace(/\r\n/g, '\n').trim().split(/\n{2,}/).map((block, bi) => {
    const lines = block.split('\n');
    if (lines.every((l) => /^\s*[-•]\s+/.test(l))) return <ul key={bi} style={{ margin: '0 0 12px 20px', padding: 0 }}>{lines.map((l, i) => <li key={i}>{linkify(l.replace(/^\s*[-•]\s+/, ''))}</li>)}</ul>;
    return <p key={bi} style={{ margin: '0 0 12px' }}>{lines.map((l, i) => <span key={i}>{isHeading(l) ? <b>{l.trim()}</b> : linkify(l)}{i < lines.length - 1 && <br />}</span>)}</p>;
  });
}

/** Growth > Outreach emails: the BD outreach system. Drafts in Isaac's voice, LinkedIn follow-ups, call follow-ups, team tracker, enterprise alerts. */
export default function OutreachPage() {
  const [params, setParams] = useSearchParams();
  const [error, setError] = useState<string | null>(params.get('error'));
  const [notice, setNotice] = useState<string | null>(params.get('notice'));
  const [tab, setTab] = useState<Tab>((TABS.find((t) => t.key === params.get('tab'))?.key ?? (params.get('draft') ? 'drafts' : 'drafts')));
  const [data, setData] = useState<OutreachData | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const isAdmin = useIsAdmin();
  useEffect(() => { if (params.has('error') || params.has('notice')) { const n = new URLSearchParams(params); n.delete('error'); n.delete('notice'); setParams(n, { replace: true }); } }, [params, setParams]);

  const load = useCallback(() => api.outreach().then(setData).catch((e) => setError((e as Error).message)), []);
  useEffect(() => { load(); }, [load]);
  useLiveUpdates((e) => { if (e.kind === 'bd' || e.kind === 'settings') load(); });

  const run = async <T extends OutreachData,>(key: string, fn: () => Promise<T>, after?: (r: T) => void) => {
    setBusy(key);
    setError(null);
    try {
      const r = await fn();
      setData(r);
      after?.(r);
    } catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  };

  if (!data) return <p>{error ?? 'Loading…'}</p>;
  const dueCount = data.followups.filter((f) => Date.parse(f.due_at) <= Date.now()).length;
  const callDrafts = data.drafts.filter((d) => d.kind === 'followup');
  const ctx = { data, isAdmin, busy, run, onNotice: setNotice, onError: setError };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Outreach emails</h1>
          <p className="hint" style={{ margin: 0 }}>The BD outreach system: cold emails and LinkedIn messages in Isaac's voice, sent from his own accounts, with the follow-ups, call recaps, team tracker and enterprise alerts around them. Start from the <Link to="/bd">BD pipeline</Link>.</p>
        </div>
      </div>
      {error && <div className="banner crit">{error}</div>}
      {notice && <div className="banner info">{notice}</div>}
      <div className="tabs">
        {TABS.map((t) => (
          <button key={t.key} className={`tab ${tab === t.key ? 'active' : ''}`} onClick={() => setTab(t.key)}>
            {t.label}
            {t.key === 'drafts' && ` (${data.drafts.filter((d) => d.kind === 'cold' && d.status !== 'sent').length})`}
            {t.key === 'followups' && dueCount > 0 && <span className="badge warn" style={{ marginLeft: 6 }}>{dueCount} due</span>}
            {t.key === 'calls' && callDrafts.length > 0 && ` (${callDrafts.filter((d) => d.status !== 'sent').length})`}
            {t.key === 'alerts' && data.alerts.length > 0 && <span className="badge crit" style={{ marginLeft: 6 }}>{data.alerts.length}</span>}
          </button>
        ))}
      </div>
      {tab === 'drafts' && <Drafts {...ctx} kind="cold" initialDraft={params.get('draft') ? Number(params.get('draft')) : null} />}
      {tab === 'calls' && <Calls {...ctx} />}
      {tab === 'followups' && <Followups {...ctx} />}
      {tab === 'activity' && <Activity {...ctx} />}
      {tab === 'alerts' && <Alerts {...ctx} />}
      {tab === 'settings' && <Settings {...ctx} />}
    </>
  );
}

type Ctx = { data: OutreachData; isAdmin: boolean; busy: string | null; run: <T extends OutreachData>(key: string, fn: () => Promise<T>, after?: (r: T) => void) => Promise<void>; onNotice: (n: string | null) => void; onError: (e: string | null) => void };

function statusBadge(d: BdEmailDraft) {
  return d.status === 'sent' ? <span className="badge good">Sent</span> : d.status === 'gmail' ? <span className="badge accent">In Gmail</span> : <span className="badge warn">Draft</span>;
}

function Drafts({ data, isAdmin, busy, run, onNotice, onError, kind, initialDraft }: Ctx & { kind: 'cold' | 'followup'; initialDraft: number | null }) {
  const [selected, setSelected] = useState<number | null>(initialDraft);
  const [edit, setEdit] = useState<{ subject: string; body: string; to_email: string } | null>(null);
  const [gen, setGen] = useState<{ language: string; style: 'short' | 'intro'; instructions: string }>({ language: 'en', style: 'short', instructions: '' });
  const [only, setOnly] = useState<'open' | 'all'>('open');
  const [preview, setPreview] = useState(true);
  const s = data.settings;
  const list = data.drafts.filter((d) => d.kind === kind && (only === 'all' || d.status !== 'sent'));
  const draft = data.drafts.find((d) => d.id === selected && d.kind === kind) ?? null;
  useEffect(() => {
    if (!draft) { setEdit(null); return; }
    setEdit({ subject: draft.subject, body: draft.body, to_email: draft.to_email });
    setGen((g) => ({ ...g, language: draft.language, style: draft.style }));
  }, [draft?.id, draft?.updated_at]); // eslint-disable-line react-hooks/exhaustive-deps
  const dirty = draft && edit && (edit.subject !== draft.subject || edit.body !== draft.body || edit.to_email !== draft.to_email);
  const saveIfDirty = async (): Promise<void> => { if (draft && edit && dirty) await api.updateDraft(draft.id, { subject: edit.subject, body: edit.body, to_email: edit.to_email }); };
  const openInGmail = () => draft && run('gmail', async () => { await saveIfDirty(); return api.draftToGmail(draft.id); }, (r) => {
    const w = window.open(r.url, '_blank', 'noopener');
    if (!w) onNotice(`Pop-up blocked. Open the draft here: ${r.url}`);
    else onNotice(r.mode === 'gmail' ? `Saved to Gmail drafts (${r.settings.gmail_email}) with real formatting. Send it from there, then click "Mark as sent".` : 'Opened a prefilled Gmail compose window (plain text). Connect Gmail in Settings to save formatted drafts instead. Send it, then click "Mark as sent".');
  });

  return (
    <>
      <div className="toolbar">
        <div className="actions">
          <span className={`badge ${s.gmail_connected ? 'good' : 'muted'}`}>{s.gmail_connected ? `Gmail: ${s.gmail_email}` : s.gmail_configured ? 'Gmail not connected' : 'Gmail: compose-link mode'}</span>
          <span className={`badge ${s.llm_configured ? 'good' : 'muted'}`}>{s.llm_configured ? 'Claude drafting' : 'Template drafting (no ANTHROPIC_API_KEY)'}</span>
          <select value={only} onChange={(e) => setOnly(e.target.value as 'open' | 'all')}><option value="open">Open drafts</option><option value="all">All incl. sent</option></select>
        </div>
        {kind === 'cold' && <span className="sub">Draft from a decision maker in the BD pipeline. Emails use the brand name, not the shop handle, and headings become real bold in Gmail.</span>}
      </div>
      <div className="inbox-split">
        <div className="inbox-list">
          {list.length === 0 ? <div className="empty">{kind === 'cold' ? 'No drafts yet. Open a prospect in the BD pipeline and click "Draft email" next to a decision maker with an email address.' : 'No call follow-ups yet.'}</div> : list.map((d) => (
            <button key={d.id} className={`conv ${selected === d.id ? 'active' : ''}`} onClick={() => setSelected(d.id)}>
              <div className="page-head" style={{ marginBottom: 2 }}><b>{d.kind === 'followup' ? d.meeting_title ?? d.shop_name : d.shop_name}</b> {statusBadge(d)}</div>
              <div className="sub">{d.to_name} · {d.to_email}</div>
              <div style={{ fontSize: 13.5 }}>{d.subject}</div>
              <div className="sub">{fmtRelative(d.updated_at)} · {d.generator === 'claude' ? 'Claude' : 'template'} · {d.kind === 'followup' ? 'call follow-up' : `${d.style} · ${DRAFT_LANGS[d.language] ?? d.language}`}{d.created_by ? ` · ${d.created_by}` : ''}</div>
            </button>
          ))}
        </div>
        <div className="detail card">
          {!draft || !edit ? <p className="sub">Pick a draft on the left.</p> : (
            <>
              <div className="page-head" style={{ marginBottom: 8 }}>
                <div><b>{draft.kind === 'followup' ? draft.meeting_title ?? draft.shop_name : draft.shop_name}</b> <span className="badge muted">{draft.market}</span> {statusBadge(draft)}</div>
                <div className="actions">
                  <button className="small" onClick={() => setPreview(!preview)}>{preview ? 'Edit text' : 'Preview'}</button>
                  {draft.gmail_url && <a className="button" href={draft.gmail_url} target="_blank" rel="noreferrer">Open Gmail draft ↗</a>}
                  {isAdmin && <button className="small danger" onClick={() => window.confirm('Discard this draft?') && run('del', () => api.deleteDraft(draft.id), () => setSelected(null))}>Discard</button>}
                </div>
              </div>
              <div className="inline-form" style={{ marginBottom: 8 }}>
                <label className="field" style={{ minWidth: 200 }}><span className="lbl">To</span><input type="email" value={edit.to_email} disabled={!isAdmin} onChange={(e) => setEdit({ ...edit, to_email: e.target.value })} /></label>
                <label className="field" style={{ flex: 1, minWidth: 260 }}><span className="lbl">Subject</span><input type="text" value={edit.subject} disabled={!isAdmin} onChange={(e) => setEdit({ ...edit, subject: e.target.value })} /></label>
              </div>
              {preview
                ? <div className="card" style={{ background: 'var(--surface-2)', minHeight: 200, cursor: isAdmin ? 'text' : 'default' }} onClick={() => isAdmin && setPreview(false)} title={isAdmin ? 'Click to edit' : ''}>{renderBody(edit.body)}</div>
                : <textarea rows={16} style={{ width: '100%', fontFamily: 'inherit' }} value={edit.body} disabled={!isAdmin} onChange={(e) => setEdit({ ...edit, body: e.target.value })} />}
              {isAdmin && (
                <>
                  <div className="actions" style={{ marginTop: 8 }}>
                    <button className="primary" disabled={busy !== null || draft.status === 'sent'} onClick={openInGmail}>{busy === 'gmail' ? 'Opening…' : s.gmail_connected ? 'Save to Gmail & open' : 'Open in Gmail'}</button>
                    <button disabled={!dirty || busy !== null} onClick={() => run('save', async () => { await saveIfDirty(); return api.outreach(); }, () => onNotice('Draft saved.'))}>Save edits</button>
                    {draft.status !== 'sent' && <button disabled={busy !== null} onClick={() => window.confirm(`Mark as sent to ${draft.to_email}? This ticks Gmail on the prospect and logs it in the history.`) && run('sent', () => api.markDraftSent(draft.id), () => onNotice('Logged as sent. Gmail is ticked on the prospect.'))}>Mark as sent</button>}
                  </div>
                  {draft.kind === 'cold' && (
                    <div className="inline-form" style={{ marginTop: 12 }}>
                      <label className="field"><span className="lbl">Language</span><select value={gen.language} onChange={(e) => setGen({ ...gen, language: e.target.value })}>{Object.entries(DRAFT_LANGS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
                      <label className="field"><span className="lbl">Shape</span><select value={gen.style} onChange={(e) => setGen({ ...gen, style: e.target.value as 'short' | 'intro' })}><option value="short">Short note</option><option value="intro">Introduction</option></select></label>
                      <label className="field" style={{ flex: 1, minWidth: 260 }}><span className="lbl">Steer it</span><input type="text" value={gen.instructions} placeholder="e.g. mention our live studio, keep it to 4 lines, reference their padel range" onChange={(e) => setGen({ ...gen, instructions: e.target.value })} /></label>
                      <button disabled={busy !== null} onClick={() => run('regen', () => api.regenerateDraft(draft.id, gen), () => onNotice('Redrafted.'))}>{busy === 'regen' ? 'Drafting…' : 'Redraft'}</button>
                    </div>
                  )}
                </>
              )}
              <p className="sub" style={{ marginTop: 10 }}>Written by {draft.generator === 'claude' ? 'Claude in Isaac\'s voice' : 'the template (set ANTHROPIC_API_KEY for tailored drafts)'} · {fmtRelative(draft.created_at)} by {draft.created_by ?? 'admin'}.</p>
            </>
          )}
        </div>
      </div>
    </>
  );
}

function Calls(ctx: Ctx) {
  const { data, isAdmin, busy, run, onNotice } = ctx;
  const t = data.tldv;
  return (
    <>
      <p className="hint">After every tl;dv call, a follow-up email is drafted from the notes and transcript in Isaac's voice, addressed to the external attendee, and saved to Gmail drafts when Gmail is connected. Checked every 30 minutes.</p>
      <div className="toolbar">
        <div className="actions">
          <span className={`badge ${t.configured ? 'good' : 'muted'}`}>{t.configured ? 'tl;dv connected' : 'TLDV_API_KEY not set'}</span>
          {t.last_check_at && <span className="badge muted">Checked {fmtRelative(t.last_check_at)}</span>}
          {t.last_error && <span className="badge crit" title={t.last_error}>Last run had errors</span>}
          {isAdmin && <label className="field check"><input type="checkbox" checked={t.auto_draft} onChange={(e) => run('tldv', () => api.saveOutreachSettings({ tldv_auto_draft: e.target.checked }))} /> Auto-draft after every call</label>}
        </div>
        {isAdmin && <button className="primary" disabled={!t.configured || busy === 'calls'} onClick={() => run('calls', api.checkCalls, (r) => onNotice(`Checked ${r.checked} call(s), ${r.drafted} follow-up(s) drafted.${r.errors.length ? ` ${r.errors.join(' · ')}` : ''}`))}>{busy === 'calls' ? 'Checking tl;dv…' : 'Check calls now'}</button>}
      </div>
      {t.last_error && <div className="banner crit">{t.last_error}</div>}
      <Drafts {...ctx} kind="followup" initialDraft={null} />
    </>
  );
}

function Followups({ data, isAdmin, busy, run, onNotice }: Ctx) {
  const [showDone, setShowDone] = useState(false);
  const [copied, setCopied] = useState<number | null>(null);
  const now = Date.now();
  const list = data.followups.filter((f) => showDone || !f.done_at);
  const kindLabel: Record<BdFollowup['kind'], string> = { linkedin_check: 'LinkedIn: check acceptance', linkedin_message: 'LinkedIn: send message', email_chase: 'Chase', custom: 'Reminder' };
  const copy = async (f: BdFollowup) => { try { await navigator.clipboard.writeText(f.note ?? ''); setCopied(f.id); setTimeout(() => setCopied(null), 1500); } catch { onNotice('Copy failed; select the text by hand.'); } };
  return (
    <>
      <p className="hint">The LinkedIn sequence runs from the BD pipeline: "Connect on LinkedIn" logs the request and sets a reminder to check back; "They accepted" writes the short message; "Message sent" schedules a chase. Due items are DMed on Slack at 09:00 on workdays to whoever logged them.</p>
      <div className="toolbar">
        <div className="actions">
          <span className="badge warn">{data.followups.filter((f) => !f.done_at && Date.parse(f.due_at) <= now).length} due</span>
          <span className="badge muted">{data.followups.filter((f) => !f.done_at && Date.parse(f.due_at) > now).length} upcoming</span>
          <label className="field check"><input type="checkbox" checked={showDone} onChange={(e) => setShowDone(e.target.checked)} /> Show done</label>
        </div>
        {isAdmin && <button onClick={() => run('remind', api.remindFollowups, (r) => onNotice(`Slack reminders sent to ${r.sent} person(s).`))} disabled={busy === 'remind'}>Send Slack reminders now</button>}
      </div>
      {list.length === 0 ? <div className="empty">Nothing due. Start a LinkedIn connection from a decision maker in the BD pipeline.</div> : (
        <div className="grid-wrap"><table><thead><tr><th>Due</th><th>What</th><th>Prospect</th><th>Message</th><th>By</th><th></th></tr></thead><tbody>
          {list.map((f) => (
            <tr key={f.id} className={f.done_at ? 'dim' : ''}>
              <td>{f.done_at ? <span className="badge good">Done</span> : Date.parse(f.due_at) <= now ? <span className="badge crit">{fmtRelative(f.due_at)}</span> : <span className="sub">{fmtRelative(f.due_at)}</span>}</td>
              <td><span className="badge muted">{kindLabel[f.kind]}</span><div>{f.title}</div></td>
              <td><b>{f.shop_name}</b>{f.contact_name && <div className="sub">{f.contact_name}</div>}</td>
              <td style={{ maxWidth: 360 }}>{f.kind === 'linkedin_message' && f.note ? <div className="sub" style={{ whiteSpace: 'pre-wrap' }}>{f.note}</div> : <span className="sub">{f.note ?? ''}</span>}</td>
              <td className="sub">{f.created_by ?? '–'}</td>
              <td>
                {isAdmin && !f.done_at && (
                  <div className="actions">
                    {f.linkedin_url && <a className="button small" href={f.linkedin_url} target="_blank" rel="noreferrer">Open LinkedIn ↗</a>}
                    {f.kind === 'linkedin_message' && f.note && <button className="small" onClick={() => copy(f)}>{copied === f.id ? 'Copied' : 'Copy message'}</button>}
                    {f.kind === 'linkedin_check' && f.contact_id && <button className="small primary" onClick={() => run(`f${f.id}`, () => api.linkedinStep(f.contact_id!, 'connected'), () => onNotice('Marked as connected. The follow-up message is ready under Follow-ups.'))}>They accepted</button>}
                    {f.kind === 'linkedin_message' && f.contact_id && <button className="small primary" onClick={() => run(`f${f.id}`, () => api.linkedinStep(f.contact_id!, 'messaged', f.note ?? undefined), () => onNotice('Logged the LinkedIn message.'))}>Message sent</button>}
                    <button className="small" onClick={() => run(`f${f.id}`, () => api.completeFollowup(f.id))}>Done</button>
                    <button className="small" onClick={() => run(`f${f.id}`, () => api.snoozeFollowup(f.id, 2))}>+2d</button>
                  </div>
                )}
              </td>
            </tr>
          ))}
        </tbody></table></div>
      )}
    </>
  );
}

function Activity({ data }: Ctx) {
  const [days, setDays] = useState(30);
  const [act, setAct] = useState(data.activity);
  useEffect(() => { api.bdActivity(days).then(setAct).catch(() => undefined); }, [days, data.activity]);
  return (
    <>
      <p className="hint">Who has done what on BD: channel ticks, notes, drafts, emails sent, LinkedIn requests and connections, replies and meetings, from the outreach history. Pick your name top right so actions are logged under you.</p>
      <div className="toolbar"><select value={days} onChange={(e) => setDays(Number(e.target.value))}><option value={7}>Last 7 days</option><option value={30}>Last 30 days</option><option value={90}>Last 90 days</option><option value={365}>Last year</option></select></div>
      <div className="stats" style={{ marginBottom: 14 }}>
        <div className="stat"><span className="v">{act.totals.contacted}</span><span className="k">outreach actions</span></div>
        <div className="stat"><span className="v">{act.totals.emails_sent}</span><span className="k">emails sent</span></div>
        <div className="stat"><span className="v">{act.totals.linkedin_requests}</span><span className="k">LinkedIn requests</span></div>
        <div className="stat"><span className="v">{act.totals.replies}</span><span className="k">replies</span></div>
        <div className="stat"><span className="v">{act.totals.meetings}</span><span className="k">meetings</span></div>
      </div>
      <div className="grid-wrap"><table><thead><tr><th>Person</th><th>Prospects touched</th><th>Outreach</th><th>TTS AM</th><th>Email sent</th><th>LinkedIn req.</th><th>Connected</th><th>Drafts</th><th>Notes</th><th>Replies</th><th>Meetings</th><th>Last active</th></tr></thead><tbody>
        {act.rows.length === 0 ? <tr><td colSpan={12} className="sub">No BD activity in this window.</td></tr> : act.rows.map((r) => (
          <tr key={r.actor}><td><b>{r.actor}</b></td><td>{r.prospects_touched}</td><td>{r.contacted}</td><td>{r.tts_am}</td><td>{r.emails_sent}</td><td>{r.linkedin_requests}</td><td>{r.linkedin_connected}</td><td>{r.drafts}</td><td>{r.notes}</td><td>{r.replies}</td><td>{r.meetings}</td><td className="sub">{r.last_active_at ? fmtRelative(r.last_active_at) : '–'}</td></tr>
        ))}
      </tbody></table></div>
      {act.weekly.length > 0 && (
        <>
          <h3>By week</h3>
          <div className="grid-wrap"><table><thead><tr><th>Week of</th><th>Outreach</th><th>Emails sent</th><th>LinkedIn requests</th><th>Replies</th></tr></thead><tbody>
            {act.weekly.map((w) => <tr key={w.week}><td>{w.week}</td><td>{w.contacted}</td><td>{w.emails_sent}</td><td>{w.linkedin_requests}</td><td>{w.replies}</td></tr>)}
          </tbody></table></div>
        </>
      )}
    </>
  );
}

function Alerts({ data, isAdmin, busy, run, onNotice }: Ctx) {
  const [names, setNames] = useState('');
  const [showList, setShowList] = useState(false);
  const money = (n: number | null, c: string) => (n === null ? '–' : `${c === 'GBP' ? '£' : '€'}${Math.round(n).toLocaleString('en-GB')}`);
  return (
    <>
      <p className="hint">Household names launching on TikTok Shop. Every FastMoss pull is checked against the watchlist ({data.watchlist.filter((w) => w.enabled).length} names: the lead sheet's enterprise tabs plus the brands Isaac has pitched); a hit on a shop created in the last 90 days, or whose sales only just started, raises an alert here.</p>
      <div className="toolbar">
        <div className="actions">
          {isAdmin && <button onClick={() => run('scan', api.scanAlerts, (r) => onNotice(`Scanned ${r.checked} prospects, ${r.new_alerts} new alert(s).`))} disabled={busy === 'scan'}>Scan now</button>}
          {isAdmin && data.settings.watchlist_sheet_tab && <button onClick={() => run('sync', api.syncWatchlist, (r) => onNotice(`Read ${r.total} names from the "${data.settings.watchlist_sheet_tab}" tab, ${r.added} new, ${r.new_alerts} new alert(s).`))} disabled={busy === 'sync'}>Sync names from the lead sheet tab</button>}
          <button onClick={() => setShowList(!showList)}>{showList ? 'Hide watchlist' : 'Edit watchlist'}</button>
        </div>
      </div>
      {data.alerts.length === 0 ? <div className="empty">No enterprise launches spotted yet.</div> : (
        <div className="grid-wrap"><table><thead><tr><th>Spotted</th><th>Name</th><th>Shop</th><th>Market</th><th>Created</th><th>7d GMV</th><th>Why</th><th></th></tr></thead><tbody>
          {data.alerts.map((a: BdAlert) => (
            <tr key={a.id}>
              <td className="sub">{fmtRelative(a.created_at)}</td>
              <td><b>{a.watch_name}</b></td>
              <td><Link to={`/bd?q=${encodeURIComponent(a.shop_name)}`}>{a.shop_name}</Link></td>
              <td>{a.market}</td>
              <td className="sub">{a.launched_at ?? '–'}</td>
              <td>{money(a.gmv_7d, a.currency)}</td>
              <td className="sub" style={{ maxWidth: 360 }}>{a.message}</td>
              <td>{isAdmin && <button className="small" onClick={() => run(`a${a.id}`, () => api.dismissAlert(a.id))}>Dismiss</button>}</td>
            </tr>
          ))}
        </tbody></table></div>
      )}
      {showList && (
        <div className="card" style={{ marginTop: 14 }}>
          <h3 style={{ marginTop: 0 }}>Watchlist</h3>
          {isAdmin && (
            <div className="inline-form" style={{ marginBottom: 10 }}>
              <label className="field" style={{ flex: 1, minWidth: 320 }}><span className="lbl">Add names (comma or line separated)</span><input type="text" value={names} onChange={(e) => setNames(e.target.value)} placeholder="e.g. Dr. Oetker, Haribo, Lindt" /></label>
              <button className="primary" disabled={!names.trim() || busy === 'wl'} onClick={() => run('wl', () => api.addWatchlist(names), (r) => { setNames(''); onNotice(`${r.added} name(s) added, ${r.new_alerts} new alert(s).`); })}>Add</button>
            </div>
          )}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {data.watchlist.map((w) => (
              <span key={w.id} className={`badge ${w.enabled ? 'muted' : 'dim'}`} title={`${w.source}`} style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                {w.name}
                {isAdmin && <button className="small" style={{ padding: '0 4px' }} onClick={() => run(`w${w.id}`, () => api.setWatchlist(w.id, !w.enabled))} title={w.enabled ? 'Pause' : 'Enable'}>{w.enabled ? '⏸' : '▶'}</button>}
                {isAdmin && <button className="small danger" style={{ padding: '0 4px' }} onClick={() => run(`w${w.id}`, () => api.deleteWatchlist(w.id))}>×</button>}
              </span>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

function Settings({ data, isAdmin, busy, run, onNotice }: Ctx) {
  const s = data.settings;
  const [settings, setSettings] = useState({ sender_name: s.sender_name, sender_title: s.sender_title, booking_url: s.booking_url, pitch: s.pitch, sent_query: s.sent_query, watchlist_sheet_tab: s.watchlist_sheet_tab, linkedin_check_days: s.linkedin_check_days });
  const [newExample, setNewExample] = useState<{ subject: string; body: string; kind: string } | null>(null);
  const [tc, setTc] = useState<Partial<TtsContact> & { market: string; name: string }>({ market: 'DE', name: '', category: '', role: '', lark: '', email: '', is_agency_manager: false });
  return (
    <>
      <div className="card" style={{ marginBottom: 14 }}>
        <h3 style={{ marginTop: 0 }}>Gmail</h3>
        {s.gmail_connected ? (
          <p className="sub">Connected as <b>{s.gmail_email}</b>. Drafts are created in that account's Drafts folder with real formatting and sent from there. {isAdmin && <button className="small" onClick={() => run('gd', api.gmailDisconnect)}>Disconnect</button>}</p>
        ) : s.gmail_configured ? (
          <p className="sub">Not connected. {isAdmin && <a className="button primary" href="/api/gmail/connect">Connect Gmail</a>} Until then "Open in Gmail" opens a prefilled compose window (plain text, no bold).</p>
        ) : (
          <p className="sub">Add <code>GOOGLE_CLIENT_ID</code> and <code>GOOGLE_CLIENT_SECRET</code> to .env (a Google Cloud OAuth client with redirect URI <code>{window.location.origin}/api/gmail/callback</code>) to save formatted drafts straight into Gmail. Without it, "Open in Gmail" opens a prefilled compose window, which still sends from your own account.</p>
        )}
      </div>

      <div className="card" style={{ marginBottom: 14 }}>
        <h3 style={{ marginTop: 0 }}>TikTok Shop contacts <span className="sub">(who to loop in per market)</span></h3>
        <p className="sub">The prospect detail suggests a TikTok Shop POC: the category contact for the market first, otherwise the market's agency manager to ask in Lark. Add the org chart here.</p>
        {data.tts_contacts.length > 0 && (
          <div className="grid-wrap"><table><thead><tr><th>Market</th><th>Category</th><th>Name</th><th>Role</th><th>Lark</th><th>Email</th><th></th></tr></thead><tbody>
            {data.tts_contacts.map((c) => (
              <tr key={c.id}><td>{c.market}</td><td className="sub">{c.is_agency_manager ? <span className="badge accent">Agency manager</span> : c.category ?? 'Any'}</td><td><b>{c.name}</b></td><td className="sub">{c.role ?? ''}</td><td className="sub">{c.lark ?? ''}</td><td className="sub">{c.email ?? ''}</td><td>{isAdmin && <div className="actions"><button className="small" onClick={() => setTc({ ...c, category: c.category ?? '', role: c.role ?? '', lark: c.lark ?? '', email: c.email ?? '' })}>Edit</button><button className="small danger" onClick={() => run(`t${c.id}`, () => api.deleteTtsContact(c.id))}>×</button></div>}</td></tr>
            ))}
          </tbody></table></div>
        )}
        {isAdmin && (
          <div className="inline-form" style={{ marginTop: 8 }}>
            <label className="field" style={{ minWidth: 90 }}><span className="lbl">Market</span><select value={tc.market} onChange={(e) => setTc({ ...tc, market: e.target.value })}>{MARKETS.map((m) => <option key={m}>{m}</option>)}</select></label>
            <label className="field" style={{ minWidth: 160 }}><span className="lbl">Category (blank = any)</span><input type="text" value={tc.category ?? ''} onChange={(e) => setTc({ ...tc, category: e.target.value })} placeholder="e.g. Beauty" /></label>
            <label className="field" style={{ minWidth: 160 }}><span className="lbl">Name</span><input type="text" value={tc.name} onChange={(e) => setTc({ ...tc, name: e.target.value })} /></label>
            <label className="field" style={{ minWidth: 160 }}><span className="lbl">Role</span><input type="text" value={tc.role ?? ''} onChange={(e) => setTc({ ...tc, role: e.target.value })} placeholder="Category manager" /></label>
            <label className="field" style={{ minWidth: 140 }}><span className="lbl">Lark</span><input type="text" value={tc.lark ?? ''} onChange={(e) => setTc({ ...tc, lark: e.target.value })} /></label>
            <label className="field" style={{ minWidth: 180 }}><span className="lbl">Email</span><input type="text" value={tc.email ?? ''} onChange={(e) => setTc({ ...tc, email: e.target.value })} /></label>
            <label className="field check"><input type="checkbox" checked={Boolean(tc.is_agency_manager)} onChange={(e) => setTc({ ...tc, is_agency_manager: e.target.checked })} /> Agency manager (fallback)</label>
            <button className="primary" disabled={!tc.name.trim() || busy === 'tc'} onClick={() => run('tc', () => api.saveTtsContact({ ...tc, category: tc.category || null }), () => { setTc({ market: tc.market, name: '', category: '', role: '', lark: '', email: '', is_agency_manager: false }); onNotice('TikTok Shop contact saved.'); })}>{tc.id ? 'Save changes' : '+ Add contact'}</button>
            {tc.id && <button onClick={() => setTc({ market: 'DE', name: '', category: '', role: '', lark: '', email: '', is_agency_manager: false })}>Cancel</button>}
          </div>
        )}
      </div>

      <div className="card" style={{ marginBottom: 14 }}>
        <h3 style={{ marginTop: 0 }}>Voice samples <span className="sub">({data.examples.filter((e) => e.enabled).length} in use)</span></h3>
        <p className="sub">Real emails {s.sender_name.split(' ')[0]} sent. The writer copies their tone, not their length or dated details. {s.gmail_connected && isAdmin && <button className="small" onClick={() => run('pull', api.pullExamples, (r) => onNotice(`Read ${r.pulled} sent emails, ${r.added} new samples added.`))} disabled={busy === 'pull'}>{busy === 'pull' ? 'Reading Gmail…' : 'Pull recent sent outreach from Gmail'}</button>} {s.last_pull_at && <span>Last pull {fmtRelative(s.last_pull_at)}.</span>} {s.last_pull_error && <span className="crit">{s.last_pull_error}</span>}</p>
        {isAdmin && (
          <div className="inline-form" style={{ marginBottom: 8 }}>
            <label className="field" style={{ flex: 1, minWidth: 320 }}><span className="lbl">Gmail search for sent outreach</span><input type="text" value={settings.sent_query} onChange={(e) => setSettings({ ...settings, sent_query: e.target.value })} onBlur={() => run('set', () => api.saveOutreachSettings({ sent_query: settings.sent_query }))} /></label>
          </div>
        )}
        <div className="grid-wrap"><table><thead><tr><th>Subject</th><th>Kind</th><th>To</th><th>Sent</th><th>Source</th><th></th></tr></thead><tbody>
          {data.examples.map((e: OutreachExample) => (
            <tr key={e.id} className={e.enabled ? '' : 'dim'}>
              <td><details><summary><b>{e.subject}</b></summary><div style={{ whiteSpace: 'pre-wrap', marginTop: 6, maxWidth: 720 }}>{e.body}</div></details></td>
              <td><span className="badge muted">{e.kind}</span></td>
              <td className="sub">{e.to_domain ?? '–'}</td>
              <td className="sub">{e.sent_at ?? '–'}</td>
              <td className="sub">{e.source}</td>
              <td>{isAdmin && <div className="actions"><button className="small" onClick={() => run(`e${e.id}`, () => api.setExample(e.id, !e.enabled))}>{e.enabled ? 'Off' : 'On'}</button><button className="small danger" onClick={() => window.confirm(`Delete "${e.subject}"?`) && run(`e${e.id}`, () => api.deleteExample(e.id))}>×</button></div>}</td>
            </tr>
          ))}
        </tbody></table></div>
        {isAdmin && (newExample ? (
          <div style={{ marginTop: 8 }}>
            <div className="inline-form">
              <label className="field" style={{ flex: 1, minWidth: 240 }}><span className="lbl">Subject</span><input type="text" value={newExample.subject} onChange={(e) => setNewExample({ ...newExample, subject: e.target.value })} /></label>
              <label className="field"><span className="lbl">Kind</span><select value={newExample.kind} onChange={(e) => setNewExample({ ...newExample, kind: e.target.value })}><option value="cold">Cold</option><option value="intro">Intro</option><option value="reply">Reply</option><option value="followup">Follow-up</option></select></label>
            </div>
            <textarea rows={8} style={{ width: '100%', marginTop: 8 }} placeholder="Paste the email as you sent it (no signature needed)" value={newExample.body} onChange={(e) => setNewExample({ ...newExample, body: e.target.value })} />
            <div className="actions" style={{ marginTop: 8 }}><button className="primary" disabled={!newExample.subject.trim() || !newExample.body.trim()} onClick={() => run('ex', () => api.addExample(newExample), () => setNewExample(null))}>Save sample</button><button onClick={() => setNewExample(null)}>Cancel</button></div>
          </div>
        ) : <button className="small" style={{ marginTop: 8 }} onClick={() => setNewExample({ subject: '', body: '', kind: 'cold' })}>+ Paste an email as a sample</button>)}
      </div>

      {isAdmin && (
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Pitch block, sign-off and sequence settings</h3>
          <p className="sub">The pitch block is the only source of claims about Brightform the writer may use; it picks the two or three that fit each shop. Headings are lines ending with a colon (they turn bold in Gmail).</p>
          <div className="inline-form">
            <label className="field" style={{ minWidth: 200 }}><span className="lbl">Sender</span><input type="text" value={settings.sender_name} onChange={(e) => setSettings({ ...settings, sender_name: e.target.value })} /></label>
            <label className="field" style={{ minWidth: 240 }}><span className="lbl">Title</span><input type="text" value={settings.sender_title} onChange={(e) => setSettings({ ...settings, sender_title: e.target.value })} /></label>
            <label className="field" style={{ flex: 1, minWidth: 260 }}><span className="lbl">Booking link</span><input type="text" value={settings.booking_url} onChange={(e) => setSettings({ ...settings, booking_url: e.target.value })} /></label>
            <label className="field" style={{ minWidth: 120 }}><span className="lbl">LinkedIn check after (days)</span><input type="number" min={1} max={14} value={settings.linkedin_check_days} onChange={(e) => setSettings({ ...settings, linkedin_check_days: Number(e.target.value) || 3 })} /></label>
            <label className="field" style={{ minWidth: 220 }}><span className="lbl">Lead sheet tab with enterprise names</span><input type="text" value={settings.watchlist_sheet_tab} onChange={(e) => setSettings({ ...settings, watchlist_sheet_tab: e.target.value })} placeholder="e.g. Enterprise" /></label>
          </div>
          <textarea rows={12} style={{ width: '100%', marginTop: 8, fontFamily: 'inherit' }} value={settings.pitch} onChange={(e) => setSettings({ ...settings, pitch: e.target.value })} />
          <div className="actions" style={{ marginTop: 8 }}><button className="primary" disabled={busy === 'set'} onClick={() => run('set', () => api.saveOutreachSettings(settings), () => onNotice('Outreach settings saved.'))}>Save settings</button></div>
        </div>
      )}
    </>
  );
}
