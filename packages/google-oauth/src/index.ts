import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes as nodeRandomBytes,
} from 'node:crypto';
import { AgentDependencyError } from '@ai-agents/agent-core';

export const googleOAuthScopes = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/gmail.readonly',
] as const;

export const gmailReadonlyScope = 'https://www.googleapis.com/auth/gmail.readonly';
export const gmailComposeScope = 'https://www.googleapis.com/auth/gmail.compose';
export const calendarEventsScope = 'https://www.googleapis.com/auth/calendar.events';
export type GoogleOAuthPurpose = 'gmail_read' | 'gmail_compose' | 'calendar_events';

const authorizationEndpoint = 'https://accounts.google.com/o/oauth2/v2/auth';
const tokenEndpoint = 'https://oauth2.googleapis.com/token';
const userInfoEndpoint = 'https://openidconnect.googleapis.com/v1/userinfo';

export type GoogleOAuthErrorCode =
  | 'OAUTH_AUTHORIZATION_DENIED'
  | 'OAUTH_CONFIGURATION_INVALID'
  | 'OAUTH_PROFILE_INVALID'
  | 'OAUTH_PROVIDER_FAILURE'
  | 'OAUTH_REFRESH_TOKEN_MISSING'
  | 'OAUTH_STATE_INVALID';

export type GoogleOAuthFailureReason = 'profile_lookup' | 'scope_not_granted' | 'token_exchange';

export class GoogleOAuthError extends Error {
  constructor(
    readonly code: GoogleOAuthErrorCode,
    message: string,
    readonly failureReason?: GoogleOAuthFailureReason,
    readonly providerError?: string,
    readonly providerStatus?: number,
  ) {
    super(message);
    this.name = 'GoogleOAuthError';
  }
}

export interface GoogleOAuthConfig {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUri: string;
  readonly tokenEncryptionKey: string;
}

export type GoogleAccessTokenConfig = Pick<
  GoogleOAuthConfig,
  'clientId' | 'clientSecret' | 'tokenEncryptionKey'
>;

export interface GoogleAuthorizationRequest {
  readonly codeChallenge: string;
  readonly scopes?: readonly string[];
  readonly state: string;
}

export interface GoogleOAuthAuthorization {
  readonly authorizationUrl: string;
  readonly browserNonce: string;
}

export interface GoogleTokenSet {
  readonly accessToken: string;
  readonly grantedScopes: readonly string[];
  readonly refreshToken: string | null;
}

export interface GoogleUserProfile {
  readonly email: string;
  readonly emailVerified: boolean;
}

export interface GoogleOAuthProvider {
  createAuthorizationUrl(request: GoogleAuthorizationRequest): string;
  exchangeAuthorizationCode(input: {
    readonly code: string;
    readonly codeVerifier: string;
  }): Promise<GoogleTokenSet>;
  getUserProfile(accessToken: string): Promise<GoogleUserProfile>;
}

export interface OAuthStateRecord {
  readonly encryptedCodeVerifier: string;
  readonly purpose?: GoogleOAuthPurpose;
}

export interface OAuthStateRepository {
  create(input: {
    readonly browserNonceHash: string;
    readonly encryptedCodeVerifier: string;
    readonly expiresAt: Date;
    readonly purpose?: GoogleOAuthPurpose;
    readonly stateHash: string;
  }): Promise<void>;
  consume(input: {
    readonly browserNonceHash: string;
    readonly stateHash: string;
  }): Promise<OAuthStateRecord | null>;
  deleteExpired(): Promise<void>;
}

export interface GoogleConnectionRecord {
  readonly encryptedRefreshToken: string;
}

export type GoogleConnectionUpsertInput =
  | {
      readonly email: string;
      readonly encryptedRefreshToken: string;
      readonly grantedScopes: readonly string[];
      readonly validateExistingRefreshToken?: never;
    }
  | {
      readonly email: string;
      readonly encryptedRefreshToken: null;
      readonly grantedScopes: readonly string[];
      readonly validateExistingRefreshToken: (encryptedRefreshToken: string) => boolean;
    };

