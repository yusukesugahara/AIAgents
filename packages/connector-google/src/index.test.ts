import { describe, expect, test } from 'bun:test';
import type { GoogleAccessTokenProvider } from '@ai-agents/google-oauth';
import { HttpGmailReader } from './index';

const base64Url = (value: string) => Buffer.from(value, 'utf8').toString('base64url');

class FakeAccessTokens implements GoogleAccessTokenProvider {
  calls = 0;
  invalidations: string[] = [];

  async getAccessToken(): Promise<string> {
    this.calls += 1;
    return `access-${this.calls}`;
  }

  invalidateAccessToken(connectionId: string): void {
    this.invalidations.push(connectionId);
  }
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json' },
    status,
  });
}

function emailMessage(overrides: Record<string, unknown> = {}) {
  return {
    id: 'message-1',
    internalDate: '1784419200000',
    labelIds: ['INBOX'],
    payload: {
      headers: [
        { name: 'From', value: 'Recruiter <recruiter@example.com>' },
        { name: 'To', value: 'candidate@example.com, Other <other@example.com>' },
        { name: 'Cc', value: 'copy@example.com' },
        { name: 'Subject', value: ' Interview ' },
        { name: 'Message-ID', value: '<message@example.com>' },
        { name: 'In-Reply-To', value: '<previous@example.com>' },
        { name: 'References', value: '<root@example.com> <previous@example.com>' },
      ],
      mimeType: 'multipart/alternative',
      parts: [
        { body: { data: base64Url('<p>Hello <strong>HTML</strong></p>') }, mimeType: 'text/html' },
        { body: { data: base64Url('Hello plain\r\n\r\n  World') }, mimeType: 'text/plain' },
      ],
    },
    threadId: 'thread-1',
    ...overrides,
  };
}

