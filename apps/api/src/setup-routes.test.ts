import { describe, expect, test } from 'bun:test';
import { AgentDependencyError } from '@ai-agents/agent-core';
import { createDevelopmentAgentRegistry } from '@ai-agents/agent-composition';
import type {
  CreatedGmailDraft,
  CreateReplyDraftInput,
  FindReplyDraftInput,
  GmailReader,
} from '@ai-agents/connector-google';
import {
  type GoogleConnectionSummary,
  gmailComposeScope,
  gmailReadonlyScope,
} from '@ai-agents/google-oauth';
import { createApp } from './app';
import { FakeJobQueue, FakeRunRepository, now, runId } from './app.test-support';

const connectionId = '0198be1d-a3a9-7d34-9bc3-123456789acd';
const connection: GoogleConnectionSummary = {
  email: 'person@example.com',
  grantedScopes: [gmailReadonlyScope, gmailComposeScope],
  id: connectionId,
  status: 'connected',
  updatedAt: now,
};

function configuredApp(
  input: {
    readonly connections?: readonly GoogleConnectionSummary[];
    readonly gmail?: Pick<GmailReader, 'getMessage' | 'listMessages'>;
    readonly gmailDrafts?: {
      createReplyDraft: (input: CreateReplyDraftInput) => Promise<CreatedGmailDraft>;
      findReplyDraft: (input: FindReplyDraftInput) => Promise<CreatedGmailDraft | null>;
    };
    readonly jobEmailSettings?: {
      getReplySettings: () => Promise<{
        createDrafts: boolean;
        draftConfidenceThreshold: number;
        emailSignature: string;
        googleEmail: string;
        userName: string | null;
      } | null>;
      saveReplySettings: (settings: {
        createDrafts: boolean;
        draftConfidenceThreshold: number;
        emailSignature: string;
        googleConnectionId: string;
        userName: string;
      }) => Promise<boolean>;
    };
    readonly queue?: FakeJobQueue;
    readonly runs?: FakeRunRepository;
  } = {},
) {
  return createApp({
    googleConnections: {
      listConnections: async () => input.connections ?? [connection],
    },
    ...(input.gmail ? { gmail: input.gmail } : {}),
    ...(input.gmailDrafts ? { gmailDrafts: input.gmailDrafts } : {}),
    logger: { error() {}, info() {} },
    jobEmailSettings: input.jobEmailSettings ?? {
      getReplySettings: async () => ({
        createDrafts: true,
        draftConfidenceThreshold: 0.85,
        emailSignature: 'Person',
        googleEmail: 'person@example.com',
        userName: 'Person',
      }),
      saveReplySettings: async () => true,
    },
    queue: input.queue ?? new FakeJobQueue(),
    registry: createDevelopmentAgentRegistry(),
    requestIdGenerator: () => 'setup-request-id',
    runs: input.runs ?? new FakeRunRepository(),
  });
}

