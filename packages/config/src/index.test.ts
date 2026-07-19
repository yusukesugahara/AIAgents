import { describe, expect, test } from 'bun:test';

import { loadJobRuntimeConfig } from './index';

describe('Job runtime configuration', () => {
  test('uses the documented defaults', () => {
    expect(loadJobRuntimeConfig({})).toEqual({
      leaseHeartbeatIntervalMs: 15_000,
      lockTimeoutMs: 60_000,
      maxAttempts: 3,
      pollIntervalMs: 250,
    });
  });

  test('rejects an invalid lease heartbeat configuration', () => {
    expect(() =>
      loadJobRuntimeConfig({
        AGENT_JOB_LEASE_HEARTBEAT_MS: '60000',
        AGENT_JOB_LOCK_TIMEOUT_SECONDS: '60',
      }),
    ).toThrow('AGENT_JOB_LEASE_HEARTBEAT_MS must be shorter than the lock timeout');
  });
});
