import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { ReplyAudit, ReplyAuditAction, ReplyAuditItem, ReplyAuditRow } from '../../../sweep/types';
import { api, fmtRelative, useLiveUpdates } from '../api';
import { useIsAdmin } from '../session';

/**
 * The reply audit: the latest run's ranking (accounts, topics, languages, rubric points), the worst replies with
 * the auditor's reasoning, what the run changed on its own (with Undo), and the history of runs.
 */

const RUBRIC: Record<string, string> = { answers: 'Answers', facts: 'Facts', language: 'Language', tone: 'Tone', policy: 'Policy', next_step: 'Next step' };
const pct = (x: number | null) => (x === null ? '–' : `${Math.round(x * 100)}%`);
const num = (x: number | null) => (x === null ? '–' : x.toFixed(1));
const Trend = ({ now, prev }: { now: number | null; prev: number | null }) => (now === null || prev === null ? null : <span className={`sub ${now > prev + 0.2 ? 'good' : now < prev - 0.2 ? 'crit' : ''}`} title={`previous run ${prev.toFixed(1)}`}>{now > prev + 0.2 ? ' ↑' : now < prev - 0.2 ? ' ↓' : ' →'}</span>);

function RankTable<T extends ReplyAuditRow>({ rows, label, head }: { rows: T[]; label: (r: T) => React.ReactNode; head: string }) {
  if (!rows.length) return <p className="sub">Nothing to rank.</p>;
  return (
    <table>
      <thead><tr><th>{head}</th><th className="num">Replies</th><th className="num">Mean /12</th><th className="num">Fails</th><th>Worst</th></tr></thead>
      <tbody>{rows.map((r, i) => (
        <tr key={i} className={(r.fail_rate ?? 0) > 0.1 || (r.mean ?? 12) < 7 ? 'wrong' : ''}>
          <td>{label(r)}</td>
          <td className="num">{r.n}</td>
          <td className="num">{num(r.mean)}<Trend now={r.mean} prev={r.prev_mean} /></td>
          <td className="num">{pct(r.fail_rate)}</td>
          <td className="sub">{r.worst.slice(0, 2).map((w) => `${w.counterpart ?? 'someone'} ${w.total}/12: ${w.why}`).join(' · ')}</td>
        </tr>
      ))}</tbody>
    </table>
  );
}

function ActionLine({ a, onUndo, isAdmin }: { a: ReplyAuditAction; onUndo: () => void; isAdmin: boolean }) {
  const text = a.kind === 'note' ? <>Library note added for account #{a.account_id} ({a.language}, {a.channel === 'cs' ? 'buyers' : 'creators'}): <b>{a.title}</b> · "{a.body}" · {a.replies} replies would have been helped</>
    : a.kind === 'rule' ? <>Standing rule added to every reply prompt: "{a.rule}" · seen {a.replies} times</>
    : a.kind === 'nudge' ? <>{a.direction === 'to_human' ? `"${a.intent}" switched to a human on account #${a.account_id} (${Math.round(a.fail_rate * 100)}% fails)` : `"${a.intent}" restored to automatic on account #${a.account_id}: it scores well again`}</>
    : a.kind === 'note_disabled' ? <>Note #{a.note_id} ({a.note_key}) switched off: {a.why}</>
    : <>Note #{a.note_id} ({a.note_key}) checked: {a.why}</>;
  return <li className={a.undone ? 'dim' : ''}><span className={`badge ${a.kind === 'nudge' && a.direction === 'to_human' ? 'warn' : a.kind === 'note_disabled' ? 'muted' : 'good'}`}>{a.kind.replace('_', ' ')}</span> {text}{a.undone ? <span className="sub"> · undone</span> : isAdmin && a.kind !== 'note_checked' ? <> <button className="small" onClick={onUndo}>Undo</button></> : null}</li>;
}

