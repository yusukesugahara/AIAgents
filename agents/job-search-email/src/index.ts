import { createHash } from 'node:crypto';
import type { AgentContext } from '@ai-agents/agent-core';
import { AgentDependencyError, defineAgent } from '@ai-agents/agent-core';
import type { EmailThread } from '@ai-agents/connector-google';
import { manifest } from './manifest';
import type { JobEmailReviewReason, JobSearchEmailAgentDependencies } from './ports';
import {
  buildJobEmailAnalysisInput,
  buildJobEmailReplyInput,
  jobEmailAnalysisPromptVersion,
  jobEmailAnalysisSchemaName,
  jobEmailAnalysisSchemaVersion,
  jobEmailAnalysisSystemPrompt,
  jobEmailDraftPolicyVersion,
  jobEmailReplyPromptVersion,
  jobEmailReplySchemaName,
  jobEmailReplySchemaVersion,
  jobEmailReplySystemPrompt,
} from './prompt';
import {
  generatedReplySchema,
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
  if (!dependencies.replyModel.trim()) {
    throw new Error('OPENAI_REPLY_MODEL is required');
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

      if (!analysis.isJobRelated) {
        return { analysis, calendarEventId: null, draftId: null, result: 'skipped' as const };
      }
      if (!analysis.needsReply) {
        return completed(analysis);
      }
      const settingsRepository = dependencies.settings;
      const draftRepository = dependencies.drafts;
      const gmailDraftWriter = dependencies.gmailDrafts;
      const replyModel = dependencies.replyModel;

      const settings = await persistResult(
        () => settingsRepository.getReplySettings(input.googleConnectionId),
        'Reply settings could not be loaded',
      );
      if (!settings) {
        return saveNeedsReview(dependencies, context, 'reply_settings_missing', analysis);
      }
      if (!settings.createDrafts) {
        return completed(analysis);
      }
      if (!settings.userName) {
        return saveNeedsReview(dependencies, context, 'reply_settings_missing', analysis);
      }
      if (analysis.confidence < settings.draftConfidenceThreshold) {
        return saveNeedsReview(dependencies, context, 'reply_analysis_low_confidence', analysis);
      }
      if (analysis.missingRequiredInformation.length > 0) {
        return saveNeedsReview(dependencies, context, 'reply_information_missing', analysis);
      }
      if (!isLatestReplyTarget(thread, message.id, settings.googleEmail)) {
        return saveNeedsReview(dependencies, context, 'reply_target_stale', analysis);
      }
      const recipient = extractAddress(message.replyTo ?? '') ?? extractAddress(message.from);
      if (
        !recipient ||
        !message.messageId ||
        !isMessageId(message.messageId) ||
        !isSafeHeaderValue(message.subject)
      ) {
        return saveNeedsReview(dependencies, context, 'reply_headers_invalid', analysis);
      }

      const replyResult = await dependencies.llm.generateStructured({
        model: replyModel,
        promptVersion: jobEmailReplyPromptVersion,
        runId: context.runId,
        schema: generatedReplySchema,
        schemaName: jobEmailReplySchemaName,
        schemaVersion: jobEmailReplySchemaVersion,
        signal: context.signal,
        systemPrompt: jobEmailReplySystemPrompt,
        userInput: buildJobEmailReplyInput({
          analysis,
          signature: settings.emailSignature,
          target: message,
          thread,
          userName: settings.userName,
        }),
      });
      if (replyResult.status === 'needs_review') {
        return saveNeedsReview(
          dependencies,
          context,
          replyResult.reason === 'refusal' ? 'reply_llm_refusal' : 'reply_llm_invalid_output',
          analysis,
        );
      }
      const reply = generatedReplySchema.safeParse(replyResult.data);
      if (!reply.success) {
        return saveNeedsReview(dependencies, context, 'reply_llm_invalid_output', analysis);
      }
      if (reply.data.confidence < settings.draftConfidenceThreshold) {
        return saveNeedsReview(dependencies, context, 'reply_low_confidence', analysis);
      }
      if (reply.data.warnings.length > 0) {
        return saveNeedsReview(dependencies, context, 'reply_warnings', analysis);
      }

      const currentThread = await dependencies.gmail.getThread({
        googleConnectionId: input.googleConnectionId,
        gmailThreadId: input.gmailThreadId,
      });
      if (
        currentThread.id !== input.gmailThreadId ||
        !isLatestReplyTarget(currentThread, message.id, settings.googleEmail)
      ) {
        return saveNeedsReview(dependencies, context, 'reply_target_stale', analysis);
      }

      const idempotencyKey = `gmail-draft:${input.googleConnectionId}:${input.gmailMessageId}:${jobEmailDraftPolicyVersion}`;
      const reservation = await persistResult(
        () =>
          draftRepository.reserve({
            googleConnectionId: input.googleConnectionId,
            gmailMessageId: input.gmailMessageId,
            gmailThreadId: input.gmailThreadId,
            idempotencyKey,
            jobId: context.jobId,
            runId: context.runId,
          }),
        'Draft reservation could not be saved',
      );
      if (reservation.status === 'completed' && reservation.draftId) {
        return completed(analysis, reservation.draftId);
      }
      const existing = await gmailDraftWriter.findReplyDraft({
        googleConnectionId: input.googleConnectionId,
        gmailThreadId: input.gmailThreadId,
        idempotencyKey,
      });
      const gmailDraft =
        existing ??
        (await gmailDraftWriter.createReplyDraft({
          body: reply.data.body,
          from: settings.googleEmail,
          gmailThreadId: input.gmailThreadId,
          googleConnectionId: input.googleConnectionId,
          idempotencyKey,
          inReplyTo: message.messageId,
          references: message.references,
          subject: message.subject,
          to: recipient,
        }));
      await persistSafely(
        () =>
          draftRepository.complete({
            gmailDraft,
            idempotencyKey,
            jobId: context.jobId,
            replyBodyHash: createHash('sha256').update(reply.data.body).digest('hex'),
            runId: context.runId,
          }),
        'Draft history could not be saved',
      );

      return completed(analysis, gmailDraft.draftId);
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
  analysis: import('./schemas').JobEmailAnalysis | null = null,
): Promise<{
  analysis: import('./schemas').JobEmailAnalysis | null;
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
    analysis,
    calendarEventId: null,
    draftId: null,
    result: 'needs_review' as const,
  };
}

