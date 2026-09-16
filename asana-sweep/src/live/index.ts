import { asana, AsanaClient } from '../asana/client.js';
import { Queries } from '../db/queries.js';
import { log } from '../logger.js';
import { checkAccount, todayIn } from '../checklist/checker.js';
import { runRule } from '../sweep/runner.js';
import { liveEvents } from './events.js';

/**
 * Live watcher. Every `interval` seconds it asks Asana, per linked board, whether any task was
 * modified since the last look (one cheap request per board). On a change it re-evaluates the
 * checklist and, if live sweeping is on, deletes spent recurring copies immediately.
 */
export class LiveWatcher {
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private lastSeen = new Map<number, string>(); // account id -> ISO timestamp of last successful look
  lastTickAt: string | null = null;
  watching = 0;

  constructor(private q: Queries, private client: AsanaClient = asana) {}

  start(): void {
    this.stop();
    if (this.q.getSetting('live_enabled', '1') !== '1') {
      log.info('Live watching is off');
      return;
    }
    const seconds = Math.max(15, Number(this.q.getSetting('live_interval_seconds', '60')) || 60);
    this.timer = setInterval(() => void this.tick(), seconds * 1000);
    this.timer.unref?.();
    log.info(`Live watching every ${seconds}s`);
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  get running(): boolean {
    return this.timer !== null;
  }

  /** Force a full re-evaluation of every board on the next tick. */
  reset(): void {
    this.lastSeen.clear();
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    const startedAt = new Date().toISOString();
    try {
      const tz = this.q.getSetting('check_timezone', 'Europe/Madrid');
      const today = todayIn(tz);
      const accounts = this.q.listAccounts().filter((a) => a.enabled && a.asana_project_gid);
      this.watching = accounts.length;
      const sweep = this.q.getSetting('live_sweep_enabled', '1') === '1';
      let changed = 0;
      for (const account of accounts) {
        const gid = account.asana_project_gid!;
        const since = this.lastSeen.get(account.id);
        const live = this.q.getLive(account.id);
        // First look, a new day, or no live row yet: always evaluate.
        let needs = !since || !live || live.check_date !== today;
        if (!needs) {
          try {
            needs = await this.client.projectChangedSince(gid, since!);
          } catch (err) {
            log.warn(`Live: change check failed for ${account.name}: ${(err as Error).message}`);
            continue;
          }
        }
        if (!needs) continue;
        changed += 1;
        // Overlap the window by a few seconds so a change landing mid-request is not missed.
        const seenAt = new Date(Date.now() - 5000).toISOString();
        if (sweep) {
          const rule = this.q.listRules().find((r) => r.asana_project_gid === gid && r.enabled);
          if (rule) await runRule(this.q, rule, { trigger: 'live', immediate: true, client: this.client });
        }
        await checkAccount(this.q, account, { trigger: 'live', tz, client: this.client });
        this.lastSeen.set(account.id, seenAt);
      }
      // Boards we could not evaluate keep their old timestamp; everything else moves forward.
      for (const account of accounts) if (!this.lastSeen.has(account.id)) this.lastSeen.set(account.id, startedAt);
      this.lastTickAt = new Date().toISOString();
      if (changed) log.info(`Live: ${changed} board(s) changed`);
      liveEvents.emitUpdate({ kind: 'tick' });
    } catch (err) {
      log.error(`Live tick failed: ${(err as Error).message}`);
    } finally {
      this.ticking = false;
    }
  }
}
