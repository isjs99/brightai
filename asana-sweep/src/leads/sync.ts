import { Queries } from '../db/queries.js';
import { log } from '../logger.js';
import { liveEvents } from '../live/events.js';
import { leadsFromCsv, sheetCsvUrl } from './sheet.js';
import type { LeadsSettings, LeadsSyncStatus } from '../sweep/types.js';

let syncing = false;

export function leadsSettings(q: Queries): LeadsSettings {
  const sheet_id = q.getSetting('leads_sheet_id', '');
  const sheet_tab = q.getSetting('leads_sheet_tab', 'Core Lead List');
  const envUrl = (process.env.LEADS_CSV_URL ?? '').trim();
  return {
    sheet_id,
    sheet_tab,
    sync_enabled: q.getSetting('leads_sync_enabled', '1') === '1',
    sync_seconds: Math.max(30, Number(q.getSetting('leads_sync_seconds', '180')) || 180),
    points_signed: Number(q.getSetting('leads_points_signed', '1')) || 0,
    points_sourced: Number(q.getSetting('leads_points_sourced', '1')) || 0,
    currency: q.getSetting('leads_currency', 'GBP') || 'GBP',
    csv_url: envUrl || (sheet_id ? sheetCsvUrl(sheet_id, sheet_tab) : ''),
    csv_url_from_env: Boolean(envUrl),
  };
}

export function leadsSyncStatus(q: Queries): LeadsSyncStatus {
  const at = q.getSetting('leads_last_sync_at', '');
  let columns: string[] = [];
  try {
    columns = JSON.parse(q.getSetting('leads_last_sync_columns', '[]')) as string[];
  } catch {
    columns = [];
  }
  return {
    last_sync_at: at || null,
    status: at ? (q.getSetting('leads_last_sync_status', 'ok') === 'error' ? 'error' : 'ok') : 'never',
    error: q.getSetting('leads_last_sync_error', '') || null,
    rows: Number(q.getSetting('leads_last_sync_rows', '0')) || 0,
    columns,
  };
}

/** Apply CSV text (from the sheet or a manual paste) to the leads table and record the outcome. */
export function importLeadsCsv(q: Queries, csv: string, source: 'sheet' | 'import'): ReturnType<Queries['upsertLeads']> & { rows: number } {
  const { leads, columns } = leadsFromCsv(csv);
  if (leads.length === 0) throw new Error('No lead rows found (every row needs a client name).');
  const result = q.upsertLeads(leads);
  const now = new Date().toISOString();
  q.setSetting('leads_last_sync_at', now);
  q.setSetting('leads_last_sync_status', 'ok');
  q.setSetting('leads_last_sync_error', '');
  q.setSetting('leads_last_sync_rows', String(leads.length));
  q.setSetting('leads_last_sync_columns', JSON.stringify(columns));
  q.setSetting('leads_last_sync_source', source);
  if (result.added || result.updated || result.removed) {
    log.info(`Leads ${source}: ${leads.length} rows, +${result.added} ~${result.updated} -${result.removed}${result.newly_signed.length ? `, signed: ${result.newly_signed.join(', ')}` : ''}`);
    liveEvents.emitUpdate({ kind: 'leads' });
  }
  return { ...result, rows: leads.length };
}

export async function syncLeads(q: Queries, fetchText: (url: string) => Promise<string> = defaultFetch): Promise<{ ok: boolean; error?: string; rows?: number; added?: number; updated?: number; removed?: number }> {
  if (syncing) return { ok: false, error: 'A sync is already running.' };
  syncing = true;
  try {
    const s = leadsSettings(q);
    if (!s.csv_url) throw new Error('No sheet configured. Set the sheet id in Leads settings.');
    const csv = await fetchText(s.csv_url);
    if (/<html/i.test(csv.slice(0, 200))) throw new Error('Google returned a sign-in page instead of CSV. Share the sheet as "Anyone with the link can view", or set LEADS_CSV_URL.');
    const r = importLeadsCsv(q, csv, 'sheet');
    return { ok: true, ...r };
  } catch (err) {
    const message = (err as Error).message;
    q.setSetting('leads_last_sync_at', new Date().toISOString());
    q.setSetting('leads_last_sync_status', 'error');
    q.setSetting('leads_last_sync_error', message);
    log.error(`Leads sync failed: ${message}`);
    liveEvents.emitUpdate({ kind: 'leads' });
    return { ok: false, error: message };
  } finally {
    syncing = false;
  }
}

async function defaultFetch(url: string): Promise<string> {
  const res = await fetch(url, { redirect: 'follow', headers: { accept: 'text/csv,*/*' } });
  if (!res.ok) throw new Error(`Sheet fetch failed (${res.status}). Is the sheet shared "Anyone with the link"?`);
  return res.text();
}

/** Polls the sheet every N seconds so the dashboard tracks the lead list in near real time. */
export class LeadsWatcher {
  private timer: NodeJS.Timeout | null = null;

  constructor(private q: Queries) {}

  start(): void {
    this.stop();
    const s = leadsSettings(this.q);
    if (!s.sync_enabled || !s.csv_url) {
      log.info('Leads sync is off');
      return;
    }
    this.timer = setInterval(() => void syncLeads(this.q), s.sync_seconds * 1000);
    this.timer.unref?.();
    log.info(`Leads sync every ${s.sync_seconds}s from ${s.csv_url_from_env ? 'LEADS_CSV_URL' : 'the lead sheet'}`);
    void syncLeads(this.q);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  get running(): boolean {
    return this.timer !== null;
  }
}
