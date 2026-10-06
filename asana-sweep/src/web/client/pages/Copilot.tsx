import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { CopilotData, CopilotQuestion } from '../../../sweep/types';
import { api, fmtRelative, useActor, useLiveUpdates } from '../api';
import { useIsAdmin } from '../session';
import { useAccountScope, useAllowedAccounts, useInScope } from '../hubs';
import { AccountGroup, GroupsHead, useOpenGroups, type GroupLight } from '../groups';

const KIND: Record<string, string> = { call: 'Call', email: 'Email', slack: 'Slack', sop: 'SOP', report: 'Report', incident: 'Incident', data: 'Account data', inbox: 'Inbox' };

/**
 * Accounts > Ask: the team's own tool. Pick an account, ask anything about it (about any day), and get
 * a brief from the calls, emails, client Slack, SOPs, reports, incidents and the numbers, written in
 * Slack syntax so it can be copied straight into a channel. Client questions caught from Slack and
 * email still land here with a client-facing draft.
 */
export default function CopilotPage() {
  const [data, setData] = useState<CopilotData | null>(null);
  const [params] = useSearchParams();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const isAdmin = useIsAdmin();
  const scope = useAccountScope();
  const inScope = useInScope();
  const allowed = useAllowedAccounts();
  const groups = useOpenGroups('ask');
  const load = useCallback(() => api.copilot().then(setData).catch((e) => setError((e as Error).message)), []);
  useEffect(() => { load(); }, [load]);
  const connected = useLiveUpdates((e) => { if (e.kind === 'copilot') load(); });
  useEffect(() => { const qid = params.get('q'); if (qid && data) { const qn = data.questions.find((x) => x.id === Number(qid)); if (qn?.account_id && !groups.isOpen(qn.account_id)) groups.toggle(qn.account_id); } }, [data?.questions.length, params]); // eslint-disable-line react-hooks/exhaustive-deps
  const run = async <T extends CopilotData,>(key: string, fn: () => Promise<T>, after?: (r: T) => void) => {
    setBusy(key); setError(null);
    try { const r = await fn(); setData(r); after?.(r); } catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  };
  if (!data) return <p>{error ?? 'Loading…'}</p>;
  const accounts = data.accounts.filter((a) => inScope(a.id));
  const fresh = data.last_index_at ? Date.now() - Date.parse(data.last_index_at) < 24 * 3600000 : false;
  const lightOf = (a: CopilotData['accounts'][number]): GroupLight => {
    const open = data.questions.filter((qn) => qn.account_id === a.id && qn.source !== 'manual' && (qn.status === 'open' || qn.status === 'drafted')).length;
    if (open) return 'amber';
    if (!a.evidence) return 'grey';
    return fresh ? 'green' : 'amber';
  };
  const order: GroupLight[] = ['red', 'amber', 'green', 'grey'];
  const sorted = [...accounts].sort((a, b) => order.indexOf(lightOf(a)) - order.indexOf(lightOf(b)) || a.name.localeCompare(b.name));
  const general = data.questions.filter((qn) => qn.account_id === null);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Ask</h1>
          <p className="hint" style={{ margin: 0 }}>Ask anything about any account, about any day: what the client said, what we agreed on the last call, how GMV did last Tuesday, which flags were open. The answer is a Slack-ready brief you can copy into a channel. Client questions caught in their Slack channel or email also land here with a client-facing draft.</p>
        </div>
        <div className="actions">
          {connected && <span className="badge muted">Live</span>}
          <span className={`badge ${data.llm_configured ? 'good' : 'muted'}`}>{data.llm_configured ? 'Claude answering' : 'Template answers (no ANTHROPIC_API_KEY)'}</span>
          <span className={`badge ${data.last_index_error ? 'warn' : data.last_index_at ? 'good' : 'muted'}`} title={data.last_index_error ?? ''}>{data.last_index_at ? `Evidence indexed ${fmtRelative(data.last_index_at)}` : 'Not indexed yet'}</span>
          {isAdmin && <button className="small" disabled={busy === 'index'} onClick={() => run('index', () => api.copilotIndex(), (r) => setNotice(`Indexed ${r.added} new item(s)${r.errors.length ? `; ${r.errors.length} source(s) had errors` : ''}.`))}>{busy === 'index' ? 'Indexing…' : 'Reindex now'}</button>}
        </div>
      </div>
      {error && <div className="banner crit">{error}</div>}
      {notice && <div className="banner info">{notice}</div>}
      <div className="stats" style={{ marginBottom: 14 }}>
        <div className="stat"><span className="v">{Object.values(data.evidence_counts).reduce((n, v) => n + v, 0).toLocaleString('en-GB')}</span><span className="k">sources indexed</span></div>
        <div className="stat"><span className="v">{data.questions.filter((qn) => qn.source !== 'manual' && (qn.status === 'open' || qn.status === 'drafted')).length}</span><span className="k">client questions waiting</span></div>
        <div className="stat"><span className="v">{data.questions.filter((qn) => Date.now() - Date.parse(qn.created_at) < 7 * 86400000).length}</span><span className="k">asked this week</span></div>
        <div className="stat"><span className="v">{[data.slack_configured && 'Slack', data.gmail_connected && 'Gmail', data.tldv_configured && 'tl;dv'].filter(Boolean).join(' · ') || 'none'}</span><span className="k">connected sources</span></div>
      </div>

      <GroupsHead items={sorted.length} lights={sorted.map(lightOf)} open={sorted.every((a) => groups.isOpen(a.id))} onAll={(o) => groups.setAll(sorted.map((a) => a.id), o)} />
      <div className="areas">
        {scope === null && (
          <AccountGroup light={general.length ? 'green' : 'grey'} name="All accounts" sub="questions across the agency" summary={general.length ? `${general.length} question${general.length === 1 ? '' : 's'}` : 'Ask across every account'} open={groups.isOpen('all')} onToggle={() => groups.toggle('all')}>
            <AskPanel accountId={null} questions={general} data={data} busy={busy} run={run} isAdmin={isAdmin} highlight={params.get('q')} />
          </AccountGroup>
        )}
        {sorted.map((a) => {
          const mine = data.questions.filter((qn) => qn.account_id === a.id);
          const waiting = mine.filter((qn) => qn.source !== 'manual' && (qn.status === 'open' || qn.status === 'drafted')).length;
          return (
            <AccountGroup key={a.id} light={lightOf(a)} name={a.name} sub={a.client_slack_channel ?? undefined} open={groups.isOpen(a.id)} onToggle={() => groups.toggle(a.id)}
              summary={`${a.evidence} source${a.evidence === 1 ? '' : 's'} on record${waiting ? ` · ${waiting} client question${waiting === 1 ? '' : 's'} waiting` : mine.length ? ` · last asked ${fmtRelative(mine[0].created_at)}` : ''}`}
              nums={<><span className="num"><span className="k">Sources</span><span className="v">{a.evidence}</span></span><span className="num"><span className="k">Asked</span><span className="v">{mine.length}</span></span></>}
              right={waiting ? <span className="badge warn">{waiting} waiting</span> : null}>
              {groups.isOpen(a.id) && <AskPanel accountId={a.id} questions={mine} data={data} busy={busy} run={run} isAdmin={isAdmin} highlight={params.get('q')} />}
            </AccountGroup>
          );
        })}
      </div>
    </>
  );
}

