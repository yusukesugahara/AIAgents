import { AgentCoreError, IdempotencyConflictError } from '@ai-agents/agent-core';
import { GoogleOAuthError } from '@ai-agents/google-oauth';
import { Hono } from 'hono';
import { type ApiAppOptions, type ApiEnvironment, ApiError, type ApiLogger } from './api-types';
import { errorResponse, hasValidBearerToken, isPublicPath, oauthErrorMessage } from './http';
import { registerAgentRoutes } from './routes/agents';
import { registerHealthRoutes } from './routes/health';
import { registerOAuthRoutes } from './routes/oauth';
import { registerRunHistoryRoutes } from './routes/run-history';
import { registerRunRoutes } from './routes/runs';

export type { ApiAppOptions, ApiLogger } from './api-types';

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

  registerHealthRoutes(app, options);
  registerOAuthRoutes(app, options, logger);
  registerAgentRoutes(app, options, logger);
  registerRunRoutes(app, options);
  registerRunHistoryRoutes(app, options);

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
        ...(error.failureReason ? { failureReason: error.failureReason } : {}),
        ...(error.providerError ? { providerError: error.providerError } : {}),
        ...(error.providerStatus ? { providerStatus: error.providerStatus } : {}),
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

const consoleLogger: ApiLogger = {
  info(entry) {
    console.info(JSON.stringify(entry));
  },
  error(entry) {
    console.error(JSON.stringify(entry));
  },
};
