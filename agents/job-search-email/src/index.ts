import type { AgentContext } from '@ai-agents/agent-core';
import { AgentDependencyError, defineAgent } from '@ai-agents/agent-core';
import { normalizeJobEmailAnalysis } from './analysis-normalization';
import { createCalendarEvent, prepareCalendarAction } from './calendar-action';
import { manifest } from './manifest';
import { persistResult, persistSafely } from './persistence';
import type { JobEmailReviewReason, JobSearchEmailAgentDependencies } from './ports';
import {
  buildJobEmailAnalysisInput,
  jobEmailAnalysisPromptVersion,
  jobEmailAnalysisSchemaName,
  jobEmailAnalysisSchemaVersion,
  jobEmailAnalysisSystemPrompt,
  jobEmailDefaultTimezone,
} from './prompt';
import { createDraft, prepareReplyAction } from './reply-action';
import { completeTrackedRun, trackStep } from './run-step-tracker';
import {
  type JobEmailAnalysis,
  type JobSearchEmailOutput,
  jobEmailAnalysisSchema,
  jobEmailAnalysisStructuredOutputSchema,
  jobSearchEmailInputSchema,
  jobSearchEmailOutputSchema,
} from './schemas';
import { isValidIanaTimeZone } from './validation';

export { manifest } from './manifest';
export * from './analysis-normalization';
export * from './ports';
export * from './prompt';
export * from './scheduled-gmail-poll';
export * from './schemas';

