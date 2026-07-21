import { describe, expect, test } from 'bun:test';

import {
  loadGmailPollingRuntimeConfig,
  loadJobEmailAnalysisRuntimeConfig,
  loadJobRuntimeConfig,
} from './index';

describe('Gmail polling runtime configuration', () => {
  test('uses a five-minute interval and fifty-message page by default', () => {
    expect(loadGmailPollingRuntimeConfig({})).toEqual({
      intervalMs: 300_000,
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
    expect(() => loadGmailPollingRuntimeConfig({ GMAIL_LOOKBACK_QUERY: '   ' })).toThrow(
      'GMAIL_LOOKBACK_QUERY must contain 1 through 1000 characters',
    );
    expect(
      loadGmailPollingRuntimeConfig({
        GMAIL_LOOKBACK_QUERY: 'in:inbox newer_than:2h',
        GMAIL_POLL_INTERVAL_SECONDS: '600',
        GMAIL_POLL_MAX_RESULTS: '25',
      }),
    ).toEqual({
      intervalMs: 600_000,
      maxResults: 25,
      query: 'in:inbox newer_than:2h',
    });
  });
});

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
