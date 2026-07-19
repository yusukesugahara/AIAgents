import { AgentDependencyError } from '@ai-agents/agent-core';
import OpenAI from 'openai';
import { zodTextFormat } from 'openai/helpers/zod';
import type { z } from 'zod';

export type LlmInvocationOutcome = 'completed' | 'failed' | 'invalid_output' | 'needs_review';
export type LlmNeedsReviewReason = 'invalid_output' | 'refusal';

export interface LlmUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
}

export interface LlmInvocationRecord {
  readonly attempt: number;
  readonly createdAt: Date;
  readonly durationMs: number;
  readonly estimatedCostUsd: number | null;
  readonly inputTokens: number;
  readonly model: string;
  readonly outcome: LlmInvocationOutcome;
  readonly outputTokens: number;
  readonly promptVersion: string;
  readonly provider: 'openai';
  readonly reviewReason: LlmNeedsReviewReason | null;
  readonly runId: string;
  readonly schemaName: string;
  readonly schemaVersion: string;
  readonly totalTokens: number;
}

export interface LlmInvocationRepository {
  recordInvocation(invocation: LlmInvocationRecord): Promise<void>;
}

export interface StructuredLlmRequest<TOutput> {
  readonly model: string;
  readonly promptVersion: string;
  readonly runId: string;
  readonly schema: z.ZodType<TOutput>;
  readonly schemaName: string;
  readonly schemaVersion: string;
  readonly systemPrompt: string;
  readonly userInput: string;
}

export interface LlmInvocationMetadata {
  readonly attempts: number;
  readonly durationMs: number;
  readonly estimatedCostUsd: number | null;
  readonly model: string;
  readonly promptVersion: string;
  readonly schemaName: string;
  readonly schemaVersion: string;
  readonly usage: LlmUsage;
}

export type StructuredLlmResult<TOutput> =
  | {
      readonly data: TOutput;
      readonly metadata: LlmInvocationMetadata;
      readonly status: 'completed';
    }
  | {
      readonly metadata: LlmInvocationMetadata;
      readonly reason: LlmNeedsReviewReason;
      readonly status: 'needs_review';
    };

export interface LlmProvider {
  generateStructured<TOutput>(
    request: StructuredLlmRequest<TOutput>,
  ): Promise<StructuredLlmResult<TOutput>>;
}

export interface OpenAiStructuredResponse {
  readonly model?: string;
  readonly output: readonly {
    readonly content: readonly {
      readonly parsed?: unknown;
      readonly refusal?: string;
      readonly type: string;
    }[];
    readonly type: string;
  }[];
  readonly usage?: {
    readonly input_tokens?: number;
    readonly output_tokens?: number;
    readonly total_tokens?: number;
  };
}

export interface OpenAiStructuredClient {
  parse(
    request: {
      readonly model: string;
      readonly schema: z.ZodType<unknown>;
      readonly schemaName: string;
      readonly systemPrompt: string;
      readonly userInput: string;
    },
    options?: { readonly signal?: AbortSignal },
  ): Promise<OpenAiStructuredResponse>;
}

export interface OpenAiLlmProviderOptions {
  readonly apiKey?: string;
  readonly client?: OpenAiStructuredClient;
  readonly invocationRepository: LlmInvocationRepository;
  readonly now?: () => Date;
  readonly timeoutMs?: number;
}

interface AttemptResult<TOutput> {
  readonly data?: TOutput;
  readonly durationMs: number;
  readonly model: string;
  readonly reason?: LlmNeedsReviewReason;
  readonly usage: LlmUsage;
}

const defaultTimeoutMs = 30_000;

/**
 * Calls OpenAI's Responses API through a typed boundary and records only invocation metadata.
 * Prompts and model outputs are intentionally never persisted by this provider.
 */
export class OpenAiLlmProvider implements LlmProvider {
  readonly #client: OpenAiStructuredClient | undefined;
  readonly #now: () => Date;
  readonly #timeoutMs: number;

