import { describe, expect, it } from 'vitest';
import { Queries } from '../src/db/queries';
import { openTestDb } from '../src/db/index';
import { columnsFromHeader, DEFAULT_FBT_COLUMNS, fbtManifestCsv, fbtPlan, fbtProfile, fbtSummary, fbtTemplateCsv, guessField } from '../src/stock/fbt';
import type { StockProjection, StockProjectionRow } from '../src/sweep/types';

const row = (over: Partial<StockProjectionRow>): StockProjectionRow => ({
  shop_id: 'shop1', account_id: 1, source: 'tts', product_id: 'p1', product_title: 'Collagen', sku_id: 'sku-1', sku_name: '30 caps', seller_sku: 'COL-30', product_status: 'ACTIVATE', on_hand: 40, sold_7d: 70, sold_30d: 240, captured_at: '2026-10-01T00:00:00Z', velocity_override: null, exclude: false, note: null,
  velocity: 9, days_left: 4.4, stockout_at: '2026-10-05', level: 'crit', send_in: 230, ...over,
} as StockProjectionRow);

const proj = (rows: StockProjectionRow[], accountId: number | null = 1): StockProjection => ({ shop_id: 'shop1', shop_name: 'Nutori ES', account_id: accountId, account_name: 'Nutori', cover_days: 30, lead_days: 0, captured_at: '2026-10-01T00:00:00Z', rows, totals: { skus: rows.length, send_in_units: 0, send_in_skus: 0, out: 0, crit: 0, warn: 0 } });

describe('FBT paperwork', () => {
  const setup = () => { const q = new Queries(openTestDb()); const a = q.createAccount({ name: 'Nutori', markets: 'ES', am_name: 'Ana', aa_name: null, enabled: true, notes: null, commission_pct: null, commission_basis: 'gmv', settlement_pct: 100, slack_channel: null, client_slack_channel: null, client_domain: null }); return { q, a }; };

  it('rounds units up to full cartons and flags missing specs', () => {
    const { q, a } = setup();
    const p = proj([row({ account_id: a.id })], a.id);
    const before = fbtPlan(q, p);
    expect(before.lines[0].units).toBe(230);
    expect(before.lines[0].cartons).toBe(0);
    expect(before.lines[0].blockers).toContain('units per carton missing');
    q.saveFbtSkuSpec('shop1', 'sku-1', { units_per_carton: 24, carton_length_cm: 40, carton_width_cm: 30, carton_height_cm: 20, carton_weight_kg: 6.5, cartons_per_pallet: 20 });
    const plan = fbtPlan(q, p);
    expect(plan.lines[0].cartons).toBe(10); // 230 / 24 → 10 cartons
    expect(plan.lines[0].units).toBe(240);
    expect(plan.lines[0].pallets).toBe(1);
    expect(plan.lines[0].blockers).toEqual([]);
    expect(plan.totals).toMatchObject({ units: 240, cartons: 10, pallets: 1, weight_kg: 65, skus: 1, ready: 1 });
  });

  it('lets the AM ask for cartons or units and pallets directly', () => {
    const { q, a } = setup();
    q.saveFbtSkuSpec('shop1', 'sku-1', { units_per_carton: 12 });
    const p = proj([row({ account_id: a.id })], a.id);
    expect(fbtPlan(q, p, { 'sku-1': { cartons: 3 } }).lines[0]).toMatchObject({ cartons: 3, units: 36 });
    expect(fbtPlan(q, p, { 'sku-1': { units: 25 } }).lines[0]).toMatchObject({ cartons: 3, units: 36 });
    expect(fbtPlan(q, p, { 'sku-1': { units: 0 } }).lines[0]).toMatchObject({ cartons: 0, units: 0, blockers: [] });
    expect(fbtPlan(q, p, { 'sku-1': { cartons: 4, pallets: 2 } }).lines[0].pallets).toBe(2);
  });

  it('writes the template with exactly the saved header row and one line per SKU to send', () => {
    const { q, a } = setup();
    q.saveFbtSkuSpec('shop1', 'sku-1', { units_per_carton: 24, goods_id: 'G123', barcode: '5060000000001', carton_length_cm: 40, carton_width_cm: 30, carton_height_cm: 20, carton_weight_kg: 6 });
    q.saveFbtProfile(a.id, 'ES', { warehouse_name: 'FBT Madrid', warehouse_id: 'WH-ES-1', columns: columnsFromHeader('Goods ID;Seller SKU;Qty per Carton;Carton Qty;Total Qty;Warehouse'), delimiter: ';' });
    const p = proj([row({ account_id: a.id }), row({ sku_id: 'sku-2', seller_sku: 'COL-60', send_in: 0, level: 'ok', account_id: a.id })], a.id);
    const plan = fbtPlan(q, p);
    expect(plan.profile.columns.map((c) => c.field)).toEqual(['goods_id', 'seller_sku', 'units_per_carton', 'cartons', 'total_units', 'warehouse_name']);
    const csv = fbtTemplateCsv(plan);
    const lines = csv.trim().split('\r\n');
    expect(lines[0]).toBe('Goods ID;Seller SKU;Qty per Carton;Carton Qty;Total Qty;Warehouse');
    expect(lines).toHaveLength(2); // sku-2 has nothing to send
    expect(lines[1]).toBe('G123;COL-30;24;10;240;FBT Madrid');
    const manifest = fbtManifestCsv(plan);
    expect(manifest.trim().split(/\r?\n/).length).toBe(11); // header + 10 cartons
    const summary = fbtSummary(plan);
    expect(summary).toContain('FBT Madrid');
    expect(summary).toContain('10 cartons');
  });

  it('maps common header names to fields and keeps the default template otherwise', () => {
    expect(guessField('SKU ID')).toBe('sku_id');
    expect(guessField('Seller SKU')).toBe('seller_sku');
    expect(guessField('Number of cartons')).toBe('cartons');
    expect(guessField('Units per carton')).toBe('units_per_carton');
    expect(guessField('Carton weight (kg)')).toBe('carton_weight_kg');
    expect(guessField('Total quantity')).toBe('total_units');
    expect(guessField('Something odd')).toBe('blank');
    const q = new Queries(openTestDb());
    expect(fbtProfile(q, null, 'ES').columns).toEqual(DEFAULT_FBT_COLUMNS);
  });
});
