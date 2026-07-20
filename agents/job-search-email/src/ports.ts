import type { GmailReader } from '@ai-agents/connector-google';
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

export type JobEmailReviewReason = 'llm_invalid_output' | 'llm_refusal';

export interface JobEmailReviewRequestRepository {
  createReviewRequest(input: {
    readonly agentId: string;
    readonly jobId: string;
    readonly reason: JobEmailReviewReason;
    readonly runId: string;
  }): Promise<void>;
}

export interface JobSearchEmailAgentDependencies {
  readonly analyses: JobEmailAnalysisRepository;
  readonly gmail: Pick<GmailReader, 'getMessage' | 'getThread'>;
  readonly llm: LlmProvider;
  readonly model: string;
  readonly reviews: JobEmailReviewRequestRepository;
}
