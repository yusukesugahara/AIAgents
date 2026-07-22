import { createHash, timingSafeEqual } from 'node:crypto';
import { AgentDependencyError } from '@ai-agents/agent-core';
import { gmailComposeScope } from '@ai-agents/google-oauth';
import { enqueueScheduledGmailPoll } from '@ai-agents/job-search-email';
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import { enqueueManualAgentRun } from '../agent-run-service';
import { type ApiAppOptions, type ApiEnvironment, ApiError, type ApiLogger } from '../api-types';
import { renderSetupPage, type SetupJobView, type SetupMessageView } from '../setup-view';

const jobIdSchema = z.uuid();
const draftIdSchema = z.string().trim().min(1).max(255);
const draftTestStatusSchema = z.enum(['created', 'reused']);
const draftTestErrorSchema = z
  .string()
  .trim()
  .regex(/^[A-Z][A-Z0-9_]{0,63}$/u);
const scheduledPollResultSchema = z.object({
  connectionFailures: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  eligibleConnections: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  enqueueFailures: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  jobRequestsAccepted: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  messagesFound: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
});
const csrfCookieName = 'ai_agents_setup_csrf';
const csrfTokenPattern = /^[a-f0-9]{32}$/u;
const gmailMetadataFetchConcurrency = 5;
const defaultScheduledGmailPoll = {
  maxMessages: 100,
  maxResults: 50,
  query: 'in:inbox newer_than:1d',
} as const;
const testRunSchema = z.object({
  gmailMessageId: z.string().trim().min(1).max(255),
  gmailThreadId: z.string().trim().min(1).max(255),
  googleConnectionId: z.uuid(),
  idempotencyKey: z.string().trim().max(255).optional(),
});
const draftTestSchema = z.object({
  gmailMessageId: z.string().trim().min(1).max(255),
  gmailThreadId: z.string().trim().min(1).max(255),
  googleConnectionId: z.uuid(),
});
const replySettingsSchema = z.object({
  createDrafts: z.literal('true').optional().transform(Boolean),
  draftConfidenceThreshold: z.coerce.number().min(0).max(1),
  emailSignature: z.string().trim().max(2_000),
  googleConnectionId: z.uuid(),
  userName: z.string().trim().min(1).max(100),
});

