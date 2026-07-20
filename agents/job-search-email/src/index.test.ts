import { describe, expect, test } from 'bun:test';
import { AgentDependencyError } from '@ai-agents/agent-core';
import type { GoogleCalendarClient } from '@ai-agents/connector-google';
import { FakeLlmProvider } from '@ai-agents/testing';
import { createJobSearchEmailAgent } from './index';
import {
  jobEmailAnalysisPromptVersion,
  jobEmailAnalysisSchemaName,
  jobEmailAnalysisSchemaVersion,
  jobEmailAnalysisSystemPrompt,
} from './prompt';
import {
  analysis,
  connectionId,
  context,
  createDependencies,
  FakeDraftRepository,
  FakeGmailDraftWriter,
  FakeGmailReader,
  FakeGoogleCalendar,
  FakeReplySettingsRepository,
  FakeStepRepository,
  message,
  metadata,
} from './test-support';

describe('Job Search Email Agent', () => {
  test('rejects a missing reply model during construction', () => {
    expect(() => createJobSearchEmailAgent({ ...createDependencies(), replyModel: '   ' })).toThrow(
      'OPENAI_REPLY_MODEL is required',
    );
  });

  test('fetches a consistent Gmail thread, calls the versioned schema, and saves valid analysis', async () => {
    const dependencies = createDependencies();
    const agent = createJobSearchEmailAgent(dependencies);
    const output = await agent.run(context(), {
      googleConnectionId: connectionId,
      gmailMessageId: 'message-1',
      gmailThreadId: 'thread-1',
    });

    expect(output.result).toBe('completed');
    expect(dependencies.gmail.requests).toEqual([
      { googleConnectionId: connectionId, gmailMessageId: 'message-1' },
      { googleConnectionId: connectionId, gmailThreadId: 'thread-1' },
    ]);
    expect(dependencies.llm.requests[0]).toMatchObject({
      model: 'test-model',
      promptVersion: jobEmailAnalysisPromptVersion,
      runId: context().runId,
      schemaName: jobEmailAnalysisSchemaName,
      schemaVersion: jobEmailAnalysisSchemaVersion,
      systemPrompt: jobEmailAnalysisSystemPrompt,
    });
    expect(dependencies.analyses.saved[0]).toMatchObject({
      googleConnectionId: connectionId,
      gmailMessageId: 'message-1',
      gmailThreadId: 'thread-1',
      runId: context().runId,
    });
    expect(dependencies.reviews.saved).toHaveLength(0);
  });

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

    const userInput = dependencies.llm.requests[0]?.userInput;
    expect(typeof userInput).toBe('string');
    expect(JSON.parse(String(userInput))).toMatchObject({
      EMAIL_THREAD_DATA: { defaultTimezone: 'America/New_York' },
    });
  });

  test('persists unrelated analysis and returns skipped', async () => {
    const dependencies = createDependencies(
      analysis({
        isJobRelated: false,
        category: 'not_job_related',
        companyName: null,
        contactName: null,
        confidence: 0.9,
        evidence: ['ニュースレター'],
      }),
    );
    const output = await createJobSearchEmailAgent(dependencies).run(context(), {
      googleConnectionId: connectionId,
      gmailMessageId: 'message-1',
      gmailThreadId: 'thread-1',
    });
    expect(output.result).toBe('skipped');
    expect(dependencies.analyses.saved).toHaveLength(1);
  });

  test('creates a review request without saving analysis for refusal or invalid output', async () => {
    for (const reason of ['refusal', 'invalid_output'] as const) {
      const dependencies = createDependencies();
      dependencies.llm = new FakeLlmProvider([{ metadata, reason, status: 'needs_review' }]);
      const steps = new FakeStepRepository();
      const output = await createJobSearchEmailAgent({ ...dependencies, steps }).run(context(), {
        googleConnectionId: connectionId,
        gmailMessageId: 'message-1',
        gmailThreadId: 'thread-1',
      });
      expect(output).toEqual({
        analysis: null,
        calendarEventId: null,
        draftId: null,
        result: 'needs_review',
      });
      expect(dependencies.analyses.saved).toHaveLength(0);
      expect(dependencies.reviews.saved[0]?.reason).toBe(
        reason === 'refusal' ? 'llm_refusal' : 'llm_invalid_output',
      );
      expect(steps.completed.at(-1)?.output).toMatchObject({
        result: 'needs_review',
        reviewReason: reason === 'refusal' ? 'llm_refusal' : 'llm_invalid_output',
      });
    }
  });

  test('defensively routes a completed but schema-invalid provider result to review', async () => {
    const dependencies = createDependencies();
    dependencies.llm = new FakeLlmProvider([
      { data: { category: 'invalid' }, metadata, status: 'completed' },
    ]);
    const output = await createJobSearchEmailAgent(dependencies).run(context(), {
      googleConnectionId: connectionId,
      gmailMessageId: 'message-1',
      gmailThreadId: 'thread-1',
    });

    expect(output.result).toBe('needs_review');
    expect(dependencies.analyses.saved).toHaveLength(0);
    expect(dependencies.reviews.saved[0]?.reason).toBe('llm_invalid_output');
  });

  test('rejects inconsistent Gmail identifiers before calling the LLM', async () => {
    const dependencies = createDependencies();
    dependencies.gmail = new FakeGmailReader(message('message-1', 'different-thread'), {
      id: 'thread-1',
      messages: [message()],
    });
    await expect(
      createJobSearchEmailAgent(dependencies).run(context(), {
        googleConnectionId: connectionId,
        gmailMessageId: 'message-1',
        gmailThreadId: 'thread-1',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE', retryable: false });
    expect(dependencies.llm.requests).toHaveLength(0);
  });

  test('preserves provider errors and maps persistence failures to retryable dependency errors', async () => {
    const providerFailure = new AgentDependencyError(
      'RATE_LIMITED',
      true,
      'Provider rate limit was exceeded',
    );
    const dependencies = createDependencies();
    dependencies.llm = new FakeLlmProvider([providerFailure]);
    const steps = new FakeStepRepository();
    await expect(
      createJobSearchEmailAgent({ ...dependencies, steps }).run(context(), {
        googleConnectionId: connectionId,
        gmailMessageId: 'message-1',
        gmailThreadId: 'thread-1',
      }),
    ).rejects.toBe(providerFailure);
    expect(steps.completed.map((step) => step.stepName)).toEqual(['FETCH_EMAIL_THREAD']);
    expect(steps.failed).toEqual([
      expect.objectContaining({
        errorCode: 'RATE_LIMITED',
        retryable: true,
        stepName: 'ANALYZE_EMAIL',
      }),
    ]);

    const persistenceDependencies = createDependencies();
    persistenceDependencies.analyses.error = new Error('database secret details');
    await expect(
      createJobSearchEmailAgent(persistenceDependencies).run(context(), {
        googleConnectionId: connectionId,
        gmailMessageId: 'message-1',
        gmailThreadId: 'thread-1',
      }),
    ).rejects.toMatchObject({
      code: 'TEMPORARY_UNAVAILABLE',
      message: 'Email analysis could not be saved',
      retryable: true,
    });
  });

  test('creates exactly one reply Draft only after a safe reply is generated', async () => {
    const analysisResult = analysis({ needsReply: true, replyIntent: 'acknowledge' });
    const dependencies = createDependencies(analysisResult);
    const replyTarget = { ...message(), replyTo: '応募受付 <applications@example.com>' };
    dependencies.gmail = new FakeGmailReader(replyTarget, {
      id: 'thread-1',
      messages: [replyTarget],
    });
    dependencies.llm = new FakeLlmProvider([
      { data: analysisResult, metadata, status: 'completed' },
      {
        data: {
          body: 'ご連絡ありがとうございます。\nよろしくお願いいたします。',
          confidence: 0.95,
          warnings: [],
        },
        metadata,
        status: 'completed',
      },
    ]);
    const drafts = new FakeDraftRepository();
    const gmailDrafts = new FakeGmailDraftWriter();
    const output = await createJobSearchEmailAgent({
      ...dependencies,
      drafts,
      gmailDrafts,
      replyModel: 'test-reply-model',
      settings: new FakeReplySettingsRepository(),
    }).run(context(), {
      googleConnectionId: connectionId,
      gmailMessageId: 'message-1',
      gmailThreadId: 'thread-1',
    });

    expect(output).toMatchObject({ draftId: 'draft-1', result: 'completed' });
    expect(dependencies.llm.requests).toHaveLength(2);
    expect(drafts.reservations).toHaveLength(1);
    expect(drafts.completed).toHaveLength(1);
    expect(gmailDrafts.created).toEqual([
      expect.objectContaining({
        gmailThreadId: 'thread-1',
        inReplyTo: '<message-1@example.com>',
        subject: '選考のご案内',
        to: 'applications@example.com',
      }),
    ]);
    expect(dependencies.reviews.saved).toHaveLength(0);
  });

  test('records safe, ordered execution steps for a complete manual flow', async () => {
    const analysisResult = analysis({
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
    const dependencies = createDependencies(analysisResult);
    dependencies.llm = new FakeLlmProvider([
      { data: analysisResult, metadata, status: 'completed' },
      {
        data: { body: 'ご連絡ありがとうございます。', confidence: 0.98, warnings: [] },
        metadata,
        status: 'completed',
      },
    ]);
    const steps = new FakeStepRepository();
    const output = await createJobSearchEmailAgent({ ...dependencies, steps }).run(context(), {
      googleConnectionId: connectionId,
      gmailMessageId: 'message-1',
      gmailThreadId: 'thread-1',
    });

    expect(output).toMatchObject({ result: 'completed' });
    expect(steps.started.map((step) => step.stepName)).toEqual([
      'FETCH_EMAIL_THREAD',
      'ANALYZE_EMAIL',
      'GENERATE_REPLY',
      'CHECK_CALENDAR_POLICY',
      'CREATE_DRAFT',
      'CREATE_CALENDAR_EVENT',
      'COMPLETE',
    ]);
    expect(steps.started.map((step) => step.sequence)).toEqual([10, 20, 30, 40, 50, 60, 70]);
    expect(steps.completed).toHaveLength(7);
    expect(steps.failed).toHaveLength(0);
    expect(steps.completed.find((step) => step.stepName === 'ANALYZE_EMAIL')?.output).toEqual({
      category: 'meeting_confirmed',
      isJobRelated: true,
      outcome: 'completed',
    });
    expect(steps.completed.at(-1)?.output).toEqual({
      calendarEventId: output.calendarEventId,
      draftId: output.draftId,
      result: 'completed',
    });
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

  test('routes incomplete reply material to review without generating or creating a Draft', async () => {
    const analysisResult = analysis({
      missingRequiredInformation: ['面談日時'],
      needsReply: true,
      replyIntent: 'acknowledge',
    });
    const dependencies = createDependencies(analysisResult);
    const drafts = new FakeDraftRepository();
    const gmailDrafts = new FakeGmailDraftWriter();
    const output = await createJobSearchEmailAgent({
      ...dependencies,
      drafts,
      gmailDrafts,
      replyModel: 'test-reply-model',
      settings: new FakeReplySettingsRepository(),
    }).run(context(), {
      googleConnectionId: connectionId,
      gmailMessageId: 'message-1',
      gmailThreadId: 'thread-1',
    });

    expect(output.result).toBe('needs_review');
    expect(dependencies.reviews.saved[0]?.reason).toBe('reply_information_missing');
    expect(dependencies.llm.requests).toHaveLength(1);
    expect(drafts.reservations).toHaveLength(0);
    expect(gmailDrafts.created).toHaveLength(0);
  });

  test('honors disabled Draft creation without requiring reply profile settings', async () => {
    const analysisResult = analysis({ needsReply: true, replyIntent: 'acknowledge' });
    const dependencies = createDependencies(analysisResult);
    dependencies.settings = new FakeReplySettingsRepository({
      createDrafts: false,
      draftConfidenceThreshold: 0.85,
      emailSignature: '',
      googleEmail: 'candidate@example.com',
      userName: null,
    });

    const output = await createJobSearchEmailAgent(dependencies).run(context(), {
      googleConnectionId: connectionId,
      gmailMessageId: 'message-1',
      gmailThreadId: 'thread-1',
    });

    expect(output).toMatchObject({ draftId: null, result: 'completed' });
    expect(dependencies.llm.requests).toHaveLength(1);
    expect(dependencies.reviews.saved).toHaveLength(0);
    expect(dependencies.gmailDrafts.created).toHaveLength(0);
  });

  test('routes unsafe reply headers to review before generating a reply', async () => {
    const analysisResult = analysis({ needsReply: true, replyIntent: 'acknowledge' });
    const dependencies = createDependencies(analysisResult);
    const emailMessage = { ...message(), subject: '' };
    dependencies.gmail = new FakeGmailReader(emailMessage, {
      id: 'thread-1',
      messages: [emailMessage],
    });
    const drafts = new FakeDraftRepository();
    const gmailDrafts = new FakeGmailDraftWriter();
    const output = await createJobSearchEmailAgent({
      ...dependencies,
      drafts,
      gmailDrafts,
      replyModel: 'test-reply-model',
      settings: new FakeReplySettingsRepository(),
    }).run(context(), {
      googleConnectionId: connectionId,
      gmailMessageId: 'message-1',
      gmailThreadId: 'thread-1',
    });

    expect(output.result).toBe('needs_review');
    expect(dependencies.reviews.saved[0]?.reason).toBe('reply_headers_invalid');
    expect(dependencies.llm.requests).toHaveLength(1);
    expect(drafts.reservations).toHaveLength(0);
    expect(gmailDrafts.created).toHaveLength(0);
  });

  test('does not create a Draft when the user already replied later in the thread', async () => {
    const analysisResult = analysis({ needsReply: true, replyIntent: 'acknowledge' });
    const dependencies = createDependencies(analysisResult);
    const target = message();
    const userReply = {
      ...message(
        'message-2',
        'thread-1',
        'すでに返信しました。',
        new Date('2026-07-19T02:00:00.000Z'),
      ),
      from: 'candidate@example.com',
      replyTo: null,
    };
    dependencies.gmail = new FakeGmailReader(target, {
      id: 'thread-1',
      messages: [target, userReply],
    });

    const output = await createJobSearchEmailAgent(dependencies).run(context(), {
      googleConnectionId: connectionId,
      gmailMessageId: 'message-1',
      gmailThreadId: 'thread-1',
    });

    expect(output.result).toBe('needs_review');
    expect(dependencies.reviews.saved[0]?.reason).toBe('reply_target_stale');
    expect(dependencies.llm.requests).toHaveLength(1);
    expect(dependencies.gmailDrafts.created).toHaveLength(0);
  });

  test('rechecks the thread after reply generation before creating a Draft', async () => {
    const analysisResult = analysis({ needsReply: true, replyIntent: 'acknowledge' });
    const dependencies = createDependencies(analysisResult);
    dependencies.llm = new FakeLlmProvider([
      { data: analysisResult, metadata, status: 'completed' },
      {
        data: { body: '承知しました。', confidence: 0.95, warnings: [] },
        metadata,
        status: 'completed',
      },
    ]);
    const target = message();
    const userReply = {
      ...message(
        'message-2',
        'thread-1',
        '生成中に返信しました。',
        new Date('2026-07-19T02:00:00.000Z'),
      ),
      from: 'candidate@example.com',
      replyTo: null,
    };
    dependencies.gmail = new FakeGmailReader(
      target,
      { id: 'thread-1', messages: [target] },
      { id: 'thread-1', messages: [target, userReply] },
    );

    const output = await createJobSearchEmailAgent(dependencies).run(context(), {
      googleConnectionId: connectionId,
      gmailMessageId: 'message-1',
      gmailThreadId: 'thread-1',
    });

    expect(output.result).toBe('needs_review');
    expect(dependencies.reviews.saved[0]?.reason).toBe('reply_target_stale');
    expect(dependencies.llm.requests).toHaveLength(2);
    expect(dependencies.gmailDrafts.created).toHaveLength(0);
    expect(dependencies.drafts.reservations).toHaveLength(0);
  });

  test('returns an existing Draft without creating a duplicate', async () => {
    const analysisResult = analysis({ needsReply: true, replyIntent: 'acknowledge' });
    const dependencies = createDependencies(analysisResult);
    dependencies.llm = new FakeLlmProvider([
      { data: analysisResult, metadata, status: 'completed' },
      {
        data: { body: '承知しました。', confidence: 0.95, warnings: [] },
        metadata,
        status: 'completed',
      },
    ]);
    const drafts = new FakeDraftRepository();
    drafts.reservation = { draftId: 'existing-draft', status: 'completed' };
    const gmailDrafts = new FakeGmailDraftWriter();
    const output = await createJobSearchEmailAgent({
      ...dependencies,
      drafts,
      gmailDrafts,
      replyModel: 'test-reply-model',
      settings: new FakeReplySettingsRepository(),
    }).run(context(), {
      googleConnectionId: connectionId,
      gmailMessageId: 'message-1',
      gmailThreadId: 'thread-1',
    });

    expect(output).toMatchObject({ draftId: 'existing-draft', result: 'completed' });
    expect(gmailDrafts.found).toHaveLength(0);
    expect(gmailDrafts.created).toHaveLength(0);
    expect(drafts.completed).toHaveLength(0);
  });

  test('recovers an externally created Draft after history persistence was interrupted', async () => {
    const analysisResult = analysis({ needsReply: true, replyIntent: 'acknowledge' });
    const dependencies = createDependencies(analysisResult);
    dependencies.llm = new FakeLlmProvider([
      { data: analysisResult, metadata, status: 'completed' },
      {
        data: { body: '承知しました。', confidence: 0.95, warnings: [] },
        metadata,
        status: 'completed',
      },
    ]);
    dependencies.gmailDrafts.existing = {
      draftId: 'recovered-draft',
      messageId: 'recovered-message',
      threadId: 'thread-1',
    };

    const output = await createJobSearchEmailAgent(dependencies).run(context(), {
      googleConnectionId: connectionId,
      gmailMessageId: 'message-1',
      gmailThreadId: 'thread-1',
    });

    expect(output).toMatchObject({ draftId: 'recovered-draft', result: 'completed' });
    expect(dependencies.gmailDrafts.found).toHaveLength(1);
    expect(dependencies.gmailDrafts.created).toHaveLength(0);
    expect(dependencies.drafts.completed[0]?.gmailDraft.draftId).toBe('recovered-draft');
  });
});
