import {
  AgentCoreError,
  type AgentJob,
  type AgentRegistry,
  type AgentRun,
  type AgentRunRepository,
  type JobQueue,
} from '@ai-agents/agent-core';
import type { DatabaseConnection } from '@ai-agents/database';
import { type Context, Hono } from 'hono';
import { z } from 'zod';

interface ApiEnvironment {
  Variables: {
    requestId: string;
  };
}

export interface ApiLogger {
  info(entry: Record<string, unknown>): void;
  error(entry: Record<string, unknown>): void;
}

export interface ApiAppOptions {
  database?: Pick<DatabaseConnection, 'isReady'>;
  logger?: ApiLogger;
  queue?: JobQueue;
  registry?: AgentRegistry;
  requestIdGenerator?: () => string;
  runs?: Pick<AgentRunRepository, 'getRun'>;
}

class ApiError extends Error {
  constructor(
    readonly code: string,
    readonly status: 400 | 404 | 500,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

const runRequestSchema = z
  .object({
    input: z.unknown(),
    idempotencyKey: z.string().min(1).max(255).optional(),
  })
  .strict()
  .refine((value) => Object.hasOwn(value, 'input'), { message: 'input is required' });

const jobIdSchema = z.uuid();

export function createApp(options: ApiAppOptions = {}): Hono<ApiEnvironment> {
  const app = new Hono<ApiEnvironment>();
  const logger = options.logger ?? consoleLogger;
  const requestIdGenerator = options.requestIdGenerator ?? (() => crypto.randomUUID());

  app.use('*', async (context, next) => {
    const requestId = context.req.header('X-Request-Id')?.trim() || requestIdGenerator();
    context.set('requestId', requestId);
    context.header('X-Request-Id', requestId);

    try {
      await next();
    } finally {
      logger.info({
        event: 'api.request.completed',
        method: context.req.method,
        path: new URL(context.req.url).pathname,
        requestId,
        status: context.res.status,
      });
    }
  });

  app.get('/health/live', (context) => context.json({ status: 'ok' }));

  app.get('/health/ready', async (context) => {
    const ready = options.database ? await options.database.isReady() : false;

    if (!ready) {
      return context.json({ status: 'not_ready' }, 503);
    }

    return context.json({ status: 'ok' });
  });

  app.get('/agents', (context) => {
    const registry = requireRegistry(options);
    return context.json({ agents: registry.list().map((agent) => agent.manifest) });
  });

  app.get('/agents/:agentId', (context) => {
    const registry = requireRegistry(options);
    const agent = getAgent(registry, context.req.param('agentId'));
    return context.json({ agent: agent.manifest });
  });

  app.post('/agents/:agentId/runs', async (context) => {
    const registry = requireRegistry(options);
    const queue = requireQueue(options);
    const agent = getAgent(registry, context.req.param('agentId'));
    const payload = await parseRunRequest(context);
    const inputResult = agent.inputSchema.safeParse(payload.input);

    if (!inputResult.success) {
      throw new ApiError('BAD_REQUEST', 400, inputResult.error.message);
    }

    const enqueueInput = {
      agentId: agent.manifest.id,
      input: inputResult.data,
      ...(payload.idempotencyKey ? { idempotencyKey: payload.idempotencyKey } : {}),
    };
    const job = await queue.enqueue(enqueueInput);
    logger.info({
      agentId: agent.manifest.id,
      event: 'api.job.enqueued',
      jobId: job.id,
      requestId: context.get('requestId'),
    });

    return context.json({ jobId: job.id }, 202);
  });

  app.get('/jobs/:jobId', async (context) => {
    const jobId = parseId(context.req.param('jobId'));
    const job = await requireQueue(options).get(jobId);

    if (!job) {
      throw new ApiError('JOB_NOT_FOUND', 404, `Job "${jobId}" was not found`);
    }

    return context.json({ job: toJobResponse(job) });
  });

  app.get('/runs/:runId', async (context) => {
    const runId = parseId(context.req.param('runId'));
    const run = await requireRunRepository(options).getRun(runId);

    if (!run) {
      throw new ApiError('RUN_NOT_FOUND', 404, `Run "${runId}" was not found`);
    }

    return context.json({ run: toRunResponse(run) });
  });

  app.notFound((context) => errorResponse(context, 'NOT_FOUND', 404, 'Route was not found'));

  app.onError((error, context) => {
    if (error instanceof ApiError) {
      return errorResponse(context, error.code, error.status, error.message);
    }

    if (error instanceof AgentCoreError && error.code === 'AGENT_NOT_FOUND') {
      return errorResponse(context, 'AGENT_NOT_FOUND', 404, error.message);
    }

    logger.error({
      event: 'api.request.failed',
      message: error instanceof Error ? error.message : 'Unknown error',
      requestId: context.get('requestId'),
    });
    return errorResponse(context, 'INTERNAL_ERROR', 500, 'An unexpected error occurred');
  });

  return app;
}

function requireRegistry(options: ApiAppOptions): AgentRegistry {
  if (!options.registry) {
    throw new ApiError('INTERNAL_ERROR', 500, 'Agent Registry is not configured');
  }

  return options.registry;
}

function requireQueue(options: ApiAppOptions): JobQueue {
  if (!options.queue) {
    throw new ApiError('INTERNAL_ERROR', 500, 'Job Queue is not configured');
  }

  return options.queue;
}

function requireRunRepository(options: ApiAppOptions): Pick<AgentRunRepository, 'getRun'> {
  if (!options.runs) {
    throw new ApiError('INTERNAL_ERROR', 500, 'Run Repository is not configured');
  }

  return options.runs;
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
  if (!parsed.success) {
    throw new ApiError('BAD_REQUEST', 400, parsed.error.message);
  }

  return parsed.data;
}

function parseId(value: string): string {
  const parsed = jobIdSchema.safeParse(value);

  if (!parsed.success) {
    throw new ApiError('BAD_REQUEST', 400, 'ID must be a valid UUID');
  }

  return parsed.data;
}

function toJobResponse(job: AgentJob) {
  return {
    agentId: job.agentId,
    attempts: job.attempts,
    availableAt: toIsoString(job.availableAt),
    completedAt: job.completedAt ? toIsoString(job.completedAt) : null,
    createdAt: toIsoString(job.createdAt),
    hasError: job.lastError !== null,
    id: job.id,
    status: job.status,
  };
}

function toRunResponse(run: AgentRun) {
  return {
    agentId: run.agentId,
    completedAt: run.completedAt ? toIsoString(run.completedAt) : null,
    errorCode: run.errorCode,
    id: run.id,
    jobId: run.jobId,
    startedAt: toIsoString(run.startedAt),
    status: run.status,
    triggerType: run.triggerType,
  };
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function errorResponse(
  context: Context<ApiEnvironment>,
  code: string,
  status: 400 | 404 | 500,
  message: string,
) {
  const requestId = context.get('requestId');
  context.header('X-Request-Id', requestId);
  return context.json({ error: { code, message, requestId } }, status);
}

const consoleLogger: ApiLogger = {
  info(entry) {
    console.info(JSON.stringify(entry));
  },
  error(entry) {
    console.error(JSON.stringify(entry));
  },
};
