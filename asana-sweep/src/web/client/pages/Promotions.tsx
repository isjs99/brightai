import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { Account, Promotion, PromotionInput, TargetStatus, TtsStatus } from '../../../sweep/types';
import { api, fmtDate, fmtRelative } from '../api';
import { useIsAdmin } from '../session';

const EU = ['DE', 'FR', 'IT', 'ES', 'NL', 'BE', 'IE', 'AT', 'PL', 'UK'];
const marketsOf = (m: string | null) => (m ? [...new Set(m.toUpperCase().split(/[\/,\s]+/).filter((x) => /^[A-Z]{2}$/.test(x)))] : []);

const TYPE_LABEL: Record<string, string> = { DIRECT_DISCOUNT: 'Percentage off', FIXED_PRICE: 'Fixed price', FLASHSALE: 'Flash sale', SHIPPING_DISCOUNT: 'Shipping discount' };

function TargetPill({ status }: { status: TargetStatus }) {
  const map: Record<TargetStatus, [string, string]> = {
    planned: ['muted', 'Planned'],
    pushed: ['accent', 'Scheduled on TikTok'],
    live: ['good', 'Live'],
    ended: ['muted', 'Ended'],
    deactivated: ['warn', 'Deactivated'],
    error: ['crit', 'Error'],
    unlinked: ['warn', 'No shop linked'],
  };
  const [cls, label] = map[status] ?? ['muted', status];
  return <span className={`badge ${cls}`}>{label}</span>;
}

