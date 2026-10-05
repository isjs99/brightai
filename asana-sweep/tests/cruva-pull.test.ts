import { describe, it, expect } from 'vitest';
import { openTestDb } from '../src/db/index';
import { Queries } from '../src/db/queries';
import { CruvaRest } from '../src/cruva/rest';
import { CruvaPuller, daysFromStats, metricsFromDays } from '../src/cruva/pull';
import { HealthEngine } from '../src/health/index';
import { buildAlertCalendar, marketOfShopName, shopsForGmv } from '../src/reports/index';
import { StockTracker } from '../src/stock/index';
import { savePolicy } from '../src/inbox/replies';

const NOW = Date.parse('2026-10-05T10:00:00Z');
const day = (n: number) => new Date(NOW - n * 86400000).toISOString().slice(0, 10);
const series = (per: number, days = 28) => Array.from({ length: days }, (_, i) => ({ date: day(days - 1 - i), count: per }));

/** A fake api.cruva.com: every shop returns the same figures, except the one that fails on stats. */
function fakeRest(opts: { failShop?: string } = {}) {
  const calls: { path: string; shop: string | null; body: Record<string, unknown> }[] = [];
  const fetchFn = (async (url: string, init?: { headers?: Record<string, string>; body?: string }) => {
    const path = new URL(url).pathname;
    const shop = init?.headers?.['x-shop-id'] ?? null;
    const body = init?.body ? JSON.parse(init.body) as Record<string, unknown> : {};
    calls.push({ path, shop, body });
    const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
    if (path === '/shop/stats') {
      if (shop === opts.failShop) return json({ error: 'nope' }, 500);
      const want = (body.stats as string[]) ?? [];
      const all: Record<string, number> = { total_gmv: 1000, affiliate_gmv: 700, total_units_sold: 40, affiliate_units_sold: 30, videos_posted: 12, video_views: 50000, samples_approved: 3, samples_shipped: 2, dms_sent: 80, aov: 25 };
      return json({ data: { stats: want.filter((k) => k in all).map((k) => ({ key: k, title: k, total_count: all[k] * 28, percent_change: -5, daily_counts: series(all[k]) })) } });
    }
    if (path === '/shop/sps') return json({ data: { sps: 3.2 } });
    if (path === '/affiliate/samples/funnel') return json({ data: { total_count: 100, by_status: [{ status: 'To Review', count: 7, is_open: true, avg_age_days: 3.1, oldest_age_days: 4 }, { status: 'Content Pending', count: 25, is_open: true }, { status: 'Rejected', count: 68, is_open: false }], funnel: [] } });
    if (path === '/automations/list') return json({ data: { results: [{ campaign_id: 'a1', campaign_name: 'Sample Shipped', status: 'active' }, { campaign_id: 'a2', campaign_name: 'Old', status: 'stopped' }] } });
    if (path === '/shop/skus') return json({ data: [{ sku_id: 's1', sku_name: '30 days', product_id: 'p1', product_name: 'Magnesium', price: 20, custom_cogs: 5, stock: 12 }, { sku_id: 's2', sku_name: '90 days', product_id: 'p1', product_name: 'Magnesium', price: 50, custom_cogs: null, stock: 0 }] });
    if (path === '/timeseries/skus') { const from = String((body.search_params as { date_range: { from: string } }).date_range.from); const span = Math.round((NOW - Date.parse(from + 'T00:00:00Z')) / 86400000); return json({ data: [{ sku_id: 's1', units_sold: span >= 30 ? 60 : 14, gmv: 1, orders: 1 }, { sku_id: 's2', units_sold: span >= 30 ? 9 : 2, gmv: 1, orders: 1 }], has_more: false }); }
    return json({ error: 'unknown path ' + path }, 404);
  }) as unknown as typeof fetch;
  return { rest: new CruvaRest('key', 'https://api.cruva.com', fetchFn), calls };
}

