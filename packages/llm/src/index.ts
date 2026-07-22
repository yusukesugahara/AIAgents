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
  readonly signal?: AbortSignal;
  readonly systemPrompt: string;
  readonly userInput: string;
}

export interface LlmFunctionTool {
  readonly description: string;
  readonly execute: (arguments_: unknown, context: LlmToolExecutionContext) => Promise<unknown>;
  readonly maxCalls: number;
  readonly name: string;
  readonly parameters: Record<string, unknown>;
  readonly schema: z.ZodType<unknown>;
}

export interface LlmToolExecutionContext {
  readonly callId: string;
  readonly signal?: AbortSignal;
}

export type LlmToolChoice = 'auto' | 'required' | { readonly name: string };

export interface ToolLoopLlmRequest<TOutput> extends StructuredLlmRequest<TOutput> {
  readonly initialToolChoice?: LlmToolChoice;
  readonly maxToolCalls?: number;
  readonly maxTurns?: number;
  readonly requiredToolNames?: readonly string[];
  readonly tools: readonly LlmFunctionTool[];
}

export interface LlmToolCallMetadata {
  readonly callId: string;
  readonly name: string;
  /** Application-side tool result, distinct from the LLM protocol outcome. */
  readonly outcome: 'completed' | 'created' | 'rejected' | 'reused';
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
  readonly toolCalls?: readonly LlmToolCallMetadata[];
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
  runToolLoop<TOutput>(request: ToolLoopLlmRequest<TOutput>): Promise<StructuredLlmResult<TOutput>>;
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
  readonly status?: string;
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
  createToolTurn?(
    request: OpenAiToolTurnRequest,
    options?: { readonly signal?: AbortSignal },
  ): Promise<OpenAiToolTurnResponse>;
}

export interface OpenAiToolTurnRequest {
  readonly input: readonly unknown[];
  readonly model: string;
  readonly schema: z.ZodType<unknown>;
  readonly schemaName: string;
  readonly systemPrompt: string;
  readonly toolChoice: LlmToolChoice;
  readonly tools: readonly Pick<LlmFunctionTool, 'description' | 'name' | 'parameters'>[];
}

export interface OpenAiToolTurnResponse extends OpenAiStructuredResponse {
  readonly output: readonly {
    readonly arguments?: string;
    readonly callId?: string;
    readonly content: readonly {
      readonly parsed?: unknown;
      readonly refusal?: string;
      readonly type: string;
    }[];
    readonly name?: string;
    readonly type: string;
  }[];
  readonly rawOutput: readonly unknown[];
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
  readonly toolCalls?: readonly LlmToolCallMetadata[];
}

const defaultTimeoutMs = 30_000;
const defaultMaximumToolCalls = 8;
const defaultMaximumToolTurns = 10;
const maximumToolOutputBytes = 1024 * 1024;
const toolNamePattern = /^[A-Za-z0-9_-]{1,64}$/u;

/**
 * Calls OpenAI's Responses API through a typed boundary and records only invocation metadata.
 * Prompts and model outputs are intentionally never persisted by this provider.
 */
export class OpenAiLlmProvider implements LlmProvider {
  readonly #client: OpenAiStructuredClient | undefined;
  readonly #invocationRepository: LlmInvocationRepository;
  readonly #now: () => Date;
  readonly #timeoutMs: number;