export interface GoogleConnectionRepository {
  findByGoogleEmail(email: string): Promise<GoogleConnectionRecord | null>;
  upsert(input: GoogleConnectionUpsertInput): Promise<GoogleConnectionRecord | null>;
}

export interface GoogleConnectionCredential {
  readonly encryptedRefreshToken: string;
  readonly grantedScopes: readonly string[];
}

export interface GoogleConnectionSummary {
  readonly email: string;
  readonly grantedScopes: readonly string[];
  readonly id: string;
  readonly status: 'connected' | 'reauth_required';
  readonly updatedAt: Date;
}

/** Read-only connection metadata safe to expose behind the API authentication boundary. */
export interface GoogleConnectionSummaryRepository {
  listConnections(): Promise<readonly GoogleConnectionSummary[]>;
}

/** Runtime-only persistence boundary for a connected Google account. */
export interface GoogleConnectionCredentialRepository {
  findCredentialById(connectionId: string): Promise<GoogleConnectionCredential | null>;
  markReauthRequired(input: {
    readonly connectionId: string;
    readonly expectedEncryptedRefreshToken: string;
  }): Promise<boolean>;
}

export interface GoogleAccessTokenProvider {
  getAccessToken(connectionId: string, requiredScopes?: readonly string[]): Promise<string>;
  invalidateAccessToken(connectionId: string): void;
}

export interface GoogleRefreshedAccessToken {
  readonly accessToken: string;
  readonly expiresInSeconds: number;
}

export interface GoogleTokenRefresher {
  refreshAccessToken(refreshToken: string): Promise<GoogleRefreshedAccessToken>;
}

export type GoogleRefreshFailureCode =
  | 'INVALID_GRANT'
  | 'INVALID_RESPONSE'
  | 'PERMISSION_DENIED'
  | 'TEMPORARY_UNAVAILABLE'
  | 'UNKNOWN';

/** Intentionally contains no provider response body or credential value. */
export class GoogleRefreshTokenError extends Error {
  constructor(
    readonly code: GoogleRefreshFailureCode,
    message: string,
  ) {
    super(message);
    this.name = 'GoogleRefreshTokenError';
  }
}

export interface TokenCipher {
  decrypt(ciphertext: string): string;
  encrypt(plaintext: string): string;
}

export interface GoogleAccessTokenServiceOptions {
  readonly cipher: TokenCipher;
  readonly credentials: GoogleConnectionCredentialRepository;
  readonly now?: () => Date;
  readonly refreshSkewMs?: number;
  readonly refresher: GoogleTokenRefresher;
}

/**
 * Obtains short-lived Google access tokens from encrypted, persisted refresh tokens.
 * Access tokens remain process-local and are never persisted.
 */
export class GoogleAccessTokenService implements GoogleAccessTokenProvider {
  readonly #cachedTokens = new Map<
    string,
    { accessToken: string; expiresAt: number; grantedScopes: readonly string[] }
  >();
  readonly #inFlightRefreshes = new Map<string, Promise<string>>();
  readonly #now: () => Date;
  readonly #refreshSkewMs: number;

