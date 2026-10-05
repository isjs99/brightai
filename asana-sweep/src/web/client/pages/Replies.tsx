import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { ConversationDetail, InboxChannel, RepliesData, RepliesSummaryRow, ReplyEvent, ReplyMode } from '../../../sweep/types';
import { api, fmtRelative, useLiveUpdates } from '../api';
import { useAccountScope } from '../hubs';
import { useIsAdmin } from '../session';
import { Library } from './Library';

/**
 * Creators and Customer service tabs under Accounts: one policy per account and channel (off, draft,
 * automatic with a daily cap), the threads that need a human, the log of what went out automatically
 * with right/wrong feedback that teaches the library, and what the replies know about the account.
 */
export default function RepliesPage({ channel }: { channel: InboxChannel }) {
  const scope = useAccountScope();
  if (scope === null) return <Summary channel={channel} />;
  return <AccountReplies key={`${scope}:${channel}`} accountId={scope} channel={channel} />;
}

const label = (channel: InboxChannel) => (channel === 'cs' ? 'Customer service' : 'Creators');
const who = (channel: InboxChannel) => (channel === 'cs' ? 'buyer' : 'creator');
const MODE_LABEL: Record<ReplyMode, string> = { off: 'Off', draft: 'Draft', auto: 'Automatic' };
const DECISION: Record<ReplyEvent['decision'], { label: string; cls: string }> = {
  auto_sent: { label: 'Sent automatically', cls: 'good' },
  drafted: { label: 'Drafted', cls: 'accent' },
  escalated: { label: 'Needs a human', cls: 'warn' },
  skipped: { label: 'No reply needed', cls: 'muted' },
  capped: { label: 'Over the daily cap', cls: 'warn' },
  quiet: { label: 'Quiet hours', cls: 'muted' },
  error: { label: 'Error', cls: 'crit' },
};

function Summary({ channel }: { channel: InboxChannel }) {
  const [rows, setRows] = useState<RepliesSummaryRow[] | null>(null);
  const [meta, setMeta] = useState<{ master_on: boolean; llm_configured: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => api.repliesSummary().then((r) => { setRows(r.rows); setMeta({ master_on: r.master_on, llm_configured: r.llm_configured }); }).catch((e) => setError((e as Error).message)), []);
  useEffect(() => { load(); }, [load]);
  useLiveUpdates((e) => { if (e.kind === 'inbox' || e.kind === 'settings') load(); });
  if (!rows) return <p>{error ?? 'Loading…'}</p>;
  const mine = rows.filter((r) => r.channel === channel);
  const other = channel === 'cs' ? 'affiliate' : 'cs';
  return (
    <>
      <div className="page-head">
        <div>
          <h1>{label(channel)} replies</h1>
          <p className="hint" style={{ margin: 0 }}>{channel === 'cs' ? 'Buyer chats answered per account with the shop\'s orders, returns, products and policies.' : 'Creator DMs answered per account with the commission, samples, campaigns, brief and products.'} Pick an account above to set its policy and review what went out.</p>
        </div>
        <div className="actions">
          {meta && !meta.llm_configured && <span className="badge crit" title="Set ANTHROPIC_API_KEY on the server">Model not configured</span>}
          {meta && <span className={`badge ${meta.master_on ? 'good' : 'muted'}`} title="The master switch under Settings › Connections gates every automatic send">Master {meta.master_on ? 'on' : 'off'}</span>}
        </div>
      </div>
      {error && <div className="banner crit">{error}</div>}
      <div className="grid-wrap"><table>
        <thead><tr><th>Account</th><th>AM</th><th>{label(channel)}</th><th>Waiting for a human</th><th>Sent automatically today</th><th>Channel</th><th>{label(other)}</th></tr></thead>
        <tbody>
          {mine.map((r) => {
            const o = rows.find((x) => x.account_id === r.account_id && x.channel === other);
            return (
              <tr key={r.account_id}>
                <td><Link to={`${channel === 'cs' ? '/customer-service' : '/creators'}?account=${r.account_id}`}><b>{r.account_name}</b></Link></td>
                <td className="sub">{r.am_name ?? ''}</td>
                <td><span className={`badge ${r.mode === 'auto' ? 'good' : r.mode === 'draft' ? 'accent' : 'muted'}`}>{MODE_LABEL[r.mode]}</span></td>
                <td>{r.waiting ? <span className="badge warn">{r.waiting}</span> : <span className="sub">0</span>}</td>
                <td>{r.auto_today}{r.cap !== null ? <span className="sub"> / {r.cap}</span> : <span className="sub"> · unlimited</span>}</td>
                <td>{r.ready ? <span className="badge good">ready</span> : <span className="badge muted">{channel === 'cs' ? 'scope pending' : 'not connected'}</span>}</td>
                <td className="sub">{o ? `${MODE_LABEL[o.mode]}${o.waiting ? ` · ${o.waiting} waiting` : ''}` : ''}</td>
              </tr>
            );
          })}
          {mine.length === 0 && <tr><td colSpan={7} className="sub">No enabled accounts.</td></tr>}
        </tbody>
      </table></div>
    </>
  );
}

