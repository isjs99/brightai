import { createHash } from 'node:crypto';
import type { Queries } from '../db/queries.js';
import { draftWithClaude } from './llm.js';

/**
 * English for the team: creator and buyer messages and our replies in any language, translated on request and
 * kept, so the same text never costs a second call. Haiku, batched, JSON in and out.
 */

export const textHash = (text: string): string => createHash('sha1').update(text.trim().replace(/\s+/g, ' ')).digest('hex');

const SYSTEM = 'You translate chat messages between a TikTok Shop brand and its creators or buyers into English for the brand\'s account team. Keep the meaning, tone and length; keep names, handles, product names, order numbers and placeholders like [brand] as they are. If a message is already English, return it unchanged. Answer with one JSON array of strings in the same order as the input and nothing else.';

export async function translateToEnglish(q: Queries, texts: string[], opts: { llm?: (system: string, user: string) => Promise<string>; accountId?: number | null } = {}): Promise<string[]> {
  const clean = texts.map((t) => String(t ?? '').slice(0, 2000));
  const hashes = clean.map(textHash);
  const cached = q.getTranslations([...new Set(hashes)]);
  const todo = [...new Map(clean.map((t, i) => [hashes[i], t])).entries()].filter(([h, t]) => t.trim() && !cached.has(h));
  const llm = opts.llm ?? ((s: string, u: string) => draftWithClaude(s, u, { feature: 'translate', accountId: opts.accountId ?? null, maxTokens: 4000 }));
  for (let i = 0; i < todo.length; i += 20) {
    const chunk = todo.slice(i, i + 20);
    const raw = await llm(SYSTEM, JSON.stringify(chunk.map(([, t]) => t)));
    const start = raw.indexOf('['); const end = raw.lastIndexOf(']');
    let arr: unknown;
    try { arr = JSON.parse(raw.slice(start, end + 1)); } catch { throw new Error('The translation did not come back as a list.'); }
    if (!Array.isArray(arr) || arr.length !== chunk.length) throw new Error('The translation came back with the wrong number of lines.');
    chunk.forEach(([h, t], j) => { const en = String(arr[j] ?? '').trim() || t; cached.set(h, en); q.putTranslation(h, t, en); });
  }
  return hashes.map((h, i) => cached.get(h) ?? clean[i]);
}
