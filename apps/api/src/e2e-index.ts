import {
  type GoogleAuthorizationRequest,
  type GoogleOAuthConfig,
  GoogleOAuthError,
  type GoogleOAuthProvider,
  type GoogleTokenSet,
  type GoogleUserProfile,
  googleOAuthScopes,
} from '@ai-agents/google-oauth';
import { startApi } from './server';

if (process.env.APP_ENV !== 'test') {
  throw new Error('The OAuth E2E API entrypoint requires APP_ENV=test');
}

const email = process.env.GOOGLE_OAUTH_E2E_EMAIL?.trim();
if (!email) {
  throw new Error('GOOGLE_OAUTH_E2E_EMAIL is required');
}

class E2eGoogleOAuthProvider implements GoogleOAuthProvider {
  constructor(
    private readonly redirectUri: string,
    private readonly email: string,
  ) {}

  createAuthorizationUrl(request: GoogleAuthorizationRequest): string {
    const url = new URL(this.redirectUri);
    url.search = new URLSearchParams({
      code: 'fake-authorization-code',
      state: request.state,
    }).toString();
    return url.toString();
  }

  async exchangeAuthorizationCode(input: {
    readonly code: string;
    readonly codeVerifier: string;
  }): Promise<GoogleTokenSet> {
    if (input.code !== 'fake-authorization-code' || !input.codeVerifier) {
      throw new GoogleOAuthError('OAUTH_PROVIDER_FAILURE', 'Google token exchange failed');
    }
    return {
      accessToken: 'fake-access-token',
      grantedScopes: googleOAuthScopes,
      refreshToken: 'fake-refresh-token',
    };
  }

  async getUserProfile(accessToken: string): Promise<GoogleUserProfile> {
    if (accessToken !== 'fake-access-token') {
      throw new GoogleOAuthError('OAUTH_PROVIDER_FAILURE', 'Google profile lookup failed');
    }
    return { email: this.email, emailVerified: true };
  }
}

startApi({
  createGoogleOAuthProvider: (config: GoogleOAuthConfig) =>
    new E2eGoogleOAuthProvider(config.redirectUri, email),
});