describe('Setup Web routes', () => {
  test('renders OAuth registration actions and connected accounts', async () => {
    const response = await configuredApp().request('/setup');
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('Content-Security-Policy')).toContain("form-action 'self'");
    expect(response.headers.get('Set-Cookie')).toContain('ai_agents_setup_csrf=');
    expect(body).toContain('/auth/google');
    expect(body).toContain('/auth/google/compose');
    expect(body).toContain('/auth/google/calendar');
    expect(body).toContain('person@example.com');
    expect(body).toContain(connectionId);
    expect(body).toContain('/setup/reply-settings');
    expect(body).toContain('/setup/scheduled-poll');
    expect(body).toContain('今すぐ定期実行を実行');
    expect(body).toContain('/setup/scheduled-poll-reset');
    expect(body).toContain('既存ジョブをリセットして再実行');
    expect(body).toContain('name="_csrf"');
    expect(body).not.toContain('AI Agent テスト実行');
    expect(body).not.toContain('Gmail Message ID');
    expect(body).not.toContain('encrypted');
  });

  test('saves validated reply Draft settings for a connected account', async () => {
    const saved: unknown[] = [];
    const app = configuredApp({
      jobEmailSettings: {
        getReplySettings: async () => null,
        saveReplySettings: async (settings) => {
          saved.push(settings);
          return true;
        },
      },
    });
    const response = await app.request('/setup/reply-settings', {
      body: new URLSearchParams({
        createDrafts: 'true',
        draftConfidenceThreshold: '0.9',
        emailSignature: 'Person\nTokyo',
        googleConnectionId: connectionId,
        userName: 'Person',
      }),
      headers: { Origin: 'http://localhost' },
      method: 'POST',
    });

    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(
      `/setup?connectionId=${connectionId}&settings=saved`,
    );
    expect(saved).toEqual([
      {
        createDrafts: true,
        draftConfidenceThreshold: 0.9,
        emailSignature: 'Person\nTokyo',
        googleConnectionId: connectionId,
        userName: 'Person',
      },
    ]);
  });

  test('enqueues a validated Job Search Email test run and redirects to its status', async () => {
    const queue = new FakeJobQueue();
    const app = configuredApp({ queue });
    const response = await app.request('/setup/test-run', {
      body: new URLSearchParams({
        gmailMessageId: 'message-1',
        gmailThreadId: 'thread-1',
        googleConnectionId: connectionId,
        idempotencyKey: 'setup-test-1',
      }),
      headers: { Origin: 'http://localhost' },
      method: 'POST',
    });

    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(
      '/setup?jobId=0198be1d-a3a9-7d34-9bc3-123456789abc',
    );
    expect(queue.enqueued).toEqual([
      {
        agentId: 'job-search-email',
        idempotencyKey: 'setup-test-1',
        input: {
          gmailMessageId: 'message-1',
          gmailThreadId: 'thread-1',
          googleConnectionId: connectionId,
        },
        triggerType: 'manual',
      },
    ]);
  });

  test('enqueues the same Jobs as the scheduled Gmail poll from setup', async () => {
    const queue = new FakeJobQueue();
    const app = configuredApp({
      gmail: {
        getMessage: async () => {
          throw new Error('getMessage is not used by a scheduled poll');
        },
        listMessages: async () => ({
          messages: [
            { id: 'message-1', threadId: 'thread-1' },
            { id: 'message-2', threadId: 'thread-2' },
          ],
          nextPageToken: null,
        }),
      },
      queue,
    });

    const response = await app.request('/setup/scheduled-poll', {
      body: new URLSearchParams(),
      headers: { Origin: 'http://localhost' },
      method: 'POST',
    });

    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(
      '/setup?scheduledPoll=completed&connectionFailures=0&eligibleConnections=1&enqueueFailures=0&jobRequestsAccepted=2&messagesFound=2',
    );
    expect(queue.enqueued).toEqual([
      {
        agentId: 'job-search-email',
        idempotencyKey: `gmail-poll:${connectionId}:message-1`,
        input: {
          gmailMessageId: 'message-1',
          gmailThreadId: 'thread-1',
          googleConnectionId: connectionId,
        },
        triggerType: 'schedule',
      },
      {
        agentId: 'job-search-email',
        idempotencyKey: `gmail-poll:${connectionId}:message-2`,
        input: {
          gmailMessageId: 'message-2',
          gmailThreadId: 'thread-2',
          googleConnectionId: connectionId,
        },
        triggerType: 'schedule',
      },
    ]);

    const result = await app.request(response.headers.get('location') ?? '/setup');
    expect(await result.text()).toContain('キュー登録要求: 2件');
  });

  test('resets poll idempotency without deleting prior history and queues a rerun', async () => {
    const queue = new FakeJobQueue();
    const app = configuredApp({
      gmail: {
        getMessage: async () => {
          throw new Error('getMessage is not used by a scheduled poll');
        },
        listMessages: async () => ({
          messages: [{ id: 'message-1', threadId: 'thread-1' }],
          nextPageToken: null,
        }),
      },
      queue,
    });

    const response = await app.request('/setup/scheduled-poll-reset', {
      body: new URLSearchParams(),
      headers: { Origin: 'http://localhost' },
      method: 'POST',
    });

    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toContain('scheduledPoll=reset-completed');
    expect(queue.enqueued).toHaveLength(1);
    expect(queue.enqueued[0]).toMatchObject({
      agentId: 'job-search-email',
      idempotencyKey: expect.stringMatching(
        new RegExp(`^gmail-poll-reset:[0-9a-f-]{36}:${connectionId}:message-1$`, 'u'),
      ),
      input: {
        gmailMessageId: 'message-1',
        gmailThreadId: 'thread-1',
        googleConnectionId: connectionId,
      },
      triggerType: 'schedule',
    });

    const result = await app.request(response.headers.get('location') ?? '/setup');
    expect(await result.text()).toContain('既存ジョブをリセットして再実行しました');
  });

  test('lists recent Gmail metadata without rendering message bodies', async () => {
    let requestedMaxResults: number | undefined;
    const response = await configuredApp({
      gmail: {
        getMessage: async () => ({
          bodyText: 'private email body',
          bodyTruncated: false,
          cc: [],
          from: 'Recruiter <recruiter@example.com>',
          id: 'message-1',
          inReplyTo: null,
          labelIds: ['INBOX'],
          messageId: '<message-1@example.com>',
          references: [],
          replyTo: null,
          sentAt: now,
          subject: 'Interview invitation',
          threadId: 'thread-1',
          to: ['person@example.com'],
        }),
        listMessages: async (input) => {
          requestedMaxResults = input.maxResults;
          return {
            messages: [{ id: 'message-1', threadId: 'thread-1' }],
            nextPageToken: null,
          };
        },
      },
    }).request(`/setup?connectionId=${connectionId}`);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(requestedMaxResults).toBe(50);
    expect(body).toContain('Recruiter &lt;recruiter@example.com&gt;');
    expect(body).toContain('Interview invitation');
    expect(body).toContain('value="message-1"');
    expect(body).toContain('/setup/draft-test');
    expect(body).toContain('テスト下書きを作成');
    expect(body).not.toContain('AI Agent テスト実行');
    expect(body).not.toContain('Gmail Message ID');
    expect(body).not.toContain('private email body');
  });

  test('limits concurrent Gmail metadata reads to avoid rate limits', async () => {
    let activeReads = 0;
    let maximumActiveReads = 0;
    const response = await configuredApp({
      gmail: {
        getMessage: async (input) => {
          activeReads += 1;
          maximumActiveReads = Math.max(maximumActiveReads, activeReads);
          await Promise.resolve();
          activeReads -= 1;
          return {
            bodyText: '',
            bodyTruncated: false,
            cc: [],
            from: 'Recruiter <recruiter@example.com>',
            id: input.gmailMessageId,
            inReplyTo: null,
            labelIds: ['INBOX'],
            messageId: null,
            references: [],
            replyTo: null,
            sentAt: now,
            subject: 'Interview invitation',
            threadId: `thread-${input.gmailMessageId}`,
            to: ['person@example.com'],
          };
        },
        listMessages: async () => ({
          messages: Array.from({ length: 7 }, (_, index) => ({
            id: `message-${index}`,
            threadId: `thread-${index}`,
          })),
          nextPageToken: null,
        }),
      },
    }).request(`/setup?connectionId=${connectionId}`);

    expect(response.status).toBe(200);
    expect(maximumActiveReads).toBe(5);
  });

  test('creates a fixed unsent Gmail Draft from a recent message', async () => {
    const created: CreateReplyDraftInput[] = [];
    const app = configuredApp({
      gmail: {
        getMessage: async () => ({
          bodyText: 'private email body',
          bodyTruncated: false,
          cc: [],
          from: 'Recruiter <recruiter@example.com>',
          id: 'message-1',
          inReplyTo: null,
          labelIds: ['INBOX'],
          messageId: '<message-1@example.com>',
          references: ['<previous@example.com>'],
          replyTo: null,
          sentAt: now,
          subject: 'Interview invitation',
          threadId: 'thread-1',
          to: ['person@example.com'],
        }),
        listMessages: async () => ({ messages: [], nextPageToken: null }),
      },
      gmailDrafts: {
        createReplyDraft: async (input) => {
          created.push(input);
          return { draftId: 'draft-1', messageId: 'draft-message-1', threadId: 'thread-1' };
        },
        findReplyDraft: async () => null,
      },
    });
    const response = await app.request('/setup/draft-test', {
      body: new URLSearchParams({
        gmailMessageId: 'message-1',
        gmailThreadId: 'thread-1',
        googleConnectionId: connectionId,
      }),
      headers: { Origin: 'http://localhost' },
      method: 'POST',
    });

    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(
      `/setup?connectionId=${connectionId}&draftId=draft-1&draftStatus=created`,
    );
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      from: 'person@example.com',
      gmailThreadId: 'thread-1',
      googleConnectionId: connectionId,
      inReplyTo: '<message-1@example.com>',
      references: ['<previous@example.com>'],
      subject: 'Re: Interview invitation',
      to: 'recruiter@example.com',
    });
    expect(created[0]?.body).toContain('下書き作成テスト');
    expect(created[0]?.body).not.toContain('private email body');

    const result = await app.request(response.headers.get('location') ?? '/setup');
    expect(await result.text()).toContain('Gmailにテスト下書きを作成しました');
  });

  test('reuses the existing test Draft instead of creating a duplicate', async () => {
    let createCalls = 0;
    const app = configuredApp({
      gmail: {
        getMessage: async () => ({
          bodyText: '',
          bodyTruncated: false,
          cc: [],
          from: 'Recruiter <recruiter@example.com>',
          id: 'message-1',
          inReplyTo: null,
          labelIds: ['INBOX'],
          messageId: '<message-1@example.com>',
          references: [],
          replyTo: 'Reply Desk <reply@example.com>',
          sentAt: now,
          subject: 'Re: Interview invitation',
          threadId: 'thread-1',
          to: ['person@example.com'],
        }),
        listMessages: async () => ({ messages: [], nextPageToken: null }),
      },
      gmailDrafts: {
        createReplyDraft: async () => {
          createCalls += 1;
          return { draftId: 'unexpected', messageId: 'unexpected', threadId: 'thread-1' };
        },
        findReplyDraft: async () => ({
          draftId: 'draft-existing',
          messageId: 'draft-message-existing',
          threadId: 'thread-1',
        }),
      },
    });
    const response = await app.request('/setup/draft-test', {
      body: new URLSearchParams({
        gmailMessageId: 'message-1',
        gmailThreadId: 'thread-1',
        googleConnectionId: connectionId,
      }),
      headers: { Origin: 'http://localhost' },
      method: 'POST',
    });

    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toContain('draftStatus=reused');
    expect(createCalls).toBe(0);
  });

  test('renders a safe configuration warning when the Gmail Reader is unavailable', async () => {
    const response = await configuredApp().request(`/setup?connectionId=${connectionId}`);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain('GMAIL_READER_UNAVAILABLE');
    expect(body).not.toContain('INTERNAL_ERROR');
  });

  test('advises retrying instead of reauthorizing after a Gmail rate limit', async () => {
    const response = await configuredApp({
      gmail: {
        getMessage: async () => {
          throw new Error('not reached');
        },
        listMessages: async () => {
          throw new AgentDependencyError('RATE_LIMITED', true, 'Gmail rate limit was exceeded');
        },
      },
    }).request(`/setup?connectionId=${connectionId}`);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain('RATE_LIMITED');
    expect(body).toContain('数分待ってから再試行してください');
    expect(body).not.toContain('権限を再登録してお試しください');
  });

  test('rejects cross-origin submissions and unregistered connections', async () => {
    const form = new URLSearchParams({
      gmailMessageId: 'message-1',
      gmailThreadId: 'thread-1',
      googleConnectionId: connectionId,
    });
    const crossOrigin = await configuredApp().request('/setup/test-run', {
      body: form,
      headers: { Origin: 'https://attacker.example' },
      method: 'POST',
    });
    expect(crossOrigin.status).toBe(400);

    const unregistered = await configuredApp({ connections: [] }).request('/setup/test-run', {
      body: form,
      headers: { Origin: 'http://localhost' },
      method: 'POST',
    });
    expect(unregistered.status).toBe(400);
  });

  test('accepts browser same-origin forms when Docker URL reconstruction differs', async () => {
    const form = new URLSearchParams({
      gmailMessageId: 'message-1',
      gmailThreadId: 'thread-1',
      googleConnectionId: connectionId,
    });
    const hostMatched = await configuredApp().request('/setup/test-run', {
      body: form,
      headers: { Host: 'localhost:4000', Origin: 'http://localhost:4000' },
      method: 'POST',
    });
    const fetchMetadataMatched = await configuredApp().request('/setup/test-run', {
      body: form,
      headers: { 'Sec-Fetch-Site': 'same-origin' },
      method: 'POST',
    });

    expect(hostMatched.status).toBe(303);
    expect(fetchMetadataMatched.status).toBe(303);
  });

  test('accepts a valid double-submit CSRF token when the browser Origin is opaque', async () => {
    const app = configuredApp();
    const setup = await app.request('/setup');
    const cookie = setup.headers.get('Set-Cookie');
    const token = cookie?.match(/ai_agents_setup_csrf=([a-f0-9]{32})/u)?.[1];
    expect(token).toBeDefined();
    const response = await app.request('/setup/test-run', {
      body: new URLSearchParams({
        _csrf: token ?? '',
        gmailMessageId: 'message-1',
        gmailThreadId: 'thread-1',
        googleConnectionId: connectionId,
      }),
      headers: {
        Cookie: `ai_agents_setup_csrf=${token}`,
        Origin: 'null',
      },
      method: 'POST',
    });

    expect(response.status).toBe(303);
  });

  test('requires Gmail Draft permission and enabled reply settings before a test run', async () => {
    const form = new URLSearchParams({
      gmailMessageId: 'message-1',
      gmailThreadId: 'thread-1',
      googleConnectionId: connectionId,
    });
    const withoutPermission = await configuredApp({
      connections: [{ ...connection, grantedScopes: [gmailReadonlyScope] }],
    }).request('/setup/test-run', {
      body: form,
      headers: { Origin: 'http://localhost' },
      method: 'POST',
    });
    const withoutSettings = await configuredApp({
      jobEmailSettings: {
        getReplySettings: async () => null,
        saveReplySettings: async () => true,
      },
    }).request('/setup/test-run', {
      body: form,
      headers: { Origin: 'http://localhost' },
      method: 'POST',
    });

    expect(withoutPermission.status).toBe(400);
    expect(await withoutPermission.json()).toMatchObject({
      error: { message: 'Gmail Draft permission is required' },
    });
    expect(withoutSettings.status).toBe(400);
    expect(await withoutSettings.json()).toMatchObject({
      error: { message: 'Configure reply Draft settings before testing' },
    });
  });

  test('shows queued Job state and links its latest Run', async () => {
    const queue = new FakeJobQueue();
    const runs = new FakeRunRepository();
    const job = await queue.enqueue({
      agentId: 'job-search-email',
      input: {},
      triggerType: 'manual',
    });
    runs.runs.set(runId, {
      agentId: 'job-search-email',
      completedAt: now,
      errorCode: null,
      id: runId,
      jobId: job.id,
      startedAt: now,
      status: 'completed',
      triggerType: 'manual',
    });

    const response = await configuredApp({ queue, runs }).request(`/setup?jobId=${job.id}`);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain(job.id);
    expect(body).toContain(`/history/runs/${runId}`);
  });

  test('keeps setup and test execution behind the configured API authentication boundary', async () => {
    const app = createApp({
      accessToken: 'expected-token',
      googleConnections: { listConnections: async () => [connection] },
      logger: { error() {}, info() {} },
      queue: new FakeJobQueue(),
      registry: createDevelopmentAgentRegistry(),
    });

    expect((await app.request('/setup')).status).toBe(401);
    expect(
      (
        await app.request('/setup/test-run', {
          body: new URLSearchParams({
            gmailMessageId: 'message-1',
            gmailThreadId: 'thread-1',
            googleConnectionId: connectionId,
          }),
          headers: { Origin: 'http://localhost' },
          method: 'POST',
        })
      ).status,
    ).toBe(401);
  });
});