  constructor(private readonly options: GoogleAccessTokenServiceOptions) {
    this.#now = options.now ?? (() => new Date());
    this.#refreshSkewMs = options.refreshSkewMs ?? 60_000;
    if (!Number.isSafeInteger(this.#refreshSkewMs) || this.#refreshSkewMs < 0) {
      throw new Error('Google access token refresh skew must be a non-negative integer');
    }
  }

  async getAccessToken(
    connectionId: string,
    requiredScopes: readonly string[] = [gmailReadonlyScope],
  ): Promise<string> {
    if (!isUuid(connectionId)) {
      throw new AgentDependencyError(
        'INVALID_REQUEST',
        false,
        'Google connection ID must be a valid UUID',
      );
    }
    const cached = this.#cachedTokens.get(connectionId);
    if (
      cached &&
      cached.expiresAt - this.#refreshSkewMs > this.#now().getTime() &&
      requiredScopes.every((scope) => cached.grantedScopes.includes(scope))
    ) {
      return cached.accessToken;
    }

    const refreshKey = `${connectionId}:${[...new Set(requiredScopes)].sort().join(' ')}`;
    const existing = this.#inFlightRefreshes.get(refreshKey);
    if (existing) {
      return existing;
    }

    const refresh = this.#refresh(connectionId, requiredScopes);
    this.#inFlightRefreshes.set(refreshKey, refresh);
    try {
      return await refresh;
    } finally {
      this.#inFlightRefreshes.delete(refreshKey);
    }
  }

  invalidateAccessToken(connectionId: string): void {
    this.#cachedTokens.delete(connectionId);
  }

  async #refresh(connectionId: string, requiredScopes: readonly string[]): Promise<string> {
    let credential: GoogleConnectionCredential | null;
    try {
      credential = await this.options.credentials.findCredentialById(connectionId);
    } catch (error) {
      throw new AgentDependencyError(
        'TEMPORARY_UNAVAILABLE',
        true,
        'Google connection could not be loaded',
        { cause: error },
      );
    }
    if (!credential) {
      throw new AgentDependencyError(
        'AUTHENTICATION_REQUIRED',
        false,
        'Google connection is unavailable or requires reauthorization',
      );
    }
    if (!requiredScopes.every((scope) => credential.grantedScopes.includes(scope))) {
      throw new AgentDependencyError(
        'PERMISSION_DENIED',
        false,
        'Google connection does not grant the required permission',
      );
    }

    let refreshToken: string;
    try {
      refreshToken = this.options.cipher.decrypt(credential.encryptedRefreshToken);
    } catch (error) {
      await this.#markReauthRequired(connectionId, credential.encryptedRefreshToken);
      throw new AgentDependencyError(
        'AUTHENTICATION_REQUIRED',
        false,
        'Google connection requires reauthorization',
        { cause: error },
      );
    }

    try {
      const token = await this.options.refresher.refreshAccessToken(refreshToken);
      if (
        !token.accessToken ||
        !Number.isSafeInteger(token.expiresInSeconds) ||
        token.expiresInSeconds <= 0
      ) {
        throw new GoogleRefreshTokenError(
          'INVALID_RESPONSE',
          'Google returned an invalid access token response',
        );
      }
      this.#cachedTokens.set(connectionId, {
        accessToken: token.accessToken,
        expiresAt: this.#now().getTime() + token.expiresInSeconds * 1000,
        grantedScopes: credential.grantedScopes,
      });
      return token.accessToken;
    } catch (error) {
      if (error instanceof GoogleRefreshTokenError && error.code === 'INVALID_GRANT') {
        await this.#markReauthRequired(connectionId, credential.encryptedRefreshToken);
        throw new AgentDependencyError(
          'AUTHENTICATION_REQUIRED',
          false,
          'Google connection requires reauthorization',
          { cause: error },
        );
      }
      if (error instanceof GoogleRefreshTokenError && error.code === 'PERMISSION_DENIED') {
        throw new AgentDependencyError(
          'PERMISSION_DENIED',
          false,
          'Google token refresh was denied',
          {
            cause: error,
          },
        );
      }
      if (error instanceof GoogleRefreshTokenError && error.code === 'TEMPORARY_UNAVAILABLE') {
        throw new AgentDependencyError(
          'TEMPORARY_UNAVAILABLE',
          true,
          'Google token service is temporarily unavailable',
          { cause: error },
        );
      }
      if (error instanceof GoogleRefreshTokenError && error.code === 'INVALID_RESPONSE') {
        throw new AgentDependencyError(
          'INVALID_RESPONSE',
          false,
          'Google token service returned an invalid response',
          { cause: error },
        );
      }
      if (error instanceof AgentDependencyError) {
        throw error;
      }
      throw new AgentDependencyError('UNKNOWN', false, 'Google token refresh failed', {
        cause: error,
      });
    }
  }

  async #markReauthRequired(
    connectionId: string,
    expectedEncryptedRefreshToken: string,
  ): Promise<void> {
    try {
      const marked = await this.options.credentials.markReauthRequired({
        connectionId,
        expectedEncryptedRefreshToken,
      });
      if (!marked) {
        throw new AgentDependencyError(
          'TEMPORARY_UNAVAILABLE',
          true,
          'Google connection changed while its token was refreshed',
        );
      }
    } catch (error) {
      if (error instanceof AgentDependencyError) {
        throw error;
      }
      throw new AgentDependencyError(
        'TEMPORARY_UNAVAILABLE',
        true,
        'Google connection status could not be updated',
        { cause: error },
      );
    }
  }
}

