import type { AgentContext } from '@ai-agents/agent-core';
import { AgentDependencyError } from '@ai-agents/agent-core';
import {
  type CreatedGoogleCalendarEvent,
  deterministicCalendarEventId,
} from '@ai-agents/connector-google';
import { persistResult, persistSafely } from './persistence';
import type {
  JobEmailCalendarSettings,
  JobEmailReviewReason,
  JobSearchEmailAgentDependencies,
} from './ports';
import { jobEmailCalendarPolicyVersion } from './prompt';
import type { JobEmailAnalysis, JobSearchEmailInput } from './schemas';
import { isValidIanaTimeZone } from './validation';

export type CalendarAction =
  | { readonly kind: 'not_applicable' }
  | { readonly kind: 'needs_review'; readonly reason: JobEmailReviewReason }
  | {
      readonly eventId: string;
      readonly existingEvent: CreatedGoogleCalendarEvent | null;
      readonly idempotencyKey: string;
      readonly kind: 'ready';
      readonly analysisConfidence: number;
      readonly meeting: {
        readonly companyName: string;
        readonly contactName: string | null;
        readonly endAt: string;
        readonly startAt: string;
        readonly url: string;
      };
      readonly timeZone: string;
    };

export async function prepareCalendarAction(
  dependencies: JobSearchEmailAgentDependencies,
  input: JobSearchEmailInput,
  analysis: JobEmailAnalysis,
  settings: JobEmailCalendarSettings | null,
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
      analysisConfidence: analysis.confidence,
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

export async function createCalendarEvent(
  dependencies: JobSearchEmailAgentDependencies,
  context: AgentContext,
  input: JobSearchEmailInput,
  action: Extract<CalendarAction, { readonly kind: 'ready' }>,
): Promise<
  | { readonly eventId: string; readonly kind: 'completed' }
  | { readonly kind: 'needs_review'; readonly reason: JobEmailReviewReason }
> {
  const revalidation = await revalidateCalendarAction(dependencies, input, action);
  if (revalidation.kind === 'needs_review') return revalidation;

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
  if (reservation.status === 'completed' && reservation.eventId) {
    return { eventId: reservation.eventId, kind: 'completed' };
  }
  const meeting = action.meeting;
  let calendarEvent = revalidation.existingEvent;
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
  return { eventId: calendarEvent.eventId, kind: 'completed' };
}

async function revalidateCalendarAction(
  dependencies: JobSearchEmailAgentDependencies,
  input: JobSearchEmailInput,
  action: Extract<CalendarAction, { readonly kind: 'ready' }>,
): Promise<
  | { readonly existingEvent: CreatedGoogleCalendarEvent | null; readonly kind: 'ready' }
  | { readonly kind: 'needs_review'; readonly reason: JobEmailReviewReason }
> {
  const settings = await persistResult(
    () => dependencies.settings.getCalendarSettings(input.googleConnectionId),
    'Calendar settings could not be revalidated',
  );
  if (!settings) return { kind: 'needs_review', reason: 'calendar_settings_missing' };
  if (
    !settings.createCalendarEvents ||
    !isValidIanaTimeZone(settings.timezone) ||
    action.analysisConfidence < settings.calendarConfidenceThreshold
  ) {
    return { kind: 'needs_review', reason: 'calendar_policy_changed' };
  }

  try {
    const existingEvent = await dependencies.calendar.findEvent({
      eventId: action.eventId,
      googleConnectionId: input.googleConnectionId,
      idempotencyKey: action.idempotencyKey,
    });
    if (existingEvent) return { existingEvent, kind: 'ready' };
    const conflicts = await dependencies.calendar.findConflictingEvents({
      endAt: action.meeting.endAt,
      googleConnectionId: input.googleConnectionId,
      startAt: action.meeting.startAt,
    });
    if (conflicts.length > 0) return { kind: 'needs_review', reason: 'calendar_conflict' };
    return { existingEvent: null, kind: 'ready' };
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
