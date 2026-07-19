import type {
  AgentJob,
  AgentJobStatus,
  AgentRun,
  AgentRunCompletion,
  AgentRunFailure,
  AgentRunRepository,
  AgentRunStart,
  ClaimNextJobInput,
  CompleteJobInput,
  EnqueueJobInput,
  ExtendJobLeaseInput,
  FailJobInput,
  JobQueue,
  ReleaseJobInput,
} from '@ai-agents/agent-core';
import {
  AgentCoreError,
  AgentDependencyError,
  IdempotencyConflictError,
  RetryableJobError,
} from '@ai-agents/agent-core';
import type { DatabaseConnection } from './client';

interface AgentJobRow {
  id: string;
  agent_id: string;
  input_json: unknown;
  trigger_type: string;
  status: AgentJobStatus;
  idempotency_key: string | null;
  attempts: number;
  available_at: Date | string;
  locked_at: Date | string | null;
  locked_by: string | null;
  last_error_code: string | null;
  last_error: string | null;
  created_at: Date | string;
  completed_at: Date | string | null;
}

interface AgentRunRow {
  id: string;
  job_id: string;
  agent_id: string;
  status: AgentRun['status'];
  trigger_type: string;
  error_code: string | null;
  started_at: Date | string;
  completed_at: Date | string | null;
}

const jobColumns = `
  id, agent_id, input_json, trigger_type, status, idempotency_key, attempts, available_at,
  locked_at, locked_by, last_error_code, last_error, created_at, completed_at
`;

const claimedJobColumns = `
  jobs.id, jobs.agent_id, jobs.input_json, jobs.trigger_type, jobs.status, jobs.idempotency_key, jobs.attempts,
  jobs.available_at, jobs.locked_at, jobs.locked_by, jobs.last_error_code, jobs.last_error, jobs.created_at, jobs.completed_at
`;

export interface PostgresJobQueueOptions {
  readonly lockTimeoutMs?: number;
  readonly maxAttempts?: number;
  /** Retry waits; with the default maxAttempts=3, attempts include the initial run, so 1s and 2s apply. */
  readonly retryDelaysMs?: readonly number[];
}

export class PostgresJobQueue implements JobQueue {
  readonly #lockTimeoutMs: number;
  readonly #maxAttempts: number;
  readonly #retryDelaysMs: readonly number[];

