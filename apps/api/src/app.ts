import type { DatabaseConnection } from '@ai-agents/database';
import { Hono } from 'hono';

export interface ApiAppOptions {
  database?: Pick<DatabaseConnection, 'isReady'>;
}

export function createApp(options: ApiAppOptions = {}): Hono {
  const app = new Hono();

  app.get('/health/live', (context) => context.json({ status: 'ok' }));

  app.get('/health/ready', async (context) => {
    const ready = options.database ? await options.database.isReady() : false;

    if (!ready) {
      return context.json({ status: 'not_ready' }, 503);
    }

    return context.json({ status: 'ok' });
  });

  return app;
}
