import { describe, expect, test } from 'bun:test';
import { AgentDependencyError, type AgentJob, type EnqueueJobInput } from '@ai-agents/agent-core';
import type { GmailMessagePage } from '@ai-agents/connector-google';
import {
  type GoogleConnectionSummary,
  gmailComposeScope,
  gmailReadonlyScope,
} from '@ai-agents/google-oauth';
import { startGmailPoller } from './gmail-poller';

const now = new Date('2026-07-21T00:00:00.000Z');
const connectionOne: GoogleConnectionSummary = {
  email: 'one@example.com',
  grantedScopes: [gmailReadonlyScope, gmailComposeScope],
  id: '0198c9b2-e7a4-7a35-8d21-111111111111',
  status: 'connected',
  updatedAt: now,
};
const connectionTwo: GoogleConnectionSummary = {
  ...connectionOne,
  email: 'two@example.com',
  id: '0198c9b2-e7a4-7a35-8d21-222222222222',
};
const enabledSettings = {
  createDrafts: true,
  draftConfidenceThreshold: 0.85,
  emailSignature: '',
  googleEmail: 'one@example.com',
  userName: 'Candidate',
};

function job(input: EnqueueJobInput): AgentJob {
  return {
    agentId: input.agentId,
    attempts: 0,
    availableAt: now,
    completedAt: null,
    createdAt: now,
    id: crypto.randomUUID(),
    idempotencyKey: input.idempotencyKey ?? null,
    input: input.input,
    lastError: null,
    lastErrorCode: null,
    lockedAt: null,
    lockedBy: null,
    status: 'queued',
    triggerType: input.triggerType,
  };
}

