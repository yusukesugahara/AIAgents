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
      metadata: {
        attempts: 2,
        estimatedCostUsd: 0.011,
        usage: { inputTokens: 2_000, outputTokens: 400, totalTokens: 2_400 },
      },
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

  test('never accepts incomplete Responses output as a completed result', async () => {
    const repository = new FakeInvocationRepository();
    const incomplete = { ...parsedResponse({ category: 'other' }), status: 'incomplete' };
    const provider = new OpenAiLlmProvider({
      client: new FakeOpenAiClient([incomplete, incomplete]),
      invocationRepository: repository,
    });

    await expect(provider.generateStructured(createRequest())).resolves.toMatchObject({
      reason: 'invalid_output',
      status: 'needs_review',
    });
    expect(repository.records.map((record) => record.outcome)).toEqual([
      'invalid_output',
      'needs_review',
    ]);
  });

  test('maps timeouts and provider statuses without leaking provider details', async () => {
    const cases = [
      { code: 'AUTHENTICATION_REQUIRED', retryable: false, status: 401 },
      { code: 'PERMISSION_DENIED', retryable: false, status: 403 },
      { code: 'NOT_FOUND', retryable: false, status: 404 },
      { code: 'TEMPORARY_UNAVAILABLE', retryable: true, status: 409 },
      { code: 'INVALID_REQUEST', retryable: false, status: 422 },
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
      try {
        await provider.generateStructured(createRequest());
        throw new Error('Expected provider failure');
      } catch (error) {
        expect(error).toMatchObject({
          code: expected.code,
          retryable: expected.retryable,
        });
        expect((error as Error).cause).toBeUndefined();
      }
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

  test('records elapsed time for failed provider calls', async () => {
    const repository = new FakeInvocationRepository();
    const times = [0, 10, 25, 30].map((milliseconds) => new Date(milliseconds));
    const provider = new OpenAiLlmProvider({
      client: new FakeOpenAiClient([Object.assign(new Error('unavailable'), { status: 503 })]),
      invocationRepository: repository,
      now: () => times.shift() ?? new Date(30),
    });

    await expect(provider.generateStructured(createRequest())).rejects.toBeInstanceOf(
      AgentDependencyError,
    );
    expect(repository.records).toEqual([expect.objectContaining({ durationMs: 25 })]);
  });

  test('propagates an external cancellation without waiting for the provider timeout', async () => {
    const repository = new FakeInvocationRepository();
    const abortController = new AbortController();
    const provider = new OpenAiLlmProvider({
      client: new FakeOpenAiClient([new Promise<OpenAiStructuredResponse>(() => undefined)]),
      invocationRepository: repository,
      timeoutMs: 30_000,
    });

    const result = provider.generateStructured({
      ...createRequest(),
      signal: abortController.signal,
    });
    abortController.abort('lease lost');

    await expect(result).rejects.toMatchObject({
      code: 'TEMPORARY_UNAVAILABLE',
      retryable: true,
    });
    expect(repository.records).toEqual([expect.objectContaining({ outcome: 'failed' })]);
  });

  test('rejects malformed runtime requests as permanent input errors', async () => {
    const provider = new OpenAiLlmProvider({
      client: new FakeOpenAiClient([parsedResponse({ category: 'other' })]),
      invocationRepository: new FakeInvocationRepository(),
    });

    await expect(
      provider.generateStructured({ ...createRequest(), model: 42 } as never),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST', retryable: false });
    await expect(
      provider.generateStructured({ ...createRequest(), schema: null } as never),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST', retryable: false });
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

  test('does not expose the API key when the provider instance is serialized', () => {
    const provider = new OpenAiLlmProvider({
      apiKey: 'secret-api-key',
      invocationRepository: new FakeInvocationRepository(),
    });

    expect(JSON.stringify(provider)).not.toContain('secret-api-key');
  });

  test('uses only the versioned pricing catalog and leaves unknown models unpriced', () => {
    expect(
      estimateOpenAiCostUsd('gpt-5.6-luna', {
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        totalTokens: 2_000_000,
      }),
    ).toBe(11);
    expect(
      estimateOpenAiCostUsd('unpriced-model', {
        inputTokens: 1,
        outputTokens: 1,
        totalTokens: 2,
      }),
    ).toBeNull();
    expect(
      estimateOpenAiCostUsd('gpt-5.6-luna', {
        inputTokens: 272_000,
        outputTokens: 100_000,
        totalTokens: 372_000,
      }),
    ).toBe(0.872);
    expect(
      estimateOpenAiCostUsd('gpt-5.6-luna', {
        inputTokens: 272_001,
        outputTokens: 100_000,
        totalTokens: 372_001,
      }),
    ).toBe(1.444002);
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
