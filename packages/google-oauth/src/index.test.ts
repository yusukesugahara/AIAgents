import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';

import {
  AesGcmTokenCipher,
  type GoogleConnectionRecord,
  type GoogleConnectionRepository,
  type GoogleConnectionUpsertInput,
  type GoogleOAuthProvider,
  GoogleOAuthService,
  type GoogleTokenSet,
  HttpGoogleOAuthProvider,
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
});

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
