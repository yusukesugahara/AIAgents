import { describe, expect, test } from 'bun:test';
import { FakeLlmProvider } from '@ai-agents/testing';
import { createJobSearchEmailAgent } from './index';
import {
  analysis,
  connectionId,
  context,
  createDependencies,
  FakeStepRepository,
  metadata,
} from './test-support';

describe('Job Search Email Run step flow', () => {
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
      'CHECK_REPLY_POLICY',
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
      toolCallCount: 2,
      toolNames: ['get_email_thread', 'get_agent_context'],
    });
    expect(steps.completed.at(-1)?.output).toEqual({
      calendarEventId: output.calendarEventId,
      draftId: output.draftId,
      result: 'completed',
    });
  });
});
