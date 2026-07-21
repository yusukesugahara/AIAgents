import { createDevelopmentAgentRegistry } from '@ai-agents/agent-composition';
import type {
  AgentJob,
  AgentRun,
  AgentRunHistoryRepository,
  AgentRunRepository,
  AgentRunStep,
  ClaimNextJobInput,
  CompleteJobInput,
  EnqueueJobInput,
  ExtendJobLeaseInput,
  FailJobInput,
  JobQueue,
  ReleaseJobInput,
} from '@ai-agents/agent-core';
import type { ApiRunRepository } from './api-types';
import { createApp } from './app';

export const now = new Date('2026-07-19T00:00:00.000Z');
export const jobId = '0198be1d-a3a9-7d34-9bc3-123456789abc';
export const runId = '0198be1d-a3a9-7d34-9bc3-123456789abd';

export function createJob(overrides: Partial<AgentJob> = {}): AgentJob {
  return {
    id: jobId,
    agentId: 'echo',
    input: { value: 'secret' },
    triggerType: 'manual',
    status: 'queued',
    idempotencyKey: null,
    attempts: 0,
    availableAt: now,
    lockedAt: null,
    lockedBy: null,
    lastErrorCode: null,
    lastError: null,
    createdAt: now,
    completedAt: null,
    ...overrides,
  };
}

export class FakeJobQueue implements JobQueue {
  readonly enqueued: EnqueueJobInput[] = [];
  readonly jobs = new Map<string, AgentJob>();

  async enqueue(input: EnqueueJobInput): Promise<AgentJob> {
    const existing = input.idempotencyKey
      ? [...this.jobs.values()].find((job) => job.idempotencyKey === input.idempotencyKey)
      : undefined;
    if (existing) return existing;

    this.enqueued.push(input);
    const job = createJob({
      agentId: input.agentId,
      idempotencyKey: input.idempotencyKey ?? null,
      input: input.input,
      triggerType: input.triggerType,
    });
    this.jobs.set(job.id, job);
    return job;
  }

  async get(id: string): Promise<AgentJob | null> {
    return this.jobs.get(id) ?? null;
  }

  async claimNext(_input: ClaimNextJobInput): Promise<null> {
    return null;
  }

  async complete(_input: CompleteJobInput): Promise<void> {}

  async extendLease(_input: ExtendJobLeaseInput): Promise<boolean> {
    return true;
  }

  async release(_input: ReleaseJobInput): Promise<void> {}

  async fail(_input: FailJobInput): Promise<void> {}

  async recoverStaleJobs(): Promise<number> {
    return 0;
  }
}

export class FakeRunRepository
  implements Pick<AgentRunRepository, 'getLatestRunForJob' | 'getRun'>, AgentRunHistoryRepository
{
  readonly runs = new Map<string, AgentRun>();
  readonly steps = new Map<string, readonly AgentRunStep[]>();

  async getRun(id: string): Promise<AgentRun | null> {
    return this.runs.get(id) ?? null;
  }

  async getLatestRunForJob(targetJobId: string): Promise<AgentRun | null> {
    return (
      [...this.runs.values()]
        .filter((run) => run.jobId === targetJobId)
        .sort((left, right) => right.startedAt.getTime() - left.startedAt.getTime())[0] ?? null
    );
  }

  async listRuns(options: { limit: number; offset: number }) {
    const sorted = [...this.runs.values()].sort(
      (left, right) =>
        right.startedAt.getTime() - left.startedAt.getTime() || right.id.localeCompare(left.id),
    );
    return {
      hasMore: sorted.length > options.offset + options.limit,
      runs: sorted.slice(options.offset, options.offset + options.limit),
    };
  }

  async getSteps(id: string): Promise<readonly AgentRunStep[]> {
    return this.steps.get(id) ?? [];
  }
}

export function createConfiguredApp(options: { queue?: JobQueue; runs?: ApiRunRepository } = {}) {
  return createApp({
    logger: { error() {}, info() {} },
    queue: options.queue ?? new FakeJobQueue(),
    registry: createDevelopmentAgentRegistry(),
    requestIdGenerator: () => 'generated-request-id',
    runs: options.runs ?? new FakeRunRepository(),
  });
}
