import { describe, expect, test } from 'bun:test';
import { createRuntimeAgentRegistry } from '@ai-agents/agent-composition';
import { AgentRunner } from '@ai-agents/agent-core';
import type {
  CreatedGmailDraft,
  CreatedGoogleCalendarEvent,
  EmailMessage,
  EmailThread,
  GmailDraftWriter,
  GmailReader,
  GoogleCalendarClient,
} from '@ai-agents/connector-google';
import {
  createDatabaseConnection,
  PostgresAgentRunRepository,
  PostgresJobEmailAnalysisRepository,
  PostgresJobEmailCalendarEventRepository,
  PostgresJobEmailDraftRepository,
  PostgresJobEmailReviewRequestRepository,
  PostgresJobEmailSettingsRepository,
  PostgresJobQueue,
  PostgresLlmInvocationRepository,
} from '@ai-agents/database';
import { createJobSearchEmailAgent, type JobEmailAnalysis } from '@ai-agents/job-search-email';
import {
  OpenAiLlmProvider,
  type OpenAiStructuredClient,
  type OpenAiStructuredResponse,
} from '@ai-agents/llm';
import { createApp } from '../../api/src/app';
import { startWorker, type WorkerHandle } from './worker';

const integrationEnabled = process.env.INTEGRATION_TESTS === '1';
const databaseUrl = process.env.DATABASE_URL;
const integrationDatabaseUrl = databaseUrl ?? '';

const completedAnalysis: JobEmailAnalysis = {
  isJobRelated: true,
  category: 'meeting_confirmed',
  companyName: 'Example株式会社',
  contactName: '採用担当者',
  needsReply: true,
  replyIntent: 'acknowledge',
  missingRequiredInformation: [],
  meeting: {
    isConfirmed: true,
    startAt: '2026-07-21T10:00:00+09:00',
    endAt: '2026-07-21T11:00:00+09:00',
    timezone: 'Asia/Tokyo',
    url: 'https://meet.example.com/interview',
    urlType: 'web_meeting',
  },
  confidence: 0.98,
  evidence: ['7月21日10時より面接を実施します'],
};

class FakeGmailReader implements Pick<GmailReader, 'getMessage' | 'getThread'> {
  async getMessage(input: {
    readonly googleConnectionId: string;
    readonly gmailMessageId: string;
  }): Promise<EmailMessage> {
    return message(input.gmailMessageId);
  }

  async getThread(input: {
    readonly googleConnectionId: string;
    readonly gmailThreadId: string;
  }): Promise<EmailThread> {
    const messageId = input.gmailThreadId.replace('thread-', 'message-');
    return { id: input.gmailThreadId, messages: [message(messageId)] };
  }
}

class FakeGmailDraftWriter implements GmailDraftWriter {
  readonly created: Parameters<GmailDraftWriter['createReplyDraft']>[0][] = [];

  async findReplyDraft(): Promise<null> {
    return null;
  }

  async createReplyDraft(
    input: Parameters<GmailDraftWriter['createReplyDraft']>[0],
  ): Promise<CreatedGmailDraft> {
    this.created.push(input);
    return {
      draftId: 'worker-draft-1',
      messageId: 'worker-draft-message-1',
      threadId: input.gmailThreadId,
    };
  }
}

class FakeGoogleCalendar implements GoogleCalendarClient {
  readonly created: Parameters<GoogleCalendarClient['createEvent']>[0][] = [];

  async createEvent(
    input: Parameters<GoogleCalendarClient['createEvent']>[0],
  ): Promise<CreatedGoogleCalendarEvent> {
    this.created.push(input);
    return { eventId: input.eventId };
  }

  async findConflictingEvents(): Promise<[]> {
    return [];
  }

  async findEvent(): Promise<null> {
    return null;
  }
}

