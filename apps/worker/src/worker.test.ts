import { describe, expect, test } from 'bun:test';
import {
  type AgentJob,
  type AgentRunner,
  type ClaimNextJobInput,
  type CompleteJobInput,
  type EnqueueJobInput,
  type ExtendJobLeaseInput,
  type FailJobInput,
  type JobQueue,
  type ReleaseJobInput,
  RetryableJobError,
} from '@ai-agents/agent-core';

import { startWorker } from './worker';

function createJob(id = 'job-123'): AgentJob {
  const now = new Date('2026-07-19T00:00:00.000Z');

  return {
    id,
    agentId: 'test-agent',
    input: { greeting: 'Hello' },
    triggerType: 'manual',
    status: 'processing',
    idempotencyKey: null,
    attempts: 1,
    availableAt: now,
    lockedAt: now,
    lockedBy: 'test-worker',
    lastErrorCode: null,
    lastError: null,
    createdAt: now,
    completedAt: null,
  };
}

class FakeJobQueue implements JobQueue {
  readonly claimedBy: ClaimNextJobInput[] = [];
  readonly completed: CompleteJobInput[] = [];
  readonly failed: FailJobInput[] = [];
  readonly leaseExtensions: ExtendJobLeaseInput[] = [];
  readonly released: ReleaseJobInput[] = [];
  claimWait: Promise<void> | undefined;
  leaseError: Error | undefined;
  leaseExtensionDelayMs = 0;
  leaseResult = true;
  completeError: Error | undefined;

  constructor(private readonly jobs: AgentJob[]) {}

  async enqueue(_input: EnqueueJobInput): Promise<AgentJob> {
    throw new Error('Not implemented in FakeJobQueue');
  }

  async get(): Promise<null> {
    return null;
  }

  async claimNext(input: ClaimNextJobInput): Promise<AgentJob | null> {
    this.claimedBy.push(input);
    await this.claimWait;
    return this.jobs.shift() ?? null;
  }

  async complete(input: CompleteJobInput): Promise<void> {
    this.completed.push(input);
    if (this.completeError) {
      throw this.completeError;
    }
  }

  async extendLease(input: ExtendJobLeaseInput): Promise<boolean> {
    this.leaseExtensions.push(input);
    if (this.leaseExtensionDelayMs > 0) {
      await Bun.sleep(this.leaseExtensionDelayMs);
    }
    if (this.leaseError) {
      throw this.leaseError;
    }
    return this.leaseResult;
  }

