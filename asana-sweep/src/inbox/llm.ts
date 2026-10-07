import { config } from '../config.js';

/**
 * The one place the dashboard calls Claude. Every call is tagged with the feature it serves, the model is
 * chosen per feature (cheap and fast for the creator and buyer replies and the task scan, the configured
 * default for everything else), the token usage comes back with the reply and is recorded with its cost,
 * and a daily budget can stop the automatic features before the account runs dry.
 */

export type LlmFeature = 'reply' | 'tasks' | 'ask' | 'report' | 'targets' | 'competitors' | 'pitch' | 'outreach' | 'incidents' | 'health' | 'playbook' | 'calls' | 'translate' | 'audit' | 'other';

export interface LlmUsage { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }
export interface LlmCallRecord { feature: LlmFeature; account_id: number | null; ref: string | null; model: string; usage: LlmUsage; cost_usd: number; ms: number; ok: boolean; error: string | null }

/** Price per million tokens, Anthropic first-party rates (input, output, cache read, cache write). */
export const MODEL_PRICES: Record<string, { label: string; input: number; output: number; cache_read: number; cache_write: number; note: string }> = {
  'claude-haiku-4-5': { label: 'Haiku 4.5', input: 1, output: 5, cache_read: 0.1, cache_write: 1.25, note: 'Fastest and cheapest. Right for replies and task extraction.' },
  'claude-sonnet-5-5': { label: 'Sonnet 5.5', input: 2, output: 10, cache_read: 0.2, cache_write: 2.5, note: 'Everyday work with better judgement.' },
  'claude-sonnet-5': { label: 'Sonnet 5', input: 2, output: 10, cache_read: 0.2, cache_write: 2.5, note: 'Previous Sonnet, same price as 5.5.' },
  'claude-sonnet-4-6': { label: 'Sonnet 4.6', input: 3, output: 15, cache_read: 0.3, cache_write: 3.75, note: 'Older Sonnet, dearer than 5.5.' },
  'claude-opus-5-5': { label: 'Opus 5.5', input: 4, output: 20, cache_read: 0.2, cache_write: 5, note: 'Reports, pitches and anything that must read well.' },
  'claude-opus-5': { label: 'Opus 5', input: 5, output: 25, cache_read: 0.5, cache_write: 6.25, note: 'Previous Opus.' },
  'claude-fable-5-1': { label: 'Fable 5.1', input: 10, output: 50, cache_read: 0.25, cache_write: 12.5, note: 'Most capable, 10x the price of Haiku.' },
};

export const FEATURE_LABELS: Record<LlmFeature, string> = { reply: 'Creator and buyer replies', tasks: 'Client task scan', ask: 'Ask and copilot', report: 'Client reports', targets: 'Targets (deal reads)', competitors: 'Competitor pages', pitch: 'Pitch decks', outreach: 'Outreach drafts (email, LinkedIn, Lark)', incidents: 'Incident notes', health: 'Account health review', playbook: 'Cruva playbook', calls: 'Call follow-ups', translate: 'Translations to English', audit: 'Reply audit', other: 'Other' };

/** Features that run on their own, without a person pressing a button; the daily budget stops these first. */
export const AUTO_FEATURES: LlmFeature[] = ['reply', 'tasks', 'ask', 'targets', 'competitors', 'incidents', 'health', 'playbook', 'calls'];

const DEFAULT_MODEL: Partial<Record<LlmFeature, string>> = { reply: 'claude-haiku-4-5', tasks: 'claude-haiku-4-5', ask: 'claude-haiku-4-5', incidents: 'claude-haiku-4-5', calls: 'claude-haiku-4-5', translate: 'claude-haiku-4-5' };

export function estimateCost(model: string, u: LlmUsage): number {
  const p = MODEL_PRICES[model] ?? MODEL_PRICES['claude-sonnet-5-5'];
  return (u.input_tokens * p.input + u.output_tokens * p.output + u.cache_read_input_tokens * p.cache_read + u.cache_creation_input_tokens * p.cache_write) / 1_000_000;
}

