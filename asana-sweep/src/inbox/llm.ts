import { config } from '../config.js';

/** Minimal Anthropic Messages API call. Returns the reply text. */
export async function draftWithClaude(system: string, user: string, opts: { apiKey?: string; model?: string; fetchFn?: typeof fetch; maxTokens?: number } = {}): Promise<string> {
  const apiKey = opts.apiKey ?? config.anthropicApiKey;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set. Add it to .env and restart to draft replies.');
  const res = await (opts.fetchFn ?? fetch)('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: opts.model ?? config.replyModel, max_tokens: opts.maxTokens ?? 600, system, messages: [{ role: 'user', content: user }] }),
  });
  const data = (await res.json().catch(() => null)) as { content?: { type: string; text?: string }[]; error?: { message?: string } } | null;
  if (!res.ok) throw new Error(`Claude API ${res.status}: ${data?.error?.message ?? res.statusText}`);
  const text = (data?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('').trim();
  if (!text) throw new Error('Claude returned an empty reply.');
  return text.replace(/^["“]|["”]$/g, '').trim();
}
