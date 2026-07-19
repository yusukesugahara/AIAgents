import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';

import {
  AesGcmTokenCipher,
  GoogleAccessTokenService,
  type GoogleConnectionCredential,
  type GoogleConnectionCredentialRepository,
  type GoogleConnectionRecord,
  type GoogleConnectionRepository,
  type GoogleConnectionUpsertInput,
  type GoogleOAuthProvider,
  GoogleOAuthService,
  GoogleRefreshTokenError,
  type GoogleTokenSet,
  HttpGoogleOAuthProvider,
  HttpGoogleTokenRefresher,
  loadGoogleOAuthConfig,
  type OAuthStateRecord,
  type OAuthStateRepository,
} from './index';

const encryptionKey = Buffer.alloc(32, 7).toString('base64');

class FakeStates implements OAuthStateRepository {
  cleanupCalls = 0;
  readonly records = new Map<string, { browserNonceHash: string; record: OAuthStateRecord }>();

  async create(input: {
    readonly browserNonceHash: string;
    readonly encryptedCodeVerifier: string;
    readonly expiresAt: Date;
    readonly stateHash: string;
  }): Promise<void> {
    this.records.set(input.stateHash, {
      browserNonceHash: input.browserNonceHash,
      record: { encryptedCodeVerifier: input.encryptedCodeVerifier },
    });
  }

  async consume(input: {
    readonly browserNonceHash: string;
    readonly stateHash: string;
  }): Promise<OAuthStateRecord | null> {
    const state = this.records.get(input.stateHash);
    if (!state || state.browserNonceHash !== input.browserNonceHash) {
      return null;
    }
    this.records.delete(input.stateHash);
    return state.record;
  }

  async deleteExpired(): Promise<void> {
    this.cleanupCalls += 1;
  }
}

class FakeConnections implements GoogleConnectionRepository {
  existing: GoogleConnectionRecord | null = null;
  readonly saved: Array<{
    email: string;
    encryptedRefreshToken: string | null;
    grantedScopes: readonly string[];
  }> = [];

  async findByGoogleEmail(): Promise<GoogleConnectionRecord | null> {
    return this.existing;
  }

  async upsert(input: GoogleConnectionUpsertInput): Promise<GoogleConnectionRecord | null> {
    this.saved.push(input);
    if (input.encryptedRefreshToken !== null) {
      this.existing = { encryptedRefreshToken: input.encryptedRefreshToken };
    }
    if (
      input.encryptedRefreshToken === null &&
      this.existing &&
      !input.validateExistingRefreshToken(this.existing.encryptedRefreshToken)
    ) {
      return null;
    }
    return this.existing;
  }
}

class FakeProvider implements GoogleOAuthProvider {
  lastCodeVerifier: string | undefined;
  profile = { email: 'person@example.com', emailVerified: true };
  tokens: GoogleTokenSet = {
    accessToken: 'access-token',
    grantedScopes: ['openid', 'email', 'profile', 'https://www.googleapis.com/auth/gmail.readonly'],
    refreshToken: 'refresh-token',
  };

  createAuthorizationUrl(request: {
    readonly codeChallenge: string;
    readonly state: string;
  }): string {
    return `https://provider.example/authorize?${new URLSearchParams(request).toString()}`;
  }

  async exchangeAuthorizationCode(input: { readonly code: string; readonly codeVerifier: string }) {
    this.lastCodeVerifier = input.codeVerifier;
    return this.tokens;
  }

  async getUserProfile() {
    return this.profile;
  }
}

function createService() {
  const cipher = AesGcmTokenCipher.fromBase64Key(encryptionKey);
  const states = new FakeStates();
  const connections = new FakeConnections();
  const provider = new FakeProvider();
  let sequence = 0;
  const service = new GoogleOAuthService({
    cipher,
    connections,
    now: () => new Date('2026-07-19T00:00:00.000Z'),
    provider,
    randomBytes: (size) => Uint8Array.from({ length: size }, () => sequence++),
    states,
  });
  return { cipher, connections, provider, service, states };
}