export class AesGcmTokenCipher implements TokenCipher {
  static fromBase64Key(value: string): AesGcmTokenCipher {
    const normalized = value.trim();
    const key = Buffer.from(normalized, 'base64');

    if (key.length !== 32 || Buffer.from(key).toString('base64') !== normalized) {
      throw new GoogleOAuthError(
        'OAUTH_CONFIGURATION_INVALID',
        'TOKEN_ENCRYPTION_KEY must be a 32-byte Base64 value',
      );
    }

    return new AesGcmTokenCipher(key);
  }

  constructor(private readonly key: Uint8Array) {}

  encrypt(plaintext: string): string {
    const iv = nodeRandomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();

    return `v1.${iv.toString('base64url')}.${tag.toString('base64url')}.${ciphertext.toString('base64url')}`;
  }

  decrypt(value: string): string {
    const [version, ivValue, tagValue, ciphertextValue, extra] = value.split('.');
    if (version !== 'v1' || !ivValue || !tagValue || !ciphertextValue || extra) {
      throw new GoogleOAuthError(
        'OAUTH_STATE_INVALID',
        'OAuth authorization is invalid or expired',
      );
    }

    try {
      const iv = Buffer.from(ivValue, 'base64url');
      const tag = Buffer.from(tagValue, 'base64url');
      const ciphertext = Buffer.from(ciphertextValue, 'base64url');
      if (iv.length !== 12 || tag.length !== 16 || ciphertext.length === 0) {
        throw new Error('Invalid ciphertext');
      }
      const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    } catch {
      throw new GoogleOAuthError(
        'OAUTH_STATE_INVALID',
        'OAuth authorization is invalid or expired',
      );
    }
  }
}

export interface GoogleOAuthServiceOptions {
  readonly cipher: TokenCipher;
  readonly connections: GoogleConnectionRepository;
  readonly now?: () => Date;
  readonly provider: GoogleOAuthProvider;
  readonly randomBytes?: (size: number) => Uint8Array;
  readonly states: OAuthStateRepository;
  readonly stateTtlMs?: number;
}

export class GoogleOAuthService {
  readonly #now: () => Date;
  readonly #randomBytes: (size: number) => Uint8Array;
  readonly #stateTtlMs: number;

