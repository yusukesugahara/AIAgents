import { AgentDependencyError } from '@ai-agents/agent-core';
import type {
  JobEmailDraftRepository,
  JobEmailDraftReservation,
} from '@ai-agents/job-search-email';
import type { DatabaseConnection } from './client';

export class PostgresJobEmailDraftRepository implements JobEmailDraftRepository {
  constructor(private readonly database: Pick<DatabaseConnection, 'client'>) {}

  async reserve(input: {
    readonly googleConnectionId: string;
    readonly gmailMessageId: string;
    readonly gmailThreadId: string;
    readonly idempotencyKey: string;
    readonly jobId: string;
    readonly runId: string;
  }): Promise<JobEmailDraftReservation> {
    const [inserted] = (await this.database.client`
      INSERT INTO job_email_drafts (
        google_connection_id, gmail_message_id, gmail_thread_id, job_id, run_id, idempotency_key
      ) VALUES (
        ${input.googleConnectionId}::uuid, ${input.gmailMessageId}, ${input.gmailThreadId},
        ${input.jobId}::uuid, ${input.runId}::uuid, ${input.idempotencyKey}
      )
      ON CONFLICT (google_connection_id, gmail_message_id) DO UPDATE
      SET gmail_thread_id = EXCLUDED.gmail_thread_id,
          job_id = EXCLUDED.job_id,
          run_id = EXCLUDED.run_id,
          idempotency_key = EXCLUDED.idempotency_key
      WHERE job_email_drafts.status = 'creating'
        AND (
          job_email_drafts.job_id = EXCLUDED.job_id
          OR EXISTS (
            SELECT 1
            FROM agent_jobs
            WHERE agent_jobs.id = job_email_drafts.job_id
              AND agent_jobs.status = 'failed'
          )
        )
      RETURNING status, gmail_draft_id
    `) as Array<{ gmail_draft_id: string | null; status: 'completed' | 'creating' }>;
    if (inserted) return { draftId: null, status: 'reserved' };
    const [existing] = (await this.database.client`
      SELECT status, gmail_draft_id, job_id
      FROM job_email_drafts
      WHERE google_connection_id = ${input.googleConnectionId}::uuid
        AND gmail_message_id = ${input.gmailMessageId}
      LIMIT 1
    `) as Array<{
      gmail_draft_id: string | null;
      job_id: string;
      status: 'completed' | 'creating';
    }>;
    if (existing?.status === 'completed' && existing.gmail_draft_id) {
      return { draftId: existing.gmail_draft_id, status: 'completed' };
    }
    if (existing?.job_id === input.jobId) return { draftId: null, status: 'reserved' };
    throw new AgentDependencyError(
      'TEMPORARY_UNAVAILABLE',
      true,
      'Another Worker is creating this Gmail Draft',
    );
  }

  async complete(input: {
    readonly gmailDraft: {
      readonly draftId: string;
      readonly messageId: string;
      readonly threadId: string;
    };
    readonly idempotencyKey: string;
    readonly jobId: string;
    readonly replyBodyHash: string;
    readonly runId: string;
  }): Promise<void> {
    const [updated] = (await this.database.client`
      UPDATE job_email_drafts
      SET status = 'completed', gmail_draft_id = ${input.gmailDraft.draftId},
          gmail_draft_message_id = ${input.gmailDraft.messageId}, reply_body_hash = ${input.replyBodyHash},
          run_id = ${input.runId}::uuid, completed_at = NOW()
      WHERE idempotency_key = ${input.idempotencyKey}
        AND job_id = ${input.jobId}::uuid
        AND status = 'creating'
      RETURNING id
    `) as Array<{ id: string }>;
    if (updated) return;
    const [existing] = (await this.database.client`
      SELECT status, gmail_draft_id, gmail_draft_message_id, gmail_thread_id, reply_body_hash
      FROM job_email_drafts
      WHERE idempotency_key = ${input.idempotencyKey}
        AND job_id = ${input.jobId}::uuid
      LIMIT 1
    `) as Array<{
      gmail_draft_id: string | null;
      gmail_draft_message_id: string | null;
      gmail_thread_id: string;
      reply_body_hash: string | null;
      status: 'completed' | 'creating';
    }>;
    if (
      existing?.status === 'completed' &&
      existing.gmail_draft_id === input.gmailDraft.draftId &&
      existing.gmail_draft_message_id === input.gmailDraft.messageId &&
      existing.gmail_thread_id === input.gmailDraft.threadId &&
      existing.reply_body_hash === input.replyBodyHash
    ) {
      return;
    }
    throw new AgentDependencyError(
      'INVALID_REQUEST',
      false,
      'Draft reservation does not belong to this Job or was already completed differently',
    );
  }
}
