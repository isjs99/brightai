import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { CopilotData, CopilotQuestion } from '../../../sweep/types';
import { api, fmtRelative, useLiveUpdates } from '../api';
import { useIsAdmin } from '../session';

const KIND: Record<string, string> = { call: 'Call', email: 'Email', slack: 'Slack', sop: 'SOP', report: 'Report', incident: 'Incident', data: 'Account data', inbox: 'Inbox' };

/** Account management > Client copilot: every client question answered from the calls, emails, Slack, SOPs and account data, with the sources shown. */
export default function CopilotPage() {
  const [data, setData] = useState<CopilotData | null>(null);
  const [params] = useSearchParams();
  const [selected, setSelected] = useState<number | null>(params.get('q') ? Number(params.get('q')) : null);
  const [answer, setAnswer] = useState('');
  const [ask, setAsk] = useState({ account_id: '', question: '', asked_by: '' });
  const [only, setOnly] = useState<'open' | 'all'>('open');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const isAdmin = useIsAdmin();
  const load = useCallback(() => api.copilot().then(setData).catch((e) => setError((e as Error).message)), []);
  useEffect(() => { load(); }, [load]);
  const connected = useLiveUpdates((e) => { if (e.kind === 'copilot') load(); });
  const qn = data?.questions.find((x) => x.id === selected) ?? null;
  useEffect(() => { setAnswer(qn?.answer ?? ''); }, [qn?.id, qn?.answered_at]); // eslint-disable-line react-hooks/exhaustive-deps
  const run = async <T extends CopilotData,>(key: string, fn: () => Promise<T>, after?: (r: T) => void) => {
    setBusy(key);
    setError(null);
    try { const r = await fn(); setData(r); after?.(r); } catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  };
  if (!data) return <p>{error ?? 'Loading…'}</p>;
  const list = data.questions.filter((x) => only === 'all' || (x.status !== 'answered' && x.status !== 'dismissed'));
  const status = (x: CopilotQuestion) => <span className={`badge ${x.status === 'answered' ? 'good' : x.status === 'drafted' ? 'accent' : x.status === 'dismissed' ? 'muted' : 'warn'}`}>{x.status}</span>;
  const dirty = qn && answer !== (qn.answer ?? '');
  const evidenceTotal = Object.values(data.evidence_counts).reduce((n, v) => n + v, 0);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Client copilot</h1>
          <p className="hint" style={{ margin: 0 }}>When a client asks something in Slack or email, or you type it in here, the copilot searches the tl;dv calls, emails, the client channel, SOPs, reports, incidents and the account numbers, and drafts the answer with the evidence behind it. No more "I swear we discussed this three weeks ago".</p>
        </div>
        <div className="actions">
          {connected && <span className="badge muted">Live</span>}
          <span className={`badge ${evidenceTotal ? 'good' : 'muted'}`} title={Object.entries(data.evidence_counts).map(([k, v]) => `${KIND[k] ?? k}: ${v}`).join(' · ')}>{evidenceTotal} evidence items{data.last_index_at ? ` · indexed ${fmtRelative(data.last_index_at)}` : ''}</span>
          <span className={`badge ${data.llm_configured ? 'good' : 'muted'}`}>{data.llm_configured ? 'Claude answering' : 'Template answers (no ANTHROPIC_API_KEY)'}</span>
          {isAdmin && <button disabled={busy === 'idx'} onClick={() => run('idx', api.copilotIndex, (r) => setNotice(`Indexed ${r.added} item(s)${r.errors.length ? `, ${r.errors.length} source error(s): ${r.errors.slice(0, 2).join(' · ')}` : ''}.`))} title="Re-read calls, emails, Slack, SOPs and account data">{busy === 'idx' ? 'Indexing…' : 'Re-index sources'}</button>}
          {isAdmin && <button disabled={busy === 'poll'} onClick={() => run('poll', api.copilotPoll, (r) => setNotice(`${r.found} new client question(s) picked up${r.errors.length ? `; ${r.errors.slice(0, 2).join(' · ')}` : ''}.`))} title="Check the client Slack channels and inbox for new questions now">{busy === 'poll' ? 'Checking…' : 'Check channels now'}</button>}
        </div>
      </div>
      {error && <div className="banner crit">{error}</div>}
      {notice && <div className="banner info">{notice}</div>}
      {data.last_index_error && <div className="banner crit">Some sources failed on the last index: {data.last_index_error}</div>}

      <div className="card" style={{ marginBottom: 14 }}>
        <div className="inline-form" style={{ alignItems: 'flex-end' }}>
          <label className="field" style={{ minWidth: 200 }}><span className="lbl">Account</span><select value={ask.account_id} onChange={(e) => setAsk({ ...ask, account_id: e.target.value })}><option value="">Any / not sure</option>{data.accounts.map((a) => <option key={a.id} value={a.id}>{a.name} ({a.evidence} items)</option>)}</select></label>
          <label className="field" style={{ flex: 2, minWidth: 320 }}><span className="lbl">The client's question</span><input type="text" value={ask.question} onChange={(e) => setAsk({ ...ask, question: e.target.value })} placeholder="e.g. When did we say the new creatives would go live?" onKeyDown={(e) => { if (e.key === 'Enter' && ask.question.trim()) run('ask', () => api.copilotAsk({ account_id: ask.account_id ? Number(ask.account_id) : null, question: ask.question, asked_by: ask.asked_by || undefined }), (r) => { setSelected(r.question.id); setAsk({ ...ask, question: '' }); }); }} /></label>
          <label className="field" style={{ minWidth: 150 }}><span className="lbl">Asked by (optional)</span><input type="text" value={ask.asked_by} onChange={(e) => setAsk({ ...ask, asked_by: e.target.value })} placeholder="name or email" /></label>
          <button className="primary" disabled={!ask.question.trim() || busy === 'ask'} onClick={() => run('ask', () => api.copilotAsk({ account_id: ask.account_id ? Number(ask.account_id) : null, question: ask.question, asked_by: ask.asked_by || undefined }), (r) => { setSelected(r.question.id); setAsk({ ...ask, question: '' }); })}>{busy === 'ask' ? 'Searching…' : 'Draft answer'}</button>
        </div>
        {isAdmin && (
          <div className="inline-form" style={{ marginTop: 6 }}>
            <label className="field check" title="Poll each account's client Slack channel every 5 minutes for questions"><input type="checkbox" checked={data.settings.watch_slack} disabled={!data.slack_configured} onChange={(e) => run('s', () => api.copilotSettings({ watch_slack: e.target.checked }))} /> Watch client Slack channels{data.slack_configured ? '' : ' (no bot token)'}</label>
            <label className="field check" title="Poll Gmail for emails from client domains"><input type="checkbox" checked={data.settings.watch_email} disabled={!data.gmail_connected} onChange={(e) => run('s', () => api.copilotSettings({ watch_email: e.target.checked }))} /> Watch client emails{data.gmail_connected ? '' : ' (connect Gmail)'}</label>
            <label className="field check" title="DM the account manager the draft when a question is picked up"><input type="checkbox" checked={data.settings.notify_am} onChange={(e) => run('s', () => api.copilotSettings({ notify_am: e.target.checked }))} /> DM the AM with the draft</label>
            <span className="sub">Accounts need a client Slack channel and client domain (Accounts page): {data.accounts.filter((a) => a.client_slack_channel).length} channel(s), {data.accounts.filter((a) => a.client_domain).length} domain(s) set.</span>
          </div>
        )}
      </div>

      <div className="inbox-split">
        <div className="inbox-list">
          <div className="toolbar"><select value={only} onChange={(e) => setOnly(e.target.value as 'open' | 'all')}><option value="open">Open</option><option value="all">All</option></select><span className="sub">{list.length}</span></div>
          {list.length === 0 ? <div className="empty">No questions yet.</div> : list.map((x) => (
            <button key={x.id} className={`conv ${selected === x.id ? 'active' : ''}`} onClick={() => setSelected(x.id)}>
              <div className="page-head" style={{ marginBottom: 2 }}><b>{x.account_name ?? 'Unassigned'}</b> {status(x)}</div>
              <div style={{ fontSize: 13.5 }}>{x.question.slice(0, 140)}</div>
              <div className="sub">{x.source}{x.asked_by ? ` · ${x.asked_by}` : ''} · {fmtRelative(x.created_at)}</div>
            </button>
          ))}
        </div>
        <div className="detail card">
          {!qn ? <p className="sub">Pick a question or ask one above.</p> : (
            <>
              <div className="page-head" style={{ marginBottom: 8 }}>
                <div><b>{qn.account_name ?? 'Unassigned'}</b> <span className="badge muted">{qn.source}</span> {status(qn)}{qn.generator && <span className="sub"> · {qn.generator === 'claude' ? 'Claude' : 'template'}</span>}</div>
                <div className="actions">
                  {isAdmin && <button className="small" disabled={busy === 'ans'} onClick={() => run('ans', () => api.copilotAnswer(qn.id), () => setNotice('Redrafted.'))}>{busy === 'ans' ? 'Drafting…' : 'Redraft'}</button>}
                  {isAdmin && qn.status !== 'dismissed' && <button className="small" onClick={() => run('dis', () => api.copilotUpdate(qn.id, { status: 'dismissed' }))}>Dismiss</button>}
                  {isAdmin && <button className="small danger" onClick={() => window.confirm('Delete this question?') && run('del', () => api.copilotDelete(qn.id), () => setSelected(null))}>Delete</button>}
                </div>
              </div>
              <blockquote style={{ margin: '0 0 10px', paddingLeft: 12, borderLeft: '3px solid var(--border-strong)' }}>{qn.question}{qn.asked_by ? <div className="sub">{qn.asked_by}{qn.channel ? ` in ${qn.channel}` : ''}</div> : null}</blockquote>
              {isAdmin && <div className="inline-form" style={{ marginBottom: 8 }}><label className="field" style={{ minWidth: 200 }}><span className="lbl">Account</span><select value={qn.account_id ?? ''} onChange={(e) => run('acct', () => api.copilotUpdate(qn.id, { account_id: e.target.value ? Number(e.target.value) : null }))}><option value="">Unassigned</option>{data.accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select><span className="help">Change and click Redraft to search that account's evidence.</span></label></div>}
              <label className="field"><span className="lbl">Draft answer (the [n] marks point at the sources below; they are stripped when sent)</span><textarea rows={8} style={{ width: '100%', fontFamily: 'inherit' }} value={answer} disabled={!isAdmin} onChange={(e) => setAnswer(e.target.value)} /></label>
              {isAdmin && (
                <div className="actions" style={{ marginTop: 8 }}>
                  <button disabled={!dirty || busy === 'save'} onClick={() => run('save', () => api.copilotUpdate(qn.id, { answer }))}>{dirty ? 'Save' : 'Saved'}</button>
                  <button className="small" onClick={() => navigator.clipboard.writeText(answer.replace(/\s?\[\d+\](\[\d+\])*/g, '')).then(() => setNotice('Answer copied without the source marks.'))}>Copy clean</button>
                  <button className="primary" disabled={busy === 'send' || !answer.trim()} title={qn.source === 'slack' ? 'Reply in the Slack thread' : qn.source === 'email' ? 'Create a Gmail draft reply' : 'Mark as answered'} onClick={() => run('send', () => api.copilotSend(qn.id, answer), (r) => { setNotice(r.mode === 'slack' ? 'Posted in the Slack thread.' : r.mode === 'gmail_draft' ? `Gmail draft created${r.url ? `: ${r.url}` : ''}.` : 'Marked as answered.'); if (r.mode === 'gmail_draft' && r.url) window.open(r.url, '_blank', 'noopener'); })}>{busy === 'send' ? 'Sending…' : qn.source === 'slack' ? 'Reply in Slack thread' : qn.source === 'email' ? 'Create Gmail draft' : 'Mark answered'}</button>
                </div>
              )}
              <h4 style={{ marginBottom: 6 }}>Evidence ({qn.sources.length})</h4>
              {qn.sources.length === 0 ? <p className="sub">Nothing matched. Set the client domain and channel on the account, re-index, then redraft.</p> : (
                <ol style={{ paddingLeft: 20 }}>
                  {qn.sources.map((s, i) => (
                    <li key={i} style={{ marginBottom: 8 }}>
                      <div><span className="badge muted">{KIND[s.kind] ?? s.kind}</span> <b>{s.url ? <a href={s.url} target="_blank" rel="noreferrer">{s.title}</a> : s.title}</b>{s.occurred_at ? <span className="sub"> · {s.occurred_at.slice(0, 10)}</span> : null}<span className="sub"> · match {Math.round(s.score * 100)}%</span></div>
                      <div className="sub" style={{ whiteSpace: 'pre-wrap' }}>{s.snippet}</div>
                    </li>
                  ))}
                </ol>
              )}
            </>
          )}
        </div>
      </div>
    </>
  );
}
