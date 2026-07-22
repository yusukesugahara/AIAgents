import type { AgentContext, AgentRunStepRepository } from '@ai-agents/agent-core';
import type {
  CreatedGmailDraft,
  CreatedGoogleCalendarEvent,
  EmailMessage,
  EmailThread,
  GmailDraftWriter,
  GmailReader,
  GoogleCalendarClient,
} from '@ai-agents/connector-google';
import type { LlmInvocationMetadata } from '@ai-agents/llm';
import { FakeLlmProvider } from '@ai-agents/testing';
import type {
  JobEmailAnalysisRecord,
  JobEmailAnalysisRepository,
  JobEmailCalendarEventRepository,
  JobEmailCalendarSettings,
  JobEmailDraftRepository,
  JobEmailReplySettings,
  JobEmailReviewRequestRepository,
  JobEmailSettingsRepository,
  StoredJobEmailAnalysis,
} from './ports';
import {
  jobEmailAnalysisPromptVersion,
  jobEmailAnalysisSchemaName,
  jobEmailAnalysisSchemaVersion,
} from './prompt';
import type { JobEmailAnalysis } from './schemas';

export const connectionId = '0198d171-8d5f-7b1a-8812-0123456789ab';

export const metadata: LlmInvocationMetadata = {
  attempts: 1,
  durationMs: 10,
  estimatedCostUsd: 0.001,
  model: 'test-model',
  promptVersion: jobEmailAnalysisPromptVersion,
  schemaName: jobEmailAnalysisSchemaName,
  schemaVersion: jobEmailAnalysisSchemaVersion,
  usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
};

export function analysis(overrides: Partial<JobEmailAnalysis> = {}): JobEmailAnalysis {
  return {
    isJobRelated: true,
    category: 'application_update',
    companyName: 'Example株式会社',
    contactName: '採用担当者',
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
    confidence: 0.95,
    evidence: ['選考結果をご案内します'],
    ...overrides,
  };
}

export function message(
  id = 'message-1',
  threadId = 'thread-1',
  bodyText = 'Example株式会社 採用担当者より、選考結果をご案内します。面談は2026年7月21日 10:00〜11:00、URL: https://meet.example.com/interview',
  sentAt = new Date('2026-07-19T01:00:00.000Z'),
): EmailMessage {
  return {
    id,
    threadId,
    labelIds: ['INBOX'],
    from: '採用担当 <recruiter@example.com>',
    to: ['candidate@example.com'],
    cc: [],
    subject: '選考のご案内',
    sentAt,
    messageId: `<${id}@example.com>`,
    inReplyTo: null,
    replyTo: null,
    references: [],
    bodyText,
    bodyTruncated: false,
  };
}

export class FakeGmailReader implements Pick<GmailReader, 'getMessage' | 'getThread'> {
  readonly requests: unknown[] = [];
  private threadReads = 0;

  constructor(
    readonly emailMessage: EmailMessage,
    readonly emailThread: EmailThread,
    readonly refreshedEmailThread?: EmailThread,
  ) {}

  async getMessage(input: unknown): Promise<EmailMessage> {
    this.requests.push(input);
    return this.emailMessage;
  }

  async getThread(input: unknown): Promise<EmailThread> {
    this.requests.push(input);
    const thread =
      this.threadReads > 0 && this.refreshedEmailThread
        ? this.refreshedEmailThread
        : this.emailThread;
    this.threadReads += 1;
    return thread;
  }
}

class FakeAnalysisRepository implements JobEmailAnalysisRepository {
  readonly saved: JobEmailAnalysisRecord[] = [];
  error: Error | undefined;

  async saveAnalysis(record: JobEmailAnalysisRecord): Promise<void> {
    if (this.error) throw this.error;
    this.saved.push(record);
  }

  async getLatestByMessage(): Promise<StoredJobEmailAnalysis | null> {
    const record = this.saved.at(-1);
    return record
      ? { ...record, createdAt: new Date('2026-07-20T00:00:00.000Z'), id: 'analysis-1' }
      : null;
  }
}

class FakeReviewRepository implements JobEmailReviewRequestRepository {
  readonly saved: Parameters<JobEmailReviewRequestRepository['createReviewRequest']>[0][] = [];

  async createReviewRequest(
    input: Parameters<JobEmailReviewRequestRepository['createReviewRequest']>[0],
  ): Promise<void> {
    this.saved.push(input);
  }
}

export class FakeStepRepository implements AgentRunStepRepository {
  readonly completed: Parameters<AgentRunStepRepository['completeStep']>[0][] = [];
  readonly failed: Parameters<AgentRunStepRepository['failStep']>[0][] = [];
  readonly started: Parameters<AgentRunStepRepository['startStep']>[0][] = [];

  async completeStep(input: Parameters<AgentRunStepRepository['completeStep']>[0]): Promise<void> {
    this.completed.push(input);
  }

  async failStep(input: Parameters<AgentRunStepRepository['failStep']>[0]): Promise<void> {
    this.failed.push(input);
  }

  async getSteps(): Promise<[]> {
    return [];
  }

  async startStep(input: Parameters<AgentRunStepRepository['startStep']>[0]): Promise<void> {
    this.started.push(input);
  }
}

export class FakeReplySettingsRepository implements JobEmailSettingsRepository {
  calls: string[] = [];

  constructor(
    private readonly settings: JobEmailReplySettings | null = {
      createDrafts: true,
      draftConfidenceThreshold: 0.85,
      emailSignature: '山田 太郎',
      googleEmail: 'candidate@example.com',
      userName: '山田 太郎',
    },
  ) {}

