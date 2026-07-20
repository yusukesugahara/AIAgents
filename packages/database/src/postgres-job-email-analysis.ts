import { AgentDependencyError } from '@ai-agents/agent-core';
import type {
  JobEmailAnalysisRecord,
  JobEmailAnalysisRepository,
  JobEmailReviewRequestRepository,
  StoredJobEmailAnalysis,
} from '@ai-agents/job-search-email';
import {
  jobEmailAnalysisPromptVersion,
  jobEmailAnalysisSchema,
  jobEmailAnalysisSchemaName,
  jobEmailAnalysisSchemaVersion,
} from '@ai-agents/job-search-email';
import type { DatabaseConnection } from './client';

interface AnalysisRow {
  readonly analysis_json: unknown;
  readonly created_at: Date | string;
  readonly gmail_message_id: string;
  readonly gmail_thread_id: string;
  readonly google_connection_id: string;
  readonly id: string;
  readonly model: string;
  readonly prompt_version: string;
  readonly run_id: string;
  readonly schema_name: string;
  readonly schema_version: string;
}

export class PostgresJobEmailAnalysisRepository implements JobEmailAnalysisRepository {
  constructor(private readonly database: Pick<DatabaseConnection, 'client'>) {}

  async saveAnalysis(record: JobEmailAnalysisRecord): Promise<void> {
    const validation = jobEmailAnalysisSchema.safeParse(record.analysis);
    if (!validation.success) {
      throw invalidPersistenceReference('Email analysis does not match its schema');
    }
    if (
      !record.metadata.model.trim() ||
      record.metadata.promptVersion !== jobEmailAnalysisPromptVersion ||
      record.metadata.schemaName !== jobEmailAnalysisSchemaName ||
      record.metadata.schemaVersion !== jobEmailAnalysisSchemaVersion
    ) {
      throw invalidPersistenceReference('Email analysis metadata does not match its contract');
    }
    const analysis = validation.data;
    const [run] = (await this.database.client`
      SELECT EXISTS (
        SELECT 1 FROM agent_runs
        WHERE id = ${record.runId}::uuid
          AND agent_id = 'job-search-email'
          AND input_json->>'googleConnectionId' = ${record.googleConnectionId}
          AND input_json->>'gmailMessageId' = ${record.gmailMessageId}
          AND input_json->>'gmailThreadId' = ${record.gmailThreadId}
      ) AS matches
    `) as Array<{ matches: boolean }>;
    if (!run?.matches) {
      throw invalidPersistenceReference('Email analysis Run does not belong to this Agent');
    }

    const analysisJson = JSON.stringify(analysis);
    const [inserted] = await this.database.client`
      INSERT INTO job_email_analyses (
        run_id, google_connection_id, gmail_message_id, gmail_thread_id, is_job_related,
        category, needs_reply, reply_intent, company_name, contact_name, meeting_is_confirmed,
        meeting_start_at, meeting_end_at, meeting_timezone, meeting_url, meeting_url_type,
        confidence, analysis_json, model, prompt_version, schema_name, schema_version
      )
      VALUES (
        ${record.runId}::uuid,
        ${record.googleConnectionId}::uuid,
        ${record.gmailMessageId},
        ${record.gmailThreadId},
        ${analysis.isJobRelated},
        ${analysis.category},
        ${analysis.needsReply},
        ${analysis.replyIntent},
        ${analysis.companyName},
        ${analysis.contactName},
        ${analysis.meeting.isConfirmed},
        ${analysis.meeting.startAt}::timestamptz,
        ${analysis.meeting.endAt}::timestamptz,
        ${analysis.meeting.timezone},
        ${analysis.meeting.url},
        ${analysis.meeting.urlType},
        ${analysis.confidence},
        ${analysisJson}::jsonb,
        ${record.metadata.model},
        ${record.metadata.promptVersion},
        ${record.metadata.schemaName},
        ${record.metadata.schemaVersion}
      )
      ON CONFLICT (run_id) DO NOTHING
      RETURNING id
    `;
    if (inserted) return;

    const [existing] = await this.database.client`
      SELECT id
      FROM job_email_analyses
      WHERE run_id = ${record.runId}::uuid
        AND google_connection_id = ${record.googleConnectionId}::uuid
        AND gmail_message_id = ${record.gmailMessageId}
        AND gmail_thread_id = ${record.gmailThreadId}
        AND analysis_json = ${analysisJson}::jsonb
        AND model = ${record.metadata.model}
        AND prompt_version = ${record.metadata.promptVersion}
        AND schema_name = ${record.metadata.schemaName}
        AND schema_version = ${record.metadata.schemaVersion}
    `;
    if (!existing) {
      throw invalidPersistenceReference('Email analysis Run already has different content');
    }
  }

  async getLatestByMessage(input: {
    readonly googleConnectionId: string;
    readonly gmailMessageId: string;
  }): Promise<StoredJobEmailAnalysis | null> {
    const [row] = (await this.database.client`
      SELECT
        id, run_id, google_connection_id, gmail_message_id, gmail_thread_id, analysis_json,
        model, prompt_version, schema_name, schema_version, created_at
      FROM job_email_analyses
      WHERE google_connection_id = ${input.googleConnectionId}::uuid
        AND gmail_message_id = ${input.gmailMessageId}
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `) as AnalysisRow[];
    if (!row) {
      return null;
    }
    const analysis = jobEmailAnalysisSchema.safeParse(row.analysis_json);
    if (!analysis.success) {
      throw new AgentDependencyError('INVALID_RESPONSE', false, 'Stored email analysis is invalid');
    }
    return {
      analysis: analysis.data,
      createdAt: toDate(row.created_at),
      gmailMessageId: row.gmail_message_id,
      gmailThreadId: row.gmail_thread_id,
      googleConnectionId: row.google_connection_id,
      id: row.id,
      metadata: {
        model: row.model,
        promptVersion: row.prompt_version,
        schemaName: row.schema_name,
        schemaVersion: row.schema_version,
      },
      runId: row.run_id,
    };
  }
}

export class PostgresJobEmailReviewRequestRepository implements JobEmailReviewRequestRepository {
  constructor(private readonly database: Pick<DatabaseConnection, 'client'>) {}

  async createReviewRequest(input: {
    readonly agentId: string;
    readonly jobId: string;
    readonly reason: 'llm_invalid_output' | 'llm_refusal';
    readonly runId: string;
  }): Promise<void> {
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

function invalidPersistenceReference(message: string): AgentDependencyError {
  return new AgentDependencyError('INVALID_REQUEST', false, message);
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}
