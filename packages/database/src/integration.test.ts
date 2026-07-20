import { describe, expect, test } from 'bun:test';
import { IdempotencyConflictError, RetryableJobError } from '@ai-agents/agent-core';
import { AesGcmTokenCipher } from '@ai-agents/google-oauth';
import {
  jobEmailAnalysisPromptVersion,
  jobEmailAnalysisSchemaVersion,
} from '@ai-agents/job-search-email';

import {
  createDatabaseConnection,
  type DatabaseConnection,
  PostgresAgentRunRepository,
  PostgresGoogleConnectionRepository,
  PostgresJobEmailAnalysisRepository,
  PostgresJobEmailCalendarEventRepository,
  PostgresJobEmailDraftRepository,
  PostgresJobEmailReviewRequestRepository,
  PostgresJobEmailSettingsRepository,
  PostgresJobQueue,
  PostgresLlmInvocationRepository,
  PostgresOAuthStateRepository,
} from './index';
import {
  applyMigrationFile,
  databaseUrl,
  integrationDatabaseUrl,
  integrationEnabled,
  runMigrations,
} from './integration-test-support';

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
        expect(await temporary.isSchemaReady()).toBe(false);
        await applyMigrationFile(temporary, '0007_parched_tana_nile.sql');
        expect(await temporary.isSchemaReady()).toBe(false);
        await applyMigrationFile(temporary, '0008_supreme_nemesis.sql');
        await temporary.client`
          INSERT INTO agent_settings (user_id, agent_id, settings_json, updated_at)
          VALUES
            (${user.id}::uuid, 'job-search-email', '{"userName":"older"}'::jsonb, NOW() - INTERVAL '1 day'),
            (${user.id}::uuid, 'job-search-email', '{"userName":"newer"}'::jsonb, NOW())
        `;
        expect(await temporary.isSchemaReady()).toBe(false);
        await applyMigrationFile(temporary, '0009_stiff_nuke.sql');
        expect(await temporary.isSchemaReady()).toBe(false);
        await applyMigrationFile(temporary, '0010_slow_wonder_man.sql');
        expect(await temporary.isSchemaReady()).toBe(false);
        await applyMigrationFile(temporary, '0011_careless_rhodey.sql');
        expect(await temporary.isSchemaReady()).toBe(true);
        const settings = (await temporary.client`
          SELECT settings_json
          FROM agent_settings
          WHERE user_id = ${user.id}::uuid
            AND agent_id = 'job-search-email'
        `) as Array<{ settings_json: { userName: string } }>;
        expect(settings).toEqual([{ settings_json: { userName: 'newer' } }]);
        const constraints = (await temporary.client`
          SELECT conname
          FROM pg_constraint
          WHERE conrelid = 'job_email_analyses'::regclass
            AND conname LIKE 'job_email_analyses_%_check'
          ORDER BY conname
        `) as Array<{ conname: string }>;
        expect(constraints.map(({ conname }) => conname)).toEqual([
          'job_email_analyses_category_check',
          'job_email_analyses_confidence_check',
          'job_email_analyses_confirmed_category_check',
          'job_email_analyses_job_category_check',
          'job_email_analyses_meeting_range_check',
          'job_email_analyses_meeting_timezone_check',
          'job_email_analyses_meeting_url_check',
          'job_email_analyses_reply_intent_check',
          'job_email_analyses_reply_required_check',
          'job_email_analyses_url_type_check',
        ]);
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
          output: { result: 'ok' },
          status: 'completed',
        });
        await repository.startStep({
          input: { gmailMessageId: 'message-1' },
          runId: completedRunId,
          sequence: 10,
          startedAt: now,
          stepName: 'FETCH_EMAIL_THREAD',
        });
        await repository.completeStep({
          completedAt: now,
          output: { messageCount: 1 },
          runId: completedRunId,
          stepName: 'FETCH_EMAIL_THREAD',
        });
        await repository.startStep({
          input: { gmailMessageId: 'message-1' },
          runId: completedRunId,
          sequence: 20,
          startedAt: now,
          stepName: 'ANALYZE_EMAIL',
        });
        await repository.failStep({
          completedAt: now,
          errorCode: 'RATE_LIMITED',
          retryable: true,
          runId: completedRunId,
          stepName: 'ANALYZE_EMAIL',
        });
        expect(await repository.getSteps(completedRunId)).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              output: { messageCount: 1 },
              status: 'succeeded',
              stepName: 'FETCH_EMAIL_THREAD',
            }),
            expect.objectContaining({
              errorCode: 'RATE_LIMITED',
              output: { retryable: true },
              status: 'failed',
              stepName: 'ANALYZE_EMAIL',
            }),
          ]),
        );

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

    test('persists LLM invocation metadata without prompt or generated content', async () => {
      const connection = createDatabaseConnection({ databaseUrl: integrationDatabaseUrl });
      const queue = new PostgresJobQueue(connection);
      const runs = new PostgresAgentRunRepository(connection);
      const invocations = new PostgresLlmInvocationRepository(connection);
      const idempotencyKey = `llm-${crypto.randomUUID()}`;
      const runId = crypto.randomUUID();
      const now = new Date();

      try {
        const job = await queue.enqueue({
          agentId: 'test-agent',
          input: { source: 'llm-integration' },
          triggerType: 'manual',
          idempotencyKey,
        });
        await runs.startRun({
          runId,
          jobId: job.id,
          agentId: 'test-agent',
          triggerType: 'queue',
          input: { source: 'llm-integration' },
          startedAt: now,
        });
        await invocations.recordInvocation({
          attempt: 1,
          createdAt: now,
          durationMs: 125,
          estimatedCostUsd: 0.0055,
          inputTokens: 1_000,
          model: 'gpt-5.6-terra',
          outcome: 'completed',
          outputTokens: 200,
          promptVersion: 'email-analysis.v1',
          provider: 'openai',
          reviewReason: null,
          runId,
          schemaName: 'email_analysis',
          schemaVersion: '1',
          totalTokens: 1_200,
        });

        const [invocation] = (await connection.client`
          SELECT
            provider,
            model,
            prompt_version,
            schema_name,
            schema_version,
            attempt,
            outcome,
            review_reason,
            input_tokens,
            output_tokens,
            total_tokens,
            estimated_cost_usd,
            duration_ms
          FROM llm_invocations
          WHERE run_id = ${runId}::uuid
        `) as Array<{
          attempt: number;
          duration_ms: number;
          estimated_cost_usd: string | null;
          input_tokens: number;
          model: string;
          outcome: string;
          output_tokens: number;
          prompt_version: string;
          provider: string;
          review_reason: string | null;
          schema_name: string;
          schema_version: string;
          total_tokens: number;
        }>;
        expect(invocation).toEqual({
          attempt: 1,
          duration_ms: 125,
          estimated_cost_usd: '0.00550000',
          input_tokens: 1_000,
          model: 'gpt-5.6-terra',
          outcome: 'completed',
          output_tokens: 200,
          prompt_version: 'email-analysis.v1',
          provider: 'openai',
          review_reason: null,
          schema_name: 'email_analysis',
          schema_version: '1',
          total_tokens: 1_200,
        });
      } finally {
        await connection.client`DELETE FROM agent_runs WHERE id = ${runId}::uuid`;
        await connection.client`DELETE FROM agent_jobs WHERE idempotency_key = ${idempotencyKey}`;
        await connection.close();
      }
    });

    test('appends Job Email analyses by Run and creates idempotent review requests', async () => {
      const connection = createDatabaseConnection({ databaseUrl: integrationDatabaseUrl });
      const queue = new PostgresJobQueue(connection);
      const runs = new PostgresAgentRunRepository(connection);
      const analyses = new PostgresJobEmailAnalysisRepository(connection);
      const reviews = new PostgresJobEmailReviewRequestRepository(connection);
      const idempotencyKey = `analysis-${crypto.randomUUID()}`;
      const runIdOne = crypto.randomUUID();
      const runIdTwo = crypto.randomUUID();
      const runIds = [runIdOne, runIdTwo] as const;
      const email = `analysis-${crypto.randomUUID()}@example.com`;
      let connectionId = '';

      try {
        const [googleConnection] = (await connection.client`
          WITH inserted_user AS (
            INSERT INTO users (email) VALUES (${email}) RETURNING id
          )
          INSERT INTO connections (
            user_id, type, google_email, encrypted_refresh_token, granted_scopes, status
          )
          SELECT
            id, 'google', ${email}, 'encrypted-test-token',
            ARRAY['https://www.googleapis.com/auth/gmail.readonly'], 'connected'
          FROM inserted_user
          RETURNING id
        `) as Array<{ id: string }>;
        if (!googleConnection) throw new Error('Expected a Google connection');
        connectionId = googleConnection.id;
        const job = await queue.enqueue({
          agentId: 'job-search-email',
          input: {
            googleConnectionId: connectionId,
            gmailMessageId: 'gmail-message-1',
            gmailThreadId: 'gmail-thread-1',
          },
          triggerType: 'manual',
          idempotencyKey,
        });
        for (const runId of runIds) {
          await runs.startRun({
            runId,
            jobId: job.id,
            agentId: 'job-search-email',
            triggerType: 'manual',
            input: {
              googleConnectionId: connectionId,
              gmailMessageId: 'gmail-message-1',
              gmailThreadId: 'gmail-thread-1',
            },
            startedAt: new Date(),
          });
        }

        for (const [index, runId] of runIds.entries()) {
          await analyses.saveAnalysis({
            analysis: {
              isJobRelated: true,
              category: 'application_update',
              companyName: 'Example株式会社',
              contactName: null,
              needsReply: false,
              replyIntent: 'none',
              missingRequiredInformation: [],
              meeting: {
                isConfirmed: false,
                startAt: null,
                endAt: null,
                timezone: null,
                url: null,
                urlType: 'none',
              },
              confidence: 0.8 + index * 0.1,
              evidence: [`analysis-${index}`],
            },
            googleConnectionId: connectionId,
            gmailMessageId: 'gmail-message-1',
            gmailThreadId: 'gmail-thread-1',
            metadata: {
              model: `test-model-${index}`,
              promptVersion: jobEmailAnalysisPromptVersion,
              schemaName: 'job_email_analysis',
              schemaVersion: jobEmailAnalysisSchemaVersion,
            },
            runId,
          });
        }
        const repeatedAnalysis = {
          analysis: {
            isJobRelated: true,
            category: 'application_update' as const,
            companyName: 'Example株式会社',
            contactName: null,
            needsReply: false,
            replyIntent: 'none' as const,
            missingRequiredInformation: [],
            meeting: {
              isConfirmed: false,
              startAt: null,
              endAt: null,
              timezone: null,
              url: null,
              urlType: 'none' as const,
            },
            confidence: 0.9,
            evidence: ['analysis-1'],
          },
          googleConnectionId: connectionId,
          gmailMessageId: 'gmail-message-1',
          gmailThreadId: 'gmail-thread-1',
          metadata: {
            model: 'test-model-1',
            promptVersion: jobEmailAnalysisPromptVersion,
            schemaName: 'job_email_analysis',
            schemaVersion: jobEmailAnalysisSchemaVersion,
          },
          runId: runIdTwo,
        };
        await analyses.saveAnalysis(repeatedAnalysis);
        await expect(
          analyses.saveAnalysis({
            ...repeatedAnalysis,
            metadata: { ...repeatedAnalysis.metadata, model: 'different-model' },
          }),
        ).rejects.toMatchObject({ code: 'INVALID_REQUEST', retryable: false });

        const latest = await analyses.getLatestByMessage({
          googleConnectionId: connectionId,
          gmailMessageId: 'gmail-message-1',
        });
        expect(latest).toMatchObject({ runId: runIdTwo, metadata: { model: 'test-model-1' } });
        const countRows = (await connection.client`
          SELECT COUNT(*)::int AS count FROM job_email_analyses
          WHERE google_connection_id = ${connectionId}::uuid
            AND gmail_message_id = 'gmail-message-1'
        `) as Array<{ count: number }>;
        expect(countRows[0]?.count).toBe(2);

        const reviewInput = {
          agentId: 'job-search-email',
          jobId: job.id,
          reason: 'llm_refusal' as const,
          runId: runIdOne,
        };
        await reviews.createReviewRequest(reviewInput);
        await reviews.createReviewRequest(reviewInput);
        await expect(
          reviews.createReviewRequest({ ...reviewInput, agentId: 'different-agent' }),
        ).rejects.toMatchObject({ code: 'INVALID_REQUEST', retryable: false });
        await expect(
          reviews.createReviewRequest({ ...reviewInput, reason: 'llm_invalid_output' }),
        ).rejects.toMatchObject({ code: 'INVALID_REQUEST', retryable: false });
        const reviewRows = (await connection.client`
          SELECT COUNT(*)::int AS review_count FROM review_requests
          WHERE run_id = ${runIdOne}::uuid AND reason = 'llm_refusal'
        `) as Array<{ review_count: number }>;
        expect(reviewRows[0]?.review_count).toBe(1);
      } finally {
        if (connectionId) {
          await connection.client`DELETE FROM connections WHERE id = ${connectionId}::uuid`;
        }
        await connection.client`DELETE FROM agent_runs WHERE id IN (${runIdOne}::uuid, ${runIdTwo}::uuid)`;
        await connection.client`DELETE FROM agent_jobs WHERE idempotency_key = ${idempotencyKey}`;
        await connection.client`DELETE FROM users WHERE email = ${email}`;
        await connection.close();
      }
    });

    test('reserves and completes an idempotent Job Email Draft with its reply settings', async () => {
      const connection = createDatabaseConnection({ databaseUrl: integrationDatabaseUrl });
      const queue = new PostgresJobQueue(connection);
      const runs = new PostgresAgentRunRepository(connection);
      const drafts = new PostgresJobEmailDraftRepository(connection);
      const calendarEvents = new PostgresJobEmailCalendarEventRepository(connection);
      const settings = new PostgresJobEmailSettingsRepository(connection);
      const email = `draft-${crypto.randomUUID()}@example.com`;
      const idempotencyKey = `draft-${crypto.randomUUID()}`;
      const runId = crypto.randomUUID();
      const takeoverJobKeyOne = `draft-takeover-one-${crypto.randomUUID()}`;
      const takeoverJobKeyTwo = `draft-takeover-two-${crypto.randomUUID()}`;
      const takeoverDraftKey = `gmail-draft-takeover-${crypto.randomUUID()}`;
      const takeoverRunIdOne = crypto.randomUUID();
      const takeoverRunIdTwo = crypto.randomUUID();
      let connectionId = '';

      try {
        const [googleConnection] = (await connection.client`
          WITH inserted_user AS (
            INSERT INTO users (email) VALUES (${email}) RETURNING id
          ), configured_settings AS (
            INSERT INTO agent_settings (user_id, agent_id, enabled, settings_json)
            SELECT id, 'job-search-email', true,
              '{"createDrafts":true,"draftConfidenceThreshold":0.9,"emailSignature":"署名","userName":"候補者"}'::jsonb
            FROM inserted_user
            RETURNING user_id
          )
          INSERT INTO connections (
            user_id, type, google_email, encrypted_refresh_token, granted_scopes, status
          )
          SELECT
            user_id, 'google', ${email}, 'encrypted-test-token',
            ARRAY['https://www.googleapis.com/auth/gmail.compose'], 'connected'
          FROM configured_settings
          RETURNING id
        `) as Array<{ id: string }>;
        if (!googleConnection) throw new Error('Expected a Google connection');
        connectionId = googleConnection.id;
        expect(await settings.getReplySettings(connectionId)).toEqual({
          createDrafts: true,
          draftConfidenceThreshold: 0.9,
          emailSignature: '署名',
          googleEmail: email,
          userName: '候補者',
        });

        const job = await queue.enqueue({
          agentId: 'job-search-email',
          input: { gmailMessageId: 'message-1' },
          triggerType: 'manual',
          idempotencyKey,
        });
        await runs.startRun({
          runId,
          jobId: job.id,
          agentId: 'job-search-email',
          triggerType: 'manual',
          input: { gmailMessageId: 'message-1' },
          startedAt: new Date(),
        });
        const reservationInput = {
          googleConnectionId: connectionId,
          gmailMessageId: 'message-1',
          gmailThreadId: 'thread-1',
          idempotencyKey,
          jobId: job.id,
          runId,
        };
        expect(await drafts.reserve(reservationInput)).toEqual({
          draftId: null,
          status: 'reserved',
        });
        expect(await drafts.reserve(reservationInput)).toEqual({
          draftId: null,
          status: 'reserved',
        });
        const completionInput = {
          gmailDraft: {
            draftId: 'gmail-draft-1',
            messageId: 'draft-message-1',
            threadId: 'thread-1',
          },
          idempotencyKey,
          jobId: job.id,
          replyBodyHash: 'a'.repeat(64),
          runId,
        };
        await drafts.complete(completionInput);
        await drafts.complete(completionInput);
        await expect(
          drafts.complete({
            ...completionInput,
            gmailDraft: { ...completionInput.gmailDraft, draftId: 'different-draft' },
          }),
        ).rejects.toMatchObject({ code: 'INVALID_REQUEST', retryable: false });
        expect(await drafts.reserve(reservationInput)).toEqual({
          draftId: 'gmail-draft-1',
          status: 'completed',
        });

        const calendarReservationInput = {
          ...reservationInput,
          idempotencyKey: `calendar-event-${crypto.randomUUID()}`,
        };
        expect(await calendarEvents.reserve(calendarReservationInput)).toEqual({
          eventId: null,
          status: 'reserved',
        });
        const calendarCompletionInput = {
          calendarEvent: {
            eventId: 'aia0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
          },
          idempotencyKey: calendarReservationInput.idempotencyKey,
          jobId: job.id,
          runId,
        };
        await calendarEvents.complete(calendarCompletionInput);
        await calendarEvents.complete(calendarCompletionInput);
        expect(await calendarEvents.reserve(calendarReservationInput)).toEqual({
          eventId: calendarCompletionInput.calendarEvent.eventId,
          status: 'completed',
        });

        const failedJob = await queue.enqueue({
          agentId: 'job-search-email',
          input: { gmailMessageId: 'message-2' },
          triggerType: 'manual',
          idempotencyKey: takeoverJobKeyOne,
        });
        await runs.startRun({
          runId: takeoverRunIdOne,
          jobId: failedJob.id,
          agentId: 'job-search-email',
          triggerType: 'manual',
          input: { gmailMessageId: 'message-2' },
          startedAt: new Date(),
        });
        const failedReservation = {
          googleConnectionId: connectionId,
          gmailMessageId: 'message-2',
          gmailThreadId: 'thread-2',
          idempotencyKey: takeoverDraftKey,
          jobId: failedJob.id,
          runId: takeoverRunIdOne,
        };
        expect(await drafts.reserve(failedReservation)).toEqual({
          draftId: null,
          status: 'reserved',
        });
        await connection.client`
          UPDATE agent_jobs SET status = 'failed', completed_at = NOW()
          WHERE id = ${failedJob.id}::uuid
        `;

        const recoveryJob = await queue.enqueue({
          agentId: 'job-search-email',
          input: { gmailMessageId: 'message-2' },
          triggerType: 'manual',
          idempotencyKey: takeoverJobKeyTwo,
        });
        await runs.startRun({
          runId: takeoverRunIdTwo,
          jobId: recoveryJob.id,
          agentId: 'job-search-email',
          triggerType: 'manual',
          input: { gmailMessageId: 'message-2' },
          startedAt: new Date(),
        });
        expect(
          await drafts.reserve({
            ...failedReservation,
            jobId: recoveryJob.id,
            runId: takeoverRunIdTwo,
          }),
        ).toEqual({ draftId: null, status: 'reserved' });
        await expect(
          drafts.complete({
            gmailDraft: {
              draftId: 'stale-owner-draft',
              messageId: 'stale-owner-message',
              threadId: 'thread-2',
            },
            idempotencyKey: takeoverDraftKey,
            jobId: failedJob.id,
            replyBodyHash: 'b'.repeat(64),
            runId: takeoverRunIdOne,
          }),
        ).rejects.toMatchObject({ code: 'INVALID_REQUEST', retryable: false });
        await drafts.complete({
          gmailDraft: {
            draftId: 'recovered-draft',
            messageId: 'recovered-message',
            threadId: 'thread-2',
          },
          idempotencyKey: takeoverDraftKey,
          jobId: recoveryJob.id,
          replyBodyHash: 'c'.repeat(64),
          runId: takeoverRunIdTwo,
        });
      } finally {
        if (connectionId) {
          await connection.client`DELETE FROM connections WHERE id = ${connectionId}::uuid`;
        }
        await connection.client`DELETE FROM agent_runs WHERE id = ${runId}::uuid`;
        await connection.client`
          DELETE FROM agent_runs
          WHERE id IN (${takeoverRunIdOne}::uuid, ${takeoverRunIdTwo}::uuid)
        `;
        await connection.client`DELETE FROM agent_jobs WHERE idempotency_key = ${idempotencyKey}`;
        await connection.client`
          DELETE FROM agent_jobs
          WHERE idempotency_key IN (${takeoverJobKeyOne}, ${takeoverJobKeyTwo})
        `;
        await connection.client`DELETE FROM users WHERE email = ${email}`;
        await connection.close();
      }
    });
  },
);