  constructor(
    private readonly database: Pick<DatabaseConnection, 'client'>,
    options: PostgresJobQueueOptions = {},
  ) {
    this.#lockTimeoutMs = options.lockTimeoutMs ?? 60_000;
    this.#maxAttempts = options.maxAttempts ?? 3;
    this.#retryDelaysMs = options.retryDelaysMs ?? [1_000, 2_000];

    if (!Number.isSafeInteger(this.#lockTimeoutMs) || this.#lockTimeoutMs <= 0) {
      throw new Error('Job lock timeout must be a positive integer');
    }
    if (!Number.isSafeInteger(this.#maxAttempts) || this.#maxAttempts <= 0) {
      throw new Error('Job maximum attempts must be a positive integer');
    }
    if (this.#retryDelaysMs.some((delay) => !Number.isSafeInteger(delay) || delay < 0)) {
      throw new Error('Job retry delays must be non-negative integers');
    }
  }

  async enqueue(input: EnqueueJobInput): Promise<AgentJob> {
    const availableAt = toTimestamp(input.availableAt ?? new Date());
    const requestedAvailableAt = input.availableAt ? toTimestamp(input.availableAt) : null;
    const inputJson = JSON.stringify(input.input);
    const [inserted] = (await this.database.client`
      INSERT INTO agent_jobs (
        agent_id, input_json, trigger_type, idempotency_key, available_at, requested_available_at
      )
      VALUES (
        ${input.agentId}, ${inputJson}::jsonb, ${input.triggerType}, ${input.idempotencyKey ?? null},
        ${availableAt}, ${requestedAvailableAt}::timestamptz
      )
      ON CONFLICT (agent_id, idempotency_key) DO NOTHING
      RETURNING ${this.database.client.unsafe(jobColumns)}
    `) as AgentJobRow[];

    if (inserted) {
      return toAgentJob(inserted);
    }

    if (!input.idempotencyKey) {
      throw new Error('Failed to enqueue Job');
    }

    const [existing] = (await this.database.client`
      SELECT ${this.database.client.unsafe(jobColumns)}
      FROM agent_jobs
      WHERE agent_id = ${input.agentId}
        AND idempotency_key = ${input.idempotencyKey}
        AND input_json = ${inputJson}::jsonb
        AND trigger_type = ${input.triggerType}
        AND requested_available_at IS NOT DISTINCT FROM ${requestedAvailableAt}::timestamptz
    `) as AgentJobRow[];

    if (!existing) {
      throw new IdempotencyConflictError(
        `Idempotency key "${input.idempotencyKey}" was already used with a different request`,
      );
    }

    return toAgentJob(existing);
  }

  async get(jobId: string): Promise<AgentJob | null> {
    const [job] = (await this.database.client`
      SELECT ${this.database.client.unsafe(jobColumns)}
      FROM agent_jobs
      WHERE id = ${jobId}::uuid
    `) as AgentJobRow[];

    return job ? toAgentJob(job) : null;
  }

  async claimNext(input: ClaimNextJobInput): Promise<AgentJob | null> {
    await this.recoverStaleJobs();

    const [claimed] = (await this.database.client`
      WITH next_job AS (
        SELECT id
        FROM agent_jobs
        WHERE status IN ('queued', 'retry_waiting')
          AND available_at <= NOW()
          AND (${input.agentId ?? null}::text IS NULL OR agent_id = ${input.agentId ?? null})
        ORDER BY created_at
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      UPDATE agent_jobs AS jobs
      SET status = 'processing',
          attempts = jobs.attempts + 1,
          locked_at = NOW(),
          locked_by = ${input.workerId}
      FROM next_job
      WHERE jobs.id = next_job.id
      RETURNING ${this.database.client.unsafe(claimedJobColumns)}
    `) as AgentJobRow[];

    return claimed ? toAgentJob(claimed) : null;
  }

  async complete(input: CompleteJobInput): Promise<void> {
    const [completed] = await this.database.client`
      UPDATE agent_jobs
      SET status = 'completed',
          locked_at = NULL,
          locked_by = NULL,
          last_error_code = NULL,
          last_error = NULL,
          completed_at = NOW()
      WHERE id = ${input.jobId}
        AND status = 'processing'
        AND locked_by = ${input.workerId}
      RETURNING id
    `;

    if (!completed) {
      throw new Error(`Job "${input.jobId}" is no longer leased by Worker "${input.workerId}"`);
    }
  }

  async extendLease(input: ExtendJobLeaseInput): Promise<boolean> {
    const [extended] = await this.database.client`
      UPDATE agent_jobs
      SET locked_at = NOW()
      WHERE id = ${input.jobId}
        AND status = 'processing'
        AND locked_by = ${input.workerId}
      RETURNING id
    `;

    return Boolean(extended);
  }

  async release(input: ReleaseJobInput): Promise<void> {
    const [released] = await this.database.client`
      UPDATE agent_jobs
      SET status = 'queued',
          attempts = GREATEST(attempts - 1, 0),
          locked_at = NULL,
          locked_by = NULL
      WHERE id = ${input.jobId}
        AND status = 'processing'
        AND locked_by = ${input.workerId}
      RETURNING id
    `;

    if (!released) {
      throw new Error(`Job "${input.jobId}" is no longer leased by Worker "${input.workerId}"`);
    }
  }

  async fail(input: FailJobInput): Promise<void> {
    await this.database.client.begin(async (sql) => {
      const [job] = (await sql`
        SELECT attempts
        FROM agent_jobs
        WHERE id = ${input.jobId}
          AND status = 'processing'
          AND locked_by = ${input.workerId}
        FOR UPDATE
      `) as Array<{ attempts: number }>;

      if (!job) {
        throw new Error(`Job "${input.jobId}" is no longer leased by Worker "${input.workerId}"`);
      }

      const shouldRetry = input.retryable && job.attempts < this.#maxAttempts;
      const retryDelayMs = shouldRetry ? this.#retryDelayForAttempt(job.attempts) : 0;
      const [updated] = await sql`
        UPDATE agent_jobs
        SET status = ${shouldRetry ? 'retry_waiting' : 'failed'}::job_status,
            available_at = CASE
              WHEN ${shouldRetry} THEN NOW() + (${retryDelayMs} * INTERVAL '1 millisecond')
              ELSE available_at
            END,
            locked_at = NULL,
            locked_by = NULL,
            last_error_code = ${toJobErrorCode(input.error)},
            last_error = ${input.error.message},
            completed_at = CASE WHEN ${shouldRetry} THEN NULL ELSE NOW() END
        WHERE id = ${input.jobId}
          AND status = 'processing'
          AND locked_by = ${input.workerId}
        RETURNING id
      `;

      if (!updated) {
        throw new Error(`Job "${input.jobId}" could not be marked as failed`);
      }

      await sql`
        WITH abandoned_runs AS (
          UPDATE agent_runs
          SET status = 'failed', completed_at = NOW()
          WHERE job_id = ${input.jobId}::uuid
            AND status = 'running'
          RETURNING id, job_id
        )
        INSERT INTO agent_errors (run_id, job_id, code, message, occurred_at)
        SELECT
          id,
          job_id,
          'RUN_PERSISTENCE_FAILED',
          'Run was left running when the Job execution ended',
          NOW()
        FROM abandoned_runs
      `;
    });
  }

  async recoverStaleJobs(): Promise<number> {
    const [result] = (await this.database.client`
      WITH recovered_jobs AS (
        UPDATE agent_jobs
        SET status = (
              CASE WHEN attempts >= ${this.#maxAttempts} THEN 'failed' ELSE 'retry_waiting' END
            )::job_status,
            available_at = CASE WHEN attempts >= ${this.#maxAttempts} THEN available_at ELSE NOW() END,
            locked_at = NULL,
            locked_by = NULL,
            last_error_code = 'JOB_LOCK_EXPIRED',
            last_error = 'Job lock expired',
            completed_at = CASE WHEN attempts >= ${this.#maxAttempts} THEN NOW() ELSE NULL END
        WHERE status = 'processing'
          AND (
            locked_at IS NULL
            OR locked_at <= NOW() - (${this.#lockTimeoutMs} * INTERVAL '1 millisecond')
          )
        RETURNING id
      ),
      failed_runs AS (
        UPDATE agent_runs
        SET status = 'failed', completed_at = NOW()
        WHERE status = 'running'
          AND job_id IN (SELECT id FROM recovered_jobs)
        RETURNING id, job_id
      ),
      recorded_errors AS (
        INSERT INTO agent_errors (run_id, job_id, code, message, occurred_at)
        SELECT id, job_id, 'JOB_LOCK_EXPIRED', 'Job lock expired', NOW()
        FROM failed_runs
      )
      SELECT COUNT(*)::int AS count FROM recovered_jobs
    `) as Array<{ count: number | string }>;

    return Number(result?.count ?? 0);
  }

  #retryDelayForAttempt(attempts: number): number {
    return this.#retryDelaysMs[Math.min(attempts - 1, this.#retryDelaysMs.length - 1)] ?? 0;
  }
}

export class PostgresAgentRunRepository implements AgentRunRepository {
  constructor(private readonly database: Pick<DatabaseConnection, 'client'>) {}

