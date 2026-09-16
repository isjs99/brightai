import { describe, it, expect } from 'vitest';
import { describeSchedule, nextRun, validateCron } from '../src/scheduler/describe';

describe('describeSchedule', () => {
  it('describes the presets in plain English', () => {
    expect(describeSchedule('30 6 * * 1-5', 'Europe/Madrid')).toMatch(/^Weekdays 06:30 CES?T$/);
    expect(describeSchedule('30 6 * * *', 'Europe/Madrid')).toMatch(/^Daily 06:30 CES?T$/);
    expect(describeSchedule('0 * * * *', 'Europe/Madrid')).toBe('Every hour on the hour');
    expect(describeSchedule('15 * * * *', 'Europe/Madrid')).toBe('Hourly at :15');
    expect(describeSchedule('0 9 * * 1', 'Europe/Madrid')).toMatch(/^Monday 09:00/);
  });

  it('falls back to cronstrue for unusual expressions', () => {
    expect(describeSchedule('*/10 8-18 * * *', 'UTC')).toMatch(/Every 10 minutes/);
  });
});

describe('validateCron / nextRun', () => {
  it('accepts valid and rejects invalid expressions', () => {
    expect(validateCron('30 6 * * 1-5')).toBeNull();
    expect(validateCron('30 6 * *')).toMatch(/5 fields/);
    expect(validateCron('99 6 * * *')).toMatch(/Invalid/);
  });

  it('computes the next run in the rule timezone', () => {
    // Tuesday 2026-09-15 10:00 UTC -> next weekday 06:30 Madrid (CEST, UTC+2) is Wed 16th 04:30 UTC.
    const next = nextRun('30 6 * * 1-5', 'Europe/Madrid', new Date('2026-09-15T10:00:00Z'));
    expect(next?.toISOString()).toBe('2026-09-16T04:30:00.000Z');
  });
});
