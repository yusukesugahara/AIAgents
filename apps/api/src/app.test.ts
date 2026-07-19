import { describe, expect, test } from 'bun:test';
import type {
  AgentJob,
  AgentRun,
  AgentRunRepository,
  ClaimNextJobInput,
  CompleteJobInput,
  EnqueueJobInput,
  FailJobInput,
  JobQueue,
} from '@ai-agents/agent-core';
import { createDevelopmentAgentRegistry } from '@ai-agents/echo-agent';

import { createApp } from './app';

const now = new Date('2026-07-19T00:00:00.000Z');
const jobId = '0198be1d-a3a9-7d34-9bc3-123456789abc';
const runId = '0198be1d-a3a9-7d34-9bc3-123456789abd';

function createJob(overrides: Partial<AgentJob> = {}): AgentJob {
  return {
    id: jobId,
    agentId: 'echo',
    input: { value: 'secret' },
    status: 'queued',
    idempotencyKey: null,
    attempts: 0,
    availableAt: now,
    lockedAt: null,
    lockedBy: null,
    lastError: null,
    createdAt: now,
    completedAt: null,
    ...overrides,
  };
}

class FakeJobQueue implements JobQueue {
  readonly enqueued: EnqueueJobInput[] = [];
  readonly jobs = new Map<string, AgentJob>();

