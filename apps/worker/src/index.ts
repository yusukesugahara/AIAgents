import { createRuntimeAgentRegistry } from '@ai-agents/agent-composition';
import { AgentRunner } from '@ai-agents/agent-core';
import { loadJobRuntimeConfig } from '@ai-agents/config';
import {
  createDatabaseConnection,
  type DatabaseConnection,
  PostgresAgentRunRepository,
  PostgresJobQueue,
} from '@ai-agents/database';
import { startWorker } from './worker';

let database: DatabaseConnection | undefined;
const jobRuntimeConfig = loadJobRuntimeConfig();

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

const worker = await startWorker({
  database,
  leaseHeartbeatIntervalMs: jobRuntimeConfig.leaseHeartbeatIntervalMs,
  leaseTimeoutMs: jobRuntimeConfig.lockTimeoutMs,
  pollIntervalMs: jobRuntimeConfig.pollIntervalMs,
  queue: new PostgresJobQueue(database, jobRuntimeConfig),
  runner: new AgentRunner({
    registry: createRuntimeAgentRegistry(),
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