  constructor(private readonly options: GoogleOAuthServiceOptions) {
    this.#now = options.now ?? (() => new Date());
    this.#randomBytes = options.randomBytes ?? nodeRandomBytes;
    this.#stateTtlMs = options.stateTtlMs ?? 10 * 60_000;
    if (!Number.isSafeInteger(this.#stateTtlMs) || this.#stateTtlMs <= 0) {
      throw new Error('OAuth state TTL must be a positive integer');
    }
  }

  async begin(purpose: GoogleOAuthPurpose = 'gmail_read'): Promise<GoogleOAuthAuthorization> {
    await this.cleanupExpiredStates();
    const state = Buffer.from(this.#randomBytes(32)).toString('base64url');
    const browserNonce = Buffer.from(this.#randomBytes(32)).toString('base64url');
    const codeVerifier = Buffer.from(this.#randomBytes(32)).toString('base64url');
    const codeChallenge = sha256Base64Url(codeVerifier);
    await this.options.states.create({
      browserNonceHash: sha256Hex(browserNonce),
      encryptedCodeVerifier: this.options.cipher.encrypt(codeVerifier),
      expiresAt: new Date(this.#now().getTime() + this.#stateTtlMs),
      purpose,
      stateHash: sha256Hex(state),
    });

    return {
      authorizationUrl: this.options.provider.createAuthorizationUrl({
        codeChallenge,
        scopes: scopesForPurpose(purpose),
        state,
      }),
      browserNonce,
    };
  }

  async cancel(input: { readonly browserNonce: string; readonly state: string }): Promise<void> {
    await this.#consumeState(input);
  }

  async cleanupExpiredStates(): Promise<void> {
    await this.options.states.deleteExpired();
  }

  async complete(input: {
    readonly browserNonce: string;
    readonly code: string;
    readonly state: string;
  }): Promise<void> {
    if (!input.code.trim()) {
      throw new GoogleOAuthError(
        'OAUTH_STATE_INVALID',
        'OAuth authorization is invalid or expired',
      );
    }

    const state = await this.#consumeState(input);
    const codeVerifier = this.options.cipher.decrypt(state.encryptedCodeVerifier);
    const tokens = await this.options.provider.exchangeAuthorizationCode({
      code: input.code,
      codeVerifier,
    });
    const profile = await this.options.provider.getUserProfile(tokens.accessToken);
    const email = profile.email.trim().toLowerCase();
    if (!profile.emailVerified || !isValidEmail(email)) {
      throw new GoogleOAuthError('OAUTH_PROFILE_INVALID', 'Google account email is not verified');
    }
    if (
      !requiredApiScopesForPurpose(state.purpose ?? 'gmail_read').every((scope) =>
        tokens.grantedScopes.includes(scope),
      )
    ) {
      throw new GoogleOAuthError(
        'OAUTH_PROVIDER_FAILURE',
        'Google did not grant the required permission',
        'scope_not_granted',
      );
    }

    const encryptedRefreshToken = tokens.refreshToken
      ? this.options.cipher.encrypt(tokens.refreshToken)
      : null;
    const connection = encryptedRefreshToken
      ? await this.options.connections.upsert({
          email,
          encryptedRefreshToken,
          grantedScopes: tokens.grantedScopes,
        })
      : await this.options.connections.upsert({
          email,
          encryptedRefreshToken: null,
          grantedScopes: tokens.grantedScopes,
          validateExistingRefreshToken: (value) => {
            try {
              this.options.cipher.decrypt(value);
              return true;
            } catch {
              return false;
            }
          },
        });
    if (!connection) {
      throw new GoogleOAuthError(
        'OAUTH_REFRESH_TOKEN_MISSING',
        'Google did not grant offline access; reconnect and grant consent',
      );
    }
  }

  async #consumeState(input: {
    readonly browserNonce: string;
    readonly state: string;
  }): Promise<OAuthStateRecord> {
    if (!input.state.trim() || !input.browserNonce.trim()) {
      throw new GoogleOAuthError(
        'OAUTH_STATE_INVALID',
        'OAuth authorization is invalid or expired',
      );
    }
    const consumed = await this.options.states.consume({
      browserNonceHash: sha256Hex(input.browserNonce),
      stateHash: sha256Hex(input.state),
    });
    if (!consumed) {
      throw new GoogleOAuthError(
        'OAUTH_STATE_INVALID',
        'OAuth authorization is invalid or expired',
      );
    }
    return consumed;
  }
}

export class HttpGoogleOAuthProvider implements GoogleOAuthProvider {
  constructor(
    private readonly config: Pick<GoogleOAuthConfig, 'clientId' | 'clientSecret' | 'redirectUri'>,
    private readonly fetchImplementation: typeof fetch = fetch,
    private readonly timeoutMs = 10_000,
  ) {
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new Error('Google OAuth timeout must be a positive integer');
    }
  }

  createAuthorizationUrl(request: GoogleAuthorizationRequest): string {
    const url = new URL(authorizationEndpoint);
    url.search = new URLSearchParams({
      access_type: 'offline',
      client_id: this.config.clientId,
      code_challenge: request.codeChallenge,
      code_challenge_method: 'S256',
      include_granted_scopes: 'true',
      prompt: 'consent',
      redirect_uri: this.config.redirectUri,
      response_type: 'code',
      scope: (request.scopes ?? googleOAuthScopes).join(' '),
      state: request.state,
    }).toString();
    return url.toString();
  }

  async exchangeAuthorizationCode(input: {
    readonly code: string;
    readonly codeVerifier: string;
  }): Promise<GoogleTokenSet> {
    const { body, ok, status } = await this.#fetchJson(
      tokenEndpoint,
      {
        body: new URLSearchParams({
          client_id: this.config.clientId,
          client_secret: this.config.clientSecret,
          code: input.code,
          code_verifier: input.codeVerifier,
          grant_type: 'authorization_code',
          redirect_uri: this.config.redirectUri,
        }),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        method: 'POST',
      },
      'token_exchange',
    );
    if (!ok || !body || typeof body.access_token !== 'string') {
      throw new GoogleOAuthError(
        'OAUTH_PROVIDER_FAILURE',
        'Google token exchange failed',
        'token_exchange',
        providerErrorCode(body),
        status,
      );
    }
    const scope = typeof body.scope === 'string' ? body.scope.split(' ').filter(Boolean) : [];
    return {
      accessToken: body.access_token,
      grantedScopes: scope,
      refreshToken: typeof body.refresh_token === 'string' ? body.refresh_token : null,
    };
  }

  async getUserProfile(accessToken: string): Promise<GoogleUserProfile> {
    const { body, ok, status } = await this.#fetchJson(
      userInfoEndpoint,
      { headers: { Authorization: `Bearer ${accessToken}` } },
      'profile_lookup',
    );
    if (!ok || !body || typeof body.email !== 'string') {
      throw new GoogleOAuthError(
        'OAUTH_PROVIDER_FAILURE',
        'Google profile lookup failed',
        'profile_lookup',
        providerErrorCode(body),
        status,
      );
    }
    return { email: body.email, emailVerified: body.email_verified === true };
  }

