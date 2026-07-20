export const defaultTimezone = 'Asia/Tokyo';

export interface JobRuntimeConfig {
  readonly leaseHeartbeatIntervalMs: number;
  readonly lockTimeoutMs: number;
  readonly maxAttempts: number;
  readonly pollIntervalMs: number;
}

export interface JobEmailAnalysisRuntimeConfig {
  readonly openAiApiKey: string;
  readonly openAiModel: string;
}

export function loadJobEmailAnalysisRuntimeConfig(
  environment = process.env,
): JobEmailAnalysisRuntimeConfig {
  const openAiApiKey = environment.OPENAI_API_KEY?.trim();
  const openAiModel = environment.OPENAI_ANALYSIS_MODEL?.trim();
  if (!openAiApiKey) {
    throw new Error('OPENAI_API_KEY is required by the Job Search Email Agent');
  }
  if (!openAiModel) {
    throw new Error('OPENAI_ANALYSIS_MODEL is required by the Job Search Email Agent');
  }
  return { openAiApiKey, openAiModel };
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

  return {
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
