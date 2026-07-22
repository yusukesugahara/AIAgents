import type { AgentContext } from '@ai-agents/agent-core';
import { AgentDependencyError, defineAgent } from '@ai-agents/agent-core';
import { z } from 'zod';
import { validateAnalysisGrounding } from './analysis-grounding';
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
import { prepareReplyAction, runReplyDraftToolLoop } from './reply-action';
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

export * from './analysis-grounding';
export * from './analysis-normalization';
export * from './evaluation';
export { manifest } from './manifest';
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
          const analysisPayload = JSON.parse(
            buildJobEmailAnalysisInput(thread, message, analysisDefaultTimezone),
          ) as Record<string, unknown>;
          const llmResult = await dependencies.llm.runToolLoop({
            initialToolChoice: 'required',
            maxToolCalls: 2,
            maxTurns: 4,
            model: dependencies.model,
            promptVersion: jobEmailAnalysisPromptVersion,
            requiredToolNames: ['get_email_thread', 'get_agent_context'],
            runId: context.runId,
            schema: jobEmailAnalysisStructuredOutputSchema,
            schemaName: jobEmailAnalysisSchemaName,
            schemaVersion: jobEmailAnalysisSchemaVersion,
            signal: context.signal,
            systemPrompt: `${jobEmailAnalysisSystemPrompt}\n\nYou must call get_email_thread and get_agent_context before returning the analysis schema.`,
            tools: [
              {
                description: 'Get the validated, untrusted Gmail thread to analyze.',
                execute: async () => analysisPayload,
                maxCalls: 1,
                name: 'get_email_thread',
                parameters: emptyFunctionParameters,
                schema: emptyFunctionArgumentsSchema,
              },
              {
                description: 'Get non-secret runtime context needed to interpret the email.',
                execute: async () => ({ defaultTimezone: analysisDefaultTimezone }),
                maxCalls: 1,
                name: 'get_agent_context',
                parameters: emptyFunctionParameters,
                schema: emptyFunctionArgumentsSchema,
              },
            ],
            userInput: 'Use the available tools to analyze the target job-search email thread.',
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
            toolCallCount: llmResult.metadata.toolCalls?.length ?? 0,
            toolNames: llmResult.metadata.toolCalls?.map((toolCall) => toolCall.name) ?? [],
            toolOutcomes: llmResult.metadata.toolCalls?.map((toolCall) => toolCall.outcome) ?? [],
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
      if (!validateAnalysisGrounding(analysis, thread).valid) {
        const output = await saveNeedsReview(dependencies, context, 'analysis_not_grounded');
        return completeTrackedRun(dependencies, context, output, 'analysis_not_grounded');
      }

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
        'CHECK_REPLY_POLICY',
        { gmailMessageId: input.gmailMessageId },
        () => prepareReplyAction(dependencies, input, analysis, message, thread),
        (action) => ({
          applicable: action.kind === 'ready',
          outcome: action.kind,
          ...(action.kind === 'needs_review' ? { reviewReason: action.reason } : {}),
          ...(action.kind === 'not_applicable' ? { notApplicableReason: action.reason } : {}),
        }),
      );
      // Complete every deterministic preflight before allowing the Draft tool to write externally.
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

      // Create/reuse the Calendar event first so its conflict and policy checks are performed
      // immediately before that write. A conflict still prevents any Draft write.
      const calendarResult =
        calendarAction.kind === 'ready'
          ? await trackStep(
              dependencies,
              context,
              'CREATE_CALENDAR_EVENT',
              { gmailMessageId: input.gmailMessageId },
              () => createCalendarEvent(dependencies, context, input, calendarAction),
              (result) => ({
                applicable: true,
                outcome: result.kind,
                ...(result.kind === 'completed'
                  ? { calendarEventId: result.eventId }
                  : { reviewReason: result.reason }),
              }),
            )
          : null;
      if (calendarResult?.kind === 'needs_review') {
        const output = await saveNeedsReview(
          dependencies,
          context,
          calendarResult.reason,
          analysis,
        );
        return completeTrackedRun(dependencies, context, output, calendarResult.reason);
      }
      const calendarEventId = calendarResult?.kind === 'completed' ? calendarResult.eventId : null;

      const draftResult =
        replyAction.kind === 'ready'
          ? await trackStep(
              dependencies,
              context,
              'CREATE_DRAFT',
              { gmailMessageId: input.gmailMessageId },
              () =>
                runReplyDraftToolLoop(
                  dependencies,
                  context,
                  input,
                  analysis,
                  message,
                  thread,
                  replyAction,
                ),
              (result) => ({
                applicable: true,
                outcome: result.kind,
                ...(result.kind === 'completed'
                  ? {
                      draftId: result.draftId,
                      toolCallCount: result.metadata.toolCalls?.length ?? 0,
                      toolNames: result.metadata.toolCalls?.map((toolCall) => toolCall.name) ?? [],
                      toolOutcomes:
                        result.metadata.toolCalls?.map((toolCall) => toolCall.outcome) ?? [],
                      writeStatus: result.writeStatus,
                    }
                  : {
                      reviewReason: result.reason,
                      toolCallCount: result.metadata?.toolCalls?.length ?? 0,
                      toolNames: result.metadata?.toolCalls?.map((toolCall) => toolCall.name) ?? [],
                      toolOutcomes:
                        result.metadata?.toolCalls?.map((toolCall) => toolCall.outcome) ?? [],
                    }),
              }),
            )
          : null;
      if (draftResult?.kind === 'needs_review') {
        const output = await saveNeedsReview(
          dependencies,
          context,
          draftResult.reason,
          analysis,
          null,
          calendarEventId,
        );
        return completeTrackedRun(dependencies, context, output, draftResult.reason);
      }
      const draftId = draftResult?.kind === 'completed' ? draftResult.draftId : null;
      return completeTrackedRun(
        dependencies,
        context,
        completed(analysis, draftId, calendarEventId),
      );
    },
  });
}

const emptyFunctionArgumentsSchema = z.object({}).strict();
const emptyFunctionParameters = {
  additionalProperties: false,
  properties: {},
  required: [],
  type: 'object',
} as const;

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
  draftId: string | null = null,
  calendarEventId: string | null = null,
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
    calendarEventId,
    draftId,
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
