import { describe, expect, test } from 'bun:test';

import { createApp } from './app';

describe('API app', () => {
  test('returns liveness status', async () => {
    const response = await createApp().request('/health/live');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
  });

  test('returns readiness status as not ready when database is missing', async () => {
    const response = await createApp().request('/health/ready');

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: 'not_ready' });
  });

  test('returns readiness status as ready when database is healthy', async () => {
    const response = await createApp({
      database: {
        isReady: async () => true,
      },
    }).request('/health/ready');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
  });

  test('returns readiness status as not ready when database is unhealthy', async () => {
    const response = await createApp({
      database: {
        isReady: async () => false,
      },
    }).request('/health/ready');

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: 'not_ready' });
  });
});
