import { describe, expect, test } from 'bun:test';

import { createApp } from './app';

describe('API app', () => {
  test('returns liveness status', async () => {
    const response = await createApp().request('/health/live');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
  });
});
