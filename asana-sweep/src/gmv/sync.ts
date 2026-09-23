import { Queries } from '../db/queries.js';
import { log } from '../logger.js';
import { cruva, CruvaClient } from './cruva.js';
import { syncWindsorGmv, windsor, WindsorClient } from './windsor.js';
import type { GmvSync } from '../sweep/types.js';

let syncing = false;

export function isGmvSyncing(): boolean {
  return syncing;
}

/** Pull the last `days` days of GMV for every mapped shop from Cruva and upsert. */
export async function syncGmv(q: Queries, opts: { days?: number; client?: CruvaClient; windsorClient?: WindsorClient } = {}): Promise<GmvSync | null> {
  if (syncing) {
    log.warn('GMV sync already running, skipping');
    return null;
  }
  const client = opts.client ?? cruva;
  syncing = true;
  const sync = q.startGmvSync();
  const to = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.now() - (opts.days ?? 10) * 86400000).toISOString().slice(0, 10);
  let synced = 0;
  const errors: string[] = [];
  try {
    const wc = opts.windsorClient ?? windsor;
    const cruvaShops = q.listShops('cruva');
    const windsorShops = q.listShops('windsor');
    if (!client.configured && !wc.configured) throw new Error('Neither CRUVA_API_KEY nor WINDSOR_API_KEY is set. Add one to .env and restart, or import GMV manually.');
    if (client.configured) {
      for (const shop of cruvaShops) {
        try {
          const rows = await client.shopStats(shop.shop_id, from, to);
          q.upsertGmv(rows.map((r) => ({ shop_id: shop.shop_id, ...r })));
          synced += 1;
        } catch (err) {
          errors.push(`${shop.shop_name}: ${(err as Error).message}`);
        }
      }
    } else if (cruvaShops.length) errors.push(`${cruvaShops.length} Cruva shop(s) skipped: CRUVA_API_KEY is not set`);
    if (wc.configured && windsorShops.length) {
      const w = await syncWindsorGmv(q, { days: opts.days ?? 10, client: wc });
      if (w.error) errors.push(`Windsor: ${w.error}`);
      else synced += w.shops;
    }
    const status = errors.length && synced === 0 ? 'error' : 'ok';
    const finished = q.finishGmvSync(sync.id, status, synced, errors.length ? errors.slice(0, 5).join(' | ') + (errors.length > 5 ? ` (+${errors.length - 5} more)` : '') : null);
    log.info(`GMV sync finished: ${synced} shops ok, ${errors.length} failed`);
    return finished;
  } catch (err) {
    log.error(`GMV sync failed: ${(err as Error).message}`);
    return q.finishGmvSync(sync.id, 'error', synced, (err as Error).message);
  } finally {
    syncing = false;
  }
}
