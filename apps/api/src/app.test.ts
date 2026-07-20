import { describe, expect, test } from 'bun:test';
import { createDevelopmentAgentRegistry } from '@ai-agents/agent-composition';
import { IdempotencyConflictError } from '@ai-agents/agent-core';
import { createApp } from './app';
import { createConfiguredApp, FakeJobQueue, FakeRunRepository } from './app.test-support';

describe('API middleware and errors', () => {
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
    const readiness = await app.request('/health/ready');
    const unknownHealthRoute = await app.request('/health/private');

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
    expect(readiness.status).toBe(503);
    expect(unknownHealthRoute.status).toBe(401);
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