export function registerSetupRoutes(
  app: Hono<ApiEnvironment>,
  options: ApiAppOptions,
  logger: ApiLogger,
): void {
  const enqueueSetupScheduledPoll = async (
    context: Context<ApiEnvironment>,
    resetToken?: string,
  ) => {
    const polling = options.gmailPolling ?? defaultScheduledGmailPoll;
    return enqueueScheduledGmailPoll({
      connections: requireConnections(options),
      gmail: requireGmail(options),
      ...(resetToken ? { idempotencyKeyPrefix: `gmail-poll-reset:${resetToken}` } : {}),
      logger: {
        error(entry) {
          logger.error({ ...entry, requestId: context.get('requestId'), source: 'setup' });
        },
      },
      maxMessages: polling.maxMessages,
      maxResults: polling.maxResults,
      query: polling.query,
      queue: requireQueue(options),
      settings: requireJobEmailSettings(options),
    });
  };

  app.get('/', (context) => context.redirect('/setup', 303));

  app.get('/setup', async (context) => {
    const csrfToken = ensureCsrfToken(context, options.oauthCookieSecure ?? false);
    const connections = await requireConnections(options).listConnections();
    const selectedConnectionId = context.req.query('connectionId');
    let messages: readonly SetupMessageView[] = [];
    let gmailErrorCode: string | undefined;
    if (selectedConnectionId) {
      const connection = connections.find(
        (candidate) => candidate.id === selectedConnectionId && candidate.status === 'connected',
      );
      if (!connection) throw new ApiError('BAD_REQUEST', 400, 'Invalid Google connection');
      const gmail = options.gmail;
      if (!gmail) {
        gmailErrorCode = 'GMAIL_READER_UNAVAILABLE';
      } else {
        try {
          const page = await gmail.listMessages({
            googleConnectionId: connection.id,
            maxResults: 50,
            query: 'in:inbox newer_than:7d',
          });
          const fetchedMessages: SetupMessageView[] = [];
          for (
            let start = 0;
            start < page.messages.length;
            start += gmailMetadataFetchConcurrency
          ) {
            const references = page.messages.slice(start, start + gmailMetadataFetchConcurrency);
            const batch = await Promise.all(
              references.map(async (reference) => {
                const message = await gmail.getMessage({
                  gmailMessageId: reference.id,
                  googleConnectionId: connection.id,
                  metadataOnly: true,
                });
                return {
                  from: message.from,
                  id: message.id,
                  sentAt: message.sentAt.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }),
                  subject: message.subject,
                  threadId: message.threadId,
                };
              }),
            );
            fetchedMessages.push(...batch);
          }
          messages = fetchedMessages;
        } catch (error) {
          if (!(error instanceof AgentDependencyError)) throw error;
          gmailErrorCode = error.code;
        }
      }
    }
    const settingsConnection =
      connections.find(
        (candidate) => candidate.id === selectedConnectionId && candidate.status === 'connected',
      ) ?? connections.find((candidate) => candidate.status === 'connected');
    const storedReplySettings =
      settingsConnection && options.jobEmailSettings
        ? await options.jobEmailSettings.getReplySettings(settingsConnection.id)
        : null;
    const draftCreationReady = Boolean(
      settingsConnection?.grantedScopes.includes(gmailComposeScope) &&
        storedReplySettings?.createDrafts &&
        storedReplySettings.userName,
    );
    const draftTestReady = Boolean(
      settingsConnection?.grantedScopes.includes(gmailComposeScope) &&
        options.gmail &&
        options.gmailDrafts,
    );
    const requestedDraftId = context.req.query('draftId');
    const requestedDraftStatus = context.req.query('draftStatus');
    let draftTestResult: { readonly draftId: string; readonly reused: boolean } | undefined;
    if (requestedDraftId || requestedDraftStatus) {
      const parsedDraftId = draftIdSchema.safeParse(requestedDraftId);
      const parsedDraftStatus = draftTestStatusSchema.safeParse(requestedDraftStatus);
      if (!parsedDraftId.success || !parsedDraftStatus.success) {
        throw new ApiError('BAD_REQUEST', 400, 'Invalid Gmail Draft test result');
      }
      draftTestResult = {
        draftId: parsedDraftId.data,
        reused: parsedDraftStatus.data === 'reused',
      };
    }
    const requestedDraftError = context.req.query('draftError');
    let draftTestErrorCode: string | undefined;
    if (requestedDraftError) {
      const parsedDraftError = draftTestErrorSchema.safeParse(requestedDraftError);
      if (!parsedDraftError.success) {
        throw new ApiError('BAD_REQUEST', 400, 'Invalid Gmail Draft test error');
      }
      draftTestErrorCode = parsedDraftError.data;
    }
    const requestedJobId = context.req.query('jobId');
    let job: SetupJobView | undefined;
    if (requestedJobId) {
      const parsedJobId = jobIdSchema.safeParse(requestedJobId);
      if (!parsedJobId.success) throw new ApiError('BAD_REQUEST', 400, 'Invalid Job ID');
      const storedJob = await requireQueue(options).get(parsedJobId.data);
      if (!storedJob) throw new ApiError('JOB_NOT_FOUND', 404, 'Job was not found');
      const latestRun = options.runs ? await options.runs.getLatestRunForJob(storedJob.id) : null;
      job = {
        errorCode: storedJob.lastErrorCode,
        id: storedJob.id,
        latestRunId: latestRun?.id ?? null,
        status: storedJob.status,
      };
    }
    let scheduledPollResult:
      | {
          readonly connectionFailures: number;
          readonly eligibleConnections: number;
          readonly enqueueFailures: number;
          readonly jobRequestsAccepted: number;
          readonly messagesFound: number;
        }
      | undefined;
    const scheduledPollReset = context.req.query('scheduledPoll') === 'reset-completed';
    if (context.req.query('scheduledPoll') === 'completed' || scheduledPollReset) {
      const parsedScheduledPollResult = scheduledPollResultSchema.safeParse({
        connectionFailures: context.req.query('connectionFailures'),
        eligibleConnections: context.req.query('eligibleConnections'),
        enqueueFailures: context.req.query('enqueueFailures'),
        jobRequestsAccepted: context.req.query('jobRequestsAccepted'),
        messagesFound: context.req.query('messagesFound'),
      });
      if (!parsedScheduledPollResult.success) {
        throw new ApiError('BAD_REQUEST', 400, 'Invalid scheduled poll result');
      }
      scheduledPollResult = parsedScheduledPollResult.data;
    }
    setPageHeaders(context);
    return context.html(
      renderSetupPage({
        connections,
        csrfToken,
        draftCreationReady,
        draftTestReady,
        ...(draftTestErrorCode ? { draftTestErrorCode } : {}),
        ...(draftTestResult ? { draftTestResult } : {}),
        ...(gmailErrorCode ? { gmailErrorCode } : {}),
        ...(job ? { job } : {}),
        messages,
        oauthCompleted: context.req.query('oauth') === 'completed',
        scheduledPollReady: Boolean(options.gmail && options.jobEmailSettings && options.queue),
        ...(scheduledPollResult ? { scheduledPollResult, scheduledPollReset } : {}),
        ...(settingsConnection
          ? {
              replySettings: {
                createDrafts: storedReplySettings?.createDrafts ?? true,
                draftConfidenceThreshold: storedReplySettings?.draftConfidenceThreshold ?? 0.85,
                emailSignature: storedReplySettings?.emailSignature ?? '',
                googleConnectionId: settingsConnection.id,
                userName: storedReplySettings?.userName ?? '',
              },
            }
          : {}),
        settingsSaved: context.req.query('settings') === 'saved',
        ...(selectedConnectionId ? { selectedConnectionId } : {}),
      }),
    );
  });

  app.post('/setup/reply-settings', async (context) => {
    const body = await context.req.parseBody();
    requireFormSubmission(context, body);
    const parsed = replySettingsSchema.safeParse(body);
    if (!parsed.success) throw new ApiError('BAD_REQUEST', 400, parsed.error.message);
    const connection = (await requireConnections(options).listConnections()).find(
      (candidate) =>
        candidate.id === parsed.data.googleConnectionId && candidate.status === 'connected',
    );
    if (!connection) throw new ApiError('BAD_REQUEST', 400, 'Select a connected Google account');
    const saved = await requireJobEmailSettings(options).saveReplySettings(parsed.data);
    if (!saved) throw new ApiError('BAD_REQUEST', 400, 'Google connection is unavailable');
    logger.info({
      event: 'api.job_email_reply_settings.saved',
      googleConnectionId: connection.id,
      requestId: context.get('requestId'),
    });
    return context.redirect(
      `/setup?connectionId=${encodeURIComponent(connection.id)}&settings=saved`,
      303,
    );
  });

  app.post('/setup/scheduled-poll', async (context) => {
    const body = await context.req.parseBody();
    requireFormSubmission(context, body);
    const result = await enqueueSetupScheduledPoll(context);
    return redirectScheduledPollResult(context, logger, result, false);
  });

  app.post('/setup/scheduled-poll-reset', async (context) => {
    const body = await context.req.parseBody();
    requireFormSubmission(context, body);
    const result = await enqueueSetupScheduledPoll(context, crypto.randomUUID());
    return redirectScheduledPollResult(context, logger, result, true);
  });

  app.post('/setup/test-run', async (context) => {
    const body = await context.req.parseBody();
    requireFormSubmission(context, body);
    const parsed = testRunSchema.safeParse(body);
    if (!parsed.success) throw new ApiError('BAD_REQUEST', 400, parsed.error.message);
    const connections = await requireConnections(options).listConnections();
    const connection = connections.find(
      (candidate) =>
        candidate.id === parsed.data.googleConnectionId && candidate.status === 'connected',
    );
    if (!connection) {
      throw new ApiError('BAD_REQUEST', 400, 'Select a connected Google account');
    }
    if (!connection.grantedScopes.includes(gmailComposeScope)) {
      throw new ApiError('BAD_REQUEST', 400, 'Gmail Draft permission is required');
    }
    const replySettings = await requireJobEmailSettings(options).getReplySettings(connection.id);
    if (!replySettings?.createDrafts || !replySettings.userName) {
      throw new ApiError('BAD_REQUEST', 400, 'Configure reply Draft settings before testing');
    }
    const job = await enqueueManualAgentRun(options, {
      agentId: 'job-search-email',
      value: {
        gmailMessageId: parsed.data.gmailMessageId,
        gmailThreadId: parsed.data.gmailThreadId,
        googleConnectionId: parsed.data.googleConnectionId,
      },
      ...(parsed.data.idempotencyKey ? { idempotencyKey: parsed.data.idempotencyKey } : {}),
    });
    logger.info({
      agentId: 'job-search-email',
      event: 'api.job.enqueued',
      jobId: job.id,
      requestId: context.get('requestId'),
      source: 'setup',
    });
    return context.redirect(`/setup?jobId=${encodeURIComponent(job.id)}`, 303);
  });

  app.post('/setup/draft-test', async (context) => {
    const body = await context.req.parseBody();
    requireFormSubmission(context, body);
    const parsed = draftTestSchema.safeParse(body);
    if (!parsed.success) throw new ApiError('BAD_REQUEST', 400, parsed.error.message);
    const connection = (await requireConnections(options).listConnections()).find(
      (candidate) =>
        candidate.id === parsed.data.googleConnectionId && candidate.status === 'connected',
    );
    if (!connection) throw new ApiError('BAD_REQUEST', 400, 'Select a connected Google account');
    if (!connection.grantedScopes.includes(gmailComposeScope)) {
      throw new ApiError('BAD_REQUEST', 400, 'Gmail Draft permission is required');
    }
    const gmail = requireGmail(options);
    const drafts = requireGmailDrafts(options);
    const resultUrl = (parameters: Record<string, string>): string => {
      const query = new URLSearchParams({ connectionId: connection.id, ...parameters });
      return `/setup?${query.toString()}`;
    };
    try {
      const message = await gmail.getMessage({
        gmailMessageId: parsed.data.gmailMessageId,
        googleConnectionId: connection.id,
        metadataOnly: true,
      });
      if (
        message.id !== parsed.data.gmailMessageId ||
        message.threadId !== parsed.data.gmailThreadId
      ) {
        return context.redirect(resultUrl({ draftError: 'SOURCE_MESSAGE_MISMATCH' }), 303);
      }
      if (!message.messageId) {
        return context.redirect(resultUrl({ draftError: 'SOURCE_MESSAGE_INVALID' }), 303);
      }
      const recipient = extractSingleMailbox(message.replyTo ?? message.from);
      const sender = extractSingleMailbox(connection.email);
      if (!recipient || !sender) {
        return context.redirect(resultUrl({ draftError: 'RECIPIENT_INVALID' }), 303);
      }
      const idempotencyKey = createDraftTestIdempotencyKey(connection.id, message.id);
      const existing = await drafts.findReplyDraft({
        gmailThreadId: message.threadId,
        googleConnectionId: connection.id,
        idempotencyKey,
      });
      const draft =
        existing ??
        (await drafts.createReplyDraft({
          body: createDraftTestBody(),
          from: sender,
          gmailThreadId: message.threadId,
          googleConnectionId: connection.id,
          idempotencyKey,
          inReplyTo: message.messageId,
          references: message.references,
          subject: createReplySubject(message.subject),
          to: recipient,
        }));
      logger.info({
        draftId: draft.draftId,
        event: 'api.gmail_draft_test.completed',
        googleConnectionId: connection.id,
        requestId: context.get('requestId'),
        reused: existing !== null,
      });
      return context.redirect(
        resultUrl({
          draftId: draft.draftId,
          draftStatus: existing ? 'reused' : 'created',
        }),
        303,
      );
    } catch (error) {
      if (!(error instanceof AgentDependencyError)) throw error;
      logger.error({
        code: error.code,
        event: 'api.gmail_draft_test.failed',
        googleConnectionId: connection.id,
        requestId: context.get('requestId'),
      });
      return context.redirect(resultUrl({ draftError: error.code }), 303);
    }
  });
}

