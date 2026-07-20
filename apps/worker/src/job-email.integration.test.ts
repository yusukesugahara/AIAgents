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
  test('persists completed analysis, invocation metadata, and a refusal review', async () => {
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
          registry: createRuntimeAgentRegistry({
            environment: 'test',
            jobSearchEmailAgent,
          }),
          repository: runs,
        }),
        workerId: 'job-email-integration-worker',
      });

      for (const index of [1, 2]) {
        const job = await queue.enqueue({
          agentId: 'job-search-email',
          idempotencyKey: `${idempotencyPrefix}-${index}`,
          input: {
            googleConnectionId: connectionId,
            gmailMessageId: `message-${index}`,
            gmailThreadId: `thread-${index}`,
          },
          triggerType: 'manual',
        });
        jobIds.push(job.id);
      }
      await waitForCompletedJobs(queue, jobIds);

      const completedRun = await runs.getLatestRunForJob(jobIds[0] as string);
      const reviewRun = await runs.getLatestRunForJob(jobIds[1] as string);
      if (!completedRun || !reviewRun) throw new Error('Expected completed integration Runs');
      expect(completedRun).toMatchObject({ status: 'completed' });
      expect(reviewRun).toMatchObject({ status: 'completed' });
      expect(
        await analyses.getLatestByMessage({
          googleConnectionId: connectionId,
          gmailMessageId: 'message-1',
        }),
      ).toMatchObject({ analysis: { category: 'meeting_confirmed' }, runId: completedRun.id });
      expect(gmailDrafts.created).toEqual([
        expect.objectContaining({
          gmailThreadId: 'thread-1',
          inReplyTo: '<message-1@example.com>',
          to: 'recruiter@example.com',
        }),
      ]);

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
             WHERE run_id = ${reviewRun.id}::uuid) AS refused_analysis_count
        `) as Array<{
        draft_count: number;
        invocation_count: number;
        refused_analysis_count: number;
        review_count: number;
      }>;
      expect(countRows[0]).toEqual({
        draft_count: 1,
        invocation_count: 3,
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
