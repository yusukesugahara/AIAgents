import { describe, expect, test } from 'bun:test';
import { GoogleOAuthError, type GoogleOAuthService } from '@ai-agents/google-oauth';
import { createApp } from './app';

const logger = { error() {}, info() {} };

describe('API health routes', () => {
  test('returns liveness status', async () => {
    const response = await createApp({ logger }).request('/health/live');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
  });

  test('returns not ready when the database is missing', async () => {
    const response = await createApp({ logger }).request('/health/ready');

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: 'not_ready' });
  });

  test('returns ready when the database is healthy', async () => {
    const response = await createApp({
      database: { isReady: async () => true },
      logger,
    }).request('/health/ready');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
  });

  test('returns not ready when required OAuth is unavailable', async () => {
    const response = await createApp({
      database: { isReady: async () => true },
      logger,
      oauthRequired: true,
    }).request('/health/ready');

    expect(response.status).toBe(503);
  });
});

describe('API Google OAuth routes', () => {
  test('starts and completes public routes without exposing callback credentials', async () => {
    const completed: Array<{ browserNonce: string; code: string; state: string }> = [];
    const cancelled: Array<{ browserNonce: string; state: string }> = [];
    const purposes: Array<'calendar_events' | 'gmail_compose' | 'gmail_read' | undefined> = [];
    const googleOAuth = {
      begin: async (purpose?: 'calendar_events' | 'gmail_compose' | 'gmail_read') => {
        purposes.push(purpose);
        return {
          authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?state=secret-state',
          browserNonce: 'browser-nonce',
        };
      },
      cancel: async (input: { browserNonce: string; state: string }) => {
        cancelled.push(input);
      },
      complete: async (input: { browserNonce: string; code: string; state: string }) => {
        completed.push(input);
      },
    } as Pick<GoogleOAuthService, 'begin' | 'cancel' | 'complete'>;
    const app = createApp({
      accessToken: 'api-secret',
      googleOAuth,
      logger,
      requestIdGenerator: () => 'generated-request-id',
    });

    const start = await app.request('/auth/google');
    expect(start.status).toBe(303);
    expect(start.headers.get('location')).toContain('accounts.google.com');
    expect(start.headers.get('cache-control')).toBe('no-store');
    expect(start.headers.get('referrer-policy')).toBe('no-referrer');
    expect(start.headers.get('set-cookie')).toContain('HttpOnly');
    expect(start.headers.get('set-cookie')).toContain('SameSite=Lax');
    const cookie = start.headers.get('set-cookie')?.split(';')[0] ?? '';

    const composeStart = await app.request('/auth/google/compose');
    expect(composeStart.status).toBe(303);
    expect(composeStart.headers.get('set-cookie')).toContain('ai_agents_oauth_nonce=');
    const calendarStart = await app.request('/auth/google/calendar');
    expect(calendarStart.status).toBe(303);
    expect(calendarStart.headers.get('set-cookie')).toContain('ai_agents_oauth_nonce=');
    expect(purposes).toEqual(['gmail_read', 'gmail_compose', 'calendar_events']);

    const callback = await app.request('/auth/google/callback?code=code-value&state=state-value', {
      headers: { Cookie: cookie },
    });
    expect(callback.status).toBe(303);
    expect(callback.headers.get('location')).toBe('/auth/google/complete');
    expect(callback.headers.get('location')).not.toContain('code-value');
    expect(callback.headers.get('cache-control')).toBe('no-store');
    expect(callback.headers.get('referrer-policy')).toBe('no-referrer');
    expect(completed).toEqual([
      { browserNonce: 'browser-nonce', code: 'code-value', state: 'state-value' },
    ]);

    const denied = await app.request(
      '/auth/google/callback?error=access_denied&state=cancel-state',
      { headers: { Cookie: cookie } },
    );
    expect(denied.status).toBe(400);
    expect(await denied.json()).toMatchObject({ error: { code: 'OAUTH_AUTHORIZATION_DENIED' } });
    expect(cancelled).toEqual([{ browserNonce: 'browser-nonce', state: 'cancel-state' }]);
    expect((await app.request('/agents')).status).toBe(401);

    const providerFailure = await app.request(
      '/auth/google/callback?error=temporarily_unavailable&state=provider-state',
      { headers: { Cookie: cookie } },
    );
    expect(providerFailure.status).toBe(500);
    expect(await providerFailure.json()).toMatchObject({
      error: { code: 'OAUTH_PROVIDER_FAILURE' },
    });
  });

  test('returns common errors for unavailable OAuth and invalid callback state', async () => {
    const unavailable = await createApp({
      logger,
      requestIdGenerator: () => 'generated-request-id',
    }).request('/auth/google');
    expect(unavailable.status).toBe(500);
    expect(unavailable.headers.get('cache-control')).toBe('no-store');
    expect(unavailable.headers.get('referrer-policy')).toBe('no-referrer');
    expect(await unavailable.json()).toEqual({
      error: {
        code: 'OAUTH_CONFIGURATION_INVALID',
        message: 'Google OAuth is temporarily unavailable',
        requestId: 'generated-request-id',
      },
    });

    const app = createApp({
      googleOAuth: {
        begin: async () => ({
          authorizationUrl: 'https://accounts.google.com',
          browserNonce: 'nonce',
        }),
        cancel: async () => {
          throw new GoogleOAuthError('OAUTH_STATE_INVALID', 'sensitive state');
        },
        complete: async () => {},
      },
      logger,
      requestIdGenerator: () => 'generated-request-id',
    });
    const invalid = await app.request('/auth/google/callback?error=access_denied&state=bad');
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({
      error: {
        code: 'OAUTH_STATE_INVALID',
        message: 'OAuth authorization is invalid or expired',
        requestId: 'generated-request-id',
      },
    });
  });

  test('returns client errors for accounts that cannot complete connection setup', async () => {
    for (const code of ['OAUTH_PROFILE_INVALID', 'OAUTH_REFRESH_TOKEN_MISSING'] as const) {
      const app = createApp({
        googleOAuth: {
          begin: async () => ({
            authorizationUrl: 'https://accounts.google.com',
            browserNonce: '',
          }),
          cancel: async () => {},
          complete: async () => {
            throw new GoogleOAuthError(code, 'sensitive provider detail');
          },
        },
        logger,
        requestIdGenerator: () => 'generated-request-id',
      });

      const response = await app.request('/auth/google/callback?code=code&state=state');
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code } });
    }
  });

  test('uses a secure cookie when configured for a protected deployment', async () => {
    const response = await createApp({
      googleOAuth: {
        begin: async () => ({
          authorizationUrl: 'https://accounts.google.com',
          browserNonce: 'nonce',
        }),
        cancel: async () => {},
        complete: async () => {},
      },
      logger,
      oauthCookieSecure: true,
    }).request('/auth/google');

    expect(response.headers.get('set-cookie')).toContain('Secure');
  });
});
