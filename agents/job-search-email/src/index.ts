import { createHash } from 'node:crypto';
import type { AgentContext } from '@ai-agents/agent-core';
import { AgentDependencyError, defineAgent, RetryableJobError } from '@ai-agents/agent-core';
import {
  type CreatedGmailDraft,
  type CreatedGoogleCalendarEvent,
  deterministicCalendarEventId,
  type EmailMessage,
  type EmailThread,
} from '@ai-agents/connector-google';
import { manifest } from './manifest';
import type { JobEmailReviewReason, JobSearchEmailAgentDependencies } from './ports';
import {
  buildJobEmailAnalysisInput,
  buildJobEmailReplyInput,
  jobEmailAnalysisPromptVersion,
  jobEmailAnalysisSchemaName,
  jobEmailAnalysisSchemaVersion,
  jobEmailAnalysisSystemPrompt,
  jobEmailCalendarPolicyVersion,
  jobEmailDefaultTimezone,
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

const jobEmailStepSequence = {
  FETCH_EMAIL_THREAD: 10,
  ANALYZE_EMAIL: 20,
  GENERATE_REPLY: 30,
  CHECK_CALENDAR_POLICY: 40,
  CREATE_DRAFT: 50,
  CREATE_CALENDAR_EVENT: 60,
  COMPLETE: 70,
} as const;

type JobEmailStepName = keyof typeof jobEmailStepSequence;

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
            schema: jobEmailAnalysisSchema,
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

type ReplyAction =
  | { readonly kind: 'not_applicable' }
  | { readonly kind: 'needs_review'; readonly reason: JobEmailReviewReason }
  | {
      readonly body: string;
      readonly idempotencyKey: string;
      readonly kind: 'ready';
      readonly recipient: string;
      readonly settings: import('./ports').JobEmailReplySettings;
      readonly target: {
        readonly messageId: string;
        readonly references: readonly string[];
        readonly subject: string;
      };
    };

type CalendarAction =
  | { readonly kind: 'not_applicable' }
  | { readonly kind: 'needs_review'; readonly reason: JobEmailReviewReason }
  | {
      readonly eventId: string;
      readonly existingEvent: CreatedGoogleCalendarEvent | null;
      readonly idempotencyKey: string;
      readonly kind: 'ready';
      readonly meeting: {
        readonly companyName: string;
        readonly contactName: string | null;
        readonly endAt: string;
        readonly startAt: string;
        readonly url: string;
      };
      readonly timeZone: string;
    };

async function prepareReplyAction(
  dependencies: JobSearchEmailAgentDependencies,
  context: AgentContext,
  input: import('./schemas').JobSearchEmailInput,
  analysis: import('./schemas').JobEmailAnalysis,
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

async function prepareCalendarAction(
  dependencies: JobSearchEmailAgentDependencies,
  input: import('./schemas').JobSearchEmailInput,
  analysis: import('./schemas').JobEmailAnalysis,
  settings: import('./ports').JobEmailCalendarSettings | null,
): Promise<CalendarAction> {
  if (!analysis.meeting.isConfirmed) return { kind: 'not_applicable' };
  if (!settings) return { kind: 'needs_review', reason: 'calendar_settings_missing' };
  if (!settings.createCalendarEvents) return { kind: 'not_applicable' };
  if (!isValidIanaTimeZone(settings.timezone)) {
    return { kind: 'needs_review', reason: 'calendar_datetime_invalid' };
  }
  const meeting = analysis.meeting;
  if (
    !analysis.companyName ||
    !meeting.startAt ||
    !meeting.endAt ||
    !meeting.url ||
    meeting.urlType !== 'web_meeting'
  ) {
    return { kind: 'needs_review', reason: 'calendar_information_missing' };
  }
  if (analysis.confidence < settings.calendarConfidenceThreshold) {
    return { kind: 'needs_review', reason: 'calendar_low_confidence' };
  }
  const timeZone = meeting.timezone ?? settings.timezone;
  if (!isValidIanaTimeZone(timeZone)) {
    return { kind: 'needs_review', reason: 'calendar_datetime_invalid' };
  }
  const idempotencyKey = `calendar-event:${input.googleConnectionId}:${input.gmailMessageId}:${jobEmailCalendarPolicyVersion}`;
  const eventId = deterministicCalendarEventId(idempotencyKey);
  try {
    const existingEvent = await dependencies.calendar.findEvent({
      eventId,
      googleConnectionId: input.googleConnectionId,
      idempotencyKey,
    });
    const action = {
      eventId,
      idempotencyKey,
      kind: 'ready' as const,
      meeting: {
        companyName: analysis.companyName,
        contactName: analysis.contactName,
        endAt: meeting.endAt,
        startAt: meeting.startAt,
        url: meeting.url,
      },
      timeZone,
    };
    if (existingEvent) return { ...action, existingEvent };
    const conflicts = await dependencies.calendar.findConflictingEvents({
      endAt: meeting.endAt,
      googleConnectionId: input.googleConnectionId,
      startAt: meeting.startAt,
    });
    if (conflicts.length > 0) return { kind: 'needs_review', reason: 'calendar_conflict' };
    return { ...action, existingEvent: null };
  } catch (error) {
    if (
      error instanceof AgentDependencyError &&
      (error.code === 'PERMISSION_DENIED' || error.code === 'AUTHENTICATION_REQUIRED')
    ) {
      return { kind: 'needs_review', reason: 'calendar_permission_missing' };
    }
    if (error instanceof AgentDependencyError && error.code === 'CONFLICT') {
      return { kind: 'needs_review', reason: 'calendar_conflict' };
    }
    throw error;
  }
}

async function createDraft(
  dependencies: JobSearchEmailAgentDependencies,
  context: AgentContext,
  input: import('./schemas').JobSearchEmailInput,
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

async function createCalendarEvent(
  dependencies: JobSearchEmailAgentDependencies,
  context: AgentContext,
  input: import('./schemas').JobSearchEmailInput,
  action: Extract<CalendarAction, { readonly kind: 'ready' }>,
): Promise<string> {
  const reservation = await persistResult(
    () =>
      dependencies.calendarEvents.reserve({
        googleConnectionId: input.googleConnectionId,
        gmailMessageId: input.gmailMessageId,
        gmailThreadId: input.gmailThreadId,
        idempotencyKey: action.idempotencyKey,
        jobId: context.jobId,
        runId: context.runId,
      }),
    'Calendar event reservation could not be saved',
  );
  if (reservation.status === 'completed' && reservation.eventId) return reservation.eventId;
  const meeting = action.meeting;
  let calendarEvent = action.existingEvent;
  if (!calendarEvent) {
    try {
      calendarEvent = await dependencies.calendar.createEvent({
        description: [
          `会社名: ${meeting.companyName}`,
          ...(meeting.contactName ? [`担当者名: ${meeting.contactName}`] : []),
          `Web会議URL: ${meeting.url}`,
          `元Gmail message ID: ${input.gmailMessageId}`,
        ].join('\n'),
        endAt: meeting.endAt,
        eventId: action.eventId,
        googleConnectionId: input.googleConnectionId,
        idempotencyKey: action.idempotencyKey,
        location: meeting.url,
        startAt: meeting.startAt,
        summary: `【面談】${meeting.companyName}`,
        timeZone: action.timeZone,
      });
    } catch (error) {
      if (!(error instanceof AgentDependencyError) || error.code !== 'CONFLICT') throw error;
      calendarEvent = await dependencies.calendar.findEvent({
        eventId: action.eventId,
        googleConnectionId: input.googleConnectionId,
        idempotencyKey: action.idempotencyKey,
      });
      if (!calendarEvent) throw error;
    }
  }
  await persistSafely(
    () =>
      dependencies.calendarEvents.complete({
        calendarEvent,
        idempotencyKey: action.idempotencyKey,
        jobId: context.jobId,
        runId: context.runId,
      }),
    'Calendar event history could not be saved',
  );
  return calendarEvent.eventId;
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

function completed(
  analysis: import('./schemas').JobEmailAnalysis,
  draftId: string | null = null,
  calendarEventId: string | null = null,
) {
  return {
    analysis,
    calendarEventId,
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

function isValidIanaTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
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

async function trackStep<T>(
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

async function completeTrackedRun(
  dependencies: JobSearchEmailAgentDependencies,
  context: AgentContext,
  output: import('./schemas').JobSearchEmailOutput,
  reviewReason?: JobEmailReviewReason,
): Promise<import('./schemas').JobSearchEmailOutput> {
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
