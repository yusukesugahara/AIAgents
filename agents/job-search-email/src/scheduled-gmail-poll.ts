import type { JobQueue } from '@ai-agents/agent-core';
import type { GmailReader } from '@ai-agents/connector-google';
import {
  type GoogleConnectionSummaryRepository,
  gmailComposeScope,
  gmailReadonlyScope,
} from '@ai-agents/google-oauth';
import type { JobEmailSettingsRepository } from './ports';

export interface ScheduledGmailPollLogger {
  error(entry: Record<string, unknown>): void;
}

export interface ScheduledGmailPollOptions {
  readonly connections: GoogleConnectionSummaryRepository;
  readonly gmail: Pick<GmailReader, 'listMessages'>;
  /** A unique prefix deliberately bypasses a prior poll Job for a safe re-run. */
  readonly idempotencyKeyPrefix?: string;
  readonly logger: ScheduledGmailPollLogger;
  readonly maxMessages: number;
  readonly maxResults: number;
  readonly query: string;
  readonly queue: Pick<JobQueue, 'enqueue'>;
  readonly settings: Pick<JobEmailSettingsRepository, 'getReplySettings'>;
}

export interface ScheduledGmailPollResult {
  readonly connectionFailures: number;
  readonly eligibleConnections: number;
  readonly enqueueFailures: number;
  /** Successful enqueue requests. An idempotency match may reuse an existing Job. */
  readonly jobRequestsAccepted: number;
  readonly messagesFound: number;
}

const maximumPagesPerConnection = 100;

/**
 * Enqueues the same Jobs as the Worker schedule. Reusing this function keeps
 * the setup-page action and the periodic poll identical and idempotent.
 */
export async function enqueueScheduledGmailPoll(
  options: ScheduledGmailPollOptions,
): Promise<ScheduledGmailPollResult> {
  if (!Number.isSafeInteger(options.maxMessages) || options.maxMessages < 1) {
    throw new Error('Gmail polling max messages must be a positive integer');
  }
  let eligibleConnections = 0;
  let connectionFailures = 0;
  let enqueueFailures = 0;
  let jobRequestsAccepted = 0;
  const idempotencyKeyPrefix = options.idempotencyKeyPrefix ?? 'gmail-poll';
  let messagesFound = 0;
  const connections = await options.connections.listConnections();

  for (const connection of connections) {
    if (
      connection.status !== 'connected' ||
      !connection.grantedScopes.includes(gmailReadonlyScope) ||
      !connection.grantedScopes.includes(gmailComposeScope)
    ) {
      continue;
    }
    try {
      const settings = await options.settings.getReplySettings(connection.id);
      if (!settings?.createDrafts || !settings.userName) continue;
      eligibleConnections += 1;
      let pageToken: string | undefined;
      const seenPageTokens = new Set<string>();
      const seenThreadIds = new Set<string>();
      let selectedMessages = 0;
      pageLoop: for (let pageNumber = 0; pageNumber < maximumPagesPerConnection; pageNumber += 1) {
        const page = await options.gmail.listMessages({
          googleConnectionId: connection.id,
          maxResults: options.maxResults,
          ...(pageToken ? { pageToken } : {}),
          query: options.query,
        });
        messagesFound += page.messages.length;
        for (const message of page.messages) {
          // Gmail lists newest references first. Only the newest message from each thread is
          // selected during a bounded poll, preventing duplicate analysis of one conversation.
          if (seenThreadIds.has(message.threadId)) continue;
          seenThreadIds.add(message.threadId);
          selectedMessages += 1;
          try {
            await options.queue.enqueue({
              agentId: 'job-search-email',
              idempotencyKey: `${idempotencyKeyPrefix}:${connection.id}:${message.id}`,
              input: {
                gmailMessageId: message.id,
                gmailThreadId: message.threadId,
                googleConnectionId: connection.id,
              },
              retryFailed: false,
              triggerType: 'schedule',
            });
            jobRequestsAccepted += 1;
          } catch (error) {
            enqueueFailures += 1;
            options.logger.error({
              code: safeErrorCode(error),
              event: 'gmail.poll.enqueue_failed',
            });
          }
          if (selectedMessages >= options.maxMessages) break pageLoop;
        }
        if (!page.nextPageToken) break;
        if (seenPageTokens.has(page.nextPageToken)) {
          throw new Error('Gmail returned a repeated page token');
        }
        seenPageTokens.add(page.nextPageToken);
        pageToken = page.nextPageToken;
        if (pageNumber === maximumPagesPerConnection - 1) {
          throw new Error('Gmail polling page limit was exceeded');
        }
      }
    } catch (error) {
      connectionFailures += 1;
      options.logger.error({
        code: safeErrorCode(error),
        event: 'gmail.poll.connection_failed',
      });
    }
  }

  return {
    connectionFailures,
    eligibleConnections,
    enqueueFailures,
    jobRequestsAccepted,
    messagesFound,
  };
}

function safeErrorCode(error: unknown): string {
  if (
    error instanceof Error &&
    'code' in error &&
    typeof error.code === 'string' &&
    error.code.length <= 100
  ) {
    return error.code;
  }
  return 'UNKNOWN';
}