  constructor(private readonly options: OpenAiLlmProviderOptions) {
    this.#client = options.client ?? createSdkClient(options.apiKey);
    this.#now = options.now ?? (() => new Date());
    this.#timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
    if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs <= 0) {
      throw new Error('OpenAI timeout must be a positive integer');
    }
  }

  async generateStructured<TOutput>(
    request: StructuredLlmRequest<TOutput>,
  ): Promise<StructuredLlmResult<TOutput>> {
    validateRequest(request);
    if (!this.#client) {
      throw new AgentDependencyError(
        'AUTHENTICATION_REQUIRED',
        false,
        'OpenAI API key is not configured',
      );
    }

    for (const attempt of [1, 2]) {
      let result: AttemptResult<TOutput>;
      try {
        result = await this.#generateAttempt(request, this.#client);
      } catch (error) {
        const dependencyError = toOpenAiDependencyError(error);
        await this.#record({
          attempt,
          durationMs: 0,
          model: request.model,
          outcome: 'failed',
          request,
          reviewReason: null,
          usage: emptyUsage,
        });
        throw dependencyError;
      }

      if (result.reason === 'refusal') {
        const metadata = await this.#record({
          attempt,
          durationMs: result.durationMs,
          model: result.model,
          outcome: 'needs_review',
          request,
          reviewReason: result.reason,
          usage: result.usage,
        });
        return { metadata, reason: result.reason, status: 'needs_review' };
      }

      if (result.reason === 'invalid_output') {
        const finalAttempt = attempt === 2;
        const metadata = await this.#record({
          attempt,
          durationMs: result.durationMs,
          model: result.model,
          outcome: finalAttempt ? 'needs_review' : 'invalid_output',
          request,
          reviewReason: finalAttempt ? result.reason : null,
          usage: result.usage,
        });
        if (finalAttempt) {
          return { metadata, reason: result.reason, status: 'needs_review' };
        }
        continue;
      }

      const metadata = await this.#record({
        attempt,
        durationMs: result.durationMs,
        model: result.model,
        outcome: 'completed',
        request,
        reviewReason: null,
        usage: result.usage,
      });
      return { data: result.data as TOutput, metadata, status: 'completed' };
    }

    throw new Error('OpenAI structured output retry loop ended unexpectedly');
  }

  async #generateAttempt<TOutput>(
    request: StructuredLlmRequest<TOutput>,
    client: OpenAiStructuredClient,
  ): Promise<AttemptResult<TOutput>> {
    const controller = new AbortController();
    const startedAt = this.#now();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeoutError = new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(new OpenAiTimeoutError());
        }, this.#timeoutMs);
      });
      const response = await Promise.race([
        client.parse(
          {
            model: request.model,
            schema: request.schema as z.ZodType<unknown>,
            schemaName: request.schemaName,
            systemPrompt: request.systemPrompt,
            userInput: request.userInput,
          },
          { signal: controller.signal },
        ),
        timeoutError,
      ]);
      const model = response.model ?? request.model;
      const usage = normalizeUsage(response.usage);
      const durationMs = durationBetween(startedAt, this.#now());
      const refusal = findRefusal(response);
      if (refusal) {
        return { durationMs, model, reason: 'refusal', usage };
      }
      const parsed = findParsedOutput(response);
      const validated = request.schema.safeParse(parsed);
      if (!validated.success) {
        return { durationMs, model, reason: 'invalid_output', usage };
      }
      return { data: validated.data, durationMs, model, usage };
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }

  async #record<TOutput>(input: {
    readonly attempt: number;
    readonly durationMs: number;
    readonly model: string;
    readonly outcome: LlmInvocationOutcome;
    readonly request: StructuredLlmRequest<TOutput>;
    readonly reviewReason: LlmNeedsReviewReason | null;
    readonly usage: LlmUsage;
  }): Promise<LlmInvocationMetadata> {
    const estimatedCostUsd = estimateOpenAiCostUsd(input.model, input.usage);
    const createdAt = this.#now();
    try {
      await this.options.invocationRepository.recordInvocation({
        attempt: input.attempt,
        createdAt,
        durationMs: input.durationMs,
        estimatedCostUsd,
        inputTokens: input.usage.inputTokens,
        model: input.model,
        outcome: input.outcome,
        outputTokens: input.usage.outputTokens,
        promptVersion: input.request.promptVersion,
        provider: 'openai',
        reviewReason: input.reviewReason,
        runId: input.request.runId,
        schemaName: input.request.schemaName,
        schemaVersion: input.request.schemaVersion,
        totalTokens: input.usage.totalTokens,
      });
    } catch (error) {
      throw new AgentDependencyError(
        'TEMPORARY_UNAVAILABLE',
        true,
        'LLM invocation metadata could not be saved',
        { cause: error },
      );
    }
    return {
      attempts: input.attempt,
      durationMs: input.durationMs,
      estimatedCostUsd,
      model: input.model,
      promptVersion: input.request.promptVersion,
      schemaName: input.request.schemaName,
      schemaVersion: input.request.schemaVersion,
      usage: input.usage,
    };
  }
}

class OpenAiSdkClient implements OpenAiStructuredClient {
  constructor(private readonly client: OpenAI) {}

  async parse(
    request: {
      readonly model: string;
      readonly schema: z.ZodType<unknown>;
      readonly schemaName: string;
      readonly systemPrompt: string;
      readonly userInput: string;
    },
    options?: { readonly signal?: AbortSignal },
  ): Promise<OpenAiStructuredResponse> {
    return (await this.client.responses.parse(
      {
        input: request.userInput,
        instructions: request.systemPrompt,
        model: request.model,
        store: false,
        text: { format: zodTextFormat(request.schema, request.schemaName) },
      },
      options,
    )) as unknown as OpenAiStructuredResponse;
  }
}