class FakeStructuredClient implements OpenAiStructuredClient {
  readonly responses: OpenAiStructuredResponse[] = [
    {
      model: 'fake-analysis-model',
      output: [{ content: [{ parsed: completedAnalysis, type: 'output_text' }], type: 'message' }],
      status: 'completed',
      usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
    },
    {
      model: 'fake-reply-model',
      output: [
        {
          content: [
            {
              parsed: { body: 'ご連絡ありがとうございます。', confidence: 0.98, warnings: [] },
              type: 'output_text',
            },
          ],
          type: 'message',
        },
      ],
      status: 'completed',
      usage: { input_tokens: 80, output_tokens: 20, total_tokens: 100 },
    },
    {
      model: 'fake-analysis-model',
      output: [{ content: [{ refusal: 'Policy refusal', type: 'refusal' }], type: 'message' }],
      status: 'completed',
      usage: { input_tokens: 80, output_tokens: 5, total_tokens: 85 },
    },
    {
      model: 'fake-analysis-model',
      output: [{ content: [{ parsed: completedAnalysis, type: 'output_text' }], type: 'message' }],
      status: 'completed',
      usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
    },
    {
      model: 'fake-reply-model',
      output: [
        {
          content: [
            {
              parsed: { body: 'ご連絡ありがとうございます。', confidence: 0.98, warnings: [] },
              type: 'output_text',
            },
          ],
          type: 'message',
        },
      ],
      status: 'completed',
      usage: { input_tokens: 80, output_tokens: 20, total_tokens: 100 },
    },
  ];

  async parse(): Promise<OpenAiStructuredResponse> {
    const response = this.responses.shift();
    if (!response) throw new Error('No Fake OpenAI response remains');
    return response;
  }
}

function message(id: string): EmailMessage {
  return {
    id,
    threadId: id.replace('message-', 'thread-'),
    labelIds: ['INBOX'],
    from: '採用担当 <recruiter@example.com>',
    to: ['candidate@example.com'],
    cc: [],
    subject: '面接日時確定のご案内',
    sentAt: new Date('2026-07-19T01:00:00.000Z'),
    messageId: `<${id}@example.com>`,
    inReplyTo: null,
    replyTo: null,
    references: [],
    bodyText: '7月21日10時より面接を実施します。https://meet.example.com/interview',
    bodyTruncated: false,
  };
}

async function waitForCompletedJobs(queue: PostgresJobQueue, jobIds: readonly string[]) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const jobs = await Promise.all(jobIds.map((jobId) => queue.get(jobId)));
    if (jobs.every((job) => job?.status === 'completed')) return jobs;
    await Bun.sleep(10);
  }
  throw new Error('Timed out waiting for Job Search Email integration Jobs');
}

