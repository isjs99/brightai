import { expect, it } from 'vitest';
import { openTestDb } from '../src/db/index';
import { Queries } from '../src/db/queries';
import { textHash, translateToEnglish } from '../src/inbox/translate';

it('translates in batches, keeps every text, and never asks twice for the same one', async () => {
  const q = new Queries(openTestDb());
  const calls: string[][] = [];
  const llm = async (_s: string, u: string) => { const arr = JSON.parse(u) as string[]; calls.push(arr); return JSON.stringify(arr.map((t) => (t === 'Hello' ? 'Hello' : `EN(${t})`))); };
  const out = await translateToEnglish(q, ['Wo ist mein Sample?', 'Hello', 'Wo ist mein Sample?', '  '], { llm });
  expect(out).toEqual(['EN(Wo ist mein Sample?)', 'Hello', 'EN(Wo ist mein Sample?)', '']);
  expect(calls).toHaveLength(1);
  expect(calls[0]).toEqual(['Wo ist mein Sample?', 'Hello']);
  // Kept: the second time nothing is asked.
  const again = await translateToEnglish(q, ['Wo ist mein Sample?', 'Grazie mille'], { llm });
  expect(again).toEqual(['EN(Wo ist mein Sample?)', 'EN(Grazie mille)']);
  expect(calls).toHaveLength(2);
  expect(calls[1]).toEqual(['Grazie mille']);
  expect(q.getTranslations([textHash('Grazie mille')]).get(textHash('Grazie mille'))).toBe('EN(Grazie mille)');
  // Batches of twenty.
  const many = Array.from({ length: 45 }, (_, i) => `Satz ${i}`);
  await translateToEnglish(q, many, { llm });
  expect(calls.slice(2).map((c) => c.length)).toEqual([20, 20, 5]);
  // A reply with the wrong shape is an error, not a silent mismatch.
  await expect(translateToEnglish(q, ['Nuevo'], { llm: async () => '["a","b"]' })).rejects.toThrow(/wrong number/);
});
