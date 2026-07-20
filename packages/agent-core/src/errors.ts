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

export type AgentDependencyErrorCode =
  | 'AUTHENTICATION_REQUIRED'
  | 'RATE_LIMITED'
  | 'TEMPORARY_UNAVAILABLE'
  | 'INVALID_REQUEST'
  | 'CONFLICT'
  | 'PERMISSION_DENIED'
  | 'NOT_FOUND'
  | 'INVALID_RESPONSE'
  | 'UNKNOWN';

/** An error returned by a service that an Agent depends on, such as Gmail or an LLM provider. */
export class AgentDependencyError extends Error {
  constructor(
    readonly code: AgentDependencyErrorCode,
    readonly retryable: boolean,
    message: string,
    options: ErrorOptions = {},
  ) {
    super(message, options);
    this.name = 'AgentDependencyError';
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

export function isRetryableJobError(
  error: unknown,
): error is RetryableJobError | AgentDependencyError {
  return (
    error instanceof RetryableJobError || (error instanceof AgentDependencyError && error.retryable)
  );
}