function redirectScheduledPollResult(
  context: Context<ApiEnvironment>,
  logger: ApiLogger,
  result: {
    readonly connectionFailures: number;
    readonly eligibleConnections: number;
    readonly enqueueFailures: number;
    readonly jobRequestsAccepted: number;
    readonly messagesFound: number;
  },
  reset: boolean,
) {
  logger.info({
    connectionFailures: result.connectionFailures,
    eligibleConnections: result.eligibleConnections,
    enqueueFailures: result.enqueueFailures,
    event: reset
      ? 'api.gmail_scheduled_poll.reset_completed'
      : 'api.gmail_scheduled_poll.completed',
    jobRequestsAccepted: result.jobRequestsAccepted,
    messagesFound: result.messagesFound,
    requestId: context.get('requestId'),
    source: 'setup',
  });
  return context.redirect(
    `/setup?${new URLSearchParams({
      scheduledPoll: reset ? 'reset-completed' : 'completed',
      connectionFailures: String(result.connectionFailures),
      eligibleConnections: String(result.eligibleConnections),
      enqueueFailures: String(result.enqueueFailures),
      jobRequestsAccepted: String(result.jobRequestsAccepted),
      messagesFound: String(result.messagesFound),
    }).toString()}`,
    303,
  );
}

function requireConnections(options: ApiAppOptions) {
  if (!options.googleConnections) {
    throw new ApiError('INTERNAL_ERROR', 500, 'Google Connections are not configured');
  }
  return options.googleConnections;
}