export function createJobSearchEmailAgent(dependencies: JobSearchEmailAgentDependencies) {
  if (!dependencies.model.trim()) {
    throw new Error('OPENAI_ANALYSIS_MODEL is required');
  }
  if (!dependencies.replyModel.trim()) {
    throw new Error('OPENAI_REPLY_MODEL is required');
  }

  return defineAgent({
    manifest,
    inputSchema: jobSearchEmailInputSchema,
    outputSchema: jobSearchEmailOutputSchema,
    async run(context, input) {
      const { message, thread } = await trackStep(
        dependencies,
        context,
        'FETCH_EMAIL_THREAD',
        { gmailMessageId: input.gmailMessageId, gmailThreadId: input.gmailThreadId },
        async () => {
          const [message, thread] = await Promise.all([
            dependencies.gmail.getMessage({
              googleConnectionId: input.googleConnectionId,
              gmailMessageId: input.gmailMessageId,
            }),
            dependencies.gmail.getThread({
              googleConnectionId: input.googleConnectionId,
              gmailThreadId: input.gmailThreadId,
            }),
          ]);
          if (
            message.id !== input.gmailMessageId ||
            message.threadId !== input.gmailThreadId ||
            thread.id !== input.gmailThreadId ||
            !thread.messages.some((threadMessage) => threadMessage.id === input.gmailMessageId)
          ) {
            throw new AgentDependencyError(
              'INVALID_RESPONSE',
              false,
              'Gmail returned inconsistent message and thread data',
            );
          }
          return { message, thread };
        },
        ({ message, thread }) => ({
          emailSubject: message.subject.slice(0, 512),
          gmailMessageId: message.id,
          gmailThreadId: thread.id,
          messageCount: thread.messages.length,
        }),
      );

      const { calendarSettings, llmResult } = await trackStep(
        dependencies,
        context,
        'ANALYZE_EMAIL',
        { gmailMessageId: input.gmailMessageId, gmailThreadId: input.gmailThreadId },
        async () => {
          const calendarSettings = await persistResult(
            () => dependencies.settings.getCalendarSettings(input.googleConnectionId),
            'Calendar settings could not be loaded',
          );
          const analysisDefaultTimezone =
            calendarSettings && isValidIanaTimeZone(calendarSettings.timezone)
              ? calendarSettings.timezone
              : jobEmailDefaultTimezone;
          const llmResult = await dependencies.llm.generateStructured({
            model: dependencies.model,
            promptVersion: jobEmailAnalysisPromptVersion,
            runId: context.runId,
            schema: jobEmailAnalysisStructuredOutputSchema,
            schemaName: jobEmailAnalysisSchemaName,
            schemaVersion: jobEmailAnalysisSchemaVersion,
            signal: context.signal,
            systemPrompt: jobEmailAnalysisSystemPrompt,
            userInput: buildJobEmailAnalysisInput(thread, message, analysisDefaultTimezone),
          });
          return { calendarSettings, llmResult };
        },
        ({ llmResult }) => {
          const parsedAnalysis =
            llmResult.status === 'completed'
              ? jobEmailAnalysisSchema.safeParse(llmResult.data)
              : null;
          return {
            ...(parsedAnalysis?.success
              ? {
                  category: parsedAnalysis.data.category,
                  isJobRelated: parsedAnalysis.data.isJobRelated,
                }
              : {}),
            outcome: llmResult.status,
          };
        },
      );

      if (llmResult.status === 'needs_review') {
        const output = await saveNeedsReview(
          dependencies,
          context,
          llmResult.reason === 'refusal' ? 'llm_refusal' : 'llm_invalid_output',
        );
        return completeTrackedRun(
          dependencies,
          context,
          output,
          llmResult.reason === 'refusal' ? 'llm_refusal' : 'llm_invalid_output',
        );
      }

      const validatedAnalysis = jobEmailAnalysisSchema.safeParse(llmResult.data);
      if (!validatedAnalysis.success) {
        const output = await saveNeedsReview(dependencies, context, 'llm_invalid_output');
        return completeTrackedRun(dependencies, context, output, 'llm_invalid_output');
      }
      const analysis = normalizeJobEmailAnalysis(validatedAnalysis.data);

      await persistSafely(
        () =>
          dependencies.analyses.saveAnalysis({
            analysis,
            googleConnectionId: input.googleConnectionId,
            gmailMessageId: input.gmailMessageId,
            gmailThreadId: input.gmailThreadId,
            metadata: llmResult.metadata,
            runId: context.runId,
          }),
        'Email analysis could not be saved',
      );

      if (!analysis.isJobRelated) {
        return completeTrackedRun(dependencies, context, {
          analysis,
          calendarEventId: null,
          draftId: null,
          result: 'skipped' as const,
        });
      }

      const replyAction = await trackStep(
        dependencies,
        context,
        'GENERATE_REPLY',
        { gmailMessageId: input.gmailMessageId },
        () => prepareReplyAction(dependencies, context, input, analysis, message, thread),
        (action) => ({
          applicable: action.kind === 'ready',
          outcome: action.kind,
          ...(action.kind === 'needs_review' ? { reviewReason: action.reason } : {}),
          ...(action.kind === 'not_applicable' ? { notApplicableReason: action.reason } : {}),
        }),
      );
      // Keep the conflict check as close as possible to the external-write boundary because
      // reply generation can be comparatively slow.
      const calendarAction = await trackStep(
        dependencies,
        context,
        'CHECK_CALENDAR_POLICY',
        { gmailMessageId: input.gmailMessageId },
        () => prepareCalendarAction(dependencies, input, analysis, calendarSettings),
        (action) => ({
          applicable: action.kind === 'ready',
          outcome: action.kind,
          ...(action.kind === 'needs_review' ? { reviewReason: action.reason } : {}),
        }),
      );
      const reviewReason =
        calendarAction.kind === 'needs_review'
          ? calendarAction.reason
          : replyAction.kind === 'needs_review'
            ? replyAction.reason
            : null;
      if (reviewReason) {
        const output = await saveNeedsReview(dependencies, context, reviewReason, analysis);
        return completeTrackedRun(dependencies, context, output, reviewReason);
      }

      const draftId =
        replyAction.kind === 'ready'
          ? await trackStep(
              dependencies,
              context,
              'CREATE_DRAFT',
              { gmailMessageId: input.gmailMessageId },
              () => createDraft(dependencies, context, input, replyAction),
              (createdDraftId) => ({ applicable: true, draftId: createdDraftId }),
            )
          : null;
      const calendarEventId =
        calendarAction.kind === 'ready'
          ? await trackStep(
              dependencies,
              context,
              'CREATE_CALENDAR_EVENT',
              { gmailMessageId: input.gmailMessageId },
              () => createCalendarEvent(dependencies, context, input, calendarAction),
              (createdCalendarEventId) => ({
                applicable: true,
                calendarEventId: createdCalendarEventId,
              }),
            )
          : null;
      return completeTrackedRun(
        dependencies,
        context,
        completed(analysis, draftId, calendarEventId),
      );
    },
  });
}

export const jobSearchEmailCatalogAgent = defineAgent({
  manifest,
  inputSchema: jobSearchEmailInputSchema,
  outputSchema: jobSearchEmailOutputSchema,
  async run() {
    throw new AgentDependencyError(
      'UNKNOWN',
      false,
      'Job Search Email Agent execution dependencies are unavailable',
    );
  },
});

async function saveNeedsReview(
  dependencies: JobSearchEmailAgentDependencies,
  context: AgentContext,
  reason: JobEmailReviewReason,
  analysis: JobEmailAnalysis | null = null,
): Promise<JobSearchEmailOutput> {
  await persistSafely(
    () =>
      dependencies.reviews.createReviewRequest({
        agentId: manifest.id,
        jobId: context.jobId,
        reason,
        runId: context.runId,
      }),
    'Review request could not be saved',
  );
  return {
    analysis,
    calendarEventId: null,
    draftId: null,
    result: 'needs_review' as const,
  };
}

function completed(
  analysis: JobEmailAnalysis,
  draftId: string | null = null,
  calendarEventId: string | null = null,
): JobSearchEmailOutput {
  return {
    analysis,
    calendarEventId,
    draftId,
    result: 'completed' as const,
  };
}
