export const defaultTimezone = 'Asia/Tokyo';

export interface JobRuntimeConfig {
  readonly concurrency: number;
  readonly leaseHeartbeatIntervalMs: number;
  readonly lockTimeoutMs: number;
  readonly maxAttempts: number;
  readonly pollIntervalMs: number;
}

export interface JobEmailAnalysisRuntimeConfig {
  readonly openAiApiKey: string;
  readonly openAiModel: string;
  readonly openAiReplyModel: string;
}

export interface GmailPollingRuntimeConfig {
  readonly intervalMs: number;
  readonly maxMessages: number;
  readonly maxResults: number;
  readonly query: string;
}

export interface DataRetentionRuntimeConfig {
  readonly cleanupIntervalMs: number;
  readonly retentionMs: number;
}

export function loadDataRetentionRuntimeConfig(
  environment = process.env,
): DataRetentionRuntimeConfig {
  const retentionDays = readPositiveInteger(
    environment.OPERATIONAL_DATA_RETENTION_DAYS,
    'OPERATIONAL_DATA_RETENTION_DAYS',
    90,
  );
  if (retentionDays > 3_650) {
    throw new Error('OPERATIONAL_DATA_RETENTION_DAYS must be at most 3650');
  }
  return {
    cleanupIntervalMs: 24 * 60 * 60 * 1_000,
    retentionMs: retentionDays * 24 * 60 * 60 * 1_000,
  };
}

export function loadGmailPollingRuntimeConfig(
  environment = process.env,
): GmailPollingRuntimeConfig {
  const intervalSeconds = readPositiveInteger(
    environment.GMAIL_POLL_INTERVAL_SECONDS,
    'GMAIL_POLL_INTERVAL_SECONDS',
    300,
  );
  if (intervalSeconds > Math.floor(Number.MAX_SAFE_INTEGER / 1_000)) {
    throw new Error('GMAIL_POLL_INTERVAL_SECONDS is too large');
  }
  const maxResults = readPositiveInteger(
    environment.GMAIL_POLL_MAX_RESULTS,
    'GMAIL_POLL_MAX_RESULTS',
    50,
  );
  if (maxResults > 100) {
    throw new Error('GMAIL_POLL_MAX_RESULTS must be at most 100');
  }
  const maxMessages = readPositiveInteger(
    environment.GMAIL_POLL_MAX_MESSAGES,
    'GMAIL_POLL_MAX_MESSAGES',
    100,
  );
  if (maxMessages > 1_000) {
    throw new Error('GMAIL_POLL_MAX_MESSAGES must be at most 1000');
  }
  const query = (environment.GMAIL_LOOKBACK_QUERY ?? 'in:inbox newer_than:1d').trim();
  if (!query || query.length > 1_000) {
    throw new Error('GMAIL_LOOKBACK_QUERY must contain 1 through 1000 characters');
  }
  return { intervalMs: intervalSeconds * 1_000, maxMessages, maxResults, query };
}

export function loadJobEmailAnalysisRuntimeConfig(
  environment = process.env,
): JobEmailAnalysisRuntimeConfig {
  const openAiApiKey = environment.OPENAI_API_KEY?.trim();
  const openAiModel = environment.OPENAI_ANALYSIS_MODEL?.trim();
  const openAiReplyModel = environment.OPENAI_REPLY_MODEL?.trim();
  if (!openAiApiKey) {
    throw new Error('OPENAI_API_KEY is required by the Job Search Email Agent');
  }
  if (!openAiModel) {
    throw new Error('OPENAI_ANALYSIS_MODEL is required by the Job Search Email Agent');
  }
  if (!openAiReplyModel) {
    throw new Error('OPENAI_REPLY_MODEL is required by the Job Search Email Agent');
  }
  return { openAiApiKey, openAiModel, openAiReplyModel };
}

export function loadJobRuntimeConfig(environment = process.env): JobRuntimeConfig {
  const lockTimeoutSeconds = readPositiveInteger(
    environment.AGENT_JOB_LOCK_TIMEOUT_SECONDS,
    'AGENT_JOB_LOCK_TIMEOUT_SECONDS',
    60,
  );
  const lockTimeoutMs = lockTimeoutSeconds * 1_000;
  const leaseHeartbeatIntervalMs = readPositiveInteger(
    environment.AGENT_JOB_LEASE_HEARTBEAT_MS,
    'AGENT_JOB_LEASE_HEARTBEAT_MS',
    Math.floor(lockTimeoutMs / 4),
  );

  if (leaseHeartbeatIntervalMs >= lockTimeoutMs) {
    throw new Error('AGENT_JOB_LEASE_HEARTBEAT_MS must be shorter than the lock timeout');
  }

  const concurrency = readPositiveInteger(
    environment.AGENT_WORKER_CONCURRENCY,
    'AGENT_WORKER_CONCURRENCY',
    2,
  );
  if (concurrency > 32) throw new Error('AGENT_WORKER_CONCURRENCY must be at most 32');

  return {
    concurrency,
    leaseHeartbeatIntervalMs,
    lockTimeoutMs,
    maxAttempts: readPositiveInteger(
      environment.AGENT_JOB_MAX_ATTEMPTS,
      'AGENT_JOB_MAX_ATTEMPTS',
      3,
    ),
    pollIntervalMs: readPositiveInteger(
      environment.AGENT_JOB_POLL_INTERVAL_MS,
      'AGENT_JOB_POLL_INTERVAL_MS',
      250,
    ),
  };
}

function readPositiveInteger(value: string | undefined, name: string, fallback: number): number {
  if (value === undefined || value === '') {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }

  return parsed;
}
