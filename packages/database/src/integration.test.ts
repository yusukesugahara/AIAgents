import { describe, expect, test } from 'bun:test';

import { createDatabaseConnection, PostgresAgentRunRepository, PostgresJobQueue } from './index';

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
    }, 15_000);

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

    test('queues, retries, and recovers Jobs without duplicate claims', async () => {
      const connection = createDatabaseConnection({ databaseUrl: integrationDatabaseUrl });
      const queue = new PostgresJobQueue(connection, {
        lockTimeoutMs: 1,
        retryDelaysMs: [1, 2, 4],
      });
      const idempotencyKey = `queue-${crypto.randomUUID()}`;

      try {
        const first = await queue.enqueue({
          agentId: 'test-agent',
          input: { source: 'integration' },
          idempotencyKey,
        });
        const duplicate = await queue.enqueue({
          agentId: 'test-agent',
          input: { source: 'ignored' },
          idempotencyKey,
        });
        expect(duplicate.id).toBe(first.id);

        const [claimedByOne, claimedByTwo] = await Promise.all([
          queue.claimNext({ workerId: 'worker-one' }),
          queue.claimNext({ workerId: 'worker-two' }),
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

        const retried = await queue.claimNext({ workerId: 'worker-three' });
        expect(retried?.attempts).toBe(2);
        expect(retried?.status).toBe('processing');
        if (!retried) {
          throw new Error('Expected a retried Job');
        }

        await connection.client`
          UPDATE agent_jobs
          SET locked_at = NOW() - INTERVAL '2 seconds'
          WHERE id = ${retried.id}::uuid
        `;
        expect(await queue.recoverStaleJobs()).toBe(1);

        const recovered = await queue.claimNext({ workerId: 'worker-four' });
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
          SELECT status, attempts, completed_at
          FROM agent_jobs
          WHERE id = ${first.id}::uuid
        `) as [{ status: string; attempts: number; completed_at: Date | null }];
        expect(terminal).toEqual({
          status: 'failed',
          attempts: 3,
          completed_at: expect.any(String),
        });
      } finally {
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
      const now = new Date();

      try {
        const job = await queue.enqueue({
          agentId: 'test-agent',
          input: { source: 'integration' },
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
      } finally {
        await connection.client`
          DELETE FROM agent_errors
          WHERE run_id IN (${completedRunId}::uuid, ${failedRunId}::uuid)
        `;
        await connection.client`DELETE FROM agent_jobs WHERE idempotency_key = ${idempotencyKey}`;
        await connection.close();
      }
    });
  },
);
