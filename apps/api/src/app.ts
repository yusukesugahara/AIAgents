import { timingSafeEqual } from 'node:crypto';
import {
  AgentCoreError,
  type AgentJob,
  type AgentRegistry,
  type AgentRun,
  type AgentRunRepository,
  IdempotencyConflictError,
  type JobQueue,
} from '@ai-agents/agent-core';
import type { DatabaseConnection } from '@ai-agents/database';
import {
  GoogleOAuthError,
  type GoogleOAuthErrorCode,
  type GoogleOAuthService,
} from '@ai-agents/google-oauth';
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
  accessToken?: string;
  database?: Pick<DatabaseConnection, 'isReady'> &
    Partial<Pick<DatabaseConnection, 'isSchemaReady'>>;
  logger?: ApiLogger;
  googleOAuth?: Pick<GoogleOAuthService, 'begin' | 'cancel' | 'complete'>;
  oauthRequired?: boolean;
  oauthCookieSecure?: boolean;
  queue?: JobQueue;
  registry?: AgentRegistry;
  requestIdGenerator?: () => string;
  runs?: Pick<AgentRunRepository, 'getLatestRunForJob' | 'getRun'>;
}

class ApiError extends Error {
  constructor(
    readonly code: string,
    readonly status: 400 | 401 | 404 | 409 | 500,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

const runRequestSchema = z
  .object({
    input: z.unknown(),
    idempotencyKey: z.string().trim().min(1).max(255).optional(),
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
      if (
        options.accessToken &&
        !isPublicPath(new URL(context.req.url).pathname) &&
        !hasValidBearerToken(context.req.header('Authorization'), options.accessToken)
      ) {
        return errorResponse(context, 'UNAUTHORIZED', 401, 'Authentication is required');
      }

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

  app.get('/auth/google', async (context) => {
    context.header('Cache-Control', 'no-store');
    context.header('Referrer-Policy', 'no-referrer');
    const authorization = await requireGoogleOAuth(options).begin('gmail_read');
    context.header(
      'Set-Cookie',
      serializeOAuthCookie(authorization.browserNonce, options.oauthCookieSecure ?? false),
    );
    logger.info({
      event: 'oauth.google.authorization_started',
      requestId: context.get('requestId'),
    });
    return context.redirect(authorization.authorizationUrl, 303);
  });

  app.get('/auth/google/compose', async (context) => {
    context.header('Cache-Control', 'no-store');
    context.header('Referrer-Policy', 'no-referrer');
    const authorization = await requireGoogleOAuth(options).begin('gmail_compose');
    context.header(
      'Set-Cookie',
      serializeOAuthCookie(authorization.browserNonce, options.oauthCookieSecure ?? false),
    );
    logger.info({
      event: 'oauth.google.compose_authorization_started',
      requestId: context.get('requestId'),
    });
    return context.redirect(authorization.authorizationUrl, 303);
  });

  app.get('/auth/google/callback', async (context) => {
    const state = context.req.query('state') ?? '';
    const authorizationError = context.req.query('error');
    const browserNonce = readCookie(context.req.header('Cookie'), oauthCookieName) ?? '';
    context.header('Cache-Control', 'no-store');
    context.header('Referrer-Policy', 'no-referrer');
    context.header('Set-Cookie', clearOAuthCookie(options.oauthCookieSecure ?? false));
    const googleOAuth = requireGoogleOAuth(options);

    if (authorizationError) {
      await googleOAuth.cancel({ browserNonce, state });
      if (authorizationError === 'access_denied') {
        throw new GoogleOAuthError('OAUTH_AUTHORIZATION_DENIED', 'Google authorization was denied');
      }
      throw new GoogleOAuthError('OAUTH_PROVIDER_FAILURE', 'Google authorization failed');
    }

    await googleOAuth.complete({
      browserNonce,
      code: context.req.query('code') ?? '',
      state,
    });
    logger.info({ event: 'oauth.google.connected', requestId: context.get('requestId') });
    return context.redirect('/auth/google/complete', 303);
  });

  app.get('/auth/google/complete', (context) => {
    context.header('Cache-Control', 'no-store');
    return context.json({ status: 'completed' });
  });

  app.get('/health/ready', async (context) => {
    const databaseReady = options.database
      ? options.database.isSchemaReady
        ? await options.database.isSchemaReady()
        : await options.database.isReady()
      : false;
    const ready = databaseReady && (!options.oauthRequired || options.googleOAuth !== undefined);

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

    if (!agent.manifest.triggers.includes('manual')) {
      throw new ApiError(
        'AGENT_TRIGGER_UNSUPPORTED',
        400,
        `Agent "${agent.manifest.id}" does not support manual runs`,
      );
    }

    const payload = await parseRunRequest(context);
    const inputResult = agent.inputSchema.safeParse(payload.input);

    if (!inputResult.success) {
      throw new ApiError('BAD_REQUEST', 400, inputResult.error.message);
    }

    const enqueueInput = {
      agentId: agent.manifest.id,
      input: inputResult.data,
      triggerType: 'manual',
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

    const latestRun = await requireRunRepository(options).getLatestRunForJob(jobId);
    return context.json({ job: toJobResponse(job, latestRun) });
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

    if (error instanceof IdempotencyConflictError) {
      return errorResponse(context, 'IDEMPOTENCY_CONFLICT', 409, error.message);
    }

    if (error instanceof GoogleOAuthError) {
      const status =
        error.code === 'OAUTH_STATE_INVALID' ||
        error.code === 'OAUTH_AUTHORIZATION_DENIED' ||
        error.code === 'OAUTH_PROFILE_INVALID' ||
        error.code === 'OAUTH_REFRESH_TOKEN_MISSING'
          ? 400
          : 500;
      logger.error({
        code: error.code,
        event: 'oauth.google.failed',
        requestId: context.get('requestId'),
      });
      return errorResponse(context, error.code, status, oauthErrorMessage(error.code));
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

function requireGoogleOAuth(
  options: ApiAppOptions,
): Pick<GoogleOAuthService, 'begin' | 'cancel' | 'complete'> {
  if (!options.googleOAuth) {
    throw new GoogleOAuthError('OAUTH_CONFIGURATION_INVALID', 'Google OAuth is not configured');
  }
  return options.googleOAuth;
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

function requireRunRepository(
  options: ApiAppOptions,
): Pick<AgentRunRepository, 'getLatestRunForJob' | 'getRun'> {
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

function toJobResponse(job: AgentJob, latestRun: AgentRun | null) {
  return {
    agentId: job.agentId,
    attempts: job.attempts,
    availableAt: toIsoString(job.availableAt),
    completedAt: job.completedAt ? toIsoString(job.completedAt) : null,
    createdAt: toIsoString(job.createdAt),
    errorCode: job.lastErrorCode,
    hasError: job.lastErrorCode !== null || job.lastError !== null,
    id: job.id,
    latestRunId: latestRun?.id ?? null,
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
  status: 400 | 401 | 404 | 409 | 500,
  message: string,
) {
  const requestId = context.get('requestId');
  context.header('X-Request-Id', requestId);
  return context.json({ error: { code, message, requestId } }, status);
}

function hasValidBearerToken(authorization: string | undefined, expectedToken: string): boolean {
  const token = authorization?.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : '';
  const encoder = new TextEncoder();
  const actual = encoder.encode(token);
  const expected = encoder.encode(expectedToken);

  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function isPublicPath(pathname: string): boolean {
  return (
    pathname.startsWith('/health/') ||
    pathname === '/auth/google' ||
    pathname === '/auth/google/compose' ||
    pathname === '/auth/google/callback' ||
    pathname === '/auth/google/complete'
  );
}

const oauthCookieName = 'ai_agents_oauth_nonce';

function serializeOAuthCookie(value: string, secure: boolean): string {
  return `${oauthCookieName}=${value}; Path=/auth/google; Max-Age=600; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
}

function clearOAuthCookie(secure: boolean): string {
  return `${oauthCookieName}=; Path=/auth/google; Max-Age=0; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
}

function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) {
    return undefined;
  }
  return header
    .split(';')
    .map((value) => value.trim())
    .find((value) => value.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}

function oauthErrorMessage(code: GoogleOAuthErrorCode): string {
  switch (code) {
    case 'OAUTH_STATE_INVALID':
      return 'OAuth authorization is invalid or expired';
    case 'OAUTH_AUTHORIZATION_DENIED':
      return 'Google authorization was denied';
    case 'OAUTH_PROFILE_INVALID':
      return 'Google account email could not be verified';
    case 'OAUTH_REFRESH_TOKEN_MISSING':
      return 'Google did not grant offline access';
    case 'OAUTH_CONFIGURATION_INVALID':
    case 'OAUTH_PROVIDER_FAILURE':
      return 'Google OAuth is temporarily unavailable';
  }
}

const consoleLogger: ApiLogger = {
  info(entry) {
    console.info(JSON.stringify(entry));
  },
  error(entry) {
    console.error(JSON.stringify(entry));
  },
};
