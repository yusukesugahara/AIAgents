import { describe, expect, test } from 'bun:test';

import {
  loadDataRetentionRuntimeConfig,
  loadGmailPollingRuntimeConfig,
  loadJobEmailAnalysisRuntimeConfig,
  loadJobRuntimeConfig,
} from './index';

describe('operational data retention configuration', () => {
  test('defaults to ninety days and rejects excessive retention', () => {
    expect(loadDataRetentionRuntimeConfig({})).toEqual({
      cleanupIntervalMs: 86_400_000,
      retentionMs: 7_776_000_000,
    });
    expect(() =>
      loadDataRetentionRuntimeConfig({ OPERATIONAL_DATA_RETENTION_DAYS: '3651' }),
    ).toThrow('OPERATIONAL_DATA_RETENTION_DAYS must be at most 3650');
  });
});

describe('Gmail polling runtime configuration', () => {
  test('uses a five-minute interval and fifty-message page by default', () => {
    expect(loadGmailPollingRuntimeConfig({})).toEqual({
      intervalMs: 300_000,
      maxMessages: 100,
      maxResults: 50,
      query: 'in:inbox newer_than:1d',
    });
  });

  test('validates the Gmail polling interval, page size, and query', () => {
    expect(() => loadGmailPollingRuntimeConfig({ GMAIL_POLL_INTERVAL_SECONDS: '0' })).toThrow(
      'GMAIL_POLL_INTERVAL_SECONDS must be a positive integer',
    );
    expect(() => loadGmailPollingRuntimeConfig({ GMAIL_POLL_MAX_RESULTS: '101' })).toThrow(
      'GMAIL_POLL_MAX_RESULTS must be at most 100',
    );
    expect(() => loadGmailPollingRuntimeConfig({ GMAIL_POLL_MAX_MESSAGES: '1001' })).toThrow(
      'GMAIL_POLL_MAX_MESSAGES must be at most 1000',
    );
    expect(() => loadGmailPollingRuntimeConfig({ GMAIL_LOOKBACK_QUERY: '   ' })).toThrow(
      'GMAIL_LOOKBACK_QUERY must contain 1 through 1000 characters',
    );
    expect(
      loadGmailPollingRuntimeConfig({
        GMAIL_LOOKBACK_QUERY: 'in:inbox newer_than:2h',
        GMAIL_POLL_INTERVAL_SECONDS: '600',
        GMAIL_POLL_MAX_MESSAGES: '75',
        GMAIL_POLL_MAX_RESULTS: '25',
      }),
    ).toEqual({
      intervalMs: 600_000,
      maxMessages: 75,
      maxResults: 25,
      query: 'in:inbox newer_than:2h',
    });
  });
});

describe('Job runtime configuration', () => {
  test('uses the documented defaults', () => {
    expect(loadJobRuntimeConfig({})).toEqual({
      concurrency: 2,
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

  test('caps Worker concurrency', () => {
    expect(() => loadJobRuntimeConfig({ AGENT_WORKER_CONCURRENCY: '33' })).toThrow(
      'AGENT_WORKER_CONCURRENCY must be at most 32',
    );
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