  async #fetchJson(
    url: string,
    init: RequestInit,
    failureReason: GoogleOAuthFailureReason,
  ): Promise<{ body: Record<string, unknown> | null; ok: boolean; status: number }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImplementation(url, { ...init, signal: controller.signal });
      const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
      return { body, ok: response.ok, status: response.status };
    } catch {
      throw new GoogleOAuthError('OAUTH_PROVIDER_FAILURE', 'Google request failed', failureReason);
    } finally {
      clearTimeout(timeout);
    }
  }
}

/** Minimal REST adapter for the OAuth refresh-token grant. */
export class HttpGoogleTokenRefresher implements GoogleTokenRefresher {
  constructor(
    private readonly config: Pick<GoogleOAuthConfig, 'clientId' | 'clientSecret'>,
    private readonly fetchImplementation: typeof fetch = fetch,
    private readonly timeoutMs = 10_000,
  ) {
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new Error('Google token refresh timeout must be a positive integer');
    }
  }

  async refreshAccessToken(refreshToken: string): Promise<GoogleRefreshedAccessToken> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImplementation(tokenEndpoint, {
        body: new URLSearchParams({
          client_id: this.config.clientId,
          client_secret: this.config.clientSecret,
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
        }),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        method: 'POST',
        signal: controller.signal,
      });
      const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
      if (!response.ok) {
        const providerError = typeof body?.error === 'string' ? body.error : '';
        if (providerError === 'invalid_grant') {
          throw new GoogleRefreshTokenError('INVALID_GRANT', 'Google refresh token is invalid');
        }
        if (response.status === 401 || response.status === 403) {
          throw new GoogleRefreshTokenError('PERMISSION_DENIED', 'Google token refresh was denied');
        }
        if (response.status === 408 || response.status === 429 || response.status >= 500) {
          throw new GoogleRefreshTokenError(
            'TEMPORARY_UNAVAILABLE',
            'Google token service is temporarily unavailable',
          );
        }
        throw new GoogleRefreshTokenError('UNKNOWN', 'Google token refresh failed');
      }
      if (
        !body ||
        typeof body.access_token !== 'string' ||
        typeof body.expires_in !== 'number' ||
        !Number.isFinite(body.expires_in)
      ) {
        throw new GoogleRefreshTokenError(
          'INVALID_RESPONSE',
          'Google returned an invalid access token response',
        );
      }
      return { accessToken: body.access_token, expiresInSeconds: Math.floor(body.expires_in) };
    } catch (error) {
      if (error instanceof GoogleRefreshTokenError) {
        throw error;
      }
      throw new GoogleRefreshTokenError(
        'TEMPORARY_UNAVAILABLE',
        'Google token service is temporarily unavailable',
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function loadGoogleOAuthConfig(environment = process.env): GoogleOAuthConfig {
  const redirectUri = environment.GOOGLE_REDIRECT_URI?.trim();
  if (!redirectUri) {
    throw new GoogleOAuthError('OAUTH_CONFIGURATION_INVALID', 'Google OAuth is not configured');
  }
  const accessTokenConfig = loadGoogleAccessTokenConfig(environment);
  try {
    const parsedRedirectUri = new URL(redirectUri);
    if (
      (parsedRedirectUri.protocol !== 'http:' && parsedRedirectUri.protocol !== 'https:') ||
      (parsedRedirectUri.protocol === 'http:' &&
        parsedRedirectUri.hostname !== 'localhost' &&
        parsedRedirectUri.hostname !== '127.0.0.1' &&
        parsedRedirectUri.hostname !== '[::1]') ||
      parsedRedirectUri.username ||
      parsedRedirectUri.password ||
      parsedRedirectUri.hash
    ) {
      throw new Error('Invalid redirect URI');
    }
  } catch {
    throw new GoogleOAuthError(
      'OAUTH_CONFIGURATION_INVALID',
      'GOOGLE_REDIRECT_URI must use HTTPS, or HTTP on localhost, without credentials or a fragment',
    );
  }
  return { ...accessTokenConfig, redirectUri };
}

export function loadGoogleAccessTokenConfig(environment = process.env): GoogleAccessTokenConfig {
  const clientId = environment.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = environment.GOOGLE_CLIENT_SECRET?.trim();
  const tokenEncryptionKey = environment.TOKEN_ENCRYPTION_KEY?.trim();
  if (!clientId || !clientSecret || !tokenEncryptionKey) {
    throw new GoogleOAuthError(
      'OAUTH_CONFIGURATION_INVALID',
      'Google access token service is not configured',
    );
  }
  AesGcmTokenCipher.fromBase64Key(tokenEncryptionKey);
  return { clientId, clientSecret, tokenEncryptionKey };
}

function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value);
}

function scopesForPurpose(purpose: GoogleOAuthPurpose): readonly string[] {
  switch (purpose) {
    case 'gmail_compose':
      return [...googleOAuthScopes, gmailComposeScope];
    case 'calendar_events':
      return [...googleOAuthScopes, calendarEventsScope];
    default:
      return googleOAuthScopes;
  }
}

function requiredApiScopesForPurpose(purpose: GoogleOAuthPurpose): readonly string[] {
  switch (purpose) {
    case 'gmail_compose':
      return [gmailReadonlyScope, gmailComposeScope];
    case 'calendar_events':
      return [gmailReadonlyScope, calendarEventsScope];
    default:
      return [gmailReadonlyScope];
  }
}

function providerErrorCode(body: Record<string, unknown> | null): string | undefined {
  const error = body?.error;
  if (typeof error !== 'string') return undefined;
  return /^[a-z_]{1,64}$/u.test(error) ? error : undefined;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

function sha256Base64Url(value: string): string {
  return createHash('sha256').update(value).digest('base64url');
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
