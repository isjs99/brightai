import { log } from './logger.js';

/**
 * Event-loop lag and slow requests, so a slow dashboard can be read off /api/health and the logs instead of
 * guessed at. Lag is how late a 1-second timer fires; anything over a second means a synchronous job held the
 * process and every request waited behind it.
 */

const SAMPLES = 120;
const lags: number[] = [];
const slow: { at: string; method: string; path: string; ms: number }[] = [];
let timer: NodeJS.Timeout | null = null;
let last = Date.now();

export function startPerfMonitor(): void {
  if (timer) return;
  last = Date.now();
  timer = setInterval(() => {
    const now = Date.now();
    const lag = Math.max(0, now - last - 1000);
    last = now;
    lags.push(lag);
    if (lags.length > SAMPLES) lags.shift();
    if (lag > 1000) log.warn(`Event loop blocked for ~${(lag / 1000).toFixed(1)}s (a synchronous job held the server; see the job logged just before this)`);
  }, 1000);
  timer.unref();
}

export function stopPerfMonitor(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

export function recordRequest(method: string, path: string, ms: number): void {
  if (ms < 1500) return;
  slow.unshift({ at: new Date().toISOString(), method, path, ms: Math.round(ms) });
  if (slow.length > 30) slow.pop();
  log.warn(`Slow request ${method} ${path} took ${(ms / 1000).toFixed(1)}s`);
}

export function perfSnapshot(): { uptime_s: number; lag_now_ms: number; lag_max_2m_ms: number; lag_p95_2m_ms: number; blocked_s_2m: number; rss_mb: number; heap_mb: number } {
  const sorted = [...lags].sort((a, b) => a - b);
  const mem = process.memoryUsage();
  return {
    uptime_s: Math.round(process.uptime()),
    lag_now_ms: lags[lags.length - 1] ?? 0,
    lag_max_2m_ms: sorted[sorted.length - 1] ?? 0,
    lag_p95_2m_ms: sorted[Math.floor(sorted.length * 0.95)] ?? 0,
    blocked_s_2m: Math.round(lags.reduce((n, l) => n + l, 0) / 100) / 10,
    rss_mb: Math.round(mem.rss / 1048576),
    heap_mb: Math.round(mem.heapUsed / 1048576),
  };
}

export function slowRequests(): { at: string; method: string; path: string; ms: number }[] {
  return [...slow];
}