  async release(input: ReleaseJobInput): Promise<void> {
    this.released.push(input);
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
  test('requires a Job Queue and an Agent Runner', async () => {
    await expect(startWorker()).rejects.toThrow(
      'Worker requires both a Job Queue and an Agent Runner',
    );
  });

  test('rejects invalid Worker interval options before starting timers', async () => {
    const queue = new FakeJobQueue([]);
    const runner = {
      run: async () => ({ runId: 'run-123', output: {} }),
    } as unknown as AgentRunner;

    await expect(startWorker({ queue, runner, heartbeatIntervalMs: 0 })).rejects.toThrow(
      'Worker intervals must be positive integers',
    );
    await expect(
      startWorker({ queue, runner, leaseHeartbeatIntervalMs: Number.NaN }),
    ).rejects.toThrow('Worker intervals must be positive integers');
    await expect(startWorker({ queue, runner, pollIntervalMs: 0 })).rejects.toThrow(
      'Worker intervals must be positive integers',
    );
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
      queue: new FakeJobQueue([]),
      runner: { run: async () => ({ runId: 'run-123', output: {} }) } as unknown as AgentRunner,
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
        queue: new FakeJobQueue([]),
        runner: { run: async () => ({ runId: 'run-123', output: {} }) } as unknown as AgentRunner,
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
      expect.objectContaining({
        agentId: 'test-agent',
        jobId: 'job-123',
        input: { greeting: 'Hello' },
        triggerType: 'manual',
      }),
    ]);
    expect(queue.completed).toEqual([{ jobId: 'job-123', workerId: 'test-worker' }]);
  });

  test('runs only the configured number of Jobs concurrently', async () => {
    const queue = new FakeJobQueue([createJob('job-1'), createJob('job-2'), createJob('job-3')]);
    let active = 0;
    let maximumActive = 0;
    const releases: Array<() => void> = [];
    const runner = {
      run: async () => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise<void>((resolve) => releases.push(resolve));
        active -= 1;
        return { runId: crypto.randomUUID(), output: {} };
      },
    } as unknown as AgentRunner;
    const worker = await startWorker({ concurrency: 2, pollIntervalMs: 1, queue, runner });

    await waitFor(() => active === 2);
    expect(maximumActive).toBe(2);
    expect(queue.claimedBy).toHaveLength(2);
    releases.shift()?.();
    await waitFor(() => queue.completed.length === 1 && active === 2);
    expect(maximumActive).toBe(2);
    for (const release of releases.splice(0)) release();
    await waitFor(() => queue.completed.length === 3);
    await worker.stop();
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

  test('renews the Job lease while an Agent is running', async () => {
    const queue = new FakeJobQueue([createJob()]);
    const runner = {
      run: async () => {
        await Bun.sleep(20);
        return { runId: 'run-123', output: { message: 'Hello' } };
      },
    } as unknown as AgentRunner;
    const worker = await startWorker({
      leaseHeartbeatIntervalMs: 2,
      pollIntervalMs: 1,
      queue,
      runner,
      workerId: 'test-worker',
    });

    await waitFor(() => queue.completed.length === 1);
    await worker.stop();

    expect(queue.leaseExtensions.length).toBeGreaterThan(0);
    expect(queue.leaseExtensions[0]).toEqual({ jobId: 'job-123', workerId: 'test-worker' });
  });

  test('does not re-arm a lease timer when a late lease renewal finishes after the Run', async () => {
    const queue = new FakeJobQueue([createJob()]);
    queue.leaseExtensionDelayMs = 20;
    let aborted = false;
    const runner = {
      run: async (request: { signal: AbortSignal }) => {
        request.signal.addEventListener('abort', () => {
          aborted = true;
        });
        await Bun.sleep(5);
        return { runId: 'run-123', output: { message: 'Hello' } };
      },
    } as unknown as AgentRunner;
    const worker = await startWorker({
      leaseHeartbeatIntervalMs: 1,
      leaseTimeoutMs: 10,
      pollIntervalMs: 1,
      queue,
      runner,
      workerId: 'test-worker',
    });

    await waitFor(() => queue.completed.length === 1);
    await Bun.sleep(35);
    await worker.stop();

    expect(aborted).toBe(false);
  });

  test('aborts an Agent and does not finalize a Job after its lease is lost', async () => {
    const queue = new FakeJobQueue([createJob()]);
    queue.leaseResult = false;
    let aborted = false;
    const runner = {
      run: async (request: { signal: AbortSignal }) => {
        await new Promise<void>((resolve) => {
          request.signal.addEventListener(
            'abort',
            () => {
              aborted = true;
              resolve();
            },
            { once: true },
          );
        });
        return { runId: 'run-123', output: { message: 'Hello' } };
      },
    } as unknown as AgentRunner;
    const worker = await startWorker({
      leaseHeartbeatIntervalMs: 2,
      pollIntervalMs: 1,
      queue,
      runner,
      workerId: 'test-worker',
    });

    await waitFor(() => aborted);
    await worker.stop();

    expect(queue.completed).toHaveLength(0);
    expect(queue.failed).toHaveLength(0);
  });

  test('aborts an Agent when lease renewal cannot be confirmed before expiration', async () => {
    const queue = new FakeJobQueue([createJob()]);
    queue.leaseError = new Error('database unavailable');
    let aborted = false;
    const runner = {
      run: async (request: { signal: AbortSignal }) => {
        await new Promise<void>((resolve) => {
          request.signal.addEventListener(
            'abort',
            () => {
              aborted = true;
              resolve();
            },
            { once: true },
          );
        });
        return { runId: 'run-123', output: { message: 'Hello' } };
      },
    } as unknown as AgentRunner;
    const worker = await startWorker({
      leaseHeartbeatIntervalMs: 2,
      leaseTimeoutMs: 10,
      pollIntervalMs: 1,
      queue,
      runner,
      workerId: 'test-worker',
    });

    await waitFor(() => aborted);
    await worker.stop();

    expect(queue.completed).toHaveLength(0);
    expect(queue.failed).toHaveLength(0);
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

  test('releases a Job claimed after shutdown begins without running its Agent', async () => {
    const queue = new FakeJobQueue([createJob()]);
    let releaseClaim: (() => void) | undefined;
    queue.claimWait = new Promise<void>((resolve) => {
      releaseClaim = resolve;
    });
    let runs = 0;
    const worker = await startWorker({
      queue,
      runner: {
        run: async () => {
          runs += 1;
          return { runId: 'run-123', output: {} };
        },
      } as unknown as AgentRunner,
      workerId: 'test-worker',
    });

    await waitFor(() => queue.claimedBy.length === 1);
    const stopped = worker.stop();
    releaseClaim?.();
    await stopped;

    expect(runs).toBe(0);
    expect(queue.completed).toHaveLength(0);
    expect(queue.released).toEqual([{ jobId: 'job-123', workerId: 'test-worker' }]);
  });

  test('shares shutdown work and closes the database when the in-flight Job fails to finalize', async () => {
    const queue = new FakeJobQueue([createJob()]);
    queue.completeError = new Error('database unavailable');
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
      pollIntervalMs: 1,
    });

    await waitFor(() => runStarted);
    const firstStop = worker.stop();
    const secondStop = worker.stop();
    finishRun?.();

    await expect(firstStop).rejects.toThrow('database unavailable');
    await expect(secondStop).rejects.toThrow('database unavailable');
    expect(closeCalls).toBe(1);
  });
});