  constructor(options: OpenAiLlmProviderOptions) {
    this.#client = options.client ?? createSdkClient(options.apiKey);
    this.#invocationRepository = options.invocationRepository;
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

    let aggregateMetadata: LlmInvocationMetadata | undefined;
    for (const attempt of [1, 2]) {
      const attemptStartedAt = this.#now();
      let result: AttemptResult<TOutput>;
      try {
        result = await this.#generateAttempt(request, this.#client);
      } catch (error) {
        const dependencyError = toOpenAiDependencyError(error);
        await this.#record({
          attempt,
          durationMs: durationBetween(attemptStartedAt, this.#now()),
          model: request.model,
          outcome: 'failed',
          request,
          reviewReason: null,
          usage: emptyUsage,
        });
        throw dependencyError;
      }

      if (result.reason === 'refusal') {
        const attemptMetadata = await this.#record({
          attempt,
          durationMs: result.durationMs,
          model: result.model,
          outcome: 'needs_review',
          request,
          reviewReason: result.reason,
          usage: result.usage,
        });
        const metadata = combineInvocationMetadata(aggregateMetadata, attemptMetadata);
        return { metadata, reason: result.reason, status: 'needs_review' };
      }

      if (result.reason === 'invalid_output') {
        const finalAttempt = attempt === 2;
        const attemptMetadata = await this.#record({
          attempt,
          durationMs: result.durationMs,
          model: result.model,
          outcome: finalAttempt ? 'needs_review' : 'invalid_output',
          request,
          reviewReason: finalAttempt ? result.reason : null,
          usage: result.usage,
        });
        const metadata = combineInvocationMetadata(aggregateMetadata, attemptMetadata);
        if (finalAttempt) {
          return { metadata, reason: result.reason, status: 'needs_review' };
        }
        aggregateMetadata = metadata;
        continue;
      }

      const attemptMetadata = await this.#record({
        attempt,
        durationMs: result.durationMs,
        model: result.model,
        outcome: 'completed',
        request,
        reviewReason: null,
        usage: result.usage,
      });
      const metadata = combineInvocationMetadata(aggregateMetadata, attemptMetadata);
      return { data: result.data as TOutput, metadata, status: 'completed' };
    }

    throw new Error('OpenAI structured output retry loop ended unexpectedly');
  }

  async runToolLoop<TOutput>(
    request: ToolLoopLlmRequest<TOutput>,
  ): Promise<StructuredLlmResult<TOutput>> {
    validateToolLoopRequest(request);
    if (!this.#client?.createToolTurn) {
      throw new AgentDependencyError(
        'AUTHENTICATION_REQUIRED',
        false,
        'OpenAI API key is not configured',
      );
    }

    const attemptStartedAt = this.#now();
    let result: AttemptResult<TOutput>;
    try {
      result = await this.#runToolLoopAttempt(
        request,
        this.#client.createToolTurn.bind(this.#client),
      );
    } catch (error) {
      const dependencyError = toOpenAiDependencyError(error);
      await this.#record({
        attempt: 1,
        durationMs: durationBetween(attemptStartedAt, this.#now()),
        model: request.model,
        outcome: 'failed',
        request,
        reviewReason: null,
        usage: emptyUsage,
      });
      throw dependencyError;
    }

    const outcome = result.reason ? 'needs_review' : 'completed';
    const metadata = await this.#record({
      attempt: 1,
      durationMs: result.durationMs,
      model: result.model,
      outcome,
      request,
      reviewReason: result.reason ?? null,
      ...(result.toolCalls ? { toolCalls: result.toolCalls } : {}),
      usage: result.usage,
    });
    if (result.reason) {
      return { metadata, reason: result.reason, status: 'needs_review' };
    }
    return { data: result.data as TOutput, metadata, status: 'completed' };
  }

  async #runToolLoopAttempt<TOutput>(
    request: ToolLoopLlmRequest<TOutput>,
    createTurn: NonNullable<OpenAiStructuredClient['createToolTurn']>,
  ): Promise<AttemptResult<TOutput>> {
    const controller = new AbortController();
    const startedAt = this.#now();
    const externalSignal = request.signal;
    let externalAbortHandler: (() => void) | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const input: unknown[] = [{ content: request.userInput, role: 'user' }];
    const toolsByName = new Map(request.tools.map((tool) => [tool.name, tool]));
    const requiredToolNames = new Set(request.requiredToolNames ?? []);
    const calledToolNames = new Set<string>();
    const toolCallCounts = new Map<string, number>();
    const seenCallIds = new Set<string>();
    const toolCalls: LlmToolCallMetadata[] = [];
    let usage = emptyUsage;
    let model = request.model;

    try {
      if (externalSignal?.aborted) throw new OpenAiCancelledError();
      const timeoutError = new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(new OpenAiTimeoutError());
        }, this.#timeoutMs);
      });
      const cancellationError = new Promise<never>((_, reject) => {
        if (!externalSignal) return;
        externalAbortHandler = () => {
          controller.abort();
          reject(new OpenAiCancelledError());
        };
        externalSignal.addEventListener('abort', externalAbortHandler, { once: true });
      });

      const maxTurns = request.maxTurns ?? defaultMaximumToolTurns;
      const maxToolCalls = request.maxToolCalls ?? defaultMaximumToolCalls;
      for (let turn = 0; turn < maxTurns; turn += 1) {
        const remainingRequiredToolNames = [...requiredToolNames].filter(
          (name) => !calledToolNames.has(name),
        );
        const toolChoice =
          turn === 0 && request.initialToolChoice !== undefined
            ? request.initialToolChoice
            : remainingRequiredToolNames.length === 1
              ? { name: remainingRequiredToolNames[0] as string }
              : remainingRequiredToolNames.length > 1
                ? 'required'
                : 'auto';
        const response = await Promise.race([
          createTurn(
            {
              input,
              model: request.model,
              schema: request.schema as z.ZodType<unknown>,
              schemaName: request.schemaName,
              systemPrompt: request.systemPrompt,
              toolChoice,
              tools: request.tools,
            },
            { signal: controller.signal },
          ),
          timeoutError,
          cancellationError,
        ]);
        model = response.model ?? model;
        usage = addUsage(usage, normalizeUsage(response.usage));
        if (response.status && response.status !== 'completed') {
          return invalidToolLoopAttempt(startedAt, this.#now(), model, usage, toolCalls);
        }
        if (findRefusal(response)) {
          return {
            durationMs: durationBetween(startedAt, this.#now()),
            model,
            reason: 'refusal',
            toolCalls,
            usage,
          };
        }

        input.push(...response.rawOutput);
        const calls = response.output.filter((item) => item.type === 'function_call');
        if (calls.length === 0) {
          if (!response.output.some((item) => item.type === 'message')) {
            continue;
          }
          const hasEveryRequiredTool = [...requiredToolNames].every((name) =>
            calledToolNames.has(name),
          );
          const validated = request.schema.safeParse(findParsedOutput(response));
          if (!hasEveryRequiredTool || !validated.success) {
            return invalidToolLoopAttempt(startedAt, this.#now(), model, usage, toolCalls);
          }
          return {
            data: validated.data,
            durationMs: durationBetween(startedAt, this.#now()),
            model,
            toolCalls,
            usage,
          };
        }

        if (toolCalls.length + calls.length > maxToolCalls) {
          return invalidToolLoopAttempt(startedAt, this.#now(), model, usage, toolCalls);
        }
        const batchCallIds = new Set<string>();
        const projectedCallCounts = new Map(toolCallCounts);
        const validatedCalls: Array<{
          readonly arguments: unknown;
          readonly callId: string;
          readonly tool: LlmFunctionTool;
        }> = [];
        for (const call of calls) {
          if (!call.name || !call.callId || typeof call.arguments !== 'string') {
            return invalidToolLoopAttempt(startedAt, this.#now(), model, usage, toolCalls);
          }
          if (seenCallIds.has(call.callId) || batchCallIds.has(call.callId)) {
            return invalidToolLoopAttempt(startedAt, this.#now(), model, usage, toolCalls);
          }
          const tool = toolsByName.get(call.name);
          const parsedArguments = parseJson(call.arguments);
          const validatedArguments = tool?.schema.safeParse(parsedArguments);
          if (!tool || !validatedArguments?.success) {
            return invalidToolLoopAttempt(startedAt, this.#now(), model, usage, toolCalls);
          }
          const projectedCallCount = (projectedCallCounts.get(tool.name) ?? 0) + 1;
          if (projectedCallCount > tool.maxCalls) {
            return invalidToolLoopAttempt(startedAt, this.#now(), model, usage, toolCalls);
          }
          projectedCallCounts.set(tool.name, projectedCallCount);
          batchCallIds.add(call.callId);
          validatedCalls.push({
            arguments: validatedArguments.data,
            callId: call.callId,
            tool,
          });
        }
        for (const call of validatedCalls) {
          const output = await Promise.race([
            call.tool.execute(call.arguments, {
              callId: call.callId,
              signal: controller.signal,
            }),
            timeoutError,
            cancellationError,
          ]);
          const callCount = (toolCallCounts.get(call.tool.name) ?? 0) + 1;
          toolCallCounts.set(call.tool.name, callCount);
          calledToolNames.add(call.tool.name);
          seenCallIds.add(call.callId);
          toolCalls.push({
            callId: call.callId,
            name: call.tool.name,
            outcome: toolCallOutcome(output),
          });
          input.push({
            call_id: call.callId,
            output: serializeToolOutput(output),
            type: 'function_call_output',
          });
        }
      }
      return invalidToolLoopAttempt(startedAt, this.#now(), model, usage, toolCalls);
    } finally {
      if (timeout) clearTimeout(timeout);
      if (externalAbortHandler) externalSignal?.removeEventListener('abort', externalAbortHandler);
    }
  }

  async #generateAttempt<TOutput>(
    request: StructuredLlmRequest<TOutput>,
    client: OpenAiStructuredClient,
  ): Promise<AttemptResult<TOutput>> {
    const controller = new AbortController();
    const startedAt = this.#now();
    const externalSignal = request.signal;
    let externalAbortHandler: (() => void) | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      if (externalSignal?.aborted) {
        throw new OpenAiCancelledError();
      }
      const timeoutError = new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(new OpenAiTimeoutError());
        }, this.#timeoutMs);
      });
      const cancellationError = new Promise<never>((_, reject) => {
        if (!externalSignal) {
          return;
        }
        externalAbortHandler = () => {
          controller.abort();
          reject(new OpenAiCancelledError());
        };
        externalSignal.addEventListener('abort', externalAbortHandler, { once: true });
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
        cancellationError,
      ]);
      const model = response.model ?? request.model;
      const usage = normalizeUsage(response.usage);
      const durationMs = durationBetween(startedAt, this.#now());
      if (response.status && response.status !== 'completed') {
        return { durationMs, model, reason: 'invalid_output', usage };
      }
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
      if (externalAbortHandler) {
        externalSignal?.removeEventListener('abort', externalAbortHandler);
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
    readonly toolCalls?: readonly LlmToolCallMetadata[];
    readonly usage: LlmUsage;
  }): Promise<LlmInvocationMetadata> {
    const estimatedCostUsd = estimateOpenAiCostUsd(input.model, input.usage);
    const createdAt = this.#now();
    try {
      await this.#invocationRepository.recordInvocation({
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
      ...(input.toolCalls ? { toolCalls: input.toolCalls } : {}),
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
    let format: ReturnType<typeof zodTextFormat>;
    try {
      format = zodTextFormat(request.schema, request.schemaName);
    } catch (error) {
      throw new AgentDependencyError(
        'INVALID_REQUEST',
        false,
        'OpenAI structured output schema is invalid',
        { cause: error },
      );
    }

    const response = await this.client.responses.create(
      {
        input: request.userInput,
        instructions: request.systemPrompt,
        model: request.model,
        ...(request.model === 'gpt-5.6-luna' ? { reasoning: { effort: 'low' as const } } : {}),
        store: false,
        text: { format },
      },
      options,
    );

    return {
      model: response.model,
      output: response.output.map((output) => ({
        content:
          output.type === 'message'
            ? output.content.map((content) => {
                if (content.type === 'output_text') {
                  return { parsed: parseJson(content.text), type: content.type };
                }
                return { refusal: content.refusal, type: content.type };
              })
            : [],
        type: output.type,
      })),
      ...(response.status ? { status: response.status } : {}),
      ...(response.usage
        ? {
            usage: {
              input_tokens: response.usage.input_tokens,
              output_tokens: response.usage.output_tokens,
              total_tokens: response.usage.total_tokens,
            },
          }
        : {}),
    };
  }

  async createToolTurn(
    request: OpenAiToolTurnRequest,
    options?: { readonly signal?: AbortSignal },
  ): Promise<OpenAiToolTurnResponse> {
    let format: ReturnType<typeof zodTextFormat>;
    try {
      format = zodTextFormat(request.schema, request.schemaName);
    } catch (error) {
      throw new AgentDependencyError(
        'INVALID_REQUEST',
        false,
        'OpenAI structured output schema is invalid',
        { cause: error },
      );
    }
    const toolChoice =
      typeof request.toolChoice === 'object'
        ? { name: request.toolChoice.name, type: 'function' as const }
        : request.toolChoice;
    const response = await this.client.responses.create(
      {
        include: ['reasoning.encrypted_content'],
        input: request.input as never,
        instructions: request.systemPrompt,
        model: request.model,
        parallel_tool_calls: false,
        ...(request.model === 'gpt-5.6-luna' ? { reasoning: { effort: 'low' as const } } : {}),
        store: false,
        text: { format },
        tool_choice: toolChoice,
        tools: request.tools.map((tool) => ({
          description: tool.description,
          name: tool.name,
          parameters: tool.parameters,
          strict: true,
          type: 'function' as const,
        })) as never,
      },
      options,
    );

    return {
      model: response.model,
      output: response.output.map((output) => {
        if (output.type === 'function_call') {
          return {
            arguments: output.arguments,
            callId: output.call_id,
            content: [],
            name: output.name,
            type: output.type,
          };
        }
        return {
          content:
            output.type === 'message'
              ? output.content.map((content) => {
                  if (content.type === 'output_text') {
                    return { parsed: parseJson(content.text), type: content.type };
                  }
                  return { refusal: content.refusal, type: content.type };
                })
              : [],
          type: output.type,
        };
      }),
      rawOutput: response.output,
      ...(response.status ? { status: response.status } : {}),
      ...(response.usage
        ? {
            usage: {
              input_tokens: response.usage.input_tokens,
              output_tokens: response.usage.output_tokens,
              total_tokens: response.usage.total_tokens,
            },
          }
        : {}),
    };
  }
}

class OpenAiTimeoutError extends Error {
  constructor() {
    super('OpenAI request timed out');
    this.name = 'OpenAiTimeoutError';
  }
}

class OpenAiCancelledError extends Error {
  constructor() {
    super('OpenAI request was cancelled');
    this.name = 'AbortError';
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
const longContextInputThreshold = 272_000;
const longContextInputMultiplier = 2;
const longContextOutputMultiplier = 1.5;

export function estimateOpenAiCostUsd(model: string, usage: LlmUsage): number | null {
  const pricing = openAiPricingCatalog[model as keyof typeof openAiPricingCatalog];
  if (!pricing) {
    return null;
  }
  const longContext = usage.inputTokens > longContextInputThreshold;
  const inputMultiplier = longContext ? longContextInputMultiplier : 1;
  const outputMultiplier = longContext ? longContextOutputMultiplier : 1;
  return Number(
    (
      (usage.inputTokens * pricing.inputPerMillionUsd * inputMultiplier +
        usage.outputTokens * pricing.outputPerMillionUsd * outputMultiplier) /
      1_000_000
    ).toFixed(8),
  );
}

function createSdkClient(apiKey: string | undefined): OpenAiStructuredClient | undefined {
  if (!apiKey?.trim()) {
    return undefined;
  }
  return new OpenAiSdkClient(new OpenAI({ apiKey, maxRetries: 0 }));
}

function combineInvocationMetadata(
  previous: LlmInvocationMetadata | undefined,
  current: LlmInvocationMetadata,
): LlmInvocationMetadata {
  if (!previous) {
    return current;
  }
  return {
    ...current,
    durationMs: previous.durationMs + current.durationMs,
    estimatedCostUsd:
      previous.estimatedCostUsd === null || current.estimatedCostUsd === null
        ? null
        : Number((previous.estimatedCostUsd + current.estimatedCostUsd).toFixed(8)),
    usage: {
      inputTokens: previous.usage.inputTokens + current.usage.inputTokens,
      outputTokens: previous.usage.outputTokens + current.usage.outputTokens,
      totalTokens: previous.usage.totalTokens + current.usage.totalTokens,
    },
  };
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

function addUsage(left: LlmUsage, right: LlmUsage): LlmUsage {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    totalTokens: left.totalTokens + right.totalTokens,
  };
}

function toolCallOutcome(output: unknown): 'completed' | 'created' | 'rejected' | 'reused' {
  if (output && typeof output === 'object' && 'status' in output) {
    const status = output.status;
    if (status === 'created' || status === 'rejected' || status === 'reused') return status;
  }
  return 'completed';
}

function invalidToolLoopAttempt<TOutput>(
  startedAt: Date,
  completedAt: Date,
  model: string,
  usage: LlmUsage,
  toolCalls: readonly LlmToolCallMetadata[],
): AttemptResult<TOutput> {
  return {
    durationMs: durationBetween(startedAt, completedAt),
    model,
    reason: 'invalid_output',
    toolCalls,
    usage,
  };
}

function serializeToolOutput(value: unknown): string {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch (error) {
    throw new AgentDependencyError('INVALID_RESPONSE', false, 'LLM tool output is invalid', {
      cause: error,
    });
  }
  if (serialized === undefined) {
    throw new AgentDependencyError('INVALID_RESPONSE', false, 'LLM tool returned no output');
  }
  if (Buffer.byteLength(serialized, 'utf8') > maximumToolOutputBytes) {
    throw new AgentDependencyError('INVALID_RESPONSE', false, 'LLM tool output is too large');
  }
  return serialized;
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
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
    );
  }
  if (status === 403) {
    return new AgentDependencyError('PERMISSION_DENIED', false, 'OpenAI access was denied');
  }
  if (status === 404) {
    return new AgentDependencyError('NOT_FOUND', false, 'OpenAI resource was not found');
  }
  if (status === 400 || status === 422) {
    return new AgentDependencyError('INVALID_REQUEST', false, 'OpenAI rejected the request');
  }
  if (status === 429) {
    return new AgentDependencyError('RATE_LIMITED', true, 'OpenAI rate limit was exceeded');
  }
  if (status === 408 || status === 409 || (status !== undefined && status >= 500)) {
    return new AgentDependencyError(
      'TEMPORARY_UNAVAILABLE',
      true,
      'OpenAI service is temporarily unavailable',
    );
  }
  if (status === undefined) {
    return new AgentDependencyError(
      'TEMPORARY_UNAVAILABLE',
      true,
      'OpenAI service is temporarily unavailable',
    );
  }
  return new AgentDependencyError('UNKNOWN', false, 'OpenAI request failed');
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
    if (typeof value !== 'string' || !value.trim()) {
      throw new AgentDependencyError('INVALID_REQUEST', false, `LLM ${label} must not be empty`);
    }
  }
  if (!request.schema || typeof request.schema.safeParse !== 'function') {
    throw new AgentDependencyError('INVALID_REQUEST', false, 'LLM schema is invalid');
  }
}

function validateToolLoopRequest<TOutput>(request: ToolLoopLlmRequest<TOutput>): void {
  validateRequest(request);
  if (!Array.isArray(request.tools) || request.tools.length === 0) {
    throw new AgentDependencyError('INVALID_REQUEST', false, 'LLM tools must not be empty');
  }
  const names = new Set<string>();
  for (const tool of request.tools) {
    if (
      !toolNamePattern.test(tool.name) ||
      !tool.description?.trim() ||
      !Number.isSafeInteger(tool.maxCalls) ||
      tool.maxCalls <= 0 ||
      names.has(tool.name) ||
      !tool.schema ||
      typeof tool.schema.safeParse !== 'function' ||
      !tool.parameters ||
      typeof tool.parameters !== 'object' ||
      typeof tool.execute !== 'function'
    ) {
      throw new AgentDependencyError('INVALID_REQUEST', false, 'LLM tool definition is invalid');
    }
    names.add(tool.name);
  }
  if ((request.requiredToolNames ?? []).some((name) => !names.has(name))) {
    throw new AgentDependencyError('INVALID_REQUEST', false, 'Required LLM tool is not defined');
  }
  if (typeof request.initialToolChoice === 'object' && !names.has(request.initialToolChoice.name)) {
    throw new AgentDependencyError('INVALID_REQUEST', false, 'Selected LLM tool is not defined');
  }
  for (const [label, value] of Object.entries({
    maxToolCalls: request.maxToolCalls ?? defaultMaximumToolCalls,
    maxTurns: request.maxTurns ?? defaultMaximumToolTurns,
  })) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new AgentDependencyError(
        'INVALID_REQUEST',
        false,
        `LLM ${label} must be a positive integer`,
      );
    }
  }
}
