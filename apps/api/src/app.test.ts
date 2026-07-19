import { describe, expect, test } from 'bun:test';
import { createDevelopmentAgentRegistry } from '@ai-agents/agent-composition';
import type {
  AgentJob,
  AgentRun,
  AgentRunRepository,
  ClaimNextJobInput,
  CompleteJobInput,
  EnqueueJobInput,
  ExtendJobLeaseInput,
  FailJobInput,
  JobQueue,
  ReleaseJobInput,
} from '@ai-agents/agent-core';
import { AgentRegistry, defineAgent, IdempotencyConflictError } from '@ai-agents/agent-core';
import { z } from 'zod';

import { createApp } from './app';

const now = new Date('2026-07-19T00:00:00.000Z');
const jobId = '0198be1d-a3a9-7d34-9bc3-123456789abc';
const runId = '0198be1d-a3a9-7d34-9bc3-123456789abd';

function createJob(overrides: Partial<AgentJob> = {}): AgentJob {
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

  async extendLease(_input: ExtendJobLeaseInput): Promise<boolean> {
    return true;
  }

  async release(_input: ReleaseJobInput): Promise<void> {}

  async fail(_input: FailJobInput): Promise<void> {}

  async recoverStaleJobs(): Promise<number> {
    return 0;
  }
}

class FakeRunRepository implements Pick<AgentRunRepository, 'getLatestRunForJob' | 'getRun'> {
  readonly runs = new Map<string, AgentRun>();

  async getRun(id: string): Promise<AgentRun | null> {
    return this.runs.get(id) ?? null;
  }

  async getLatestRunForJob(jobId: string): Promise<AgentRun | null> {
    return (
      [...this.runs.values()]
        .filter((run) => run.jobId === jobId)
        .sort((left, right) => right.startedAt.getTime() - left.startedAt.getTime())[0] ?? null
    );
  }
}

function createConfiguredApp(
  options: {
    queue?: JobQueue;
    runs?: Pick<AgentRunRepository, 'getLatestRunForJob' | 'getRun'>;
  } = {},
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
    expect(queue.enqueued).toEqual([{ ...request, agentId: 'echo', triggerType: 'manual' }]);
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

  test('rejects whitespace-only idempotency keys', async () => {
    const response = await createConfiguredApp().request('/agents/echo/runs', {
      method: 'POST',
      body: JSON.stringify({ input: { value: 'Hello' }, idempotencyKey: '   ' }),
      headers: { 'Content-Type': 'application/json' },
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: 'BAD_REQUEST' } });
  });

  test('rejects manual runs for Agents that do not declare the manual trigger', async () => {
    const registry = new AgentRegistry().register(
      defineAgent({
        manifest: {
          id: 'scheduled-only',
          name: 'Scheduled only',
          version: '0.1.0',
          triggers: ['schedule'],
        },
        inputSchema: z.object({ value: z.string() }),
        outputSchema: z.object({ value: z.string() }),
        async run(_context, input) {
          return input;
        },
      }),
    );
    const queue = new FakeJobQueue();
    const app = createApp({
      logger: { error() {}, info() {} },
      queue,
      registry,
      requestIdGenerator: () => 'generated-request-id',
      runs: new FakeRunRepository(),
    });

    const response = await app.request('/agents/scheduled-only/runs', {
      method: 'POST',
      body: JSON.stringify({ input: { value: 'Hello' } }),
      headers: { 'Content-Type': 'application/json' },
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: 'AGENT_TRIGGER_UNSUPPORTED' },
    });
    expect(queue.enqueued).toHaveLength(0);
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
        errorCode: null,
        hasError: false,
        latestRunId: runId,
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

  test('exposes a Job error code without exposing its error message', async () => {
    const queue = new FakeJobQueue();
    queue.jobs.set(
      jobId,
      createJob({
        status: 'failed',
        lastErrorCode: 'AGENT_EXECUTION_FAILED',
        lastError: 'sensitive adapter detail',
      }),
    );
    const app = createConfiguredApp({ queue });

    const response = await app.request(`/jobs/${jobId}`);
    const body = await response.json();

    expect(body).toMatchObject({
      job: { errorCode: 'AGENT_EXECUTION_FAILED', hasError: true },
    });
    expect(JSON.stringify(body)).not.toContain('sensitive adapter detail');
  });

  test('reports migrated Job errors even when a legacy error code is unavailable', async () => {
    const queue = new FakeJobQueue();
    queue.jobs.set(
      jobId,
      createJob({ status: 'failed', lastErrorCode: null, lastError: 'legacy failure detail' }),
    );
    const app = createConfiguredApp({ queue });

    const response = await app.request(`/jobs/${jobId}`);
    const body = await response.json();

    expect(body).toMatchObject({ job: { errorCode: null, hasError: true } });
    expect(JSON.stringify(body)).not.toContain('legacy failure detail');
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

  test('requires a configured Bearer token except for health checks', async () => {
    const app = createApp({
      accessToken: 'test-token',
      logger: { error() {}, info() {} },
      queue: new FakeJobQueue(),
      registry: createDevelopmentAgentRegistry(),
      requestIdGenerator: () => 'generated-request-id',
      runs: new FakeRunRepository(),
    });

    const denied = await app.request('/agents');
    const allowed = await app.request('/agents', {
      headers: { Authorization: 'Bearer test-token' },
    });
    const health = await app.request('/health/live');

    expect(denied.status).toBe(401);
    expect(await denied.json()).toEqual({
      error: {
        code: 'UNAUTHORIZED',
        message: 'Authentication is required',
        requestId: 'generated-request-id',
      },
    });
    expect(allowed.status).toBe(200);
    expect(health.status).toBe(200);
  });

  test('returns 409 when an idempotency key is reused for a different request', async () => {
    const queue = new FakeJobQueue();
    queue.enqueue = async () => {
      throw new IdempotencyConflictError(
        'idempotency key was already used with a different request',
      );
    };
    const app = createConfiguredApp({ queue });

    const response = await app.request('/agents/echo/runs', {
      method: 'POST',
      body: JSON.stringify({ input: { value: 'Hello' }, idempotencyKey: 'same-key' }),
      headers: { 'Content-Type': 'application/json' },
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'IDEMPOTENCY_CONFLICT' } });
  });
});