function requireQueue(options: ApiAppOptions) {
  if (!options.queue) throw new ApiError('INTERNAL_ERROR', 500, 'Job Queue is not configured');
  return options.queue;
}

function requireJobEmailSettings(options: ApiAppOptions) {
  if (!options.jobEmailSettings) {
    throw new ApiError('INTERNAL_ERROR', 500, 'Job Email Settings are not configured');
  }
  return options.jobEmailSettings;
}

function requireGmail(options: ApiAppOptions) {
  if (!options.gmail) throw new ApiError('INTERNAL_ERROR', 500, 'Gmail Reader is not configured');
  return options.gmail;
}

function requireGmailDrafts(options: ApiAppOptions) {
  if (!options.gmailDrafts) {
    throw new ApiError('INTERNAL_ERROR', 500, 'Gmail Draft Writer is not configured');
  }
  return options.gmailDrafts;
}

function extractSingleMailbox(header: string): string | null {
  if (/\r|\n/u.test(header)) return null;
  const matches = [...header.matchAll(/<([^<>]+)>/gu)];
  const candidate = (
    matches.length === 1 ? matches[0]?.[1] : matches.length === 0 ? header : ''
  )?.trim();
  if (!candidate || !/^[^\s(),:;<>@]+@[^\s(),:;<>@]+$/u.test(candidate)) return null;
  return candidate;
}

