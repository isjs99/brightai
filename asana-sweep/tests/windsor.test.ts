import { describe, it, expect } from 'vitest';
import { openTestDb } from '../src/db/index';
import { Queries } from '../src/db/queries';
import { discoverWindsorShops, matchAccount, ordersToDailyGmv, syncWindsorGmv, type WindsorClient, type WindsorOrder, type WindsorShop } from '../src/gmv/windsor';
import { syncGmv } from '../src/gmv/sync';
import { buildGmv } from '../src/reports/index';
import type { CruvaClient } from '../src/gmv/cruva';

const shops: WindsorShop[] = [
  { account_id: 'DEESLCN8QWCV', account_name: 'Clearly_Spain', shop_id: '8648359959192050479', shop_name: 'Clearly_Spain', shop_region: 'ES', shop_seller_type: 'LOCAL' },
  { account_id: 'DEITLCCTQLXS', account_name: 'Nutori Italia', shop_id: '8647333938898836345', shop_name: 'Nutori Italia', shop_region: 'IT', shop_seller_type: 'LOCAL' },
];
const today = new Date().toISOString().slice(0, 10);
const daysAgo = (n: number) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
const orders: WindsorOrder[] = [
  { account_id: 'DEESLCN8QWCV', account_name: 'Clearly_Spain', date: daysAgo(2), order_id: '1', order_status: 'COMPLETED', order_payment_total_amount: 19.9, order_payment_currency: 'EUR' },
  { account_id: 'DEESLCN8QWCV', account_name: 'Clearly_Spain', date: daysAgo(2), order_id: '2', order_status: 'DELIVERED', order_payment_total_amount: 30.1, order_payment_currency: 'EUR' },
  { account_id: 'DEESLCN8QWCV', account_name: 'Clearly_Spain', date: daysAgo(2), order_id: '3', order_status: 'CANCELLED', order_payment_total_amount: 99, order_payment_currency: 'EUR' },
  { account_id: 'DEESLCN8QWCV', account_name: 'Clearly_Spain', date: daysAgo(1), order_id: '4', order_status: 'IN_TRANSIT', order_payment_total_amount: 12.5, order_payment_currency: 'EUR' },
  { account_id: 'DEITLCCTQLXS', account_name: 'Nutori Italia', date: daysAgo(1), order_id: '5', order_status: 'COMPLETED', order_payment_total_amount: 40, order_payment_currency: 'EUR' },
];
const fake = { configured: true, async shops() { return shops; }, async orders() { return orders; } } as unknown as WindsorClient;

describe('windsor', () => {
  it('turns orders into daily GMV per shop, cancelled excluded', () => {
    const rows = ordersToDailyGmv(orders);
    const es2 = rows.find((r) => r.shop_id === 'DEESLCN8QWCV' && r.date === daysAgo(2))!;
    expect(es2.total_gmv).toBe(50);
    expect(es2.units).toBe(2);
    expect(rows.find((r) => r.shop_id === 'DEITLCCTQLXS')!.total_gmv).toBe(40);
    expect(rows.every((r) => r.source === 'windsor')).toBe(true);
  });

  it('matches shops to roster accounts by name', () => {
    const accounts = [{ id: 1, name: 'Clearly' }, { id: 2, name: 'Nutori' }, { id: 3, name: 'Super Ninja' }];
    expect(matchAccount({ shop_name: 'Clearly_Spain', account_name: 'Clearly_Spain' }, accounts)?.id).toBe(1);
    expect(matchAccount({ shop_name: 'Nutori España', account_name: 'Nutori España' }, accounts)?.id).toBe(2);
    expect(matchAccount({ shop_name: 'Something Else', account_name: 'x' }, accounts)).toBeNull();
  });

  it('discovers, links by name and syncs into the GMV page', async () => {
    const q = new Queries(openTestDb());
    const clearly = q.listAccounts().find((a) => a.name === 'Clearly')!;
    const d = await discoverWindsorShops(q, fake);
    expect(d.shops).toHaveLength(2);
    expect(d.linked).toBe(2); // Clearly and Nutori are both on the roster
    const linked = q.listShops('windsor');
    expect(linked).toHaveLength(2);
    const es = linked.find((s) => s.shop_id === 'DEESLCN8QWCV')!;
    expect(es.account_id).toBe(clearly.id);
    expect(es.currency).toBe('EUR');
    expect(es.source).toBe('windsor');
    const nutori = q.listAccounts().find((a) => a.name === 'Nutori')!;
    expect(linked.find((s) => s.shop_id === 'DEITLCCTQLXS')!.account_id).toBe(nutori.id);
    const r = await syncWindsorGmv(q, { days: 5, client: fake });
    expect(r.error).toBeNull();
    expect(r.shops).toBe(2);
    const gmv = q.listGmvBetween(daysAgo(5), today);
    expect(gmv.find((g) => g.shop_id === 'DEESLCN8QWCV' && g.date === daysAgo(2))!.total_gmv).toBe(50);
    expect(gmv.find((g) => g.shop_id === 'DEITLCCTQLXS' && g.date === daysAgo(1))!.total_gmv).toBe(40);
    // The GMV page shows the shop under Clearly with a source id, not a Cruva id.
    const page = buildGmv(q, today.slice(0, 7));
    const row = page.accounts.find((a) => a.account.id === clearly.id)!;
    expect(row.shops.map((s) => s.shop.shop_id)).toContain('DEESLCN8QWCV');
    expect(page.windsor_configured).toBe(false); // env not set in tests
  });

  it('discovers shops from orders when the connector shop table is empty', async () => {
    const q = new Queries(openTestDb());
    const { WindsorClient } = await import('../src/gmv/windsor');
    const c = new WindsorClient('key', 'https://example.invalid');
    // Shop table → nothing; orders → the two accounts; products → one more.
    c.query = (async (fields: string[]) => {
      if (fields.includes('shop_id')) return [];
      if (fields.includes('order_id') || fields.includes('date')) return orders;
      if (fields.includes('product_id')) return [{ account_id: 'DEFRLCN8QWCN', account_name: 'Clearly_France', product_id: '1' }];
      return [];
    }) as WindsorClient['query'];
    const found = await c.shops();
    expect(found.map((s) => s.account_id).sort()).toEqual(['DEESLCN8QWCV', 'DEFRLCN8QWCN', 'DEITLCCTQLXS']);
    expect(found.find((s) => s.account_id === 'DEFRLCN8QWCN')!.shop_region).toBe('FR');
    const d = await discoverWindsorShops(q, c);
    expect(d.linked).toBe(3); // both Clearly shops link to Clearly, Nutori Italia to Nutori
    expect(q.listShops('windsor').filter((s) => s.account_id === q.listAccounts().find((a) => a.name === 'Clearly')!.id)).toHaveLength(2);
  });

  it('the combined sync runs Windsor even when Cruva is not configured', async () => {
    const q = new Queries(openTestDb());
    await discoverWindsorShops(q, fake);
    const noCruva = { configured: false } as unknown as CruvaClient;
    const s = await syncGmv(q, { days: 5, client: noCruva, windsorClient: fake });
    expect(s?.status).toBe('ok');
    expect(s?.shops_synced).toBe(2);
    // Cruva shops without the REST key are not reported as failures any more.
    expect(s?.error_message).toBeNull();
  });
});
