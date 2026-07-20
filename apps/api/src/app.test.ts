import { describe, expect, test } from 'bun:test';
import { createDevelopmentAgentRegistry } from '@ai-agents/agent-composition';
import { IdempotencyConflictError } from '@ai-agents/agent-core';
import { createApp } from './app';
import {
  createConfiguredApp,
  createJob,
  FakeJobQueue,
  FakeRunRepository,
  jobId,
  now,
  runId,
} from './app.test-support';

describe('API app', () => {
  test('returns Job metadata and keeps non-Job-Search Run output private', async () => {
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
        latestRun: {
          agentId: 'echo',
          completedAt: '2026-07-19T00:00:00.000Z',
          errorCode: null,
          id: runId,
          jobId,
          output: null,
          startedAt: '2026-07-19T00:00:00.000Z',
          status: 'completed',
          steps: [],
          triggerType: 'queue',
        },
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
        output: null,
        steps: [],
      },
    });
  });

  test('returns safe Job Search Email Run output and step state without stored inputs', async () => {
    const queue = new FakeJobQueue();
    queue.jobs.set(jobId, createJob({ agentId: 'job-search-email', status: 'completed' }));
    const runs = new FakeRunRepository();
    runs.runs.set(runId, {
      agentId: 'job-search-email',
      completedAt: now,
      errorCode: null,
      id: runId,
      jobId,
      output: {
        analysis: { evidence: ['private email excerpt'] },
        calendarEventId: 'calendar-event-1',
        draftId: 'draft-1',
        result: 'completed',
      },
      startedAt: now,
      status: 'completed',
      triggerType: 'manual',
    });
    runs.steps.set(runId, [
      {
        completedAt: now,
        errorCode: null,
        id: '0198be1d-a3a9-7d34-9bc3-123456789abe',
        input: { body: 'private Gmail content' },
        output: { draftId: 'draft-1', recipient: 'private@example.com' },
        runId,
        sequence: 50,
        startedAt: now,
        status: 'succeeded',
        stepName: 'CREATE_DRAFT',
      },
      {
        completedAt: now,
        errorCode: 'RATE_LIMITED',
        id: '0198be1d-a3a9-7d34-9bc3-123456789abf',
        input: { prompt: 'private prompt' },
        output: {
          draftId: { secret: 'private nested detail' },
          providerDetail: 'private detail',
          retryable: true,
        },
        runId,
        sequence: 20,
        startedAt: now,
        status: 'failed',
        stepName: 'ANALYZE_EMAIL',
      },
    ]);
    const app = createConfiguredApp({ queue, runs });
    const response = await app.request(`/runs/${runId}`);
    const body = await response.json();

    expect(body).toMatchObject({
      run: {
        output: {
          calendarEventId: 'calendar-event-1',
          draftId: 'draft-1',
          result: 'completed',
        },
        steps: [
          {
            errorCode: 'RATE_LIMITED',
            output: { retryable: true },
            sequence: 20,
            status: 'failed',
            stepName: 'ANALYZE_EMAIL',
          },
          {
            errorCode: null,
            output: { draftId: 'draft-1' },
            sequence: 50,
            status: 'succeeded',
            stepName: 'CREATE_DRAFT',
          },
        ],
      },
    });
    expect(JSON.stringify(body)).not.toContain('private');

    const jobResponse = await app.request(`/jobs/${jobId}`);
    const jobBody = await jobResponse.json();
    expect(jobBody).toMatchObject({
      job: {
        latestRun: {
          output: {
            calendarEventId: 'calendar-event-1',
            draftId: 'draft-1',
            result: 'completed',
          },
          steps: body.run.steps,
        },
        latestRunId: runId,
      },
    });
    expect(JSON.stringify(jobBody)).not.toContain('private');
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
