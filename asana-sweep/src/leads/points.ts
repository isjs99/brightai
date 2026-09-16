import type { Lead, LeadAmRow, Person } from '../sweep/types.js';

export interface PointRule {
  points_signed: number; // to the onboarding AM when the deal is signed
  points_sourced: number; // to the sourcing AM when a deal they sourced is signed
}

/** Per-AM scoreboard: who onboards what, who sourced what, and points for signed deals. */
export function amSummary(leads: Lead[], people: Person[], rule: PointRule): LeadAmRow[] {
  const live = leads.filter((l) => !l.removed_at);
  return people
    .map((p) => {
      const onboarding = live.filter((l) => l.onboarding_id === p.id);
      const sourced = live.filter((l) => l.sourced_by_id === p.id);
      const onboardingSigned = onboarding.filter((l) => l.signed);
      const sourcedSigned = sourced.filter((l) => l.signed);
      return {
        person_id: p.id,
        name: p.name,
        role: p.role,
        onboarding_total: onboarding.length,
        onboarding_signed: onboardingSigned.length,
        sourced_total: sourced.length,
        sourced_signed: sourcedSigned.length,
        points: onboardingSigned.length * rule.points_signed + sourcedSigned.length * rule.points_sourced,
        signed_value: onboardingSigned.reduce((s, l) => s + (l.est_value ?? 0), 0),
        pipeline_value: onboarding.filter((l) => !l.signed).reduce((s, l) => s + (l.est_value ?? 0), 0),
      };
    })
    .sort((a, b) => b.points - a.points || b.onboarding_signed - a.onboarding_signed || a.name.localeCompare(b.name));
}
