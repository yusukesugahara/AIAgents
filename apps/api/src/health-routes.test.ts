import { describe, expect, test } from 'bun:test';
import { createApp } from './app';

const logger = { error() {}, info() {} };

describe('API health routes', () => {
  test('returns liveness status', async () => {
    const response = await createApp({ logger }).request('/health/live');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
  });

  test('returns not ready when the database is missing', async () => {
    const response = await createApp({ logger }).request('/health/ready');

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: 'not_ready' });
  });

  test('returns ready when the database is healthy', async () => {
    const response = await createApp({
      database: { isReady: async () => true },
      logger,
    }).request('/health/ready');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
  });

  test('returns not ready when required OAuth is unavailable', async () => {
    const response = await createApp({
      database: { isReady: async () => true },
      logger,
      oauthRequired: true,
    }).request('/health/ready');

    expect(response.status).toBe(503);
  });
});