describe('Google OAuth', () => {
  test('encrypts tokens with authenticated encryption and rejects tampering', async () => {
    const cipher = AesGcmTokenCipher.fromBase64Key(encryptionKey);
    const encrypted = cipher.encrypt('refresh-token');

    expect(encrypted).not.toContain('refresh-token');
    expect(cipher.decrypt(encrypted)).toBe('refresh-token');
    await expect(
      Promise.resolve().then(() => cipher.decrypt(`${encrypted}x`)),
    ).rejects.toMatchObject({
      code: 'OAUTH_STATE_INVALID',
    });
    expect(() => AesGcmTokenCipher.fromBase64Key('not-a-key')).toThrow(
      'TOKEN_ENCRYPTION_KEY must be a 32-byte Base64 value',
    );
  });

  test('creates a PKCE authorization request and saves a hashed state', async () => {
    const { service, states } = createService();
    const authorization = await service.begin();
    const authorizationUrl = new URL(authorization.authorizationUrl);
    const state = authorizationUrl.searchParams.get('state');

    expect(authorizationUrl.searchParams.get('codeChallenge')).toBeTruthy();
    expect(state).toBeTruthy();
    expect(states.records.has(sha256Hex(state ?? ''))).toBe(true);
    expect(JSON.stringify([...states.records.values()])).not.toContain(state ?? '');
    expect(states.cleanupCalls).toBe(1);
  });

  test('consumes state once and saves only an encrypted refresh token', async () => {
    const { cipher, connections, provider, service } = createService();
    const authorization = await service.begin();
    const state = new URL(authorization.authorizationUrl).searchParams.get('state') ?? '';

    await service.complete({
      browserNonce: authorization.browserNonce,
      code: 'authorization-code',
      state,
    });

    expect(provider.lastCodeVerifier).toBeTruthy();
    expect(connections.saved).toEqual([
      expect.objectContaining({
        email: 'person@example.com',
        grantedScopes: expect.arrayContaining(['https://www.googleapis.com/auth/gmail.readonly']),
      }),
    ]);
    expect(connections.saved[0]?.encryptedRefreshToken).not.toContain('refresh-token');
    expect(cipher.decrypt(connections.saved[0]?.encryptedRefreshToken ?? '')).toBe('refresh-token');
    await expect(
      service.complete({
        browserNonce: authorization.browserNonce,
        code: 'authorization-code',
        state,
      }),
    ).rejects.toMatchObject({ code: 'OAUTH_STATE_INVALID' });
  });

  test('rejects a callback from a different browser without consuming its state', async () => {
    const { service } = createService();
    const authorization = await service.begin();
    const state = new URL(authorization.authorizationUrl).searchParams.get('state') ?? '';

    await expect(
      service.complete({ browserNonce: 'different-browser', code: 'authorization-code', state }),
    ).rejects.toMatchObject({ code: 'OAUTH_STATE_INVALID' });

    await expect(
      service.complete({
        browserNonce: authorization.browserNonce,
        code: 'authorization-code',
        state,
      }),
    ).resolves.toBeUndefined();
  });

  test('preserves an existing refresh token when Google does not return another one', async () => {
    const { cipher, connections, provider, service } = createService();
    connections.existing = { encryptedRefreshToken: cipher.encrypt('previous-refresh-token') };
    provider.tokens = { ...provider.tokens, refreshToken: null };
    const authorization = await service.begin();
    const state = new URL(authorization.authorizationUrl).searchParams.get('state') ?? '';

    await service.complete({
      browserNonce: authorization.browserNonce,
      code: 'authorization-code',
      state,
    });

    expect(connections.saved[0]?.encryptedRefreshToken).toBeNull();
    expect(cipher.decrypt(connections.existing.encryptedRefreshToken)).toBe(
      'previous-refresh-token',
    );
  });

  test('rejects a first connection when Google does not return a refresh token', async () => {
    const { connections, provider, service } = createService();
    provider.tokens = { ...provider.tokens, refreshToken: null };
    const authorization = await service.begin();
    const state = new URL(authorization.authorizationUrl).searchParams.get('state') ?? '';

    await expect(
      service.complete({
        browserNonce: authorization.browserNonce,
        code: 'authorization-code',
        state,
      }),
    ).rejects.toMatchObject({ code: 'OAUTH_REFRESH_TOKEN_MISSING' });
    expect(connections.saved).toEqual([expect.objectContaining({ encryptedRefreshToken: null })]);
  });

  test('rejects a tampered existing refresh token instead of completing the connection', async () => {
    const { connections, provider, service } = createService();
    connections.existing = { encryptedRefreshToken: 'tampered-ciphertext' };
    provider.tokens = { ...provider.tokens, refreshToken: null };
    const authorization = await service.begin();
    const state = new URL(authorization.authorizationUrl).searchParams.get('state') ?? '';

    await expect(
      service.complete({
        browserNonce: authorization.browserNonce,
        code: 'authorization-code',
        state,
      }),
    ).rejects.toMatchObject({ code: 'OAUTH_REFRESH_TOKEN_MISSING' });
  });

  test('rejects unverified Google email without saving a connection', async () => {
    const { connections, provider, service } = createService();
    provider.profile.emailVerified = false;
    const authorization = await service.begin();
    const state = new URL(authorization.authorizationUrl).searchParams.get('state') ?? '';

    await expect(
      service.complete({
        browserNonce: authorization.browserNonce,
        code: 'authorization-code',
        state,
      }),
    ).rejects.toMatchObject({ code: 'OAUTH_PROFILE_INVALID' });
    expect(connections.saved).toHaveLength(0);
  });

  test('validates environment configuration and sends Google-required authorization parameters', () => {
    expect(() => loadGoogleOAuthConfig({})).toThrow('Google OAuth is not configured');
    expect(() =>
      loadGoogleOAuthConfig({
        GOOGLE_CLIENT_ID: 'client-id',
        GOOGLE_CLIENT_SECRET: 'client-secret',
        GOOGLE_REDIRECT_URI: 'javascript:alert(1)',
        TOKEN_ENCRYPTION_KEY: encryptionKey,
      }),
    ).toThrow('GOOGLE_REDIRECT_URI must use HTTPS');
    expect(() =>
      loadGoogleOAuthConfig({
        GOOGLE_CLIENT_ID: 'client-id',
        GOOGLE_CLIENT_SECRET: 'client-secret',
        GOOGLE_REDIRECT_URI: 'http://example.com/auth/google/callback',
        TOKEN_ENCRYPTION_KEY: encryptionKey,
      }),
    ).toThrow('GOOGLE_REDIRECT_URI must use HTTPS');
    expect(
      loadGoogleOAuthConfig({
        GOOGLE_CLIENT_ID: 'client-id',
        GOOGLE_CLIENT_SECRET: 'client-secret',
        GOOGLE_REDIRECT_URI: 'http://localhost:4000/auth/google/callback',
        TOKEN_ENCRYPTION_KEY: encryptionKey,
      }).redirectUri,
    ).toBe('http://localhost:4000/auth/google/callback');
    const provider = new HttpGoogleOAuthProvider({
      clientId: 'client-id',
      clientSecret: 'client-secret',
      redirectUri: 'http://localhost:4000/auth/google/callback',
    });
    const url = new URL(
      provider.createAuthorizationUrl({ codeChallenge: 'challenge', state: 'state' }),
    );

    expect(url.origin).toBe('https://accounts.google.com');
    expect(url.searchParams.get('client_id')).toBe('client-id');
    expect(url.searchParams.get('code_challenge')).toBe('challenge');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('include_granted_scopes')).toBe('true');
    expect(url.searchParams.get('scope')).toContain(
      'https://www.googleapis.com/auth/gmail.readonly',
    );
  });

  test('maps Google network failures to a safe provider error', async () => {
    const provider = new HttpGoogleOAuthProvider(
      {
        clientId: 'client-id',
        clientSecret: 'client-secret',
        redirectUri: 'http://localhost:4000/auth/google/callback',
      },
      (async () => {
        throw new Error('network unavailable');
      }) as unknown as typeof fetch,
    );

    await expect(
      provider.exchangeAuthorizationCode({ code: 'secret-code', codeVerifier: 'verifier' }),
    ).rejects.toMatchObject({ code: 'OAUTH_PROVIDER_FAILURE' });
  });

  test('enforces the timeout while reading a Google response body', async () => {
    const provider = new HttpGoogleOAuthProvider(
      {
        clientId: 'client-id',
        clientSecret: 'client-secret',
        redirectUri: 'http://localhost:4000/auth/google/callback',
      },
      (async (_url: RequestInfo | URL, init?: RequestInit) => ({
        json: () =>
          new Promise((_, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
          }),
        ok: true,
      })) as unknown as typeof fetch,
      1,
    );

    await expect(
      provider.exchangeAuthorizationCode({ code: 'secret-code', codeVerifier: 'verifier' }),
    ).rejects.toMatchObject({ code: 'OAUTH_PROVIDER_FAILURE' });
  });

  test('refreshes access tokens through the token endpoint without exposing credentials', async () => {
    let request: Request | undefined;
    const refresher = new HttpGoogleTokenRefresher(
      { clientId: 'client-id', clientSecret: 'client-secret' },
      (async (input: RequestInfo | URL, init?: RequestInit) => {
        request = new Request(input, init);
        return new Response(
          JSON.stringify({ access_token: 'short-lived-access', expires_in: 3600 }),
          {
            headers: { 'Content-Type': 'application/json' },
          },
        );
      }) as unknown as typeof fetch,
    );

    await expect(refresher.refreshAccessToken('refresh-secret')).resolves.toEqual({
      accessToken: 'short-lived-access',
      expiresInSeconds: 3600,
    });
    const body = await request?.text();
    expect(body).toContain('grant_type=refresh_token');
    expect(body).toContain('refresh_token=refresh-secret');
  });

  test('classifies invalid grant and temporary token refresh failures', async () => {
    const invalidGrant = new HttpGoogleTokenRefresher(
      { clientId: 'client-id', clientSecret: 'client-secret' },
      (async () =>
        new Response(JSON.stringify({ error: 'invalid_grant' }), {
          status: 400,
        })) as unknown as typeof fetch,
    );
    await expect(invalidGrant.refreshAccessToken('refresh-secret')).rejects.toMatchObject({
      code: 'INVALID_GRANT',
    });

    const unavailable = new HttpGoogleTokenRefresher(
      { clientId: 'client-id', clientSecret: 'client-secret' },
      (async () => new Response('{}', { status: 503 })) as unknown as typeof fetch,
    );
    await expect(unavailable.refreshAccessToken('refresh-secret')).rejects.toMatchObject({
      code: 'TEMPORARY_UNAVAILABLE',
    });
  });
});

