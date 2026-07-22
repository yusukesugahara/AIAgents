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
  readonly triggerType: string;
  readonly status: AgentJobStatus;
  readonly idempotencyKey: string | null;
  readonly attempts: number;
  readonly availableAt: Date;
  readonly lockedAt: Date | null;
  readonly lockedBy: string | null;
  readonly lastErrorCode: string | null;
  readonly lastError: string | null;
  readonly createdAt: Date;
  readonly completedAt: Date | null;
}

export interface EnqueueJobInput {
  readonly agentId: string;
  readonly input: unknown;
  readonly idempotencyKey?: string;
  readonly availableAt?: Date;
  /** Requeues a matching terminal transient failure while preserving its idempotency key. */
  readonly retryFailed?: boolean;
  readonly triggerType: string;
}

export interface ClaimNextJobInput {
  readonly agentId?: string;
  readonly workerId: string;
}

export interface CompleteJobInput {
  readonly jobId: string;
  readonly workerId: string;
}

export interface ExtendJobLeaseInput extends CompleteJobInput {}

/** Releases a claimed Job without treating it as an execution attempt. */
export interface ReleaseJobInput extends CompleteJobInput {}

export interface FailJobInput extends CompleteJobInput {
  readonly error: Error;
  readonly retryable: boolean;
}

export interface JobQueue {
  enqueue(input: EnqueueJobInput): Promise<AgentJob>;
  get(jobId: string): Promise<AgentJob | null>;
  claimNext(input: ClaimNextJobInput): Promise<AgentJob | null>;
  extendLease(input: ExtendJobLeaseInput): Promise<boolean>;
  release(input: ReleaseJobInput): Promise<void>;
  complete(input: CompleteJobInput): Promise<void>;
  fail(input: FailJobInput): Promise<void>;
  recoverStaleJobs(): Promise<number>;
}