describe('Cruva pull', () => {
  it('pivots stats into days and 7-day metrics', () => {
    const days = daysFromStats([{ key: 'total_gmv', title: '', total: 0, change_pct: null, days: series(10, 15) }, { key: 'dms_sent', title: '', total: 0, change_pct: null, days: series(5, 15) }]);
    expect(days).toHaveLength(15);
    expect(days[0]).toMatchObject({ total_gmv: 10, dms: 5, affiliate_gmv: 0 });
    const m = metricsFromDays(days, NOW);
    expect(m.total_gmv_7d).toBe(70);
    expect(m.total_gmv_prev_7d).toBe(70);
    expect(m.dms_sent_7d).toBe(35);
  });

  it('pulls every linked shop: daily GMV, metrics, score, samples, automations and stock, and records a failed shop', async () => {
    const q = new Queries(openTestDb());
    const shops = q.listShops('cruva');
    expect(shops.length).toBeGreaterThan(10);
    const { rest, calls } = fakeRest({ failShop: shops[1].shop_id });
    const puller = new CruvaPuller(q, rest);
    const r = await puller.run(undefined, NOW);
    expect(r.shops).toBe(shops.length - 1);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatch(shops[1].shop_name);
    const pulls = q.latestHealthPulls('cruva');
    const good = pulls.find((p) => p.shop_id === shops[0].shop_id)!;
    expect(good.ok).toBe(true);
    expect(good.metrics).toMatchObject({ total_gmv_7d: 7000, affiliate_gmv_7d: 4900, dms_sent_7d: 560, samples_approved_7d: 21, sps: 3.2, samples_pending_review: 7, samples_pending_review_oldest_hours: 96, content_pending: 25, automations_active: 1, automations_total: 2, out_of_stock_skus: 1 });
    expect((good.rows as { days: unknown[] }).days).toHaveLength(28);
    expect(pulls.find((p) => p.shop_id === shops[1].shop_id)!.ok).toBe(false);
    // Daily GMV landed for the Performance page.
    const gmv = q.listGmvBetween(day(7), day(0)).filter((x) => x.shop_id === shops[0].shop_id);
    expect(gmv).toHaveLength(8);
    expect(gmv[0]).toMatchObject({ total_gmv: 1000, affiliate_gmv: 700, units: 40 });
    // Stock snapshot carries the Cruva source and velocity from the two windows.
    const stock = q.listStock(shops[0].shop_id);
    expect(stock).toHaveLength(2);
    expect(stock.find((s) => s.sku_id === 's1')).toMatchObject({ source: 'cruva', on_hand: 12, sold_7d: 14, sold_30d: 60, product_title: 'Magnesium' });
    expect(puller.status()).toMatchObject({ configured: true, running: false, shops: shops.length, shops_ok: shops.length - 1 });
    expect(calls.filter((c) => c.shop === shops[0].shop_id).map((c) => c.path).sort()).toEqual(['/affiliate/samples/funnel', '/automations/list', '/shop/skus', '/shop/sps', '/shop/stats', '/timeseries/skus', '/timeseries/skus']);
    // Monitor rules read the pull: low score, review backlog, content pending.
    const engine = new HealthEngine(q);
    const flags = engine.cruvaFlags(new Set(['c_sps_low', 'c_samples_waiting', 'c_content_pending', 'c_dms_stopped', 'c_automations_off']), NOW);
    const mine = flags.filter((f) => f.shop_id === shops[0].shop_id).map((f) => f.code).sort();
    expect(mine).toEqual(['c_content_pending', 'c_samples_waiting', 'c_sps_low']);
    // The overview fills the gaps from Cruva for an account with no TikTok shop.
    const o = engine.accountOverview(shops[0].account_id, [], NOW)!;
    expect(o.series_source).toBe('cruva');
    expect(o.series.length).toBeGreaterThan(20);
    expect(o.kpis.find((k) => k.key === 'gmv_7d')).toMatchObject({ value: 7000, via: 'cruva' });
    expect(o.kpis.find((k) => k.key === 'samples_pending')).toMatchObject({ value: 7, via: 'cruva' });
    expect(o.kpis.find((k) => k.key === 'shop_score')).toMatchObject({ value: 3.2, via: 'cruva' });
    expect(o.cruva_shops.length).toBeGreaterThan(0);
    // The stock page lists the Cruva shop because no TikTok shop covers it.
    const tracker = new StockTracker(q);
    const row = tracker.data().shops.find((s) => s.shop_id === shops[0].shop_id)!;
    expect(row).toMatchObject({ source: 'cruva', skus: 2, out: 1 });
    expect(tracker.projection(shops[0].shop_id, 30).rows.find((r) => r.sku_id === 's1')).toMatchObject({ on_hand: 12, send_in: expect.any(Number) });
  });

  it('keeps Windsor as the GMV source where it has rows and lets Cruva fill the other markets', () => {
    expect(marketOfShopName('Kijimea IT')).toBe('IT');
    expect(marketOfShopName('TBC (DE)')).toBe('DE');
    expect(marketOfShopName('Vaseline - FR')).toBe('FR');
    expect(marketOfShopName('Sacheu Beauty UK [External]')).toBe('UK');
    expect(marketOfShopName('Belively')).toBeNull();
    const mine = [{ shop_id: 'w1', shop_name: 'Kijimea DE', source: 'windsor' as const }, { shop_id: 'c1', shop_name: 'Kijimea DE', source: 'cruva' as const }, { shop_id: 'c2', shop_name: 'Kijimea FR', source: 'cruva' as const }];
    expect(shopsForGmv(mine, (id) => id === 'w1').map((s) => s.shop_id)).toEqual(['w1', 'c2']);
    expect(shopsForGmv(mine, () => false).map((s) => s.shop_id)).toEqual(['w1', 'c1', 'c2']);
    expect(shopsForGmv([{ shop_id: 'w9', shop_name: 'Belively', source: 'windsor' as const }, ...mine.slice(1)], (id) => id === 'w9').map((s) => s.shop_id)).toEqual(['w9']);
  });

  it('builds the alerts calendar from incidents, flags and checklist records', () => {
    const q = new Queries(openTestDb());
    const a = q.listAccounts()[0];
    q.applyScan([{ account_id: a.id, shop_id: null, code: 'c_sps_low', severity: 'crit', message: `${a.name}: score low`, detail: null }], { codes: ['c_sps_low'] });
    const inc = q.createIncident({ account_id: a.id, shop_id: null, kind: 'account_at_risk', severity: 'warn', title: 'At risk', message: 'red review', recommended_action: 'look', owner: null, owner_slack_id: null, source: 'monitor', dedupe_key: 'k1', slack_channel: '#ops' });
    const month = new Date().toISOString().slice(0, 7);
    const cal = buildAlertCalendar(q, month);
    const today = cal.days.find((d) => d.date === cal.today)!;
    expect(today.light).toBe('crit');
    expect(today.crit).toBe(1);
    expect(today.warn).toBe(1);
    const acc = today.accounts.find((x) => x.account_id === a.id)!;
    expect(acc.light).toBe('crit');
    expect(acc.incidents[0]).toMatchObject({ id: inc.id, slack_channel: '#ops', opened_today: true });
    expect(acc.flags[0]).toMatchObject({ code: 'c_sps_low', severity: 'crit' });
    expect(cal.totals.days_red).toBe(1);
    expect(cal.days.filter((d) => d.date > cal.today).every((d) => d.light === 'none')).toBe(true);
  });

  it('saves per-shop switches and languages on a reply policy', () => {
    const q = new Queries(openTestDb());
    const a = q.createAccount({ name: 'Nutori', markets: 'DE/FR', am_name: 'Elena', aa_name: null, enabled: true, notes: null, commission_pct: null, commission_basis: 'gmv', settlement_pct: 100, slack_channel: null, client_slack_channel: null, client_domain: null });
    for (const [id, m] of [['sh-de', 'DE'], ['sh-fr', 'FR']]) { q.upsertTtsShop({ id, name: `Nutori ${m}`, region: m, seller_type: 'LOCAL', cipher: 'x' }, { access_token: 'a', refresh_token: 'r', access_token_expire_in: 9999999999, refresh_token_expire_in: 9999999999 }); q.linkTtsShop(id, a.id, m); }
    const p = savePolicy(q, a.id, 'affiliate', { mode: 'draft', shops_off: ['sh-fr', 'not-mine'], languages: { 'sh-de': 'de', 'sh-fr': 'xx', other: 'en' } });
    expect(p.shops_off).toEqual(['sh-fr']);
    expect(p.languages).toEqual({ 'sh-de': 'de' });
    expect(q.getReplyPolicy(a.id, 'affiliate')!.shops_off).toEqual(['sh-fr']);
  });
});
