import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { BdEmailDraft, OutreachData, OutreachExample } from '../../../sweep/types';
import { api, fmtRelative, useLiveUpdates } from '../api';
import { useIsAdmin } from '../session';

/** Growth > Outreach emails: BD cold emails drafted in Isaac's voice, reviewed here, then handed to Gmail. */
export default function OutreachPage() {
  const [params, setParams] = useSearchParams();
  const [error, setError] = useState<string | null>(params.get('error'));
  const [notice, setNotice] = useState<string | null>(params.get('notice'));
  const isAdmin = useIsAdmin();
  useEffect(() => { if (params.has('error') || params.has('notice')) { const n = new URLSearchParams(params); n.delete('error'); n.delete('notice'); setParams(n, { replace: true }); } }, [params, setParams]);
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Outreach emails</h1>
          <p className="hint" style={{ margin: 0 }}>Cold emails to BD prospects, written in Isaac's voice and sent from his Gmail. Start one from the <Link to="/bd">BD pipeline</Link>: open a prospect and click "Draft email" next to a decision maker with an email address.</p>
        </div>
      </div>
      {error && <div className="banner crit">{error}</div>}
      {notice && <div className="banner info">{notice}</div>}
      <Outreach isAdmin={isAdmin} onError={setError} onNotice={setNotice} initialDraft={params.get('draft') ? Number(params.get('draft')) : null} />
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
      <p className="hint">Drafts are written in {s.sender_name.split(' ')[0]}'s voice from his earlier outreach and tailored to the shop's numbers. Review and edit here, then <b>Open in Gmail</b> puts the draft in {s.gmail_connected ? `the ${s.gmail_email} drafts folder` : 'a Gmail compose window'} so it goes out from his own account.</p>
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

