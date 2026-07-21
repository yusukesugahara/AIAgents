import { describe, expect, test } from 'bun:test';
import { FakeLlmProvider } from '@ai-agents/testing';
import { createJobSearchEmailAgent } from './index';
import {
  analysis,
  connectionId,
  context,
  createDependencies,
  FakeDraftRepository,
  FakeGmailDraftWriter,
  FakeGmailReader,
  FakeReplySettingsRepository,
  FakeStepRepository,
  message,
  metadata,
} from './test-support';

describe('Job Search Email reply flow', () => {
  test('rejects a missing reply model during construction', () => {
    expect(() => createJobSearchEmailAgent({ ...createDependencies(), replyModel: '   ' })).toThrow(
      'OPENAI_REPLY_MODEL is required',
    );
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

  test('creates an editable scheduling Draft when only candidate dates are missing', async () => {
    const analysisResult = analysis({
      category: 'scheduling_request',
      missingRequiredInformation: ['候補日時'],
      needsReply: true,
      replyIntent: 'submit_information',
    });
    const dependencies = createDependencies(analysisResult);
    const gmailDrafts = new FakeGmailDraftWriter();
    const output = await createJobSearchEmailAgent({
      ...dependencies,
      gmailDrafts,
      replyModel: 'test-reply-model',
      settings: new FakeReplySettingsRepository(),
    }).run(context(), {
      googleConnectionId: connectionId,
      gmailMessageId: 'message-1',
      gmailThreadId: 'thread-1',
    });

    expect(output).toMatchObject({ draftId: 'draft-1', result: 'completed' });
    expect(dependencies.llm.requests).toHaveLength(1);
    expect(dependencies.reviews.saved).toHaveLength(0);
    expect(gmailDrafts.created[0]?.body).toContain('採用担当者様');
    expect(gmailDrafts.created[0]?.body).toContain('お世話になっております。山田 太郎です。');
    expect(gmailDrafts.created[0]?.body).toContain('【候補日時を入力してください】');
  });

  test('creates an editable scheduling Draft regardless of the missing-information label', async () => {
    const analysisResult = analysis({
      category: 'scheduling_request',
      missingRequiredInformation: ['希望条件'],
      needsReply: true,
      replyIntent: 'submit_information',
    });
    const dependencies = createDependencies(analysisResult);
    const gmailDrafts = new FakeGmailDraftWriter();

    const output = await createJobSearchEmailAgent({ ...dependencies, gmailDrafts }).run(context(), {
      googleConnectionId: connectionId,
      gmailMessageId: 'message-1',
      gmailThreadId: 'thread-1',
    });

    expect(output).toMatchObject({ draftId: 'draft-1', result: 'completed' });
    expect(gmailDrafts.created[0]?.body).toContain('【候補日時を入力してください】');
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

  test('records why reply Draft creation is not applicable', async () => {
    const analysisResult = analysis({ needsReply: false, replyIntent: 'none' });
    const dependencies = createDependencies(analysisResult);
    const steps = new FakeStepRepository();

    await createJobSearchEmailAgent({ ...dependencies, steps }).run(context(), {
      googleConnectionId: connectionId,
      gmailMessageId: 'message-1',
      gmailThreadId: 'thread-1',
    });

    expect(steps.completed.find((step) => step.stepName === 'GENERATE_REPLY')?.output).toEqual(
      expect.objectContaining({
        applicable: false,
        notApplicableReason: 'reply_not_required',
        outcome: 'not_applicable',
      }),
    );
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
