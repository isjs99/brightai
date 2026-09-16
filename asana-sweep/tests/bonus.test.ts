import { describe, it, expect } from 'vitest';
import { bonusTarget, DEFAULT_BONUS_RULE, growthPct, requiredGrowthPct } from '../src/gmv/grading';
import { currencyForShop, parseFx, toReportCurrency } from '../src/gmv/currency';

describe('bonus rule', () => {
  it('needs 100% growth under 30k and 40% at or above', () => {
    expect(requiredGrowthPct(12000, DEFAULT_BONUS_RULE)).toBe(100);
    expect(requiredGrowthPct(29999, DEFAULT_BONUS_RULE)).toBe(100);
    expect(requiredGrowthPct(30000, DEFAULT_BONUS_RULE)).toBe(40);
    expect(requiredGrowthPct(120000, DEFAULT_BONUS_RULE)).toBe(40);
    expect(requiredGrowthPct(0, DEFAULT_BONUS_RULE)).toBeNull();
    expect(requiredGrowthPct(null, DEFAULT_BONUS_RULE)).toBeNull();
  });

  it('derives the target from last month', () => {
    expect(bonusTarget(12000, DEFAULT_BONUS_RULE)).toBe(24000);
    expect(bonusTarget(50000, DEFAULT_BONUS_RULE)).toBe(70000);
    expect(bonusTarget(null, DEFAULT_BONUS_RULE)).toBeNull();
  });

  it('computes growth', () => {
    expect(growthPct(24000, 12000)).toBe(100);
    expect(growthPct(9000, 12000)).toBe(-25);
    expect(growthPct(9000, 0)).toBeNull();
  });
});

describe('market currency', () => {
  it('maps shops to their market currency', () => {
    expect(currencyForShop('Kijimea UK')).toBe('GBP');
    expect(currencyForShop('Estrid PL')).toBe('PLN');
    expect(currencyForShop('Estrid AU')).toBe('AUD');
    expect(currencyForShop('Vaseline - DE')).toBe('EUR');
    expect(currencyForShop("Mother's Earth")).toBe('EUR');
    expect(currencyForShop('TBC (DE)')).toBe('EUR');
  });

  it('converts to the report currency with editable rates', () => {
    const fx = parseFx('{"GBP": 1.2}');
    expect(toReportCurrency(100, 'GBP', fx)).toBeCloseTo(120);
    expect(toReportCurrency(100, 'EUR', fx)).toBe(100);
    expect(parseFx('garbage').GBP).toBeGreaterThan(1);
  });
});
