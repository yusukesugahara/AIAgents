import { type AgentRunner, isRetryableJobError, type JobQueue } from '@ai-agents/agent-core';
import type { DatabaseConnection } from '@ai-agents/database';

export interface WorkerHandle {
  stop(): Promise<void>;
}

export interface WorkerOptions {
  heartbeatIntervalMs?: number;
  pollIntervalMs?: number;
  queue?: JobQueue;
  runner?: AgentRunner;
  workerId?: string;
  database?: Pick<DatabaseConnection, 'isReady' | 'close'>;
}

export async function startWorker(options: WorkerOptions = {}): Promise<WorkerHandle> {
  if ((options.queue && !options.runner) || (!options.queue && options.runner)) {
    throw new Error('Worker requires both a Job Queue and an Agent Runner');
  }

  if (options.database && !(await options.database.isReady())) {
    await options.database.close();
    throw new Error('Database is not ready');
  }

  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? 60_000;
  const pollIntervalMs = options.pollIntervalMs ?? 250;
  const workerId = options.workerId ?? `worker-${crypto.randomUUID()}`;
  console.info(JSON.stringify({ event: 'worker.started' }));

  const heartbeat = setInterval(() => {
    console.info(JSON.stringify({ event: 'worker.heartbeat' }));
  }, heartbeatIntervalMs);

  let stopped = false;
  let currentJob: Promise<void> | undefined;

  const processNextJob = async (): Promise<void> => {
    if (stopped || currentJob || !options.queue || !options.runner) {
      return;
    }

    currentJob = (async () => {
      const job = await options.queue?.claimNext({ workerId });
      if (!job) {
        return;
      }

      try {
        await options.runner?.run({
          agentId: job.agentId,
          jobId: job.id,
          input: job.input,
          triggerType: 'queue',
        });
      } catch (error) {
        const jobError = error instanceof Error ? error : new Error(String(error));
        await options.queue?.fail({
          jobId: job.id,
          workerId,
          error: jobError,
          retryable: isRetryableJobError(error),
        });
        return;
      }

      await options.queue?.complete({ jobId: job.id, workerId });
    })();

    try {
      await currentJob;
    } finally {
      currentJob = undefined;
    }
  };

  const poll = (): void => {
    void processNextJob().catch((error: unknown) => {
      console.error(
        JSON.stringify({
          event: 'worker.poll.failed',
          message: error instanceof Error ? error.message : 'unknown',
          workerId,
        }),
      );
    });
  };

  const poller = options.queue ? setInterval(poll, pollIntervalMs) : undefined;
  poll();

  return {
    async stop() {
      if (stopped) {
        return;
      }

      stopped = true;
      clearInterval(heartbeat);
      if (poller) {
        clearInterval(poller);
      }
      if (currentJob) {
        await currentJob;
      }
      if (options.database) {
        await options.database.close();
      }
      console.info(JSON.stringify({ event: 'worker.stopped' }));
    },
  };
}
