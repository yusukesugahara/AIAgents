import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import * as schema from './schema';

export interface DatabaseConnection {
  client: ReturnType<typeof postgres>;
  db: ReturnType<typeof drizzle>;
  isReady: () => Promise<boolean>;
  isSchemaReady: () => Promise<boolean>;
  close: () => Promise<void>;
}

export interface CreateDatabaseConnectionOptions {
  databaseUrl?: string;
  /** Maximum connections in this process's PostgreSQL pool. Defaults to 10. */
  maxConnections?: number;
}

export function createDatabaseConnection(
  options: CreateDatabaseConnectionOptions = {},
): DatabaseConnection {
  const databaseUrl = options.databaseUrl ?? process.env.DATABASE_URL;

  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required');
  }
  const maxConnections = options.maxConnections ?? 10;
  if (!Number.isSafeInteger(maxConnections) || maxConnections <= 0) {
    throw new Error('Database maximum connections must be a positive integer');
  }

  const client = postgres(databaseUrl, {
    connect_timeout: 3,
    max: maxConnections,
  });
  const db = drizzle(client, { schema });

  const isReady = async (): Promise<boolean> => {
    try {
      await client`SELECT 1`;
      return true;
    } catch {
      return false;
    }
  };

  const isSchemaReady = async (): Promise<boolean> => {
    try {
      const [result] = (await client`
        SELECT
          to_regclass('public.agent_jobs') IS NOT NULL
          AND to_regclass('public.agent_runs') IS NOT NULL
          AND to_regclass('public.agent_errors') IS NOT NULL
          AND to_regclass('public.agent_jobs_agent_id_idempotency_key_unique') IS NOT NULL
          AND EXISTS (
            SELECT 1
            FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'agent_jobs'
              AND column_name = 'trigger_type'
          )
          AND EXISTS (
            SELECT 1
            FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'agent_jobs'
              AND column_name = 'last_error_code'
          )
          AND EXISTS (
            SELECT 1
            FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'agent_jobs'
              AND column_name = 'requested_available_at'
          ) AS ready
      `) as Array<{ ready: boolean }>;
      return result?.ready === true;
    } catch {
      return false;
    }
  };

  const close = async (): Promise<void> => {
    await client.end({ timeout: 5 });
  };

  return {
    client,
    db,
    isReady,
    isSchemaReady,
    close,
  };
}