class FakeCredentials implements GoogleConnectionCredentialRepository {
  credential: GoogleConnectionCredential | null;
  markFailure: Error | undefined;
  readonly reauthRequired: string[] = [];

  constructor(credential: GoogleConnectionCredential | null) {
    this.credential = credential;
  }

  async findCredentialById(): Promise<GoogleConnectionCredential | null> {
    return this.credential;
  }

  async markReauthRequired(connectionId: string): Promise<void> {
    if (this.markFailure) {
      throw this.markFailure;
    }
    this.reauthRequired.push(connectionId);
  }
}

class FakeRefresher {
  calls = 0;
  deferred: Promise<void> | undefined;
  failure: Error | undefined;

  async refreshAccessToken() {
    this.calls += 1;
    await this.deferred;
    if (this.failure) {
      throw this.failure;
    }
    return { accessToken: `access-${this.calls}`, expiresInSeconds: 3600 };
  }
}

describe('Google access token service', () => {
  const gmailScope = 'https://www.googleapis.com/auth/gmail.readonly';

  test('refreshes an encrypted token once and shares concurrent refreshes', async () => {
    const cipher = AesGcmTokenCipher.fromBase64Key(encryptionKey);
    const credentials = new FakeCredentials({
      encryptedRefreshToken: cipher.encrypt('refresh-secret'),
      grantedScopes: [gmailScope],
    });
    const refresher = new FakeRefresher();
    let release: (() => void) | undefined;
    refresher.deferred = new Promise<void>((resolve) => {
      release = resolve;
    });
    const service = new GoogleAccessTokenService({ cipher, credentials, refresher });

    const first = service.getAccessToken('connection-id');
    const second = service.getAccessToken('connection-id');
    release?.();

    await expect(Promise.all([first, second])).resolves.toEqual(['access-1', 'access-1']);
    expect(refresher.calls).toBe(1);
    await expect(service.getAccessToken('connection-id')).resolves.toBe('access-1');
    expect(refresher.calls).toBe(1);
  });

  test('refreshes again inside the configured expiry skew and can invalidate a cached token', async () => {
    const cipher = AesGcmTokenCipher.fromBase64Key(encryptionKey);
    const credentials = new FakeCredentials({
      encryptedRefreshToken: cipher.encrypt('refresh-secret'),
      grantedScopes: [gmailScope],
    });
    const refresher = new FakeRefresher();
    let now = new Date('2026-07-19T00:00:00.000Z');
    const service = new GoogleAccessTokenService({
      cipher,
      credentials,
      now: () => now,
      refreshSkewMs: 60_000,
      refresher,
    });

    await service.getAccessToken('connection-id');
    now = new Date('2026-07-19T00:59:01.000Z');
    await service.getAccessToken('connection-id');
    service.invalidateAccessToken('connection-id');
    await service.getAccessToken('connection-id');
    expect(refresher.calls).toBe(3);
  });

  test('requires an active connection and required Gmail scope', async () => {
    const cipher = AesGcmTokenCipher.fromBase64Key(encryptionKey);
    const refresher = new FakeRefresher();
    await expect(
      new GoogleAccessTokenService({
        cipher,
        credentials: new FakeCredentials(null),
        refresher,
      }).getAccessToken('missing'),
    ).rejects.toMatchObject({ code: 'AUTHENTICATION_REQUIRED', retryable: false });
    await expect(
      new GoogleAccessTokenService({
        cipher,
        credentials: new FakeCredentials({
          encryptedRefreshToken: cipher.encrypt('refresh-secret'),
          grantedScopes: [],
        }),
        refresher,
      }).getAccessToken('connection-id'),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED', retryable: false });
  });

  test('marks invalid refresh tokens as requiring reauthorization and maps temporary failures', async () => {
    const cipher = AesGcmTokenCipher.fromBase64Key(encryptionKey);
    const credentials = new FakeCredentials({
      encryptedRefreshToken: cipher.encrypt('refresh-secret'),
      grantedScopes: [gmailScope],
    });
    const refresher = new FakeRefresher();
    refresher.failure = new GoogleRefreshTokenError('INVALID_GRANT', 'invalid grant');
    const service = new GoogleAccessTokenService({ cipher, credentials, refresher });
    await expect(service.getAccessToken('connection-id')).rejects.toMatchObject({
      code: 'AUTHENTICATION_REQUIRED',
      retryable: false,
    });
    expect(credentials.reauthRequired).toEqual(['connection-id']);

    refresher.failure = new GoogleRefreshTokenError('TEMPORARY_UNAVAILABLE', 'temporary');
    await expect(service.getAccessToken('connection-id')).rejects.toMatchObject({
      code: 'TEMPORARY_UNAVAILABLE',
      retryable: true,
    });
  });

  test('treats a failed reauthorization-state update as retryable', async () => {
    const cipher = AesGcmTokenCipher.fromBase64Key(encryptionKey);
    const credentials = new FakeCredentials({
      encryptedRefreshToken: cipher.encrypt('refresh-secret'),
      grantedScopes: [gmailScope],
    });
    credentials.markFailure = new Error('database unavailable');
    const refresher = new FakeRefresher();
    refresher.failure = new GoogleRefreshTokenError('INVALID_GRANT', 'invalid grant');

    await expect(
      new GoogleAccessTokenService({ cipher, credentials, refresher }).getAccessToken(
        'connection-id',
      ),
    ).rejects.toMatchObject({ code: 'TEMPORARY_UNAVAILABLE', retryable: true });
  });
});

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
