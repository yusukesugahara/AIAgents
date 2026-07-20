import type { Hono } from 'hono';
import type { ApiAppOptions, ApiEnvironment } from '../api-types';

export function registerHealthRoutes(app: Hono<ApiEnvironment>, options: ApiAppOptions): void {
  app.get('/health/live', (context) => context.json({ status: 'ok' }));
  app.get('/health/ready', async (context) => {
    const databaseReady = options.database
      ? options.database.isSchemaReady
        ? await options.database.isSchemaReady()
        : await options.database.isReady()
      : false;
    const ready = databaseReady && (!options.oauthRequired || options.googleOAuth !== undefined);
    return ready ? context.json({ status: 'ok' }) : context.json({ status: 'not_ready' }, 503);
  });
}
