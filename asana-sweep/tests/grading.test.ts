import { describe, it, expect } from 'vitest';
import { attainmentOf, gradeOf, projectMonth, scoreOf } from '../src/gmv/grading';
import { workdaysInMonth, daysInMonth, previousMonth, monthRange } from '../src/checklist/calendar';
import { parseStats } from '../src/gmv/cruva';

describe('grading', () => {
  it('blends compliance and attainment by weight', () => {
    expect(scoreOf({ compliance: 100, attainment: 100, weightChecklist: 50 })).toBe(100);
    expect(scoreOf({ compliance: 80, attainment: 60, weightChecklist: 50 })).toBe(70);
    expect(scoreOf({ compliance: 80, attainment: 60, weightChecklist: 100 })).toBe(80);
    expect(scoreOf({ compliance: 80, attainment: 60, weightChecklist: 0 })).toBe(60);
  });

  it('caps attainment at 100 for scoring and grades on one side when the other is missing', () => {
    expect(scoreOf({ compliance: 50, attainment: 250, weightChecklist: 50 })).toBe(75);
    expect(scoreOf({ compliance: null, attainment: 90, weightChecklist: 50 })).toBe(90);
    expect(scoreOf({ compliance: 70, attainment: null, weightChecklist: 50 })).toBe(70);
    expect(scoreOf({ compliance: null, attainment: null, weightChecklist: 50 })).toBeNull();
  });

  it('maps scores to letters', () => {
    expect(gradeOf(95)).toBe('A');
    expect(gradeOf(90)).toBe('A');
    expect(gradeOf(85)).toBe('B');
    expect(gradeOf(72)).toBe('C');
    expect(gradeOf(60)).toBe('D');
    expect(gradeOf(59)).toBe('F');
    expect(gradeOf(null)).toBeNull();
  });

  it('computes attainment and projection', () => {
    expect(attainmentOf(50000, 100000)).toBe(50);
    expect(attainmentOf(50000, null)).toBeNull();
    expect(attainmentOf(50000, 0)).toBeNull();
    expect(projectMonth(30000, 15, 30)).toBe(60000);
    expect(projectMonth(30000, 0, 30)).toBeNull();
  });
});

describe('calendar helpers', () => {
  it('lists Monday to Friday only', () => {
    const days = workdaysInMonth('2026-09');
    expect(days[0]).toBe('2026-09-01'); // Tuesday
    expect(days).toHaveLength(22);
    expect(days).not.toContain('2026-09-05'); // Saturday
    expect(workdaysInMonth('2026-09', '2026-09-16')).toHaveLength(12);
  });

  it('month arithmetic', () => {
    expect(daysInMonth('2026-02')).toBe(28);
    expect(previousMonth('2026-01')).toBe('2025-12');
    expect(monthRange('2026-09')).toEqual({ from: '2026-09-01', to: '2026-09-30' });
  });
});

describe('parseStats', () => {
  it('reads per-stat series keyed by date', () => {
    const rows = parseStats({ total_gmv: { value: 10, series: { '2026-09-01': 4, '2026-09-02': 6 } }, affiliate_gmv: { series: { '2026-09-01': 3 } }, total_units_sold: { series: { '2026-09-02': 2 } } });
    expect(rows).toEqual([
      { date: '2026-09-01', total_gmv: 4, affiliate_gmv: 3, units: 0 },
      { date: '2026-09-02', total_gmv: 6, affiliate_gmv: 0, units: 2 },
    ]);
  });

  it('reads arrays of day rows and point arrays', () => {
    expect(parseStats({ data: [{ date: '2026-09-01', total_gmv: '1,200.5', affiliate_gmv: 100, total_units_sold: 3 }] })).toEqual([{ date: '2026-09-01', total_gmv: 1200.5, affiliate_gmv: 100, units: 3 }]);
    expect(parseStats({ total_gmv: [{ date: '2026-09-01', value: 5 }] })[0].total_gmv).toBe(5);
    expect(parseStats(null)).toEqual([]);
  });
});
