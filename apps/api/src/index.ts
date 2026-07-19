import {
  createDatabaseConnection,
  type DatabaseConnection,
  PostgresAgentRunRepository,
  PostgresJobQueue,
} from '@ai-agents/database';
import { createRuntimeAgentRegistry } from '@ai-agents/echo-agent';
import { createApp } from './app';

const port = Number(process.env.APP_PORT ?? 4000);
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

const app = createApp(
  database
    ? {
        database,
        queue: new PostgresJobQueue(database),
        registry: createRuntimeAgentRegistry(),
        runs: new PostgresAgentRunRepository(database),
      }
    : {},
);
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
      if (database) {
        await database.close();
      }
    } catch (error) {
      exitCode = 1;
      console.error(
        JSON.stringify({
          event: 'api.shutdown.failed',
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
