export type AgentJobStatus =
  | 'queued'
  | 'processing'
  | 'retry_waiting'
  | 'needs_review'
  | 'completed'
  | 'failed';

export interface AgentJob {
  readonly id: string;
  readonly agentId: string;
  readonly input: unknown;
  readonly status: AgentJobStatus;
  readonly idempotencyKey: string | null;
  readonly attempts: number;
  readonly availableAt: Date;
  readonly lockedAt: Date | null;
  readonly lockedBy: string | null;
  readonly lastError: string | null;
  readonly createdAt: Date;
  readonly completedAt: Date | null;
}

export interface EnqueueJobInput {
  readonly agentId: string;
  readonly input: unknown;
  readonly idempotencyKey?: string;
  readonly availableAt?: Date;
}

export interface ClaimNextJobInput {
  readonly workerId: string;
}

export interface CompleteJobInput {
  readonly jobId: string;
  readonly workerId: string;
}

export interface FailJobInput extends CompleteJobInput {
  readonly error: Error;
  readonly retryable: boolean;
}

export interface JobQueue {
  enqueue(input: EnqueueJobInput): Promise<AgentJob>;
  claimNext(input: ClaimNextJobInput): Promise<AgentJob | null>;
  complete(input: CompleteJobInput): Promise<void>;
  fail(input: FailJobInput): Promise<void>;
  recoverStaleJobs(): Promise<number>;
}
