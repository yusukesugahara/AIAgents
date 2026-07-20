import { describe, expect, test } from 'bun:test';

import { loadJobEmailAnalysisRuntimeConfig, loadJobRuntimeConfig } from './index';

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

describe('Job Search Email runtime configuration', () => {
  test('requires an explicitly injected OpenAI key and analysis model', () => {
    expect(() => loadJobEmailAnalysisRuntimeConfig({})).toThrow('OPENAI_API_KEY is required');
    expect(() => loadJobEmailAnalysisRuntimeConfig({ OPENAI_API_KEY: 'test-key' })).toThrow(
      'OPENAI_ANALYSIS_MODEL is required',
    );
    expect(() =>
      loadJobEmailAnalysisRuntimeConfig({
        OPENAI_API_KEY: 'test-key',
        OPENAI_ANALYSIS_MODEL: 'test-model',
      }),
    ).toThrow('OPENAI_REPLY_MODEL is required');
    expect(
      loadJobEmailAnalysisRuntimeConfig({
        OPENAI_API_KEY: 'test-key',
        OPENAI_ANALYSIS_MODEL: 'test-model',
        OPENAI_REPLY_MODEL: 'test-reply-model',
      }),
    ).toEqual({
      openAiApiKey: 'test-key',
      openAiModel: 'test-model',
      openAiReplyModel: 'test-reply-model',
    });
  });
});