  async enqueue(input: EnqueueJobInput): Promise<AgentJob> {
    const existing = input.idempotencyKey
      ? [...this.jobs.values()].find((job) => job.idempotencyKey === input.idempotencyKey)
      : undefined;
    if (existing) {
      return existing;
    }

    this.enqueued.push(input);
    const job = createJob({
      idempotencyKey: input.idempotencyKey ?? null,
      input: input.input,
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

  async fail(_input: FailJobInput): Promise<void> {}

  async recoverStaleJobs(): Promise<number> {
    return 0;
  }
}

class FakeRunRepository implements Pick<AgentRunRepository, 'getRun'> {
  readonly runs = new Map<string, AgentRun>();

  async getRun(id: string): Promise<AgentRun | null> {
    return this.runs.get(id) ?? null;
  }
}

function createConfiguredApp(
  options: { queue?: JobQueue; runs?: Pick<AgentRunRepository, 'getRun'> } = {},
) {
  return createApp({
    logger: { error() {}, info() {} },
    queue: options.queue ?? new FakeJobQueue(),
    registry: createDevelopmentAgentRegistry(),
    requestIdGenerator: () => 'generated-request-id',
    runs: options.runs ?? new FakeRunRepository(),
  });
}

describe('API app', () => {
  test('returns liveness status', async () => {
    const response = await createApp({ logger: { error() {}, info() {} } }).request('/health/live');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
  });

  test('returns readiness status as not ready when database is missing', async () => {
    const response = await createApp({ logger: { error() {}, info() {} } }).request(
      '/health/ready',
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: 'not_ready' });
  });

  test('returns readiness status as ready when database is healthy', async () => {
    const response = await createApp({
      database: { isReady: async () => true },
      logger: { error() {}, info() {} },
    }).request('/health/ready');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
  });

  test('lists Agents and returns Agent details', async () => {
    const app = createConfiguredApp();

    const listResponse = await app.request('/agents');
    const detailResponse = await app.request('/agents/echo');

    expect(await listResponse.json()).toEqual({
      agents: [
        {
          id: 'echo',
          name: 'Development Echo Agent',
          version: '0.1.0',
          triggers: ['manual'],
        },
      ],
    });
    expect(await detailResponse.json()).toEqual({
      agent: {
        id: 'echo',
        name: 'Development Echo Agent',
        version: '0.1.0',
        triggers: ['manual'],
      },
    });
  });

  test('accepts valid input asynchronously and reuses an idempotent Job', async () => {
    const queue = new FakeJobQueue();
    const app = createConfiguredApp({ queue });
    const request = {
      input: { value: 'Hello' },
      idempotencyKey: 'manual-echo-1',
    };

    const first = await app.request('/agents/echo/runs', {
      method: 'POST',
      body: JSON.stringify(request),
      headers: { 'Content-Type': 'application/json' },
    });
    const second = await app.request('/agents/echo/runs', {
      method: 'POST',
      body: JSON.stringify(request),
      headers: { 'Content-Type': 'application/json' },
    });

    expect(first.status).toBe(202);
    expect(await first.json()).toEqual({ jobId });
    expect(await second.json()).toEqual({ jobId });
    expect(queue.enqueued).toEqual([{ ...request, agentId: 'echo' }]);
  });

  test('rejects invalid input and unknown Agents', async () => {
    const app = createConfiguredApp();

    const invalid = await app.request('/agents/echo/runs', {
      method: 'POST',
      body: JSON.stringify({ input: { value: 1 } }),
      headers: { 'Content-Type': 'application/json' },
    });
    const missing = await app.request('/agents/missing/runs', {
      method: 'POST',
      body: JSON.stringify({ input: { value: 'Hello' } }),
      headers: { 'Content-Type': 'application/json' },
    });

    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ error: { code: 'BAD_REQUEST' } });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({
      error: {
        code: 'AGENT_NOT_FOUND',
        message: 'Agent "missing" was not found',
        requestId: 'generated-request-id',
      },
    });
  });

  test('returns Job and Run metadata without input or output data', async () => {
    const queue = new FakeJobQueue();
    queue.jobs.set(jobId, createJob({ status: 'completed', attempts: 1, completedAt: now }));
    const runs = new FakeRunRepository();
    runs.runs.set(runId, {
      id: runId,
      jobId,
      agentId: 'echo',
      status: 'completed',
      triggerType: 'queue',
      errorCode: null,
      startedAt: now,
      completedAt: now,
    });
    const app = createConfiguredApp({ queue, runs });

    const jobResponse = await app.request(`/jobs/${jobId}`);
    const runResponse = await app.request(`/runs/${runId}`);

    expect(await jobResponse.json()).toEqual({
      job: {
        id: jobId,
        agentId: 'echo',
        status: 'completed',
        attempts: 1,
        availableAt: '2026-07-19T00:00:00.000Z',
        createdAt: '2026-07-19T00:00:00.000Z',
        completedAt: '2026-07-19T00:00:00.000Z',
        hasError: false,
      },
    });
    expect(await runResponse.json()).toEqual({
      run: {
        id: runId,
        jobId,
        agentId: 'echo',
        status: 'completed',
        triggerType: 'queue',
        errorCode: null,
        startedAt: '2026-07-19T00:00:00.000Z',
        completedAt: '2026-07-19T00:00:00.000Z',
      },
    });
  });

  test('returns stable request IDs and common errors', async () => {
    const app = createConfiguredApp();

    const response = await app.request('/jobs/not-a-uuid', {
      headers: { 'X-Request-Id': 'client-request-id' },
    });

    expect(response.status).toBe(400);
    expect(response.headers.get('X-Request-Id')).toBe('client-request-id');
    expect(await response.json()).toEqual({
      error: {
        code: 'BAD_REQUEST',
        message: 'ID must be a valid UUID',
        requestId: 'client-request-id',
      },
    });
  });

  test('returns a common 500 response for dependency failures', async () => {
    const queue = new FakeJobQueue();
    queue.enqueue = async () => {
      throw new Error('database unavailable');
    };
    const app = createConfiguredApp({ queue });

    const response = await app.request('/agents/echo/runs', {
      method: 'POST',
      body: JSON.stringify({ input: { value: 'Hello' } }),
      headers: { 'Content-Type': 'application/json' },
    });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'An unexpected error occurred',
        requestId: 'generated-request-id',
      },
    });
  });
});
