import type { z } from 'zod';

import type { AgentContext } from './agent-context';

export interface AgentManifest {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly triggers: readonly string[];
}

export interface AgentDefinition<TInput, TOutput> {
  readonly manifest: AgentManifest;
  readonly inputSchema: z.ZodType<TInput>;
  readonly outputSchema: z.ZodType<TOutput>;
  run(context: AgentContext, input: TInput): Promise<TOutput>;
}

export interface AgentRunStart {
  readonly runId: string;
  readonly jobId: string;
  readonly agentId: string;
  readonly triggerType: string;
  readonly input: unknown;
  readonly startedAt: Date;
}

export interface AgentRunCompletion {
  readonly runId: string;
  readonly output: unknown;
  readonly completedAt: Date;
}

export interface AgentRunFailure {
  readonly runId: string;
  readonly errorCode: string;
  readonly errorMessage: string;
  readonly completedAt: Date;
}

export interface AgentRun {
  readonly id: string;
  readonly jobId: string;
  readonly agentId: string;
  readonly status: 'running' | 'completed' | 'failed';
  readonly triggerType: string;
  readonly errorCode: string | null;
  readonly startedAt: Date;
  readonly completedAt: Date | null;
}

export interface AgentRunRepository {
  startRun(run: AgentRunStart): Promise<void>;
  completeRun(run: AgentRunCompletion): Promise<void>;
  failRun(run: AgentRunFailure): Promise<void>;
  getRun(runId: string): Promise<AgentRun | null>;
}
