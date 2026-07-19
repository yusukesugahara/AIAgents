import { describe, expect, test } from 'bun:test';
import {
  type AgentJob,
  type AgentRunner,
  type ClaimNextJobInput,
  type CompleteJobInput,
  type EnqueueJobInput,
  type FailJobInput,
  type JobQueue,
  RetryableJobError,
} from '@ai-agents/agent-core';

import { startWorker } from './worker';

function createJob(): AgentJob {
  const now = new Date('2026-07-19T00:00:00.000Z');

  return {
    id: 'job-123',
    agentId: 'test-agent',
    input: { greeting: 'Hello' },
    status: 'processing',
    idempotencyKey: null,
    attempts: 1,
    availableAt: now,
    lockedAt: now,
    lockedBy: 'test-worker',
    lastError: null,
    createdAt: now,
    completedAt: null,
  };
}

class FakeJobQueue implements JobQueue {
  readonly claimedBy: ClaimNextJobInput[] = [];
  readonly completed: CompleteJobInput[] = [];
  readonly failed: FailJobInput[] = [];

  constructor(private readonly jobs: AgentJob[]) {}

  async enqueue(_input: EnqueueJobInput): Promise<AgentJob> {
    throw new Error('Not implemented in FakeJobQueue');
  }

  async get(): Promise<null> {
    return null;
  }

  async claimNext(input: ClaimNextJobInput): Promise<AgentJob | null> {
    this.claimedBy.push(input);
    return this.jobs.shift() ?? null;
  }

  async complete(input: CompleteJobInput): Promise<void> {
    this.completed.push(input);
  }

  async fail(input: FailJobInput): Promise<void> {
    this.failed.push(input);
  }

  async recoverStaleJobs(): Promise<number> {
    return 0;
  }
}

async function waitFor(assertion: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (assertion()) {
      return;
    }
    await Bun.sleep(5);
  }

  throw new Error('Timed out waiting for Worker');
}

describe('worker', () => {
  test('can be started and stopped', async () => {
    const worker = await startWorker();

    expect(worker.stop).toBeFunction();
    await worker.stop();
  });

  test('checks the database at startup and closes it at shutdown', async () => {
    let readinessChecks = 0;
    let closeCalls = 0;
    const worker = await startWorker({
      database: {
        isReady: async () => {
          readinessChecks += 1;
          return true;
        },
        close: async () => {
          closeCalls += 1;
        },
      },
    });

    expect(readinessChecks).toBe(1);
    await worker.stop();
    await worker.stop();
    expect(closeCalls).toBe(1);
  });

  test('does not start when the database is unavailable', async () => {
    let closeCalls = 0;

    await expect(
      startWorker({
        database: {
          isReady: async () => false,
          close: async () => {
            closeCalls += 1;
          },
        },
      }),
    ).rejects.toThrow('Database is not ready');
    expect(closeCalls).toBe(1);
  });

  test('claims a Job, runs the Agent, and completes the Job', async () => {
    const queue = new FakeJobQueue([createJob()]);
    const requests: unknown[] = [];
    const runner = {
      run: async (request: unknown) => {
        requests.push(request);
        return { runId: 'run-123', output: { message: 'Hello' } };
      },
    } as unknown as AgentRunner;
    const worker = await startWorker({
      queue,
      runner,
      workerId: 'test-worker',
      pollIntervalMs: 5,
    });

    await waitFor(() => queue.completed.length === 1);
    await worker.stop();

    expect(requests).toEqual([
      {
        agentId: 'test-agent',
        jobId: 'job-123',
        input: { greeting: 'Hello' },
        triggerType: 'queue',
      },
    ]);
    expect(queue.completed).toEqual([{ jobId: 'job-123', workerId: 'test-worker' }]);
  });

  test('marks retryable Agent failures for retry', async () => {
    const queue = new FakeJobQueue([createJob()]);
    const runner = {
      run: async () => {
        throw new RetryableJobError('temporary provider failure');
      },
    } as unknown as AgentRunner;
    const worker = await startWorker({
      queue,
      runner,
      workerId: 'test-worker',
      pollIntervalMs: 5,
    });

    await waitFor(() => queue.failed.length === 1);
    await worker.stop();

    expect(queue.failed[0]).toMatchObject({
      jobId: 'job-123',
      workerId: 'test-worker',
      retryable: true,
      error: { message: 'temporary provider failure' },
    });
  });

  test('stops polling and waits for the in-flight Job before closing the database', async () => {
    const queue = new FakeJobQueue([createJob(), createJob()]);
    let closeCalls = 0;
    let runStarted = false;
    let finishRun: (() => void) | undefined;
    const runner = {
      run: async () => {
        runStarted = true;
        await new Promise<void>((resolve) => {
          finishRun = resolve;
        });
        return { runId: 'run-123', output: { message: 'Hello' } };
      },
    } as unknown as AgentRunner;
    const worker = await startWorker({
      database: {
        isReady: async () => true,
        close: async () => {
          closeCalls += 1;
        },
      },
      queue,
      runner,
      workerId: 'test-worker',
      pollIntervalMs: 5,
    });

    await waitFor(() => runStarted);
    const stopped = worker.stop();
    await Bun.sleep(10);
    expect(closeCalls).toBe(0);
    expect(queue.claimedBy).toHaveLength(1);

    finishRun?.();
    await stopped;

    expect(queue.completed).toHaveLength(1);
    expect(closeCalls).toBe(1);
    expect(queue.claimedBy).toHaveLength(1);
  });
});