describe('Gmail poller', () => {
  test('queues up to fifty Gmail references with deterministic idempotency keys', async () => {
    const enqueued: EnqueueJobInput[] = [];
    const listRequests: unknown[] = [];
    const poller = startGmailPoller({
      connections: { listConnections: async () => [connectionOne] },
      gmail: {
        listMessages: async (input) => {
          listRequests.push(input);
          return {
            messages: [
              { id: 'message-1', threadId: 'thread-1' },
              { id: 'message-2', threadId: 'thread-2' },
            ],
            nextPageToken: null,
          };
        },
      },
      intervalMs: 300_000,
      logger: { error() {}, info() {} },
      maxResults: 50,
      query: 'in:inbox newer_than:1d',
      queue: {
        enqueue: async (input) => {
          enqueued.push(input);
          return job(input);
        },
      },
      runImmediately: false,
      settings: { getReplySettings: async () => enabledSettings },
    });

    await poller.pollNow();
    await poller.stop();

    expect(listRequests).toEqual([
      {
        googleConnectionId: connectionOne.id,
        maxResults: 50,
        query: 'in:inbox newer_than:1d',
      },
    ]);
    expect(enqueued).toEqual([
      {
        agentId: 'job-search-email',
        idempotencyKey: `gmail-poll:${connectionOne.id}:message-1`,
        input: {
          gmailMessageId: 'message-1',
          gmailThreadId: 'thread-1',
          googleConnectionId: connectionOne.id,
        },
        retryFailed: false,
        triggerType: 'schedule',
      },
      {
        agentId: 'job-search-email',
        idempotencyKey: `gmail-poll:${connectionOne.id}:message-2`,
        input: {
          gmailMessageId: 'message-2',
          gmailThreadId: 'thread-2',
          googleConnectionId: connectionOne.id,
        },
        retryFailed: false,
        triggerType: 'schedule',
      },
    ]);
  });

  test('follows Gmail pagination so messages beyond the first page are queued', async () => {
    const pageTokens: Array<string | undefined> = [];
    const enqueued: EnqueueJobInput[] = [];
    const poller = startGmailPoller({
      connections: { listConnections: async () => [connectionOne] },
      gmail: {
        listMessages: async (input) => {
          pageTokens.push(input.pageToken);
          return input.pageToken
            ? {
                messages: [{ id: 'message-2', threadId: 'thread-2' }],
                nextPageToken: null,
              }
            : {
                messages: [{ id: 'message-1', threadId: 'thread-1' }],
                nextPageToken: 'page-2',
              };
        },
      },
      intervalMs: 300_000,
      logger: { error() {}, info() {} },
      maxResults: 50,
      query: 'in:inbox newer_than:1d',
      queue: {
        enqueue: async (input) => {
          enqueued.push(input);
          return job(input);
        },
      },
      runImmediately: false,
      settings: { getReplySettings: async () => enabledSettings },
    });

    await poller.pollNow();
    await poller.stop();

    expect(pageTokens).toEqual([undefined, 'page-2']);
    expect(enqueued.map((input) => input.input)).toEqual([
      {
        gmailMessageId: 'message-1',
        gmailThreadId: 'thread-1',
        googleConnectionId: connectionOne.id,
      },
      {
        gmailMessageId: 'message-2',
        gmailThreadId: 'thread-2',
        googleConnectionId: connectionOne.id,
      },
    ]);
  });

  test('caps each connection and selects only the newest message per thread', async () => {
    const enqueued: EnqueueJobInput[] = [];
    let requests = 0;
    const poller = startGmailPoller({
      connections: { listConnections: async () => [connectionOne] },
      gmail: {
        listMessages: async () => {
          requests += 1;
          return {
            messages: [
              { id: 'newest-in-thread', threadId: 'thread-1' },
              { id: 'older-in-thread', threadId: 'thread-1' },
              { id: 'second-thread', threadId: 'thread-2' },
              { id: 'over-cap', threadId: 'thread-3' },
            ],
            nextPageToken: 'page-that-must-not-be-read',
          };
        },
      },
      intervalMs: 300_000,
      logger: { error() {}, info() {} },
      maxMessages: 2,
      maxResults: 50,
      query: 'in:inbox',
      queue: {
        enqueue: async (input) => {
          enqueued.push(input);
          return job(input);
        },
      },
      runImmediately: false,
      settings: { getReplySettings: async () => enabledSettings },
    });

    await poller.pollNow();
    await poller.stop();

    expect(requests).toBe(1);
    expect(enqueued.map((input) => input.input)).toEqual([
      expect.objectContaining({ gmailMessageId: 'newest-in-thread' }),
      expect.objectContaining({ gmailMessageId: 'second-thread' }),
    ]);
  });

  test('skips unavailable or unconfigured connections and isolates account failures', async () => {
    const enqueued: EnqueueJobInput[] = [];
    const errors: Record<string, unknown>[] = [];
    const ineligible: GoogleConnectionSummary = {
      ...connectionOne,
      grantedScopes: [],
      id: '0198c9b2-e7a4-7a35-8d21-333333333333',
    };
    const unconfigured: GoogleConnectionSummary = {
      ...connectionOne,
      id: '0198c9b2-e7a4-7a35-8d21-444444444444',
    };
    const poller = startGmailPoller({
      connections: {
        listConnections: async () => [ineligible, unconfigured, connectionOne, connectionTwo],
      },
      gmail: {
        listMessages: async (input): Promise<GmailMessagePage> => {
          if (input.googleConnectionId === connectionOne.id) {
            throw new AgentDependencyError('PERMISSION_DENIED', false, 'denied');
          }
          return {
            messages: [{ id: 'message-2', threadId: 'thread-2' }],
            nextPageToken: null,
          };
        },
      },
      intervalMs: 300_000,
      logger: { error: (entry) => errors.push(entry), info() {} },
      query: 'in:inbox',
      queue: {
        enqueue: async (input) => {
          enqueued.push(input);
          return job(input);
        },
      },
      runImmediately: false,
      settings: {
        getReplySettings: async (connectionId) =>
          connectionId === unconfigured.id ? null : enabledSettings,
      },
    });

    await poller.pollNow();
    await poller.stop();

    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]?.input).toMatchObject({ googleConnectionId: connectionTwo.id });
    expect(errors).toEqual([{ code: 'PERMISSION_DENIED', event: 'gmail.poll.connection_failed' }]);
  });

  test('prevents overlapping polls and waits for the active poll during shutdown', async () => {
    let listCalls = 0;
    let releaseList: ((page: GmailMessagePage) => void) | undefined;
    const listResult = new Promise<GmailMessagePage>((resolve) => {
      releaseList = resolve;
    });
    const poller = startGmailPoller({
      connections: { listConnections: async () => [connectionOne] },
      gmail: {
        listMessages: async () => {
          listCalls += 1;
          return listResult;
        },
      },
      intervalMs: 300_000,
      logger: { error() {}, info() {} },
      query: 'in:inbox',
      queue: { enqueue: async (input) => job(input) },
      runImmediately: false,
      settings: { getReplySettings: async () => enabledSettings },
    });

    const first = poller.pollNow();
    const second = poller.pollNow();
    expect(second).toBe(first);
    let stopped = false;
    const stop = poller.stop().then(() => {
      stopped = true;
    });
    await Bun.sleep(1);
    expect(stopped).toBe(false);
    releaseList?.({ messages: [], nextPageToken: null });
    await stop;
    await poller.pollNow();

    expect(stopped).toBe(true);
    expect(listCalls).toBe(1);
  });
});
