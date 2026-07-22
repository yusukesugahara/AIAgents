import { createHash } from 'node:crypto';
import type { AgentContext } from '@ai-agents/agent-core';
import type { CreatedGmailDraft, EmailMessage, EmailThread } from '@ai-agents/connector-google';
import { persistResult, persistSafely } from './persistence';
import type {
  JobEmailReplyNotApplicableReason,
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
  | { readonly kind: 'not_applicable'; readonly reason: JobEmailReplyNotApplicableReason }
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
  if (!analysis.needsReply && analysis.category !== 'scheduling_request') {
    return { kind: 'not_applicable', reason: 'reply_not_required' };
  }
  const settings = await persistResult(
    () => dependencies.settings.getReplySettings(input.googleConnectionId),
    'Reply settings could not be loaded',
  );
  if (!settings) return { kind: 'needs_review', reason: 'reply_settings_missing' };
  if (!settings.createDrafts) return { kind: 'not_applicable', reason: 'reply_creation_disabled' };
  if (!settings.userName) return { kind: 'needs_review', reason: 'reply_settings_missing' };
  if (analysis.confidence < settings.draftConfidenceThreshold) {
    return { kind: 'needs_review', reason: 'reply_analysis_low_confidence' };
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
  if (canCreateSchedulingPlaceholderDraft(analysis)) {
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
      body: createSchedulingPlaceholderDraft(analysis, settings),
      idempotencyKey: `gmail-draft:${input.googleConnectionId}:${input.gmailMessageId}:scheduling-placeholder.v1`,
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
  if (analysis.missingRequiredInformation.length > 0) {
    return { kind: 'needs_review', reason: 'reply_information_missing' };
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

function canCreateSchedulingPlaceholderDraft(analysis: JobEmailAnalysis): boolean {
  return analysis.category === 'scheduling_request';
}

function createSchedulingPlaceholderDraft(
  analysis: JobEmailAnalysis,
  settings: JobEmailReplySettings,
): string {
  const contactName = analysis.contactName?.trim();
  const addressee = contactName
    ? /(?:様|御中)$/u.test(contactName)
      ? contactName
      : `${contactName}様`
    : '採用ご担当者様';
  return [
    addressee,
    '',
    `お世話になっております。${settings.userName}です。`,
    '',
    'ご連絡ありがとうございます。',
    '日程につきまして、下記候補で調整をお願いいたします。',
    '',
    '【候補日時を入力してください】',
    '',
    'お手数をおかけしますが、よろしくお願いいたします。',
    ...(settings.emailSignature ? ['', settings.emailSignature] : []),
  ].join('\n');
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
  if (reservation.status === 'completed' && reservation.draftId) {
    const existing = await dependencies.gmailDrafts.findReplyDraft({
      googleConnectionId: input.googleConnectionId,
      gmailThreadId: input.gmailThreadId,
      idempotencyKey: action.idempotencyKey,
    });
    if (existing) return existing.draftId;
    await persistResult(
      () =>
        dependencies.drafts.reopen({
          googleConnectionId: input.googleConnectionId,
          gmailMessageId: input.gmailMessageId,
          idempotencyKey: action.idempotencyKey,
          jobId: context.jobId,
          runId: context.runId,
        }),
      'Gmail Draft reservation could not be reopened',
    );
  }
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