function createDraftTestIdempotencyKey(connectionId: string, messageId: string): string {
  const digest = createHash('sha256').update(`${connectionId}:${messageId}`).digest('hex');
  return `setup-gmail-draft-test:v1:${digest}`;
}

function createReplySubject(subject: string): string {
  const normalized = subject.trim() || '件名なし';
  return /^re\s*:/iu.test(normalized) ? normalized : `Re: ${normalized}`;
}

function createDraftTestBody(): string {
  return [
    'これは AIAgents のGmail下書き作成テストです。',
    '',
    'このメールは送信されていません。Gmailの下書き一覧で内容を確認し、不要であれば削除してください。',
  ].join('\n');
}

function requireFormSubmission(
  context: Context<ApiEnvironment>,
  body: Record<string, unknown>,
): void {
  if (isSameOriginRequest(context) || hasValidCsrfToken(context, body._csrf)) return;
  throw new ApiError('BAD_REQUEST', 400, 'Form submission must come from this application');
}

function isSameOriginRequest(context: Context<ApiEnvironment>): boolean {
  const origin = context.req.header('Origin');
  if (origin) {
    return matchesRequestOrigin(context, origin);
  }
  const referer = context.req.header('Referer');
  if (referer) {
    return matchesRequestOrigin(context, referer);
  }
  return context.req.header('Sec-Fetch-Site') === 'same-origin';
}

function matchesRequestOrigin(context: Context<ApiEnvironment>, candidate: string): boolean {
  try {
    const candidateUrl = new URL(candidate);
    if (candidateUrl.protocol !== 'http:' && candidateUrl.protocol !== 'https:') return false;
    if (candidateUrl.origin === new URL(context.req.url).origin) return true;
    const host = context.req.header('Host')?.trim().toLowerCase();
    return Boolean(host && candidateUrl.host.toLowerCase() === host);
  } catch {
    return false;
  }
}

function ensureCsrfToken(context: Context<ApiEnvironment>, secure: boolean): string {
  const existing = readCookie(context.req.header('Cookie'), csrfCookieName);
  if (existing && csrfTokenPattern.test(existing)) return existing;
  const token = crypto.randomUUID().replaceAll('-', '');
  context.header(
    'Set-Cookie',
    `${csrfCookieName}=${token}; Path=/setup; Max-Age=3600; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`,
  );
  return token;
}

function hasValidCsrfToken(context: Context<ApiEnvironment>, submitted: unknown): boolean {
  if (typeof submitted !== 'string' || !csrfTokenPattern.test(submitted)) return false;
  const cookie = readCookie(context.req.header('Cookie'), csrfCookieName);
  if (!cookie || !csrfTokenPattern.test(cookie)) return false;
  const submittedBytes = new TextEncoder().encode(submitted);
  const cookieBytes = new TextEncoder().encode(cookie);
  return timingSafeEqual(submittedBytes, cookieBytes);
}

function readCookie(header: string | undefined, name: string): string | undefined {
  return header
    ?.split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}

function setPageHeaders(context: Context<ApiEnvironment>): void {
  context.header('Cache-Control', 'no-store');
  context.header(
    'Content-Security-Policy',
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  );
  context.header('Referrer-Policy', 'no-referrer');
  context.header('X-Content-Type-Options', 'nosniff');
}
