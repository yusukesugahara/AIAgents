import { createHash } from 'node:crypto';
import { AgentDependencyError } from '@ai-agents/agent-core';
import {
  calendarEventsScope,
  type GoogleAccessTokenProvider,
  gmailComposeScope,
} from '@ai-agents/google-oauth';
import { z } from 'zod';

const gmailApiBaseUrl = 'https://gmail.googleapis.com/gmail/v1/users/me';
const calendarApiBaseUrl = 'https://www.googleapis.com/calendar/v3/calendars/primary';
const defaultQuery = 'in:inbox newer_than:1d';

export interface GmailMessageReference {
  readonly id: string;
  readonly threadId: string;
}

export interface GmailMessagePage {
  readonly messages: readonly GmailMessageReference[];
  readonly nextPageToken: string | null;
}

export interface EmailMessage {
  readonly id: string;
  readonly threadId: string;
  readonly labelIds: readonly string[];
  readonly from: string;
  readonly to: readonly string[];
  readonly cc: readonly string[];
  readonly subject: string;
  readonly sentAt: Date;
  readonly messageId: string | null;
  readonly inReplyTo: string | null;
  readonly replyTo: string | null;
  readonly references: readonly string[];
  readonly bodyText: string;
  readonly bodyTruncated: boolean;
}

export interface EmailThread {
  readonly id: string;
  readonly messages: readonly EmailMessage[];
}

export interface GmailReader {
  listMessages(input: {
    readonly googleConnectionId: string;
    readonly maxResults?: number;
    readonly pageToken?: string;
    readonly query?: string;
  }): Promise<GmailMessagePage>;
  getMessage(input: {
    readonly googleConnectionId: string;
    readonly gmailMessageId: string;
    readonly metadataOnly?: boolean;
  }): Promise<EmailMessage>;
  getThread(input: {
    readonly googleConnectionId: string;
    readonly gmailThreadId: string;
  }): Promise<EmailThread>;
}

export interface CreatedGmailDraft {
  readonly draftId: string;
  readonly messageId: string;
  readonly threadId: string;
}

export interface GmailDraftWriter {
  createReplyDraft(input: CreateReplyDraftInput): Promise<CreatedGmailDraft>;
  findReplyDraft(input: FindReplyDraftInput): Promise<CreatedGmailDraft | null>;
}

export interface GoogleCalendarEvent {
  readonly eventId: string;
}

export interface CreatedGoogleCalendarEvent extends GoogleCalendarEvent {}

export interface GoogleCalendarClient {
  createEvent(input: CreateGoogleCalendarEventInput): Promise<CreatedGoogleCalendarEvent>;
  findConflictingEvents(input: FindCalendarConflictsInput): Promise<readonly GoogleCalendarEvent[]>;
  findEvent(input: FindGoogleCalendarEventInput): Promise<GoogleCalendarEvent | null>;
}

export interface FindCalendarConflictsInput {
  readonly endAt: string;
  readonly googleConnectionId: string;
  readonly startAt: string;
}

export interface FindGoogleCalendarEventInput {
  readonly eventId: string;
  readonly googleConnectionId: string;
  readonly idempotencyKey: string;
}

export interface CreateGoogleCalendarEventInput extends FindGoogleCalendarEventInput {
  readonly description: string;
  readonly endAt: string;
  readonly location: string;
  readonly startAt: string;
  readonly summary: string;
  readonly timeZone: string;
}

export interface CreateReplyDraftInput extends FindReplyDraftInput {
  readonly body: string;
  readonly from: string;
  readonly inReplyTo: string;
  readonly references: readonly string[];
  readonly subject: string;
  readonly to: string;
}

export interface FindReplyDraftInput {
  readonly googleConnectionId: string;
  readonly gmailThreadId: string;
  readonly idempotencyKey: string;
}

export interface HttpGmailReaderOptions {
  readonly accessTokens: GoogleAccessTokenProvider;
  readonly bodyLimitBytes?: number;
  readonly fetchImplementation?: FetchImplementation;
  readonly timeoutMs?: number;
}

export interface HttpGmailDraftWriterOptions {
  readonly accessTokens: GoogleAccessTokenProvider;
  readonly fetchImplementation?: FetchImplementation;
  readonly timeoutMs?: number;
}

export interface HttpGoogleCalendarClientOptions {
  readonly accessTokens: GoogleAccessTokenProvider;
  readonly fetchImplementation?: FetchImplementation;
  readonly timeoutMs?: number;
}

export type FetchImplementation = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

const headerSchema = z.object({ name: z.string(), value: z.string() }).passthrough();
const messagePartSchema: z.ZodType<RawMessagePart> = z.lazy(() =>
  z
    .object({
      body: z
        .object({ attachmentId: z.string().optional(), data: z.string().optional() })
        .optional(),
      filename: z.string().optional(),
      headers: z.array(headerSchema).optional(),
      mimeType: z.string().optional(),
      parts: z.array(messagePartSchema).optional(),
    })
    .passthrough(),
);
const messageSchema = z
  .object({
    id: z.string().min(1),
    internalDate: z.string().regex(/^\d+$/u).optional(),
    labelIds: z.array(z.string()).optional(),
    payload: messagePartSchema.optional(),
    threadId: z.string().min(1),
  })
  .passthrough();
