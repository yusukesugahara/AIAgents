import { GoogleOAuthError, type GoogleOAuthService } from '@ai-agents/google-oauth';
import type { Context, Hono } from 'hono';
import type { ApiAppOptions, ApiEnvironment, ApiLogger } from '../api-types';
import { clearOAuthCookie, readOAuthCookie, serializeOAuthCookie } from '../http';

export function registerOAuthRoutes(
  app: Hono<ApiEnvironment>,
  options: ApiAppOptions,
  logger: ApiLogger,
): void {
  const startAuthorization = async (
    context: Context<ApiEnvironment>,
    purpose: 'calendar_events' | 'gmail_compose' | 'gmail_read',
    event: string,
  ) => {
    context.header('Cache-Control', 'no-store');
    context.header('Referrer-Policy', 'no-referrer');
    const authorization = await requireGoogleOAuth(options).begin(purpose);
    context.header(
      'Set-Cookie',
      serializeOAuthCookie(authorization.browserNonce, options.oauthCookieSecure ?? false),
    );
    logger.info({ event, requestId: context.get('requestId') });
    return context.redirect(authorization.authorizationUrl, 303);
  };

  app.get('/auth/google', (context) =>
    startAuthorization(context, 'gmail_read', 'oauth.google.authorization_started'),
  );
  app.get('/auth/google/compose', (context) =>
    startAuthorization(context, 'gmail_compose', 'oauth.google.compose_authorization_started'),
  );
  app.get('/auth/google/calendar', (context) =>
    startAuthorization(context, 'calendar_events', 'oauth.google.calendar_authorization_started'),
  );
  app.get('/auth/google/callback', async (context) => {
    const state = context.req.query('state') ?? '';
    const authorizationError = context.req.query('error');
    const browserNonce = readOAuthCookie(context.req.header('Cookie')) ?? '';
    context.header('Cache-Control', 'no-store');
    context.header('Referrer-Policy', 'no-referrer');
    context.header('Set-Cookie', clearOAuthCookie(options.oauthCookieSecure ?? false));
    const googleOAuth = requireGoogleOAuth(options);
    if (authorizationError) {
      await googleOAuth.cancel({ browserNonce, state });
      if (authorizationError === 'access_denied') {
        throw new GoogleOAuthError('OAUTH_AUTHORIZATION_DENIED', 'Google authorization was denied');
      }
      throw new GoogleOAuthError('OAUTH_PROVIDER_FAILURE', 'Google authorization failed');
    }
    await googleOAuth.complete({
      browserNonce,
      code: context.req.query('code') ?? '',
      state,
    });
    logger.info({ event: 'oauth.google.connected', requestId: context.get('requestId') });
    return context.redirect('/auth/google/complete', 303);
  });
  app.get('/auth/google/complete', (context) => {
    context.header('Cache-Control', 'no-store');
    return context.redirect('/setup?oauth=completed', 303);
  });
}

function requireGoogleOAuth(
  options: ApiAppOptions,
): Pick<GoogleOAuthService, 'begin' | 'cancel' | 'complete'> {
  if (!options.googleOAuth) {
    throw new GoogleOAuthError('OAUTH_CONFIGURATION_INVALID', 'Google OAuth is not configured');
  }
  return options.googleOAuth;
}
