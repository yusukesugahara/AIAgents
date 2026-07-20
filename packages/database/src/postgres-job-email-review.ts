import type { JobEmailReviewRequestRepository } from '@ai-agents/job-search-email';
import type { DatabaseConnection } from './client';
import { invalidPersistenceReference } from './postgres-errors';

export class PostgresJobEmailReviewRequestRepository implements JobEmailReviewRequestRepository {
  constructor(private readonly database: Pick<DatabaseConnection, 'client'>) {}

  async createReviewRequest(
    input: Parameters<JobEmailReviewRequestRepository['createReviewRequest']>[0],
  ): Promise<void> {
    const [run] = (await this.database.client`
      SELECT EXISTS (
        SELECT 1 FROM agent_runs
        WHERE id = ${input.runId}::uuid
          AND job_id = ${input.jobId}::uuid
          AND agent_id = ${input.agentId}
      ) AS matches
    `) as Array<{ matches: boolean }>;
    if (!run?.matches) {
      throw invalidPersistenceReference('Review request Run, Job, and Agent do not match');
    }

    const [inserted] = await this.database.client`
      INSERT INTO review_requests (agent_id, job_id, run_id, reason)
      VALUES (${input.agentId}, ${input.jobId}::uuid, ${input.runId}::uuid, ${input.reason})
      ON CONFLICT (run_id) DO NOTHING
      RETURNING id
    `;
    if (inserted) return;

    const [existing] = await this.database.client`
      SELECT id FROM review_requests
      WHERE run_id = ${input.runId}::uuid
        AND job_id = ${input.jobId}::uuid
        AND agent_id = ${input.agentId}
        AND reason = ${input.reason}
    `;
    if (!existing) {
      throw invalidPersistenceReference('Review request Run already has different ownership');
    }
  }
}
