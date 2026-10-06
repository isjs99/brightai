import type { Queries } from '../db/queries.js';
import type { SyncFeed, SyncStatus } from '../sweep/types.js';
import { describeSchedule, nextRun } from './describe.js';
import { CRUVA_PULL_EVERY_HOURS } from '../cruva/pull.js';

/**
 * What scans when, for the strip at the top of every Accounts tab: each data feed with its schedule
 * (shown in the team's timezone, CET by default), its next run, when it last ran and whether it failed.
 */

export interface SyncSources {
  monitor: { last_scan_at: string | null; last_scan_error: string | null; scanning: boolean; interval_minutes: number };
  health: { configured: boolean; last_pull_at: string | null; last_pull_error: string | null; pulling: boolean; tts_last_pull_at: string | null; tts_last_pull_error: string | null; pulling_tts: boolean; tts_configured: boolean };
  cruvaPull: { configured: boolean; running: boolean; last_run_at: string | null; last_error: string | null };
  stock: { last_scan_at: string | null; last_scan_error: string | null; scanning: boolean; configured: boolean };
  playbook: { configured: boolean; last_check_at: string | null; last_error: string | null; checking: boolean };
  inbox: { configured: boolean; last_sync_at: string | null; last_sync_error: string | null; poll_seconds: number };
  copilot: { configured: boolean; last_index_at: string | null; last_index_error: string | null };
  clientTasks: { last_scan_at: string | null; last_scan_error: string | null; scanning: boolean };
  reportsQueue: { last_tick_at: string | null };
  windsor: { configured: boolean; last_sync_at: string | null; last_error: string | null };
  tldv: { configured: boolean; last_check_at: string | null };
}

const every = (minutes: number): string => (minutes >= 60 ? (minutes % 60 === 0 ? `Every ${minutes / 60 === 1 ? 'hour' : `${minutes / 60} hours`}` : `Every ${Math.round(minutes / 60 * 10) / 10} hours`) : `Every ${minutes} min`);
const plusMinutes = (iso: string | null, minutes: number): string | null => (iso ? new Date(Date.parse(iso) + minutes * 60000).toISOString() : null);

export function syncStatus(q: Queries, s: SyncSources, now = new Date()): SyncStatus {
  const tz = q.getSetting('check_timezone', 'Europe/Madrid');
  const cronFeed = (key: string, label: string, feeds: string, expr: string, last: string | null, err: string | null, running: boolean, configured = true): SyncFeed => ({
    key, label, feeds, schedule_text: describeSchedule(expr, tz), next_run_at: nextRun(expr, tz, now)?.toISOString() ?? null, last_run_at: last, last_error: err || null, running, configured,
  });
  const intervalFeed = (key: string, label: string, feeds: string, minutes: number, last: string | null, err: string | null, running: boolean, configured = true): SyncFeed => ({
    key, label, feeds, schedule_text: every(minutes), next_run_at: plusMinutes(last, minutes), last_run_at: last, last_error: err || null, running, configured,
  });
  const feeds: SyncFeed[] = [
    intervalFeed('monitor', 'Account monitor', 'Overview flags, calendar lights, checklist flags', s.monitor.interval_minutes, s.monitor.last_scan_at, s.monitor.last_scan_error, s.monitor.scanning),
    cronFeed('health', 'Windsor daily pull', 'Orders, stock, payouts and statements per shop', q.getSetting('health_cron', '30 6 * * *'), s.health.last_pull_at, s.health.last_pull_error, s.health.pulling, s.health.configured),
    intervalFeed('tts', 'TikTok Shop pull', 'Orders, products and analytics for authorised shops', 60 * 4, s.health.tts_last_pull_at, s.health.tts_last_pull_error, s.health.pulling_tts, s.health.tts_configured),
    intervalFeed('cruva', 'Cruva pull', 'GMV, creators, videos, samples, DMs, score and stock for every linked shop', CRUVA_PULL_EVERY_HOURS * 60, s.cruvaPull.last_run_at, s.cruvaPull.last_error, s.cruvaPull.running, s.cruvaPull.configured),
    cronFeed('gmv', 'GMV sync', 'GMV & bonus, P&L actuals', q.getSetting('gmv_sync_cron', '15 7 * * *'), s.windsor.last_sync_at, s.windsor.last_error, false, s.windsor.configured),
    intervalFeed('stock', 'Stock snapshot', 'Stock countdown and alerts', 6 * 60, s.stock.last_scan_at, s.stock.last_scan_error, s.stock.scanning, s.stock.configured),
    cronFeed('playbook', 'Cruva best practice check', 'Cruva setup matrix', '20 5 * * *', s.playbook.last_check_at, s.playbook.last_error, s.playbook.checking, s.playbook.configured),
    cronFeed('checklist', 'Checklist lock', 'The day’s record and the Slack digest', q.getSetting('check_cron', '0 16 * * 1-5'), q.getSetting('check_last_run_at', '') || null, null, false, q.getSetting('check_enabled', '1') !== '0'),
    cronFeed('reminder', 'AM reminder', 'Slack nudge for unticked lines', q.getSetting('reminder_cron', '0 14 * * 1-5'), q.getSetting('reminder_last_run_at', '') || null, null, false),
    intervalFeed('inbox', 'Creator & CS inbox', 'Creators and Customer service threads and replies', Math.max(1, Math.round(s.inbox.poll_seconds / 60)), s.inbox.last_sync_at, s.inbox.last_sync_error, false, s.inbox.configured),
    cronFeed('replies_digest', 'Replies digest', 'Monday summary of creator and CS replies', '50 8 * * 1', q.getSetting('replies_digest_last_at', '') || null, null, false),
    intervalFeed('copilot', 'Evidence index', 'Ask, Reports context and client tasks: calls, emails, client Slack, SOPs', 5, s.copilot.last_index_at, s.copilot.last_index_error, false, s.copilot.configured),
    intervalFeed('tldv', 'tl;dv calls', 'Call notes and transcripts', 30, s.tldv.last_check_at, null, false, s.tldv.configured),
    intervalFeed('client_tasks', 'Client task scan', 'Ad hoc client tasks from Slack, email and calls', 30, s.clientTasks.last_scan_at, s.clientTasks.last_scan_error, s.clientTasks.scanning),
    intervalFeed('reports_queue', 'Report queue', 'Scheduled reports and autosend', 10, s.reportsQueue.last_tick_at, null, false),
  ];
  return { timezone: tz, now: now.toISOString(), feeds };
}

/** Which feeds matter on which Accounts tab. */
export const FEEDS_BY_TAB: Record<string, string[]> = {
  '/monitor': ['monitor', 'health', 'tts', 'cruva', 'gmv'],
  '/checklists': ['checklist', 'reminder', 'monitor', 'client_tasks'],
  '/calendar': ['checklist', 'monitor', 'cruva'],
  '/promotions': ['tts', 'monitor'],
  '/gmv-max': ['tts', 'cruva'],
  '/stock': ['stock', 'cruva', 'tts'],
  '/pnl': ['gmv', 'cruva', 'stock'],
  '/cruva': ['cruva', 'playbook'],
  '/playbook': ['cruva', 'playbook'],
  '/creators': ['inbox', 'replies_digest', 'cruva'],
  '/customer-service': ['inbox', 'replies_digest'],
  '/reports': ['reports_queue', 'copilot', 'tldv', 'gmv', 'cruva'],
  '/copilot': ['copilot', 'tldv', 'inbox'],
};