function toLocalInput(iso: string) {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const emptyForm = (): PromotionInput => {
  const start = new Date(Date.now() + 3600000);
  const end = new Date(Date.now() + 8 * 86400000);
  return { name: '', activity_type: 'DIRECT_DISCOUNT', product_level: 'SHOP', discount_type: 'PERCENTAGE_OFF', discount_value: 10, begin_at: start.toISOString(), end_at: end.toISOString(), participation: 'BUYER_NO_LIMIT', products: {}, notes: '', targets: [] };
};

function PromotionForm({ initial, accounts, tts, onSave, onCancel }: { initial: PromotionInput; accounts: Account[]; tts: TtsStatus; onSave: (p: PromotionInput) => Promise<void>; onCancel: () => void }) {
  const [form, setForm] = useState<PromotionInput>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scope, setScope] = useState<'all' | 'pick'>('all');
  const [pickedMarkets, setPickedMarkets] = useState<string[]>(EU);
  const [pickedAccounts, setPickedAccounts] = useState<number[]>(initial.targets.length ? [...new Set(initial.targets.map((t) => t.account_id))] : []);
  const [products, setProducts] = useState<Record<string, { id: string; title: string }[]>>({});

  const set = <K extends keyof PromotionInput>(k: K, v: PromotionInput[K]) => setForm((f) => ({ ...f, [k]: v }));

  // Targets = picked accounts × (their active markets, optionally narrowed to the picked countries).
  useEffect(() => {
    const targets: { account_id: number; market: string }[] = [];
    for (const id of pickedAccounts) {
      const a = accounts.find((x) => x.id === id);
      if (!a) continue;
      for (const m of marketsOf(a.markets)) if (scope === 'all' || pickedMarkets.includes(m)) targets.push({ account_id: id, market: m });
    }
    setForm((f) => ({ ...f, targets }));
  }, [pickedAccounts, pickedMarkets, scope, accounts]);

  const shopsFor = (t: { account_id: number; market: string }) => tts.shops.filter((s) => s.account_id === t.account_id && s.market === t.market);
  const loadProducts = async (shopId: string) => {
    try {
      const r = await api.ttsShopProducts(shopId);
      setProducts((p) => ({ ...p, [shopId]: r.products.map((x) => ({ id: x.id, title: x.title })) }));
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onSave(form);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const needsProducts = form.product_level !== 'SHOP' && form.activity_type !== 'SHIPPING_DISCOUNT';

  return (
    <form className="card" onSubmit={submit} style={{ marginBottom: 18 }}>
      <div className="grid">
        <label className="field"><span className="lbl">Name</span><input type="text" value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="Black Friday 15% off" required /><span className="help">The TikTok activity title becomes "name + market", max 50 characters.</span></label>
        <label className="field"><span className="lbl">Type</span>
          <select value={form.activity_type} onChange={(e) => set('activity_type', e.target.value as PromotionInput['activity_type'])}>
            {Object.entries(TYPE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </label>
        <label className="field"><span className="lbl">{form.activity_type === 'FIXED_PRICE' || form.activity_type === 'FLASHSALE' ? 'Deal price (per product)' : 'Discount'}</span>
          <div style={{ display: 'flex', gap: 6 }}>
            <input type="number" min={0} step="0.01" value={form.discount_value ?? ''} onChange={(e) => set('discount_value', e.target.value === '' ? null : Number(e.target.value))} />
            {form.activity_type !== 'FIXED_PRICE' && form.activity_type !== 'FLASHSALE' && (
              <select value={form.discount_type} onChange={(e) => set('discount_type', e.target.value as PromotionInput['discount_type'])} style={{ width: 130 }}>
                <option value="PERCENTAGE_OFF">% off</option>
                {form.activity_type === 'SHIPPING_DISCOUNT' && <option value="AMOUNT_OFF">amount off</option>}
              </select>
            )}
          </div>
        </label>
        <label className="field"><span className="lbl">Applies to</span>
          <select value={form.product_level} onChange={(e) => set('product_level', e.target.value as PromotionInput['product_level'])} disabled={form.activity_type === 'SHIPPING_DISCOUNT'}>
            <option value="SHOP">Whole shop</option>
            <option value="PRODUCT">Selected products</option>
          </select>
        </label>
        <label className="field"><span className="lbl">Start</span><input type="datetime-local" value={toLocalInput(form.begin_at)} onChange={(e) => set('begin_at', new Date(e.target.value).toISOString())} /></label>
        <label className="field"><span className="lbl">End</span><input type="datetime-local" value={toLocalInput(form.end_at)} onChange={(e) => set('end_at', new Date(e.target.value).toISOString())} /></label>
        <label className="field"><span className="lbl">Per buyer</span>
          <select value={form.participation} onChange={(e) => set('participation', e.target.value as PromotionInput['participation'])}>
            <option value="BUYER_NO_LIMIT">No limit</option>
            <option value="BUYER_LIMIT_ONLY_ONE">Once per buyer</option>
          </select>
        </label>
        <label className="field"><span className="lbl">Notes</span><input type="text" value={form.notes ?? ''} onChange={(e) => set('notes', e.target.value)} /></label>
      </div>

      <h2>Where it runs</h2>
      <div className="grid">
        <div className="field">
          <span className="lbl">Accounts</span>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 14px' }}>
            {accounts.filter((a) => a.enabled && marketsOf(a.markets).length).map((a) => (
              <label key={a.id} className="toggle">
                <input type="checkbox" checked={pickedAccounts.includes(a.id)} onChange={(e) => setPickedAccounts(e.target.checked ? [...pickedAccounts, a.id] : pickedAccounts.filter((x) => x !== a.id))} />
                {a.name} <span className="sub">{marketsOf(a.markets).join('/')}</span>
              </label>
            ))}
          </div>
          <span className="help"><a href="#" onClick={(e) => { e.preventDefault(); setPickedAccounts(accounts.filter((a) => a.enabled && marketsOf(a.markets).length).map((a) => a.id)); }}>all</a> · <a href="#" onClick={(e) => { e.preventDefault(); setPickedAccounts([]); }}>none</a></span>
        </div>
        <div className="field">
          <span className="lbl">Countries</span>
          <label className="toggle"><input type="radio" checked={scope === 'all'} onChange={() => setScope('all')} /> Every market each account is active in</label>
          <label className="toggle"><input type="radio" checked={scope === 'pick'} onChange={() => setScope('pick')} /> Only these countries</label>
          {scope === 'pick' && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 12px', marginTop: 4 }}>
              {EU.map((m) => (
                <label key={m} className="toggle"><input type="checkbox" checked={pickedMarkets.includes(m)} onChange={(e) => setPickedMarkets(e.target.checked ? [...pickedMarkets, m] : pickedMarkets.filter((x) => x !== m))} />{m}</label>
              ))}
            </div>
          )}
          <span className="help">{form.targets.length} shop{form.targets.length === 1 ? '' : 's'} will get this promotion.</span>
        </div>
      </div>

      {needsProducts && form.targets.length > 0 && (
        <>
          <h2>Products per shop</h2>
          <p className="hint">Product ids come from each authorised TikTok shop. Shops without an authorisation cannot be pushed yet.</p>
          {form.targets.map((t) => {
            const shops = shopsFor(t);
            const a = accounts.find((x) => x.id === t.account_id);
            if (!shops.length) return <div key={`${t.account_id}-${t.market}`} className="sub">{a?.name} {t.market}: no authorised shop linked.</div>;
            return shops.map((s) => (
              <div key={s.id} className="card" style={{ marginBottom: 8 }}>
                <b>{a?.name} {t.market}</b> <span className="sub">· {s.name}</span>{' '}
                {!products[s.id] ? <button type="button" className="small" onClick={() => loadProducts(s.id)}>Load products</button> : (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 12px', marginTop: 6 }}>
                    {products[s.id].map((p) => (
                      <label key={p.id} className="toggle sub">
                        <input type="checkbox" checked={(form.products[s.id] ?? []).includes(p.id)} onChange={(e) => {
                          const cur = form.products[s.id] ?? [];
                          set('products', { ...form.products, [s.id]: e.target.checked ? [...cur, p.id] : cur.filter((x) => x !== p.id) });
                        }} />
                        {p.title}
                      </label>
                    ))}
                  </div>
                )}
              </div>
            ));
          })}
        </>
      )}

      {error && <p className="error">{error}</p>}
      <div className="form-foot">
        <button className="primary" disabled={busy}>{busy ? 'Saving…' : 'Save promotion'}</button>
        <button type="button" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

function ConnectionPanel({ tts, accounts, onChange }: { tts: TtsStatus; accounts: Account[]; onChange: (s: TtsStatus) => void }) {
  const [serviceId, setServiceId] = useState(tts.service_id);
  const [error, setError] = useState<string | null>(null);
  const [test, setTest] = useState<{ id: string; busy: boolean; result: Awaited<ReturnType<typeof api.ttsShopAnalytics>> | null; error: string | null } | null>(null);
  const isAdmin = useIsAdmin();
  const testAnalytics = async (id: string) => {
    setTest({ id, busy: true, result: null, error: null });
    try { setTest({ id, busy: false, result: await api.ttsShopAnalytics(id, 7), error: null }); } catch (e) { setTest({ id, busy: false, result: null, error: (e as Error).message }); }
  };
  const save = async () => { try { onChange(await api.saveTtsSettings(serviceId)); } catch (e) { setError((e as Error).message); } };
  return (
    <div className="card" style={{ marginBottom: 18 }}>
      <h2 style={{ marginTop: 0 }}>TikTok Shop connection</h2>
      {!tts.configured ? (
        <div className="banner warn"><b>Partner Center app not configured.</b> Set <code>TTS_APP_KEY</code> and <code>TTS_APP_SECRET</code> in <code>.env</code> (Partner Center › Apps), set the app's redirect URL to <code>{tts.callback_url}</code>, restart, then authorise each shop below.</div>
      ) : (
        <p className="hint">App configured. Each seller authorises the app once via the link below; every shop under that seller lands here. Redirect URL must be <code>{tts.callback_url}</code>.</p>
      )}
      {isAdmin && (
        <div className="inline-form" style={{ marginBottom: 10 }}>
          <label className="field" style={{ minWidth: 280 }}><span className="lbl">Service ID (Partner Center › Apps › Service)</span><input type="text" value={serviceId} onChange={(e) => setServiceId(e.target.value)} placeholder="e.g. 7xxxxxxxxxxxxxxxxxx" /></label>
          <button onClick={save}>Save</button>
          {tts.authorize_url && <a className="btn" href={tts.authorize_url} target="_blank" rel="noreferrer">Authorise a shop ↗</a>}
        </div>
      )}
      {error && <p className="error">{error}</p>}
      {tts.shops.length === 0 ? <p className="sub">No shops authorised yet.</p> : (
        <table>
          <thead><tr><th>TikTok shop</th><th>Region</th><th>Linked account</th><th>Market</th><th>Token</th><th></th></tr></thead>
          <tbody>
            {tts.shops.map((s) => (
              <tr key={s.id}>
                <td><b>{s.name}</b><div className="sub mono">{s.id}</div></td>
                <td>{s.region}</td>
                <td>
                  {isAdmin ? (
                    <select value={s.account_id ?? ''} onChange={async (e) => onChange(await api.linkTtsShop(s.id, e.target.value ? Number(e.target.value) : null, s.market))} style={{ width: 'auto' }}>
                      <option value="">not linked</option>
                      {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                    </select>
                  ) : accounts.find((a) => a.id === s.account_id)?.name ?? <span className="sub">not linked</span>}
                </td>
                <td>
                  {isAdmin ? (
                    <select value={s.market ?? ''} onChange={async (e) => onChange(await api.linkTtsShop(s.id, s.account_id, e.target.value || null))} style={{ width: 'auto' }}>
                      <option value="">–</option>
                      {EU.map((m) => <option key={m}>{m}</option>)}
                    </select>
                  ) : s.market}
                </td>
                <td>{s.token_ok ? <span className="badge good">ok</span> : <span className="badge crit">expired, re-authorise</span>}<div className="sub">since {fmtDate(s.authorized_at)}</div></td>
                <td><div className="actions"><button className="small" disabled={test?.busy} onClick={() => testAnalytics(s.id)} title="Call the Analytics API for the last 7 days">{test?.id === s.id && test.busy ? 'Calling…' : 'Test analytics'}</button>{isAdmin && <button className="small danger" onClick={async () => { if (window.confirm(`Remove ${s.name}?`)) onChange(await api.removeTtsShop(s.id)); }}>Remove</button>}</div></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {test && !test.busy && (
        <div className={`banner ${test.error ? 'crit' : 'good'}`} style={{ marginTop: 12 }}>
          {test.error ? <><b>Analytics call failed.</b> {test.error}</> : test.result && (
            <>
              <b>{test.result.shop.name}</b> · last 7 days ({test.result.start} to {test.result.end}, {test.result.days} day(s) of data{test.result.latest_available_date ? `, data ready up to ${test.result.latest_available_date}` : ''}):{' '}
              GMV <b>{test.result.gmv.toLocaleString('en-GB')} {test.result.currency}</b>{test.result.orders ? <> · {test.result.orders} orders</> : null}{test.result.units ? <> · {test.result.units} units</> : null}
              <details style={{ marginTop: 6 }}><summary className="sub">Last day, every field</summary>
                <table style={{ marginTop: 6 }}><tbody>{Object.entries(test.result.last_interval).map(([k, v]) => <tr key={k}><td className="mono sub">{k}</td><td>{v}</td></tr>)}</tbody></table>
              </details>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export default function PromotionsPage() {
  const [promotions, setPromotions] = useState<Promotion[] | null>(null);
  const [tts, setTts] = useState<TtsStatus | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [editing, setEditing] = useState<{ id: number | null; data: PromotionInput } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [showConn, setShowConn] = useState(false);
  const [params] = useSearchParams();
  const isAdmin = useIsAdmin();

  const load = useCallback(() => {
    api.listPromotions().then((r) => { setPromotions(r.promotions); setTts(r.tts); }).catch((e) => setError((e as Error).message));
    api.listAccounts().then((r) => setAccounts(r.accounts.map((x) => x.account))).catch(() => undefined);
  }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (params.get('authorised')) setNotice(`Authorised ${params.get('authorised')} shop(s). Link each one to an account and market below.`); }, [params]);

  const save = async (p: PromotionInput) => {
    if (editing?.id) await api.updatePromotion(editing.id, p);
    else await api.createPromotion(p);
    setEditing(null);
    load();
  };

  const act = async (p: Promotion, what: 'push' | 'deactivate' | 'sync' | 'delete') => {
    if (what === 'push' && !window.confirm(`Push "${p.name}" to ${p.targets.length} shop(s) on TikTok now?`)) return;
    if (what === 'deactivate' && !window.confirm(`Deactivate "${p.name}" on every shop where it is live?`)) return;
    if (what === 'delete' && !window.confirm(`Delete "${p.name}" from the dashboard? Live activities on TikTok are not touched.`)) return;
    setBusy(p.id);
    setError(null);
    try {
      if (what === 'push') { const r = await api.pushPromotion(p.id); const errs = r.promotion.targets.filter((t) => t.status === 'error' || t.status === 'unlinked'); setNotice(`Pushed. ${r.promotion.targets.filter((t) => t.status === 'pushed' || t.status === 'live').length} scheduled${errs.length ? `, ${errs.length} could not be pushed (see targets).` : '.'}`); }
      else if (what === 'deactivate') await api.deactivatePromotion(p.id);
      else if (what === 'sync') await api.syncPromotion(p.id);
      else await api.deletePromotion(p.id);
      load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const toInput = (p: Promotion): PromotionInput => ({ name: p.name, activity_type: p.activity_type, product_level: p.product_level, discount_type: p.discount_type, discount_value: p.discount_value, begin_at: p.begin_at, end_at: p.end_at, participation: p.participation, products: p.products, notes: p.notes, targets: p.targets.map((t) => ({ account_id: t.account_id, market: t.market })) });

  const summary = (p: Promotion) => {
    const counts = p.targets.reduce<Record<string, number>>((m, t) => ({ ...m, [t.status]: (m[t.status] ?? 0) + 1 }), {});
    return Object.entries(counts).map(([s, n]) => `${n} ${s.replace('_', ' ')}`).join(', ');
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Promotions</h1>
          <p className="hint" style={{ margin: 0 }}>
            One promotion, many shops: pick the accounts and it runs in every market they are active in, or only the countries you choose. Pushed to TikTok Shop through the Partner Center app.{' '}
            <a href="#" onClick={(e) => { e.preventDefault(); setShowConn((s) => !s); }}>{showConn ? 'Hide connection' : `Connection (${tts?.shops.length ?? 0} shops)`}</a>
          </p>
        </div>
        {isAdmin && <button className="primary" onClick={() => setEditing({ id: null, data: emptyForm() })}>+ New promotion</button>}
      </div>
      {error && <div className="banner crit">{error}</div>}
      {notice && <div className="banner info">{notice}</div>}
      {tts && !tts.configured && !showConn && <div className="banner warn">TikTok Shop app not connected yet. Promotions can be planned now and pushed once the app is set up. <a href="#" onClick={(e) => { e.preventDefault(); setShowConn(true); }}>Set up</a></div>}
      {showConn && tts && <ConnectionPanel tts={tts} accounts={accounts} onChange={setTts} />}
      {editing && tts && <PromotionForm initial={editing.data} accounts={accounts} tts={tts} onSave={save} onCancel={() => setEditing(null)} />}

      {promotions === null ? <p>Loading…</p> : promotions.length === 0 ? <div className="empty">No promotions yet.</div> : (
        <table>
          <thead><tr><th>Promotion</th><th>Type</th><th className="hide-sm">Runs</th><th>Shops</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {promotions.map((p) => (
              <>
                <tr key={p.id} className="clickable" onClick={() => setOpen(open === p.id ? null : p.id)}>
                  <td><b>{p.name}</b>{p.notes && <div className="sub">{p.notes}</div>}</td>
                  <td>{TYPE_LABEL[p.activity_type]}{p.discount_value !== null && <div className="sub">{p.activity_type === 'FIXED_PRICE' || p.activity_type === 'FLASHSALE' ? `price ${p.discount_value}` : `${p.discount_value}${p.discount_type === 'PERCENTAGE_OFF' ? '%' : ''} off`} · {p.product_level === 'SHOP' ? 'whole shop' : 'selected products'}</div>}</td>
                  <td className="hide-sm">{fmtDate(p.begin_at)}<div className="sub">to {fmtDate(p.end_at)}</div></td>
                  <td>{p.targets.length}<div className="sub">{[...new Set(p.targets.map((t) => t.market))].join(' ')}</div></td>
                  <td className="sub">{summary(p)}</td>
                  <td onClick={(e) => e.stopPropagation()}>
                    {isAdmin && (
                      <div className="actions">
                        <button className="small primary" disabled={busy === p.id || !tts?.configured} onClick={() => act(p, 'push')}>Push</button>
                        <button className="small" disabled={busy === p.id} onClick={() => act(p, 'sync')}>Sync</button>
                        <button className="small" disabled={busy === p.id} onClick={() => setEditing({ id: p.id, data: toInput(p) })}>Edit</button>
                        <button className="small danger" disabled={busy === p.id} onClick={() => act(p, 'deactivate')}>Deactivate</button>
                        <button className="small danger" disabled={busy === p.id} onClick={() => act(p, 'delete')}>Delete</button>
                      </div>
                    )}
                  </td>
                </tr>
                {open === p.id && (
                  <tr key={`${p.id}-t`} className="expand">
                    <td colSpan={6}>
                      <table>
                        <thead><tr><th>Account</th><th>Market</th><th>TikTok shop</th><th>Status</th><th>Activity</th><th>Detail</th></tr></thead>
                        <tbody>
                          {p.targets.map((t) => (
                            <tr key={t.id}>
                              <td>{t.account_name}</td>
                              <td>{t.market}</td>
                              <td>{t.tts_shop_name ?? <span className="sub">{tts?.shops.some((s) => s.account_id === t.account_id && s.market === t.market) ? 'linked' : 'none linked'}</span>}</td>
                              <td><TargetPill status={t.status} /></td>
                              <td className="mono sub">{t.tts_activity_id ?? '–'}{t.tts_status ? ` · ${t.tts_status}` : ''}</td>
                              <td className="sub">{t.error_message ?? (t.pushed_at ? `pushed ${fmtRelative(t.pushed_at)}` : '')}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </td>
                  </tr>
                )}
              </>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
