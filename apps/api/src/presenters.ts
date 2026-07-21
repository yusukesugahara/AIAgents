import type { AgentJob, AgentRun, AgentRunStep } from '@ai-agents/agent-core';

export function toJobResponse(
  job: AgentJob,
  latestRun: AgentRun | null,
  latestRunSteps: readonly AgentRunStep[] = [],
) {
  return {
    agentId: job.agentId,
    attempts: job.attempts,
    availableAt: toIsoString(job.availableAt),
    completedAt: job.completedAt ? toIsoString(job.completedAt) : null,
    createdAt: toIsoString(job.createdAt),
    errorCode: job.lastErrorCode,
    hasError: job.lastErrorCode !== null || job.lastError !== null,
    id: job.id,
    latestRun: latestRun ? toRunResponse(latestRun, latestRunSteps) : null,
    latestRunId: latestRun?.id ?? null,
    status: job.status,
  };
}

export function toRunResponse(run: AgentRun, steps: readonly AgentRunStep[] = []) {
  return {
    agentId: run.agentId,
    completedAt: run.completedAt ? toIsoString(run.completedAt) : null,
    emailSubject: toSafeEmailSubject(run.emailSubject),
    errorCode: run.errorCode,
    errorDetail: toSafeRunErrorDetail(run.errorCode, run.errorMessage),
    id: run.id,
    jobId: run.jobId,
    startedAt: toIsoString(run.startedAt),
    status: run.status,
    output: toJobSearchEmailOutput(run),
    steps:
      run.agentId === 'job-search-email'
        ? [...steps].sort((left, right) => left.sequence - right.sequence).map(toStepResponse)
        : [],
    triggerType: run.triggerType,
  };
}

function toSafeRunErrorDetail(errorCode: string | null, errorMessage: string | null | undefined) {
  if (typeof errorMessage !== 'string') return null;
  const invalidResponseDetails = new Set([
    'Gmail returned an invalid response',
    'Gmail returned inconsistent message and thread data',
    'Gmail message is missing required content',
    'Gmail message has an invalid date',
    'Gmail message body is invalid',
  ]);
  const invalidRequestDetails = new Set([
    'OpenAI rejected the request',
    'OpenAI structured output schema is invalid',
    'LLM model must not be empty',
    'LLM promptVersion must not be empty',
    'LLM schemaName must not be empty',
    'LLM schemaVersion must not be empty',
    'LLM systemPrompt must not be empty',
    'LLM userInput must not be empty',
    'LLM schema is invalid',
  ]);
  if (errorCode === 'INVALID_RESPONSE' && invalidResponseDetails.has(errorMessage)) {
    return errorMessage;
  }
  if (errorCode === 'INVALID_REQUEST' && invalidRequestDetails.has(errorMessage)) {
    return errorMessage;
  }
  return null;
}

function toJobSearchEmailOutput(run: AgentRun): {
  readonly calendarEventId: string | null;
  readonly draftId: string | null;
  readonly result: string;
} | null {
  if (run.agentId !== 'job-search-email' || !run.output || typeof run.output !== 'object') {
    return null;
  }
  const output = run.output as Record<string, unknown>;
  const result = output.result;
  const draftId = output.draftId;
  const calendarEventId = output.calendarEventId;
  if (
    !isJobSearchEmailResult(result) ||
    !isNullableBoundedString(draftId) ||
    !isNullableBoundedString(calendarEventId)
  ) {
    return null;
  }
  return { calendarEventId, draftId, result };
}

function isJobSearchEmailResult(value: unknown): value is 'completed' | 'needs_review' | 'skipped' {
  return value === 'completed' || value === 'needs_review' || value === 'skipped';
}

function isNullableBoundedString(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && value.length <= 1_024);
}

function toStepResponse(step: AgentRunStep) {
  return {
    completedAt: step.completedAt ? toIsoString(step.completedAt) : null,
    errorCode: step.errorCode,
    output: toSafeStepOutput(step.output),
    sequence: step.sequence,
    startedAt: toIsoString(step.startedAt),
    status: step.status,
    stepName: step.stepName,
  };
}

function toSafeStepOutput(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const output = value as Record<string, unknown>;
  const safeStringKeys = [
    'calendarEventId',
    'category',
    'draftId',
    'emailSubject',
    'gmailMessageId',
    'gmailThreadId',
    'notApplicableReason',
    'outcome',
    'result',
    'reviewReason',
  ] as const;
  const safeBooleanKeys = ['applicable', 'isJobRelated', 'retryable'] as const;
  const safeOutput: Record<string, unknown> = {};
  for (const key of safeStringKeys) {
    const field = output[key];
    if (typeof field === 'string' && field.length <= 1_024) safeOutput[key] = field;
  }
  for (const key of safeBooleanKeys) {
    const field = output[key];
    if (typeof field === 'boolean') safeOutput[key] = field;
  }
  if (
    typeof output.messageCount === 'number' &&
    Number.isSafeInteger(output.messageCount) &&
    output.messageCount >= 0
  ) {
    safeOutput.messageCount = output.messageCount;
  }
  return safeOutput;
}

function toSafeEmailSubject(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const subject = value.replace(/[\u0000-\u001F\u007F]/gu, ' ').trim();
  return subject && subject.length <= 512 ? subject : null;
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
