import { createRuntimeAgentRegistry } from '@ai-agents/agent-composition';
import { AgentRunner } from '@ai-agents/agent-core';
import {
  loadDataRetentionRuntimeConfig,
  loadGmailPollingRuntimeConfig,
  loadJobEmailAnalysisRuntimeConfig,
  loadJobRuntimeConfig,
} from '@ai-agents/config';
import {
  HttpGmailDraftWriter,
  HttpGmailReader,
  HttpGoogleCalendarClient,
} from '@ai-agents/connector-google';
import {
  createDatabaseConnection,
  type DatabaseConnection,
  PostgresAgentRunRepository,
  PostgresGoogleConnectionRepository,
  PostgresJobEmailAnalysisRepository,
  PostgresJobEmailCalendarEventRepository,
  PostgresJobEmailDraftRepository,
  PostgresJobEmailReviewRequestRepository,
  PostgresJobEmailSettingsRepository,
  PostgresJobQueue,
  PostgresLlmInvocationRepository,
  PostgresOperationalDataRetentionRepository,
} from '@ai-agents/database';
import {
  AesGcmTokenCipher,
  GoogleAccessTokenService,
  HttpGoogleTokenRefresher,
  loadGoogleAccessTokenConfig,
} from '@ai-agents/google-oauth';
import { createJobSearchEmailAgent } from '@ai-agents/job-search-email';
import { OpenAiLlmProvider } from '@ai-agents/llm';
import { startDataRetentionCleanup } from './data-retention';
import { startGmailPoller } from './gmail-poller';
import { startWorker } from './worker';

let database: DatabaseConnection | undefined;
const jobRuntimeConfig = loadJobRuntimeConfig();
const analysisRuntimeConfig = loadJobEmailAnalysisRuntimeConfig();
const gmailPollingConfig = loadGmailPollingRuntimeConfig();
const dataRetentionConfig = loadDataRetentionRuntimeConfig();
const googleAccessTokenConfig = loadGoogleAccessTokenConfig();

try {
  database = createDatabaseConnection();
} catch (error) {
  console.warn(
    JSON.stringify({
      event: 'worker.database.unavailable',
      message: error instanceof Error ? error.message : 'unknown',
    }),
  );
}

if (!database) {
  throw new Error('Worker requires a configured DATABASE_URL');
}

const googleConnections = new PostgresGoogleConnectionRepository(database);
const runs = new PostgresAgentRunRepository(database);
const accessTokens = new GoogleAccessTokenService({
  cipher: AesGcmTokenCipher.fromBase64Keys(
    googleAccessTokenConfig.tokenEncryptionKey,
    googleAccessTokenConfig.tokenEncryptionPreviousKeys,
  ),
  credentials: googleConnections,
  refresher: new HttpGoogleTokenRefresher(googleAccessTokenConfig),
});
const gmail = new HttpGmailReader({ accessTokens });
const queue = new PostgresJobQueue(database, jobRuntimeConfig);
const settings = new PostgresJobEmailSettingsRepository(database);
const jobSearchEmailAgent = createJobSearchEmailAgent({
  analyses: new PostgresJobEmailAnalysisRepository(database),
  calendar: new HttpGoogleCalendarClient({ accessTokens }),
  calendarEvents: new PostgresJobEmailCalendarEventRepository(database),
  drafts: new PostgresJobEmailDraftRepository(database),
  gmailDrafts: new HttpGmailDraftWriter({ accessTokens }),
  gmail,
  llm: new OpenAiLlmProvider({
    apiKey: analysisRuntimeConfig.openAiApiKey,
    invocationRepository: new PostgresLlmInvocationRepository(database),
  }),
  model: analysisRuntimeConfig.openAiModel,
  replyModel: analysisRuntimeConfig.openAiReplyModel,
  reviews: new PostgresJobEmailReviewRequestRepository(database),
  settings,
  steps: runs,
});

const worker = await startWorker({
  concurrency: jobRuntimeConfig.concurrency,
  database,
  leaseHeartbeatIntervalMs: jobRuntimeConfig.leaseHeartbeatIntervalMs,
  leaseTimeoutMs: jobRuntimeConfig.lockTimeoutMs,
  pollIntervalMs: jobRuntimeConfig.pollIntervalMs,
  queue,
  runner: new AgentRunner({
    registry: createRuntimeAgentRegistry({
      environment: process.env.APP_ENV,
      jobSearchEmailAgent,
    }),
    repository: runs,
  }),
});
const gmailPoller = startGmailPoller({
  connections: googleConnections,
  gmail,
  intervalMs: gmailPollingConfig.intervalMs,
  maxMessages: gmailPollingConfig.maxMessages,
  maxResults: gmailPollingConfig.maxResults,
  query: gmailPollingConfig.query,
  queue,
  settings,
});
const dataRetention = startDataRetentionCleanup({
  cleanupIntervalMs: dataRetentionConfig.cleanupIntervalMs,
  repository: new PostgresOperationalDataRetentionRepository(database),
  retentionMs: dataRetentionConfig.retentionMs,
});

let shutdownPromise: Promise<void> | undefined;

const shutdown = async (): Promise<void> => {
  if (shutdownPromise) {
    return shutdownPromise;
  }

  shutdownPromise = (async () => {
    let exitCode = 0;

    try {
      await gmailPoller.stop();
    } catch (error) {
      exitCode = 1;
      console.error(
        JSON.stringify({
          event: 'gmail.poller.shutdown_failed',
          message: error instanceof Error ? error.message : 'unknown',
        }),
      );
    }
    try {
      await dataRetention.stop();
    } catch (error) {
      exitCode = 1;
      console.error(
        JSON.stringify({
          event: 'data_retention.shutdown_failed',
          message: error instanceof Error ? error.message : 'unknown',
        }),
      );
    }
    try {
      await worker.stop();
    } catch (error) {
      exitCode = 1;
      console.error(
        JSON.stringify({
          event: 'worker.shutdown.failed',
          message: error instanceof Error ? error.message : 'unknown',
        }),
      );
    }
    process.exit(exitCode);
  })();

  return shutdownPromise;
};

process.once('SIGINT', () => {
  void shutdown();
});

process.once('SIGTERM', () => {
  void shutdown();
});
