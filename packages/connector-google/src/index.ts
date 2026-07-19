import { AgentDependencyError } from '@ai-agents/agent-core';
import type { GoogleAccessTokenProvider } from '@ai-agents/google-oauth';
import { z } from 'zod';

const gmailApiBaseUrl = 'https://gmail.googleapis.com/gmail/v1/users/me';
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
  }): Promise<EmailMessage>;
  getThread(input: {
    readonly googleConnectionId: string;
    readonly gmailThreadId: string;
  }): Promise<EmailThread>;
}

export interface HttpGmailReaderOptions {
  readonly accessTokens: GoogleAccessTokenProvider;
  readonly bodyLimitBytes?: number;
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
  }): Promise<EmailMessage> {
    requireUuid(input.googleConnectionId);
    requireIdentifier(input.gmailMessageId, 'Gmail message ID');
    return this.#withAccessToken(input.googleConnectionId, async (accessToken) => {
      const raw = parseGmailResponse(
        messageSchema,
        await this.#requestJson(
          new URL(
            `${gmailApiBaseUrl}/messages/${encodeURIComponent(input.gmailMessageId)}?format=full`,
          ),
          accessToken,
        ),
      );
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
    let accessToken = await this.options.accessTokens.getAccessToken(connectionId);
    try {
      return await request(accessToken);
    } catch (error) {
      if (!(error instanceof GmailHttpStatusError) || error.status !== 401) {
        throw error;
      }
      this.options.accessTokens.invalidateAccessToken(connectionId);
      accessToken = await this.options.accessTokens.getAccessToken(connectionId);
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
      const decoded = decodeBase64Url(
        data,
        readMimeCharset(readHeader(part.headers ?? [], 'content-type')),
      );
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

class GmailHttpStatusError extends Error {
  constructor(readonly status: number) {
    super(`Gmail request failed with status ${status}`);
    this.name = 'GmailHttpStatusError';
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

function parseGmailResponse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new AgentDependencyError('INVALID_RESPONSE', false, 'Gmail returned an invalid response');
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

function requireUuid(value: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)) {
    throw new AgentDependencyError(
      'INVALID_REQUEST',
      false,
      'Google connection ID must be a valid UUID',
    );
  }
}
