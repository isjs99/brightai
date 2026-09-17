import type { Queries } from '../db/queries.js';
import type { BdProspect } from '../sweep/types.js';
import { withinDays } from './score.js';
import { sheetCsvUrl, parseCsv } from '../leads/sheet.js';
import { leadsSettings } from '../leads/sync.js';
import { log } from '../logger.js';

/**
 * Enterprise alerts: a household name from the watchlist shows up as a recently launched TikTok
 * Shop (or one whose sales only just started). Scanned after every pull and import.
 */

const norm = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[’']/g, "'").replace(/[^a-z0-9&' ]+/g, ' ').replace(/\s+/g, ' ').trim();

/** Does the shop or brand name carry this watchlist name as a whole word or prefix ("Bosch Home DE" ~ "Bosch")? */
export function nameMatches(shopName: string, brand: string | null, watch: string): boolean {
  const w = norm(watch);
  if (w.length < 3) return false;
  for (const candidate of [shopName, brand ?? '']) {
    const c = norm(candidate);
    if (!c) continue;
    if (c === w) return true;
    const words = c.split(' ');
    const wWords = w.split(' ');
    for (let i = 0; i + wWords.length <= words.length; i += 1) {
      if (wWords.every((x, k) => words[i + k] === x)) return true;
    }
    // Concatenated handles: "sharkninjauk" ~ "sharkninja".
    if (w.length >= 5 && c.replace(/ /g, '').startsWith(w.replace(/ /g, ''))) return true;
  }
  return false;
}

/**
 * Recent = created in the last 90 days, first sales in the last 30 days, or first seen by us after
 * the alert baseline (so the shops already on the pipeline when alerts were switched on do not all fire at once).
 */
export function isRecentLaunch(p: BdProspect, opts: { now?: number; baseline?: string | null } = {}): { recent: boolean; why: string } {
  const now = opts.now ?? Date.now();
  if (p.launched_at && withinDays(p.launched_at, 90, now)) return { recent: true, why: `shop created ${p.launched_at}` };
  if (p.gmv_started_30d) return { recent: true, why: p.gmv_started_at ? `first sales ${p.gmv_started_at}` : `sales started in roughly the last ${p.age_estimate_days ?? 30} days` };
  if (opts.baseline && p.created_at > opts.baseline && withinDays(p.created_at, 30, now)) return { recent: true, why: `new on our radar since ${p.created_at.slice(0, 10)}` };
  return { recent: false, why: '' };
}

export function scanEnterpriseAlerts(q: Queries): { checked: number; new_alerts: number } {
  const watch = q.listWatchlist().filter((w) => w.enabled);
  const prospects = q.listProspects(false).filter((p) => !p.is_client);
  let baseline = q.getSetting('bd_alerts_baseline_at', '');
  if (!baseline) {
    baseline = new Date().toISOString();
    q.setSetting('bd_alerts_baseline_at', baseline);
  }
  let added = 0;
  for (const p of prospects) {
    const hit = watch.find((w) => nameMatches(p.shop_name, p.brand, w.name));
    if (!hit) continue;
    const r = isRecentLaunch(p, { baseline });
    if (!r.recent) continue;
    if (q.addAlert({ prospect_id: p.id, kind: 'enterprise_launch', watch_name: hit.name, message: `${hit.name} looks to have launched on TikTok Shop ${p.market} as "${p.shop_name}" (${r.why})` })) added += 1;
  }
  if (added) log.info(`Enterprise alerts: ${added} new`);
  return { checked: prospects.length, new_alerts: added };
}

/** Pull names from a tab of the lead sheet (first non-empty column, header row skipped) into the watchlist. */
export async function syncWatchlistFromSheet(q: Queries, fetchText: (url: string) => Promise<string> = async (u) => { const r = await fetch(u); if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.text(); }): Promise<{ added: number; total: number }> {
  const tab = q.getSetting('watchlist_sheet_tab', '').trim();
  const { sheet_id } = leadsSettings(q);
  if (!tab || !sheet_id) throw new Error('Set the lead sheet id (Leads > Settings) and the watchlist tab name first.');
  const rows = parseCsv(await fetchText(sheetCsvUrl(sheet_id, tab)));
  let added = 0;
  let total = 0;
  for (const row of rows.slice(1)) {
    const name = row.find((c) => c.trim())?.trim();
    if (!name || name.length < 3 || /^(client|brand|company|name)$/i.test(name)) continue;
    total += 1;
    if (q.addWatchlist(name, 'sheet')) added += 1;
  }
  return { added, total };
}
