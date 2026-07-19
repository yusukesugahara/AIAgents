import { AgentRegistry, AgentRunner } from '@ai-agents/agent-core';
import {
  createDatabaseConnection,
  type DatabaseConnection,
  PostgresAgentRunRepository,
  PostgresJobQueue,
} from '@ai-agents/database';
import { startWorker } from './worker';

let database: DatabaseConnection | undefined;

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

const worker = await startWorker(
  database
    ? {
        database,
        queue: new PostgresJobQueue(database),
        runner: new AgentRunner({
          registry: new AgentRegistry(),
          repository: new PostgresAgentRunRepository(database),
        }),
      }
    : {},
);

const shutdown = async (): Promise<void> => {
  await worker.stop();
  process.exit(0);
};

process.once('SIGINT', () => {
  void shutdown();
});

process.once('SIGTERM', () => {
  void shutdown();
});
