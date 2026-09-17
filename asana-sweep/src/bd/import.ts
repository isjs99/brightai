import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Queries } from '../db/queries.js';
import { log } from '../logger.js';
import { liveEvents } from '../live/events.js';
import { normaliseDomain } from './score.js';
import type { BdProspectInput } from '../sweep/types.js';
import { SEED_ENRICHED } from './seed-enriched.js';

const optText = (v: unknown): string | null => {
  if (v === undefined || v === null) return null;
  const t = String(v).trim();
  return t ? t : null;
};

export const isoDate = (v: unknown): string | null => {
  const t = optText(v);
  if (!t) return null;
  const m = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
};

/** Accepts our own shape or a raw FastMoss shop_search / shop_base_info row. */
export function parseProspectInput(b: Record<string, unknown>): BdProspectInput {
  const shopObj = (b.shop as Record<string, unknown> | undefined) ?? undefined;
  const shop_name = String(b.shop_name ?? b.name ?? shopObj?.shop_name ?? '').trim();
  const market = String(b.market ?? b.region ?? shopObj?.region ?? '').trim().toUpperCase().replace(/^GB$/, 'UK');
  if (!shop_name || !market) throw new Error('Each prospect needs shop_name and market.');
  const num = (v: unknown): number | null => (v === undefined || v === null || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);
  return {
    shop_name,
    market,
    brand: optText(b.brand ?? b.brand_name),
    category: optText(b.category ?? (b.main_category as { name?: string } | undefined)?.name ?? shopObj?.primary_category_name),
    seller_id: optText(b.seller_id ?? shopObj?.seller_id),
    domain: normaliseDomain(optText(b.domain ?? b.website)),
    website: optText(b.website),
    tiktok_handle: optText(b.tiktok_handle ?? (b.linked_creator as { unique_id?: string } | undefined)?.unique_id),
    gmv_7d: num(b.gmv_7d ?? b.gmv_last_7d),
    gmv_total: num(b.gmv_total ?? b.total_gmv),
    units_7d: num(b.units_7d ?? b.units_sold_last_7d),
    units_total: num(b.units_total ?? b.total_units_sold),
    currency: String(b.currency ?? b.currency_code ?? shopObj?.currency_code ?? '').toUpperCase() || (market === 'UK' ? 'GBP' : 'EUR'),
    shop_type: optText(b.shop_type ?? b.shop_type_code ?? shopObj?.shop_type_code)?.replace('_shop', '') ?? null,
    rating: num(b.rating ?? b.shop_rating),
    products: num(b.products ?? b.active_product_count),
    notes: optText(b.notes),
    source: optText(b.source) ?? 'import',
    pulled_at: optText(b.pulled_at) ?? new Date().toISOString(),
    launched_at: isoDate(b.launched_at ?? b.shop_created_date ?? shopObj?.shop_created_date),
    gmv_started_at: isoDate(b.gmv_started_at ?? b.first_sale_date),
  };
}

export const pullsDir = (): string => resolve(process.env.BD_PULLS_DIR?.trim() || join(process.cwd(), 'data', 'bd-pulls'));

/**
 * Import any JSON pull files dropped into data/bd-pulls (one per day, e.g. by the scheduled
 * FastMoss routine committing to the repo). Each file is imported once; the list of imported
 * names lives in settings so a restart does not re-import.
 */
export function importPullFiles(q: Queries): { files: string[]; added: number; updated: number; dir: string } {
  const dir = pullsDir();
  const result = { files: [] as string[], added: 0, updated: 0, dir };
  if (!existsSync(dir)) return result;
  let done: string[] = [];
  try {
    done = JSON.parse(q.getSetting('bd_pulls_imported', '[]')) as string[];
  } catch {
    done = [];
  }
  const files = readdirSync(dir).filter((f) => f.endsWith('.json') && !done.includes(f)).sort();
  for (const f of files) {
    try {
      const raw = JSON.parse(readFileSync(join(dir, f), 'utf8')) as { pulled_at?: string; shops?: Record<string, unknown>[]; prospects?: Record<string, unknown>[] } | Record<string, unknown>[];
      const rows = Array.isArray(raw) ? raw : (raw.shops ?? raw.prospects ?? []);
      const pulledAt = (!Array.isArray(raw) && optText(raw.pulled_at)) || f.replace(/\.json$/, '');
      const parsed: BdProspectInput[] = [];
      let skipped = 0;
      for (const row of rows) {
        try {
          parsed.push(parseProspectInput({ pulled_at: pulledAt, source: 'fastmoss', ...row }));
        } catch {
          skipped += 1; // FastMoss occasionally returns rows with an empty shop name
        }
      }
      const r = q.upsertProspects(parsed);
      result.added += r.added;
      result.updated += r.updated;
      result.files.push(f);
      done.push(f);
      log.info(`BD pull ${f}: +${r.added} new, ${r.updated} refreshed${skipped ? `, ${skipped} row(s) skipped` : ''}`);
    } catch (err) {
      log.error(`BD pull ${f} failed: ${(err as Error).message}`);
    }
  }
  if (result.files.length) {
    q.setSetting('bd_pulls_imported', JSON.stringify(done.slice(-365)));
    applyEnrichedSeed(q);
    liveEvents.emitUpdate({ kind: 'bd' });
  }
  return result;
}

/**
 * Attach the decision makers found in the Apollo enrichment runs (src/bd/seed-enriched.ts) to
 * whichever of those shops are in the pipeline. Idempotent: contacts dedupe by Apollo id, and
 * domain / organisation id only fill blanks. Runs from migration 16 and after every pull import,
 * since pulls can add shops the enrichment already covered.
 */
export function applyEnrichedSeed(q: Queries): { shops: number; contacts: number } {
  let shops = 0;
  let contacts = 0;
  const bySeller = new Map(q.listProspects(true).filter((p) => p.seller_id).map((p) => [p.seller_id as string, p]));
  for (const s of SEED_ENRICHED) {
    const p = bySeller.get(s.seller_id);
    if (!p) continue;
    shops += 1;
    if ((s.domain && !p.domain) || (s.apollo_org_id && !p.apollo_org_id)) q.patchProspect(p.id, { ...(s.domain && !p.domain ? { domain: s.domain, website: p.website ?? s.domain } : {}), ...(s.apollo_org_id && !p.apollo_org_id ? { apollo_org_id: s.apollo_org_id } : {}) });
    for (const c of s.contacts) {
      if (p.contacts.some((x) => x.apollo_id === c.apollo_id)) continue;
      q.addContact(p.id, { name: c.name, title: c.title, email: c.email, linkedin_url: c.linkedin_url, source: 'apollo', apollo_id: c.apollo_id, enriched: Boolean(c.email || c.linkedin_url), notes: c.note });
      contacts += 1;
    }
  }
  if (contacts) log.info(`Enriched seed: ${contacts} contact(s) attached across ${shops} shop(s)`);
  return { shops, contacts };
}