describe.skipIf(!integrationEnabled || !databaseUrl)('Job Search Email Worker integration', () => {
  test('runs API-to-Worker flows and preserves external idempotency across re-execution', async () => {
    const database = createDatabaseConnection({ databaseUrl: integrationDatabaseUrl });
    const queue = new PostgresJobQueue(database);
    const runs = new PostgresAgentRunRepository(database);
    const analyses = new PostgresJobEmailAnalysisRepository(database);
    const calendarEvents = new PostgresJobEmailCalendarEventRepository(database);
    const drafts = new PostgresJobEmailDraftRepository(database);
    const reviews = new PostgresJobEmailReviewRequestRepository(database);
    const settings = new PostgresJobEmailSettingsRepository(database);
    const gmailDrafts = new FakeGmailDraftWriter();
    const calendar = new FakeGoogleCalendar();
    const email = `worker-analysis-${crypto.randomUUID()}@example.com`;
    const idempotencyPrefix = `worker-analysis-${crypto.randomUUID()}`;
    let worker: WorkerHandle | undefined;
    let connectionId = '';
    const jobIds: string[] = [];

    try {
      const [connection] = (await database.client`
          WITH inserted_user AS (
            INSERT INTO users (email) VALUES (${email}) RETURNING id
          ), configured_settings AS (
            INSERT INTO agent_settings (user_id, agent_id, enabled, settings_json)
            SELECT id, 'job-search-email', true,
              '{"createDrafts":true,"draftConfidenceThreshold":0.9,"emailSignature":"候補者","userName":"候補者"}'::jsonb
            FROM inserted_user
            RETURNING user_id
          )
          INSERT INTO connections (
            user_id, type, google_email, encrypted_refresh_token, granted_scopes, status
          )
          SELECT
            user_id, 'google', ${email}, 'fake-encrypted-token',
            ARRAY[
              'https://www.googleapis.com/auth/gmail.readonly',
              'https://www.googleapis.com/auth/gmail.compose'
            ], 'connected'
          FROM configured_settings
          RETURNING id
        `) as Array<{ id: string }>;
      if (!connection) throw new Error('Expected a test Google connection');
      connectionId = connection.id;

      const llm = new OpenAiLlmProvider({
        client: new FakeStructuredClient(),
        invocationRepository: new PostgresLlmInvocationRepository(database),
      });
      const jobSearchEmailAgent = createJobSearchEmailAgent({
        analyses,
        calendar,
        calendarEvents,
        drafts,
        gmail: new FakeGmailReader(),
        gmailDrafts,
        llm,
        model: 'fake-analysis-model',
        replyModel: 'fake-reply-model',
        reviews,
        settings,
        steps: runs,
      });
      const registry = createRuntimeAgentRegistry({
        environment: 'test',
        jobSearchEmailAgent,
      });
      const app = createApp({
        logger: { error() {}, info() {} },
        queue,
        registry,
        runs,
      });
      worker = await startWorker({
        database: {
          close: async () => {},
          isReady: database.isReady,
          isSchemaReady: database.isSchemaReady,
        },
        pollIntervalMs: 5,
        queue,
        runner: new AgentRunner({
          registry,
          repository: runs,
        }),
        workerId: 'job-email-integration-worker',
      });

      for (const [index, gmailMessageId] of [
        [1, 'message-1'],
        [2, 'message-2'],
        [3, 'message-1'],
      ] as const) {
        const response = await app.request('/agents/job-search-email/runs', {
          body: JSON.stringify({
            idempotencyKey: `${idempotencyPrefix}-${index}`,
            input: {
              googleConnectionId: connectionId,
              gmailMessageId,
              gmailThreadId: gmailMessageId.replace('message-', 'thread-'),
            },
          }),
          headers: { 'Content-Type': 'application/json' },
          method: 'POST',
        });
        expect(response.status).toBe(202);
        const body = (await response.json()) as { jobId: string };
        jobIds.push(body.jobId);
      }
      await waitForCompletedJobs(queue, jobIds);

      const completedRun = await runs.getLatestRunForJob(jobIds[0] as string);
      const reviewRun = await runs.getLatestRunForJob(jobIds[1] as string);
      const replayRun = await runs.getLatestRunForJob(jobIds[2] as string);
      if (!completedRun || !reviewRun || !replayRun)
        throw new Error('Expected completed integration Runs');
      expect(completedRun).toMatchObject({ status: 'completed' });
      expect(reviewRun).toMatchObject({ status: 'completed' });
      expect(replayRun).toMatchObject({ status: 'completed' });
      expect(
        await analyses.getLatestByMessage({
          googleConnectionId: connectionId,
          gmailMessageId: 'message-1',
        }),
      ).toMatchObject({ analysis: { category: 'meeting_confirmed' }, runId: replayRun.id });
      expect(gmailDrafts.created).toEqual([
        expect.objectContaining({
          gmailThreadId: 'thread-1',
          inReplyTo: '<message-1@example.com>',
          to: 'recruiter@example.com',
        }),
      ]);
      expect(calendar.created).toHaveLength(1);
      const completedRunResponse = await app.request(`/runs/${completedRun.id}`);
      expect(completedRunResponse.status).toBe(200);
      const completedRunBody = (await completedRunResponse.json()) as {
        run: {
          output: { calendarEventId: string | null; draftId: string | null; result: string } | null;
          status: string;
          steps: Array<{ errorCode: string | null; status: string; stepName: string }>;
        };
      };
      expect(completedRunBody.run.status).toBe('completed');
      expect(completedRunBody.run.output).toMatchObject({
        draftId: 'worker-draft-1',
        result: 'completed',
      });
      expect(completedRunBody.run.output?.calendarEventId).toMatch(/^aia[0-9a-f]{64}$/u);
      expect(completedRunBody.run.steps).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ status: 'succeeded', stepName: 'CREATE_DRAFT' }),
          expect.objectContaining({ status: 'succeeded', stepName: 'CREATE_CALENDAR_EVENT' }),
        ]),
      );
      expect((await runs.getSteps(completedRun.id)).map((step) => step.stepName)).toEqual([
        'FETCH_EMAIL_THREAD',
        'ANALYZE_EMAIL',
        'GENERATE_REPLY',
        'CHECK_CALENDAR_POLICY',
        'CREATE_DRAFT',
        'CREATE_CALENDAR_EVENT',
        'COMPLETE',
      ]);
      expect((await runs.getSteps(replayRun.id)).map((step) => step.stepName)).toEqual([
        'FETCH_EMAIL_THREAD',
        'ANALYZE_EMAIL',
        'GENERATE_REPLY',
        'CHECK_CALENDAR_POLICY',
        'CREATE_DRAFT',
        'CREATE_CALENDAR_EVENT',
        'COMPLETE',
      ]);
      expect(await runs.getSteps(reviewRun.id)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ stepName: 'FETCH_EMAIL_THREAD', status: 'succeeded' }),
          expect.objectContaining({ stepName: 'ANALYZE_EMAIL', status: 'succeeded' }),
          expect.objectContaining({ stepName: 'COMPLETE', status: 'succeeded' }),
        ]),
      );
      const reviewRunResponse = await app.request(`/runs/${reviewRun.id}`);
      expect(reviewRunResponse.status).toBe(200);
      expect(await reviewRunResponse.json()).toMatchObject({
        run: {
          output: { calendarEventId: null, draftId: null, result: 'needs_review' },
          steps: [
            expect.objectContaining({ stepName: 'FETCH_EMAIL_THREAD', status: 'succeeded' }),
            expect.objectContaining({ stepName: 'ANALYZE_EMAIL', status: 'succeeded' }),
            expect.objectContaining({
              output: { result: 'needs_review', reviewReason: 'llm_refusal' },
              stepName: 'COMPLETE',
              status: 'succeeded',
            }),
          ],
        },
      });

      const countRows = (await database.client`
          SELECT
            (SELECT COUNT(*)::int FROM llm_invocations
             WHERE run_id IN (${completedRun.id}::uuid, ${reviewRun.id}::uuid)) AS invocation_count,
            (SELECT COUNT(*)::int FROM job_email_drafts
             WHERE run_id = ${completedRun.id}::uuid
               AND status = 'completed'
               AND gmail_draft_id = 'worker-draft-1') AS draft_count,
            (SELECT COUNT(*)::int FROM review_requests
             WHERE run_id = ${reviewRun.id}::uuid AND reason = 'llm_refusal') AS review_count,
            (SELECT COUNT(*)::int FROM job_email_analyses
             WHERE run_id = ${reviewRun.id}::uuid) AS refused_analysis_count,
            (SELECT COUNT(*)::int FROM job_calendar_events
             WHERE google_connection_id = ${connectionId}::uuid
               AND gmail_message_id = 'message-1'
               AND status = 'completed') AS calendar_count
        `) as Array<{
        calendar_count: number;
        draft_count: number;
        invocation_count: number;
        refused_analysis_count: number;
        review_count: number;
      }>;
      expect(countRows[0]).toEqual({
        calendar_count: 1,
        draft_count: 1,
        invocation_count: 5,
        refused_analysis_count: 0,
        review_count: 1,
      });
    } finally {
      await worker?.stop();
      for (const jobId of jobIds) {
        await database.client`DELETE FROM agent_jobs WHERE id = ${jobId}::uuid`;
      }
      if (connectionId) {
        await database.client`DELETE FROM connections WHERE id = ${connectionId}::uuid`;
      }
      await database.client`DELETE FROM users WHERE email = ${email}`;
      await database.close();
    }
  });
});