function completed(analysis: import('./schemas').JobEmailAnalysis, draftId: string | null = null) {
  return {
    analysis,
    calendarEventId: null,
    draftId,
    result: 'completed' as const,
  };
}

function extractAddress(value: string): string | null {
  const candidate = /<([^<>\s@]+@[^<>\s@]+)>/u.exec(value)?.[1] ?? value.trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(candidate) ? candidate.toLowerCase() : null;
}

function isMessageId(value: string): boolean {
  return /^<[^<>\r\n]+>$/u.test(value) && Buffer.byteLength(value, 'utf8') <= 512;
}

function isSafeHeaderValue(value: string): boolean {
  return Boolean(value.trim()) && !/[\r\n]/u.test(value);
}

function isLatestReplyTarget(
  thread: EmailThread,
  targetMessageId: string,
  userEmail: string,
): boolean {
  const latestMessage = [...thread.messages]
    .sort(
      (left, right) =>
        left.sentAt.getTime() - right.sentAt.getTime() || left.id.localeCompare(right.id),
    )
    .at(-1);
  return (
    latestMessage?.id === targetMessageId &&
    extractAddress(latestMessage.from) !== userEmail.toLowerCase()
  );
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

async function persistResult<T>(operation: () => Promise<T>, message: string): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof AgentDependencyError) throw error;
    throw new AgentDependencyError('TEMPORARY_UNAVAILABLE', true, message, { cause: error });
  }
}
