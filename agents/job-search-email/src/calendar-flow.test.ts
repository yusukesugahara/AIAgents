import { describe, expect, test } from 'bun:test';
import { AgentDependencyError } from '@ai-agents/agent-core';
import type { GoogleCalendarClient } from '@ai-agents/connector-google';
import { FakeLlmProvider } from '@ai-agents/testing';
import { createJobSearchEmailAgent } from './index';
import {
  analysis,
  connectionId,
  context,
  createDependencies,
  FakeGoogleCalendar,
  FakeReplySettingsRepository,
  FakeStepRepository,
  metadata,
} from './test-support';

describe('Job Search Email Calendar flow', () => {
  test('passes the configured Calendar timezone to meeting analysis', async () => {
    const dependencies = createDependencies();
    const settings = new FakeReplySettingsRepository();
    settings.getCalendarSettings = async () => ({
      calendarConfidenceThreshold: 0.9,
      createCalendarEvents: true,
      timezone: 'America/New_York',
    });
    dependencies.settings = settings;

    await createJobSearchEmailAgent(dependencies).run(context(), {
      googleConnectionId: connectionId,
      gmailMessageId: 'message-1',
      gmailThreadId: 'thread-1',
    });

    expect(
      dependencies.llm.toolExecutions.find((execution) => execution.name === 'get_agent_context')
        ?.output,
    ).toEqual({ defaultTimezone: 'America/New_York' });
  });

  test('creates one primary Calendar event for a confirmed Web meeting without a reply', async () => {
    const dependencies = createDependencies(
      analysis({
        category: 'meeting_confirmed',
        meeting: {
          endAt: '2026-07-21T11:00:00+09:00',
          isConfirmed: true,
          startAt: '2026-07-21T10:00:00+09:00',
          timezone: 'Asia/Tokyo',
          url: 'https://meet.example.com/interview',
          urlType: 'web_meeting',
        },
      }),
    );
    const agent = createJobSearchEmailAgent(dependencies);

    const output = await agent.run(context(), {
      googleConnectionId: connectionId,
      gmailMessageId: 'message-1',
      gmailThreadId: 'thread-1',
    });

    expect(output).toMatchObject({ draftId: null, result: 'completed' });
    expect(output.calendarEventId).toMatch(/^aia[0-9a-f]{64}$/u);
    expect(dependencies.calendar.created).toHaveLength(1);
    expect(dependencies.calendar.created[0]).toMatchObject({
      location: 'https://meet.example.com/interview',
      summary: '【面談】Example株式会社',
      timeZone: 'Asia/Tokyo',
    });
    expect(dependencies.calendarEvents.completed).toHaveLength(1);
    expect(dependencies.gmailDrafts.created).toHaveLength(0);
  });

  test('stops both external writes when a confirmed meeting conflicts with an existing event', async () => {
    const result = analysis({
      category: 'meeting_confirmed',
      meeting: {
        endAt: '2026-07-21T11:00:00+09:00',
        isConfirmed: true,
        startAt: '2026-07-21T10:00:00+09:00',
        timezone: 'Asia/Tokyo',
        url: 'https://meet.example.com/interview',
        urlType: 'web_meeting',
      },
      needsReply: true,
      replyIntent: 'acknowledge',
    });
    const dependencies = createDependencies(result);
    dependencies.llm = new FakeLlmProvider([
      { data: result, metadata, status: 'completed' },
      {
        data: { body: 'ご連絡ありがとうございます。', confidence: 0.98, warnings: [] },
        metadata,
        status: 'completed',
      },
    ]);
    dependencies.calendar.hasConflict = true;
    const steps = new FakeStepRepository();
    const agent = createJobSearchEmailAgent({ ...dependencies, steps });

    const output = await agent.run(context(), {
      googleConnectionId: connectionId,
      gmailMessageId: 'message-1',
      gmailThreadId: 'thread-1',
    });

    expect(output).toMatchObject({ calendarEventId: null, draftId: null, result: 'needs_review' });
    expect(dependencies.reviews.saved[0]?.reason).toBe('calendar_conflict');
    expect(dependencies.gmailDrafts.created).toHaveLength(0);
    expect(dependencies.calendar.created).toHaveLength(0);
    expect(dependencies.llm.toolExecutions.map((execution) => execution.name)).toEqual([
      'get_email_thread',
      'get_agent_context',
    ]);
    expect(
      steps.completed.find((step) => step.stepName === 'CHECK_CALENDAR_POLICY')?.output,
    ).toEqual({
      applicable: false,
      outcome: 'needs_review',
      reviewReason: 'calendar_conflict',
    });
  });

  test('stops both external writes when a confirmed meeting has no company name', async () => {
    const result = analysis({
      category: 'meeting_confirmed',
      companyName: null,
      meeting: {
        endAt: '2026-07-21T11:00:00+09:00',
        isConfirmed: true,
        startAt: '2026-07-21T10:00:00+09:00',
        timezone: 'Asia/Tokyo',
        url: 'https://meet.example.com/interview',
        urlType: 'web_meeting',
      },
      needsReply: true,
      replyIntent: 'acknowledge',
    });
    const dependencies = createDependencies(result);
    dependencies.llm = new FakeLlmProvider([
      { data: result, metadata, status: 'completed' },
      {
        data: { body: 'ご連絡ありがとうございます。', confidence: 0.98, warnings: [] },
        metadata,
        status: 'completed',
      },
    ]);

    const output = await createJobSearchEmailAgent(dependencies).run(context(), {
      googleConnectionId: connectionId,
      gmailMessageId: 'message-1',
      gmailThreadId: 'thread-1',
    });

    expect(output).toMatchObject({ calendarEventId: null, draftId: null, result: 'needs_review' });
    expect(dependencies.reviews.saved[0]?.reason).toBe('calendar_information_missing');
    expect(dependencies.drafts.reservations).toHaveLength(0);
    expect(dependencies.calendarEvents.reservations).toHaveLength(0);
    expect(dependencies.gmailDrafts.created).toHaveLength(0);
    expect(dependencies.calendar.created).toHaveLength(0);
  });

  test('does not require complete meeting details when Calendar creation is disabled', async () => {
    const result = analysis({
      category: 'meeting_confirmed',
      companyName: null,
      meeting: {
        endAt: null,
        isConfirmed: true,
        startAt: '2026-07-21T10:00:00+09:00',
        timezone: 'Asia/Tokyo',
        url: null,
        urlType: 'none',
      },
    });
    const dependencies = createDependencies(result);
    const disabledSettings = new FakeReplySettingsRepository();
    disabledSettings.getCalendarSettings = async () => ({
      calendarConfidenceThreshold: 0.9,
      createCalendarEvents: false,
      timezone: 'Asia/Tokyo',
    });
    dependencies.settings = disabledSettings;

    const output = await createJobSearchEmailAgent(dependencies).run(context(), {
      googleConnectionId: connectionId,
      gmailMessageId: 'message-1',
      gmailThreadId: 'thread-1',
    });

    expect(output).toMatchObject({ calendarEventId: null, draftId: null, result: 'completed' });
    expect(dependencies.reviews.saved).toHaveLength(0);
    expect(dependencies.calendar.conflicts).toHaveLength(0);
    expect(dependencies.calendar.created).toHaveLength(0);
  });

  test('stops both external writes when Calendar permission is missing during conflict lookup', async () => {
    const result = analysis({
      category: 'meeting_confirmed',
      meeting: {
        endAt: '2026-07-21T11:00:00+09:00',
        isConfirmed: true,
        startAt: '2026-07-21T10:00:00+09:00',
        timezone: 'Asia/Tokyo',
        url: 'https://meet.example.com/interview',
        urlType: 'web_meeting',
      },
      needsReply: true,
      replyIntent: 'acknowledge',
    });
    const dependencies = createDependencies(result);
    dependencies.llm = new FakeLlmProvider([
      { data: result, metadata, status: 'completed' },
      {
        data: { body: 'ご連絡ありがとうございます。', confidence: 0.98, warnings: [] },
        metadata,
        status: 'completed',
      },
    ]);
    dependencies.calendar.error = new AgentDependencyError(
      'PERMISSION_DENIED',
      false,
      'Calendar scope is missing',
    );

    const output = await createJobSearchEmailAgent(dependencies).run(context(), {
      googleConnectionId: connectionId,
      gmailMessageId: 'message-1',
      gmailThreadId: 'thread-1',
    });

    expect(output).toMatchObject({ calendarEventId: null, draftId: null, result: 'needs_review' });
    expect(dependencies.reviews.saved[0]?.reason).toBe('calendar_permission_missing');
    expect(dependencies.drafts.reservations).toHaveLength(0);
    expect(dependencies.calendarEvents.reservations).toHaveLength(0);
    expect(dependencies.gmailDrafts.created).toHaveLength(0);
    expect(dependencies.calendar.created).toHaveLength(0);
  });

  test('routes an invalid configured Calendar timezone to review without external writes', async () => {
    const result = analysis({
      category: 'meeting_confirmed',
      meeting: {
        endAt: '2026-07-21T11:00:00+09:00',
        isConfirmed: true,
        startAt: '2026-07-21T10:00:00+09:00',
        timezone: 'Asia/Tokyo',
        url: 'https://meet.example.com/interview',
        urlType: 'web_meeting',
      },
    });
    const dependencies = createDependencies(result);
    const settings = new FakeReplySettingsRepository();
    settings.getCalendarSettings = async () => ({
      calendarConfidenceThreshold: 0.9,
      createCalendarEvents: true,
      timezone: 'invalid/timezone',
    });
    dependencies.settings = settings;

    const output = await createJobSearchEmailAgent(dependencies).run(context(), {
      googleConnectionId: connectionId,
      gmailMessageId: 'message-1',
      gmailThreadId: 'thread-1',
    });

    expect(output).toMatchObject({ calendarEventId: null, draftId: null, result: 'needs_review' });
    expect(dependencies.reviews.saved[0]?.reason).toBe('calendar_datetime_invalid');
    expect(dependencies.calendarEvents.reservations).toHaveLength(0);
    expect(dependencies.calendar.created).toHaveLength(0);
  });

  test('recovers one Calendar event when persistence fails after the external write', async () => {
    const result = analysis({
      category: 'meeting_confirmed',
      meeting: {
        endAt: '2026-07-21T11:00:00+09:00',
        isConfirmed: true,
        startAt: '2026-07-21T10:00:00+09:00',
        timezone: 'Asia/Tokyo',
        url: 'https://meet.example.com/interview',
        urlType: 'web_meeting',
      },
    });
    const dependencies = createDependencies(result);
    dependencies.llm = new FakeLlmProvider([
      { data: result, metadata, status: 'completed' },
      { data: result, metadata, status: 'completed' },
    ]);
    dependencies.calendarEvents.error = new Error('database unavailable');
    const agent = createJobSearchEmailAgent(dependencies);
    const input = {
      googleConnectionId: connectionId,
      gmailMessageId: 'message-1',
      gmailThreadId: 'thread-1',
    };

    await expect(agent.run(context(), input)).rejects.toMatchObject({
      code: 'TEMPORARY_UNAVAILABLE',
      retryable: true,
    });
    dependencies.calendarEvents.error = undefined;
    const output = await agent.run(context(), input);

    expect(output.result).toBe('completed');
    expect(output.calendarEventId).toBe(dependencies.calendar.existing?.eventId ?? null);
    expect(dependencies.calendar.created).toHaveLength(1);
    expect(dependencies.calendarEvents.completed).toHaveLength(1);
  });

  test('concurrent executions converge on one deterministic Calendar event', async () => {
    const result = analysis({
      category: 'meeting_confirmed',
      meeting: {
        endAt: '2026-07-21T11:00:00+09:00',
        isConfirmed: true,
        startAt: '2026-07-21T10:00:00+09:00',
        timezone: 'Asia/Tokyo',
        url: 'https://meet.example.com/interview',
        urlType: 'web_meeting',
      },
    });
    const calendar = new (class extends FakeGoogleCalendar {
      override async createEvent(input: Parameters<GoogleCalendarClient['createEvent']>[0]) {
        await Promise.resolve();
        if (this.existing) {
          throw new AgentDependencyError('CONFLICT', false, 'Event already exists');
        }
        this.existing = { eventId: input.eventId };
        this.created.push(input);
        return this.existing;
      }
    })();
    const first = createDependencies(result);
    const second = createDependencies(result);
    first.calendar = calendar;
    second.calendar = calendar;
    const input = {
      googleConnectionId: connectionId,
      gmailMessageId: 'message-1',
      gmailThreadId: 'thread-1',
    };

    const outputs = await Promise.all([
      createJobSearchEmailAgent(first).run(context(), input),
      createJobSearchEmailAgent(second).run(context(), input),
    ]);

    expect(calendar.created).toHaveLength(1);
    const createdEventId = calendar.created[0]?.eventId;
    expect(createdEventId).toBeDefined();
    expect(outputs[0]?.calendarEventId).toBe(createdEventId ?? null);
    expect(outputs[1]?.calendarEventId).toBe(createdEventId ?? null);
  });
});
