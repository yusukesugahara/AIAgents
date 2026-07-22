import type {
  GoogleConnectionCredential,
  GoogleConnectionCredentialRepository,
  GoogleConnectionRecord,
  GoogleConnectionRepository,
  GoogleConnectionSummary,
  GoogleConnectionSummaryRepository,
  GoogleConnectionUpsertInput,
  GoogleOAuthPurpose,
  OAuthStateRecord,
  OAuthStateRepository,
} from '@ai-agents/google-oauth';
import type { DatabaseConnection } from './client';

export class PostgresOAuthStateRepository implements OAuthStateRepository {
  constructor(private readonly database: Pick<DatabaseConnection, 'client'>) {}

  async create(input: {
    readonly browserNonceHash: string;
    readonly encryptedCodeVerifier: string;
    readonly expiresAt: Date;
    readonly purpose?: GoogleOAuthPurpose;
    readonly stateHash: string;
  }): Promise<void> {
    await this.database.client`
      INSERT INTO oauth_authorization_states (
        state_hash, browser_nonce_hash, encrypted_code_verifier, authorization_purpose, expires_at
      )
      VALUES (
        ${input.stateHash}, ${input.browserNonceHash}, ${input.encryptedCodeVerifier},
        ${input.purpose ?? 'gmail_read'}, ${input.expiresAt.toISOString()}
      )
    `;
  }

  async consume(input: {
    readonly browserNonceHash: string;
    readonly stateHash: string;
  }): Promise<OAuthStateRecord | null> {
    const [state] = (await this.database.client`
      UPDATE oauth_authorization_states
      SET consumed_at = NOW()
      WHERE state_hash = ${input.stateHash}
        AND browser_nonce_hash = ${input.browserNonceHash}
        AND consumed_at IS NULL
        AND expires_at > NOW()
      RETURNING encrypted_code_verifier, authorization_purpose
    `) as Array<{ encrypted_code_verifier: string; authorization_purpose: GoogleOAuthPurpose }>;
    return state
      ? {
          encryptedCodeVerifier: state.encrypted_code_verifier,
          purpose: state.authorization_purpose,
        }
      : null;
  }

  async deleteExpired(): Promise<void> {
    await this.database.client`
      DELETE FROM oauth_authorization_states
      WHERE expires_at <= NOW()
         OR consumed_at <= NOW() - INTERVAL '1 day'
    `;
  }
}

export class PostgresGoogleConnectionRepository
  implements
    GoogleConnectionRepository,
    GoogleConnectionCredentialRepository,
    GoogleConnectionSummaryRepository
{
  constructor(private readonly database: Pick<DatabaseConnection, 'client'>) {}

  async findByGoogleEmail(email: string): Promise<GoogleConnectionRecord | null> {
    const [connection] = (await this.database.client`
      SELECT encrypted_refresh_token
      FROM connections
      WHERE type = 'google'
        AND google_email = ${email}
        AND status = 'connected'
        AND encrypted_refresh_token IS NOT NULL
      LIMIT 1
    `) as Array<{ encrypted_refresh_token: string }>;
    return connection ? { encryptedRefreshToken: connection.encrypted_refresh_token } : null;
  }

  async findCredentialById(connectionId: string): Promise<GoogleConnectionCredential | null> {
    const [connection] = (await this.database.client`
      SELECT encrypted_refresh_token, granted_scopes
      FROM connections
      WHERE id = ${connectionId}::uuid
        AND type = 'google'
        AND status = 'connected'
        AND encrypted_refresh_token IS NOT NULL
      LIMIT 1
    `) as Array<{ encrypted_refresh_token: string; granted_scopes: string[] | null }>;
    return connection
      ? {
          encryptedRefreshToken: connection.encrypted_refresh_token,
          grantedScopes: connection.granted_scopes ?? [],
        }
      : null;
  }

  async listConnections(): Promise<readonly GoogleConnectionSummary[]> {
    const rows = (await this.database.client`
      SELECT id, google_email, granted_scopes, status, updated_at
      FROM connections
      WHERE type = 'google'
        AND status IN ('connected', 'reauth_required')
      ORDER BY updated_at DESC, id DESC
    `) as Array<{
      google_email: string;
      granted_scopes: string[] | null;
      id: string;
      status: 'connected' | 'reauth_required';
      updated_at: Date | string;
    }>;
    return rows.map((row) => ({
      email: row.google_email,
      grantedScopes: row.granted_scopes ?? [],
      id: row.id,
      status: row.status,
      updatedAt: row.updated_at instanceof Date ? row.updated_at : new Date(row.updated_at),
    }));
  }

  async markReauthRequired(input: {
    readonly connectionId: string;
    readonly expectedEncryptedRefreshToken: string;
  }): Promise<boolean> {
    const [updated] = (await this.database.client`
      UPDATE connections
      SET status = 'reauth_required', updated_at = NOW()
      WHERE id = ${input.connectionId}::uuid
        AND type = 'google'
        AND status = 'connected'
        AND encrypted_refresh_token = ${input.expectedEncryptedRefreshToken}
      RETURNING id
    `) as Array<{ id: string }>;
    return updated !== undefined;
  }

  async upsert(input: GoogleConnectionUpsertInput): Promise<GoogleConnectionRecord | null> {
    try {
      return await this.database.client.begin(async (sql) => {
        const [user] = (await sql`
          INSERT INTO users (email)
          VALUES (${input.email})
          ON CONFLICT (email) DO UPDATE SET updated_at = NOW()
          RETURNING id
        `) as Array<{ id: string }>;
        if (!user) {
          throw new Error('Could not create Google OAuth user');
        }

        if (input.encryptedRefreshToken !== null) {
          const [connection] = (await sql`
            INSERT INTO connections (
              user_id, type, google_email, encrypted_refresh_token, granted_scopes, status,
              updated_at
            )
            VALUES (
              ${user.id}::uuid, 'google', ${input.email}, ${input.encryptedRefreshToken},
              ${[...input.grantedScopes]}, 'connected', NOW()
            )
            ON CONFLICT (user_id, type, google_email) DO UPDATE
            SET encrypted_refresh_token = EXCLUDED.encrypted_refresh_token,
                granted_scopes = EXCLUDED.granted_scopes,
                status = 'connected',
                updated_at = NOW()
            RETURNING encrypted_refresh_token
          `) as Array<{ encrypted_refresh_token: string }>;
          if (!connection) {
            throw new Error('Could not save Google OAuth connection');
          }
          return { encryptedRefreshToken: connection.encrypted_refresh_token };
        }

        const [connection] = (await sql`
          SELECT id, encrypted_refresh_token
          FROM connections
          WHERE user_id = ${user.id}::uuid
            AND type = 'google'
            AND google_email = ${input.email}
            AND status = 'connected'
            AND encrypted_refresh_token IS NOT NULL
          FOR UPDATE
        `) as Array<{ id: string; encrypted_refresh_token: string }>;
        if (
          !connection ||
          !input.validateExistingRefreshToken(connection.encrypted_refresh_token)
        ) {
          throw new MissingRefreshTokenError();
        }
        await sql`
          UPDATE connections
          SET granted_scopes = ${[...input.grantedScopes]},
              updated_at = NOW()
          WHERE id = ${connection.id}::uuid
        `;
        return { encryptedRefreshToken: connection.encrypted_refresh_token };
      });
    } catch (error) {
      if (error instanceof MissingRefreshTokenError) {
        return null;
      }
      throw error;
    }
  }
}

class MissingRefreshTokenError extends Error {}
