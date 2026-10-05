import type { Queries } from '../db/queries.js';
import type { FbtField, FbtLine, FbtPlan, FbtProfile, StockProjection } from '../sweep/types.js';

/**
 * Fulfilled by TikTok paperwork. An inbound request (IBR) in the FBT portal is one line per goods item:
 * the FBT goods id (or the seller SKU the goods were matched with), how many units go in a carton, how
 * many cartons ship, and the carton's dimensions and weight; pallets are declared on the shipment.
 * The portal's bulk template is uploaded as a spreadsheet, so the exact header row is kept per account
 * and market (paste it from the template once) and every column is mapped to one of the fields below.
 * Units always round up to full cartons: FBT counts cartons, not loose units.
 */

export const FBT_FIELDS: { key: FbtField; label: string }[] = [
  { key: 'goods_id', label: 'FBT goods id' }, { key: 'seller_sku', label: 'Seller SKU' }, { key: 'sku_id', label: 'TikTok SKU id' }, { key: 'product_id', label: 'TikTok product id' },
  { key: 'product_name', label: 'Product name' }, { key: 'sku_name', label: 'Variant name' }, { key: 'barcode', label: 'Barcode (EAN/UPC)' },
  { key: 'units_per_carton', label: 'Units per carton' }, { key: 'cartons', label: 'Number of cartons' }, { key: 'total_units', label: 'Total units' },
  { key: 'carton_length_cm', label: 'Carton length (cm)' }, { key: 'carton_width_cm', label: 'Carton width (cm)' }, { key: 'carton_height_cm', label: 'Carton height (cm)' }, { key: 'carton_weight_kg', label: 'Carton weight (kg)' },
  { key: 'pallets', label: 'Pallets' }, { key: 'warehouse_id', label: 'Warehouse id' }, { key: 'warehouse_name', label: 'Warehouse name' }, { key: 'expiry', label: 'Expiry date' }, { key: 'lot', label: 'Lot / batch' }, { key: 'blank', label: '(leave empty)' },
];

/** The default header row, the way the FBT inbound template reads it; replace it with the real one under FBT settings. */
export const DEFAULT_FBT_COLUMNS: FbtProfile['columns'] = [
  { header: 'Goods ID', field: 'goods_id' }, { header: 'Seller SKU', field: 'seller_sku' }, { header: 'Goods Name', field: 'product_name' }, { header: 'Barcode', field: 'barcode' },
  { header: 'Units per Carton', field: 'units_per_carton' }, { header: 'Number of Cartons', field: 'cartons' }, { header: 'Total Quantity', field: 'total_units' },
  { header: 'Carton Length (cm)', field: 'carton_length_cm' }, { header: 'Carton Width (cm)', field: 'carton_width_cm' }, { header: 'Carton Height (cm)', field: 'carton_height_cm' }, { header: 'Carton Weight (kg)', field: 'carton_weight_kg' },
  { header: 'Expiration Date', field: 'expiry' }, { header: 'Lot Number', field: 'lot' },
];

export function fbtProfile(q: Queries, accountId: number | null, market: string | null): FbtProfile {
  const stored = accountId ? q.getFbtProfile(accountId, market ?? '') : { updated_at: null };
  return { account_id: accountId ?? 0, market: (market ?? '').toUpperCase(), warehouse_name: stored.warehouse_name ?? '', warehouse_id: stored.warehouse_id ?? '', ship_from: stored.ship_from ?? '', contact: stored.contact ?? '', columns: stored.columns?.length ? stored.columns : DEFAULT_FBT_COLUMNS, delimiter: stored.delimiter === ';' ? ';' : ',', updated_at: stored.updated_at ?? null };
}

/** Parse a pasted header row into columns, guessing the field from the words in each header. */
export function columnsFromHeader(row: string): FbtProfile['columns'] {
  const delimiter = row.includes('\t') ? '\t' : row.split(';').length > row.split(',').length ? ';' : ',';
  return row.split(delimiter).map((h) => h.trim().replace(/^"|"$/g, '')).filter((h) => h).map((header) => ({ header, field: guessField(header) }));
}