  async startRun(run: AgentRunStart): Promise<void> {
    await this.database.client`
      INSERT INTO agent_runs (id, job_id, agent_id, trigger_type, input_json, started_at)
      VALUES (
        ${run.runId}::uuid,
        ${run.jobId}::uuid,
        ${run.agentId},
        ${run.triggerType},
        ${JSON.stringify(run.input)}::jsonb,
        ${toTimestamp(run.startedAt)}
      )
    `;
  }

  async completeRun(run: AgentRunCompletion): Promise<void> {
    const [completed] = await this.database.client`
      UPDATE agent_runs
      SET status = 'completed', output_json = ${JSON.stringify(run.output)}::jsonb, completed_at = ${toTimestamp(run.completedAt)}
      WHERE id = ${run.runId}::uuid
        AND status = 'running'
      RETURNING id
    `;

    if (!completed) {
      throw new Error(`Agent Run "${run.runId}" is not running and cannot be completed`);
    }
  }

  async failRun(run: AgentRunFailure): Promise<void> {
    await this.database.client.begin(async (sql) => {
      const [failed] = await sql`
        UPDATE agent_runs
        SET status = 'failed', completed_at = ${toTimestamp(run.completedAt)}
        WHERE id = ${run.runId}::uuid
          AND status = 'running'
        RETURNING id
      `;

      if (!failed) {
        throw new Error(`Agent Run "${run.runId}" is not running and cannot be failed`);
      }
      await sql`
        INSERT INTO agent_errors (run_id, job_id, code, message, occurred_at)
        SELECT id, job_id, ${run.errorCode}, ${run.errorMessage}, ${toTimestamp(run.completedAt)}
        FROM agent_runs
        WHERE id = ${run.runId}::uuid
      `;
    });
  }

