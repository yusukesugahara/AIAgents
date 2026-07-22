import { describe, expect, test } from 'bun:test';
import { AgentDependencyError } from '@ai-agents/agent-core';
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
  FakeGmailReader,
  FakeStepRepository,
  message,
  metadata,
} from './test-support';

describe('Job Search Email analysis flow', () => {
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
      initialToolChoice: 'required',
      maxToolCalls: 2,
      model: 'test-model',
      promptVersion: jobEmailAnalysisPromptVersion,
      runId: context().runId,
      schemaName: jobEmailAnalysisSchemaName,
      schemaVersion: jobEmailAnalysisSchemaVersion,
    });
    expect(dependencies.llm.requests[0]?.systemPrompt).toContain(jobEmailAnalysisSystemPrompt);
    expect(dependencies.llm.toolExecutions.map((execution) => execution.name)).toEqual([
      'get_email_thread',
      'get_agent_context',
    ]);
    expect(dependencies.analyses.saved[0]).toMatchObject({
      googleConnectionId: connectionId,
      gmailMessageId: 'message-1',
      gmailThreadId: 'thread-1',
      runId: context().runId,
    });
    expect(dependencies.reviews.saved).toHaveLength(0);
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
    const newsletter = message('message-1', 'thread-1', 'ニュースレター');
    dependencies.gmail = new FakeGmailReader(newsletter, {
      id: 'thread-1',
      messages: [newsletter],
    });
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

  test('routes schema-valid but ungrounded model output to review before persistence', async () => {
    const dependencies = createDependencies(
      analysis({ companyName: '本文にない会社', confidence: 1, evidence: ['本文にない内定'] }),
    );
    const output = await createJobSearchEmailAgent(dependencies).run(context(), {
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
    expect(dependencies.reviews.saved[0]?.reason).toBe('analysis_not_grounded');
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
});
