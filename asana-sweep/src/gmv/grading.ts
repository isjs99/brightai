// Pure grading logic. Score = weighted mix of checklist compliance (target 100%) and GMV
// attainment against the monthly target (capped at 100% for scoring). Tested in tests/grading.test.ts.

import type { Grade } from '../sweep/types.js';

export interface GradeInput {
  compliance: number | null; // 0..100, null when nothing was checked
  attainment: number | null; // 0..∞, null when no target or no GMV data
  weightChecklist: number; // 0..100, share of the score from checklist compliance
}

export function scoreOf({ compliance, attainment, weightChecklist }: GradeInput): number | null {
  const w = Math.min(100, Math.max(0, weightChecklist)) / 100;
  const c = compliance === null ? null : Math.min(100, Math.max(0, compliance));
  const a = attainment === null ? null : Math.min(100, Math.max(0, attainment));
  if (c === null && a === null) return null;
  // If one side is missing, grade on the other alone rather than punishing for missing data.
  if (c === null) return Math.round(a!);
  if (a === null) return Math.round(c);
  return Math.round(w * c + (1 - w) * a);
}

export function gradeOf(score: number | null): Grade | null {
  if (score === null) return null;
  if (score >= 90) return 'A';
  if (score >= 80) return 'B';
  if (score >= 70) return 'C';
  if (score >= 60) return 'D';
  return 'F';
}

export const attainmentOf = (gmv: number, target: number | null): number | null => (target && target > 0 ? Math.round((gmv / target) * 1000) / 10 : null);

export interface BonusRule {
  threshold: number; // previous-month GMV at which the lower growth rate applies (30k)
  growthBelowPct: number; // required MoM growth below the threshold (100)
  growthAbovePct: number; // required MoM growth at or above the threshold (40)
}

export const DEFAULT_BONUS_RULE: BonusRule = { threshold: 30000, growthBelowPct: 100, growthAbovePct: 40 };

/** Required growth for an account given last month's GMV. Null when there is no base to grow from. */
export function requiredGrowthPct(prevGmv: number | null, rule: BonusRule): number | null {
  if (prevGmv === null || prevGmv <= 0) return null;
  return prevGmv < rule.threshold ? rule.growthBelowPct : rule.growthAbovePct;
}

/** The GMV this month must reach for the bonus: last month × (1 + required growth). */
export function bonusTarget(prevGmv: number | null, rule: BonusRule): number | null {
  const g = requiredGrowthPct(prevGmv, rule);
  return g === null ? null : Math.round(prevGmv! * (1 + g / 100));
}

export const growthPct = (now: number, prev: number | null): number | null => (prev && prev > 0 ? Math.round(((now - prev) / prev) * 1000) / 10 : null);

/** Straight-line projection of month-end GMV from the month-to-date figure. */
export function projectMonth(gmv: number, daysElapsed: number, daysInMonth: number): number | null {
  if (daysElapsed <= 0) return null;
  return Math.round((gmv / daysElapsed) * daysInMonth);
}
