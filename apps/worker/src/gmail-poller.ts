import type { JobQueue } from '@ai-agents/agent-core';
import type { GmailReader } from '@ai-agents/connector-google';
import {
  enqueueScheduledGmailPoll,
  type JobEmailSettingsRepository,
} from '@ai-agents/job-search-email';
import type { GoogleConnectionSummaryRepository } from '@ai-agents/google-oauth';

export interface GmailPollerHandle {
  pollNow(): Promise<void>;
  stop(): Promise<void>;
}

export interface GmailPollerLogger {
  error(entry: Record<string, unknown>): void;
  info(entry: Record<string, unknown>): void;
}

export interface GmailPollerOptions {
  readonly connections: GoogleConnectionSummaryRepository;
  readonly gmail: Pick<GmailReader, 'listMessages'>;
  readonly intervalMs: number;
  readonly logger?: GmailPollerLogger;
  readonly maxResults?: number;
  readonly query: string;
  readonly queue: Pick<JobQueue, 'enqueue'>;
  readonly runImmediately?: boolean;
  readonly settings: Pick<JobEmailSettingsRepository, 'getReplySettings'>;
}

export function startGmailPoller(options: GmailPollerOptions): GmailPollerHandle {
  if (!Number.isSafeInteger(options.intervalMs) || options.intervalMs <= 0) {
    throw new Error('Gmail polling interval must be a positive integer');
  }
  const maxResults = options.maxResults ?? 50;
  if (!Number.isSafeInteger(maxResults) || maxResults < 1 || maxResults > 100) {
    throw new Error('Gmail polling max results must be 1 through 100');
  }
  const query = options.query.trim();
  if (!query) throw new Error('Gmail polling query must not be empty');

  const logger = options.logger ?? consoleLogger;
  let currentPoll: Promise<void> | undefined;
  let stopped = false;
  let stopPromise: Promise<void> | undefined;

  const run = async (): Promise<void> => {
    const result = await enqueueScheduledGmailPoll({
      connections: options.connections,
      gmail: options.gmail,
      idempotencyKeyPrefix: 'gmail-poll',
      logger,
      maxResults,
      query,
      queue: options.queue,
      settings: options.settings,
    });
    logger.info({
      connectionFailures: result.connectionFailures,
      eligibleConnections: result.eligibleConnections,
      enqueueFailures: result.enqueueFailures,
      event: 'gmail.poll.completed',
      jobRequestsAccepted: result.jobRequestsAccepted,
      messagesFound: result.messagesFound,
    });
  };

  const pollNow = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (currentPoll) return currentPoll;
    const execution = run()
      .catch((error: unknown) => {
        logger.error({ code: safeErrorCode(error), event: 'gmail.poll.failed' });
      })
      .finally(() => {
        if (currentPoll === execution) currentPoll = undefined;
      });
    currentPoll = execution;
    return execution;
  };

  const timer = setInterval(() => {
    void pollNow();
  }, options.intervalMs);
  logger.info({ event: 'gmail.poller.started', intervalMs: options.intervalMs, maxResults });
  if (options.runImmediately ?? true) void pollNow();

  return {
    pollNow,
    stop() {
      if (stopPromise) return stopPromise;
      stopped = true;
      clearInterval(timer);
      stopPromise = (async () => {
        if (currentPoll) await currentPoll;
        logger.info({ event: 'gmail.poller.stopped' });
      })();
      return stopPromise;
    },
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

const consoleLogger: GmailPollerLogger = {
  error(entry) {
    console.error(JSON.stringify(entry));
  },
  info(entry) {
    console.info(JSON.stringify(entry));
  },
};