const messagePageSchema = z
  .object({
    messages: z.array(z.object({ id: z.string().min(1), threadId: z.string().min(1) })).optional(),
    nextPageToken: z.string().optional(),
  })
  .passthrough();
const threadSchema = z
  .object({ id: z.string().min(1), messages: z.array(messageSchema).optional() })
  .passthrough();
const attachmentSchema = z.object({ data: z.string().min(1) }).passthrough();
const draftSchema = z
  .object({
    id: z.string().min(1),
    message: z.object({ id: z.string().min(1), threadId: z.string().min(1) }),
  })
  .passthrough();
const draftListSchema = z
  .object({ drafts: z.array(draftSchema).optional(), nextPageToken: z.string().optional() })
  .passthrough();
const calendarEventSchema = z
  .object({
    extendedProperties: z
      .object({ private: z.record(z.string(), z.string()).optional() })
      .optional(),
    id: z.string().min(1),
    transparency: z.enum(['opaque', 'transparent']).optional(),
  })
  .passthrough();
const calendarEventListSchema = z
  .object({ items: z.array(calendarEventSchema).optional() })
  .passthrough();

type RawMessage = z.infer<typeof messageSchema>;
type RawMessagePart = {
  readonly body?:
    | { readonly attachmentId?: string | undefined; readonly data?: string | undefined }
    | undefined;
  readonly filename?: string | undefined;
  readonly headers?: readonly { readonly name: string; readonly value: string }[] | undefined;
  readonly mimeType?: string | undefined;
  readonly parts?: readonly RawMessagePart[] | undefined;
};

export class HttpGmailReader implements GmailReader {
  readonly #bodyLimitBytes: number;
  readonly #fetch: FetchImplementation;
  readonly #timeoutMs: number;

  constructor(private readonly options: HttpGmailReaderOptions) {
    this.#bodyLimitBytes = options.bodyLimitBytes ?? 256 * 1024;
    this.#fetch = options.fetchImplementation ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? 10_000;
    if (!Number.isSafeInteger(this.#bodyLimitBytes) || this.#bodyLimitBytes <= 0) {
      throw new Error('Gmail body limit must be a positive integer');
    }
    if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs <= 0) {
      throw new Error('Gmail timeout must be a positive integer');
    }
  }