  async getRun(runId: string): Promise<AgentRun | null> {
    const [run] = (await this.database.client`
      SELECT
        runs.id,
        runs.job_id,
        runs.agent_id,
        runs.status,
        runs.trigger_type,
        errors.code AS error_code,
        runs.started_at,
        runs.completed_at
      FROM agent_runs AS runs
      LEFT JOIN LATERAL (
        SELECT code
        FROM agent_errors
        WHERE run_id = runs.id
        ORDER BY occurred_at DESC
        LIMIT 1
      ) AS errors ON TRUE
      WHERE runs.id = ${runId}::uuid
    `) as AgentRunRow[];

    return run ? toAgentRun(run) : null;
  }

  async getLatestRunForJob(jobId: string): Promise<AgentRun | null> {
    const [run] = (await this.database.client`
      SELECT
        runs.id,
        runs.job_id,
        runs.agent_id,
        runs.status,
        runs.trigger_type,
        errors.code AS error_code,
        runs.started_at,
        runs.completed_at
      FROM agent_runs AS runs
      LEFT JOIN LATERAL (
        SELECT code
        FROM agent_errors
        WHERE run_id = runs.id
        ORDER BY occurred_at DESC
        LIMIT 1
      ) AS errors ON TRUE
      WHERE runs.job_id = ${jobId}::uuid
      ORDER BY runs.started_at DESC, runs.id DESC
      LIMIT 1
    `) as AgentRunRow[];

    return run ? toAgentRun(run) : null;
  }
}

function toAgentJob(row: AgentJobRow): AgentJob {
  return {
    id: row.id,
    agentId: row.agent_id,
    input: row.input_json,
    triggerType: row.trigger_type,
    status: row.status,
    idempotencyKey: row.idempotency_key,
    attempts: row.attempts,
    availableAt: toDate(row.available_at),
    lockedAt: row.locked_at ? toDate(row.locked_at) : null,
    lockedBy: row.locked_by,
    lastErrorCode: row.last_error_code,
    lastError: row.last_error,
    createdAt: toDate(row.created_at),
    completedAt: row.completed_at ? toDate(row.completed_at) : null,
  };
}

function toJobErrorCode(error: Error): string {
  if (error instanceof AgentCoreError) {
    return error.code;
  }
  if (error instanceof AgentDependencyError) {
    return error.code;
  }
  if (error instanceof RetryableJobError) {
    return 'JOB_RETRYABLE';
  }
  return 'JOB_EXECUTION_FAILED';
}

function toAgentRun(row: AgentRunRow): AgentRun {
  return {
    id: row.id,
    jobId: row.job_id,
    agentId: row.agent_id,
    status: row.status,
    triggerType: row.trigger_type,
    errorCode: row.error_code,
    startedAt: toDate(row.started_at),
    completedAt: row.completed_at ? toDate(row.completed_at) : null,
  };
}

function toTimestamp(value: Date): string {
  return value.toISOString();
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}