export function guessField(header: string): FbtField {
  const h = header.toLowerCase();
  if (/goods\s*id|fbt\s*id/.test(h)) return 'goods_id';
  if (/seller\s*sku|merchant\s*sku|sku\s*code|reference/.test(h)) return 'seller_sku';
  if (/sku\s*id/.test(h)) return 'sku_id';
  if (/product\s*id/.test(h)) return 'product_id';
  if (/barcode|ean|upc|gtin/.test(h)) return 'barcode';
  if (/per\s*carton|units?\s*\/\s*carton|qty\s*per|case\s*pack/.test(h)) return 'units_per_carton';
  if (/number\s*of\s*cartons|cartons?\s*(qty|quantity|count)|^cartons?$|boxes/.test(h)) return 'cartons';
  if (/total|quantity|qty|units/.test(h)) return 'total_units';
  if (/length/.test(h)) return 'carton_length_cm';
  if (/width/.test(h)) return 'carton_width_cm';
  if (/height/.test(h)) return 'carton_height_cm';
  if (/weight/.test(h)) return 'carton_weight_kg';
  if (/pallet/.test(h)) return 'pallets';
  if (/warehouse.*id/.test(h)) return 'warehouse_id';
  if (/warehouse/.test(h)) return 'warehouse_name';
  if (/expir|best\s*before|bbd/.test(h)) return 'expiry';
  if (/lot|batch/.test(h)) return 'lot';
  if (/name|title|description/.test(h)) return 'product_name';
  if (/variant|option|size|colou?r/.test(h)) return 'sku_name';
  return 'blank';
}

/** The plan: every SKU of the projection with its FBT spec, the suggested send-in and the carton maths. */
export function fbtPlan(q: Queries, proj: StockProjection, requested: Record<string, { units?: number; cartons?: number; pallets?: number }> = {}): FbtPlan {
  const profile = fbtProfile(q, proj.account_id, marketOfProjection(q, proj));
  const specs = new Map(q.listFbtSkuSpecs(proj.shop_id).map((s) => [s.sku_id, s]));
  const lines: FbtLine[] = proj.rows.map((r) => {
    const spec = specs.get(r.sku_id) ?? { shop_id: proj.shop_id, sku_id: r.sku_id, goods_id: null, barcode: null, units_per_carton: null, carton_length_cm: null, carton_width_cm: null, carton_height_cm: null, carton_weight_kg: null, cartons_per_pallet: null, expiry: null, lot: null, updated_at: null };
    const ask = requested[r.sku_id] ?? {};
    const upc = spec.units_per_carton && spec.units_per_carton > 0 ? spec.units_per_carton : null;
    let cartons = ask.cartons !== undefined ? Math.max(0, Math.round(ask.cartons)) : upc ? Math.ceil(Math.max(0, ask.units ?? r.send_in) / upc) : 0;
    let units = upc ? cartons * upc : Math.max(0, Math.round(ask.units ?? r.send_in));
    if (!upc && ask.cartons !== undefined) { cartons = ask.cartons; }
    const pallets = ask.pallets !== undefined ? Math.max(0, Math.round(ask.pallets)) : spec.cartons_per_pallet && spec.cartons_per_pallet > 0 && cartons ? Math.ceil(cartons / spec.cartons_per_pallet) : 0;
    const blockers: string[] = [];
    if (units > 0) {
      if (!spec.goods_id && !r.seller_sku) blockers.push('FBT goods id (or seller SKU) missing');
      if (!upc) blockers.push('units per carton missing');
      if (!spec.carton_length_cm || !spec.carton_width_cm || !spec.carton_height_cm) blockers.push('carton size missing');
      if (!spec.carton_weight_kg) blockers.push('carton weight missing');
    }
    return { ...spec, product_id: r.product_id, product_title: r.product_title, sku_name: r.sku_name, seller_sku: r.seller_sku, on_hand: r.on_hand, velocity: r.velocity, suggested_units: r.send_in, units, cartons, pallets, blockers };
  });
  const active = lines.filter((l) => l.units > 0);
  return {
    shop_id: proj.shop_id, shop_name: proj.shop_name, market: profile.market || null, account_id: proj.account_id, account_name: proj.account_name, profile, lines, cover_days: proj.cover_days,
    totals: { units: active.reduce((n, l) => n + l.units, 0), cartons: active.reduce((n, l) => n + l.cartons, 0), pallets: active.reduce((n, l) => n + l.pallets, 0), weight_kg: Math.round(active.reduce((n, l) => n + l.cartons * (l.carton_weight_kg ?? 0), 0) * 10) / 10, skus: active.length, ready: active.filter((l) => !l.blockers.length).length },
  };
}

function marketOfProjection(q: Queries, proj: StockProjection): string | null {
  const tts = q.listTtsShops().find((s) => s.id === proj.shop_id);
  if (tts?.market) return tts.market;
  const m = proj.shop_name.trim().match(/(?:^|[\s(\-_])([A-Z]{2})\)?(?:\s*\[[^\]]*\])?$/);
  return m ? (m[1] === 'GB' ? 'UK' : m[1]) : null;
}

const cell = (v: unknown, delimiter: string): string => { const t = v === null || v === undefined ? '' : String(v); return new RegExp(`[",\\n;\\t${delimiter}]`).test(t) ? `"${t.replace(/"/g, '""')}"` : t; };

