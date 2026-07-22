import { type AgentRunner, isRetryableJobError, type JobQueue } from '@ai-agents/agent-core';
import type { DatabaseConnection } from '@ai-agents/database';

export interface WorkerHandle {
  stop(): Promise<void>;
}

export interface WorkerOptions {
  concurrency?: number;
  heartbeatIntervalMs?: number;
  leaseHeartbeatIntervalMs?: number;
  leaseTimeoutMs?: number;
  pollIntervalMs?: number;
  queue?: JobQueue;
  runner?: AgentRunner;
  workerId?: string;
  database?: Pick<DatabaseConnection, 'isReady' | 'close'> &
    Partial<Pick<DatabaseConnection, 'isSchemaReady'>>;
}

export async function startWorker(options: WorkerOptions = {}): Promise<WorkerHandle> {
  if (!options.queue || !options.runner) {
    throw new Error('Worker requires both a Job Queue and an Agent Runner');
  }
  const queue = options.queue;
  const runner = options.runner;

  if (options.database && !(await options.database.isReady())) {
    await options.database.close();
    throw new Error('Database is not ready');
  }

  if (options.database?.isSchemaReady && !(await options.database.isSchemaReady())) {
    await options.database.close();
    throw new Error('Database schema is not ready; run migrations before starting the Worker');
  }

  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? 60_000;
  const concurrency = options.concurrency ?? 1;
  const leaseHeartbeatIntervalMs = options.leaseHeartbeatIntervalMs ?? 15_000;
  const leaseTimeoutMs = options.leaseTimeoutMs ?? 60_000;
  const pollIntervalMs = options.pollIntervalMs ?? 250;

  if (
    !isPositiveSafeInteger(heartbeatIntervalMs) ||
    !isPositiveSafeInteger(concurrency) ||
    concurrency > 32 ||
    !isPositiveSafeInteger(leaseTimeoutMs) ||
    !isPositiveSafeInteger(leaseHeartbeatIntervalMs) ||
    !isPositiveSafeInteger(pollIntervalMs) ||
    leaseHeartbeatIntervalMs >= leaseTimeoutMs
  ) {
    throw new Error(
      'Worker intervals must be positive integers; concurrency must be a positive integer at most 32, and the lease heartbeat interval must be shorter than the lease timeout',
    );
  }
  const workerId = options.workerId ?? `worker-${crypto.randomUUID()}`;
  console.info(JSON.stringify({ event: 'worker.started' }));

  const heartbeat = setInterval(() => {
    console.info(JSON.stringify({ event: 'worker.heartbeat' }));
  }, heartbeatIntervalMs);

  let stopped = false;
  const activeJobs = new Set<Promise<void>>();
  let pollFailure: unknown;
  let stopPromise: Promise<void> | undefined;

  const processNextJob = async (): Promise<void> => {
    const job = await queue.claimNext({ workerId });
    if (!job) {
      return;
    }

    // A stop can begin while claimNext is waiting for the database. Do not start
    // a newly claimed Agent execution after shutdown has started.
    if (stopped) {
      await queue.release({ jobId: job.id, workerId });
      return;
    }

    const abortController = new AbortController();
    let executionFinished = false;
    let leaseLost = false;
    let extendingLease = false;
    let leaseExpiryTimer: ReturnType<typeof setTimeout> | undefined;
    const loseLease = (reason: string): void => {
      if (leaseLost) {
        return;
      }

      leaseLost = true;
      abortController.abort(reason);
    };
    const scheduleLeaseExpiry = (): void => {
      if (executionFinished) {
        return;
      }
      if (leaseExpiryTimer) {
        clearTimeout(leaseExpiryTimer);
      }
      leaseExpiryTimer = setTimeout(() => {
        loseLease('Job lease renewal deadline exceeded');
      }, leaseTimeoutMs);
    };
    scheduleLeaseExpiry();
    const extendLease = (): void => {
      if (extendingLease || leaseLost) {
        return;
      }

      extendingLease = true;
      void queue
        .extendLease({ jobId: job.id, workerId })
        .then((extended) => {
          if (executionFinished) {
            return;
          }
          if (!extended) {
            loseLease('Job lease lost');
            return;
          }

          scheduleLeaseExpiry();
        })
        .catch((error: unknown) => {
          if (executionFinished) {
            return;
          }
          console.error(
            JSON.stringify({
              event: 'worker.lease_heartbeat.failed',
              jobId: job.id,
              message: error instanceof Error ? error.message : 'unknown',
              workerId,
            }),
          );
        })
        .finally(() => {
          extendingLease = false;
        });
    };
    const leaseHeartbeat = setInterval(extendLease, leaseHeartbeatIntervalMs);

    try {
      await runner.run({
        agentId: job.agentId,
        jobId: job.id,
        input: job.input,
        signal: abortController.signal,
        triggerType: job.triggerType,
      });

      if (leaseLost) {
        throw new Error(`Job "${job.id}" lease was lost during execution`);
      }
    } catch (error) {
      if (leaseLost) {
        console.warn(JSON.stringify({ event: 'worker.job.lease_lost', jobId: job.id, workerId }));
        return;
      }

      const jobError = error instanceof Error ? error : new Error(String(error));
      await queue.fail({
        jobId: job.id,
        workerId,
        error: jobError,
        retryable: isRetryableJobError(error),
      });
      return;
    } finally {
      executionFinished = true;
      clearInterval(leaseHeartbeat);
      if (leaseExpiryTimer) {
        clearTimeout(leaseExpiryTimer);
      }
    }

    await queue.complete({ jobId: job.id, workerId });
  };

  const poll = (): void => {
    while (!stopped && activeJobs.size < concurrency) {
      let execution: Promise<void>;
      execution = processNextJob()
        .catch((error: unknown) => {
          pollFailure ??= error;
          console.error(
            JSON.stringify({
              event: 'worker.poll.failed',
              message: error instanceof Error ? error.message : 'unknown',
              workerId,
            }),
          );
        })
        .finally(() => {
          activeJobs.delete(execution);
        });
      activeJobs.add(execution);
    }
  };

  const poller = setInterval(poll, pollIntervalMs);
  poll();

  return {
    stop() {
      if (stopPromise) {
        return stopPromise;
      }

      stopped = true;
      clearInterval(heartbeat);
      clearInterval(poller);
      stopPromise = (async () => {
        try {
          await Promise.allSettled([...activeJobs]);
          if (pollFailure) throw pollFailure;
        } finally {
          if (options.database) {
            await options.database.close();
          }
          console.info(JSON.stringify({ event: 'worker.stopped' }));
        }
      })();

      return stopPromise;
    },
  };
}

function isPositiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}