  async getReplySettings(googleConnectionId: string): Promise<JobEmailReplySettings | null> {
    this.calls.push(googleConnectionId);
    return this.settings;
  }

  async getCalendarSettings(_googleConnectionId: string): Promise<JobEmailCalendarSettings | null> {
    return {
      calendarConfidenceThreshold: 0.9,
      createCalendarEvents: true,
      timezone: 'Asia/Tokyo',
    };
  }
}

export class FakeCalendarEventRepository implements JobEmailCalendarEventRepository {
  readonly completed: Parameters<JobEmailCalendarEventRepository['complete']>[0][] = [];
  readonly reservations: Parameters<JobEmailCalendarEventRepository['reserve']>[0][] = [];
  error: Error | undefined;
  reservation: Awaited<ReturnType<JobEmailCalendarEventRepository['reserve']>> = {
    eventId: null,
    status: 'reserved',
  };

  async complete(input: Parameters<JobEmailCalendarEventRepository['complete']>[0]): Promise<void> {
    if (this.error) throw this.error;
    this.completed.push(input);
  }

  async reserve(
    input: Parameters<JobEmailCalendarEventRepository['reserve']>[0],
  ): Promise<Awaited<ReturnType<JobEmailCalendarEventRepository['reserve']>>> {
    this.reservations.push(input);
    return this.reservation;
  }
}

export class FakeGoogleCalendar implements GoogleCalendarClient {
  readonly created: Parameters<GoogleCalendarClient['createEvent']>[0][] = [];
  readonly conflicts: Parameters<GoogleCalendarClient['findConflictingEvents']>[0][] = [];
  existing: CreatedGoogleCalendarEvent | null = null;
  error: Error | undefined;
  hasConflict = false;

  async createEvent(
    input: Parameters<GoogleCalendarClient['createEvent']>[0],
  ): Promise<CreatedGoogleCalendarEvent> {
    this.created.push(input);
    this.existing = { eventId: input.eventId };
    return this.existing;
  }

  async findConflictingEvents(input: Parameters<GoogleCalendarClient['findConflictingEvents']>[0]) {
    if (this.error) throw this.error;
    this.conflicts.push(input);
    return this.hasConflict ? [{ eventId: 'other-event' }] : [];
  }

  async findEvent(): Promise<CreatedGoogleCalendarEvent | null> {
    if (this.error) throw this.error;
    return this.existing;
  }
}

export class FakeDraftRepository implements JobEmailDraftRepository {
  completed: Parameters<JobEmailDraftRepository['complete']>[0][] = [];
  reopened: Parameters<JobEmailDraftRepository['reopen']>[0][] = [];
  reservations: Parameters<JobEmailDraftRepository['reserve']>[0][] = [];
  reservation: Awaited<ReturnType<JobEmailDraftRepository['reserve']>> = {
    draftId: null,
    status: 'reserved',
  };

  async complete(input: Parameters<JobEmailDraftRepository['complete']>[0]): Promise<void> {
    this.completed.push(input);
  }

  async reserve(
    input: Parameters<JobEmailDraftRepository['reserve']>[0],
  ): Promise<Awaited<ReturnType<JobEmailDraftRepository['reserve']>>> {
    this.reservations.push(input);
    return this.reservation;
  }

  async reopen(input: Parameters<JobEmailDraftRepository['reopen']>[0]): Promise<void> {
    this.reopened.push(input);
  }
}

export class FakeGmailDraftWriter implements GmailDraftWriter {
  created: Parameters<GmailDraftWriter['createReplyDraft']>[0][] = [];
  found: Parameters<GmailDraftWriter['findReplyDraft']>[0][] = [];
  existing: CreatedGmailDraft | null = null;

  async createReplyDraft(
    input: Parameters<GmailDraftWriter['createReplyDraft']>[0],
  ): Promise<CreatedGmailDraft> {
    this.created.push(input);
    return { draftId: 'draft-1', messageId: 'draft-message-1', threadId: input.gmailThreadId };
  }

  async findReplyDraft(
    input: Parameters<GmailDraftWriter['findReplyDraft']>[0],
  ): Promise<CreatedGmailDraft | null> {
    this.found.push(input);
    return this.existing;
  }
}

export function context(): AgentContext {
  return {
    agentId: 'job-search-email',
    jobId: '0198d171-8d5f-7b1a-8812-0123456789ac',
    runId: '0198d171-8d5f-7b1a-8812-0123456789ad',
    signal: new AbortController().signal,
    startedAt: new Date('2026-07-19T01:00:00.000Z'),
    triggerType: 'manual',
  };
}

export function createDependencies(result: JobEmailAnalysis = analysis()) {
  const emailMessage = message();
  const gmail = new FakeGmailReader(emailMessage, { id: 'thread-1', messages: [emailMessage] });
  const analyses = new FakeAnalysisRepository();
  const calendar = new FakeGoogleCalendar();
  const calendarEvents = new FakeCalendarEventRepository();
  const drafts = new FakeDraftRepository();
  const gmailDrafts = new FakeGmailDraftWriter();
  const reviews = new FakeReviewRepository();
  const llm = new FakeLlmProvider([{ data: result, metadata, status: 'completed' }]);
  const settings = new FakeReplySettingsRepository();
  return {
    analyses,
    calendar,
    calendarEvents,
    drafts,
    gmail,
    gmailDrafts,
    llm,
    model: 'test-model',
    replyModel: 'test-reply-model',
    reviews,
    settings,
  };
}
