import { createHash } from 'node:crypto';
import type { AgentContext } from '@ai-agents/agent-core';
import type { CreatedGmailDraft, EmailMessage, EmailThread } from '@ai-agents/connector-google';
import { persistResult, persistSafely } from './persistence';
import type {
  JobEmailReplySettings,
  JobEmailReviewReason,
  JobSearchEmailAgentDependencies,
} from './ports';
import {
  buildJobEmailReplyInput,
  jobEmailDraftPolicyVersion,
  jobEmailReplyPromptVersion,
  jobEmailReplySchemaName,
  jobEmailReplySchemaVersion,
  jobEmailReplySystemPrompt,
} from './prompt';
import type { JobEmailAnalysis, JobSearchEmailInput } from './schemas';
import { generatedReplySchema } from './schemas';
import { extractAddress, isLatestReplyTarget, isMessageId, isSafeHeaderValue } from './validation';

export type ReplyAction =
  | { readonly kind: 'not_applicable' }
  | { readonly kind: 'needs_review'; readonly reason: JobEmailReviewReason }
  | {
      readonly body: string;
      readonly idempotencyKey: string;
      readonly kind: 'ready';
      readonly recipient: string;
      readonly settings: JobEmailReplySettings;
      readonly target: {
        readonly messageId: string;
        readonly references: readonly string[];
        readonly subject: string;
      };
    };

export async function prepareReplyAction(
  dependencies: JobSearchEmailAgentDependencies,
  context: AgentContext,
  input: JobSearchEmailInput,
  analysis: JobEmailAnalysis,
  message: EmailMessage,
  thread: EmailThread,
): Promise<ReplyAction> {
  if (!analysis.needsReply) return { kind: 'not_applicable' };
  const settings = await persistResult(
    () => dependencies.settings.getReplySettings(input.googleConnectionId),
    'Reply settings could not be loaded',
  );
  if (!settings) return { kind: 'needs_review', reason: 'reply_settings_missing' };
  if (!settings.createDrafts) return { kind: 'not_applicable' };
  if (!settings.userName) return { kind: 'needs_review', reason: 'reply_settings_missing' };
  if (analysis.confidence < settings.draftConfidenceThreshold) {
    return { kind: 'needs_review', reason: 'reply_analysis_low_confidence' };
  }
  if (analysis.missingRequiredInformation.length > 0) {
    return { kind: 'needs_review', reason: 'reply_information_missing' };
  }
  if (!isLatestReplyTarget(thread, message.id, settings.googleEmail)) {
    return { kind: 'needs_review', reason: 'reply_target_stale' };
  }
  const recipient = extractAddress(message.replyTo ?? '') ?? extractAddress(message.from);
  if (
    !recipient ||
    !message.messageId ||
    !isMessageId(message.messageId) ||
    !isSafeHeaderValue(message.subject)
  ) {
    return { kind: 'needs_review', reason: 'reply_headers_invalid' };
  }
  const replyResult = await dependencies.llm.generateStructured({
    model: dependencies.replyModel,
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
    return {
      kind: 'needs_review',
      reason: replyResult.reason === 'refusal' ? 'reply_llm_refusal' : 'reply_llm_invalid_output',
    };
  }
  const reply = generatedReplySchema.safeParse(replyResult.data);
  if (!reply.success) return { kind: 'needs_review', reason: 'reply_llm_invalid_output' };
  if (reply.data.confidence < settings.draftConfidenceThreshold) {
    return { kind: 'needs_review', reason: 'reply_low_confidence' };
  }
  if (reply.data.warnings.length > 0) return { kind: 'needs_review', reason: 'reply_warnings' };
  const currentThread = await dependencies.gmail.getThread({
    googleConnectionId: input.googleConnectionId,
    gmailThreadId: input.gmailThreadId,
  });
  if (
    currentThread.id !== input.gmailThreadId ||
    !isLatestReplyTarget(currentThread, message.id, settings.googleEmail)
  ) {
    return { kind: 'needs_review', reason: 'reply_target_stale' };
  }
  return {
    body: reply.data.body,
    idempotencyKey: `gmail-draft:${input.googleConnectionId}:${input.gmailMessageId}:${jobEmailDraftPolicyVersion}`,
    kind: 'ready',
    recipient,
    settings,
    target: {
      messageId: message.messageId,
      references: message.references,
      subject: message.subject,
    },
  };
}

export async function createDraft(
  dependencies: JobSearchEmailAgentDependencies,
  context: AgentContext,
  input: JobSearchEmailInput,
  action: Extract<ReplyAction, { readonly kind: 'ready' }>,
): Promise<string> {
  const reservation = await persistResult(
    () =>
      dependencies.drafts.reserve({
        googleConnectionId: input.googleConnectionId,
        gmailMessageId: input.gmailMessageId,
        gmailThreadId: input.gmailThreadId,
        idempotencyKey: action.idempotencyKey,
        jobId: context.jobId,
        runId: context.runId,
      }),
    'Draft reservation could not be saved',
  );
  if (reservation.status === 'completed' && reservation.draftId) return reservation.draftId;
  const existing = await dependencies.gmailDrafts.findReplyDraft({
    googleConnectionId: input.googleConnectionId,
    gmailThreadId: input.gmailThreadId,
    idempotencyKey: action.idempotencyKey,
  });
  const message = action.target;
  const gmailDraft: CreatedGmailDraft =
    existing ??
    (await dependencies.gmailDrafts.createReplyDraft({
      body: action.body,
      from: action.settings.googleEmail,
      gmailThreadId: input.gmailThreadId,
      googleConnectionId: input.googleConnectionId,
      idempotencyKey: action.idempotencyKey,
      inReplyTo: message.messageId,
      references: message.references,
      subject: message.subject,
      to: action.recipient,
    }));
  await persistSafely(
    () =>
      dependencies.drafts.complete({
        gmailDraft,
        idempotencyKey: action.idempotencyKey,
        jobId: context.jobId,
        replyBodyHash: createHash('sha256').update(action.body).digest('hex'),
        runId: context.runId,
      }),
    'Draft history could not be saved',
  );
  return gmailDraft.draftId;
}