describe('HttpGmailReader', () => {
  test('lists one page of recent inbox messages with the default query', async () => {
    const tokens = new FakeAccessTokens();
    let requestUrl: URL | undefined;
    let authorization: string | null = null;
    const reader = new HttpGmailReader({
      accessTokens: tokens,
      fetchImplementation: async (input, init) => {
        requestUrl = new URL(String(input));
        authorization = new Headers(init?.headers).get('Authorization');
        return response({
          messages: [{ id: 'message-1', threadId: 'thread-1' }],
          nextPageToken: 'next-page',
        });
      },
    });

    await expect(reader.listMessages({ googleConnectionId: 'connection-1' })).resolves.toEqual({
      messages: [{ id: 'message-1', threadId: 'thread-1' }],
      nextPageToken: 'next-page',
    });
    expect(requestUrl?.pathname).toBe('/gmail/v1/users/me/messages');
    expect(requestUrl?.searchParams.get('q')).toBe('in:inbox newer_than:1d');
    expect(requestUrl?.searchParams.get('maxResults')).toBe('100');
    expect(String(authorization)).toBe('Bearer access-1');
  });

  test('normalizes multipart messages and prefers plain text over HTML', async () => {
    const reader = new HttpGmailReader({
      accessTokens: new FakeAccessTokens(),
      fetchImplementation: async () => response(emailMessage()),
    });

    const message = await reader.getMessage({
      googleConnectionId: 'connection-1',
      gmailMessageId: 'message-1',
    });
    expect(message).toEqual({
      bodyText: 'Hello plain\n\nWorld',
      bodyTruncated: false,
      cc: ['copy@example.com'],
      from: 'Recruiter <recruiter@example.com>',
      id: 'message-1',
      inReplyTo: '<previous@example.com>',
      labelIds: ['INBOX'],
      messageId: '<message@example.com>',
      references: ['<root@example.com>', '<previous@example.com>'],
      sentAt: new Date('2026-07-19T00:00:00.000Z'),
      subject: 'Interview',
      threadId: 'thread-1',
      to: ['candidate@example.com', 'Other <other@example.com>'],
    });
  });

  test('converts HTML-only content and fetches external text parts but ignores files', async () => {
    const urls: string[] = [];
    const reader = new HttpGmailReader({
      accessTokens: new FakeAccessTokens(),
      fetchImplementation: async (input) => {
        const url = String(input);
        urls.push(url);
        if (url.includes('/attachments/')) {
          return response({ data: base64Url('External body') });
        }
        return response(
          emailMessage({
            payload: {
              headers: [],
              mimeType: 'multipart/mixed',
              parts: [
                {
                  body: { data: base64Url('<div>Hello &amp; <b>World</b></div>') },
                  mimeType: 'text/html',
                },
                { body: { attachmentId: 'body-attachment' }, mimeType: 'text/plain' },
                {
                  body: { attachmentId: 'file-attachment' },
                  filename: 'resume.pdf',
                  mimeType: 'application/pdf',
                },
              ],
            },
          }),
        );
      },
    });

    const message = await reader.getMessage({
      googleConnectionId: 'connection-1',
      gmailMessageId: 'message-1',
    });
    expect(message.bodyText).toBe('External body');
    expect(urls.filter((url) => url.includes('/attachments/'))).toHaveLength(1);
  });

  test('sorts thread messages by Gmail internal date and truncates message bodies by byte size', async () => {
    const reader = new HttpGmailReader({
      accessTokens: new FakeAccessTokens(),
      bodyLimitBytes: 8,
      fetchImplementation: async () =>
        response({
          id: 'thread-1',
          messages: [
            emailMessage({ id: 'later', internalDate: '1784419201000' }),
            emailMessage({ id: 'earlier', internalDate: '1784419200000' }),
          ],
        }),
    });

    const thread = await reader.getThread({
      googleConnectionId: 'connection-1',
      gmailThreadId: 'thread-1',
    });
    expect(thread.messages.map((message) => message.id)).toEqual(['earlier', 'later']);
    expect(thread.messages.every((message) => message.bodyTruncated)).toBe(true);
  });

  test('retries a rejected access token once and maps the second rejection to authentication required', async () => {
    const tokens = new FakeAccessTokens();
    let calls = 0;
    const reader = new HttpGmailReader({
      accessTokens: tokens,
      fetchImplementation: async () => {
        calls += 1;
        return response({ error: { message: 'unauthorized' } }, 401);
      },
    });

    await expect(
      reader.getMessage({ googleConnectionId: 'connection-1', gmailMessageId: 'message-1' }),
    ).rejects.toMatchObject({ code: 'AUTHENTICATION_REQUIRED', retryable: false });
    expect(calls).toBe(2);
    expect(tokens.invalidations).toEqual(['connection-1']);
  });

  test('classifies Gmail failures and invalid provider payloads without exposing provider details', async () => {
    const cases = [
      { code: 'INVALID_REQUEST', retryable: false, status: 400 },
      { code: 'PERMISSION_DENIED', retryable: false, status: 403 },
      { code: 'NOT_FOUND', retryable: false, status: 404 },
      { code: 'RATE_LIMITED', retryable: true, status: 429 },
      { code: 'TEMPORARY_UNAVAILABLE', retryable: true, status: 503 },
    ] as const;
    for (const expected of cases) {
      const reader = new HttpGmailReader({
        accessTokens: new FakeAccessTokens(),
        fetchImplementation: async () =>
          response({ error: { message: 'provider secret' } }, expected.status),
      });
      await expect(
        reader.getMessage({ googleConnectionId: 'connection-1', gmailMessageId: 'message-1' }),
      ).rejects.toMatchObject({ code: expected.code, retryable: expected.retryable });
    }

    const malformed = new HttpGmailReader({
      accessTokens: new FakeAccessTokens(),
      fetchImplementation: async () => response({ id: 'message-1', threadId: 'thread-1' }),
    });
    await expect(
      malformed.getMessage({ googleConnectionId: 'connection-1', gmailMessageId: 'message-1' }),
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE', retryable: false });
  });

  test('rejects malformed Base64URL message bodies and invalid request limits', async () => {
    const reader = new HttpGmailReader({
      accessTokens: new FakeAccessTokens(),
      fetchImplementation: async () =>
        response(
          emailMessage({
            payload: { body: { data: '@@@' }, headers: [], mimeType: 'text/plain' },
          }),
        ),
    });
    await expect(
      reader.getMessage({ googleConnectionId: 'connection-1', gmailMessageId: 'message-1' }),
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE', retryable: false });
    await expect(
      reader.listMessages({ googleConnectionId: 'connection-1', maxResults: 101 }),
    ).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    });
  });

  test('turns a timed-out Gmail request into a retryable dependency error', async () => {
    const reader = new HttpGmailReader({
      accessTokens: new FakeAccessTokens(),
      fetchImplementation: async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
      timeoutMs: 1,
    });

    await expect(
      reader.getMessage({ googleConnectionId: 'connection-1', gmailMessageId: 'message-1' }),
    ).rejects.toMatchObject({ code: 'TEMPORARY_UNAVAILABLE', retryable: true });
  });
});
