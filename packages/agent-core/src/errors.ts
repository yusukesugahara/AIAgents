export type AgentCoreErrorCode =
  | 'AGENT_ALREADY_REGISTERED'
  | 'AGENT_NOT_FOUND'
  | 'AGENT_INPUT_INVALID'
  | 'AGENT_OUTPUT_INVALID'
  | 'AGENT_TRIGGER_UNSUPPORTED'
  | 'AGENT_EXECUTION_FAILED';

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

export class AgentRunPersistenceError extends RetryableJobError {
  constructor(message: string, options: ErrorOptions = {}) {
    super(message, options);
    this.name = 'AgentRunPersistenceError';
  }
}

export class IdempotencyConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IdempotencyConflictError';
  }
}

export function isRetryableJobError(error: unknown): error is RetryableJobError {
  return error instanceof RetryableJobError;
}
