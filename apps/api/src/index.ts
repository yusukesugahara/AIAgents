import { createApp } from './app';

const port = Number(process.env.APP_PORT ?? 4000);

console.info(JSON.stringify({ event: 'api.starting', port }));

Bun.serve({
  fetch: createApp().fetch,
  port,
});
