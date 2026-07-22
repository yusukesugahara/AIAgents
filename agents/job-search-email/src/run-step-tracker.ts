import type { AgentContext } from '@ai-agents/agent-core';
import { AgentDependencyError, RetryableJobError } from '@ai-agents/agent-core';
import { persistSafely } from './persistence';
import type { JobEmailReviewReason, JobSearchEmailAgentDependencies } from './ports';
import type { JobSearchEmailOutput } from './schemas';

const jobEmailStepSequence = {
  FETCH_EMAIL_THREAD: 10,
  ANALYZE_EMAIL: 20,
  CHECK_REPLY_POLICY: 30,
  CHECK_CALENDAR_POLICY: 40,
  CREATE_CALENDAR_EVENT: 50,
  CREATE_DRAFT: 60,
  COMPLETE: 70,
} as const;

type JobEmailStepName = keyof typeof jobEmailStepSequence;

export async function trackStep<T>(
  dependencies: JobSearchEmailAgentDependencies,
  context: AgentContext,
  stepName: JobEmailStepName,
  input: Record<string, unknown>,
  operation: () => Promise<T>,
  toOutput: (value: T) => Record<string, unknown>,
): Promise<T> {
  const steps = dependencies.steps;
  if (!steps) return operation();
  await persistSafely(
    () =>
      steps.startStep({
        input,
        runId: context.runId,
        sequence: jobEmailStepSequence[stepName],
        startedAt: new Date(),
        stepName,
      }),
    'Agent Run step could not be started',
  );
  try {
    const value = await operation();
    await persistSafely(
      () =>
        steps.completeStep({
          completedAt: new Date(),
          output: toOutput(value),
          runId: context.runId,
          stepName,
        }),
      'Agent Run step could not be completed',
    );
    return value;
  } catch (error) {
    const errorCode = error instanceof AgentDependencyError ? error.code : 'STEP_EXECUTION_FAILED';
    const retryable =
      error instanceof RetryableJobError ||
      (error instanceof AgentDependencyError && error.retryable);
    await persistSafely(
      () =>
        steps.failStep({
          completedAt: new Date(),
          errorCode,
          retryable,
          runId: context.runId,
          stepName,
        }),
      'Agent Run step failure could not be saved',
    );
    throw error;
  }
}

export async function completeTrackedRun(
  dependencies: JobSearchEmailAgentDependencies,
  context: AgentContext,
  output: JobSearchEmailOutput,
  reviewReason?: JobEmailReviewReason,
): Promise<JobSearchEmailOutput> {
  await trackStep(
    dependencies,
    context,
    'COMPLETE',
    {},
    async () => output,
    (result) => ({
      calendarEventId: result.calendarEventId,
      draftId: result.draftId,
      ...(reviewReason ? { reviewReason } : {}),
      result: result.result,
    }),
  );
  return output;
}