function AskPanel({ accountId, questions, data, busy, run, isAdmin, highlight }: { accountId: number | null; questions: CopilotQuestion[]; data: CopilotData; busy: string | null; run: <T extends CopilotData>(key: string, fn: () => Promise<T>, after?: (r: T) => void) => Promise<void>; isAdmin: boolean; highlight: string | null }) {
  const actor = useActor();
  const [question, setQuestion] = useState('');
  const [asOf, setAsOf] = useState('');
  const [audience, setAudience] = useState<'internal' | 'client'>('internal');
  const [openId, setOpenId] = useState<number | null>(highlight ? Number(highlight) : null);
  const [copied, setCopied] = useState<number | null>(null);
  const [edit, setEdit] = useState<Record<number, string>>({});
  const key = `ask${accountId ?? 'all'}`;
  const ask = () => {
    if (!question.trim()) return;
    void run(key, () => api.copilotAsk({ account_id: accountId, question: question.trim(), asked_by: actor || undefined, audience, as_of: asOf || null }), (r) => { setQuestion(''); setOpenId(r.question.id); });
  };
  const copy = async (qn: CopilotQuestion) => {
    const text = edit[qn.id] ?? qn.slack_text ?? qn.answer ?? '';
    try { await navigator.clipboard.writeText(text); setCopied(qn.id); setTimeout(() => setCopied(null), 1500); } catch { window.prompt('Copy the message', text); }
  };
  const list = [...questions].sort((a, b) => b.created_at.localeCompare(a.created_at));
  return (
    <div>
      <div className="card" style={{ marginBottom: 10 }}>
        <div className="inline-form" style={{ alignItems: 'flex-end' }}>
          <label className="field" style={{ flex: 1, minWidth: 320 }}><span className="lbl">Question</span><textarea rows={2} value={question} onChange={(e) => setQuestion(e.target.value)} onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') ask(); }} placeholder={accountId ? 'e.g. What did we agree on the last call about samples? · Why was GMV down on Tuesday? · What is the client waiting on from us?' : 'e.g. Which accounts have open client questions this week?'} /></label>
          <label className="field" style={{ minWidth: 150 }}><span className="lbl">About which day</span><input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} /><span className="help">Blank = anything on record</span></label>
          <label className="field" style={{ minWidth: 160 }}><span className="lbl">Answer for</span><select value={audience} onChange={(e) => setAudience(e.target.value as 'internal' | 'client')}><option value="internal">Us (Slack brief)</option><option value="client">The client (reply draft)</option></select></label>
          <button className="primary" disabled={!question.trim() || busy === key} onClick={ask}>{busy === key ? 'Thinking…' : 'Ask'}</button>
        </div>
      </div>
      {list.length === 0 ? <p className="sub">Nothing asked yet for this account.</p> : (
        <div className="ask-list">
          {list.map((qn) => {
            const open = openId === qn.id;
            const text = edit[qn.id] ?? qn.slack_text ?? qn.answer ?? '';
            return (
              <div key={qn.id} className={`card ask-q ${open ? 'open' : ''}`} style={{ marginBottom: 8, padding: '10px 12px' }}>
                <div className="page-head" style={{ marginBottom: open ? 6 : 0, cursor: 'pointer' }} onClick={() => setOpenId(open ? null : qn.id)}>
                  <div><b>{qn.question}</b><div className="sub">{qn.audience === 'internal' ? 'Brief for us' : 'Reply for the client'}{qn.as_of ? ` · about ${qn.as_of}` : ''} · {qn.source === 'manual' ? `asked by ${qn.asked_by ?? qn.created_by ?? 'someone'}` : `from the client (${qn.source})`} · {fmtRelative(qn.created_at)}{qn.generator ? ` · ${qn.generator === 'claude' ? 'Claude' : 'template'}` : ''}</div></div>
                  <div className="actions">
                    {qn.source !== 'manual' && <span className={`badge ${qn.status === 'answered' ? 'good' : qn.status === 'dismissed' ? 'muted' : 'warn'}`}>{qn.status === 'answered' ? 'Answered' : qn.status === 'dismissed' ? 'Dismissed' : 'Waiting'}</span>}
                    {qn.answer && <button className="small" onClick={(e) => { e.stopPropagation(); void copy(qn); }}>{copied === qn.id ? 'Copied' : 'Copy for Slack'}</button>}
                    <span className="sub">{open ? '▾' : '▸'}</span>
                  </div>
                </div>
                {open && (
                  <div>
                    {!qn.answer ? <p className="sub">No answer yet. <button className="small" disabled={busy === `a${qn.id}`} onClick={() => run(`a${qn.id}`, () => api.copilotAnswer(qn.id))}>Draft now</button></p> : (
                      <>
                        <textarea className="slack-text" rows={Math.min(16, Math.max(4, text.split('\n').length + 1))} value={text} onChange={(e) => setEdit({ ...edit, [qn.id]: e.target.value })} style={{ width: '100%', fontFamily: 'inherit' }} />
                        <div className="actions" style={{ marginTop: 6 }}>
                          <button className="small primary" onClick={() => void copy(qn)}>{copied === qn.id ? 'Copied' : 'Copy for Slack'}</button>
                          {edit[qn.id] !== undefined && edit[qn.id] !== (qn.slack_text ?? qn.answer) && isAdmin && <button className="small" disabled={busy === `s${qn.id}`} onClick={() => run(`s${qn.id}`, () => api.copilotUpdate(qn.id, { answer: edit[qn.id] }), () => setEdit((ed) => { const { [qn.id]: _x, ...rest } = ed; return rest; }))}>Save edit</button>}
                          <button className="small" disabled={busy === `a${qn.id}`} onClick={() => run(`a${qn.id}`, () => api.copilotAnswer(qn.id))}>{busy === `a${qn.id}` ? 'Drafting…' : 'Ask again'}</button>
                          {qn.source !== 'manual' && qn.status !== 'answered' && isAdmin && <button className="small" disabled={busy === `send${qn.id}`} onClick={() => run(`send${qn.id}`, () => api.copilotSend(qn.id, edit[qn.id]))}>{qn.source === 'slack' ? 'Reply in the thread' : 'Create Gmail draft'}</button>}
                          {isAdmin && <button className="small danger" onClick={() => window.confirm('Delete this question?') && run(`d${qn.id}`, () => api.copilotDelete(qn.id))}>Delete</button>}
                        </div>
                      </>
                    )}
                    {qn.sources.length > 0 && (
                      <details style={{ marginTop: 8 }}>
                        <summary className="sub" style={{ cursor: 'pointer' }}>Sources ({qn.sources.length})</summary>
                        <ol className="sources">{qn.sources.map((s, i) => <li key={i}><span className="badge muted">{KIND[s.kind] ?? s.kind}</span> <b>{s.url ? <a href={s.url} target="_blank" rel="noreferrer">{s.title}</a> : s.title}</b>{s.occurred_at ? <span className="sub"> · {s.occurred_at.slice(0, 10)}</span> : null}<div className="sub">{s.snippet}</div></li>)}</ol>
                      </details>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
      {accountId === null && data.accounts.length === 0 && <p className="sub">No enabled accounts.</p>}
    </div>
  );
}
