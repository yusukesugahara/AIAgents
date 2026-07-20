import { describe, expect, test } from 'bun:test';
import { AgentRegistry, defineAgent } from '@ai-agents/agent-core';
import { z } from 'zod';
import { createApp } from './app';
import { createConfiguredApp, FakeJobQueue, FakeRunRepository, jobId } from './app.test-support';

describe('API Agent routes', () => {
  test('lists Agents and returns Agent details', async () => {
    const app = createConfiguredApp();

    const listResponse = await app.request('/agents');
    const detailResponse = await app.request('/agents/echo');

    expect(await listResponse.json()).toEqual({
      agents: [
        {
          id: 'job-search-email',
          name: '就職活動メールエージェント',
          version: '0.2.0',
          triggers: ['manual', 'schedule', 'gmail-push'],
        },
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

  test('validates and enqueues Job Search Email input without executing the Agent', async () => {
    const queue = new FakeJobQueue();
    const app = createConfiguredApp({ queue });
    const validInput = {
      googleConnectionId: '0198d171-8d5f-7b1a-8812-0123456789ab',
      gmailMessageId: 'message-1',
      gmailThreadId: 'thread-1',
    };
    const accepted = await app.request('/agents/job-search-email/runs', {
      method: 'POST',
      body: JSON.stringify({ input: validInput }),
      headers: { 'Content-Type': 'application/json' },
    });
    const rejected = await app.request('/agents/job-search-email/runs', {
      method: 'POST',
      body: JSON.stringify({ input: { ...validInput, googleConnectionId: 'not-a-uuid' } }),
      headers: { 'Content-Type': 'application/json' },
    });

    expect(accepted.status).toBe(202);
    expect(queue.enqueued).toEqual([
      { agentId: 'job-search-email', input: validInput, triggerType: 'manual' },
    ]);
    expect(rejected.status).toBe(400);
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
});
