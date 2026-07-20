import { AgentCoreError, type AgentRegistry, type JobQueue } from '@ai-agents/agent-core';
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import { type ApiAppOptions, type ApiEnvironment, ApiError, type ApiLogger } from '../api-types';

const runRequestSchema = z
  .object({
    input: z.unknown(),
    idempotencyKey: z.string().trim().min(1).max(255).optional(),
  })
  .strict()
  .refine((value) => Object.hasOwn(value, 'input'), { message: 'input is required' });

export function registerAgentRoutes(
  app: Hono<ApiEnvironment>,
  options: ApiAppOptions,
  logger: ApiLogger,
): void {
  app.get('/agents', (context) => {
    const registry = requireRegistry(options);
    return context.json({ agents: registry.list().map((agent) => agent.manifest) });
  });
  app.get('/agents/:agentId', (context) => {
    const registry = requireRegistry(options);
    return context.json({ agent: getAgent(registry, context.req.param('agentId')).manifest });
  });
  app.post('/agents/:agentId/runs', async (context) => {
    const registry = requireRegistry(options);
    const queue = requireQueue(options);
    const agent = getAgent(registry, context.req.param('agentId'));
    if (!agent.manifest.triggers.includes('manual')) {
      throw new ApiError(
        'AGENT_TRIGGER_UNSUPPORTED',
        400,
        `Agent "${agent.manifest.id}" does not support manual runs`,
      );
    }
    const payload = await parseRunRequest(context);
    const inputResult = agent.inputSchema.safeParse(payload.input);
    if (!inputResult.success) throw new ApiError('BAD_REQUEST', 400, inputResult.error.message);
    const job = await queue.enqueue({
      agentId: agent.manifest.id,
      input: inputResult.data,
      triggerType: 'manual',
      ...(payload.idempotencyKey ? { idempotencyKey: payload.idempotencyKey } : {}),
    });
    logger.info({
      agentId: agent.manifest.id,
      event: 'api.job.enqueued',
      jobId: job.id,
      requestId: context.get('requestId'),
    });
    return context.json({ jobId: job.id }, 202);
  });
}

function requireRegistry(options: ApiAppOptions): AgentRegistry {
  if (!options.registry) {
    throw new ApiError('INTERNAL_ERROR', 500, 'Agent Registry is not configured');
  }
  return options.registry;
}

function requireQueue(options: ApiAppOptions): JobQueue {
  if (!options.queue) throw new ApiError('INTERNAL_ERROR', 500, 'Job Queue is not configured');
  return options.queue;
}

function getAgent(registry: AgentRegistry, agentId: string) {
  try {
    return registry.get(agentId);
  } catch (error) {
    if (error instanceof AgentCoreError && error.code === 'AGENT_NOT_FOUND') {
      throw new ApiError('AGENT_NOT_FOUND', 404, `Agent "${agentId}" was not found`);
    }
    throw error;
  }
}

async function parseRunRequest(context: Context<ApiEnvironment>) {
  let body: unknown;
  try {
    body = await context.req.json();
  } catch {
    throw new ApiError('BAD_REQUEST', 400, 'Request body must be valid JSON');
  }
  const parsed = runRequestSchema.safeParse(body);
  if (!parsed.success) throw new ApiError('BAD_REQUEST', 400, parsed.error.message);
  return parsed.data;
}
