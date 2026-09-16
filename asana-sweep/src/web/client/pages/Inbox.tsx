import { useCallback, useEffect, useState } from 'react';
import type { ContextEntry, ConversationDetail, InboxConversation, InboxData } from '../../../sweep/types';
import { api, fmtRelative, useLiveUpdates } from '../api';
import { useIsAdmin } from '../session';

type Tab = 'inbox' | 'switches' | 'library';
type Detail = ConversationDetail & { auto_reply_blocker?: string | null };

export default function InboxPage() {
  const [data, setData] = useState<(InboxData & { languages: Record<string, string> }) | null>(null);
  const [tab, setTab] = useState<Tab>('inbox');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [draft, setDraft] = useState('');
  const [instructions, setInstructions] = useState('');
  const [showContext, setShowContext] = useState(false);
  const [f, setF] = useState({ channel: '', account: '', only: 'needs' as 'needs' | 'open' | 'all', q: '' });
  const isAdmin = useIsAdmin();

  const load = useCallback(() => api.inbox().then((d) => { setData(d); }).catch((e) => setError((e as Error).message)), []);
  const loadDetail = useCallback((id: number) => api.conversation(id).then((d) => { setDetail(d); }).catch((e) => setError((e as Error).message)), []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (selected !== null) loadDetail(selected); else setDetail(null); }, [selected, loadDetail]);
  const connected = useLiveUpdates((e) => { if (e.kind === 'inbox' || e.kind === 'settings') { load(); if (selected !== null) loadDetail(selected); } });

  const run = async <T,>(key: string, fn: () => Promise<T>, after?: (r: T) => void) => {
    setBusy(key);
    setError(null);
    try {
      const r = await fn();
      after?.(r);
    } catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  };
  const absorb = (d: InboxData) => setData((prev) => ({ ...d, languages: prev?.languages ?? {} }));

  if (!data) return <p>{error ?? 'Loading…'}</p>;
  const s = data.settings;
  const q = f.q.trim().toLowerCase();
  const list = data.conversations.filter((c) =>
    (!f.channel || c.channel === f.channel) &&
    (!f.account || String(c.account_id ?? '') === f.account) &&
    (f.only === 'all' || (f.only === 'open' ? c.status !== 'closed' : c.needs_reply)) &&
    (!q || [c.counterpart_name, c.last_message_text, c.shop_name, c.account_name].some((v) => (v ?? '').toLowerCase().includes(q))));
  const accountsWithShops = data.accounts.filter((a) => a.shops.length > 0);
  const masterOk = s.tts_configured && s.llm_configured;

  const statusBadge = (c: InboxConversation) => c.needs_reply ? <span className="badge warn">Needs reply</span> : c.status === 'auto_replied' ? <span className="badge good">Auto-replied</span> : c.status === 'replied' ? <span className="badge good">Replied</span> : c.status === 'closed' ? <span className="badge muted">Closed</span> : <span className="badge muted">Open</span>;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>CS &amp; affiliate inbox</h1>
          <p className="hint" style={{ margin: 0 }}>Buyer chats and creator DMs from every connected TikTok shop in one place. Draft or auto-send replies from the context library, live promotions, products, past history and Cruva outreach.</p>
        </div>
        <div className="actions">
          {connected && <span className="badge muted">Live</span>}
          <span className={`badge ${s.last_sync_error ? 'crit' : s.last_sync_at ? 'good' : 'muted'}`} title={s.last_sync_error ?? ''}>{s.last_sync_at ? `Synced ${fmtRelative(s.last_sync_at)}` : 'Never synced'}</span>
          {isAdmin && <button onClick={() => run('sync', api.syncInbox, (d) => { absorb(d); setNotice(`Synced ${d.result.conversations} conversations, ${d.result.new_messages} new messages, ${d.result.auto_replies} auto-replies sent.`); })} disabled={busy === 'sync' || !s.tts_configured}>{busy === 'sync' ? 'Syncing…' : 'Sync now'}</button>}
        </div>
      </div>

      {/* The one clear switch */}
      <div className={`card master ${s.auto_reply_master ? 'on' : 'off'}`} style={{ marginBottom: 16 }}>
        <div className="master-row">
          <div>
            <div className="master-title">Auto-reply is <b>{s.auto_reply_master ? 'ON' : 'OFF'}</b></div>
            <div className="sub">
              {s.auto_reply_master
                ? `Replies go out automatically for accounts switched on below (${data.accounts.filter((a) => a.auto_reply_cs).length} CS, ${data.accounts.filter((a) => a.auto_reply_affiliate).length} affiliate), to messages newer than ${s.max_age_hours}h, checked every ${Math.round(s.poll_seconds / 60)} min.`
                : 'Nothing is sent automatically. You can still draft and send replies by hand.'}
              {!s.tts_configured && ' TikTok app not configured (TTS_APP_KEY / TTS_APP_SECRET).'}
              {!s.llm_configured && ' ANTHROPIC_API_KEY not set, so drafting is off.'}
            </div>
          </div>
          {isAdmin && (
            <button className={`switch ${s.auto_reply_master ? 'on' : ''}`} disabled={busy === 'master' || (!s.auto_reply_master && !masterOk)} title={!s.auto_reply_master && !masterOk ? 'Configure the TikTok app and ANTHROPIC_API_KEY first' : ''}
              onClick={() => { if (s.auto_reply_master || window.confirm('Turn auto-reply ON? Claude will answer buyers and creators for every account switched on below, without a human reading first.')) run('master', () => api.saveInboxSettings({ auto_reply_master: !s.auto_reply_master }), absorb); }}>
              <span className="knob" /> {s.auto_reply_master ? 'ON' : 'OFF'}
            </button>
          )}
        </div>
      </div>

      {error && <div className="banner crit">{error}</div>}
      {notice && <div className="banner info">{notice}</div>}

      <div className="tabs">
        {(['inbox', 'switches', 'library'] as Tab[]).map((t) => (
          <button key={t} className={`tab ${tab === t ? 'active' : ''}`} onClick={() => setTab(t)}>
            {t === 'inbox' ? `Inbox (${data.counts.needs_reply} need a reply)` : t === 'switches' ? 'Auto-reply per account' : 'Context library'}
          </button>
        ))}
      </div>

      {tab === 'inbox' && (
        <>
          <div className="kpis">
            <div className="kpi"><div className="v">{data.counts.needs_reply}</div><div className="k">Waiting on us</div></div>
            <div className="kpi"><div className="v">{data.counts.cs}</div><div className="k">Customer chats</div></div>
            <div className="kpi"><div className="v">{data.counts.affiliate}</div><div className="k">Creator chats</div></div>
            <div className="kpi"><div className="v">{data.counts.auto_replied_today}</div><div className="k">Auto-replies today</div></div>
          </div>
          <div className="toolbar">
            <input type="text" placeholder="Search" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} />
            <select value={f.channel} onChange={(e) => setF({ ...f, channel: e.target.value })}><option value="">CS + affiliate</option><option value="cs">Customer service</option><option value="affiliate">Affiliates</option></select>
            <select value={f.account} onChange={(e) => setF({ ...f, account: e.target.value })}><option value="">All accounts</option>{accountsWithShops.map((a) => <option key={a.account_id} value={a.account_id}>{a.account_name}</option>)}</select>
            <select value={f.only} onChange={(e) => setF({ ...f, only: e.target.value as typeof f.only })}><option value="needs">Needs reply</option><option value="open">Open</option><option value="all">Everything</option></select>
            <span className="sub">{list.length} of {data.conversations.length}</span>
          </div>
          {data.conversations.length === 0 ? (
            <div className="empty">{s.tts_configured ? 'No conversations yet. Connect shops under Promotions and press Sync now.' : 'Connect the TikTok Shop app (TTS_APP_KEY / TTS_APP_SECRET) and authorise shops under Promotions to start reading chats.'}</div>
          ) : (
            <div className="inbox-split">
              <div className="inbox-list">
                {list.map((c) => (
                  <button key={c.id} className={`conv ${selected === c.id ? 'active' : ''}`} onClick={() => setSelected(c.id)}>
                    <div className="conv-top"><b>{c.counterpart_name ?? (c.channel === 'cs' ? 'Buyer' : 'Creator')}</b><span className="sub">{fmtRelative(c.last_message_at)}</span></div>
                    <div className="sub">{c.account_name ?? c.shop_name} · {c.market ?? ''} · {c.channel === 'cs' ? 'CS' : 'Affiliate'}{c.unread_count ? ` · ${c.unread_count} unread` : ''}</div>
                    <div className="conv-preview">{c.last_sender === 'us' ? 'You: ' : ''}{c.last_message_text ?? '…'}</div>
                    <div className="actions">{statusBadge(c)}{c.auto_reply_on && <span className="badge accent">auto</span>}</div>
                  </button>
                ))}
                {list.length === 0 && <div className="empty">Nothing matches.</div>}
              </div>
              <div className="inbox-detail">
                {!detail ? <div className="empty">Pick a conversation.</div> : (
                  <>
                    <div className="page-head" style={{ marginBottom: 10 }}>
                      <div>
                        <h2 style={{ margin: 0 }}>{detail.conversation.counterpart_name ?? 'Conversation'} <span className="sub">{detail.conversation.channel === 'cs' ? 'buyer' : 'creator'} · {detail.conversation.account_name ?? detail.conversation.shop_name} {detail.conversation.market ?? ''}</span></h2>
                        <div className="sub">{statusBadge(detail.conversation)} {detail.auto_reply_blocker ? <span title="Why auto-reply would not fire right now">auto-reply: {detail.auto_reply_blocker}</span> : <span className="badge good">auto-reply would fire on the next sync</span>}</div>
                      </div>
                      <div className="actions">
                        <select value={detail.conversation.language ?? detail.context.language} disabled={!isAdmin} onChange={(e) => run('lang', () => api.updateConversation(detail.conversation.id, { language: e.target.value }), setDetail)} style={{ width: 'auto' }}>
                          {Object.entries(data.languages).filter(([k]) => k !== '*').map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                        </select>
                        <button onClick={() => setShowContext((x) => !x)}>{showContext ? 'Hide context' : 'Context'}</button>
                        {isAdmin && <button onClick={() => run('status', () => api.updateConversation(detail.conversation.id, { status: detail.conversation.status === 'closed' ? 'open' : 'closed' }), setDetail)}>{detail.conversation.status === 'closed' ? 'Reopen' : 'Close'}</button>}
                      </div>
                    </div>

                    {showContext && (
                      <div className="card context" style={{ marginBottom: 10 }}>
                        <b>What the reply model sees</b>
                        <div className="sub">Language {detail.context.language} · {detail.context.library.length} library entries · {detail.context.promotions.length} promotions · {detail.context.products.length} products · {detail.context.history.length} earlier messages · {detail.context.cruva_outreach.length} Cruva notes</div>
                        {detail.context.promotions.length > 0 && <ul>{detail.context.promotions.map((p, i) => <li key={i}>{p.name}: {p.discount}, {p.period} ({p.status})</li>)}</ul>}
                        {detail.context.cruva_outreach.length > 0 && <ul>{detail.context.cruva_outreach.map((o, i) => <li key={i}>{o.when?.slice(0, 10)} {o.summary}</li>)}</ul>}
                        {detail.context.history.length > 0 && <details><summary>Earlier conversations</summary><ul>{detail.context.history.map((h, i) => <li key={i}><span className="sub">{h.when.slice(0, 10)} {h.who}:</span> {h.text}</li>)}</ul></details>}
                        <details><summary>Library entries applied</summary><ul>{detail.context.library.map((l, i) => <li key={i}><b>{l.title}</b> <span className="sub">({l.language}, {l.scope})</span><br />{l.body}</li>)}</ul></details>
                      </div>
                    )}

                    <div className="thread">
                      {detail.messages.length === 0 && <div className="sub">No messages pulled yet.</div>}
                      {detail.messages.map((m) => (
                        <div key={m.id} className={`msg ${m.sender_role}`}>
                          <div className="bubble">{m.text ?? <i>{m.type.toLowerCase()}</i>}</div>
                          <div className="sub">{m.sender_role === 'us' ? (m.sender_name ?? 'shop') : m.sender_role === 'them' ? (m.sender_name ?? (detail.conversation.channel === 'cs' ? 'buyer' : 'creator')) : 'system'} · {fmtRelative(m.created_at)}</div>
                        </div>
                      ))}
                    </div>

                    {isAdmin && (
                      <div className="card" style={{ marginTop: 10 }}>
                        <textarea rows={4} value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Type a reply, or let Claude draft one from the context" style={{ width: '100%' }} />
                        <div className="inline-form" style={{ marginTop: 8 }}>
                          <input type="text" value={instructions} onChange={(e) => setInstructions(e.target.value)} placeholder="Optional steer for the draft, e.g. offer the 15% code" style={{ flex: 1, minWidth: 220 }} />
                          <button onClick={() => run('draft', () => api.draftReply(detail.conversation.id, { instructions: instructions || undefined }), (d) => { setDraft(d.reply.text); setDetail(d); })} disabled={!s.llm_configured || busy === 'draft'} title={s.llm_configured ? '' : 'Set ANTHROPIC_API_KEY'}>{busy === 'draft' ? 'Drafting…' : 'Draft with Claude'}</button>
                          <button className="primary" onClick={() => window.confirm(`Send this reply to ${detail.conversation.counterpart_name ?? 'them'} on TikTok?`) && run('send', () => api.sendReply(detail.conversation.id, draft), (d) => { setDetail(d); setDraft(''); setNotice('Sent.'); load(); })} disabled={!draft.trim() || busy === 'send' || !detail.conversation.can_send}>{busy === 'send' ? 'Sending…' : 'Send'}</button>
                        </div>
                        {!detail.conversation.can_send && <p className="sub">TikTok only lets the shop message buyers with a recent order or conversation. This one is read-only for now.</p>}
                        {detail.replies.length > 0 && (
                          <details style={{ marginTop: 8 }}><summary>{detail.replies.length} draft{detail.replies.length === 1 ? '' : 's'} / sent replies</summary>
                            <ul>{detail.replies.map((r) => <li key={r.id}><span className={`badge ${r.error_message ? 'crit' : r.sent_at ? 'good' : 'muted'}`}>{r.error_message ? 'failed' : r.sent_at ? r.mode : 'draft'}</span> {r.text} <span className="sub">{fmtRelative(r.sent_at ?? r.created_at)}{r.error_message ? ` · ${r.error_message}` : ''}</span> {!r.sent_at && <button className="small" onClick={() => setDraft(r.text)}>Use</button>}</li>)}</ul>
                          </details>
                        )}
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>
          )}
        </>
      )}

      {tab === 'switches' && (
        <>
          <p className="hint">Per account: which channels Claude may answer on its own. Both switches only do something while the master switch above is ON. Accounts without an authorised TikTok shop are listed but cannot be answered.</p>
          <table>
            <thead><tr><th>Account</th><th>Shops connected</th><th>Customer service</th><th>Affiliate DMs</th><th>Reply language</th></tr></thead>
            <tbody>
              {data.accounts.map((a) => (
                <tr key={a.account_id} className={a.shops.length ? '' : 'dim'}>
                  <td><b>{a.account_name}</b><div className="sub">{a.markets ?? ''}</div></td>
                  <td className="sub">{a.shops.length ? a.shops.map((sh) => `${sh.name}${sh.market ? ` (${sh.market})` : ''}${sh.token_ok ? '' : ' ⚠︎'}`).join(', ') : 'none'}</td>
                  <td><label className="field check"><input type="checkbox" checked={a.auto_reply_cs} disabled={!isAdmin || !a.shops.length} onChange={(e) => run(`a${a.account_id}`, () => api.saveAccountReply(a.account_id, { auto_reply_cs: e.target.checked }), absorb)} /> {a.auto_reply_cs ? 'Auto' : 'Manual'}</label></td>
                  <td><label className="field check"><input type="checkbox" checked={a.auto_reply_affiliate} disabled={!isAdmin || !a.shops.length} onChange={(e) => run(`b${a.account_id}`, () => api.saveAccountReply(a.account_id, { auto_reply_affiliate: e.target.checked }), absorb)} /> {a.auto_reply_affiliate ? 'Auto' : 'Manual'}</label></td>
                  <td><select value={a.reply_language ?? ''} disabled={!isAdmin} onChange={(e) => run(`l${a.account_id}`, () => api.saveAccountReply(a.account_id, { reply_language: e.target.value || null }), absorb)} style={{ width: 'auto' }}><option value="">Detect from message / market</option>{Object.entries(data.languages).filter(([k]) => k !== '*').map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></td>
                </tr>
              ))}
            </tbody>
          </table>
          {isAdmin && (
            <div className="card inline-form" style={{ marginTop: 16 }}>
              <label className="field" style={{ minWidth: 120 }}><span className="lbl">Check every (s)</span><input type="number" min={30} defaultValue={s.poll_seconds} onBlur={(e) => Number(e.target.value) !== s.poll_seconds && run('poll', () => api.saveInboxSettings({ poll_seconds: Number(e.target.value) }), absorb)} /></label>
              <label className="field" style={{ minWidth: 160 }}><span className="lbl">Only auto-reply if newer than (h)</span><input type="number" min={1} defaultValue={s.max_age_hours} onBlur={(e) => Number(e.target.value) !== s.max_age_hours && run('age', () => api.saveInboxSettings({ max_age_hours: Number(e.target.value) }), absorb)} /></label>
              <label className="field check"><input type="checkbox" checked={s.inbox_enabled} onChange={(e) => run('en', () => api.saveInboxSettings({ inbox_enabled: e.target.checked }), absorb)} /> Read inboxes in the background</label>
              <span className="sub">Model: {s.model}</span>
            </div>
          )}
        </>
      )}

      {tab === 'library' && <Library accounts={data.accounts} languages={data.languages} isAdmin={isAdmin} onError={setError} />}
    </>
  );
}

function Library({ accounts, languages, isAdmin, onError }: { accounts: InboxData['accounts']; languages: Record<string, string>; isAdmin: boolean; onError: (e: string | null) => void }) {
  const [entries, setEntries] = useState<ContextEntry[] | null>(null);
  const [lang, setLang] = useState('*');
  const [editing, setEditing] = useState<number | 'new' | null>(null);
  const [form, setForm] = useState({ language: '*', scope: 'both', account_id: '', title: '', body: '' });
  useEffect(() => { api.listContext().then((r) => setEntries(r.entries)).catch((e) => onError((e as Error).message)); }, [onError]);
  if (!entries) return <p>Loading…</p>;
  const langs = ['*', ...Object.keys(languages).filter((k) => k !== '*')];
  const visible = entries.filter((e) => lang === '*' ? true : e.language === lang || e.language === '*');
  const startEdit = (e: ContextEntry | null) => {
    setEditing(e ? e.id : 'new');
    setForm(e ? { language: e.language, scope: e.scope, account_id: e.account_id ? String(e.account_id) : '', title: e.title, body: e.body } : { language: lang, scope: 'both', account_id: '', title: '', body: '' });
  };
  const save = async () => {
    try {
      const payload = { language: form.language, scope: form.scope, account_id: form.account_id ? Number(form.account_id) : null, title: form.title, body: form.body };
      const r = editing === 'new' ? await api.createContext(payload) : await api.updateContext(editing as number, payload);
      setEntries(r.entries);
      setEditing(null);
    } catch (e) { onError((e as Error).message); }
  };
  const form_ = (
    <div className="card" style={{ marginBottom: 12 }}>
      <div className="inline-form">
        <label className="field" style={{ minWidth: 140 }}><span className="lbl">Language</span><select value={form.language} onChange={(e) => setForm({ ...form, language: e.target.value })}>{langs.map((k) => <option key={k} value={k}>{languages[k] ?? k}</option>)}</select></label>
        <label className="field" style={{ minWidth: 140 }}><span className="lbl">Applies to</span><select value={form.scope} onChange={(e) => setForm({ ...form, scope: e.target.value })}><option value="both">CS + affiliate</option><option value="cs">Customer service</option><option value="affiliate">Affiliates</option></select></label>
        <label className="field" style={{ minWidth: 180 }}><span className="lbl">Account</span><select value={form.account_id} onChange={(e) => setForm({ ...form, account_id: e.target.value })}><option value="">Every account</option>{accounts.map((a) => <option key={a.account_id} value={a.account_id}>{a.account_name}</option>)}</select></label>
        <label className="field" style={{ flex: 1, minWidth: 200 }}><span className="lbl">Title</span><input type="text" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="e.g. Delivery times DE" /></label>
      </div>
      <textarea rows={5} value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} placeholder="What Claude should know or how it should answer. Use [brand] for the brand name." style={{ width: '100%', marginTop: 8 }} />
      <div className="actions" style={{ marginTop: 8 }}><button className="primary" onClick={save} disabled={!form.title.trim() || !form.body.trim()}>Save</button><button onClick={() => setEditing(null)}>Cancel</button></div>
    </div>
  );
  return (
    <>
      <p className="hint">Guidance the reply model reads before answering: tone, policies, delivery windows, commission terms, FAQs. Entries marked "All languages" apply everywhere; language entries only when the conversation is in that language. Account-specific entries win over general ones.</p>
      <div className="toolbar">
        <div className="tabs" style={{ marginBottom: 0 }}>{langs.map((k) => <button key={k} className={`tab ${lang === k ? 'active' : ''}`} onClick={() => setLang(k)}>{languages[k] ?? k} <span className="sub">{entries.filter((e) => e.language === k).length}</span></button>)}</div>
        {isAdmin && editing === null && <button className="primary" onClick={() => startEdit(null)}>+ Entry</button>}
      </div>
      {editing === 'new' && form_}
      {visible.length === 0 ? <div className="empty">No entries for this language yet.</div> : visible.map((e) => (
        editing === e.id ? <div key={e.id}>{form_}</div> : (
          <div key={e.id} className={`card entry ${e.enabled ? '' : 'dim'}`} style={{ marginBottom: 10 }}>
            <div className="page-head" style={{ marginBottom: 6 }}>
              <div><b>{e.title}</b> <span className="badge muted">{languages[e.language] ?? e.language}</span> <span className="badge muted">{e.scope === 'both' ? 'CS + affiliate' : e.scope === 'cs' ? 'CS' : 'Affiliate'}</span> {e.account_name && <span className="badge accent">{e.account_name}</span>} {!e.enabled && <span className="badge crit">off</span>}</div>
              {isAdmin && <div className="actions"><button className="small" onClick={() => startEdit(e)}>Edit</button><button className="small" onClick={async () => { try { setEntries((await api.updateContext(e.id, { enabled: !e.enabled })).entries); } catch (x) { onError((x as Error).message); } }}>{e.enabled ? 'Disable' : 'Enable'}</button><button className="small danger" onClick={async () => { if (!window.confirm(`Delete "${e.title}"?`)) return; try { setEntries((await api.deleteContext(e.id)).entries); } catch (x) { onError((x as Error).message); } }}>×</button></div>}
            </div>
            <div style={{ whiteSpace: 'pre-wrap' }}>{e.body}</div>
            <div className="sub" style={{ marginTop: 6 }}>Updated {fmtRelative(e.updated_at)}</div>
          </div>
        )
      ))}
    </>
  );
}
