import { describe, expect, test } from 'bun:test';

import { createDatabaseConnection } from './client';

describe('createDatabaseConnection', () => {
  test('rejects an invalid pool size before opening a connection', () => {
    expect(() =>
      createDatabaseConnection({
        databaseUrl: 'postgres://postgres:postgres@localhost:5432/ai_agents',
        maxConnections: 0,
      }),
    ).toThrow('Database maximum connections must be a positive integer');
  });
});
