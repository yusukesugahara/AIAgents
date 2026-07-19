import { createRuntimeAgentRegistry } from '@ai-agents/agent-composition';
import { loadJobRuntimeConfig } from '@ai-agents/config';
import {
  createDatabaseConnection,
  type DatabaseConnection,
  PostgresAgentRunRepository,
  PostgresJobQueue,
} from '@ai-agents/database';
import { createApp } from './app';
import { resolveApiAccessToken } from './runtime-config';

const port = Number(process.env.APP_PORT ?? 4000);
const accessToken = resolveApiAccessToken();
const jobRuntimeConfig = loadJobRuntimeConfig();
let database: DatabaseConnection | undefined;

try {
  database = createDatabaseConnection();
} catch (error) {
  console.warn(
    JSON.stringify({
      event: 'api.database.unavailable',
      message: error instanceof Error ? error.message : 'unknown',
    }),
  );
}

console.info(
  JSON.stringify({
    event: 'api.starting',
    port,
    databaseConnected: database !== undefined,
  }),
);

const app = createApp({
  ...(accessToken ? { accessToken } : {}),
  ...(database
    ? {
        database,
        queue: new PostgresJobQueue(database, jobRuntimeConfig),
        runs: new PostgresAgentRunRepository(database),
      }
    : {}),
  registry: createRuntimeAgentRegistry(),
});
const server = Bun.serve({
  fetch: app.fetch,
  port,
});

let shutdownPromise: Promise<void> | undefined;

const shutdown = async (): Promise<void> => {
  if (shutdownPromise) {
    return shutdownPromise;
  }

  shutdownPromise = (async () => {
    let exitCode = 0;

    try {
      await server.stop(true);
    } catch (error) {
      exitCode = 1;
      console.error(
        JSON.stringify({
          event: 'api.shutdown.failed',
          message: error instanceof Error ? error.message : 'unknown',
        }),
      );
    }

    try {
      if (database) {
        await database.close();
      }
    } catch (error) {
      exitCode = 1;
      console.error(
        JSON.stringify({
          event: 'api.database.close.failed',
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
