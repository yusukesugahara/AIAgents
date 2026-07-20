import { AgentCoreError, type AgentRegistry, type JobQueue } from '@ai-agents/agent-core';
import { GoogleOAuthError, type GoogleOAuthService } from '@ai-agents/google-oauth';
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import { type ApiAppOptions, type ApiEnvironment, ApiError, type ApiLogger } from './api-types';
import { clearOAuthCookie, readOAuthCookie, serializeOAuthCookie } from './http';
import { toJobResponse, toRunResponse } from './presenters';

const runRequestSchema = z
  .object({
    input: z.unknown(),
    idempotencyKey: z.string().trim().min(1).max(255).optional(),
  })
  .strict()
  .refine((value) => Object.hasOwn(value, 'input'), { message: 'input is required' });

const jobIdSchema = z.uuid();

export function registerHealthRoutes(app: Hono<ApiEnvironment>, options: ApiAppOptions): void {
  app.get('/health/live', (context) => context.json({ status: 'ok' }));
  app.get('/health/ready', async (context) => {
    const databaseReady = options.database
      ? options.database.isSchemaReady
        ? await options.database.isSchemaReady()
        : await options.database.isReady()
      : false;
    const ready = databaseReady && (!options.oauthRequired || options.googleOAuth !== undefined);
    return ready ? context.json({ status: 'ok' }) : context.json({ status: 'not_ready' }, 503);
  });
}

export function registerOAuthRoutes(
  app: Hono<ApiEnvironment>,
  options: ApiAppOptions,
  logger: ApiLogger,
): void {
  const startAuthorization = async (
    context: Context<ApiEnvironment>,
    purpose: 'calendar_events' | 'gmail_compose' | 'gmail_read',
    event: string,
  ) => {
    context.header('Cache-Control', 'no-store');
    context.header('Referrer-Policy', 'no-referrer');
    const authorization = await requireGoogleOAuth(options).begin(purpose);
    context.header(
      'Set-Cookie',
      serializeOAuthCookie(authorization.browserNonce, options.oauthCookieSecure ?? false),
    );
    logger.info({ event, requestId: context.get('requestId') });
    return context.redirect(authorization.authorizationUrl, 303);
  };

  app.get('/auth/google', (context) =>
    startAuthorization(context, 'gmail_read', 'oauth.google.authorization_started'),
  );
  app.get('/auth/google/compose', (context) =>
    startAuthorization(context, 'gmail_compose', 'oauth.google.compose_authorization_started'),
  );
  app.get('/auth/google/calendar', (context) =>
    startAuthorization(context, 'calendar_events', 'oauth.google.calendar_authorization_started'),
  );
  app.get('/auth/google/callback', async (context) => {
    const state = context.req.query('state') ?? '';
    const authorizationError = context.req.query('error');
    const browserNonce = readOAuthCookie(context.req.header('Cookie')) ?? '';
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
}

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

export function registerRunRoutes(app: Hono<ApiEnvironment>, options: ApiAppOptions): void {
  app.get('/jobs/:jobId', async (context) => {
    const jobId = parseId(context.req.param('jobId'));
    const job = await requireQueue(options).get(jobId);
    if (!job) throw new ApiError('JOB_NOT_FOUND', 404, `Job "${jobId}" was not found`);
    const runs = requireRunRepository(options);
    const latestRun = await runs.getLatestRunForJob(jobId);
    const steps = latestRun && runs.getSteps ? await runs.getSteps(latestRun.id) : [];
    return context.json({ job: toJobResponse(job, latestRun, steps) });
  });
  app.get('/runs/:runId', async (context) => {
    const runId = parseId(context.req.param('runId'));
    const runs = requireRunRepository(options);
    const run = await runs.getRun(runId);
    if (!run) throw new ApiError('RUN_NOT_FOUND', 404, `Run "${runId}" was not found`);
    const steps = runs.getSteps ? await runs.getSteps(runId) : [];
    return context.json({ run: toRunResponse(run, steps) });
  });
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
  if (!options.registry)
    throw new ApiError('INTERNAL_ERROR', 500, 'Agent Registry is not configured');
  return options.registry;
}

function requireQueue(options: ApiAppOptions): JobQueue {
  if (!options.queue) throw new ApiError('INTERNAL_ERROR', 500, 'Job Queue is not configured');
  return options.queue;
}

function requireRunRepository(options: ApiAppOptions) {
  if (!options.runs) throw new ApiError('INTERNAL_ERROR', 500, 'Run Repository is not configured');
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
  if (!parsed.success) throw new ApiError('BAD_REQUEST', 400, parsed.error.message);
  return parsed.data;
}

function parseId(value: string): string {
  const parsed = jobIdSchema.safeParse(value);
  if (!parsed.success) throw new ApiError('BAD_REQUEST', 400, 'ID must be a valid UUID');
  return parsed.data;
}
