import { describe, expect, test } from 'bun:test';
import { AgentDependencyError } from '@ai-agents/agent-core';
import { z } from 'zod';
import {
  estimateOpenAiCostUsd,
  type LlmInvocationRecord,
  type LlmInvocationRepository,
  OpenAiLlmProvider,
  type OpenAiStructuredClient,
  type OpenAiStructuredResponse,
} from './index';

const outputSchema = z.object({ category: z.enum(['interview', 'other']) });
const runId = '018f7f9a-7b2c-7abc-8def-0123456789ab';

class FakeInvocationRepository implements LlmInvocationRepository {
  readonly records: LlmInvocationRecord[] = [];
  failure: Error | undefined;

  async recordInvocation(invocation: LlmInvocationRecord): Promise<void> {
    if (this.failure) {
      throw this.failure;
    }
    this.records.push(invocation);
  }
}

class FakeOpenAiClient implements OpenAiStructuredClient {
  readonly requests: Array<{
    model: string;
    schemaName: string;
    systemPrompt: string;
    userInput: string;
  }> = [];

  constructor(
    private readonly responses: Array<
      OpenAiStructuredResponse | Error | Promise<OpenAiStructuredResponse>
    >,
  ) {}

  async parse(request: {
    readonly model: string;
    readonly schemaName: string;
    readonly systemPrompt: string;
    readonly userInput: string;
  }): Promise<OpenAiStructuredResponse> {
    this.requests.push(request);
    const response = this.responses.shift();
    if (!response) {
      throw new Error('No fake OpenAI response is queued');
    }
    if (response instanceof Error) {
      throw response;
    }
    return response;
  }
}

function createRequest() {
  return {
    model: 'gpt-5.6-terra',
    promptVersion: 'email-analysis.v1',
    runId,
    schema: outputSchema,
    schemaName: 'email_analysis',
    schemaVersion: '1',
    systemPrompt: 'Return a classified email.',
    userInput: 'Private email body that must not be persisted.',
  };
}

function parsedResponse(parsed: unknown): OpenAiStructuredResponse {
  return {
    model: 'gpt-5.6-terra',
    output: [{ content: [{ parsed, type: 'output_text' }], type: 'message' }],
    usage: { input_tokens: 1_000, output_tokens: 200, total_tokens: 1_200 },
  };
}

