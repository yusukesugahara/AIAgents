import { Hono } from 'hono';

export function createApp(): Hono {
  const app = new Hono();

  app.get('/health/live', (context) => context.json({ status: 'ok' }));

  return app;
}
