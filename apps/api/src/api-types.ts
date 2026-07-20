import type {
  AgentRegistry,
  AgentRunRepository,
  AgentRunStepRepository,
  JobQueue,
} from '@ai-agents/agent-core';
import type { DatabaseConnection } from '@ai-agents/database';
import type { GoogleOAuthService } from '@ai-agents/google-oauth';

export interface ApiEnvironment {
  Variables: {
    requestId: string;
  };
}

export interface ApiLogger {
  info(entry: Record<string, unknown>): void;
  error(entry: Record<string, unknown>): void;
}

export type ApiRunRepository = Pick<AgentRunRepository, 'getLatestRunForJob' | 'getRun'> &
  Partial<Pick<AgentRunStepRepository, 'getSteps'>>;

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
  runs?: ApiRunRepository;
}

export class ApiError extends Error {
  constructor(
    readonly code: string,
    readonly status: 400 | 401 | 404 | 409 | 500,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}
