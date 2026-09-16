import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { BdEmailDraft, ContextEntry, ConversationDetail, InboxConversation, InboxData, OutreachData, OutreachExample } from '../../../sweep/types';
import { api, fmtRelative, useLiveUpdates } from '../api';
import { useIsAdmin } from '../session';

type Tab = 'inbox' | 'outreach' | 'switches' | 'library';
type Detail = ConversationDetail & { auto_reply_blocker?: string | null };

export default function InboxPage() {
  const [data, setData] = useState<(InboxData & { languages: Record<string, string> }) | null>(null);
  const [params, setParams] = useSearchParams();
  const [tab, setTab] = useState<Tab>((['inbox', 'outreach', 'switches', 'library'] as Tab[]).find((t) => t === params.get('tab')) ?? 'inbox');
  const [error, setError] = useState<string | null>(params.get('error'));
  const [notice, setNotice] = useState<string | null>(params.get('notice'));
  useEffect(() => { if (params.has('error') || params.has('notice')) { const n = new URLSearchParams(params); n.delete('error'); n.delete('notice'); setParams(n, { replace: true }); } }, [params, setParams]);
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
        {(['inbox', 'outreach', 'switches', 'library'] as Tab[]).map((t) => (
          <button key={t} className={`tab ${tab === t ? 'active' : ''}`} onClick={() => setTab(t)}>
            {t === 'inbox' ? `Inbox (${data.counts.needs_reply} need a reply)` : t === 'outreach' ? 'Outreach emails' : t === 'switches' ? 'Auto-reply per account' : 'Context library'}
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

      {tab === 'outreach' && <Outreach isAdmin={isAdmin} onError={setError} onNotice={setNotice} initialDraft={params.get('draft') ? Number(params.get('draft')) : null} />}
      {tab === 'library' && <Library accounts={data.accounts} languages={data.languages} isAdmin={isAdmin} onError={setError} />}
    </>
  );
}

const DRAFT_LANGS: Record<string, string> = { en: 'English', de: 'German', fr: 'French', it: 'Italian', es: 'Spanish' };

/** BD cold emails: drafted from the BD pipeline in Isaac's voice, edited here, then handed to Gmail to send from his account. */
function Outreach({ isAdmin, onError, onNotice, initialDraft }: { isAdmin: boolean; onError: (e: string | null) => void; onNotice: (n: string | null) => void; initialDraft: number | null }) {
  const [data, setData] = useState<OutreachData | null>(null);
  const [selected, setSelected] = useState<number | null>(initialDraft);
  const [edit, setEdit] = useState<{ subject: string; body: string; to_email: string } | null>(null);
  const [gen, setGen] = useState<{ language: string; style: 'short' | 'intro'; instructions: string }>({ language: 'en', style: 'short', instructions: '' });
  const [busy, setBusy] = useState<string | null>(null);
  const [showVoice, setShowVoice] = useState(false);
  const [only, setOnly] = useState<'open' | 'all'>('open');
  const [settings, setSettings] = useState<{ sender_name: string; sender_title: string; booking_url: string; pitch: string; sent_query: string } | null>(null);
  const [newExample, setNewExample] = useState<{ subject: string; body: string; kind: string } | null>(null);

  const load = useCallback(() => api.outreach().then((d) => { setData(d); setSettings((prev) => prev ?? { sender_name: d.settings.sender_name, sender_title: d.settings.sender_title, booking_url: d.settings.booking_url, pitch: d.settings.pitch, sent_query: d.settings.sent_query }); }).catch((e) => onError((e as Error).message)), [onError]);
  useEffect(() => { load(); }, [load]);
  useLiveUpdates((e) => { if (e.kind === 'bd' || e.kind === 'settings') load(); });

  const draft = data?.drafts.find((d) => d.id === selected) ?? null;
  useEffect(() => {
    if (!draft) { setEdit(null); return; }
    setEdit({ subject: draft.subject, body: draft.body, to_email: draft.to_email });
    setGen((g) => ({ ...g, language: draft.language, style: draft.style }));
  }, [draft?.id, draft?.updated_at]); // eslint-disable-line react-hooks/exhaustive-deps

  const run = async <T extends OutreachData,>(key: string, fn: () => Promise<T>, after?: (r: T) => void) => {
    setBusy(key);
    onError(null);
    try {
      const r = await fn();
      setData(r);
      after?.(r);
    } catch (e) { onError((e as Error).message); } finally { setBusy(null); }
  };
  const dirty = draft && edit && (edit.subject !== draft.subject || edit.body !== draft.body || edit.to_email !== draft.to_email);
  const saveIfDirty = async (): Promise<void> => {
    if (!draft || !edit || !dirty) return;
    const r = await api.updateDraft(draft.id, { subject: edit.subject, body: edit.body, to_email: edit.to_email });
    setData(r);
  };
  const openInGmail = async () => {
    if (!draft) return;
    setBusy('gmail');
    onError(null);
    try {
      await saveIfDirty();
      const r = await api.draftToGmail(draft.id);
      setData(r);
      const w = window.open(r.url, '_blank', 'noopener');
      if (!w) onNotice(`Pop-up blocked. Open the draft here: ${r.url}`);
      else onNotice(r.mode === 'gmail' ? `Saved to Gmail drafts (${r.settings.gmail_email}). Send it from there, then click "Mark as sent".` : 'Opened a prefilled Gmail compose window. Send it from there, then click "Mark as sent". Connect Gmail below to save real drafts instead.');
    } catch (e) { onError((e as Error).message); } finally { setBusy(null); }
  };

  if (!data) return <p>Loading…</p>;
  const s = data.settings;
  const statusBadge = (d: BdEmailDraft) => d.status === 'sent' ? <span className="badge good">Sent</span> : d.status === 'gmail' ? <span className="badge accent">In Gmail</span> : <span className="badge warn">Draft</span>;
  const list = data.drafts.filter((d) => only === 'all' || d.status !== 'sent');

  return (
    <>
      <p className="hint">Emails drafted from the BD pipeline ("Draft email" next to a decision maker). They are written in {s.sender_name.split(' ')[0]}'s voice from his earlier outreach and tailored to the shop's numbers. Review and edit here, then <b>Open in Gmail</b> puts the draft in {s.gmail_connected ? `the ${s.gmail_email} drafts folder` : 'a Gmail compose window'} so it goes out from his own account.</p>
      <div className="toolbar">
        <div className="actions">
          <span className={`badge ${s.gmail_connected ? 'good' : 'muted'}`}>{s.gmail_connected ? `Gmail: ${s.gmail_email}` : s.gmail_configured ? 'Gmail not connected' : 'Gmail: compose-link mode'}</span>
          <span className={`badge ${s.llm_configured ? 'good' : 'muted'}`}>{s.llm_configured ? 'Claude drafting' : 'Template drafting (no ANTHROPIC_API_KEY)'}</span>
          <select value={only} onChange={(e) => setOnly(e.target.value as 'open' | 'all')}><option value="open">Open drafts</option><option value="all">All incl. sent</option></select>
        </div>
        <button onClick={() => setShowVoice(!showVoice)}>{showVoice ? 'Hide voice & Gmail settings' : 'Voice & Gmail settings'}</button>
      </div>

      {showVoice && (
        <div className="card" style={{ marginBottom: 14 }}>
          <h3 style={{ marginTop: 0 }}>Gmail</h3>
          {s.gmail_connected ? (
            <p className="sub">Connected as <b>{s.gmail_email}</b>. Drafts are created in that account's Drafts folder and sent from there. {isAdmin && <button className="small" onClick={() => run('gd', api.gmailDisconnect)}>Disconnect</button>}</p>
          ) : s.gmail_configured ? (
            <p className="sub">Not connected. {isAdmin && <a className="button primary" href="/api/gmail/connect">Connect Gmail</a>} Until then "Open in Gmail" opens a prefilled compose window instead of saving a draft.</p>
          ) : (
            <p className="sub">Add <code>GOOGLE_CLIENT_ID</code> and <code>GOOGLE_CLIENT_SECRET</code> to .env (a Google Cloud OAuth client with redirect URI <code>{window.location.origin}/api/gmail/callback</code>) to save drafts straight into Gmail. Without it, "Open in Gmail" opens a prefilled compose window, which still sends from your own account.</p>
          )}

          <h3>Voice samples <span className="sub">({data.examples.filter((e) => e.enabled).length} in use)</span></h3>
          <p className="sub">Real emails {s.sender_name.split(' ')[0]} sent. The writer copies their tone and structure, not their dated details. {s.gmail_connected && isAdmin && <button className="small" onClick={() => run('pull', api.pullExamples, (r) => onNotice(`Read ${r.pulled} sent emails, ${r.added} new samples added.`))} disabled={busy === 'pull'}>{busy === 'pull' ? 'Reading Gmail…' : 'Pull recent sent outreach from Gmail'}</button>} {s.last_pull_at && <span>Last pull {fmtRelative(s.last_pull_at)}.</span>} {s.last_pull_error && <span className="crit">{s.last_pull_error}</span>}</p>
          {isAdmin && settings && (
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

          {isAdmin && settings && (
            <>
              <h3>Pitch block and sign-off</h3>
              <p className="sub">The only source of claims about Brightform the writer may use. Keep it current (awards, GMV, shop count).</p>
              <div className="inline-form">
                <label className="field" style={{ minWidth: 200 }}><span className="lbl">Sender</span><input type="text" value={settings.sender_name} onChange={(e) => setSettings({ ...settings, sender_name: e.target.value })} /></label>
                <label className="field" style={{ minWidth: 240 }}><span className="lbl">Title</span><input type="text" value={settings.sender_title} onChange={(e) => setSettings({ ...settings, sender_title: e.target.value })} /></label>
                <label className="field" style={{ flex: 1, minWidth: 260 }}><span className="lbl">Booking link</span><input type="text" value={settings.booking_url} onChange={(e) => setSettings({ ...settings, booking_url: e.target.value })} /></label>
              </div>
              <textarea rows={12} style={{ width: '100%', marginTop: 8, fontFamily: 'inherit' }} value={settings.pitch} onChange={(e) => setSettings({ ...settings, pitch: e.target.value })} />
              <div className="actions" style={{ marginTop: 8 }}><button className="primary" disabled={busy === 'set'} onClick={() => run('set', () => api.saveOutreachSettings(settings), () => onNotice('Outreach settings saved.'))}>Save pitch & sign-off</button></div>
            </>
          )}
        </div>
      )}

      <div className="inbox-split">
        <div className="inbox-list">
          {list.length === 0 ? <div className="empty">No drafts yet. Open a prospect in the BD pipeline and click "Draft email" next to a decision maker with an email address.</div> : list.map((d) => (
            <button key={d.id} className={`conv ${selected === d.id ? 'active' : ''}`} onClick={() => setSelected(d.id)}>
              <div className="page-head" style={{ marginBottom: 2 }}><b>{d.shop_name}</b> {statusBadge(d)}</div>
              <div className="sub">{d.to_name} · {d.to_email}</div>
              <div style={{ fontSize: 13.5 }}>{d.subject}</div>
              <div className="sub">{fmtRelative(d.updated_at)} · {d.generator === 'claude' ? 'Claude' : 'template'} · {d.style} · {DRAFT_LANGS[d.language] ?? d.language}</div>
            </button>
          ))}
        </div>
        <div className="detail card">
          {!draft || !edit ? <p className="sub">Pick a draft on the left.</p> : (
            <>
              <div className="page-head" style={{ marginBottom: 8 }}>
                <div><b>{draft.shop_name}</b> <span className="badge muted">{draft.market}</span> {statusBadge(draft)}</div>
                <div className="actions">
                  {draft.gmail_url && <a className="button" href={draft.gmail_url} target="_blank" rel="noreferrer">Open Gmail draft ↗</a>}
                  {isAdmin && <button className="small danger" onClick={() => window.confirm('Discard this draft?') && run('del', () => api.deleteDraft(draft.id), () => setSelected(null))}>Discard</button>}
                </div>
              </div>
              <div className="inline-form" style={{ marginBottom: 8 }}>
                <label className="field" style={{ minWidth: 200 }}><span className="lbl">To</span><input type="email" value={edit.to_email} disabled={!isAdmin} onChange={(e) => setEdit({ ...edit, to_email: e.target.value })} /></label>
                <label className="field" style={{ flex: 1, minWidth: 260 }}><span className="lbl">Subject</span><input type="text" value={edit.subject} disabled={!isAdmin} onChange={(e) => setEdit({ ...edit, subject: e.target.value })} /></label>
              </div>
              <textarea rows={18} style={{ width: '100%', fontFamily: 'inherit' }} value={edit.body} disabled={!isAdmin} onChange={(e) => setEdit({ ...edit, body: e.target.value })} />
              {isAdmin && (
                <>
                  <div className="actions" style={{ marginTop: 8 }}>
                    <button className="primary" disabled={busy !== null || draft.status === 'sent'} onClick={openInGmail}>{busy === 'gmail' ? 'Opening…' : s.gmail_connected ? 'Save to Gmail & open' : 'Open in Gmail'}</button>
                    <button disabled={!dirty || busy !== null} onClick={() => run('save', async () => { await saveIfDirty(); return api.outreach(); }, () => onNotice('Draft saved.'))}>Save edits</button>
                    {draft.status !== 'sent' && <button disabled={busy !== null} onClick={() => window.confirm(`Mark as sent to ${draft.to_email}? This ticks Gmail on the prospect and logs it in the history.`) && run('sent', () => api.markDraftSent(draft.id), () => onNotice('Logged as sent. Gmail is ticked on the prospect.'))}>Mark as sent</button>}
                  </div>
                  <div className="inline-form" style={{ marginTop: 12 }}>
                    <label className="field"><span className="lbl">Language</span><select value={gen.language} onChange={(e) => setGen({ ...gen, language: e.target.value })}>{Object.entries(DRAFT_LANGS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
                    <label className="field"><span className="lbl">Shape</span><select value={gen.style} onChange={(e) => setGen({ ...gen, style: e.target.value as 'short' | 'intro' })}><option value="short">Short note</option><option value="intro">Full introduction</option></select></label>
                    <label className="field" style={{ flex: 1, minWidth: 260 }}><span className="lbl">Steer it</span><input type="text" value={gen.instructions} placeholder="e.g. mention our live studio, keep it to 4 lines, reference their padel range" onChange={(e) => setGen({ ...gen, instructions: e.target.value })} /></label>
                    <button disabled={busy !== null} onClick={() => run('regen', () => api.regenerateDraft(draft.id, gen), () => onNotice('Redrafted.'))}>{busy === 'regen' ? 'Drafting…' : 'Redraft'}</button>
                  </div>
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
