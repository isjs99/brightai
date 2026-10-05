import { useEffect, useState } from 'react';
import type { FbtField, FbtLine } from '../../../sweep/types';
import { api, fmtRelative, type FbtPlanData, type FbtRequested } from '../api';

/**
 * FBT (Fulfilled by TikTok) inbound paperwork for one shop: the AM sets how many units (or cartons / pallets)
 * go in per SKU, the carton specs are kept per SKU, the template header row and warehouse per account and
 * market, and the download is the upload-ready file plus a carton manifest and a booking summary.
 */
export default function FbtPanel({ shopId, days, lead, isAdmin, onError }: { shopId: string; days: number; lead: number; isAdmin: boolean; onError: (m: string | null) => void }) {
  const [plan, setPlan] = useState<FbtPlanData | null>(null);
  const [requested, setRequested] = useState<FbtRequested>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [header, setHeader] = useState('');
  const [onlySending, setOnlySending] = useState(true);
  useEffect(() => {
    const t = setTimeout(() => api.fbtPlan(shopId, days, lead, requested).then(setPlan).catch((e) => onError((e as Error).message)), 150);
    return () => clearTimeout(t);
  }, [shopId, days, lead, requested]);
  const save = async (key: string, fn: () => Promise<FbtPlanData>) => {
    setBusy(key); onError(null);
    try { setPlan(await fn()); } catch (e) { onError((e as Error).message); } finally { setBusy(null); }
  };
  if (!plan) return <p className="sub">Loading FBT plan…</p>;
  const p = plan.profile;
  const lines = plan.lines.filter((l) => !onlySending || l.units > 0 || l.suggested_units > 0 || requested[l.sku_id]);
  const blocked = plan.lines.filter((l) => l.units > 0 && l.blockers.length);
  const ask = (skuId: string, patch: { units?: number; cartons?: number; pallets?: number }) => setRequested((r) => {
    const cur = { ...(r[skuId] ?? {}) };
    // Typing cartons overrides units and the other way round; the server rounds units up to full cartons.
    if (patch.units !== undefined) { cur.units = patch.units; delete cur.cartons; }
    if (patch.cartons !== undefined) { cur.cartons = patch.cartons; delete cur.units; }
    if (patch.pallets !== undefined) cur.pallets = patch.pallets;
    return { ...r, [skuId]: cur };
  });
  const specInput = (l: FbtLine, key: keyof Pick<FbtLine, 'units_per_carton' | 'carton_length_cm' | 'carton_width_cm' | 'carton_height_cm' | 'carton_weight_kg' | 'cartons_per_pallet'>, width = 64, step = 1) => (
    <input type="number" min={0} step={step} style={{ width }} defaultValue={l[key] ?? ''} disabled={!isAdmin} key={`${l.sku_id}-${key}-${l.updated_at ?? ''}`}
      onBlur={(e) => { const v = e.target.value === '' ? null : Number(e.target.value); if (v !== (l[key] ?? null)) void save(`${l.sku_id}${key}`, () => api.fbtSku(shopId, l.sku_id, { [key]: v }, days, lead, requested)); }} />
  );
  const textInput = (l: FbtLine, key: 'goods_id' | 'barcode' | 'expiry' | 'lot', width = 110, placeholder = '') => (
    <input type="text" style={{ width }} defaultValue={l[key] ?? ''} placeholder={placeholder} disabled={!isAdmin} key={`${l.sku_id}-${key}-${l.updated_at ?? ''}`}
      onBlur={(e) => { const v = e.target.value.trim() || null; if (v !== (l[key] ?? null)) void save(`${l.sku_id}${key}`, () => api.fbtSku(shopId, l.sku_id, { [key]: v }, days, lead, requested)); }} />
  );
  const ready = plan.totals.skus > 0 && plan.totals.ready === plan.totals.skus;
  return (
    <div className="card" style={{ marginTop: 14 }}>
      <div className="page-head" style={{ marginBottom: 8 }}>
        <div>
          <h3 style={{ margin: 0 }}>FBT inbound paperwork <span className="sub">{plan.market ? `${plan.market} · ` : ''}{p.warehouse_name || 'warehouse not set'}</span></h3>
          <p className="sub" style={{ margin: 0 }}>{plan.totals.skus} SKU{plan.totals.skus === 1 ? '' : 's'} · {plan.totals.units} units · {plan.totals.cartons} cartons{plan.totals.pallets ? ` · ${plan.totals.pallets} pallets` : ''}{plan.totals.weight_kg ? ` · ${plan.totals.weight_kg} kg` : ''} · {plan.totals.ready}/{plan.totals.skus} ready{p.updated_at ? ` · template saved ${fmtRelative(p.updated_at)}` : ' · default template'}</p>
        </div>
        <div className="actions">
          <a className={`button primary${plan.totals.skus === 0 ? ' disabled' : ''}`} href={api.fbtFileUrl(shopId, 'template.csv', days, lead, requested)} download title={ready ? 'The upload file, exactly the template header row' : 'Some lines still miss carton specs; the file downloads anyway with blanks'}>Inbound template CSV</a>
          <a className="button" href={api.fbtFileUrl(shopId, 'manifest.csv', days, lead, requested)} download title="One line per carton for labels and the delivery note">Carton manifest</a>
          <a className="button" href={api.fbtFileUrl(shopId, 'summary.txt', days, lead, requested)} download title="Totals, warehouse and contact for the booking">Booking summary</a>
          <button className="small" onClick={() => setShowSettings((v) => !v)}>{showSettings ? 'Hide FBT settings' : 'FBT settings'}</button>
        </div>
      </div>
      {blocked.length > 0 && <div className="banner warn">{blocked.length} line{blocked.length === 1 ? '' : 's'} not ready: {[...new Set(blocked.flatMap((l) => l.blockers))].join(', ')}. Fill the carton specs below; they are remembered per SKU.</div>}
      {!plan.account_id && <div className="banner warn">This shop is not linked to an account, so the warehouse and template cannot be saved. Link it under Settings → Accounts.</div>}

      {showSettings && (
        <div className="card" style={{ marginBottom: 12, background: 'var(--surface-2, var(--surface))' }}>
          <h4 style={{ marginTop: 0 }}>FBT settings <span className="sub">per account and market, used for every shipment to this warehouse</span></h4>
          <div className="inline-form" style={{ marginBottom: 8 }}>
            <label className="field" style={{ minWidth: 200 }}><span className="lbl">Warehouse name</span><input type="text" defaultValue={p.warehouse_name} disabled={!isAdmin} placeholder="e.g. FBT ES Madrid" onBlur={(e) => save('wh', () => api.fbtProfile(shopId, { warehouse_name: e.target.value }, days, lead, requested))} /></label>
            <label className="field" style={{ minWidth: 160 }}><span className="lbl">Warehouse id</span><input type="text" defaultValue={p.warehouse_id} disabled={!isAdmin} placeholder="from Seller Center" onBlur={(e) => save('whid', () => api.fbtProfile(shopId, { warehouse_id: e.target.value }, days, lead, requested))} /></label>
            <label className="field" style={{ minWidth: 220 }}><span className="lbl">Ship from</span><input type="text" defaultValue={p.ship_from} disabled={!isAdmin} placeholder="client / 3PL address" onBlur={(e) => save('from', () => api.fbtProfile(shopId, { ship_from: e.target.value }, days, lead, requested))} /></label>
            <label className="field" style={{ minWidth: 180 }}><span className="lbl">Contact</span><input type="text" defaultValue={p.contact} disabled={!isAdmin} placeholder="name · phone · email" onBlur={(e) => save('contact', () => api.fbtProfile(shopId, { contact: e.target.value }, days, lead, requested))} /></label>
            <label className="field" style={{ minWidth: 110 }}><span className="lbl">Delimiter</span><select value={p.delimiter} disabled={!isAdmin} onChange={(e) => save('delim', () => api.fbtProfile(shopId, { delimiter: e.target.value as ',' | ';' }, days, lead, requested))}><option value=",">comma</option><option value=";">semicolon</option></select></label>
          </div>
          <label className="field" style={{ marginBottom: 8 }}>
            <span className="lbl">Template header row <span className="sub">open the inbound template downloaded from Seller Center → Fulfilled by TikTok → Inbound, copy its header row and paste it here; every column is then mapped to a field below</span></span>
            <div className="inline-form"><input type="text" style={{ flex: 1, minWidth: 320 }} value={header} placeholder={p.columns.map((c) => c.header).join(p.delimiter)} disabled={!isAdmin} onChange={(e) => setHeader(e.target.value)} />
              <button className="small" disabled={!isAdmin || !header.trim() || busy === 'hdr'} onClick={() => save('hdr', () => api.fbtProfile(shopId, { header }, days, lead, requested)).then(() => setHeader(''))}>Use this header</button>
              <button className="small" disabled={!isAdmin || busy === 'reset'} onClick={() => save('reset', () => api.fbtProfile(shopId, { reset_columns: true }, days, lead, requested))}>Reset to default</button></div>
          </label>
          <div className="grid-wrap"><table><thead><tr><th>#</th><th>Column in the template</th><th>Filled with</th></tr></thead><tbody>
            {p.columns.map((c, i) => (
              <tr key={`${i}-${c.header}`}>
                <td className="sub">{i + 1}</td>
                <td><b>{c.header}</b></td>
                <td><select value={c.field} disabled={!isAdmin} onChange={(e) => save(`col${i}`, () => api.fbtProfile(shopId, { columns: p.columns.map((x, k) => k === i ? { ...x, field: e.target.value as FbtField } : x) }, days, lead, requested))}>
                  {plan.fields.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
                </select></td>
              </tr>
            ))}
          </tbody></table></div>
        </div>
      )}

      <div className="toolbar" style={{ marginBottom: 6 }}>
        <label className="field check"><input type="checkbox" checked={onlySending} onChange={(e) => setOnlySending(e.target.checked)} /> Only SKUs with something to send</label>
        <span className="sub">Units round up to full cartons. Type cartons to override the units, or pallets when the warehouse books by pallet.</span>
        {Object.keys(requested).length > 0 && <button className="small" style={{ marginLeft: 'auto' }} onClick={() => setRequested({})}>Back to suggested units</button>}
      </div>
      {lines.length === 0 ? <div className="empty">Nothing to send in for this cover. Untick the filter to add SKUs by hand.</div> : (
        <div className="grid-wrap"><table className="fbt"><thead><tr><th>Product</th><th>Seller SKU</th><th>FBT goods id</th><th>Barcode</th><th className="num">On hand</th><th className="num">Suggested</th><th className="num">Units</th><th className="num">Per carton</th><th className="num">Cartons</th><th className="num">Pallets</th><th>Carton L×W×H cm</th><th className="num">kg</th><th className="num">Ctn/pallet</th><th>Expiry</th><th>Lot</th><th></th></tr></thead><tbody>
          {lines.map((l) => (
            <tr key={l.sku_id} className={l.units > 0 && l.blockers.length ? 'warnrow' : ''}>
              <td>{l.product_title}{l.sku_name ? <div className="sub">{l.sku_name}</div> : null}<div className="sub" title="TikTok SKU id">{l.sku_id}</div></td>
              <td className="sub">{l.seller_sku ?? '–'}</td>
              <td>{textInput(l, 'goods_id', 120, l.seller_sku ? 'uses seller SKU' : 'required')}</td>
              <td>{textInput(l, 'barcode', 120, 'EAN')}</td>
              <td className="num">{l.on_hand}</td>
              <td className="num sub">{l.suggested_units}</td>
              <td className="num"><input type="number" min={0} style={{ width: 70 }} value={l.units} onChange={(e) => ask(l.sku_id, { units: Math.max(0, Number(e.target.value) || 0) })} /></td>
              <td className="num">{specInput(l, 'units_per_carton', 60)}</td>
              <td className="num"><input type="number" min={0} style={{ width: 60 }} value={l.cartons} onChange={(e) => ask(l.sku_id, { cartons: Math.max(0, Number(e.target.value) || 0) })} /></td>
              <td className="num"><input type="number" min={0} style={{ width: 56 }} value={l.pallets} onChange={(e) => ask(l.sku_id, { pallets: Math.max(0, Number(e.target.value) || 0) })} /></td>
              <td style={{ whiteSpace: 'nowrap' }}>{specInput(l, 'carton_length_cm', 50, 0.1)} × {specInput(l, 'carton_width_cm', 50, 0.1)} × {specInput(l, 'carton_height_cm', 50, 0.1)}</td>
              <td className="num">{specInput(l, 'carton_weight_kg', 56, 0.01)}</td>
              <td className="num">{specInput(l, 'cartons_per_pallet', 56)}</td>
              <td>{textInput(l, 'expiry', 100, 'YYYY-MM-DD')}</td>
              <td>{textInput(l, 'lot', 80)}</td>
              <td>{l.units > 0 ? l.blockers.length ? <span className="badge warn" title={l.blockers.join('; ')}>missing {l.blockers.length}</span> : <span className="badge good">ready</span> : <span className="badge muted">not sending</span>}</td>
            </tr>
          ))}
        </tbody></table></div>
      )}
      <p className="help" style={{ marginBottom: 0 }}>How FBT inbound works: create an inbound request in Seller Center (Fulfilled by TikTok → Inventory → Inbound), pick the warehouse, upload the template with one line per goods item and its cartons, then book the delivery slot with the carton count and pallets from the booking summary. Print the carton labels from the inbound request and put one on each carton listed in the manifest.</p>
    </div>
  );
}
