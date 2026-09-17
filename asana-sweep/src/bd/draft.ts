import type { Queries } from '../db/queries.js';
import type { BdEmailDraft } from '../sweep/types.js';
import { config } from '../config.js';
import { draftWithClaude } from '../inbox/llm.js';
import { outreachInputs, parseDraftJson, renderOutreachPrompt, templateDraft } from './outreach.js';

export interface DraftOpts {
  language: string;
  style: 'short' | 'intro';
  instructions: string | null;
}

/** Draft a cold email to one contact: Claude in Isaac's voice when configured, the template otherwise. */
export async function generateDraft(q: Queries, prospectId: number, contact: { name: string; title: string | null; email: string | null }, opts: DraftOpts): Promise<{ subject: string; body: string; generator: BdEmailDraft['generator'] }> {
  const prospect = q.getProspect(prospectId);
  if (!prospect) throw new Error('Prospect not found');
  const req = { prospect, contact, ...opts, ...outreachInputs(q), previousDrafts: q.listDrafts({ prospectId, includeDiscarded: true }) };
  if (!config.anthropicApiKey) return { ...templateDraft(req), generator: 'template' };
  const { system, user } = renderOutreachPrompt(req);
  const text = await draftWithClaude(system, user, { maxTokens: 1500 });
  return { ...parseDraftJson(text), generator: 'claude' };
}
