import { createRuntimeAgentRegistry } from '@ai-agents/agent-composition';
import { AgentRunner } from '@ai-agents/agent-core';
import { loadJobEmailAnalysisRuntimeConfig, loadJobRuntimeConfig } from '@ai-agents/config';
import { HttpGmailReader } from '@ai-agents/connector-google';
import {
  createDatabaseConnection,
  type DatabaseConnection,
  PostgresAgentRunRepository,
  PostgresGoogleConnectionRepository,
  PostgresJobEmailAnalysisRepository,
  PostgresJobEmailReviewRequestRepository,
  PostgresJobQueue,
  PostgresLlmInvocationRepository,
} from '@ai-agents/database';
import {
  AesGcmTokenCipher,
  GoogleAccessTokenService,
  HttpGoogleTokenRefresher,
  loadGoogleAccessTokenConfig,
} from '@ai-agents/google-oauth';
import { createJobSearchEmailAgent } from '@ai-agents/job-search-email';
import { OpenAiLlmProvider } from '@ai-agents/llm';
import { startWorker } from './worker';

let database: DatabaseConnection | undefined;
const jobRuntimeConfig = loadJobRuntimeConfig();
const analysisRuntimeConfig = loadJobEmailAnalysisRuntimeConfig();
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
const accessTokens = new GoogleAccessTokenService({
  cipher: AesGcmTokenCipher.fromBase64Key(googleAccessTokenConfig.tokenEncryptionKey),
  credentials: googleConnections,
  refresher: new HttpGoogleTokenRefresher(googleAccessTokenConfig),
});
const jobSearchEmailAgent = createJobSearchEmailAgent({
  analyses: new PostgresJobEmailAnalysisRepository(database),
  gmail: new HttpGmailReader({ accessTokens }),
  llm: new OpenAiLlmProvider({
    apiKey: analysisRuntimeConfig.openAiApiKey,
    invocationRepository: new PostgresLlmInvocationRepository(database),
  }),
  model: analysisRuntimeConfig.openAiModel,
  reviews: new PostgresJobEmailReviewRequestRepository(database),
});

const worker = await startWorker({
  database,
  leaseHeartbeatIntervalMs: jobRuntimeConfig.leaseHeartbeatIntervalMs,
  leaseTimeoutMs: jobRuntimeConfig.lockTimeoutMs,
  pollIntervalMs: jobRuntimeConfig.pollIntervalMs,
  queue: new PostgresJobQueue(database, jobRuntimeConfig),
  runner: new AgentRunner({
    registry: createRuntimeAgentRegistry({
      environment: process.env.APP_ENV,
      jobSearchEmailAgent,
    }),
    repository: new PostgresAgentRunRepository(database),
  }),
});

let shutdownPromise: Promise<void> | undefined;

const shutdown = async (): Promise<void> => {
  if (shutdownPromise) {
    return shutdownPromise;
  }

  shutdownPromise = (async () => {
    let exitCode = 0;

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
    } finally {
      process.exit(exitCode);
    }
  })();

  return shutdownPromise;
};

process.once('SIGINT', () => {
  void shutdown();
});

process.once('SIGTERM', () => {
  void shutdown();
});
