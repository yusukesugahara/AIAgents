export type AgentCoreErrorCode =
  | 'AGENT_ALREADY_REGISTERED'
  | 'AGENT_NOT_FOUND'
  | 'AGENT_INPUT_INVALID'
  | 'AGENT_OUTPUT_INVALID'
  | 'AGENT_EXECUTION_FAILED'
  | 'AGENT_RUN_PERSISTENCE_FAILED';

export class AgentCoreError extends Error {
  constructor(
    readonly code: AgentCoreErrorCode,
    message: string,
    options: ErrorOptions = {},
  ) {
    super(message, options);
    this.name = 'AgentCoreError';
  }
}

export class RetryableJobError extends Error {
  readonly retryable = true;

  constructor(message: string, options: ErrorOptions = {}) {
    super(message, options);
    this.name = 'RetryableJobError';
  }
}

export function isRetryableJobError(error: unknown): error is RetryableJobError {
  return error instanceof RetryableJobError;
}