/** A rough token count for a prompt before sending it (4 characters a token). Used for the projection only. */
export const roughTokens = (text: string): number => Math.ceil(text.length / 4);

export class LlmBudgetError extends Error {}

export interface LlmHooks {
  /** The model to use for a feature when the caller did not name one. */
  modelFor?: (feature: LlmFeature) => string;
  /** Called after every call, successful or not. */
  record?: (r: LlmCallRecord) => void;
  /** True when the daily budget is spent; automatic features then stop before calling. */
  budgetReached?: (feature: LlmFeature) => boolean;
}

let hooks: LlmHooks = {};
export function configureLlm(h: LlmHooks): void { hooks = h; }

export function defaultModelFor(feature: LlmFeature): string {
  return DEFAULT_MODEL[feature] ?? config.replyModel;
}

export function modelFor(feature: LlmFeature): string {
  return hooks.modelFor?.(feature) ?? defaultModelFor(feature);
}

export interface DraftOpts { apiKey?: string; model?: string; fetchFn?: typeof fetch; maxTokens?: number; feature?: LlmFeature; accountId?: number | null; ref?: string | null }

/** Turn Anthropic's error into the sentence the team needs to read. */
export function explainApiError(status: number, message: string): string {
  if (/credit balance is too low|purchase credits|insufficient credit/i.test(message)) return 'Anthropic account has no credit left: top up at console.anthropic.com (Plans & Billing), then replies resume by themselves.';
  if (status === 401) return 'Anthropic API key rejected (401): check ANTHROPIC_API_KEY.';
  if (status === 429) return `Anthropic rate limit (429): ${message}`;
  if (status === 529 || status >= 500) return `Anthropic is overloaded (${status}); it will retry on the next pass.`;
  return `Claude API ${status}: ${message}`;
}

/** Minimal Anthropic Messages API call. Returns the reply text; records tokens and cost through the hooks. */
export async function draftWithClaude(system: string, user: string, opts: DraftOpts = {}): Promise<string> {
  const apiKey = opts.apiKey ?? config.anthropicApiKey;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set. Add it to .env and restart to draft replies.');
  const feature = opts.feature ?? 'other';
  const model = opts.model ?? modelFor(feature);
  if (AUTO_FEATURES.includes(feature) && hooks.budgetReached?.(feature)) throw new LlmBudgetError('Daily Claude budget reached (Settings › Connections › Claude); automatic work resumes tomorrow or when the budget is raised.');
  const started = Date.now();
  const usage: LlmUsage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  const done = (ok: boolean, error: string | null) => { try { hooks.record?.({ feature, account_id: opts.accountId ?? null, ref: opts.ref ?? null, model, usage, cost_usd: estimateCost(model, usage), ms: Date.now() - started, ok, error }); } catch { /* recording never breaks the call */ } };
  let res: Response;
  try {
    res = await (opts.fetchFn ?? fetch)('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model, max_tokens: opts.maxTokens ?? 600, system, messages: [{ role: 'user', content: user }] }),
    });
  } catch (err) {
    done(false, `network: ${(err as Error).message}`);
    throw err;
  }
  const data = (await res.json().catch(() => null)) as { content?: { type: string; text?: string }[]; usage?: Partial<LlmUsage>; error?: { message?: string } } | null;
  if (data?.usage) { usage.input_tokens = Number(data.usage.input_tokens ?? 0); usage.output_tokens = Number(data.usage.output_tokens ?? 0); usage.cache_read_input_tokens = Number(data.usage.cache_read_input_tokens ?? 0); usage.cache_creation_input_tokens = Number(data.usage.cache_creation_input_tokens ?? 0); }
  if (!res.ok) {
    const msg = explainApiError(res.status, data?.error?.message ?? res.statusText);
    done(false, msg);
    throw new Error(msg);
  }
  const text = (data?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('').trim();
  if (!text) { done(false, 'empty reply'); throw new Error('Claude returned an empty reply.'); }
  done(true, null);
  return text.replace(/^["“]|["”]$/g, '').trim();
}