function AccountReplies({ accountId, channel }: { accountId: number; channel: InboxChannel }) {
  const isAdmin = useIsAdmin();
  const [data, setData] = useState<RepliesData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [thread, setThread] = useState<number | null>(null);
  const [logOpen, setLogOpen] = useState(false);
  const [logFilter, setLogFilter] = useState<'all' | ReplyEvent['decision']>('all');
  const [teach, setTeach] = useState<{ id: number; note: string; body: string } | null>(null);
  const [sample, setSample] = useState({ text: '', language: '' });
  const [sampleOut, setSampleOut] = useState<{ draft: string | null; event: ReplyEvent | null } | null>(null);
  const [showLibrary, setShowLibrary] = useState(false);
  const [capDraft, setCapDraft] = useState<number | null | undefined>(undefined);

  const load = useCallback(() => api.replies(accountId, channel).then(setData).catch((e) => setError((e as Error).message)), [accountId, channel]);
  useEffect(() => { load(); }, [load]);
  useLiveUpdates((e) => { if (e.kind === 'inbox' || e.kind === 'settings') load(); });

  const run = async <T,>(key: string, fn: () => Promise<T>, after?: (r: T) => void) => {
    setBusy(key); setError(null);
    try { after?.(await fn()); } catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  };
  const save = (p: Parameters<typeof api.saveReplyPolicy>[2], key = 'policy') => run(key, () => api.saveReplyPolicy(accountId, channel, p), setData);

  if (!data) return <p>{error ?? 'Loading…'}</p>;
  const { policy, counts } = data;
  const cap = capDraft === undefined ? policy.daily_cap : capDraft;
  const toggle = (list: string[], key: string) => (list.includes(key) ? list.filter((k) => k !== key) : [...list, key]);
  const setMode = (mode: ReplyMode) => {
    if (mode === 'auto' && !window.confirm(`Switch ${label(channel)} replies for ${data.account.name} to automatic? Messages that pass the filters go out without a human reading them first${policy.daily_cap !== null ? ` (up to ${policy.daily_cap} a day)` : ' (no daily cap)'}.`)) return;
    save({ mode });
  };
  const log = data.log.filter((e) => logFilter === 'all' || e.decision === logFilter);
  const path = channel === 'cs' ? '/customer-service' : '/creators';

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{label(channel)} · {data.account.name}</h1>
          <p className="hint" style={{ margin: 0 }}>{channel === 'cs' ? 'Every buyer message is read, classified and answered with the shop\'s orders, returns, products and policies, in the buyer\'s language.' : 'Every creator DM is read, classified and answered with the commission, their samples, campaigns, the brief and products, in the creator\'s language.'}</p>
        </div>
        <div className="actions">
          <span className={`badge ${data.channel_ready ? 'good' : 'muted'}`} title={data.channel_note ?? ''}>{data.channel_ready ? 'Channel live' : channel === 'cs' ? 'Scope pending' : 'Not connected'}</span>
          {!data.llm_configured && <span className="badge crit">Model not configured</span>}
          {policy.mode === 'auto' && !data.master_on && <span className="badge warn" title="Settings › Connections › Auto-reply master">Master switch off: drafts only</span>}
          <Link to={`${path}`} className="sub">All accounts ▸</Link>
        </div>
      </div>
      {error && <div className="banner crit">{error}</div>}
      {notice && <div className="banner info">{notice}</div>}
      {data.channel_note && <div className={`banner ${channel === 'cs' ? 'info' : 'warn'}`}>{data.channel_note}</div>}

      {/* Policy strip */}
      <div className={`card policy ${policy.mode}`} style={{ marginBottom: 16 }}>
        <div className="policy-row">
          <button className={`switch ${policy.mode !== 'off' ? 'on' : ''}`} disabled={!isAdmin || busy === 'policy'} title={policy.mode === 'off' ? 'Switch replies on (starts in Draft mode)' : 'Switch replies off'} onClick={() => setMode(policy.mode === 'off' ? 'draft' : 'off')}>
            <span className="knob" /> {policy.mode === 'off' ? 'OFF' : 'ON'}
          </button>
          {policy.mode !== 'off' && (
            <div className="seg" role="radiogroup" aria-label="Reply mode">
              {(['draft', 'auto'] as ReplyMode[]).map((m) => <button key={m} className={`seg-btn ${policy.mode === m ? 'active' : ''}`} disabled={!isAdmin || busy === 'policy'} onClick={() => policy.mode !== m && setMode(m)}>{MODE_LABEL[m]}</button>)}
            </div>
          )}
          <div className="sub policy-note">
            {policy.mode === 'off' && 'Nothing is drafted or sent. Threads still sync so you can reply by hand.'}
            {policy.mode === 'draft' && `Every ${who(channel)} message gets a drafted reply for the team to approve. Nothing goes out on its own.`}
            {policy.mode === 'auto' && `Replies go out on their own when they pass the filters below. Anything escalated, over the cap or in quiet hours waits as a draft.`}
          </div>
        </div>
        <div className="policy-grid">
          <div className="policy-block">
            <div className="lbl">Automatic replies a day</div>
            <div className="cap-row">
              <input type="range" min={1} max={300} value={cap ?? 300} disabled={!isAdmin || cap === null} onChange={(e) => setCapDraft(Number(e.target.value))} onMouseUp={() => capDraft !== undefined && capDraft !== null && save({ daily_cap: capDraft }, 'cap')} onTouchEnd={() => capDraft !== undefined && capDraft !== null && save({ daily_cap: capDraft }, 'cap')} onKeyUp={() => capDraft !== undefined && capDraft !== null && save({ daily_cap: capDraft }, 'cap')} />
              <b className="cap-value">{cap === null ? '∞' : cap}</b>
              <label className="field check"><input type="checkbox" checked={cap === null} disabled={!isAdmin} onChange={(e) => { const v = e.target.checked ? null : 50; setCapDraft(v); save({ daily_cap: v }, 'cap'); }} /> Unlimited</label>
            </div>
            <div className="sub">{counts.auto_today} sent automatically today{cap !== null ? ` of ${cap}` : ''}. Counted per shop day.</div>
          </div>
          <div className="policy-block">
            <div className="lbl">Quiet hours (shop time)</div>
            <div className="inline-form">
              <input type="time" value={policy.quiet_from ?? ''} disabled={!isAdmin} onChange={(e) => save({ quiet_from: e.target.value || null })} style={{ width: 'auto' }} />
              <span className="sub">to</span>
              <input type="time" value={policy.quiet_to ?? ''} disabled={!isAdmin} onChange={(e) => save({ quiet_to: e.target.value || null })} style={{ width: 'auto' }} />
              <label className="field" style={{ minWidth: 120 }}><span className="lbl">Ignore older than</span><input type="number" min={1} max={720} defaultValue={policy.max_age_hours} disabled={!isAdmin} onBlur={(e) => Number(e.target.value) !== policy.max_age_hours && save({ max_age_hours: Number(e.target.value) })} /></label>
              <span className="sub">hours</span>
            </div>
          </div>
          <div className="policy-block">
            <div className="lbl">Only reply automatically when</div>
            <div className="chips">
              {data.only_filters.map((f) => <button key={f.key} className={`chip ${policy.only.includes(f.key) ? 'on' : ''}`} disabled={!isAdmin} onClick={() => save({ only: toggle(policy.only, f.key) })}>{f.label}</button>)}
            </div>
            <div className="sub">Messages that need an answer but fail a filter wait as drafts.</div>
          </div>
          <div className="policy-block">
            <div className="lbl">Always a human for</div>
            <div className="chips">
              {data.intents.filter((i) => i.key !== 'other').map((i) => <button key={i.key} className={`chip ${policy.never.includes(i.key) || i.escalates ? 'on' : ''} ${i.escalates ? 'locked' : ''}`} disabled={!isAdmin || i.escalates} title={i.escalates ? 'Always escalated' : ''} onClick={() => save({ never: toggle(policy.never, i.key) })}>{i.label}</button>)}
            </div>
            <div className="sub">Thanks, emojis and cards never get a reply in any language; the rest is classified before anything is written.</div>
          </div>
          {channel === 'cs' && (
            <div className="policy-block">
              <div className="lbl">Send automatically only for</div>
              <div className="chips">
                {data.intents.filter((i) => !i.escalates && i.key !== 'other').map((i) => <button key={i.key} className={`chip ${policy.auto_intents.includes(i.key) ? 'on' : ''}`} disabled={!isAdmin} onClick={() => save({ auto_intents: toggle(policy.auto_intents, i.key) })}>{i.label}</button>)}
              </div>
              <div className="sub">Leave empty to allow every non-escalated intent.</div>
            </div>
          )}
        </div>
        <div className="policy-foot">
          <div className="lbl">Countries (one TikTok shop each)</div>
          {data.shops.length === 0 ? <div className="sub">No TikTok shop linked to this account yet.</div> : (
            <div className="shop-switches">
              {data.shops.map((s) => (
                <div key={s.id} className={`shop-switch ${s.off ? 'off' : ''}`}>
                  <button className={`switch small ${!s.off ? 'on' : ''}`} disabled={!isAdmin || busy === 'policy' || policy.mode === 'off'} title={policy.mode === 'off' ? 'Switch the account on first' : s.off ? 'Switch this country on' : 'Switch this country off'} onClick={() => save({ shops_off: s.off ? policy.shops_off.filter((x) => x !== s.id) : [...policy.shops_off, s.id] })}><span className="knob" /> {s.off ? 'OFF' : 'ON'}</button>
                  <b>{s.market ?? '–'}</b>
                  <span className="sub">{s.name}{s.token_ok ? '' : ' · not authorised'}</span>
                  <select value={s.language ?? ''} disabled={!isAdmin} onChange={(e) => save({ languages: { ...policy.languages, [s.id]: e.target.value } })} aria-label={`Reply language for ${s.name}`}>
                    <option value="">Language: detect, then market</option>
                    {Object.entries(data.languages).filter(([k]) => k !== '*').map(([k, v]) => <option key={k} value={k}>Always {v}</option>)}
                  </select>
                </div>
              ))}
            </div>
          )}
          <div className="sub" style={{ marginTop: 6 }}>Each country can be on or off on its own, and reply in a fixed language or in the {who(channel)}'s language (falling back to the market: {Object.entries(data.languages).filter(([k]) => k !== '*').map(([, v]) => v).join(', ')}).</div>
        </div>
      </div>

      <div className="kpis">
        <div className="kpi"><div className="v">{counts.replied_today}</div><div className="k">Replied today</div><div className="d">{counts.auto_today} automatic · {counts.manual_today} by the team</div></div>
        <div className="kpi"><div className="v">{counts.waiting}</div><div className="k">Waiting for a human</div><div className="d">{counts.escalated} escalated · {counts.drafts} with a draft</div></div>
        <div className="kpi"><div className="v">{counts.skipped_today}</div><div className="k">Needed no reply today</div><div className="d">thanks, emojis, cards</div></div>
        <div className="kpi"><div className="v">{counts.median_minutes === null ? '–' : `${counts.median_minutes}m`}</div><div className="k">Median time to answer</div><div className="d">automatic, today</div></div>
        <div className="kpi"><div className="v">{counts.wrong_7d}</div><div className="k">Marked wrong, 7 days</div><div className="d">teach from the log below</div></div>
      </div>

      {/* Needs a human */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="page-head" style={{ marginBottom: 8 }}><h3 style={{ margin: 0 }}><span className="badge warn">{counts.waiting}</span> Needs a human</h3><span className="sub">Newest first</span></div>
        {data.waiting.length === 0 ? <p className="sub">Nobody is waiting on this account.</p> : (
          <div className="waitlist">
            {data.waiting.slice(0, 50).map((w) => (
              <div key={w.id} className="wait-row">
                <div className="wait-main">
                  <div><b>{w.counterpart_name ?? who(channel)}</b> <span className="sub">· {w.shop_name}{w.market ? ` ${w.market}` : ''} · {fmtRelative(w.last_message_at)}</span> {w.event && <span className={`badge ${DECISION[w.event.decision].cls}`}>{w.event.intent ? (data.intents.find((i) => i.key === w.event!.intent)?.label ?? w.event.intent) : DECISION[w.event.decision].label}</span>}</div>
                  <div className="their">{w.last_message_text}</div>
                  {w.event?.escalation && <div className="sub">Why: {w.event.escalation}</div>}
                  {w.draft && <div className="draft-preview"><span className="sub">Draft:</span> {w.draft.text}</div>}
                </div>
                {isAdmin && (
                  <div className="actions wait-actions">
                    {w.draft && w.can_send && !w.conversation_id.startsWith('sample-') && <button className="primary small" disabled={busy === `send${w.id}`} onClick={() => window.confirm(`Send this draft to ${w.counterpart_name ?? `the ${who(channel)}`}?`) && run(`send${w.id}`, () => api.sendDraft(w.draft!.id), () => { setNotice('Sent.'); load(); })}>Send draft</button>}
                    <button className="small" onClick={() => setThread(w.id)}>{w.draft ? 'Edit & send' : 'Reply'}</button>
                    <button className="small" disabled={busy === `close${w.id}`} onClick={() => run(`close${w.id}`, () => api.updateConversation(w.id, { status: 'closed' }), () => load())}>No reply needed</button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Sample thread for CS (and creators) before the channel is live */}
      {isAdmin && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="page-head" style={{ marginBottom: 8 }}><h3 style={{ margin: 0 }}>Try a message</h3><span className="sub">Drafts only, never sent. Uses the account's real context.</span></div>
          <div className="inline-form">
            <input type="text" value={sample.text} onChange={(e) => setSample({ ...sample, text: e.target.value })} placeholder={channel === 'cs' ? 'e.g. Wo ist meine Bestellung? Habe seit 5 Tagen nichts gehört.' : 'e.g. Hola! Cuándo llega mi muestra? Y cuál es la comisión?'} style={{ flex: 1, minWidth: 260 }} />
            <select value={sample.language} onChange={(e) => setSample({ ...sample, language: e.target.value })} style={{ width: 'auto' }}><option value="">Detect language</option>{Object.entries(data.languages).filter(([k]) => k !== '*').map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
            <button disabled={!sample.text.trim() || busy === 'sample' || !data.llm_configured} onClick={() => run('sample', () => api.replySample(accountId, channel, sample.text, sample.language || null), (r) => { setSampleOut({ draft: r.draft?.text ?? r.event?.context.reply_text ?? null, event: r.event }); setData(r.data); })}>{busy === 'sample' ? 'Thinking…' : 'Draft a reply'}</button>
          </div>
          {sampleOut && (
            <div className="sample-out">
              {sampleOut.event && <div className="chips" style={{ marginBottom: 6 }}><span className={`badge ${DECISION[sampleOut.event.decision].cls}`}>{DECISION[sampleOut.event.decision].label}</span>{sampleOut.event.context.chips.map((c, i) => <span key={i} className="chip static">{c}</span>)}</div>}
              {sampleOut.event?.escalation && <div className="sub">Why: {sampleOut.event.escalation}</div>}
              <div className="bubble" style={{ marginTop: 6 }}>{sampleOut.draft ?? '(no reply needed)'}</div>
            </div>
          )}
        </div>
      )}

      {/* Log */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="page-head" style={{ marginBottom: 8 }}>
          <h3 style={{ margin: 0, cursor: 'pointer' }} onClick={() => setLogOpen((x) => !x)}><button className="small">{logOpen ? '▾' : '▸'}</button> Everything the replies did <span className="sub">({data.log.length} recent)</span></h3>
          {logOpen && <select value={logFilter} onChange={(e) => setLogFilter(e.target.value as typeof logFilter)} style={{ width: 'auto' }}><option value="all">Everything</option>{(Object.keys(DECISION) as ReplyEvent['decision'][]).map((d) => <option key={d} value={d}>{DECISION[d].label}</option>)}</select>}
        </div>
        {logOpen && (log.length === 0 ? <p className="sub">Nothing logged yet.</p> : (
          <div className="loglist">
            {log.map((e) => (
              <div key={e.id} className={`log-row ${e.feedback ?? ''}`}>
                <div className="log-head">
                  <span className={`badge ${DECISION[e.decision].cls}`}>{DECISION[e.decision].label}</span>
                  <b>{e.context.counterpart ?? who(channel)}</b>
                  <span className="sub">{fmtRelative(e.created_at)}{e.language ? ` · ${data.languages[e.language] ?? e.language}` : ''}{e.intent ? ` · ${data.intents.find((i) => i.key === e.intent)?.label ?? e.intent}` : ''}{e.confidence !== null ? ` · ${Math.round(e.confidence * 100)}%` : ''}</span>
                  {e.feedback === 'right' && <span className="badge good">looks right</span>}
                  {e.feedback === 'wrong' && <span className="badge crit">marked wrong</span>}
                </div>
                {e.context.their_text && <div className="their">{e.context.their_text}</div>}
                {e.context.reply_text && <div className="bubble reply">{e.context.reply_text}</div>}
                {e.escalation && <div className="sub">Why: {e.escalation}</div>}
                {e.context.chips.length > 0 && <div className="chips">{e.context.chips.map((c, i) => <span key={i} className="chip static">{c}</span>)}</div>}
                {isAdmin && (
                  <div className="actions">
                    {e.context.reply_text && <button className="small" disabled={e.feedback === 'right'} onClick={() => run(`fb${e.id}`, () => api.replyFeedback(e.id, 'right'), () => load())}>Looks right</button>}
                    {e.context.reply_text && <button className="small" onClick={() => setTeach(teach?.id === e.id ? null : { id: e.id, note: '', body: '' })}>Mark wrong · teach</button>}
                    <button className="small" onClick={() => setThread(e.conversation_ref)}>Open thread</button>
                  </div>
                )}
                {teach?.id === e.id && (
                  <div className="teach">
                    <input type="text" value={teach.note} onChange={(ev) => setTeach({ ...teach, note: ev.target.value })} placeholder="What was wrong? (kept on the log)" />
                    <textarea rows={3} value={teach.body} onChange={(ev) => setTeach({ ...teach, body: ev.target.value })} placeholder={`What should the next reply know? Saved to the library for ${data.account.name}${e.language && e.language !== 'en' ? ` in ${data.languages[e.language] ?? e.language}` : ''}. Leave empty to only mark it wrong.`} />
                    <div className="actions"><button className="primary small" disabled={busy === `teach${e.id}`} onClick={() => run(`teach${e.id}`, () => api.replyFeedback(e.id, 'wrong', teach.note || null, teach.body.trim() ? { body: teach.body } : null), () => { setTeach(null); setNotice(teach.body.trim() ? 'Marked wrong and added to the library.' : 'Marked wrong.'); load(); })}>Save</button><button className="small" onClick={() => setTeach(null)}>Cancel</button></div>
                  </div>
                )}
              </div>
            ))}
          </div>
        ))}
      </div>

      {/* Knowledge */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="page-head" style={{ marginBottom: 8 }}><h3 style={{ margin: 0 }}>What the replies know</h3><button className="small" onClick={() => setShowLibrary((x) => !x)}>{showLibrary ? 'Hide library' : 'Open library'}</button></div>
        <div className="know-grid">
          {data.knowledge.map((k) => <div key={k.label} className={`know ${k.state}`}><b>{k.label}</b><div className="sub">{k.detail}</div></div>)}
        </div>
        {showLibrary && <div style={{ marginTop: 14 }}><Library accounts={[{ account_id: data.account.id, account_name: data.account.name }]} languages={data.languages} isAdmin={isAdmin} onError={setError} /></div>}
      </div>

      {thread !== null && <ThreadModal id={thread} channel={channel} languages={data.languages} llm={data.llm_configured} onClose={() => { setThread(null); load(); }} />}
    </>
  );
}

function ThreadModal({ id, channel, languages, llm, onClose }: { id: number; channel: InboxChannel; languages: Record<string, string>; llm: boolean; onClose: () => void }) {
  const isAdmin = useIsAdmin();
  const [d, setD] = useState<(ConversationDetail & { auto_reply_blocker: string | null; events: ReplyEvent[] }) | null>(null);
  const [draft, setDraft] = useState('');
  const [instructions, setInstructions] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showContext, setShowContext] = useState(false);
  const load = useCallback(() => api.conversation(id).then((x) => { setD(x); setDraft((cur) => cur || x.replies.filter((r) => !r.sent_at && !r.error_message).slice(-1)[0]?.text || ''); }).catch((e) => setError((e as Error).message)), [id]);
  useEffect(() => { load(); }, [load]);
  const run = async <T,>(key: string, fn: () => Promise<T>, after?: (r: T) => void) => { setBusy(key); setError(null); try { after?.(await fn()); } catch (e) { setError((e as Error).message); } finally { setBusy(null); } };
  const paused = d?.auto_reply_blocker === 'paused by the team';
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        {!d ? <p>{error ?? 'Loading…'}</p> : (
          <>
            <div className="modal-head">
              <div>
                <h3>{d.conversation.counterpart_name ?? who(channel)} <span className="sub">· {d.conversation.shop_name}{d.conversation.market ? ` ${d.conversation.market}` : ''} · {d.conversation.status}</span></h3>
                <div className="sub">{d.auto_reply_blocker ? `Automatic reply: ${d.auto_reply_blocker}` : 'Automatic reply would fire on the next sync'}</div>
              </div>
              <div className="actions">
                <select value={d.conversation.language ?? d.context.language} disabled={!isAdmin} onChange={(e) => run('lang', () => api.updateConversation(id, { language: e.target.value }), (x) => setD({ ...d, ...x }))} style={{ width: 'auto' }}>{Object.entries(languages).filter(([k]) => k !== '*').map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
                <button className="small" onClick={() => setShowContext((x) => !x)}>{showContext ? 'Hide context' : 'Context'}</button>
                {isAdmin && <button className="small" onClick={() => run('pause', () => api.pauseConversation(id, !paused), () => load())}>{paused ? 'Resume automatic' : 'Pause automatic'}</button>}
                {isAdmin && <button className="small" onClick={() => run('status', () => api.updateConversation(id, { status: d.conversation.status === 'closed' ? 'open' : 'closed' }), (x) => setD({ ...d, ...x }))}>{d.conversation.status === 'closed' ? 'Reopen' : 'Close'}</button>}
                <button className="small" onClick={onClose}>×</button>
              </div>
            </div>
            {error && <div className="banner crit">{error}</div>}
            {showContext && (
              <div className="card context" style={{ marginBottom: 10 }}>
                <b>What the reply model sees</b>
                <div className="sub">{languages[d.context.language] ?? d.context.language} · {d.context.library.length} library notes · {d.context.promotions.length} promotions · {d.context.products.length} products · {d.context.orders.length} orders · {d.context.samples.length} samples · {d.context.campaigns.length} campaigns · {d.context.history.length} earlier messages</div>
                {d.context.creator && <div className="sub">Creator: @{d.context.creator.handle}, {d.context.creator.followers ?? '?'} followers, {d.context.creator.videos ?? 0} videos for us, GMV {d.context.creator.gmv_for_us ?? 0}</div>}
                {d.context.orders.length > 0 && <ul>{d.context.orders.map((o) => <li key={o.id}>Order {o.id}: {o.status}, placed {o.created}{o.shipped ? `, shipped ${o.shipped}` : ''}{o.delivered ? `, delivered ${o.delivered}` : ''} · {o.items.join(', ')}</li>)}</ul>}
                {d.context.samples.length > 0 && <ul>{d.context.samples.map((s, i) => <li key={i}>{s.product}: {s.status}{s.requested ? ` (${s.requested.slice(0, 10)})` : ''}</li>)}</ul>}
                {d.context.promotions.length > 0 && <ul>{d.context.promotions.map((p, i) => <li key={i}>{p.name}: {p.discount}, {p.period} ({p.status})</li>)}</ul>}
                {d.context.notes.length > 0 && <ul>{d.context.notes.map((n, i) => <li key={i} className="sub">{n}</li>)}</ul>}
                <details><summary>Library notes applied</summary><ul>{d.context.library.map((l, i) => <li key={i}><b>{l.title}</b> <span className="sub">({l.language}, {l.scope})</span><br />{l.body}</li>)}</ul></details>
              </div>
            )}
            <div className="thread">
              {d.messages.length === 0 && <div className="sub">No messages pulled yet.</div>}
              {d.messages.map((m) => (
                <div key={m.id} className={`msg ${m.sender_role}`}>
                  <div className="bubble">{m.text ?? <i>{m.type.toLowerCase()}</i>}</div>
                  <div className="sub">{m.sender_role === 'us' ? (m.sender_name ?? 'shop') : m.sender_role === 'them' ? (m.sender_name ?? who(channel)) : 'system'} · {fmtRelative(m.created_at)}</div>
                </div>
              ))}
            </div>
            {d.events.length > 0 && <div className="sub" style={{ marginTop: 6 }}>Last decision: {DECISION[d.events[0].decision].label}{d.events[0].escalation ? ` · ${d.events[0].escalation}` : ''}</div>}
            {isAdmin && (
              <div className="card" style={{ marginTop: 10 }}>
                <textarea rows={4} value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Type a reply, or let the model draft one from the context" style={{ width: '100%' }} />
                <div className="inline-form" style={{ marginTop: 8 }}>
                  <input type="text" value={instructions} onChange={(e) => setInstructions(e.target.value)} placeholder="Optional steer, e.g. offer the 15% code" style={{ flex: 1, minWidth: 220 }} />
                  <button onClick={() => run('draft', () => api.draftReply(id, { instructions: instructions || undefined }), (x) => { setDraft(x.reply.text); setD({ ...d, ...x }); })} disabled={!llm || busy === 'draft'}>{busy === 'draft' ? 'Drafting…' : 'Draft for me'}</button>
                  <button className="primary" onClick={() => window.confirm(`Send this reply to ${d.conversation.counterpart_name ?? 'them'} on TikTok?`) && run('send', () => api.sendReply(id, draft), (x) => { setD({ ...d, ...x }); setDraft(''); })} disabled={!draft.trim() || busy === 'send' || !d.conversation.can_send || d.conversation.conversation_id.startsWith('sample-')}>{busy === 'send' ? 'Sending…' : 'Send'}</button>
                </div>
                {!d.conversation.can_send && !d.conversation.conversation_id.startsWith('sample-') && <p className="sub">TikTok only lets the shop message buyers with a recent order or conversation. This one is read-only for now.</p>}
                {d.conversation.conversation_id.startsWith('sample-') && <p className="sub">Sample thread: nothing here is ever sent.</p>}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
