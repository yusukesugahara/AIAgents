import { createRuntimeAgentRegistry } from '@ai-agents/agent-composition';
import { loadGmailPollingRuntimeConfig, loadJobRuntimeConfig } from '@ai-agents/config';
import { HttpGmailDraftWriter, HttpGmailReader } from '@ai-agents/connector-google';
import {
  createDatabaseConnection,
  type DatabaseConnection,
  PostgresAgentRunRepository,
  PostgresGoogleConnectionRepository,
  PostgresJobEmailSettingsRepository,
  PostgresJobQueue,
  PostgresOAuthStateRepository,
} from '@ai-agents/database';
import {
  AesGcmTokenCipher,
  GoogleAccessTokenService,
  type GoogleOAuthConfig,
  type GoogleOAuthProvider,
  GoogleOAuthService,
  HttpGoogleTokenRefresher,
  loadGoogleAccessTokenConfig,
  loadGoogleOAuthConfig,
} from '@ai-agents/google-oauth';
import { createApp } from './app';
import { requiresProtectedApi, resolveApiAccessToken } from './runtime-config';

export interface StartApiOptions {
  readonly createGoogleOAuthProvider: (config: GoogleOAuthConfig) => GoogleOAuthProvider;
  readonly oauthStateCleanupIntervalMs?: number;
}

export interface OAuthStateCleanupController {
  stop(): Promise<void>;
}

export function startOAuthStateCleanup(
  cleanup: () => Promise<void>,
  intervalMs: number,
  logError: () => void = () => {
    console.error(JSON.stringify({ event: 'oauth.google.state_cleanup_failed' }));
  },
): OAuthStateCleanupController {
  if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
    throw new Error('OAuth state cleanup interval must be a positive integer');
  }

  let stopped = false;
  let inFlight: Promise<void> | undefined;
  const run = (): void => {
    if (stopped || inFlight) {
      return;
    }
    inFlight = Promise.resolve()
      .then(cleanup)
      .catch(() => {
        logError();
      })
      .finally(() => {
        inFlight = undefined;
      });
  };
  run();
  const timer = setInterval(run, intervalMs);
  timer.unref?.();

  return {
    async stop(): Promise<void> {
      stopped = true;
      clearInterval(timer);
      await inFlight;
    },
  };
}

export function startApi(options: StartApiOptions): void {
  const port = Number(process.env.APP_PORT ?? 4000);
  const accessToken = resolveApiAccessToken();
  const gmailPollingConfig = loadGmailPollingRuntimeConfig();
  const jobRuntimeConfig = loadJobRuntimeConfig();
  const oauthRequired = requiresProtectedApi();
  const oauthStateCleanupIntervalMs = options.oauthStateCleanupIntervalMs ?? 15 * 60_000;
  if (!Number.isSafeInteger(oauthStateCleanupIntervalMs) || oauthStateCleanupIntervalMs <= 0) {
    throw new Error('OAuth state cleanup interval must be a positive integer');
  }

  let database: DatabaseConnection | undefined;
  let gmailDrafts: HttpGmailDraftWriter | undefined;
  let gmail: HttpGmailReader | undefined;
  let googleConnections: PostgresGoogleConnectionRepository | undefined;
  let googleOAuth: GoogleOAuthService | undefined;
  let oauthStates: PostgresOAuthStateRepository | undefined;

  try {
    database = createDatabaseConnection();
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: 'api.database.unavailable',
        message: error instanceof Error ? error.message : 'unknown',
      }),
    );
  }

  if (database) {
    oauthStates = new PostgresOAuthStateRepository(database);
    googleConnections = new PostgresGoogleConnectionRepository(database);
    try {
      const accessTokenConfig = loadGoogleAccessTokenConfig();
      const cipher = AesGcmTokenCipher.fromBase64Keys(
        accessTokenConfig.tokenEncryptionKey,
        accessTokenConfig.tokenEncryptionPreviousKeys,
      );
      const accessTokens = new GoogleAccessTokenService({
        cipher,
        credentials: googleConnections,
        refresher: new HttpGoogleTokenRefresher(accessTokenConfig),
      });
      gmail = new HttpGmailReader({ accessTokens });
      gmailDrafts = new HttpGmailDraftWriter({ accessTokens });
    } catch (error) {
      console.warn(
        JSON.stringify({
          event: 'api.google_access.unavailable',
          code: error instanceof Error && 'code' in error ? error.code : 'unknown',
        }),
      );
    }
    try {
      const googleOAuthConfig = loadGoogleOAuthConfig();
      googleOAuth = new GoogleOAuthService({
        cipher: AesGcmTokenCipher.fromBase64Keys(
          googleOAuthConfig.tokenEncryptionKey,
          googleOAuthConfig.tokenEncryptionPreviousKeys,
        ),
        connections: googleConnections,
        provider: options.createGoogleOAuthProvider(googleOAuthConfig),
        states: oauthStates,
      });
    } catch (error) {
      console.warn(
        JSON.stringify({
          event: 'api.google_oauth.unavailable',
          code: error instanceof Error && 'code' in error ? error.code : 'unknown',
        }),
      );
    }
  }

  const stateRepository = oauthStates;
  const oauthStateCleanup = stateRepository
    ? startOAuthStateCleanup(() => stateRepository.deleteExpired(), oauthStateCleanupIntervalMs)
    : undefined;

  console.info(
    JSON.stringify({
      event: 'api.starting',
      port,
      databaseConnected: database !== undefined,
    }),
  );

  const app = createApp({
    ...(accessToken ? { accessToken } : {}),
    ...(googleOAuth ? { googleOAuth } : {}),
    ...(googleConnections ? { googleConnections } : {}),
    ...(gmail ? { gmail } : {}),
    ...(gmailDrafts ? { gmailDrafts } : {}),
    gmailPolling: gmailPollingConfig,
    oauthCookieSecure: oauthRequired,
    oauthRequired,
    ...(database
      ? {
          database,
          jobEmailSettings: new PostgresJobEmailSettingsRepository(database),
          queue: new PostgresJobQueue(database, jobRuntimeConfig),
          runs: new PostgresAgentRunRepository(database),
        }
      : {}),
    registry: createRuntimeAgentRegistry(),
  });
  const server = Bun.serve({
    fetch: app.fetch,
    port,
  });

  let shutdownPromise: Promise<void> | undefined;

  const shutdown = async (): Promise<void> => {
    if (shutdownPromise) {
      return shutdownPromise;
    }

    shutdownPromise = (async () => {
      let exitCode = 0;

      try {
        await server.stop(true);
      } catch (error) {
        exitCode = 1;
        console.error(
          JSON.stringify({
            event: 'api.shutdown.failed',
            message: error instanceof Error ? error.message : 'unknown',
          }),
        );
      }

      try {
        await oauthStateCleanup?.stop();
        if (database) {
          await database.close();
        }
      } catch (error) {
        exitCode = 1;
        console.error(
          JSON.stringify({
            event: 'api.database.close.failed',
            message: error instanceof Error ? error.message : 'unknown',
          }),
        );
      }

      process.exit(exitCode);
    })();

    return shutdownPromise;
  };

  process.once('SIGINT', () => {
    void shutdown();
  });

  process.once('SIGTERM', () => {
    void shutdown();
  });
}
