import { describe, expect, test } from 'bun:test';
import { IdempotencyConflictError, RetryableJobError } from '@ai-agents/agent-core';
import { AesGcmTokenCipher } from '@ai-agents/google-oauth';

import {
  createDatabaseConnection,
  type DatabaseConnection,
  PostgresAgentRunRepository,
  PostgresGoogleConnectionRepository,
  PostgresJobQueue,
  PostgresOAuthStateRepository,
} from './index';

const integrationEnabled = process.env.INTEGRATION_TESTS === '1';
const databaseUrl = process.env.DATABASE_URL;
const integrationDatabaseUrl = databaseUrl ?? '';

const applyMigrationFile = async (
  connection: DatabaseConnection,
  migrationName: string,
): Promise<void> => {
  const migration = await Bun.file(
    new URL(`../migrations/${migrationName}`, import.meta.url),
  ).text();
  for (const statement of migration.split('--> statement-breakpoint')) {
    if (statement.trim()) {
      await connection.client.unsafe(statement);
    }
  }
};

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
    }, 15_000);

    test('preserves a usable refresh token while deduplicating existing connections', async () => {
      const admin = createDatabaseConnection({ databaseUrl: integrationDatabaseUrl });
      const databaseName = `oauth_migration_${crypto.randomUUID().replaceAll('-', '')}`;
      const temporaryDatabaseUrl = new URL(integrationDatabaseUrl);
      temporaryDatabaseUrl.pathname = `/${databaseName}`;
      let temporary: DatabaseConnection | undefined;

      try {
        await admin.client.unsafe(`CREATE DATABASE "${databaseName}"`);
        temporary = createDatabaseConnection({ databaseUrl: temporaryDatabaseUrl.toString() });
        for (const migrationName of [
          '0000_initial.sql',
          '0001_job_queue_leases.sql',
          '0002_amazing_roland_deschain.sql',
          '0003_daffy_slayback.sql',
          '0004_military_radioactive_man.sql',
        ]) {
          await applyMigrationFile(temporary, migrationName);
        }

        const [user] = (await temporary.client`
          INSERT INTO users (email) VALUES ('migration@example.com') RETURNING id
        `) as Array<{ id: string }>;
        if (!user) {
          throw new Error('Expected migration test user');
        }
        await temporary.client`
          INSERT INTO connections (
            user_id, type, google_email, encrypted_refresh_token, status, updated_at
          ) VALUES
            (
              ${user.id}::uuid, 'google', 'migration@example.com', 'usable-ciphertext',
              'connected', NOW() - INTERVAL '1 day'
            ),
            (
              ${user.id}::uuid, 'google', 'migration@example.com', NULL,
              'connected', NOW()
            )
        `;

        await applyMigrationFile(temporary, '0005_sticky_roulette.sql');
        expect(await temporary.isSchemaReady()).toBe(false);
        await applyMigrationFile(temporary, '0006_supreme_red_hulk.sql');

        const rows = (await temporary.client`
          SELECT encrypted_refresh_token
          FROM connections
          WHERE user_id = ${user.id}::uuid
            AND type = 'google'
            AND google_email = 'migration@example.com'
        `) as Array<{ encrypted_refresh_token: string | null }>;
        expect(rows).toEqual([{ encrypted_refresh_token: 'usable-ciphertext' }]);
        expect(await temporary.isSchemaReady()).toBe(true);
      } finally {
        if (temporary) {
          await temporary.close();
        }
        await admin.client.unsafe(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
        await admin.close();
      }
    }, 30_000);

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

    test('consumes OAuth state once and upserts encrypted Google connections', async () => {
      const connection = createDatabaseConnection({ databaseUrl: integrationDatabaseUrl });
      const states = new PostgresOAuthStateRepository(connection);
      const connections = new PostgresGoogleConnectionRepository(connection);
      const stateHash = `oauth-state-${crypto.randomUUID()}`;
      const expiredStateHash = `oauth-expired-${crypto.randomUUID()}`;
      const email = `oauth-${crypto.randomUUID()}@example.com`;
      const cipher = AesGcmTokenCipher.fromBase64Key(Buffer.alloc(32, 4).toString('base64'));

      try {
        const browserNonceHash = `browser-${crypto.randomUUID()}`;
        await states.create({
          browserNonceHash,
          encryptedCodeVerifier: cipher.encrypt('verifier'),
          expiresAt: new Date(Date.now() + 60_000),
          stateHash,
        });
        expect(
          await states.consume({ browserNonceHash: 'different-browser', stateHash }),
        ).toBeNull();
        expect(await states.consume({ browserNonceHash, stateHash })).toMatchObject({
          encryptedCodeVerifier: expect.not.stringContaining('verifier'),
        });
        expect(await states.consume({ browserNonceHash, stateHash })).toBeNull();

        await states.create({
          browserNonceHash,
          encryptedCodeVerifier: cipher.encrypt('expired-verifier'),
          expiresAt: new Date(Date.now() - 1_000),
          stateHash: expiredStateHash,
        });
        expect(await states.consume({ browserNonceHash, stateHash: expiredStateHash })).toBeNull();

        await connections.upsert({
          email,
          encryptedRefreshToken: cipher.encrypt('first-token'),
          grantedScopes: ['openid', 'https://www.googleapis.com/auth/gmail.readonly'],
        });
        const existing = await connections.findByGoogleEmail(email);
        expect(cipher.decrypt(existing?.encryptedRefreshToken ?? '')).toBe('first-token');

        await connections.upsert({
          email,
          encryptedRefreshToken: cipher.encrypt('second-token'),
          grantedScopes: ['openid'],
        });
        const [stored] = (await connection.client`
          SELECT connections.id, users.email, connections.encrypted_refresh_token, connections.status
          FROM connections
          JOIN users ON users.id = connections.user_id
          WHERE connections.google_email = ${email}
        `) as Array<{ id: string; email: string; encrypted_refresh_token: string; status: string }>;
        if (!stored) {
          throw new Error('Expected stored Google connection');
        }
        expect(stored).toEqual({
          id: expect.any(String),
          email,
          encrypted_refresh_token: expect.not.stringContaining('second-token'),
          status: 'connected',
        });
        expect(cipher.decrypt(stored.encrypted_refresh_token)).toBe('second-token');

        const freshToken = cipher.encrypt('concurrent-fresh-token');
        await Promise.all([
          connections.upsert({
            email,
            encryptedRefreshToken: freshToken,
            grantedScopes: ['openid', 'https://www.googleapis.com/auth/gmail.readonly'],
          }),
          connections.upsert({
            email,
            encryptedRefreshToken: null,
            grantedScopes: ['openid', 'https://www.googleapis.com/auth/gmail.readonly'],
            validateExistingRefreshToken: (value) => {
              cipher.decrypt(value);
              return true;
            },
          }),
        ]);
        const concurrentResult = await connections.findByGoogleEmail(email);
        expect(cipher.decrypt(concurrentResult?.encryptedRefreshToken ?? '')).toBe(
          'concurrent-fresh-token',
        );

        await connection.client`
          UPDATE connections
          SET encrypted_refresh_token = 'tampered-ciphertext',
              granted_scopes = ARRAY['original-scope']::text[]
          WHERE google_email = ${email}
        `;
        expect(
          await connections.upsert({
            email,
            encryptedRefreshToken: null,
            grantedScopes: ['replacement-scope'],
            validateExistingRefreshToken: () => false,
          }),
        ).toBeNull();
        const [unchanged] = (await connection.client`
          SELECT granted_scopes
          FROM connections
          WHERE google_email = ${email}
        `) as Array<{ granted_scopes: string[] }>;
        expect(unchanged?.granted_scopes).toEqual(['original-scope']);
        const credential = await connections.findCredentialById(stored.id);
        expect(credential).toEqual({
          encryptedRefreshToken: 'tampered-ciphertext',
          grantedScopes: ['original-scope'],
        });
        expect(
          await connections.markReauthRequired({
            connectionId: stored.id,
            expectedEncryptedRefreshToken: 'stale-ciphertext',
          }),
        ).toBe(false);
        expect(await connections.findCredentialById(stored.id)).not.toBeNull();
        expect(
          await connections.markReauthRequired({
            connectionId: stored.id,
            expectedEncryptedRefreshToken: 'tampered-ciphertext',
          }),
        ).toBe(true);
        expect(await connections.findCredentialById(stored.id)).toBeNull();
        const [reauth] = (await connection.client`
          SELECT status FROM connections WHERE id = ${stored.id}::uuid
        `) as Array<{ status: string }>;
        expect(reauth?.status).toBe('reauth_required');
      } finally {
        await connection.client`
          DELETE FROM oauth_authorization_states
          WHERE state_hash IN (${stateHash}, ${expiredStateHash})
        `;
        await connection.client`DELETE FROM connections WHERE google_email = ${email}`;
        await connection.client`DELETE FROM users WHERE email = ${email}`;
        await connection.close();
      }
    });

    test('queues, retries, and recovers Jobs without duplicate claims', async () => {
      const connection = createDatabaseConnection({ databaseUrl: integrationDatabaseUrl });
      const concurrentConnection = createDatabaseConnection({
        databaseUrl: integrationDatabaseUrl,
      });
      const queue = new PostgresJobQueue(connection, {
        lockTimeoutMs: 1_000,
        retryDelaysMs: [1, 2, 4],
      });
      const concurrentQueue = new PostgresJobQueue(concurrentConnection, {
        lockTimeoutMs: 1_000,
        retryDelaysMs: [1, 2, 4],
      });
      const agentId = `test-agent-${crypto.randomUUID()}`;
      const idempotencyKey = `queue-${crypto.randomUUID()}`;

      try {
        const first = await queue.enqueue({
          agentId,
          input: { source: 'integration' },
          triggerType: 'manual',
          idempotencyKey,
        });
        const duplicate = await queue.enqueue({
          agentId,
          input: { source: 'integration' },
          triggerType: 'manual',
          idempotencyKey,
        });
        expect(duplicate.id).toBe(first.id);
        expect(first.triggerType).toBe('manual');

        await expect(
          queue.enqueue({
            agentId,
            input: { source: 'different' },
            triggerType: 'manual',
            idempotencyKey,
          }),
        ).rejects.toBeInstanceOf(IdempotencyConflictError);

        await expect(
          queue.enqueue({
            agentId,
            input: { source: 'integration' },
            triggerType: 'manual',
            idempotencyKey,
            availableAt: new Date(Date.now() + 60_000),
          }),
        ).rejects.toBeInstanceOf(IdempotencyConflictError);

        const [claimedByOne, claimedByTwo] = await Promise.all([
          queue.claimNext({ agentId, workerId: 'worker-one' }),
          concurrentQueue.claimNext({ agentId, workerId: 'worker-two' }),
        ]);
        const claimedJobs = [claimedByOne, claimedByTwo].filter((job) => job !== null);
        expect(claimedJobs).toHaveLength(1);

        const claimed = claimedJobs[0];
        if (!claimed) {
          throw new Error('Expected a claimed Job');
        }

        await queue.fail({
          jobId: claimed.id,
          workerId: claimed.lockedBy ?? 'worker-one',
          error: new Error('temporary failure'),
          retryable: true,
        });
        await Bun.sleep(5);

        const retried = await queue.claimNext({ agentId, workerId: 'worker-three' });
        expect(retried?.attempts).toBe(2);
        expect(retried?.status).toBe('processing');
        if (!retried) {
          throw new Error('Expected a retried Job');
        }

        expect(await queue.extendLease({ jobId: retried.id, workerId: 'worker-three' })).toBe(true);
        expect(await queue.extendLease({ jobId: retried.id, workerId: 'worker-other' })).toBe(
          false,
        );

        await connection.client`
          UPDATE agent_jobs
          SET locked_at = NOW() - INTERVAL '2 seconds'
          WHERE id = ${retried.id}::uuid
        `;
        expect(await queue.recoverStaleJobs()).toBe(1);

        const recovered = await queue.claimNext({ agentId, workerId: 'worker-four' });
        expect(recovered?.attempts).toBe(3);
        if (!recovered) {
          throw new Error('Expected a recovered Job');
        }

        await queue.fail({
          jobId: recovered.id,
          workerId: 'worker-four',
          error: new Error('permanent failure'),
          retryable: false,
        });

        const [terminal] = (await connection.client`
          SELECT status, attempts, completed_at, last_error_code
          FROM agent_jobs
          WHERE id = ${first.id}::uuid
        `) as [
          { status: string; attempts: number; completed_at: Date | null; last_error_code: string },
        ];
        expect(terminal).toEqual({
          status: 'failed',
          attempts: 3,
          completed_at: expect.any(String),
          last_error_code: 'JOB_EXECUTION_FAILED',
        });
      } finally {
        await connection.client`DELETE FROM agent_jobs WHERE idempotency_key = ${idempotencyKey}`;
        await connection.close();
        await concurrentConnection.close();
      }
    });

    test('honors delayed availability', async () => {
      const connection = createDatabaseConnection({ databaseUrl: integrationDatabaseUrl });
      const queue = new PostgresJobQueue(connection);
      const agentId = `delayed-agent-${crypto.randomUUID()}`;
      const idempotencyKey = `delayed-${crypto.randomUUID()}`;

      try {
        const job = await queue.enqueue({
          agentId,
          input: { source: 'integration' },
          triggerType: 'manual',
          idempotencyKey,
          availableAt: new Date(Date.now() + 60_000),
        });

        expect(await queue.claimNext({ agentId, workerId: 'worker-one' })).toBeNull();
        await connection.client`
          UPDATE agent_jobs SET available_at = NOW() WHERE id = ${job.id}::uuid
        `;
        expect(await queue.claimNext({ agentId, workerId: 'worker-one' })).toMatchObject({
          id: job.id,
          status: 'processing',
        });
        await queue.complete({ jobId: job.id, workerId: 'worker-one' });
      } finally {
        await connection.client`DELETE FROM agent_jobs WHERE idempotency_key = ${idempotencyKey}`;
        await connection.close();
      }
    });

    test('releases a claimed Job without consuming an execution attempt', async () => {
      const connection = createDatabaseConnection({ databaseUrl: integrationDatabaseUrl });
      const queue = new PostgresJobQueue(connection);
      const agentId = `released-agent-${crypto.randomUUID()}`;
      const idempotencyKey = `released-${crypto.randomUUID()}`;

      try {
        const job = await queue.enqueue({
          agentId,
          input: { source: 'integration' },
          triggerType: 'manual',
          idempotencyKey,
        });
        const claimed = await queue.claimNext({ agentId, workerId: 'worker-one' });
        expect(claimed?.attempts).toBe(1);

        await queue.release({ jobId: job.id, workerId: 'worker-one' });
        expect(await queue.get(job.id)).toMatchObject({
          attempts: 0,
          lockedAt: null,
          lockedBy: null,
          status: 'queued',
        });

        const reclaimed = await queue.claimNext({ agentId, workerId: 'worker-two' });
        expect(reclaimed?.attempts).toBe(1);
        await queue.complete({ jobId: job.id, workerId: 'worker-two' });
      } finally {
        await connection.client`DELETE FROM agent_jobs WHERE idempotency_key = ${idempotencyKey}`;
        await connection.close();
      }
    });

    test('uses 1s and 2s retry waits and fails after the third attempt', async () => {
      const connection = createDatabaseConnection({ databaseUrl: integrationDatabaseUrl });
      const queue = new PostgresJobQueue(connection);
      const agentId = `backoff-agent-${crypto.randomUUID()}`;
      const idempotencyKey = `backoff-${crypto.randomUUID()}`;

      try {
        const job = await queue.enqueue({
          agentId,
          input: { source: 'integration' },
          triggerType: 'manual',
          idempotencyKey,
        });

        const first = await queue.claimNext({ agentId, workerId: 'worker-one' });
        expect(first?.attempts).toBe(1);
        const firstFailureAt = Date.now();
        await queue.fail({
          jobId: job.id,
          workerId: 'worker-one',
          error: new RetryableJobError('temporary failure'),
          retryable: true,
        });
        const firstRetry = await queue.get(job.id);
        expect(firstRetry?.status).toBe('retry_waiting');
        expect(firstRetry?.availableAt.getTime() ?? 0).toBeGreaterThanOrEqual(firstFailureAt + 900);
        expect(firstRetry?.availableAt.getTime() ?? 0).toBeLessThan(firstFailureAt + 1_500);

        await connection.client`
          UPDATE agent_jobs SET available_at = NOW() WHERE id = ${job.id}::uuid
        `;
        const second = await queue.claimNext({ agentId, workerId: 'worker-two' });
        expect(second?.attempts).toBe(2);
        const secondFailureAt = Date.now();
        await queue.fail({
          jobId: job.id,
          workerId: 'worker-two',
          error: new RetryableJobError('temporary failure'),
          retryable: true,
        });
        const secondRetry = await queue.get(job.id);
        expect(secondRetry?.status).toBe('retry_waiting');
        expect(secondRetry?.availableAt.getTime() ?? 0).toBeGreaterThanOrEqual(
          secondFailureAt + 1_900,
        );
        expect(secondRetry?.availableAt.getTime() ?? 0).toBeLessThan(secondFailureAt + 2_500);

        await connection.client`
          UPDATE agent_jobs SET available_at = NOW() WHERE id = ${job.id}::uuid
        `;
        const third = await queue.claimNext({ agentId, workerId: 'worker-three' });
        expect(third?.attempts).toBe(3);
        await queue.fail({
          jobId: job.id,
          workerId: 'worker-three',
          error: new RetryableJobError('temporary failure'),
          retryable: true,
        });
        expect(await queue.get(job.id)).toMatchObject({
          attempts: 3,
          lastErrorCode: 'JOB_RETRYABLE',
          status: 'failed',
        });
      } finally {
        await connection.client`DELETE FROM agent_jobs WHERE idempotency_key = ${idempotencyKey}`;
        await connection.close();
      }
    });

    test('recovers an unleased processing Job and fails its running Run', async () => {
      const connection = createDatabaseConnection({ databaseUrl: integrationDatabaseUrl });
      const queue = new PostgresJobQueue(connection, { lockTimeoutMs: 1_000 });
      const repository = new PostgresAgentRunRepository(connection);
      const idempotencyKey = `stale-run-${crypto.randomUUID()}`;
      const runId = crypto.randomUUID();

      try {
        const job = await queue.enqueue({
          agentId: 'test-agent',
          input: { source: 'stale-run-integration' },
          triggerType: 'manual',
          idempotencyKey,
        });
        const claimed = await queue.claimNext({ agentId: 'test-agent', workerId: 'worker-one' });
        expect(claimed?.id).toBe(job.id);
        await repository.startRun({
          runId,
          jobId: job.id,
          agentId: 'test-agent',
          triggerType: 'manual',
          input: { source: 'stale-run-integration' },
          startedAt: new Date(),
        });
        await connection.client`
          UPDATE agent_jobs
          SET locked_at = NULL
          WHERE id = ${job.id}::uuid
        `;

        await queue.recoverStaleJobs();

        expect(await queue.get(job.id)).toMatchObject({
          status: 'retry_waiting',
          lastErrorCode: 'JOB_LOCK_EXPIRED',
        });
        expect(await repository.getRun(runId)).toMatchObject({
          status: 'failed',
          errorCode: 'JOB_LOCK_EXPIRED',
        });
      } finally {
        await connection.client`DELETE FROM agent_errors WHERE run_id = ${runId}::uuid`;
        await connection.client`DELETE FROM agent_jobs WHERE idempotency_key = ${idempotencyKey}`;
        await connection.close();
      }
    });

    test('persists Job-linked Agent Run completion and failure', async () => {
      const connection = createDatabaseConnection({ databaseUrl: integrationDatabaseUrl });
      const queue = new PostgresJobQueue(connection);
      const repository = new PostgresAgentRunRepository(connection);
      const idempotencyKey = `run-${crypto.randomUUID()}`;
      const completedRunId = crypto.randomUUID();
      const failedRunId = crypto.randomUUID();
      const abandonedRunId = crypto.randomUUID();
      const now = new Date();

      try {
        const job = await queue.enqueue({
          agentId: 'test-agent',
          input: { source: 'integration' },
          triggerType: 'manual',
          idempotencyKey,
        });

        await repository.startRun({
          runId: completedRunId,
          jobId: job.id,
          agentId: 'test-agent',
          triggerType: 'queue',
          input: { source: 'integration' },
          startedAt: now,
        });
        await repository.completeRun({
          runId: completedRunId,
          output: { result: 'ok' },
          completedAt: now,
        });
        expect(await queue.get(job.id)).toMatchObject({ id: job.id, status: 'queued' });
        expect(await repository.getRun(completedRunId)).toMatchObject({
          id: completedRunId,
          jobId: job.id,
          status: 'completed',
        });

        await repository.startRun({
          runId: failedRunId,
          jobId: job.id,
          agentId: 'test-agent',
          triggerType: 'queue',
          input: { source: 'integration' },
          startedAt: now,
        });
        await repository.failRun({
          runId: failedRunId,
          errorCode: 'AGENT_EXECUTION_FAILED',
          errorMessage: 'provider unavailable',
          completedAt: now,
        });

        const [completedRun] = (await connection.client`
          SELECT status, output_json
          FROM agent_runs
          WHERE id = ${completedRunId}::uuid
        `) as [{ status: string; output_json: unknown }];
        const [failedRun] = (await connection.client`
          SELECT status
          FROM agent_runs
          WHERE id = ${failedRunId}::uuid
        `) as [{ status: string }];
        const [error] = (await connection.client`
          SELECT code, message, job_id
          FROM agent_errors
          WHERE run_id = ${failedRunId}::uuid
        `) as [{ code: string; message: string; job_id: string }];

        expect(completedRun).toEqual({ status: 'completed', output_json: { result: 'ok' } });
        expect(failedRun).toEqual({ status: 'failed' });
        expect(error).toEqual({
          code: 'AGENT_EXECUTION_FAILED',
          message: 'provider unavailable',
          job_id: job.id,
        });

        await expect(
          repository.completeRun({
            runId: failedRunId,
            output: { result: 'unexpected' },
            completedAt: now,
          }),
        ).rejects.toThrow(`Agent Run "${failedRunId}" is not running and cannot be completed`);
        await expect(
          repository.failRun({
            runId: completedRunId,
            errorCode: 'AGENT_EXECUTION_FAILED',
            errorMessage: 'unexpected',
            completedAt: now,
          }),
        ).rejects.toThrow(`Agent Run "${completedRunId}" is not running and cannot be failed`);

        const claimed = await queue.claimNext({ agentId: 'test-agent', workerId: 'worker-one' });
        expect(claimed?.id).toBe(job.id);
        await repository.startRun({
          runId: abandonedRunId,
          jobId: job.id,
          agentId: 'test-agent',
          triggerType: 'queue',
          input: { source: 'integration' },
          startedAt: now,
        });
        await queue.fail({
          jobId: job.id,
          workerId: 'worker-one',
          error: new Error('Run persistence failed'),
          retryable: true,
        });
        expect(await repository.getRun(abandonedRunId)).toMatchObject({
          status: 'failed',
          errorCode: 'RUN_PERSISTENCE_FAILED',
        });
      } finally {
        await connection.client`
          DELETE FROM agent_errors
          WHERE run_id IN (${completedRunId}::uuid, ${failedRunId}::uuid, ${abandonedRunId}::uuid)
        `;
        await connection.client`DELETE FROM agent_jobs WHERE idempotency_key = ${idempotencyKey}`;
        await connection.close();
      }
    });
  },
);
