import { useEffect, useState } from 'react';
import type { ContextEntry } from '../../../sweep/types';
import { api, fmtRelative } from '../api';

/** The context library: guidance the reply model reads before answering, per language, channel and account. */
export function Library({ accounts, languages, isAdmin, onError }: { accounts: { account_id: number; account_name: string }[]; languages: Record<string, string>; isAdmin: boolean; onError: (e: string | null) => void }) {
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
