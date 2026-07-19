import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes as nodeRandomBytes,
} from 'node:crypto';

export const googleOAuthScopes = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/gmail.readonly',
] as const;

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

export class GoogleOAuthError extends Error {
  constructor(
    readonly code: GoogleOAuthErrorCode,
    message: string,
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

export interface GoogleAuthorizationRequest {
  readonly codeChallenge: string;
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
}

export interface OAuthStateRepository {
  create(input: {
    readonly browserNonceHash: string;
    readonly encryptedCodeVerifier: string;
    readonly expiresAt: Date;
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

export interface TokenCipher {
  decrypt(ciphertext: string): string;
  encrypt(plaintext: string): string;
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

  async begin(): Promise<GoogleOAuthAuthorization> {
    await this.cleanupExpiredStates();
    const state = Buffer.from(this.#randomBytes(32)).toString('base64url');
    const browserNonce = Buffer.from(this.#randomBytes(32)).toString('base64url');
    const codeVerifier = Buffer.from(this.#randomBytes(32)).toString('base64url');
    const codeChallenge = sha256Base64Url(codeVerifier);
    await this.options.states.create({
      browserNonceHash: sha256Hex(browserNonce),
      encryptedCodeVerifier: this.options.cipher.encrypt(codeVerifier),
      expiresAt: new Date(this.#now().getTime() + this.#stateTtlMs),
      stateHash: sha256Hex(state),
    });

    return {
      authorizationUrl: this.options.provider.createAuthorizationUrl({ codeChallenge, state }),
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
    if (!tokens.grantedScopes.includes('https://www.googleapis.com/auth/gmail.readonly')) {
      throw new GoogleOAuthError(
        'OAUTH_PROVIDER_FAILURE',
        'Google did not grant the required permission',
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
      scope: googleOAuthScopes.join(' '),
      state: request.state,
    }).toString();
    return url.toString();
  }

  async exchangeAuthorizationCode(input: {
    readonly code: string;
    readonly codeVerifier: string;
  }): Promise<GoogleTokenSet> {
    const { body, ok } = await this.#fetchJson(tokenEndpoint, {
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
    });
    if (!ok || !body || typeof body.access_token !== 'string') {
      throw new GoogleOAuthError('OAUTH_PROVIDER_FAILURE', 'Google token exchange failed');
    }
    const scope = typeof body.scope === 'string' ? body.scope.split(' ').filter(Boolean) : [];
    return {
      accessToken: body.access_token,
      grantedScopes: scope,
      refreshToken: typeof body.refresh_token === 'string' ? body.refresh_token : null,
    };
  }

  async getUserProfile(accessToken: string): Promise<GoogleUserProfile> {
    const { body, ok } = await this.#fetchJson(userInfoEndpoint, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!ok || !body || typeof body.email !== 'string') {
      throw new GoogleOAuthError('OAUTH_PROVIDER_FAILURE', 'Google profile lookup failed');
    }
    return { email: body.email, emailVerified: body.email_verified === true };
  }

  async #fetchJson(
    url: string,
    init: RequestInit,
  ): Promise<{ body: Record<string, unknown> | null; ok: boolean }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImplementation(url, { ...init, signal: controller.signal });
      const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
      return { body, ok: response.ok };
    } catch {
      throw new GoogleOAuthError('OAUTH_PROVIDER_FAILURE', 'Google request failed');
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function loadGoogleOAuthConfig(environment = process.env): GoogleOAuthConfig {
  const clientId = environment.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = environment.GOOGLE_CLIENT_SECRET?.trim();
  const redirectUri = environment.GOOGLE_REDIRECT_URI?.trim();
  const tokenEncryptionKey = environment.TOKEN_ENCRYPTION_KEY?.trim();
  if (!clientId || !clientSecret || !redirectUri || !tokenEncryptionKey) {
    throw new GoogleOAuthError('OAUTH_CONFIGURATION_INVALID', 'Google OAuth is not configured');
  }
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
  AesGcmTokenCipher.fromBase64Key(tokenEncryptionKey);
  return { clientId, clientSecret, redirectUri, tokenEncryptionKey };
}

function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value);
}

function sha256Base64Url(value: string): string {
  return createHash('sha256').update(value).digest('base64url');
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
