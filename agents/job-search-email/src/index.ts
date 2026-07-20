import type { AgentContext } from '@ai-agents/agent-core';
import { AgentDependencyError, defineAgent } from '@ai-agents/agent-core';
import { manifest } from './manifest';
import type { JobEmailReviewReason, JobSearchEmailAgentDependencies } from './ports';
import {
  buildJobEmailAnalysisInput,
  jobEmailAnalysisPromptVersion,
  jobEmailAnalysisSchemaName,
  jobEmailAnalysisSchemaVersion,
  jobEmailAnalysisSystemPrompt,
} from './prompt';
import {
  jobEmailAnalysisSchema,
  jobSearchEmailInputSchema,
  jobSearchEmailOutputSchema,
} from './schemas';

export { manifest } from './manifest';
export * from './ports';
export * from './prompt';
export * from './schemas';

export function createJobSearchEmailAgent(dependencies: JobSearchEmailAgentDependencies) {
  if (!dependencies.model.trim()) {
    throw new Error('OPENAI_ANALYSIS_MODEL is required');
  }

  return defineAgent({
    manifest,
    inputSchema: jobSearchEmailInputSchema,
    outputSchema: jobSearchEmailOutputSchema,
    async run(context, input) {
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

      const llmResult = await dependencies.llm.generateStructured({
        model: dependencies.model,
        promptVersion: jobEmailAnalysisPromptVersion,
        runId: context.runId,
        schema: jobEmailAnalysisSchema,
        schemaName: jobEmailAnalysisSchemaName,
        schemaVersion: jobEmailAnalysisSchemaVersion,
        signal: context.signal,
        systemPrompt: jobEmailAnalysisSystemPrompt,
        userInput: buildJobEmailAnalysisInput(thread, message),
      });

      if (llmResult.status === 'needs_review') {
        return saveNeedsReview(
          dependencies,
          context,
          llmResult.reason === 'refusal' ? 'llm_refusal' : 'llm_invalid_output',
        );
      }

      const validatedAnalysis = jobEmailAnalysisSchema.safeParse(llmResult.data);
      if (!validatedAnalysis.success) {
        return saveNeedsReview(dependencies, context, 'llm_invalid_output');
      }
      const analysis = validatedAnalysis.data;

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

      return {
        analysis,
        calendarEventId: null,
        draftId: null,
        result: analysis.isJobRelated ? ('completed' as const) : ('skipped' as const),
      };
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
): Promise<{
  analysis: null;
  calendarEventId: null;
  draftId: null;
  result: 'needs_review';
}> {
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
    analysis: null,
    calendarEventId: null,
    draftId: null,
    result: 'needs_review' as const,
  };
}

async function persistSafely(operation: () => Promise<void>, message: string): Promise<void> {
  try {
    await operation();
  } catch (error) {
    if (error instanceof AgentDependencyError) {
      throw error;
    }
    throw new AgentDependencyError('TEMPORARY_UNAVAILABLE', true, message, { cause: error });
  }
}
