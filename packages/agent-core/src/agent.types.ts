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
  /** A persistence-layer error message. Consumers must treat this as sensitive by default. */
  readonly errorMessage?: string | null;
  /** Subject captured from the completed Gmail fetch step, when available. */
  readonly emailSubject?: string | null;
  readonly startedAt: Date;
  readonly completedAt: Date | null;
  readonly output?: unknown | null;
}

export type AgentRunStepStatus = 'pending' | 'succeeded' | 'failed';

export interface AgentRunStep {
  readonly id: string;
  readonly runId: string;
  readonly sequence: number;
  readonly stepName: string;
  readonly status: AgentRunStepStatus;
  readonly input: unknown;
  readonly output: unknown | null;
  readonly errorCode: string | null;
  readonly startedAt: Date;
  readonly completedAt: Date | null;
}

export interface AgentRunStepStart {
  readonly runId: string;
  readonly sequence: number;
  readonly stepName: string;
  readonly input: unknown;
  readonly startedAt: Date;
}

export interface AgentRunStepCompletion {
  readonly runId: string;
  readonly stepName: string;
  readonly output: unknown;
  readonly completedAt: Date;
}

export interface AgentRunStepFailure {
  readonly runId: string;
  readonly stepName: string;
  readonly errorCode: string;
  readonly retryable: boolean;
  readonly completedAt: Date;
}

export interface AgentRunRepository {
  startRun(run: AgentRunStart): Promise<void>;
  completeRun(run: AgentRunCompletion): Promise<void>;
  failRun(run: AgentRunFailure): Promise<void>;
  getLatestRunForJob(jobId: string): Promise<AgentRun | null>;
  getRun(runId: string): Promise<AgentRun | null>;
}

export interface AgentRunListOptions {
  readonly limit: number;
  readonly offset: number;
}

export interface AgentRunListPage {
  readonly hasMore: boolean;
  readonly runs: readonly AgentRun[];
}

export interface AgentRunHistoryRepository {
  /** Returns Runs in reverse chronological order using startedAt and id as the stable sort key. */
  listRuns(options: AgentRunListOptions): Promise<AgentRunListPage>;
}

export interface AgentRunStepRepository {
  startStep(step: AgentRunStepStart): Promise<void>;
  completeStep(step: AgentRunStepCompletion): Promise<void>;
  failStep(step: AgentRunStepFailure): Promise<void>;
  getSteps(runId: string): Promise<readonly AgentRunStep[]>;
}