export default function RepliesAuditPage() {
  const isAdmin = useIsAdmin();
  const [data, setData] = useState<{ latest: ReplyAudit | null; items: ReplyAuditItem[]; history: ReplyAudit[]; rules: string[]; running: boolean } | null>(null);
  const [viewing, setViewing] = useState<{ audit: ReplyAudit; items: ReplyAuditItem[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<number | null>(null);
  const [onlyFails, setOnlyFails] = useState(false);
  const load = useCallback(() => api.repliesAudit().then(setData).catch((e) => setError((e as Error).message)), []);
  useEffect(() => { load(); }, [load]);
  useLiveUpdates((e) => { if (e.kind === 'inbox') load(); }, 5000);
  if (!data) return <p>{error ?? 'Loading…'}</p>;
  const audit = viewing?.audit ?? data.latest;
  const items = viewing?.items ?? data.items;
  const shown = items.filter((i) => !onlyFails || i.fail);
  const run = async () => { setBusy(true); setError(null); try { const r = await api.repliesAuditRun(); setViewing(null); setData({ ...data, latest: r.audit, items: r.items }); await load(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } };
  const undo = async (index: number) => { if (!audit) return; setError(null); try { const r = await api.repliesAuditUndo(audit.id, index); if (viewing) setViewing({ ...viewing, audit: r.audit }); await load(); } catch (e) { setError((e as Error).message); } };
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Reply audit</h1>
          <p className="hint" style={{ margin: 0 }}>Every Monday and Thursday the last three days of automatic replies are sampled, up to 25 per account and channel covering every topic, and scored 0 to 12 by a stronger model: answers the question, facts in the context, language and register, tone, policy, clear next step. A zero on facts or policy is a fail. The run then adds library notes, standing rules and hands a failing topic to a human on that account, and checks on the next run whether that helped. <Link to="/creators">Creators</Link> · <Link to="/customer-service">Customer service</Link></p>
        </div>
        <div className="actions">
          {data.running && <span className="badge warn">Running…</span>}
          {isAdmin && <button className="primary" disabled={busy || data.running} onClick={run}>{busy ? 'Auditing…' : 'Run now'}</button>}
        </div>
      </div>
      {error && <div className="banner crit">{error}</div>}
      {!audit ? <div className="empty">No audit has run yet. Press Run now, or wait for Monday 07:00.</div> : (
        <>
          {viewing && <div className="banner info">Showing run #{viewing.audit.id} from {fmtRelative(viewing.audit.started_at)}. <a href="#latest" onClick={(e) => { e.preventDefault(); setViewing(null); }}>Back to the latest</a>.</div>}
          <div className="kpis">
            <div className="kpi"><div className="v">{num(audit.mean)}<Trend now={audit.mean} prev={audit.prev_mean} /></div><div className="k">mean score of 12</div><div className="d">{audit.prev_mean !== null ? `previous run ${num(audit.prev_mean)}` : 'first run'}</div></div>
            <div className="kpi"><div className="v">{pct(audit.fail_rate)}</div><div className="k">fail rate</div><div className="d">a zero on facts or policy</div></div>
            <div className="kpi"><div className="v">{audit.sampled}</div><div className="k">replies scored</div><div className="d">since {fmtRelative(audit.since)}</div></div>
            <div className="kpi"><div className="v">{audit.actions.filter((a) => !a.undone && a.kind !== 'note_checked').length}</div><div className="k">changes made by the run</div><div className="d">notes, rules, hand-overs</div></div>
            <div className="kpi"><div className="v">{audit.summary.red.length}</div><div className="k">accounts in the red</div><div className="d">{audit.summary.red.join(', ') || 'none'}</div></div>
          </div>
          {audit.error && <div className="banner warn">{audit.error}</div>}

          <div className="card" style={{ marginBottom: 12 }}>
            <h3 style={{ marginTop: 0 }}>Accounts, worst first</h3>
            <RankTable rows={audit.summary.by_account} head="Account" label={(r) => <><Link to={`${r.channel === 'cs' ? '/customer-service' : '/creators'}?account=${r.account_id}`}><b>{r.account_name}</b></Link> <span className="sub">{r.channel === 'cs' ? 'buyers' : 'creators'}</span></>} />
          </div>
          <div className="two-col" style={{ marginBottom: 12 }}>
            <div className="card"><h3 style={{ marginTop: 0 }}>Topics</h3><RankTable rows={audit.summary.by_intent} head="Topic" label={(r) => <>{r.label} <span className="sub">{r.channel === 'cs' ? 'buyers' : 'creators'}</span></>} /></div>
            <div className="card"><h3 style={{ marginTop: 0 }}>Languages</h3><RankTable rows={audit.summary.by_language} head="Language" label={(r) => r.language} />
              <h3>Rubric</h3>
              <table><thead><tr><th>Point</th><th className="num">Mean /2</th><th className="num">Zeros</th></tr></thead><tbody>{audit.summary.by_rubric.map((r) => <tr key={r.key}><td>{RUBRIC[r.key] ?? r.key}<div className="sub">{r.label}</div></td><td className="num">{num(r.mean)}</td><td className="num">{r.zeros}</td></tr>)}</tbody></table>
            </div>
          </div>

          <div className="card" style={{ marginBottom: 12 }}>
            <h3 style={{ marginTop: 0 }}>What the run changed</h3>
            {audit.actions.length === 0 ? <p className="sub">Nothing: no issue repeated often enough to act on.</p> : <ul className="actions-list">{audit.actions.map((a, i) => <ActionLine key={i} a={a} isAdmin={isAdmin} onUndo={() => undo(i)} />)}</ul>}
            {data.rules.length > 0 && <p className="sub">Standing rules in every reply prompt now: {data.rules.map((r) => `"${r}"`).join(' · ')}</p>}
          </div>

          <div className="card" style={{ marginBottom: 12 }}>
            <div className="page-head" style={{ marginBottom: 8 }}><h3 style={{ margin: 0 }}>The replies, worst first</h3><label className="field check"><input type="checkbox" checked={onlyFails} onChange={(e) => setOnlyFails(e.target.checked)} /> fails only</label></div>
            {shown.length === 0 ? <p className="sub">None.</p> : (
              <div className="loglist">{shown.slice(0, 80).map((it) => (
                <div key={it.id} className={`log-row ${it.fail ? 'wrong' : ''}`}>
                  <div className="log-head" style={{ cursor: 'pointer' }} onClick={() => setOpen(open === it.id ? null : it.id)}>
                    <span className={`badge ${it.fail ? 'crit' : it.total >= 10 ? 'good' : 'warn'}`}>{it.fail ? 'fail' : `${it.total}/12`}</span>
                    <b>{it.counterpart ?? 'someone'}</b>
                    <span className="sub">{it.channel === 'cs' ? 'buyer' : 'creator'}{it.intent ? ` · ${it.intent}` : ''}{it.language ? ` · ${it.language}` : ''}{it.decision !== 'auto_sent' ? ` · ${it.decision}` : ''}</span>
                    <span className="sub" style={{ flex: 1 }}>{it.why}</span>
                    <span className="sub">{Object.entries(it.scores).map(([k, v]) => `${RUBRIC[k] ?? k} ${v}`).join(' · ')}</span>
                  </div>
                  {open === it.id && (
                    <>
                      {it.their_text && <div className="their">{it.their_text}</div>}
                      {it.reply_text && <div className="bubble reply">{it.reply_text}</div>}
                      {it.followup_text && <div className="sub">They wrote back: {it.followup_text}</div>}
                      {it.unverified_claim && <div className="sub"><b>Unverified claim:</b> {it.unverified_claim}</div>}
                      {it.note && <div className="sub"><b>Suggested note ({it.note_key}):</b> {it.note}</div>}
                      {it.fault && <div className="sub"><b>Fault:</b> {it.fault.replace(/_/g, ' ')}</div>}
                      <div className="actions"><Link className="small" to={`${it.channel === 'cs' ? '/customer-service' : '/creators'}?account=${it.account_id ?? ''}`}>Open the account</Link></div>
                    </>
                  )}
                </div>
              ))}</div>
            )}
          </div>

          <div className="card">
            <h3 style={{ marginTop: 0 }}>Runs</h3>
            <table><thead><tr><th>#</th><th>When</th><th className="num">Replies</th><th className="num">Mean</th><th className="num">Fails</th><th className="num">Changes</th><th>Red</th><th /></tr></thead><tbody>
              {data.history.map((h) => <tr key={h.id} className={audit.id === h.id ? 'sel' : ''}><td>{h.id}</td><td>{fmtRelative(h.started_at)}</td><td className="num">{h.sampled}</td><td className="num">{num(h.mean)}<Trend now={h.mean} prev={h.prev_mean} /></td><td className="num">{pct(h.fail_rate)}</td><td className="num">{h.actions.filter((a) => a.kind !== 'note_checked').length}</td><td className="sub">{h.summary.red.join(', ')}</td><td>{h.finished_at ? <button className="small" onClick={() => api.repliesAuditOne(h.id).then(setViewing).catch((e) => setError((e as Error).message))}>Open</button> : <span className="badge warn">running</span>}</td></tr>)}
            </tbody></table>
          </div>
        </>
      )}
    </>
  );
}
