import { AgentDependencyError } from '@ai-agents/agent-core';
import type {
  JobEmailCalendarEventRepository,
  JobEmailCalendarEventReservation,
} from '@ai-agents/job-search-email';
import type { DatabaseConnection } from './client';

/** Persists a durable reservation before Calendar writes so retries cannot create duplicate events. */
export class PostgresJobEmailCalendarEventRepository implements JobEmailCalendarEventRepository {
  constructor(private readonly database: Pick<DatabaseConnection, 'client'>) {}

  async reserve(input: {
    readonly googleConnectionId: string;
    readonly gmailMessageId: string;
    readonly gmailThreadId: string;
    readonly idempotencyKey: string;
    readonly jobId: string;
    readonly runId: string;
  }): Promise<JobEmailCalendarEventReservation> {
    const [inserted] = (await this.database.client`
      INSERT INTO job_calendar_events (
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
      WHERE job_calendar_events.status = 'creating'
        AND (
          job_calendar_events.job_id = EXCLUDED.job_id
          OR EXISTS (
            SELECT 1
            FROM agent_jobs
            WHERE agent_jobs.id = job_calendar_events.job_id
              AND agent_jobs.status = 'failed'
          )
        )
      RETURNING status, google_event_id
    `) as Array<{ google_event_id: string | null; status: 'completed' | 'creating' }>;
    if (inserted) {
      return inserted.status === 'completed' && inserted.google_event_id
        ? { eventId: inserted.google_event_id, status: 'completed' }
        : { eventId: null, status: 'reserved' };
    }
    const [existing] = (await this.database.client`
      SELECT status, google_event_id, job_id
      FROM job_calendar_events
      WHERE google_connection_id = ${input.googleConnectionId}::uuid
        AND gmail_message_id = ${input.gmailMessageId}
      LIMIT 1
    `) as Array<{
      google_event_id: string | null;
      job_id: string;
      status: 'completed' | 'creating';
    }>;
    if (existing?.status === 'completed' && existing.google_event_id) {
      return { eventId: existing.google_event_id, status: 'completed' };
    }
    if (existing?.job_id === input.jobId) return { eventId: null, status: 'reserved' };
    throw new AgentDependencyError(
      'TEMPORARY_UNAVAILABLE',
      true,
      'Another Worker is creating this Google Calendar event',
    );
  }

  async complete(input: {
    readonly calendarEvent: { readonly eventId: string };
    readonly idempotencyKey: string;
    readonly jobId: string;
    readonly runId: string;
  }): Promise<void> {
    const [updated] = (await this.database.client`
      UPDATE job_calendar_events
      SET status = 'completed', google_event_id = ${input.calendarEvent.eventId},
          run_id = ${input.runId}::uuid, completed_at = NOW()
      WHERE idempotency_key = ${input.idempotencyKey}
        AND job_id = ${input.jobId}::uuid
        AND status = 'creating'
      RETURNING id
    `) as Array<{ id: string }>;
    if (updated) return;
    const [existing] = (await this.database.client`
      SELECT status, google_event_id
      FROM job_calendar_events
      WHERE idempotency_key = ${input.idempotencyKey}
        AND job_id = ${input.jobId}::uuid
      LIMIT 1
    `) as Array<{ google_event_id: string | null; status: 'completed' | 'creating' }>;
    if (
      existing?.status === 'completed' &&
      existing.google_event_id === input.calendarEvent.eventId
    ) {
      return;
    }
    throw new AgentDependencyError(
      'INVALID_REQUEST',
      false,
      'Calendar event reservation does not belong to this Job or was already completed differently',
    );
  }
}
