import type { Queries } from '../db/queries.js';
import type { LlmUsageData } from '../sweep/types.js';
import { config } from '../config.js';
import { AUTO_FEATURES, FEATURE_LABELS, MODEL_PRICES, configureLlm, defaultModelFor, estimateCost, type LlmFeature } from '../inbox/llm.js';

/**
 * Claude spend: the hooks that record every call and pick the model per feature, the daily budget that
 * stops the automatic features, and the usage figures the dashboard shows (today, the week, the month,
 * the projection, per feature, per model, and what one reply costs on each model).
 */

const FEATURES = Object.keys(FEATURE_LABELS) as LlmFeature[];

export function llmSettings(q: Queries): { feature_models: Record<LlmFeature, string>; daily_budget_usd: number } {
  const feature_models = Object.fromEntries(FEATURES.map((f) => { const v = q.getSetting(`llm_model:${f}`, ''); return [f, v && MODEL_PRICES[v] ? v : defaultModelFor(f)]; })) as Record<LlmFeature, string>;
  const b = Number(q.getSetting('llm_daily_budget_usd', '0'));
  return { feature_models, daily_budget_usd: Number.isFinite(b) && b >= 0 ? b : 0 };
}

export function saveLlmSettings(q: Queries, patch: { feature_models?: Partial<Record<string, string>>; daily_budget_usd?: number }): void {
  for (const [f, m] of Object.entries(patch.feature_models ?? {})) { if (!FEATURES.includes(f as LlmFeature)) continue; if (m && MODEL_PRICES[m]) q.setSetting(`llm_model:${f}`, m); else if (m === '' || m === null) q.setSetting(`llm_model:${f}`, ''); }
  if (patch.daily_budget_usd !== undefined && Number.isFinite(patch.daily_budget_usd)) q.setSetting('llm_daily_budget_usd', String(Math.max(0, Math.round(patch.daily_budget_usd * 10000) / 10000)));
}

const startOfTodayUtc = () => `${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`;

export function budgetReached(q: Queries): boolean {
  const { daily_budget_usd } = llmSettings(q);
  if (!daily_budget_usd) return false;
  return q.llmBucket(startOfTodayUtc()).cost_usd >= daily_budget_usd;
}

/** Wire the LLM helper to the database: model per feature, usage log, budget. Call once at boot. */
export function installLlm(q: Queries): void {
  configureLlm({
    modelFor: (feature) => llmSettings(q).feature_models[feature],
    budgetReached: () => budgetReached(q),
    record: (r) => q.addLlmCall({ feature: r.feature, account_id: r.account_id, ref: r.ref, model: r.model, input_tokens: r.usage.input_tokens, output_tokens: r.usage.output_tokens, cache_read_tokens: r.usage.cache_read_input_tokens, cache_write_tokens: r.usage.cache_creation_input_tokens, cost_usd: r.cost_usd, ms: r.ms, ok: r.ok, error: r.error }),
  });
}

export function llmUsageData(q: Queries): LlmUsageData {
  const s = llmSettings(q);
  const now = new Date();
  const today = startOfTodayUtc();
  const d7 = new Date(now.getTime() - 7 * 86400000).toISOString();
  const monthStart = `${now.toISOString().slice(0, 7)}-01T00:00:00.000Z`;
  const month = q.llmBucket(monthStart);
  const dayOfMonth = now.getUTCDate();
  const daysInMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
  const week = q.llmBucket(d7);
  // Project from the last 7 days when there are any (steadier than month-to-date early in the month).
  const projected = week.calls ? (week.cost_usd / 7) * daysInMonth : (month.cost_usd / Math.max(1, dayOfMonth)) * daysInMonth;
  const replies = q.llmBucket(d7, undefined, { feature: 'reply' });
  const avgIn = replies.ok ? (replies.input + replies.cache_read) / replies.ok : null;
  const avgOut = replies.ok ? replies.output / replies.ok : null;
  const perModel = avgIn !== null && avgOut !== null ? Object.keys(MODEL_PRICES).map((m) => ({ model: m, label: MODEL_PRICES[m].label, cost_usd: estimateCost(m, { input_tokens: avgIn, output_tokens: avgOut, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }) })) : Object.keys(MODEL_PRICES).map((m) => ({ model: m, label: MODEL_PRICES[m].label, cost_usd: estimateCost(m, { input_tokens: 2500, output_tokens: 180, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }) }));
  return {
    configured: Boolean(config.anthropicApiKey),
    models: Object.entries(MODEL_PRICES).map(([id, p]) => ({ id, label: p.label, input: p.input, output: p.output, cache_read: p.cache_read, note: p.note })),
    feature_models: FEATURES.map((f) => ({ feature: f, label: FEATURE_LABELS[f], model: s.feature_models[f], auto: AUTO_FEATURES.includes(f) })),
    daily_budget_usd: s.daily_budget_usd,
    today: q.llmBucket(today), d7: week, month, projected_month_usd: Math.round(projected * 100) / 100,
    by_feature: q.llmGroups(monthStart, 'feature').map(({ key, ...b }) => ({ feature: key, label: FEATURE_LABELS[key as LlmFeature] ?? key, ...b })),
    by_model: q.llmGroups(monthStart, 'model').map(({ key, ...b }) => ({ model: key, ...b })),
    reply_avg: { cost_usd: replies.ok ? replies.cost_usd / replies.ok : null, input: avgIn, output: avgOut, messages_7d: replies.ok, per_model: perModel },
    last_error: q.llmLastError(),
    budget_reached: budgetReached(q),
  };
}
