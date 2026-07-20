import { AgentDependencyError } from '@ai-agents/agent-core';
import type {
  JobEmailCalendarSettings,
  JobEmailDraftRepository,
  JobEmailDraftReservation,
  JobEmailReplySettings,
  JobEmailSettingsRepository,
} from '@ai-agents/job-search-email';
import { z } from 'zod';
import type { DatabaseConnection } from './client';

const settingsSchema = z
  .object({
    calendarConfidenceThreshold: z.number().min(0).max(1).default(0.9),
    createCalendarEvents: z.boolean().default(true),
    createDrafts: z.boolean().default(true),
    draftConfidenceThreshold: z.number().min(0).max(1).default(0.85),
    emailSignature: z.string().max(2_000).default(''),
    replyStyle: z.literal('polite_concise').default('polite_concise'),
    timezone: z.string().trim().min(1).max(100).default('Asia/Tokyo'),
    userName: z.string().trim().min(1).max(100).optional(),
  })
  .strict();

export class PostgresJobEmailSettingsRepository implements JobEmailSettingsRepository {
  constructor(private readonly database: Pick<DatabaseConnection, 'client'>) {}

  async getReplySettings(googleConnectionId: string): Promise<JobEmailReplySettings | null> {
    const settings = await this.#getSettings(googleConnectionId);
    if (!settings) return null;
    return {
      createDrafts: settings.enabled && settings.data.createDrafts,
      draftConfidenceThreshold: settings.data.draftConfidenceThreshold,
      emailSignature: settings.data.emailSignature,
      googleEmail: settings.googleEmail,
      userName: settings.data.userName ?? null,
    };
  }

  async getCalendarSettings(googleConnectionId: string): Promise<JobEmailCalendarSettings | null> {
    const settings = await this.#getSettings(googleConnectionId);
    if (!settings) return null;
    return {
      calendarConfidenceThreshold: settings.data.calendarConfidenceThreshold,
      createCalendarEvents: settings.enabled && settings.data.createCalendarEvents,
      timezone: settings.data.timezone,
    };
  }

  async #getSettings(googleConnectionId: string): Promise<{
    data: z.infer<typeof settingsSchema>;
    enabled: boolean;
    googleEmail: string;
  } | null> {
    const [row] = (await this.database.client`
      SELECT connections.google_email, agent_settings.enabled, agent_settings.settings_json
      FROM connections
      LEFT JOIN agent_settings
        ON agent_settings.user_id = connections.user_id
       AND agent_settings.agent_id = 'job-search-email'
      WHERE connections.id = ${googleConnectionId}::uuid
        AND connections.type = 'google'
      LIMIT 1
    `) as Array<{ enabled: boolean | null; google_email: string; settings_json: unknown | null }>;
    if (!row || row.enabled === null || row.settings_json === null) return null;
    const settings = settingsSchema.safeParse(row.settings_json);
    if (!settings.success) return null;
    return {
      data: settings.data,
      enabled: row.enabled,
      googleEmail: row.google_email.toLowerCase(),
    };
  }
}

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
