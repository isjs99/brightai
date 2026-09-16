/** Decision makers found for the BD prospects with Apollo (organisation match, people search, reveal). Generated on 2026-09-16; seeded by migration 16. */
export interface SeedEnrichedContact { apollo_id: string; name: string; title: string | null; email: string | null; linkedin_url: string | null; note: string | null }
export interface SeedEnrichedShop { seller_id: string; company: string | null; domain: string | null; apollo_org_id: string | null; contacts: SeedEnrichedContact[] }

export const SEED_ENRICHED: SeedEnrichedShop[] = [];
