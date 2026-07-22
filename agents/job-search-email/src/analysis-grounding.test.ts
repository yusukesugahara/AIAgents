import { describe, expect, test } from 'bun:test';
import { validateAnalysisGrounding } from './analysis-grounding';
import { analysis, message } from './test-support';

describe('analysis grounding safety evaluation', () => {
  test('accepts facts and evidence present in the validated thread', () => {
    const email = message();
    expect(
      validateAnalysisGrounding(analysis(), { id: email.threadId, messages: [email] }),
    ).toEqual({ issues: [], valid: true });
  });

  test('rejects hallucinated entities and evidence regardless of model confidence', () => {
    const email = message();
    const result = validateAnalysisGrounding(
      analysis({
        companyName: '存在しない会社',
        confidence: 1,
        evidence: ['本文に存在しない採用決定'],
      }),
      { id: email.threadId, messages: [email] },
    );

    expect(result.valid).toBe(false);
    expect(result.issues).toEqual(['company_not_found', 'evidence_not_found']);
  });

  test('normalizes width, case, and whitespace without accepting partial inventions', () => {
    const email = message(
      'message-1',
      'thread-1',
      'EXAMPLE株式会社\n採用担当者より、面談は2026年7月25日 10時〜11時、URL: https://example.com/meet',
    );
    const result = validateAnalysisGrounding(
      analysis({
        category: 'meeting_confirmed',
        evidence: ['example株式会社 採用担当者より'],
        meeting: {
          isConfirmed: true,
          startAt: '2026-07-25T10:00:00+09:00',
          endAt: '2026-07-25T11:00:00+09:00',
          timezone: 'Asia/Tokyo',
          url: 'https://example.com/meet',
          urlType: 'web_meeting',
        },
      }),
      { id: email.threadId, messages: [email] },
    );

    expect(result).toEqual({ issues: [], valid: true });
  });

  test('rejects a confirmed meeting whose extracted time is absent from the source', () => {
    const email = message();
    const result = validateAnalysisGrounding(
      analysis({
        category: 'meeting_confirmed',
        meeting: {
          isConfirmed: true,
          startAt: '2026-07-22T15:00:00+09:00',
          endAt: '2026-07-22T16:00:00+09:00',
          timezone: 'Asia/Tokyo',
          url: 'https://meet.example.com/interview',
          urlType: 'web_meeting',
        },
      }),
      { id: email.threadId, messages: [email] },
    );

    expect(result.valid).toBe(false);
    expect(result.issues).toContain('meeting_time_not_found');
  });
});
