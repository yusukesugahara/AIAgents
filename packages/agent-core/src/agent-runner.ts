import type { AgentRunRepository } from './agent.types';
import type { AgentContext } from './agent-context';
import type { AgentRegistry } from './agent-registry';
import {
  AgentCoreError,
  AgentDependencyError,
  AgentRunPersistenceError,
  RetryableJobError,
} from './errors';
import { createUuidV7 } from './uuidv7';

export interface AgentRunRequest {
  readonly agentId: string;
  readonly jobId: string;
  readonly input: unknown;
  readonly signal?: AbortSignal;
  readonly triggerType: string;
}

export interface AgentRunResult<TOutput = unknown> {
  readonly runId: string;
  readonly output: TOutput;
}

export interface AgentRunnerOptions {
  readonly registry: AgentRegistry;
  readonly repository: AgentRunRepository;
  readonly now?: () => Date;
  readonly runIdGenerator?: () => string;
}

export class AgentRunner {
  readonly #now: () => Date;
  readonly #runIdGenerator: () => string;

  constructor(private readonly options: AgentRunnerOptions) {
    this.#now = options.now ?? (() => new Date());
    this.#runIdGenerator = options.runIdGenerator ?? createUuidV7;
  }

  async run(request: AgentRunRequest): Promise<AgentRunResult> {
    const agent = this.options.registry.get(request.agentId);

    if (!agent.manifest.triggers.includes(request.triggerType)) {
      throw new AgentCoreError(
        'AGENT_TRIGGER_UNSUPPORTED',
        `Agent "${request.agentId}" does not support trigger "${request.triggerType}"`,
      );
    }

    const inputResult = agent.inputSchema.safeParse(request.input);

    if (!inputResult.success) {
      throw new AgentCoreError(
        'AGENT_INPUT_INVALID',
        `Agent "${request.agentId}" received invalid input: ${inputResult.error.message}`,
      );
    }

    const runId = this.#runIdGenerator();
    const startedAt = this.#now();
    const context: AgentContext = {
      runId,
      jobId: request.jobId,
      agentId: request.agentId,
      triggerType: request.triggerType,
      startedAt,
      signal: request.signal ?? new AbortController().signal,
    };

    await this.#persistStart({
      runId,
      jobId: request.jobId,
      agentId: request.agentId,
      triggerType: request.triggerType,
      input: inputResult.data,
      startedAt,
    });

    try {
      const output = await agent.run(context, inputResult.data);
      const outputResult = agent.outputSchema.safeParse(output);

      if (!outputResult.success) {
        throw new AgentCoreError(
          'AGENT_OUTPUT_INVALID',
          `Agent "${request.agentId}" returned invalid output: ${outputResult.error.message}`,
        );
      }

      await this.#persistCompletion({ runId, output: outputResult.data, completedAt: this.#now() });
      return { runId, output: outputResult.data };
    } catch (error) {
      if (error instanceof AgentRunPersistenceError) {
        throw error;
      }

      const agentError = this.#toExecutionError(request.agentId, runId, error);

      await this.#persistFailure({
        runId,
        errorCode:
          agentError instanceof AgentCoreError || agentError instanceof AgentDependencyError
            ? agentError.code
            : 'JOB_RETRYABLE',
        errorMessage: agentError.message,
        completedAt: this.#now(),
      });

      throw agentError;
    }
  }

  async #persistStart(input: Parameters<AgentRunRepository['startRun']>[0]): Promise<void> {
    try {
      await this.options.repository.startRun(input);
    } catch (error) {
      throw new AgentRunPersistenceError('Failed to save Agent Run start', {
        cause: error,
      });
    }
  }

  async #persistCompletion(input: Parameters<AgentRunRepository['completeRun']>[0]): Promise<void> {
    try {
      await this.options.repository.completeRun(input);
    } catch (error) {
      throw new AgentRunPersistenceError('Failed to save Agent Run completion', { cause: error });
    }
  }

  async #persistFailure(input: Parameters<AgentRunRepository['failRun']>[0]): Promise<void> {
    try {
      await this.options.repository.failRun(input);
    } catch (error) {
      throw new AgentRunPersistenceError('Failed to save Agent Run failure', {
        cause: error,
      });
    }
  }

  #toExecutionError(
    agentId: string,
    runId: string,
    error: unknown,
  ): AgentCoreError | AgentDependencyError | RetryableJobError {
    if (error instanceof AgentCoreError) {
      return error;
    }

    if (error instanceof RetryableJobError) {
      return error;
    }

    if (error instanceof AgentDependencyError) {
      return error;
    }

    const message = error instanceof Error ? error.message : String(error);
    return new AgentCoreError(
      'AGENT_EXECUTION_FAILED',
      `Agent "${agentId}" failed during run "${runId}": ${message}`,
      { cause: error },
    );
  }
}