function valueOf(field: FbtField, l: FbtLine, p: FbtProfile): string | number {
  switch (field) {
    case 'goods_id': return l.goods_id ?? '';
    case 'seller_sku': return l.seller_sku ?? '';
    case 'sku_id': return l.sku_id;
    case 'product_id': return l.product_id;
    case 'product_name': return l.product_title;
    case 'sku_name': return l.sku_name ?? '';
    case 'barcode': return l.barcode ?? '';
    case 'units_per_carton': return l.units_per_carton ?? '';
    case 'cartons': return l.cartons;
    case 'total_units': return l.units;
    case 'carton_length_cm': return l.carton_length_cm ?? '';
    case 'carton_width_cm': return l.carton_width_cm ?? '';
    case 'carton_height_cm': return l.carton_height_cm ?? '';
    case 'carton_weight_kg': return l.carton_weight_kg ?? '';
    case 'pallets': return l.pallets;
    case 'warehouse_id': return p.warehouse_id;
    case 'warehouse_name': return p.warehouse_name;
    case 'expiry': return l.expiry ?? '';
    case 'lot': return l.lot ?? '';
    default: return '';
  }
}

/** The upload file: exactly the template's header row, one line per SKU with units to send. */
export function fbtTemplateCsv(plan: FbtPlan): string {
  const d = plan.profile.delimiter;
  const head = plan.profile.columns.map((c) => cell(c.header, d)).join(d);
  const rows = plan.lines.filter((l) => l.units > 0).map((l) => plan.profile.columns.map((c) => cell(valueOf(c.field, l, plan.profile), d)).join(d));
  return [head, ...rows].join('\r\n') + '\r\n';
}

/** The carton manifest for the labels and the delivery note: one line per carton, numbered, with its contents. */
export function fbtManifestCsv(plan: FbtPlan): string {
  const d = plan.profile.delimiter;
  const head = ['Carton no', 'Shop', 'Warehouse', 'Goods ID', 'Seller SKU', 'Product', 'Variant', 'Units in carton', 'Length cm', 'Width cm', 'Height cm', 'Weight kg', 'Pallet'].map((h) => cell(h, d)).join(d);
  const rows: string[] = [];
  let n = 0;
  for (const l of plan.lines.filter((x) => x.units > 0)) {
    const perPallet = l.cartons_per_pallet && l.cartons_per_pallet > 0 ? l.cartons_per_pallet : null;
    for (let i = 0; i < l.cartons; i += 1) {
      n += 1;
      const inCarton = l.units_per_carton ?? (l.cartons ? Math.ceil(l.units / l.cartons) : l.units);
      rows.push([n, plan.shop_name, plan.profile.warehouse_name, l.goods_id ?? '', l.seller_sku ?? '', l.product_title, l.sku_name ?? '', inCarton, l.carton_length_cm ?? '', l.carton_width_cm ?? '', l.carton_height_cm ?? '', l.carton_weight_kg ?? '', perPallet ? Math.floor(i / perPallet) + 1 : (l.pallets ? 1 : '')].map((v) => cell(v, d)).join(d));
    }
  }
  return [head, ...rows].join('\r\n') + '\r\n';
}

/** The summary the AM pastes into the booking: warehouse, counts, weight, per-SKU lines. */
export function fbtSummary(plan: FbtPlan): string {
  const lines = [
    `Inbound to Fulfilled by TikTok · ${plan.shop_name}${plan.market ? ` (${plan.market})` : ''}`,
    `Warehouse: ${plan.profile.warehouse_name || 'not set'}${plan.profile.warehouse_id ? ` (${plan.profile.warehouse_id})` : ''}`,
    `Ship from: ${plan.profile.ship_from || 'not set'}`,
    `Contact: ${plan.profile.contact || 'not set'}`,
    `${plan.totals.skus} SKU(s) · ${plan.totals.units} units · ${plan.totals.cartons} cartons · ${plan.totals.pallets} pallet(s) · ${plan.totals.weight_kg} kg`,
    '',
    ...plan.lines.filter((l) => l.units > 0).map((l) => `- ${l.product_title}${l.sku_name ? ` / ${l.sku_name}` : ''}${l.seller_sku ? ` [${l.seller_sku}]` : ''}: ${l.units} units = ${l.cartons} carton(s)${l.units_per_carton ? ` × ${l.units_per_carton}` : ''}${l.pallets ? `, ${l.pallets} pallet(s)` : ''}${l.blockers.length ? ` · MISSING: ${l.blockers.join(', ')}` : ''}`),
  ];
  return lines.join('\n') + '\n';
}
