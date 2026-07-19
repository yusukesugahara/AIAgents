import type { AgentRunRepository } from './agent.types';
import type { AgentContext } from './agent-context';
import type { AgentRegistry } from './agent-registry';
import { AgentCoreError, RetryableJobError } from './errors';

export interface AgentRunRequest {
  readonly agentId: string;
  readonly jobId: string;
  readonly input: unknown;
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
    this.#runIdGenerator = options.runIdGenerator ?? crypto.randomUUID;
  }

  async run(request: AgentRunRequest): Promise<AgentRunResult> {
    const agent = this.options.registry.get(request.agentId);
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
      const agentError = this.#toExecutionError(request.agentId, runId, error);

      await this.#persistFailure({
        runId,
        errorCode: agentError instanceof AgentCoreError ? agentError.code : 'JOB_RETRYABLE',
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
      throw new AgentCoreError('AGENT_RUN_PERSISTENCE_FAILED', 'Failed to save Agent Run start', {
        cause: error,
      });
    }
  }

  async #persistCompletion(input: Parameters<AgentRunRepository['completeRun']>[0]): Promise<void> {
    try {
      await this.options.repository.completeRun(input);
    } catch (error) {
      throw new AgentCoreError(
        'AGENT_RUN_PERSISTENCE_FAILED',
        'Failed to save Agent Run completion',
        {
          cause: error,
        },
      );
    }
  }

  async #persistFailure(input: Parameters<AgentRunRepository['failRun']>[0]): Promise<void> {
    try {
      await this.options.repository.failRun(input);
    } catch (error) {
      throw new AgentCoreError('AGENT_RUN_PERSISTENCE_FAILED', 'Failed to save Agent Run failure', {
        cause: error,
      });
    }
  }

  #toExecutionError(
    agentId: string,
    runId: string,
    error: unknown,
  ): AgentCoreError | RetryableJobError {
    if (error instanceof AgentCoreError) {
      return error;
    }

    if (error instanceof RetryableJobError) {
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