  async listMessages(input: {
    readonly googleConnectionId: string;
    readonly maxResults?: number;
    readonly pageToken?: string;
    readonly query?: string;
  }): Promise<GmailMessagePage> {
    requireUuid(input.googleConnectionId);
    const maxResults = input.maxResults ?? 100;
    if (!Number.isSafeInteger(maxResults) || maxResults < 1 || maxResults > 100) {
      throw new AgentDependencyError(
        'INVALID_REQUEST',
        false,
        'Gmail max results must be 1 through 100',
      );
    }
    const query = input.query ?? defaultQuery;
    if (!query.trim()) {
      throw new AgentDependencyError('INVALID_REQUEST', false, 'Gmail query must not be empty');
    }
    return this.#withAccessToken(input.googleConnectionId, async (accessToken) => {
      const url = new URL(`${gmailApiBaseUrl}/messages`);
      url.searchParams.set('maxResults', String(maxResults));
      url.searchParams.set('q', query);
      if (input.pageToken) {
        url.searchParams.set('pageToken', input.pageToken);
      }
      const body = parseGmailResponse(messagePageSchema, await this.#requestJson(url, accessToken));
      return { messages: body.messages ?? [], nextPageToken: body.nextPageToken ?? null };
    });
  }

  async getMessage(input: {
    readonly googleConnectionId: string;
    readonly gmailMessageId: string;
    readonly metadataOnly?: boolean;
  }): Promise<EmailMessage> {
    requireUuid(input.googleConnectionId);
    requireIdentifier(input.gmailMessageId, 'Gmail message ID');
    return this.#withAccessToken(input.googleConnectionId, async (accessToken) => {
      const url = new URL(
        `${gmailApiBaseUrl}/messages/${encodeURIComponent(input.gmailMessageId)}`,
      );
      if (input.metadataOnly) {
        url.searchParams.set('format', 'metadata');
        url.searchParams.append('metadataHeaders', 'From');
        url.searchParams.append('metadataHeaders', 'Reply-To');
        url.searchParams.append('metadataHeaders', 'Subject');
        url.searchParams.append('metadataHeaders', 'Message-ID');
        url.searchParams.append('metadataHeaders', 'References');
      } else {
        url.searchParams.set('format', 'full');
      }
      const raw = parseGmailResponse(messageSchema, await this.#requestJson(url, accessToken));
      return this.#normalizeMessage(raw, accessToken);
    });
  }

  async getThread(input: {
    readonly googleConnectionId: string;
    readonly gmailThreadId: string;
  }): Promise<EmailThread> {
    requireUuid(input.googleConnectionId);
    requireIdentifier(input.gmailThreadId, 'Gmail thread ID');
    return this.#withAccessToken(input.googleConnectionId, async (accessToken) => {
      const raw = parseGmailResponse(
        threadSchema,
        await this.#requestJson(
          new URL(
            `${gmailApiBaseUrl}/threads/${encodeURIComponent(input.gmailThreadId)}?format=full`,
          ),
          accessToken,
        ),
      );
      const messages: EmailMessage[] = [];
      for (const message of raw.messages ?? []) {
        messages.push(await this.#normalizeMessage(message, accessToken));
      }
      messages.sort((left, right) => left.sentAt.getTime() - right.sentAt.getTime());
      return { id: raw.id, messages };
    });
  }

  async #withAccessToken<T>(
    connectionId: string,
    request: (accessToken: string) => Promise<T>,
  ): Promise<T> {
    let accessToken = await this.options.accessTokens.getAccessToken(connectionId, [
      'https://www.googleapis.com/auth/gmail.readonly',
    ]);
    try {
      return await request(accessToken);
    } catch (error) {
      if (!(error instanceof GmailHttpStatusError) || error.status !== 401) {
        throw error;
      }
      this.options.accessTokens.invalidateAccessToken(connectionId);
      accessToken = await this.options.accessTokens.getAccessToken(connectionId, [
        'https://www.googleapis.com/auth/gmail.readonly',
      ]);
      try {
        return await request(accessToken);
      } catch (retryError) {
        if (retryError instanceof GmailHttpStatusError && retryError.status === 401) {
          throw new AgentDependencyError(
            'AUTHENTICATION_REQUIRED',
            false,
            'Google access token was rejected',
            { cause: retryError },
          );
        }
        throw retryError;
      }
    }
  }

  async #normalizeMessage(raw: RawMessage, accessToken: string): Promise<EmailMessage> {
    if (!raw.payload || !raw.internalDate) {
      throw new AgentDependencyError(
        'INVALID_RESPONSE',
        false,
        'Gmail message is missing required content',
      );
    }
    const internalDate = Number(raw.internalDate);
    const sentAt = new Date(internalDate);
    if (!Number.isSafeInteger(internalDate) || Number.isNaN(sentAt.getTime())) {
      throw new AgentDependencyError(
        'INVALID_RESPONSE',
        false,
        'Gmail message has an invalid date',
      );
    }
    const parts = await this.#collectTextParts(raw.id, raw.payload, accessToken);
    const selected = parts.text.join('\n\n');
    const body = truncateText(normalizeText(selected), this.#bodyLimitBytes);
    const headers = readHeaders(raw.payload.headers ?? []);
    return {
      id: raw.id,
      threadId: raw.threadId,
      labelIds: raw.labelIds ?? [],
      from: headers.get('from') ?? '',
      to: splitAddresses(headers.get('to')),
      cc: splitAddresses(headers.get('cc')),
      subject: headers.get('subject') ?? '',
      sentAt,
      messageId: headers.get('message-id') ?? null,
      inReplyTo: headers.get('in-reply-to') ?? null,
      replyTo: headers.get('reply-to') ?? null,
      references: (headers.get('references') ?? '').split(/\s+/u).filter(Boolean),
      bodyText: body.text,
      bodyTruncated: body.truncated,
    };
  }

  async #collectTextParts(
    gmailMessageId: string,
    part: RawMessagePart,
    accessToken: string,
  ): Promise<{ containsPlain: boolean; text: string[] }> {
    if (
      part.filename ||
      /^\s*attachment(?:\s*;|\s*$)/iu.test(
        readHeader(part.headers ?? [], 'content-disposition') ?? '',
      )
    ) {
      return { containsPlain: false, text: [] };
    }
    const mimeType = part.mimeType?.toLowerCase();
    if (mimeType === 'text/plain' || mimeType === 'text/html') {
      const data =
        part.body?.data ??
        (part.body?.attachmentId
          ? await this.#getAttachment(gmailMessageId, part.body.attachmentId, accessToken)
          : undefined);
      if (!data) {
        return { containsPlain: mimeType === 'text/plain', text: [] };
      }
      let decoded: string;
      try {
        decoded = decodeBase64Url(
          data,
          readMimeCharset(readHeader(part.headers ?? [], 'content-type')),
        );
      } catch (error) {
        // Individual messages in an otherwise usable Gmail thread can contain malformed
        // MIME body data. Keep their metadata and any other valid parts available to the
        // Agent instead of failing the entire thread fetch.
        if (error instanceof AgentDependencyError && error.code === 'INVALID_RESPONSE') {
          return { containsPlain: mimeType === 'text/plain', text: [] };
        }
        throw error;
      }
      return {
        containsPlain: mimeType === 'text/plain',
        text: [mimeType === 'text/html' ? htmlToText(decoded) : decoded],
      };
    }

    const children = [];
    for (const child of part.parts ?? []) {
      children.push(await this.#collectTextParts(gmailMessageId, child, accessToken));
    }
    if (mimeType === 'multipart/alternative') {
      return (
        children.find((child) => child.containsPlain && child.text.length > 0) ??
        children.find((child) => child.text.length > 0) ?? { containsPlain: false, text: [] }
      );
    }
    return {
      containsPlain: children.some((child) => child.containsPlain),
      text: children.flatMap((child) => child.text),
    };
  }

  async #getAttachment(
    gmailMessageId: string,
    attachmentId: string,
    accessToken: string,
  ): Promise<string> {
    const body = parseGmailResponse(
      attachmentSchema,
      await this.#requestJson(
        new URL(
          `${gmailApiBaseUrl}/messages/${encodeURIComponent(gmailMessageId)}/attachments/${encodeURIComponent(attachmentId)}`,
        ),
        accessToken,
      ),
    );
    return body.data;
  }

  async #requestJson(url: URL, accessToken: string): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      const response = await this.#fetch(url, {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: controller.signal,
      });
      const body = (await response.json().catch(() => null)) as unknown;
      if (response.status === 401) {
        throw new GmailHttpStatusError(401);
      }
      if (!response.ok) {
        throw toGmailError(response.status, body);
      }
      if (body === null) {
        throw new AgentDependencyError(
          'INVALID_RESPONSE',
          false,
          'Gmail returned an invalid response',
        );
      }
      return body;
    } catch (error) {
      if (error instanceof AgentDependencyError || error instanceof GmailHttpStatusError) {
        throw error;
      }
      throw new AgentDependencyError(
        'TEMPORARY_UNAVAILABLE',
        true,
        'Gmail service is temporarily unavailable',
        { cause: error },
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}

/** Creates and recovers unsent Gmail reply drafts. It deliberately has no send operation. */
export class HttpGmailDraftWriter implements GmailDraftWriter {
  readonly #fetch: FetchImplementation;
  readonly #timeoutMs: number;

  constructor(private readonly options: HttpGmailDraftWriterOptions) {
    this.#fetch = options.fetchImplementation ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? 10_000;
    if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs <= 0) {
      throw new Error('Gmail timeout must be a positive integer');
    }
  }

  async findReplyDraft(input: FindReplyDraftInput): Promise<CreatedGmailDraft | null> {
    validateDraftReference(input);
    const messageId = deterministicDraftMessageId(input.idempotencyKey);
    return this.#withAccessToken(input.googleConnectionId, async (accessToken) => {
      const url = new URL(`${gmailApiBaseUrl}/drafts`);
      url.searchParams.set('q', `rfc822msgid:${messageId}`);
      url.searchParams.set('maxResults', '10');
      const body = parseGmailResponse(draftListSchema, await this.#requestJson(url, accessToken));
      const found = (body.drafts ?? []).find(
        (draft) => draft.message.threadId === input.gmailThreadId,
      );
      return found
        ? { draftId: found.id, messageId: found.message.id, threadId: found.message.threadId }
        : null;
    });
  }

  async createReplyDraft(input: CreateReplyDraftInput): Promise<CreatedGmailDraft> {
    validateDraftReference(input);
    const raw = createReplyMime(input);
    return this.#withAccessToken(input.googleConnectionId, async (accessToken) => {
      const body = parseGmailResponse(
        draftSchema,
        await this.#requestJson(new URL(`${gmailApiBaseUrl}/drafts`), accessToken, 'POST', {
          message: { raw, threadId: input.gmailThreadId },
        }),
      );
      if (body.message.threadId !== input.gmailThreadId) {
        throw new AgentDependencyError(
          'INVALID_RESPONSE',
          false,
          'Gmail created a Draft in another Thread',
        );
      }
      return { draftId: body.id, messageId: body.message.id, threadId: body.message.threadId };
    });
  }

  async #withAccessToken<T>(
    connectionId: string,
    request: (accessToken: string) => Promise<T>,
  ): Promise<T> {
    let accessToken = await this.options.accessTokens.getAccessToken(connectionId, [
      gmailComposeScope,
    ]);
    try {
      return await request(accessToken);
    } catch (error) {
      if (!(error instanceof GmailHttpStatusError) || error.status !== 401) throw error;
      this.options.accessTokens.invalidateAccessToken(connectionId);
      accessToken = await this.options.accessTokens.getAccessToken(connectionId, [
        gmailComposeScope,
      ]);
      try {
        return await request(accessToken);
      } catch (retryError) {
        if (retryError instanceof GmailHttpStatusError && retryError.status === 401) {
          throw new AgentDependencyError(
            'AUTHENTICATION_REQUIRED',
            false,
            'Google access token was rejected',
          );
        }
        throw retryError;
      }
    }
  }

  async #requestJson(
    url: URL,
    accessToken: string,
    method = 'GET',
    payload?: unknown,
  ): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      const response = await this.#fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${accessToken}`,
          ...(payload ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(payload ? { body: JSON.stringify(payload) } : {}),
        signal: controller.signal,
      });
      const body = (await response.json().catch(() => null)) as unknown;
      if (response.status === 401) throw new GmailHttpStatusError(401);
      if (!response.ok) throw toGmailError(response.status, body);
      if (body === null)
        throw new AgentDependencyError(
          'INVALID_RESPONSE',
          false,
          'Gmail returned an invalid response',
        );
      return body;
    } catch (error) {
      if (error instanceof AgentDependencyError || error instanceof GmailHttpStatusError)
        throw error;
      throw new AgentDependencyError(
        'TEMPORARY_UNAVAILABLE',
        true,
        'Gmail service is temporarily unavailable',
        { cause: error },
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}

/** Minimal Calendar adapter: it can inspect conflicts and create, but never update or delete, events. */
export class HttpGoogleCalendarClient implements GoogleCalendarClient {
  readonly #fetch: FetchImplementation;
  readonly #timeoutMs: number;

  constructor(private readonly options: HttpGoogleCalendarClientOptions) {
    this.#fetch = options.fetchImplementation ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? 10_000;
    if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs <= 0) {
      throw new Error('Google Calendar timeout must be a positive integer');
    }
  }

  async findEvent(input: FindGoogleCalendarEventInput): Promise<GoogleCalendarEvent | null> {
    validateCalendarEventReference(input);
    try {
      return await this.#withAccessToken(input.googleConnectionId, async (accessToken) => {
        const body = parseCalendarResponse(
          calendarEventSchema,
          await this.#requestJson(
            new URL(`${calendarApiBaseUrl}/events/${encodeURIComponent(input.eventId)}`),
            accessToken,
          ),
        );
        if (body.extendedProperties?.private?.ai_agents_idempotency_key !== input.idempotencyKey) {
          throw new AgentDependencyError(
            'CONFLICT',
            false,
            'Google Calendar event ID is already owned by another event',
          );
        }
        return { eventId: body.id };
      });
    } catch (error) {
      if (error instanceof AgentDependencyError && error.code === 'NOT_FOUND') return null;
      throw error;
    }
  }

  async findConflictingEvents(
    input: FindCalendarConflictsInput,
  ): Promise<readonly GoogleCalendarEvent[]> {
    validateCalendarTimeRange(input);
    return this.#withAccessToken(input.googleConnectionId, async (accessToken) => {
      const url = new URL(`${calendarApiBaseUrl}/events`);
      url.searchParams.set('timeMin', input.startAt);
      url.searchParams.set('timeMax', input.endAt);
      url.searchParams.set('singleEvents', 'true');
      url.searchParams.set('showDeleted', 'false');
      url.searchParams.set('orderBy', 'startTime');
      const body = parseCalendarResponse(
        calendarEventListSchema,
        await this.#requestJson(url, accessToken),
      );
      return (body.items ?? [])
        .filter((event) => event.transparency !== 'transparent')
        .map((event) => ({ eventId: event.id }));
    });
  }

  async createEvent(input: CreateGoogleCalendarEventInput): Promise<CreatedGoogleCalendarEvent> {
    validateCalendarEventReference(input);
    validateCalendarTimeRange(input);
    requireIdentifier(input.idempotencyKey, 'Calendar idempotency key');
    for (const [name, value] of Object.entries({
      'Calendar description': input.description,
      'Calendar location': input.location,
      'Calendar summary': input.summary,
    })) {
      if (!value.trim() || value.length > 8_192) {
        throw new AgentDependencyError('INVALID_REQUEST', false, `${name} is invalid`);
      }
    }
    if (!isValidIanaTimeZone(input.timeZone)) {
      throw new AgentDependencyError('INVALID_REQUEST', false, 'Calendar timezone is invalid');
    }
    return this.#withAccessToken(input.googleConnectionId, async (accessToken) => {
      const body = parseCalendarResponse(
        calendarEventSchema,
        await this.#requestJson(new URL(`${calendarApiBaseUrl}/events`), accessToken, 'POST', {
          description: input.description,
          end: { dateTime: input.endAt, timeZone: input.timeZone },
          extendedProperties: { private: { ai_agents_idempotency_key: input.idempotencyKey } },
          id: input.eventId,
          location: input.location,
          reminders: { useDefault: true },
          start: { dateTime: input.startAt, timeZone: input.timeZone },
          summary: input.summary,
        }),
      );
      if (body.id !== input.eventId) {
        throw new AgentDependencyError(
          'INVALID_RESPONSE',
          false,
          'Google Calendar created an event with an unexpected ID',
        );
      }
      return { eventId: body.id };
    });
  }

  async #withAccessToken<T>(
    connectionId: string,
    request: (accessToken: string) => Promise<T>,
  ): Promise<T> {
    let accessToken = await this.options.accessTokens.getAccessToken(connectionId, [
      calendarEventsScope,
    ]);
    try {
      return await request(accessToken);
    } catch (error) {
      if (!(error instanceof CalendarHttpStatusError) || error.status !== 401) throw error;
      this.options.accessTokens.invalidateAccessToken(connectionId);
      accessToken = await this.options.accessTokens.getAccessToken(connectionId, [
        calendarEventsScope,
      ]);
      try {
        return await request(accessToken);
      } catch (retryError) {
        if (retryError instanceof CalendarHttpStatusError && retryError.status === 401) {
          throw new AgentDependencyError(
            'AUTHENTICATION_REQUIRED',
            false,
            'Google access token was rejected',
          );
        }
        throw retryError;
      }
    }
  }

  async #requestJson(
    url: URL,
    accessToken: string,
    method = 'GET',
    payload?: unknown,
  ): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      const response = await this.#fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${accessToken}`,
          ...(payload ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(payload ? { body: JSON.stringify(payload) } : {}),
        signal: controller.signal,
      });
      const body = (await response.json().catch(() => null)) as unknown;
      if (response.status === 401) throw new CalendarHttpStatusError(401);
      if (!response.ok) throw toCalendarError(response.status, body);
      if (body === null) {
        throw new AgentDependencyError(
          'INVALID_RESPONSE',
          false,
          'Google Calendar returned an invalid response',
        );
      }
      return body;
    } catch (error) {
      if (error instanceof AgentDependencyError || error instanceof CalendarHttpStatusError)
        throw error;
      throw new AgentDependencyError(
        'TEMPORARY_UNAVAILABLE',
        true,
        'Google Calendar service is temporarily unavailable',
        { cause: error },
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function deterministicCalendarEventId(idempotencyKey: string): string {
  requireIdentifier(idempotencyKey, 'Calendar idempotency key');
  return `aia${createHash('sha256').update(idempotencyKey).digest('hex')}`;
}

export function deterministicDraftMessageId(idempotencyKey: string): string {
  requireIdentifier(idempotencyKey, 'Draft idempotency key');
  return `<${createHash('sha256').update(idempotencyKey).digest('hex')}@ai-agents.invalid>`;
}

export function createReplyMime(
  input: Omit<CreateReplyDraftInput, 'googleConnectionId' | 'gmailThreadId'>,
): string {
  for (const [name, value] of Object.entries({
    From: input.from,
    To: input.to,
    Subject: input.subject,
    'In-Reply-To': input.inReplyTo,
  })) {
    if (!value.trim() || /[\r\n]/u.test(value)) {
      throw new AgentDependencyError('INVALID_REQUEST', false, `Gmail Draft ${name} is invalid`);
    }
  }
  if (!input.body.trim() || Buffer.byteLength(input.body, 'utf8') > 16 * 1024) {
    throw new AgentDependencyError('INVALID_REQUEST', false, 'Gmail Draft body is invalid');
  }
  const references = [...new Set(input.references.filter(isValidMessageId))].slice(-20);
  if (!isValidMessageId(input.inReplyTo)) {
    throw new AgentDependencyError('INVALID_REQUEST', false, 'Gmail Draft In-Reply-To is invalid');
  }
  if (!references.includes(input.inReplyTo)) references.push(input.inReplyTo);
  const encodedSubject = encodeMimeHeader(input.subject);
  const encodedBody = Buffer.from(input.body.replace(/\r?\n/gu, '\r\n'), 'utf8')
    .toString('base64')
    .replace(/(.{76})/gu, '$1\r\n');
  const message = [
    `From: ${input.from}`,
    `To: ${input.to}`,
    `Subject: ${encodedSubject}`,
    `In-Reply-To: ${input.inReplyTo}`,
    `References: ${foldMessageIds(references)}`,
    `Message-ID: ${deterministicDraftMessageId(input.idempotencyKey)}`,
    `X-AI-Agents-Draft-Key: ${createHash('sha256').update(input.idempotencyKey).digest('base64url')}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    encodedBody,
  ].join('\r\n');
  return Buffer.from(message, 'utf8').toString('base64url');
}

function validateDraftReference(input: FindReplyDraftInput): void {
  requireUuid(input.googleConnectionId);
  requireIdentifier(input.gmailThreadId, 'Gmail thread ID');
  requireIdentifier(input.idempotencyKey, 'Draft idempotency key');
}

function isValidMessageId(value: string): boolean {
  return /^<[^<>\r\n]+>$/u.test(value) && Buffer.byteLength(value, 'utf8') <= 512;
}

function foldMessageIds(messageIds: readonly string[]): string {
  const lines: string[] = [];
  let line = '';
  for (const messageId of messageIds) {
    const candidate = line ? `${line} ${messageId}` : messageId;
    if (line && Buffer.byteLength(candidate, 'utf8') > 900) {
      lines.push(line);
      line = messageId;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  return lines.join('\r\n ');
}

function encodeMimeHeader(value: string): string {
  if (/^[\x20-\x7e]*$/u.test(value) && value.length <= 75) return value;
  const maximumEncodedWordBytes = 45;
  const chunks: string[] = [];
  let chunk = '';
  let chunkBytes = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, 'utf8');
    if (chunk && chunkBytes + characterBytes > maximumEncodedWordBytes) {
      chunks.push(chunk);
      chunk = '';
      chunkBytes = 0;
    }
    chunk += character;
    chunkBytes += characterBytes;
  }
  if (chunk) chunks.push(chunk);
  return chunks
    .map((part) => `=?UTF-8?B?${Buffer.from(part, 'utf8').toString('base64')}?=`)
    .join('\r\n ');
}

class GmailHttpStatusError extends Error {
  constructor(readonly status: number) {
    super(`Gmail request failed with status ${status}`);
    this.name = 'GmailHttpStatusError';
  }
}

class CalendarHttpStatusError extends Error {
  constructor(readonly status: number) {
    super(`Google Calendar request failed with status ${status}`);
    this.name = 'CalendarHttpStatusError';
  }
}

function toGmailError(status: number, body: unknown): AgentDependencyError {
  const reasons = extractGoogleErrorReasons(body);
  if (
    status === 429 ||
    (status === 403 && reasons.some((reason) => reason.includes('ratelimit')))
  ) {
    return new AgentDependencyError('RATE_LIMITED', true, 'Gmail rate limit was exceeded');
  }
  if (status === 408 || status >= 500) {
    return new AgentDependencyError(
      'TEMPORARY_UNAVAILABLE',
      true,
      'Gmail service is temporarily unavailable',
    );
  }
  if (status === 400) {
    return new AgentDependencyError('INVALID_REQUEST', false, 'Gmail rejected the request');
  }
  if (status === 403) {
    return new AgentDependencyError('PERMISSION_DENIED', false, 'Gmail access was denied');
  }
  if (status === 404) {
    return new AgentDependencyError('NOT_FOUND', false, 'Gmail resource was not found');
  }
  return new AgentDependencyError('UNKNOWN', false, 'Gmail request failed');
}

function toCalendarError(status: number, body: unknown): AgentDependencyError {
  const reasons = extractGoogleErrorReasons(body);
  if (
    status === 429 ||
    (status === 403 && reasons.some((reason) => reason.includes('ratelimit')))
  ) {
    return new AgentDependencyError(
      'RATE_LIMITED',
      true,
      'Google Calendar rate limit was exceeded',
    );
  }
  if (status === 408 || status >= 500) {
    return new AgentDependencyError(
      'TEMPORARY_UNAVAILABLE',
      true,
      'Google Calendar service is temporarily unavailable',
    );
  }
  if (status === 400) {
    return new AgentDependencyError(
      'INVALID_REQUEST',
      false,
      'Google Calendar rejected the request',
    );
  }
  if (status === 403) {
    return new AgentDependencyError(
      'PERMISSION_DENIED',
      false,
      'Google Calendar access was denied',
    );
  }
  if (status === 404) {
    return new AgentDependencyError('NOT_FOUND', false, 'Google Calendar resource was not found');
  }
  if (status === 409) {
    return new AgentDependencyError('CONFLICT', false, 'Google Calendar event already exists');
  }
  return new AgentDependencyError('UNKNOWN', false, 'Google Calendar request failed');
}

function parseGmailResponse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new AgentDependencyError('INVALID_RESPONSE', false, 'Gmail returned an invalid response');
  }
  return parsed.data;
}

function parseCalendarResponse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new AgentDependencyError(
      'INVALID_RESPONSE',
      false,
      'Google Calendar returned an invalid response',
    );
  }
  return parsed.data;
}

function extractGoogleErrorReasons(body: unknown): string[] {
  if (!body || typeof body !== 'object' || !('error' in body)) {
    return [];
  }
  const error = body.error;
  if (!error || typeof error !== 'object' || !('errors' in error) || !Array.isArray(error.errors)) {
    return [];
  }
  return error.errors.flatMap((entry) =>
    entry && typeof entry === 'object' && 'reason' in entry && typeof entry.reason === 'string'
      ? [entry.reason.toLowerCase()]
      : [],
  );
}

function decodeBase64Url(value: string, charset = 'utf-8'): string {
  try {
    if (!/^[A-Za-z0-9_-]*$/u.test(value) || value.length % 4 === 1) {
      throw new Error('Invalid Base64URL');
    }
    const decoded = Buffer.from(value, 'base64url');
    if (decoded.length === 0 && value.length > 0) {
      throw new Error('Invalid Base64URL');
    }
    return new TextDecoder(charset, { fatal: true }).decode(decoded);
  } catch (error) {
    throw new AgentDependencyError('INVALID_RESPONSE', false, 'Gmail message body is invalid', {
      cause: error,
    });
  }
}

function readHeaders(
  headers: readonly { readonly name: string; readonly value: string }[],
): Map<string, string> {
  const values = new Map<string, string>();
  for (const header of headers) {
    const name = header.name.trim().toLowerCase();
    if (name && !values.has(name)) {
      values.set(name, decodeMimeHeader(header.value.trim()));
    }
  }
  return values;
}

function readHeader(
  headers: readonly { readonly name: string; readonly value: string }[],
  expectedName: string,
): string | undefined {
  return headers.find((header) => header.name.trim().toLowerCase() === expectedName)?.value;
}

function readMimeCharset(contentType: string | undefined): string {
  if (!contentType) {
    return 'utf-8';
  }
  const match = /(?:^|;)\s*charset\s*=\s*(?:"([^"]+)"|'([^']+)'|([^;\s]+))/iu.exec(contentType);
  return (match?.[1] ?? match?.[2] ?? match?.[3] ?? 'utf-8').trim();
}

function decodeMimeHeader(value: string): string {
  return value
    .replace(/\r?\n[\t ]+/gu, ' ')
    .replace(/\?=\s+=\?/gu, '?==?')
    .replace(
      /=\?([^?]+)\?([bq])\?([^?]*)\?=/giu,
      (_match, charset: string, encoding: string, encoded: string) => {
        try {
          const bytes =
            encoding.toLowerCase() === 'b'
              ? Buffer.from(encoded, 'base64')
              : decodeQuotedPrintableHeader(encoded);
          return new TextDecoder(charset, { fatal: true }).decode(bytes);
        } catch {
          return _match;
        }
      },
    );
}

function decodeQuotedPrintableHeader(value: string): Uint8Array {
  const bytes: number[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === '_') {
      bytes.push(0x20);
      continue;
    }
    if (character === '=' && /^[0-9a-f]{2}$/iu.test(value.slice(index + 1, index + 3))) {
      bytes.push(Number.parseInt(value.slice(index + 1, index + 3), 16));
      index += 2;
      continue;
    }
    bytes.push(value.charCodeAt(index));
  }
  return Uint8Array.from(bytes);
}

function splitAddresses(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  const addresses: string[] = [];
  let start = 0;
  let quoted = false;
  let escaped = false;
  let angleDepth = 0;
  let commentDepth = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === '\\' && quoted) {
      escaped = true;
      continue;
    }
    if (character === '"' && commentDepth === 0) {
      quoted = !quoted;
      continue;
    }
    if (quoted) {
      continue;
    }
    if (character === '(') {
      commentDepth += 1;
      continue;
    }
    if (character === ')' && commentDepth > 0) {
      commentDepth -= 1;
      continue;
    }
    if (commentDepth > 0) {
      continue;
    }
    if (character === '<') {
      angleDepth += 1;
      continue;
    }
    if (character === '>' && angleDepth > 0) {
      angleDepth -= 1;
      continue;
    }
    if (character === ',' && angleDepth === 0) {
      const address = value.slice(start, index).trim();
      if (address) {
        addresses.push(address);
      }
      start = index + 1;
    }
  }
  const finalAddress = value.slice(start).trim();
  if (finalAddress) {
    addresses.push(finalAddress);
  }
  return addresses;
}

function normalizeText(value: string): string {
  return value
    .replace(/\r\n?/gu, '\n')
    .replace(/[\t ]+/gu, ' ')
    .replace(/ *\n */gu, '\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}

function htmlToText(value: string): string {
  return value
    .replace(/<!--[\s\S]*?-->/gu, '')
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/giu, '')
    .replace(/<(br|\/p|\/div|\/li|\/tr|\/h[1-6])\b[^>]*>/giu, '\n')
    .replace(/<[^>]*>/gu, '')
    .replace(/&nbsp;/giu, ' ')
    .replace(/&amp;/giu, '&')
    .replace(/&lt;/giu, '<')
    .replace(/&gt;/giu, '>')
    .replace(/&quot;/giu, '"')
    .replace(
      /&#(?:x([0-9a-f]+)|([0-9]+));/giu,
      (_match, hex: string | undefined, decimal: string | undefined) => {
        const codePoint = Number.parseInt(hex ?? decimal ?? '', hex ? 16 : 10);
        return Number.isSafeInteger(codePoint) &&
          codePoint >= 0 &&
          codePoint <= 0x10ffff &&
          (codePoint < 0xd800 || codePoint > 0xdfff)
          ? String.fromCodePoint(codePoint)
          : _match;
      },
    );
}

function truncateText(value: string, maximumBytes: number): { text: string; truncated: boolean } {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length <= maximumBytes) {
    return { text: value, truncated: false };
  }
  let end = maximumBytes;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  while (end > 0) {
    try {
      return { text: decoder.decode(bytes.subarray(0, end)).trimEnd(), truncated: true };
    } catch {
      end -= 1;
    }
  }
  return { text: '', truncated: true };
}

function requireIdentifier(value: string, label: string): void {
  if (!value.trim()) {
    throw new AgentDependencyError('INVALID_REQUEST', false, `${label} must not be empty`);
  }
}

function validateCalendarEventReference(input: FindGoogleCalendarEventInput): void {
  requireUuid(input.googleConnectionId);
  requireIdentifier(input.idempotencyKey, 'Calendar idempotency key');
  if (!/^[a-v0-9]{5,1024}$/u.test(input.eventId)) {
    throw new AgentDependencyError('INVALID_REQUEST', false, 'Google Calendar event ID is invalid');
  }
}

function validateCalendarTimeRange(input: FindCalendarConflictsInput): void {
  requireUuid(input.googleConnectionId);
  const startAt = new Date(input.startAt);
  const endAt = new Date(input.endAt);
  if (Number.isNaN(startAt.getTime()) || Number.isNaN(endAt.getTime()) || endAt <= startAt) {
    throw new AgentDependencyError(
      'INVALID_REQUEST',
      false,
      'Google Calendar time range is invalid',
    );
  }
}

function isValidIanaTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function requireUuid(value: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)) {
    throw new AgentDependencyError(
      'INVALID_REQUEST',
      false,
      'Google connection ID must be a valid UUID',
    );
  }
}
