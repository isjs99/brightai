import { expect, it } from 'vitest';
import { openTestDb } from '../src/db/index';
import { Queries } from '../src/db/queries';

it('lists 6,000 prospects with their contacts and the latest outreach only, fast, and serves the monitor pulls from memory until a write', { timeout: 120000 }, () => {
  const q = new Queries(openTestDb());
  const base = q.listProspects(true).length;
  const rows = [];
  for (let i = 0; i < 6000; i++) rows.push({ seller_id: `s${i}`, shop_name: `Shop ${i}`, market: ['UK', 'DE', 'FR', 'ES', 'IT'][i % 5], gmv_7d: i * 10, gmv_total: i * 100, currency: 'EUR', source: 'fastmoss', pulled_at: new Date().toISOString() });
  q.upsertProspects(rows as never);
  const all = q.listProspects(true);
  expect(all).toHaveLength(base + 6000);
  const first = all.find((p) => p.seller_id === 's1')!;
  for (let c = 0; c < 3; c++) q.addContact(first.id, { name: `Person ${c}`, email: `p${c}@x.com`, title: 'Founder' });
  for (let e = 0; e < 25; e++) q.logOutreach(first.id, { channel: 'gmail', action: 'contacted', note: `note ${e}` });
  for (const p of all.filter((x) => x.id !== first.id).slice(0, 2000)) for (let e = 0; e < 3; e++) q.logOutreach(p.id, { channel: 'linkedin', action: 'note', note: 'x' });

  const t0 = performance.now();
  const page = q.listProspects(false, { logLimit: 10 });
  const t1 = performance.now();
  const full = q.listProspects(false);
  const t2 = performance.now();
  const p = page.find((x) => x.id === first.id)!;
  expect(p.contacts).toHaveLength(3);
  expect(p.outreach_log).toHaveLength(10);
  expect(p.outreach_log[0].note).toBe('note 24');
  expect(p.outreach_count).toBe(25);
  const f = full.find((x) => x.id === first.id)!;
  expect(f.outreach_log).toHaveLength(25);
  expect(f.outreach_count).toBe(25);
  expect(q.getProspect(first.id)!.outreach_count).toBe(25);
  expect(JSON.stringify(page).length).toBeLessThan(JSON.stringify(full).length);
  expect(t1 - t0).toBeLessThan(3000);
  expect(t2 - t1).toBeLessThan(3000);

  // The change stamp moves only on writes, so a cached payload knows when it is stale.
  const s1 = q.changeStamp();
  expect(q.changeStamp()).toBe(s1);
  q.upsertHealthPull({ shop_id: 'sh1', account_id: null, source: 'tts', pull_date: '2026-10-01', ok: true, error: null, metrics: { gmv_7d: 5 }, rows: { analytics: [{ date: '2026-10-01', gmv: 5 }] } });
  expect(q.changeStamp()).toBeGreaterThan(s1);
  const a = q.latestHealthPulls('tts');
  expect(a).toHaveLength(1);
  expect(q.latestHealthPulls('tts')).toBe(a); // same array: no re-parse
  q.upsertHealthPull({ shop_id: 'sh1', account_id: null, source: 'tts', pull_date: '2026-10-02', ok: true, error: null, metrics: { gmv_7d: 6 }, rows: {} });
  const b = q.latestHealthPulls('tts');
  expect(b).not.toBe(a);
  expect(b[0].pull_date).toBe('2026-10-02');
});
