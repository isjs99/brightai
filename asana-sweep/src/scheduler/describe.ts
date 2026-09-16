import cronstrue from 'cronstrue';
import { CronExpressionParser } from 'cron-parser';

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export const CRON_PRESETS: { label: string; cron: string }[] = [
  { label: 'Weekdays 06:30', cron: '30 6 * * 1-5' },
  { label: 'Daily 06:30', cron: '30 6 * * *' },
  { label: 'Hourly', cron: '0 * * * *' },
];

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function validateCron(expr: string): string | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return 'Cron expression must have 5 fields: minute hour day-of-month month day-of-week.';
  try {
    CronExpressionParser.parse(expr.trim());
    return null;
  } catch (err) {
    return `Invalid cron expression: ${(err as Error).message}`;
  }
}

/** Short timezone label such as "CET" or "CEST" (falls back to "GMT+2" style when no abbreviation exists). */
export function tzAbbrev(tz: string, at: Date = new Date()): string {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, timeZoneName: 'short' }).formatToParts(at);
    return parts.find((p) => p.type === 'timeZoneName')?.value ?? tz;
  } catch {
    return tz;
  }
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * Plain English schedule, e.g. "Weekdays 06:30 CEST". Covers the common shapes by hand and
 * falls back to cronstrue for anything else.
 */
export function describeSchedule(expr: string, tz: string): string {
  const abbr = tzAbbrev(tz);
  const parts = expr.trim().split(/\s+/);
  if (parts.length === 5) {
    const [min, hour, dom, month, dow] = parts;
    const isNum = (s: string) => /^\d{1,2}$/.test(s);
    if (isNum(min) && isNum(hour) && dom === '*' && month === '*') {
      const time = `${pad(Number(hour))}:${pad(Number(min))}`;
      if (dow === '*') return `Daily ${time} ${abbr}`;
      if (dow === '1-5') return `Weekdays ${time} ${abbr}`;
      if (dow === '0,6' || dow === '6,0') return `Weekends ${time} ${abbr}`;
      if (/^[0-7](,[0-7])*$/.test(dow)) {
        const names = dow.split(',').map((d) => DAY_NAMES[Number(d) % 7]);
        return `${names.join(', ')} ${time} ${abbr}`;
      }
    }
    if (isNum(min) && hour === '*' && dom === '*' && month === '*' && dow === '*') {
      return Number(min) === 0 ? 'Every hour on the hour' : `Hourly at :${pad(Number(min))}`;
    }
  }
  try {
    return `${cronstrue.toString(expr, { use24HourTimeFormat: true })} ${abbr}`;
  } catch {
    return `${expr} (${abbr})`;
  }
}

export function nextRun(expr: string, tz: string, from: Date = new Date()): Date | null {
  try {
    return CronExpressionParser.parse(expr.trim(), { tz, currentDate: from }).next().toDate();
  } catch {
    return null;
  }
}
