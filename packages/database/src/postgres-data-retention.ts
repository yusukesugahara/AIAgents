import type { DatabaseConnection } from './client';

export class PostgresOperationalDataRetentionRepository {
  constructor(private readonly database: Pick<DatabaseConnection, 'client'>) {}

  /** Deletes terminal Job histories while preserving Jobs with an unresolved review request. */
  async deleteExpired(before: Date): Promise<number> {
    if (Number.isNaN(before.getTime())) throw new Error('Retention cutoff must be a valid date');
    const cutoff = before.toISOString();
    return this.database.client.begin(async (sql) => {
      await sql`
        DELETE FROM agent_errors
        WHERE job_id IN (
          SELECT jobs.id
          FROM agent_jobs AS jobs
          WHERE jobs.status IN ('completed', 'failed', 'needs_review')
            AND COALESCE(jobs.completed_at, jobs.created_at) < ${cutoff}::timestamptz
            AND NOT EXISTS (
              SELECT 1 FROM review_requests AS reviews
              WHERE reviews.job_id = jobs.id AND reviews.status = 'pending'
            )
        )
      `;
      const deleted = (await sql`
        DELETE FROM agent_jobs AS jobs
        WHERE jobs.status IN ('completed', 'failed', 'needs_review')
          AND COALESCE(jobs.completed_at, jobs.created_at) < ${cutoff}::timestamptz
          AND NOT EXISTS (
            SELECT 1 FROM review_requests AS reviews
            WHERE reviews.job_id = jobs.id AND reviews.status = 'pending'
          )
        RETURNING jobs.id
      `) as Array<{ id: string }>;
      return deleted.length;
    });
  }
}
