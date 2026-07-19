import type { DatabaseConnection } from '@ai-agents/database';

export interface WorkerHandle {
  stop(): Promise<void>;
}

export interface WorkerOptions {
  heartbeatIntervalMs?: number;
  database?: Pick<DatabaseConnection, 'isReady' | 'close'>;
}

export async function startWorker(options: WorkerOptions = {}): Promise<WorkerHandle> {
  if (options.database && !(await options.database.isReady())) {
    await options.database.close();
    throw new Error('Database is not ready');
  }

  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? 60_000;
  console.info(JSON.stringify({ event: 'worker.started' }));

  const heartbeat = setInterval(() => {
    console.info(JSON.stringify({ event: 'worker.heartbeat' }));
  }, heartbeatIntervalMs);

  let stopped = false;

  return {
    async stop() {
      if (stopped) {
        return;
      }

      stopped = true;
      clearInterval(heartbeat);
      if (options.database) {
        await options.database.close();
      }
      console.info(JSON.stringify({ event: 'worker.stopped' }));
    },
  };
}
