import { createHash } from 'node:crypto';
import type { AgentContext } from '@ai-agents/agent-core';
import type { CreatedGmailDraft, EmailMessage, EmailThread } from '@ai-agents/connector-google';
import type { LlmInvocationMetadata } from '@ai-agents/llm';
import { z } from 'zod';
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
  jobEmailDraftToolPromptVersion,
  jobEmailDraftToolSchemaName,
  jobEmailDraftToolSchemaVersion,
  jobEmailReplySystemPrompt,
} from './prompt';
import type { JobEmailAnalysis, JobSearchEmailInput } from './schemas';
import { generatedReplySchema } from './schemas';
import { extractAddress, isLatestReplyTarget, isMessageId, isSafeHeaderValue } from './validation';

export type ReplyAction =
  | { readonly kind: 'not_applicable'; readonly reason: JobEmailReplyNotApplicableReason }
  | { readonly kind: 'needs_review'; readonly reason: JobEmailReviewReason }
  | {
      readonly draftKind: 'generated' | 'scheduling_placeholder';
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
    return {
      draftKind: 'scheduling_placeholder',
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
  return {
    draftKind: 'generated',
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

const emptyToolArgumentsSchema = z.object({}).strict();
const emptyToolParameters = {
  additionalProperties: false,
  properties: {},
  required: [],
  type: 'object',
} as const;
const generatedReplyToolParameters = {
  additionalProperties: false,
  properties: {
    body: { description: 'Plain-text Japanese reply body', type: 'string' },
    confidence: { maximum: 1, minimum: 0, type: 'number' },
    warnings: { items: { type: 'string' }, type: 'array' },
  },
  required: ['body', 'confidence', 'warnings'],
  type: 'object',
} as const;
const draftToolCompletionSchema = z.object({ status: z.literal('completed') }).strict();

export type ReplyDraftToolResult =
  | {
      readonly draftId: string;
      readonly kind: 'completed';
      readonly metadata: LlmInvocationMetadata;
      readonly writeStatus: 'created' | 'reused';
    }
  | {
      readonly kind: 'needs_review';
      readonly metadata?: LlmInvocationMetadata;
      readonly reason: JobEmailReviewReason;
    };

type DraftExecutionResult =
  | {
      readonly draftId: string;
      readonly kind: 'completed';
      readonly writeStatus: 'created' | 'reused';
    }
  | { readonly kind: 'needs_review'; readonly reason: JobEmailReviewReason };

export async function runReplyDraftToolLoop(
  dependencies: JobSearchEmailAgentDependencies,
  context: AgentContext,
  input: JobSearchEmailInput,
  analysis: JobEmailAnalysis,
  message: EmailMessage,
  thread: EmailThread,
  action: Extract<ReplyAction, { readonly kind: 'ready' }>,
): Promise<ReplyDraftToolResult> {
  let toolResult: DraftExecutionResult | undefined;
  const expectedToolName =
    action.draftKind === 'scheduling_placeholder'
      ? 'create_scheduling_placeholder_draft'
      : 'create_reply_draft';
  const tool =
    action.draftKind === 'scheduling_placeholder'
      ? {
          description:
            'Create one editable Gmail scheduling reply Draft using the application-owned placeholder body.',
          execute: async (arguments_: unknown) => {
            const parsed = emptyToolArgumentsSchema.parse(arguments_);
            void parsed;
            toolResult = await executeGuardedDraft(
              dependencies,
              context,
              input,
              analysis,
              message,
              action,
              createSchedulingPlaceholderDraft(analysis, action.settings),
            );
            return toSafeToolOutput(toolResult);
          },
          maxCalls: 1,
          name: expectedToolName,
          parameters: emptyToolParameters,
          schema: emptyToolArgumentsSchema,
        }
      : {
          description:
            'Create one Gmail reply Draft after the application validates the proposed body and current thread state. This never sends email.',
          execute: async (arguments_: unknown) => {
            const reply = generatedReplySchema.parse(arguments_);
            toolResult = await executeGuardedDraft(
              dependencies,
              context,
              input,
              analysis,
              message,
              action,
              reply.body,
              reply,
            );
            return toSafeToolOutput(toolResult);
          },
          maxCalls: 1,
          name: expectedToolName,
          parameters: generatedReplyToolParameters,
          schema: generatedReplySchema,
        };

  const llmResult = await dependencies.llm.runToolLoop({
    initialToolChoice: { name: expectedToolName },
    maxToolCalls: 1,
    maxTurns: 2,
    model: dependencies.replyModel,
    promptVersion: jobEmailDraftToolPromptVersion,
    requiredToolNames: [expectedToolName],
    runId: context.runId,
    schema: draftToolCompletionSchema,
    schemaName: jobEmailDraftToolSchemaName,
    schemaVersion: jobEmailDraftToolSchemaVersion,
    signal: context.signal,
    systemPrompt: `${jobEmailReplySystemPrompt}\n\nYou must call the provided Draft tool exactly once. Never claim that an email was sent. After the tool result, return the completion schema.`,
    tools: [tool],
    userInput: buildJobEmailReplyInput({
      analysis,
      signature: action.settings.emailSignature,
      target: message,
      thread,
      userName: action.settings.userName ?? '',
    }),
  });

  if (toolResult?.kind === 'completed') {
    return { ...toolResult, metadata: llmResult.metadata };
  }
  if (toolResult) return { ...toolResult, metadata: llmResult.metadata };
  return {
    kind: 'needs_review',
    reason:
      llmResult.status === 'needs_review' && llmResult.reason === 'refusal'
        ? 'reply_llm_refusal'
        : 'reply_llm_invalid_output',
  };
}

async function executeGuardedDraft(
  dependencies: JobSearchEmailAgentDependencies,
  context: AgentContext,
  input: JobSearchEmailInput,
  analysis: JobEmailAnalysis,
  message: EmailMessage,
  action: Extract<ReplyAction, { readonly kind: 'ready' }>,
  body: string,
  generatedReply?: { readonly confidence: number; readonly warnings: readonly string[] },
): Promise<DraftExecutionResult> {
  const expectedKind =
    analysis.category === 'scheduling_request' ? 'scheduling_placeholder' : 'generated';
  if (action.draftKind !== expectedKind) {
    return { kind: 'needs_review', reason: 'reply_llm_invalid_output' };
  }
  const currentSettings = await persistResult(
    () => dependencies.settings.getReplySettings(input.googleConnectionId),
    'Reply settings could not be reloaded',
  );
  if (
    !currentSettings?.createDrafts ||
    !currentSettings.userName ||
    currentSettings.googleEmail !== action.settings.googleEmail ||
    currentSettings.userName !== action.settings.userName ||
    currentSettings.emailSignature !== action.settings.emailSignature
  ) {
    return { kind: 'needs_review', reason: 'reply_settings_missing' };
  }
  if (analysis.confidence < currentSettings.draftConfidenceThreshold) {
    return { kind: 'needs_review', reason: 'reply_analysis_low_confidence' };
  }
  if (generatedReply && generatedReply.confidence < currentSettings.draftConfidenceThreshold) {
    return { kind: 'needs_review', reason: 'reply_low_confidence' };
  }
  if (generatedReply && generatedReply.warnings.length > 0) {
    return { kind: 'needs_review', reason: 'reply_warnings' };
  }
  const expectedRecipient = extractAddress(message.replyTo ?? '') ?? extractAddress(message.from);
  if (
    !expectedRecipient ||
    action.recipient !== expectedRecipient ||
    !isMessageId(action.target.messageId) ||
    !isSafeHeaderValue(action.target.subject) ||
    action.target.messageId !== message.messageId ||
    action.target.subject !== message.subject
  ) {
    return { kind: 'needs_review', reason: 'reply_headers_invalid' };
  }
  const currentThread = await dependencies.gmail.getThread({
    googleConnectionId: input.googleConnectionId,
    gmailThreadId: input.gmailThreadId,
  });
  const currentTarget = currentThread.messages.find((candidate) => candidate.id === message.id);
  const currentRecipient = currentTarget
    ? (extractAddress(currentTarget.replyTo ?? '') ?? extractAddress(currentTarget.from))
    : null;
  if (
    currentThread.id !== input.gmailThreadId ||
    !isLatestReplyTarget(currentThread, message.id, action.settings.googleEmail) ||
    currentTarget?.messageId !== action.target.messageId ||
    currentTarget.subject !== action.target.subject ||
    currentRecipient !== action.recipient
  ) {
    return { kind: 'needs_review', reason: 'reply_target_stale' };
  }
  const created = await createDraft(dependencies, context, input, action, body);
  return {
    draftId: created.draftId,
    kind: 'completed',
    writeStatus: created.status,
  };
}

function toSafeToolOutput(result: DraftExecutionResult): Record<string, unknown> {
  return result.kind === 'completed'
    ? { draftId: result.draftId, status: result.writeStatus }
    : { reason: result.reason, status: 'rejected' };
}

export async function createDraft(
  dependencies: JobSearchEmailAgentDependencies,
  context: AgentContext,
  input: JobSearchEmailInput,
  action: Extract<ReplyAction, { readonly kind: 'ready' }>,
  body: string,
): Promise<{ readonly draftId: string; readonly status: 'created' | 'reused' }> {
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
    if (existing) return { draftId: existing.draftId, status: 'reused' };
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
      body,
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
        replyBodyHash: createHash('sha256').update(body).digest('hex'),
        runId: context.runId,
      }),
    'Draft history could not be saved',
  );
  return { draftId: gmailDraft.draftId, status: existing ? 'reused' : 'created' };
}
