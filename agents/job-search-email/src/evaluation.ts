import type { EmailThread } from '@ai-agents/connector-google';
import { validateAnalysisGrounding } from './analysis-grounding';
import type { JobEmailAnalysis } from './schemas';

export interface JobEmailAnalysisEvaluation {
  readonly exactMatchRate: number;
  readonly failedFields: readonly string[];
  readonly grounded: boolean;
  readonly passed: boolean;
}

/** Deterministic scorer used by curated fixtures and by optional real-model E2E evaluation. */
export function evaluateJobEmailAnalysis(
  expected: JobEmailAnalysis,
  actual: JobEmailAnalysis,
  thread: EmailThread,
): JobEmailAnalysisEvaluation {
  const fields = [
    ['isJobRelated', expected.isJobRelated, actual.isJobRelated],
    ['category', expected.category, actual.category],
    ['needsReply', expected.needsReply, actual.needsReply],
    ['replyIntent', expected.replyIntent, actual.replyIntent],
    ['meeting.isConfirmed', expected.meeting.isConfirmed, actual.meeting.isConfirmed],
    ['meeting.urlType', expected.meeting.urlType, actual.meeting.urlType],
  ] as const;
  const failedFields = fields
    .filter(([, expectedValue, actualValue]) => expectedValue !== actualValue)
    .map(([name]) => name);
  const grounded = validateAnalysisGrounding(actual, thread).valid;
  const exactMatchRate = (fields.length - failedFields.length) / fields.length;
  return {
    exactMatchRate,
    failedFields,
    grounded,
    passed: grounded && failedFields.length === 0,
  };
}
