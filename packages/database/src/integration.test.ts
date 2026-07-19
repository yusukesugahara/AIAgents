import { describe, expect, test } from 'bun:test';

import { createDatabaseConnection } from './index';

const integrationEnabled = process.env.INTEGRATION_TESTS === '1';
const databaseUrl = process.env.DATABASE_URL;
const integrationDatabaseUrl = databaseUrl ?? '';

const runMigrations = () => {
  const result = Bun.spawnSync({
    cmd: ['bun', 'run', '--filter', '@ai-agents/database', 'db:migrate'],
    env: process.env,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString());
  }
};

describe.skipIf(!integrationEnabled || !databaseUrl)(
  'database migration and UUIDv7 integration',
  () => {
    test('applies migration without duplicate errors when executed twice', () => {
      runMigrations();
      runMigrations();
    });

    test('stores postgres uuidv7 ids in id columns that use defaults', async () => {
      const connection = createDatabaseConnection({
        databaseUrl: integrationDatabaseUrl,
      });

      try {
        const email = `it-${crypto.randomUUID()}@example.com`;
        const [user] = (await connection.client`
          INSERT INTO users (email)
          VALUES (${email})
          RETURNING id
        `) as [{ id: string }];
        expect(user.id).toHaveLength(36);
        expect(user.id[14]).toBe('7');

        const [job] = (await connection.client`
          INSERT INTO agent_jobs (agent_id, input_json)
          VALUES ('job-search-email', '{"source":"integration"}'::jsonb)
          RETURNING id
        `) as [{ id: string }];
        const [run] = (await connection.client`
          INSERT INTO agent_runs (agent_id, job_id, trigger_type, input_json)
          VALUES ('job-search-email', ${job.id}, 'manual', '{"reason":"test"}'::jsonb)
          RETURNING id
        `) as [{ id: string }];

        expect(job.id[14]).toBe('7');
        expect(run.id[14]).toBe('7');

        await connection.client`DELETE FROM agent_runs WHERE id = ${run.id}`;
        await connection.client`DELETE FROM agent_jobs WHERE id = ${job.id}`;
        await connection.client`DELETE FROM users WHERE id = ${user.id}`;
      } finally {
        await connection.close();
      }
    });
  },
);
