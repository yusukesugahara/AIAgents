import { describe, expect, test } from 'bun:test';
import { evaluateJobEmailAnalysis } from './evaluation';
import { analysis, message } from './test-support';

describe('curated Job Email analysis evaluation', () => {
  const goldenCases = [
    {
      expected: analysis(),
      source: message(),
    },
    {
      expected: analysis({
        category: 'scheduling_request',
        evidence: ['面談の候補日時をご返信ください'],
        missingRequiredInformation: ['希望日時'],
        needsReply: true,
        replyIntent: 'submit_information',
      }),
      source: message(
        'message-1',
        'thread-1',
        'Example株式会社 採用担当者より、面談の候補日時をご返信ください',
      ),
    },
    {
      expected: analysis({
        category: 'not_job_related',
        companyName: null,
        contactName: null,
        evidence: ['今週のニュースレター'],
        isJobRelated: false,
      }),
      source: message('message-1', 'thread-1', '今週のニュースレター'),
    },
  ] as const;

  test('passes grounded exact matches across job, scheduling, and unrelated fixtures', () => {
    for (const goldenCase of goldenCases) {
      expect(
        evaluateJobEmailAnalysis(goldenCase.expected, goldenCase.expected, {
          id: goldenCase.source.threadId,
          messages: [goldenCase.source],
        }),
      ).toEqual({ exactMatchRate: 1, failedFields: [], grounded: true, passed: true });
    }
  });

  test('reports semantic drift independently from grounding failures', () => {
    const goldenCase = goldenCases[1];
    const actual = analysis({
      ...goldenCase.expected,
      category: 'general',
      companyName: '本文にない会社',
      needsReply: false,
      replyIntent: 'none',
    });
    const result = evaluateJobEmailAnalysis(goldenCase.expected, actual, {
      id: goldenCase.source.threadId,
      messages: [goldenCase.source],
    });

    expect(result.passed).toBe(false);
    expect(result.grounded).toBe(false);
    expect(result.failedFields).toEqual(['category', 'needsReply', 'replyIntent']);
  });
});
