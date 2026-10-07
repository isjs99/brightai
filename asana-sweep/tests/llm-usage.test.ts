import { describe, expect, it } from 'vitest';
import { Queries } from '../src/db/queries';
import { openTestDb } from '../src/db/index';
import { configureLlm, draftWithClaude, estimateCost, explainApiError, LlmBudgetError, modelFor, requestBody } from '../src/inbox/llm';
import { installLlm, llmSettings, llmUsageData, saveLlmSettings } from '../src/llm/usage';
import { withCosts } from '../src/inbox/replies';
import { ClientTasks } from '../src/tasks/client-tasks';

const okResponse = (text: string, usage: Record<string, number>) => new Response(JSON.stringify({ content: [{ type: 'text', text }], usage }), { status: 200 });

describe('Claude cost and models', () => {
  it('prices a call from the usage and explains the errors in plain words', () => {
    expect(estimateCost('claude-haiku-4-5', { input_tokens: 2500, output_tokens: 180, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })).toBeCloseTo(0.0034, 4);
    expect(estimateCost('claude-sonnet-5', { input_tokens: 2500, output_tokens: 180, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })).toBeCloseTo(0.0068, 4);
    expect(estimateCost('claude-opus-5-5', { input_tokens: 1_000_000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })).toBe(4);
    expect(explainApiError(400, 'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.')).toMatch(/no credit left: top up at console.anthropic.com/);
    expect(explainApiError(401, 'invalid x-api-key')).toMatch(/401/);
    expect(explainApiError(529, 'overloaded')).toMatch(/overloaded/);
  });

  it('gives the Claude 5 models room to think and keeps effort low, and leaves Haiku 4.5 alone', () => {
    const b = requestBody('claude-sonnet-5', 's', 'u', { maxTokens: 4000 });
    expect(b.max_tokens).toBe(8000);
    expect(b.output_config).toEqual({ effort: 'low' });
    expect(requestBody('claude-opus-5-5', 's', 'u', { effort: 'high' })).toMatchObject({ max_tokens: 4600, output_config: { effort: 'high' } });
    const h = requestBody('claude-haiku-4-5', 's', 'u', { maxTokens: 900 });
    expect(h.max_tokens).toBe(900);
    expect(h).not.toHaveProperty('output_config');
    expect(requestBody('claude-sonnet-4-6', 's', 'u', {})).toMatchObject({ max_tokens: 600, output_config: { effort: 'low' } });
  });

  it('records every call with its tokens and cost, picks the model per feature, and stops automatic work at the budget', async () => {
    const q = new Queries(openTestDb());
    installLlm(q);
    expect(modelFor('reply')).toBe('claude-haiku-4-5');
    expect(modelFor('report')).not.toBe('claude-haiku-4-5');
    const calls: { model: string }[] = [];
    const fetchFn = (async (_url: string | URL | Request, init?: RequestInit) => { const body = JSON.parse(String(init?.body)) as { model: string }; calls.push(body); return okResponse('{"ok":true}', { input_tokens: 2400, output_tokens: 150, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }); }) as typeof fetch;
    const text = await draftWithClaude('sys', 'user', { apiKey: 'k', fetchFn, feature: 'reply', accountId: 7, ref: 'reply:1:m1' });
    expect(text).toBe('{"ok":true}');
    expect(calls[0].model).toBe('claude-haiku-4-5');
    const u = llmUsageData(q);
    expect(u.today).toMatchObject({ calls: 1, ok: 1, input: 2400, output: 150 });
    expect(u.today.cost_usd).toBeCloseTo(0.00315, 5);
    expect(u.by_feature[0]).toMatchObject({ feature: 'reply', label: 'Creator and buyer replies', calls: 1 });
    expect(u.reply_avg).toMatchObject({ messages_7d: 1, input: 2400, output: 150 });
    expect(u.reply_avg.per_model.find((m) => m.model === 'claude-sonnet-5')!.cost_usd).toBeCloseTo(0.0063, 4);
    expect(u.projected_month_usd).toBeGreaterThan(0);

    // The failure is recorded too, with the plain-words reason.
    const bad = (async () => new Response(JSON.stringify({ error: { message: 'Your credit balance is too low to access the Anthropic API.' } }), { status: 400 })) as typeof fetch;
    await expect(draftWithClaude('s', 'u', { apiKey: 'k', fetchFn: bad, feature: 'reply', ref: 'reply:1:m2' })).rejects.toThrow(/no credit left/);
    expect(llmUsageData(q).last_error).toMatchObject({ feature: 'reply', message: expect.stringMatching(/console.anthropic.com/) });

    // Model per feature and the budget.
    saveLlmSettings(q, { feature_models: { report: 'claude-haiku-4-5', reply: 'claude-sonnet-5-5' }, daily_budget_usd: 0.003 });
    expect(llmSettings(q).feature_models).toMatchObject({ report: 'claude-haiku-4-5', reply: 'claude-sonnet-5-5' });
    expect(llmUsageData(q).budget_reached).toBe(true);
    await expect(draftWithClaude('s', 'u', { apiKey: 'k', fetchFn, feature: 'reply' })).rejects.toThrow(LlmBudgetError);
    // A person pressing a button is not stopped by the budget.
    await draftWithClaude('s', 'u', { apiKey: 'k', fetchFn, feature: 'pitch' });
    expect(calls.at(-1)!.model).toBe(modelFor('pitch'));
    saveLlmSettings(q, { daily_budget_usd: 0 });
    expect(llmUsageData(q).budget_reached).toBe(false);

    // Costs attach to reply events by conversation and message id.
    const events = withCosts(q, [{ conversation_ref: 1, message_id: 'm1', cost: null }, { conversation_ref: 1, message_id: 'm9', cost: null }]);
    expect(events[0].cost).toMatchObject({ usd: expect.any(Number), input: 2400, output: 150, model: 'claude-haiku-4-5' });
    expect(events[1].cost).toBeNull();
    configureLlm({});
  });

  it('tells the team which task source is not delivering and why', () => {
    const q = new Queries(openTestDb());
    const a = q.listAccounts()[0];
    q.updateAccount(a.id, { ...a, client_slack_channel: null, client_domain: null });
    q.upsertEvidence([{ account_id: null, kind: 'call', ref: 'c1', title: 'Call: Intro with someone', text: 'x', occurred_at: new Date().toISOString() }]);
    const ct = new ClientTasks(q, { llm: null, slackConfigured: () => false, gmailConnected: () => false, tldvConfigured: () => true, copilot: { index: async () => ({ added: 0, errors: [] }), indexStatus: () => ({ last_at: null, last_error: '', indexing: false }) } });
    const s = ct.sources();
    expect(s.slack.ok).toBe(false);
    expect(s.slack.fix).toMatch(/SLACK_BOT_TOKEN/);
    expect(s.gmail.fix).toMatch(/connect Gmail/);
    expect(s.tldv.ok).toBe(true);
    expect(s.llm.ok).toBe(false);
    expect(s.accounts.find((x) => x.id === a.id)!.missing).toEqual(['Slack channel', 'client domain']);
    expect(s.unmatched_calls.map((c) => c.title)).toEqual(['Call: Intro with someone']);
    q.updateAccount(a.id, { ...a, client_slack_channel: '#client-x', client_domain: 'x.com' });
    const s2 = new ClientTasks(q, { llm: null, slackConfigured: () => true, gmailConnected: () => true, tldvConfigured: () => true }).sources();
    expect(s2.slack.ok).toBe(true);
    expect(s2.gmail.ok).toBe(true);
    expect(s2.accounts.find((x) => x.id === a.id)!.missing).toEqual([]);
  });
});
