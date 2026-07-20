import { timingSafeEqual } from 'node:crypto';
import type { GoogleOAuthErrorCode } from '@ai-agents/google-oauth';
import type { Context } from 'hono';
import type { ApiEnvironment } from './api-types';

export function errorResponse(
  context: Context<ApiEnvironment>,
  code: string,
  status: 400 | 401 | 404 | 409 | 500,
  message: string,
) {
  const requestId = context.get('requestId');
  context.header('X-Request-Id', requestId);
  return context.json({ error: { code, message, requestId } }, status);
}

export function hasValidBearerToken(
  authorization: string | undefined,
  expectedToken: string,
): boolean {
  const token = authorization?.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : '';
  const encoder = new TextEncoder();
  const actual = encoder.encode(token);
  const expected = encoder.encode(expectedToken);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function isPublicPath(pathname: string): boolean {
  return (
    pathname === '/health/live' ||
    pathname === '/health/ready' ||
    pathname === '/auth/google' ||
    pathname === '/auth/google/compose' ||
    pathname === '/auth/google/calendar' ||
    pathname === '/auth/google/callback' ||
    pathname === '/auth/google/complete'
  );
}

const oauthCookieName = 'ai_agents_oauth_nonce';

export function serializeOAuthCookie(value: string, secure: boolean): string {
  return `${oauthCookieName}=${value}; Path=/auth/google; Max-Age=600; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
}

export function clearOAuthCookie(secure: boolean): string {
  return `${oauthCookieName}=; Path=/auth/google; Max-Age=0; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
}

export function readOAuthCookie(header: string | undefined): string | undefined {
  if (!header) return undefined;
  return header
    .split(';')
    .map((value) => value.trim())
    .find((value) => value.startsWith(`${oauthCookieName}=`))
    ?.slice(oauthCookieName.length + 1);
}

export function oauthErrorMessage(code: GoogleOAuthErrorCode): string {
  switch (code) {
    case 'OAUTH_STATE_INVALID':
      return 'OAuth authorization is invalid or expired';
    case 'OAUTH_AUTHORIZATION_DENIED':
      return 'Google authorization was denied';
    case 'OAUTH_PROFILE_INVALID':
      return 'Google account email could not be verified';
    case 'OAUTH_REFRESH_TOKEN_MISSING':
      return 'Google did not grant offline access';
    case 'OAUTH_CONFIGURATION_INVALID':
    case 'OAUTH_PROVIDER_FAILURE':
      return 'Google OAuth is temporarily unavailable';
  }
}
