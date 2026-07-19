import { expect, test } from 'bun:test';
import { z } from 'zod';
import { FakeLlmProvider } from './index';

test('FakeLlmProvider returns deterministic queued responses', async () => {
  const fake = new FakeLlmProvider([
    {
      data: { category: 'other' },
      metadata: {
        attempts: 1,
        durationMs: 0,
        estimatedCostUsd: null,
        model: 'fake',
        promptVersion: 'test.v1',
        schemaName: 'test',
        schemaVersion: '1',
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      },
      status: 'completed',
    },
  ]);

  await expect(
    fake.generateStructured({
      model: 'fake',
      promptVersion: 'test.v1',
      runId: '018f7f9a-7b2c-7abc-8def-0123456789ab',
      schema: z.object({ category: z.string() }),
      schemaName: 'test',
      schemaVersion: '1',
      systemPrompt: 'system',
      userInput: 'input',
    }),
  ).resolves.toMatchObject({ data: { category: 'other' }, status: 'completed' });
  expect(fake.requests).toHaveLength(1);
});
