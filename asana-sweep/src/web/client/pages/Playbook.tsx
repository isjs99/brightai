import { useCallback, useEffect, useMemo, useState } from 'react';
import type { PlaybookData, PlaybookItem, PlaybookKind, PlaybookSetupCell } from '../../../sweep/types';
import { api, fmtRelative, useLiveUpdates } from '../api';
import { useIsAdmin } from '../session';

const KIND_LABEL: Record<PlaybookKind, string> = { group: 'CRM group', automation: 'Automation', workflow: 'Workflow', email_campaign: 'Email campaign', list: 'List' };
const LANG: Record<string, string> = { '*': 'Any', en: 'English', de: 'German', fr: 'French', it: 'Italian', es: 'Spanish' };
const STATUS: Record<PlaybookSetupCell['status'], { label: string; cls: string; glyph: string }> = { set: { label: 'Set up', cls: 'good', glyph: '✓' }, missing: { label: 'Missing', cls: 'crit', glyph: '✗' }, unknown: { label: 'Unknown', cls: 'muted', glyph: '?' }, queued: { label: 'Queued', cls: 'warn', glyph: '…' }, error: { label: 'Error', cls: 'crit', glyph: '!' } };

/** Account management > Cruva playbook: the best-practice CRM setup per shop, what is in place, and bulk apply of the rest. */
export default function PlaybookPage() {
  const [data, setData] = useState<PlaybookData | null>(null);
  const [tab, setTab] = useState<'matrix' | 'library' | 'settings'>('matrix');
  const [lang, setLang] = useState('');
  const [account, setAccount] = useState('');
  const [selShops, setSelShops] = useState<Set<string>>(new Set());
  const [selKeys, setSelKeys] = useState<Set<string>>(new Set());
  const [pack, setPack] = useState<{ shop_id: string; shop_name: string; tool: string; payload: Record<string, unknown>; blockers: string[] }[] | null>(null);
  const [importFor, setImportFor] = useState<string | null>(null);
  const [importText, setImportText] = useState('');
  const [editItem, setEditItem] = useState<Partial<PlaybookItem> & { configText?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const isAdmin = useIsAdmin();
  const load = useCallback(() => api.playbook().then(setData).catch((e) => setError((e as Error).message)), []);
  useEffect(() => { load(); }, [load]);
  const connected = useLiveUpdates((e) => { if (e.kind === 'playbook') load(); });
  const run = async <T extends PlaybookData,>(key: string, fn: () => Promise<T>, after?: (r: T) => void) => {
    setBusy(key);
    setError(null);
    try { const r = await fn(); setData(r); after?.(r); } catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  };
  /** One column per distinct kind:key (language variants collapse into one column). */
  const columns = useMemo(() => {
    if (!data) return [];
    const seen = new Map<string, { kind: PlaybookKind; key: string; name: string; description: string | null; languages: string[] }>();
    for (const i of data.items.filter((x) => x.enabled)) {
      const k = `${i.kind}:${i.key}`;
      const cur = seen.get(k);
      if (cur) cur.languages.push(i.language); else seen.set(k, { kind: i.kind, key: i.key, name: i.name, description: i.description, languages: [i.language] });
    }
    const order: Record<string, number> = { group: 0, automation: 1, workflow: 2, email_campaign: 3, list: 4 };
    return [...seen.values()].sort((a, b) => order[a.kind] - order[b.kind] || a.name.localeCompare(b.name));
  }, [data]);
  if (!data) return <p>{error ?? 'Loading…'}</p>;
  const shops = data.shops.filter((s) => (!lang || s.language === lang) && (!account || String(s.account_id) === account));
  const cell = (shopId: string, kind: PlaybookKind, key: string) => data.cells.find((c) => c.shop_id === shopId && c.kind === kind && c.playbook_key === key) ?? null;
  const toggle = <T,>(set: Set<T>, v: T) => { const n = new Set(set); if (n.has(v)) n.delete(v); else n.add(v); return n; };
  const coverage = (shopId: string) => { const cells = columns.map((c) => cell(shopId, c.kind, c.key)); const set = cells.filter((c) => c?.status === 'set').length; const known = cells.filter((c) => c && c.status !== 'unknown').length; return { set, known, total: columns.length }; };
  const apply = () => {
    if (!selShops.size || !selKeys.size) { setError('Tick at least one shop and one column first.'); return; }
    run('apply', () => api.playbookApply({ shop_ids: [...selShops], keys: [...selKeys], language: lang || null }), (r) => {
      setPack(r.pack.length ? r.pack : null);
      setNotice(`${r.created} created via the Cruva API, ${r.queued} queued for the MCP, ${r.blocked} blocked${r.errors.length ? `, ${r.errors.length} error(s): ${r.errors.slice(0, 2).join(' · ')}` : ''}.`);
    });
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Cruva playbook</h1>
          <p className="hint" style={{ margin: 0 }}>Brightform's best-practice Cruva setup (CRM groups, DM automations, workflows, creator emails) by language, checked against every shop. Green is in place, red is missing; tick shops and columns and apply the rest in bulk.</p>
        </div>
        <div className="actions">
          {connected && <span className="badge muted">Live</span>}
          <span className={`badge ${data.cruva_configured ? 'good' : 'muted'}`} title={data.cruva_configured ? 'CRUVA_API_KEY set: remote state and apply go over the API' : 'No CRUVA_API_KEY: paste the Cruva MCP listing per shop, apply produces a pack for the MCP'}>{data.cruva_configured ? 'Cruva API' : 'Cruva via MCP paste'}</span>
          {isAdmin && data.cruva_configured && <button disabled={busy === 'check'} onClick={() => run('check', () => api.playbookCheck(), (r) => setNotice(`Checked ${r.shops} shop(s)${r.errors.length ? `, errors: ${r.errors.slice(0, 2).join(' · ')}` : ''}.`))}>{busy === 'check' ? 'Checking…' : 'Check all shops'}</button>}
        </div>
      </div>
      {error && <div className="banner crit">{error}</div>}
      {notice && <div className="banner info">{notice}</div>}
      {data.last_error && <div className="banner crit">Last check: {data.last_error}</div>}

      <div className="tabs">
        {(['matrix', 'library', 'settings'] as const).map((t) => <button key={t} className={`tab ${tab === t ? 'active' : ''}`} onClick={() => setTab(t)}>{t === 'matrix' ? 'Set up vs missing' : t === 'library' ? `Library (${data.items.length})` : 'Settings'}</button>)}
      </div>

      {tab === 'matrix' && (
        <>
          <div className="toolbar">
            <select value={lang} onChange={(e) => setLang(e.target.value)}><option value="">All languages</option>{['en', 'de', 'fr', 'it', 'es'].map((l) => <option key={l} value={l}>{LANG[l]}</option>)}</select>
            <select value={account} onChange={(e) => setAccount(e.target.value)}><option value="">All accounts</option>{[...new Map(data.shops.map((s) => [s.account_id, s.account_name])).entries()].map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select>
            <button className="small" onClick={() => setSelShops(selShops.size === shops.length ? new Set() : new Set(shops.map((s) => s.shop_id)))}>{selShops.size === shops.length && shops.length ? 'Untick shops' : 'Tick all shops'}</button>
            <button className="small" onClick={() => setSelKeys(selKeys.size === columns.length ? new Set() : new Set(columns.map((c) => `${c.kind}:${c.key}`)))}>{selKeys.size === columns.length && columns.length ? 'Untick columns' : 'Tick all columns'}</button>
            {isAdmin && <button className="primary" disabled={busy === 'apply' || !selShops.size || !selKeys.size} onClick={apply} title="Create the ticked items on the ticked shops where they are missing, in each shop's language">{busy === 'apply' ? 'Applying…' : `Apply to ${selShops.size} shop(s)`}</button>}
            <span className="sub">{shops.length} shop(s) · {columns.length} playbook items</span>
          </div>
          {shops.length === 0 ? <div className="empty">No Cruva shops linked to accounts yet (Accounts &gt; shops).</div> : (
            <div className="grid-wrap"><table className="heat"><thead><tr>
              <th></th><th>Shop</th><th>Lang</th><th>Coverage</th>
              {columns.map((c) => <th key={`${c.kind}:${c.key}`} className="day" title={`${KIND_LABEL[c.kind]}: ${c.description ?? ''}`}><label style={{ cursor: 'pointer' }}><input type="checkbox" checked={selKeys.has(`${c.kind}:${c.key}`)} onChange={() => setSelKeys(toggle(selKeys, `${c.kind}:${c.key}`))} /> {c.name}</label></th>)}
              <th></th>
            </tr></thead><tbody>
              {shops.map((s) => {
                const cov = coverage(s.shop_id);
                return (
                  <tr key={s.shop_id}>
                    <td><input type="checkbox" checked={selShops.has(s.shop_id)} onChange={() => setSelShops(toggle(selShops, s.shop_id))} /></td>
                    <td><b>{s.shop_name}</b><div className="sub">{s.account_name}{s.checked_at ? ` · checked ${fmtRelative(s.checked_at)}` : ' · not checked'}</div></td>
                    <td>{isAdmin ? <select value={s.language} onChange={(e) => run(`l${s.shop_id}`, () => api.playbookShop(s.shop_id, { language: e.target.value }))}>{['en', 'de', 'fr', 'it', 'es'].map((l) => <option key={l} value={l}>{l}</option>)}</select> : s.language}</td>
                    <td><span className={`badge ${cov.known === 0 ? 'muted' : cov.set === cov.total ? 'good' : cov.set >= cov.total / 2 ? 'warn' : 'crit'}`}>{cov.known === 0 ? 'unknown' : `${cov.set}/${cov.total}`}</span></td>
                    {columns.map((c) => {
                      const st = cell(s.shop_id, c.kind, c.key);
                      const k = st?.status ?? 'unknown';
                      return <td key={c.key} className="cell" title={`${c.name}: ${STATUS[k].label}${st?.remote_name ? ` (${st.remote_name})` : ''}${st?.note ? ` · ${st.note}` : ''}`}><button className={`small badge ${STATUS[k].cls}`} style={{ minWidth: 28, cursor: isAdmin ? 'pointer' : 'default' }} onClick={() => { if (!isAdmin) return; const next: PlaybookSetupCell['status'] = k === 'set' ? 'missing' : 'set'; run(`c${s.shop_id}${c.key}`, () => api.playbookCell({ shop_id: s.shop_id, kind: c.kind, key: c.key, status: next, note: next === 'set' ? 'marked by hand' : null })); }}>{STATUS[k].glyph}</button></td>;
                    })}
                    <td>{isAdmin && <button className="small" onClick={() => { setImportFor(importFor === s.shop_id ? null : s.shop_id); setImportText(''); }} title="Paste the output of the Cruva MCP list_automations / list_groups / list_workflows / list_email_campaigns for this shop">{importFor === s.shop_id ? 'Close' : 'Paste listing'}</button>}</td>
                  </tr>
                );
              })}
            </tbody></table></div>
          )}
          {importFor && (
            <div className="card" style={{ marginTop: 12 }}>
              <h3 style={{ marginTop: 0 }}>Remote state for {data.shops.find((s) => s.shop_id === importFor)?.shop_name}</h3>
              <p className="sub">In Claude with the Cruva MCP, run <code>list_automations</code>, <code>list_groups</code>, <code>list_workflows</code> and <code>list_email_campaigns</code> for shop id <code>{importFor}</code> and paste the outputs below (all together is fine). Names are matched against the playbook.</p>
              <textarea rows={8} style={{ width: '100%', fontFamily: 'monospace' }} value={importText} onChange={(e) => setImportText(e.target.value)} placeholder={'Automations (total: 3):\n\n- Sample sent (ID: 699dd0cc...) | Status: active | Message: dm | Audience: groups | ...\n- Content not posted (ID: ...) | Status: active ...\n\nGroups (total: 2):\n\n- Sample sent (ID: ...) | Creators: 120'} />
              <div className="actions" style={{ marginTop: 8 }}><button className="primary" disabled={!importText.trim() || busy === 'imp'} onClick={() => run('imp', () => api.playbookImport(importFor, importText), (r) => { setNotice(`${r.imported} item(s) imported and matched.`); setImportFor(null); })}>{busy === 'imp' ? 'Importing…' : 'Import and match'}</button></div>
            </div>
          )}
          {pack && (
            <div className="card" style={{ marginTop: 12 }}>
              <div className="page-head" style={{ marginBottom: 6 }}>
                <h3 style={{ margin: 0 }}>Apply pack ({pack.length})</h3>
                <div className="actions"><button className="small" onClick={() => navigator.clipboard.writeText(JSON.stringify(pack.map((p) => ({ tool: p.tool, args: p.payload })), null, 2)).then(() => setNotice('Pack copied.'))}>Copy JSON</button><button className="small" onClick={() => setPack(null)}>Close</button></div>
              </div>
              <p className="sub">{data.cruva_configured ? 'These could not be created over the API (blocked or errored).' : 'No Cruva API key, so nothing was created directly.'} Paste this into Claude with the Cruva MCP: each entry is a tool call with its arguments. Items with blockers need the group, list or sender email first. Afterwards paste the listing back to turn the cells green.</p>
              <div className="grid-wrap"><table><thead><tr><th>Shop</th><th>Tool</th><th>Title</th><th>Blockers</th></tr></thead><tbody>
                {pack.map((p, i) => <tr key={i}><td>{p.shop_name}</td><td><code>{p.tool}</code></td><td>{String(p.payload.title ?? p.payload.name ?? '')}</td><td className="sub">{p.blockers.join('; ') || 'ready'}</td></tr>)}
              </tbody></table></div>
              <pre style={{ maxHeight: 260, overflow: 'auto', fontSize: 12 }}>{JSON.stringify(pack.map((p) => ({ tool: p.tool, args: p.payload })), null, 2)}</pre>
            </div>
          )}
        </>
      )}

      {tab === 'library' && (
        <>
          <div className="toolbar">
            <select value={lang} onChange={(e) => setLang(e.target.value)}><option value="">All languages</option>{data.languages.map((l) => <option key={l} value={l}>{LANG[l] ?? l}</option>)}</select>
            {isAdmin && <button className="primary" onClick={() => setEditItem({ kind: 'automation', key: '', language: 'en', name: '', description: '', configText: '{\n  "message_type": "dm",\n  "outreach_audience": "groups",\n  "group_key": "existing_creators",\n  "dm_messages": [{ "type": "message", "content": "Hey [affiliate_name], ..." }]\n}' })}>+ Item</button>}
            <span className="sub">[brand] becomes the shop's brand when applied; [affiliate_name] is Cruva's placeholder.</span>
          </div>
          {editItem && isAdmin && (
            <div className="card" style={{ marginBottom: 12 }}>
              <div className="inline-form">
                <label className="field" style={{ minWidth: 140 }}><span className="lbl">Kind</span><select value={editItem.kind} disabled={Boolean(editItem.id)} onChange={(e) => setEditItem({ ...editItem, kind: e.target.value as PlaybookKind })}>{(Object.keys(KIND_LABEL) as PlaybookKind[]).map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}</select></label>
                <label className="field" style={{ minWidth: 160 }}><span className="lbl">Key</span><input type="text" value={editItem.key ?? ''} disabled={Boolean(editItem.id)} onChange={(e) => setEditItem({ ...editItem, key: e.target.value })} placeholder="sample_sent" /></label>
                <label className="field" style={{ minWidth: 110 }}><span className="lbl">Language</span><select value={editItem.language ?? '*'} onChange={(e) => setEditItem({ ...editItem, language: e.target.value })}>{Object.entries(LANG).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
                <label className="field" style={{ flex: 1, minWidth: 200 }}><span className="lbl">Name (matched against Cruva names)</span><input type="text" value={editItem.name ?? ''} onChange={(e) => setEditItem({ ...editItem, name: e.target.value })} /></label>
                <label className="field" style={{ flex: 1, minWidth: 200 }}><span className="lbl">Description</span><input type="text" value={editItem.description ?? ''} onChange={(e) => setEditItem({ ...editItem, description: e.target.value })} /></label>
              </div>
              <label className="field"><span className="lbl">Config (JSON, the create payload)</span><textarea rows={10} style={{ width: '100%', fontFamily: 'monospace' }} value={editItem.configText ?? ''} onChange={(e) => setEditItem({ ...editItem, configText: e.target.value })} /></label>
              <div className="actions" style={{ marginTop: 8 }}>
                <button className="primary" disabled={busy === 'item'} onClick={() => run('item', () => editItem.id ? api.playbookItemUpdate(editItem.id, { name: editItem.name, description: editItem.description ?? null, language: editItem.language, config: editItem.configText }) : api.playbookItemCreate({ kind: editItem.kind as PlaybookKind, key: editItem.key ?? '', language: editItem.language ?? '*', name: editItem.name ?? '', description: editItem.description ?? undefined, config: editItem.configText ?? '{}' }), () => { setEditItem(null); setNotice('Saved.'); })}>Save</button>
                <button onClick={() => setEditItem(null)}>Cancel</button>
              </div>
            </div>
          )}
          <div className="grid-wrap"><table><thead><tr><th>On</th><th>Kind</th><th>Name</th><th>Lang</th><th>What it is</th><th></th></tr></thead><tbody>
            {data.items.filter((i) => !lang || i.language === lang || i.language === '*').map((i) => (
              <tr key={i.id} className={i.enabled ? '' : 'dim'}>
                <td>{isAdmin ? <input type="checkbox" checked={i.enabled} onChange={(e) => run(`e${i.id}`, () => api.playbookItemUpdate(i.id, { enabled: e.target.checked }))} /> : i.enabled ? 'on' : 'off'}</td>
                <td><span className="badge muted">{KIND_LABEL[i.kind]}</span></td>
                <td><b>{i.name}</b><div className="sub">{i.key}</div></td>
                <td>{LANG[i.language] ?? i.language}</td>
                <td className="sub" style={{ maxWidth: 420 }}>{i.description}{typeof (i.config as { dm_messages?: { content?: string }[] }).dm_messages?.[0]?.content === 'string' && <details><summary style={{ cursor: 'pointer' }}>Message</summary><pre style={{ whiteSpace: 'pre-wrap', fontSize: 12 }}>{(i.config as { dm_messages: { content: string }[] }).dm_messages[0].content}</pre></details>}</td>
                <td>{isAdmin && <span className="actions"><button className="small" onClick={() => setEditItem({ ...i, configText: JSON.stringify(i.config, null, 2) })}>Edit</button><button className="small danger" onClick={() => window.confirm(`Delete "${i.name}" (${LANG[i.language] ?? i.language})?`) && run(`d${i.id}`, () => api.playbookItemDelete(i.id))}>Delete</button></span>}</td>
              </tr>
            ))}
          </tbody></table></div>
        </>
      )}

      {tab === 'settings' && (
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Cruva API</h3>
          <p className="sub">With <code>CRUVA_API_KEY</code> set, "Check all shops" reads each shop's automations, groups, workflows and email campaigns and "Apply" creates the missing ones. Cruva's public REST paths for these objects were not documented when this was built, so they are configurable here (JSON, keys automation / group / workflow / email_campaign / list). Without the API, the page works from pasted MCP listings and produces an apply pack for the Cruva MCP.</p>
          <label className="field"><span className="lbl">Endpoint paths</span><textarea rows={4} style={{ width: '100%', fontFamily: 'monospace' }} defaultValue={JSON.stringify(data.endpoints, null, 2)} disabled={!isAdmin} onBlur={(e) => isAdmin && run('ep', () => api.playbookSettings({ endpoints: e.target.value }), () => setNotice('Endpoints saved.'))} /></label>
        </div>
      )}
    </>
  );
}