class OpenAiTimeoutError extends Error {
  constructor() {
    super('OpenAI request timed out');
    this.name = 'OpenAiTimeoutError';
  }
}

const emptyUsage: LlmUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

const openAiPricingCatalog = {
  'gpt-5.6': { inputPerMillionUsd: 5, outputPerMillionUsd: 30 },
  'gpt-5.6-luna': { inputPerMillionUsd: 1, outputPerMillionUsd: 6 },
  'gpt-5.6-sol': { inputPerMillionUsd: 5, outputPerMillionUsd: 30 },
  'gpt-5.6-terra': { inputPerMillionUsd: 2.5, outputPerMillionUsd: 15 },
} as const;

export const openAiPricingCatalogVersion = '2026-07-19';

export function estimateOpenAiCostUsd(model: string, usage: LlmUsage): number | null {
  const pricing = openAiPricingCatalog[model as keyof typeof openAiPricingCatalog];
  if (!pricing) {
    return null;
  }
  return Number(
    (
      (usage.inputTokens * pricing.inputPerMillionUsd +
        usage.outputTokens * pricing.outputPerMillionUsd) /
      1_000_000
    ).toFixed(8),
  );
}

function createSdkClient(apiKey: string | undefined): OpenAiStructuredClient | undefined {
  if (!apiKey?.trim()) {
    return undefined;
  }
  return new OpenAiSdkClient(new OpenAI({ apiKey }));
}

function durationBetween(startedAt: Date, completedAt: Date): number {
  return Math.max(0, completedAt.getTime() - startedAt.getTime());
}

function findParsedOutput(response: OpenAiStructuredResponse): unknown {
  for (const output of response.output) {
    if (output.type !== 'message') {
      continue;
    }
    for (const content of output.content) {
      if (content.type === 'output_text' && content.parsed !== undefined) {
        return content.parsed;
      }
    }
  }
  return undefined;
}

function findRefusal(response: OpenAiStructuredResponse): boolean {
  return response.output.some(
    (output) =>
      output.type === 'message' &&
      output.content.some((content) => content.type === 'refusal' && Boolean(content.refusal)),
  );
}

function normalizeUsage(usage: OpenAiStructuredResponse['usage']): LlmUsage {
  const inputTokens = nonNegativeInteger(usage?.input_tokens) ?? 0;
  const outputTokens = nonNegativeInteger(usage?.output_tokens) ?? 0;
  const totalTokens = nonNegativeInteger(usage?.total_tokens) ?? inputTokens + outputTokens;
  return { inputTokens, outputTokens, totalTokens };
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function toOpenAiDependencyError(error: unknown): AgentDependencyError {
  if (error instanceof AgentDependencyError) {
    return error;
  }
  if (
    error instanceof OpenAiTimeoutError ||
    (error instanceof Error && error.name === 'AbortError')
  ) {
    return new AgentDependencyError(
      'TEMPORARY_UNAVAILABLE',
      true,
      'OpenAI service is temporarily unavailable',
      { cause: error },
    );
  }
  const status =
    error && typeof error === 'object' && 'status' in error && typeof error.status === 'number'
      ? error.status
      : undefined;
  if (status === 401) {
    return new AgentDependencyError(
      'AUTHENTICATION_REQUIRED',
      false,
      'OpenAI authentication failed',
      { cause: error },
    );
  }
  if (status === 403) {
    return new AgentDependencyError('PERMISSION_DENIED', false, 'OpenAI access was denied', {
      cause: error,
    });
  }
  if (status === 400) {
    return new AgentDependencyError('INVALID_REQUEST', false, 'OpenAI rejected the request', {
      cause: error,
    });
  }
  if (status === 429) {
    return new AgentDependencyError('RATE_LIMITED', true, 'OpenAI rate limit was exceeded', {
      cause: error,
    });
  }
  if (status === 408 || (status !== undefined && status >= 500)) {
    return new AgentDependencyError(
      'TEMPORARY_UNAVAILABLE',
      true,
      'OpenAI service is temporarily unavailable',
      { cause: error },
    );
  }
  if (status === undefined) {
    return new AgentDependencyError(
      'TEMPORARY_UNAVAILABLE',
      true,
      'OpenAI service is temporarily unavailable',
      { cause: error },
    );
  }
  return new AgentDependencyError('UNKNOWN', false, 'OpenAI request failed', { cause: error });
}

function validateRequest<TOutput>(request: StructuredLlmRequest<TOutput>): void {
  for (const [label, value] of Object.entries({
    model: request.model,
    promptVersion: request.promptVersion,
    runId: request.runId,
    schemaName: request.schemaName,
    schemaVersion: request.schemaVersion,
    systemPrompt: request.systemPrompt,
    userInput: request.userInput,
  })) {
    if (!value.trim()) {
      throw new AgentDependencyError('INVALID_REQUEST', false, `LLM ${label} must not be empty`);
    }
  }
}
