import { log } from '../logger.js';

/** Post a plain-text message to a Slack incoming webhook. Never throws: a failed notification must not fail a run. */
export async function postSlack(webhookUrl: string, text: string): Promise<void> {
  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) log.warn(`Slack webhook returned ${res.status}: ${await res.text()}`);
  } catch (err) {
    log.warn(`Slack webhook failed: ${(err as Error).message}`);
  }
}
