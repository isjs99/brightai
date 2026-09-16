// Pure helpers for the month calendar and compliance maths.

/** YYYY-MM-DD for every Monday to Friday in the month, optionally capped at `upTo` (inclusive). */
export function workdaysInMonth(month: string, upTo?: string): string[] {
  const [y, m] = month.split('-').map(Number);
  const days: string[] = [];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  for (let d = 1; d <= last; d++) {
    const date = new Date(Date.UTC(y, m - 1, d));
    const dow = date.getUTCDay();
    if (dow === 0 || dow === 6) continue;
    const iso = date.toISOString().slice(0, 10);
    if (upTo && iso > upTo) break;
    days.push(iso);
  }
  return days;
}

export function daysInMonth(month: string): number {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

export function monthOf(date: string): string {
  return date.slice(0, 7);
}

export function previousMonth(month: string): string {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 2, 1));
  return d.toISOString().slice(0, 7);
}

export function monthRange(month: string): { from: string; to: string } {
  return { from: `${month}-01`, to: `${month}-${String(daysInMonth(month)).padStart(2, '0')}` };
}

export const pct = (n: number, d: number): number | null => (d > 0 ? Math.round((n / d) * 1000) / 10 : null);
