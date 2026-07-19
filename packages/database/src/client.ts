import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import * as schema from './schema';

export interface DatabaseConnection {
  client: ReturnType<typeof postgres>;
  db: ReturnType<typeof drizzle>;
  isReady: () => Promise<boolean>;
  close: () => Promise<void>;
}

export interface CreateDatabaseConnectionOptions {
  databaseUrl?: string;
}

export function createDatabaseConnection(
  options: CreateDatabaseConnectionOptions = {},
): DatabaseConnection {
  const databaseUrl = options.databaseUrl ?? process.env.DATABASE_URL;

  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required');
  }

  const client = postgres(databaseUrl, {
    connect_timeout: 3,
    max: 1,
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

  const close = async (): Promise<void> => {
    await client.end({ timeout: 5 });
  };

  return {
    client,
    db,
    isReady,
    close,
  };
}
