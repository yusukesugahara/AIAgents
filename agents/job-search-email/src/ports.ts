import type { CreatedGmailDraft, GmailDraftWriter, GmailReader } from '@ai-agents/connector-google';
import type { LlmInvocationMetadata, LlmProvider } from '@ai-agents/llm';
import type { JobEmailAnalysis } from './schemas';

export interface JobEmailAnalysisRecord {
  readonly analysis: JobEmailAnalysis;
  readonly googleConnectionId: string;
  readonly gmailMessageId: string;
  readonly gmailThreadId: string;
  readonly metadata: Pick<
    LlmInvocationMetadata,
    'model' | 'promptVersion' | 'schemaName' | 'schemaVersion'
  >;
  readonly runId: string;
}

export interface StoredJobEmailAnalysis extends JobEmailAnalysisRecord {
  readonly createdAt: Date;
  readonly id: string;
}

export interface JobEmailAnalysisRepository {
  saveAnalysis(record: JobEmailAnalysisRecord): Promise<void>;
  getLatestByMessage(input: {
    readonly googleConnectionId: string;
    readonly gmailMessageId: string;
  }): Promise<StoredJobEmailAnalysis | null>;
}

export type JobEmailReviewReason =
  | 'llm_invalid_output'
  | 'llm_refusal'
  | 'reply_analysis_low_confidence'
  | 'reply_headers_invalid'
  | 'reply_information_missing'
  | 'reply_llm_invalid_output'
  | 'reply_llm_refusal'
  | 'reply_low_confidence'
  | 'reply_settings_missing'
  | 'reply_target_stale'
  | 'reply_warnings';

export interface JobEmailReviewRequestRepository {
  createReviewRequest(input: {
    readonly agentId: string;
    readonly jobId: string;
    readonly reason: JobEmailReviewReason;
    readonly runId: string;
  }): Promise<void>;
}

export interface JobEmailReplySettings {
  readonly createDrafts: boolean;
  readonly draftConfidenceThreshold: number;
  readonly emailSignature: string;
  readonly googleEmail: string;
  readonly userName: string | null;
}

export interface JobEmailSettingsRepository {
  getReplySettings(googleConnectionId: string): Promise<JobEmailReplySettings | null>;
}

export interface JobEmailDraftReservation {
  readonly draftId: string | null;
  readonly status: 'completed' | 'reserved';
}

export interface JobEmailDraftRepository {
  complete(input: {
    readonly gmailDraft: CreatedGmailDraft;
    readonly idempotencyKey: string;
    readonly jobId: string;
    readonly replyBodyHash: string;
    readonly runId: string;
  }): Promise<void>;
  reserve(input: {
    readonly googleConnectionId: string;
    readonly gmailMessageId: string;
    readonly gmailThreadId: string;
    readonly idempotencyKey: string;
    readonly jobId: string;
    readonly runId: string;
  }): Promise<JobEmailDraftReservation>;
}

export interface JobSearchEmailAgentDependencies {
  readonly analyses: JobEmailAnalysisRepository;
  readonly drafts: JobEmailDraftRepository;
  readonly gmailDrafts: GmailDraftWriter;
  readonly gmail: Pick<GmailReader, 'getMessage' | 'getThread'>;
  readonly llm: LlmProvider;
  readonly model: string;
  readonly replyModel: string;
  readonly reviews: JobEmailReviewRequestRepository;
  readonly settings: JobEmailSettingsRepository;
}
