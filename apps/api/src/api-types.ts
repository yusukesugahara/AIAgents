import type {
  AgentRegistry,
  AgentRunHistoryRepository,
  AgentRunRepository,
  AgentRunStepRepository,
  JobQueue,
} from '@ai-agents/agent-core';
import type { GmailDraftWriter, GmailReader } from '@ai-agents/connector-google';
import type { DatabaseConnection, PostgresJobEmailSettingsRepository } from '@ai-agents/database';
import type {
  GoogleConnectionSummaryRepository,
  GoogleOAuthService,
} from '@ai-agents/google-oauth';

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
  AgentRunHistoryRepository &
  Partial<Pick<AgentRunStepRepository, 'getSteps'>>;

export interface ApiAppOptions {
  accessToken?: string;
  database?: Pick<DatabaseConnection, 'isReady'> &
    Partial<Pick<DatabaseConnection, 'isSchemaReady'>>;
  logger?: ApiLogger;
  googleConnections?: GoogleConnectionSummaryRepository;
  googleOAuth?: Pick<GoogleOAuthService, 'begin' | 'cancel' | 'complete'>;
  gmail?: Pick<GmailReader, 'getMessage' | 'listMessages'>;
  gmailDrafts?: Pick<GmailDraftWriter, 'createReplyDraft' | 'findReplyDraft'>;
  jobEmailSettings?: Pick<
    PostgresJobEmailSettingsRepository,
    'getReplySettings' | 'saveReplySettings'
  >;
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