describe('OpenAiLlmProvider', () => {
  test('returns Zod-validated data and records metadata without prompts or output', async () => {
    const repository = new FakeInvocationRepository();
    const client = new FakeOpenAiClient([parsedResponse({ category: 'interview' })]);
    const provider = new OpenAiLlmProvider({ client, invocationRepository: repository });

    const result = await provider.generateStructured(createRequest());

    expect(result).toEqual({
      data: { category: 'interview' },
      metadata: expect.objectContaining({
        attempts: 1,
        estimatedCostUsd: 0.0055,
        usage: { inputTokens: 1_000, outputTokens: 200, totalTokens: 1_200 },
      }),
      status: 'completed',
    });
    expect(client.requests).toEqual([
      expect.objectContaining({
        model: 'gpt-5.6-terra',
        schemaName: 'email_analysis',
      }),
    ]);
    expect(repository.records).toEqual([
      expect.objectContaining({
        attempt: 1,
        outcome: 'completed',
        reviewReason: null,
        runId,
      }),
    ]);
    expect(JSON.stringify(repository.records)).not.toContain('Private email body');
    expect(JSON.stringify(repository.records)).not.toContain('interview');
  });

  test('retries one invalid output and returns the next validated result', async () => {
    const repository = new FakeInvocationRepository();
    const client = new FakeOpenAiClient([
      parsedResponse({ category: 'unsupported' }),
      parsedResponse({ category: 'other' }),
    ]);
    const provider = new OpenAiLlmProvider({ client, invocationRepository: repository });

    await expect(provider.generateStructured(createRequest())).resolves.toMatchObject({
      data: { category: 'other' },
      metadata: { attempts: 2 },
      status: 'completed',
    });
    expect(repository.records.map((record) => record.outcome)).toEqual([
      'invalid_output',
      'completed',
    ]);
  });

  test('returns needs_review after two invalid outputs or an explicit refusal', async () => {
    const invalidRepository = new FakeInvocationRepository();
    const invalidProvider = new OpenAiLlmProvider({
      client: new FakeOpenAiClient([
        parsedResponse({ category: 'unsupported' }),
        parsedResponse({ category: 'unsupported' }),
      ]),
      invocationRepository: invalidRepository,
    });
    await expect(invalidProvider.generateStructured(createRequest())).resolves.toMatchObject({
      reason: 'invalid_output',
      status: 'needs_review',
    });
    expect(invalidRepository.records.map((record) => record.outcome)).toEqual([
      'invalid_output',
      'needs_review',
    ]);

    const refusalRepository = new FakeInvocationRepository();
    const refusalProvider = new OpenAiLlmProvider({
      client: new FakeOpenAiClient([
        {
          output: [{ content: [{ refusal: 'Cannot comply', type: 'refusal' }], type: 'message' }],
          usage: { input_tokens: 4, output_tokens: 1, total_tokens: 5 },
        },
      ]),
      invocationRepository: refusalRepository,
    });
    await expect(refusalProvider.generateStructured(createRequest())).resolves.toMatchObject({
      reason: 'refusal',
      status: 'needs_review',
    });
    expect(refusalRepository.records).toEqual([
      expect.objectContaining({ outcome: 'needs_review', reviewReason: 'refusal' }),
    ]);
  });

  test('maps timeouts and provider statuses without leaking provider details', async () => {
    const cases = [
      { code: 'AUTHENTICATION_REQUIRED', retryable: false, status: 401 },
      { code: 'RATE_LIMITED', retryable: true, status: 429 },
      { code: 'TEMPORARY_UNAVAILABLE', retryable: true, status: 503 },
    ] as const;
    for (const expected of cases) {
      const repository = new FakeInvocationRepository();
      const provider = new OpenAiLlmProvider({
        client: new FakeOpenAiClient([
          Object.assign(new Error('provider key: secret-value'), { status: expected.status }),
        ]),
        invocationRepository: repository,
      });
      await expect(provider.generateStructured(createRequest())).rejects.toMatchObject({
        code: expected.code,
        retryable: expected.retryable,
      });
      expect(repository.records).toEqual([
        expect.objectContaining({ outcome: 'failed', reviewReason: null }),
      ]);
    }

    const timeoutProvider = new OpenAiLlmProvider({
      client: new FakeOpenAiClient([new Promise<OpenAiStructuredResponse>(() => undefined)]),
      invocationRepository: new FakeInvocationRepository(),
      timeoutMs: 1,
    });
    await expect(timeoutProvider.generateStructured(createRequest())).rejects.toMatchObject({
      code: 'TEMPORARY_UNAVAILABLE',
      retryable: true,
    });

    const networkProvider = new OpenAiLlmProvider({
      client: new FakeOpenAiClient([new Error('network unavailable')]),
      invocationRepository: new FakeInvocationRepository(),
    });
    await expect(networkProvider.generateStructured(createRequest())).rejects.toMatchObject({
      code: 'TEMPORARY_UNAVAILABLE',
      retryable: true,
    });
  });

  test('fails closed for missing credentials and retryably for metadata persistence failures', async () => {
    await expect(
      new OpenAiLlmProvider({
        invocationRepository: new FakeInvocationRepository(),
      }).generateStructured(createRequest()),
    ).rejects.toMatchObject({ code: 'AUTHENTICATION_REQUIRED', retryable: false });

    const repository = new FakeInvocationRepository();
    repository.failure = new Error('database unavailable');
    const provider = new OpenAiLlmProvider({
      client: new FakeOpenAiClient([parsedResponse({ category: 'other' })]),
      invocationRepository: repository,
    });
    await expect(provider.generateStructured(createRequest())).rejects.toMatchObject({
      code: 'TEMPORARY_UNAVAILABLE',
      retryable: true,
    });
  });

  test('uses only the versioned pricing catalog and leaves unknown models unpriced', () => {
    expect(
      estimateOpenAiCostUsd('gpt-5.6-luna', {
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        totalTokens: 2_000_000,
      }),
    ).toBe(7);
    expect(
      estimateOpenAiCostUsd('unpriced-model', {
        inputTokens: 1,
        outputTokens: 1,
        totalTokens: 2,
      }),
    ).toBeNull();
  });
});

test('derives total tokens when a provider response omits that field', async () => {
  const repository = new FakeInvocationRepository();
  const provider = new OpenAiLlmProvider({
    client: new FakeOpenAiClient([
      {
        ...parsedResponse({ category: 'other' }),
        usage: { input_tokens: 4, output_tokens: 2 },
      },
    ]),
    invocationRepository: repository,
  });

  const result = await provider.generateStructured(createRequest());
  expect(result.metadata.usage).toEqual({ inputTokens: 4, outputTokens: 2, totalTokens: 6 });
});

test('AgentDependencyError remains safe for saved LLM failures', () => {
  const error = new AgentDependencyError('UNKNOWN', false, 'OpenAI request failed');
  expect(error.message).not.toContain('secret');
});
