import { relations, sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

export const jobStatus = pgEnum('job_status', [
  'queued',
  'processing',
  'retry_waiting',
  'needs_review',
  'completed',
  'failed',
]);

export const runStatus = pgEnum('agent_run_status', ['running', 'completed', 'failed']);

export const stepStatus = pgEnum('agent_run_step_status', ['pending', 'succeeded', 'failed']);

export const users = pgTable('users', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  email: text('email').notNull().unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const connections = pgTable(
  'connections',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    googleEmail: text('google_email').notNull(),
    encryptedRefreshToken: text('encrypted_refresh_token'),
    grantedScopes: text('granted_scopes').array(),
    status: text('status').notNull().default('connected'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('connections_user_id_type_google_email_unique').on(
      table.userId,
      table.type,
      table.googleEmail,
    ),
  ],
);

export const oauthAuthorizationStates = pgTable(
  'oauth_authorization_states',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    stateHash: text('state_hash').notNull().unique(),
    browserNonceHash: text('browser_nonce_hash').notNull(),
    encryptedCodeVerifier: text('encrypted_code_verifier').notNull(),
    authorizationPurpose: text('authorization_purpose').notNull().default('gmail_read'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('oauth_authorization_states_expires_at_idx').on(table.expiresAt)],
);

export const agentDefinitions = pgTable('agent_definitions', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  agentId: text('agent_id').notNull().unique(),
  manifestJson: jsonb('manifest_json').notNull().default(sql`'{}'::jsonb`),
  isEnabled: boolean('is_enabled').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const agentSettings = pgTable(
  'agent_settings',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    agentId: text('agent_id').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    settingsJson: jsonb('settings_json').notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('agent_settings_user_id_agent_id_unique').on(table.userId, table.agentId),
  ],
);

export const agentJobs = pgTable(
  'agent_jobs',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    agentId: text('agent_id').notNull(),
    inputJson: jsonb('input_json').notNull(),
    triggerType: text('trigger_type').notNull().default('manual'),
    status: jobStatus('status').notNull().default('queued'),
    idempotencyKey: text('idempotency_key'),
    attempts: integer('attempts').notNull().default(0),
    availableAt: timestamp('available_at', { withTimezone: true }).notNull().defaultNow(),
    requestedAvailableAt: timestamp('requested_available_at', { withTimezone: true }),
    lockedAt: timestamp('locked_at', { withTimezone: true }),
    lockedBy: text('locked_by'),
    lastErrorCode: text('last_error_code'),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (table) => [
    index('agent_jobs_status_available_at_idx').on(table.status, table.availableAt),
    uniqueIndex('agent_jobs_agent_id_idempotency_key_unique').on(
      table.agentId,
      table.idempotencyKey,
    ),
  ],
);

export const agentRuns = pgTable(
  'agent_runs',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    agentId: text('agent_id').notNull(),
    jobId: uuid('job_id')
      .notNull()
      .references(() => agentJobs.id, { onDelete: 'cascade' }),
    status: runStatus('status').notNull().default('running'),
    triggerType: text('trigger_type').notNull(),
    inputJson: jsonb('input_json').notNull(),
    outputJson: jsonb('output_json'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (table) => [index('agent_runs_job_id_started_at_idx').on(table.jobId, table.startedAt)],
);

export const agentRunSteps = pgTable('agent_run_steps', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  runId: uuid('run_id')
    .notNull()
    .references(() => agentRuns.id, { onDelete: 'cascade' }),
  stepName: text('step_name').notNull(),
  status: stepStatus('status').notNull().default('pending'),
  inputJson: jsonb('input_json').notNull(),
  outputJson: jsonb('output_json'),
  errorCode: text('error_code'),
  errorMessage: text('error_message'),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
});

export const llmInvocations = pgTable(
  'llm_invocations',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    runId: uuid('run_id')
      .notNull()
      .references(() => agentRuns.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    promptVersion: text('prompt_version').notNull(),
    schemaName: text('schema_name').notNull(),
    schemaVersion: text('schema_version').notNull(),
    attempt: integer('attempt').notNull(),
    outcome: text('outcome').notNull(),
    reviewReason: text('review_reason'),
    inputTokens: integer('input_tokens').notNull(),
    outputTokens: integer('output_tokens').notNull(),
    totalTokens: integer('total_tokens').notNull(),
    estimatedCostUsd: numeric('estimated_cost_usd', { precision: 12, scale: 8 }),
    durationMs: integer('duration_ms').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('llm_invocations_run_id_created_at_idx').on(table.runId, table.createdAt)],
);

export const agentErrors = pgTable(
  'agent_errors',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    runId: uuid('run_id').references(() => agentRuns.id, { onDelete: 'set null' }),
    jobId: uuid('job_id').references(() => agentJobs.id, { onDelete: 'set null' }),
    code: text('code').notNull(),
    message: text('message').notNull(),
    meta: jsonb('meta').notNull().default(sql`'{}'::jsonb`),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('agent_errors_run_id_occurred_at_idx').on(table.runId, table.occurredAt)],
);

export const reviewRequests = pgTable(
  'review_requests',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    agentId: text('agent_id').notNull(),
    jobId: uuid('job_id').references(() => agentJobs.id, { onDelete: 'set null' }),
    runId: uuid('run_id').references(() => agentRuns.id, { onDelete: 'cascade' }),
    status: text('status').notNull().default('pending'),
    reason: text('reason').notNull().default('manual'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
  },
  (table) => [uniqueIndex('review_requests_run_id_unique').on(table.runId)],
);

export const jobEmailAnalyses = pgTable(
  'job_email_analyses',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    runId: uuid('run_id')
      .notNull()
      .references(() => agentRuns.id, { onDelete: 'cascade' }),
    googleConnectionId: uuid('google_connection_id')
      .notNull()
      .references(() => connections.id, { onDelete: 'cascade' }),
    gmailMessageId: text('gmail_message_id').notNull(),
    gmailThreadId: text('gmail_thread_id').notNull(),
    isJobRelated: boolean('is_job_related').notNull(),
    category: text('category').notNull(),
    needsReply: boolean('needs_reply').notNull(),
    replyIntent: text('reply_intent').notNull(),
    companyName: text('company_name'),
    contactName: text('contact_name'),
    meetingIsConfirmed: boolean('meeting_is_confirmed').notNull(),
    meetingStartAt: timestamp('meeting_start_at', { withTimezone: true }),
    meetingEndAt: timestamp('meeting_end_at', { withTimezone: true }),
    meetingTimezone: text('meeting_timezone'),
    meetingUrl: text('meeting_url'),
    meetingUrlType: text('meeting_url_type').notNull(),
    confidence: numeric('confidence', { precision: 5, scale: 4 }).notNull(),
    analysisJson: jsonb('analysis_json').notNull(),
    model: text('model').notNull(),
    promptVersion: text('prompt_version').notNull(),
    schemaName: text('schema_name').notNull(),
    schemaVersion: text('schema_version').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('job_email_analyses_run_id_unique').on(table.runId),
    index('job_email_analyses_connection_message_created_idx').on(
      table.googleConnectionId,
      table.gmailMessageId,
      table.createdAt,
    ),
    check(
      'job_email_analyses_category_check',
      sql`${table.category} IN ('meeting_confirmed', 'scheduling_request', 'application_update', 'document_request', 'assignment', 'offer', 'rejection', 'general', 'not_job_related')`,
    ),
    check(
      'job_email_analyses_reply_intent_check',
      sql`${table.replyIntent} IN ('accept', 'decline', 'acknowledge', 'submit_information', 'request_clarification', 'none')`,
    ),
    check(
      'job_email_analyses_url_type_check',
      sql`${table.meetingUrlType} IN ('web_meeting', 'scheduling_page', 'other', 'none')`,
    ),
    check(
      'job_email_analyses_confidence_check',
      sql`${table.confidence} >= 0 AND ${table.confidence} <= 1`,
    ),
    check(
      'job_email_analyses_job_category_check',
      sql`${table.isJobRelated} = (${table.category} <> 'not_job_related')`,
    ),
    check(
      'job_email_analyses_reply_required_check',
      sql`${table.needsReply} = (${table.replyIntent} <> 'none')`,
    ),
    check(
      'job_email_analyses_confirmed_category_check',
      sql`${table.meetingIsConfirmed} = (${table.category} = 'meeting_confirmed')`,
    ),
    check(
      'job_email_analyses_meeting_range_check',
      sql`${table.meetingEndAt} IS NULL OR (${table.meetingStartAt} IS NOT NULL AND ${table.meetingEndAt} > ${table.meetingStartAt})`,
    ),
    check(
      'job_email_analyses_meeting_timezone_check',
      sql`(${table.meetingStartAt} IS NULL) = (${table.meetingTimezone} IS NULL)`,
    ),
    check(
      'job_email_analyses_meeting_url_check',
      sql`(${table.meetingUrl} IS NULL) = (${table.meetingUrlType} = 'none')`,
    ),
  ],
);

export const jobEmailDrafts = pgTable(
  'job_email_drafts',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    googleConnectionId: uuid('google_connection_id')
      .notNull()
      .references(() => connections.id, { onDelete: 'cascade' }),
    gmailMessageId: text('gmail_message_id').notNull(),
    gmailThreadId: text('gmail_thread_id').notNull(),
    jobId: uuid('job_id')
      .notNull()
      .references(() => agentJobs.id, { onDelete: 'cascade' }),
    runId: uuid('run_id')
      .notNull()
      .references(() => agentRuns.id, { onDelete: 'cascade' }),
    status: text('status').notNull().default('creating'),
    idempotencyKey: text('idempotency_key').notNull(),
    gmailDraftId: text('gmail_draft_id'),
    gmailDraftMessageId: text('gmail_draft_message_id'),
    replyBodyHash: text('reply_body_hash'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('job_email_drafts_connection_message_unique').on(
      table.googleConnectionId,
      table.gmailMessageId,
    ),
    uniqueIndex('job_email_drafts_idempotency_key_unique').on(table.idempotencyKey),
    uniqueIndex('job_email_drafts_gmail_draft_id_unique').on(table.gmailDraftId),
    check('job_email_drafts_status_check', sql`${table.status} IN ('creating', 'completed')`),
  ],
);

export const usersRelations = relations(users, ({ many }) => ({
  connections: many(connections),
}));

export const connectionsRelations = relations(connections, ({ one, many }) => ({
  user: one(users, {
    fields: [connections.userId],
    references: [users.id],
  }),
  jobEmailAnalyses: many(jobEmailAnalyses),
  jobEmailDrafts: many(jobEmailDrafts),
}));

export const agentJobsRelations = relations(agentJobs, ({ many }) => ({
  runs: many(agentRuns),
}));

export const agentRunsRelations = relations(agentRuns, ({ one, many }) => ({
  job: one(agentJobs, {
    fields: [agentRuns.jobId],
    references: [agentJobs.id],
  }),
  steps: many(agentRunSteps),
  llmInvocations: many(llmInvocations),
  jobEmailAnalyses: many(jobEmailAnalyses),
  reviewRequests: many(reviewRequests),
  jobEmailDrafts: many(jobEmailDrafts),
}));

export const agentRunStepsRelations = relations(agentRunSteps, ({ one }) => ({
  run: one(agentRuns, {
    fields: [agentRunSteps.runId],
    references: [agentRuns.id],
  }),
}));

export const llmInvocationsRelations = relations(llmInvocations, ({ one }) => ({
  run: one(agentRuns, {
    fields: [llmInvocations.runId],
    references: [agentRuns.id],
  }),
}));

export const jobEmailAnalysesRelations = relations(jobEmailAnalyses, ({ one }) => ({
  connection: one(connections, {
    fields: [jobEmailAnalyses.googleConnectionId],
    references: [connections.id],
  }),
  run: one(agentRuns, {
    fields: [jobEmailAnalyses.runId],
    references: [agentRuns.id],
  }),
}));

export const jobEmailDraftsRelations = relations(jobEmailDrafts, ({ one }) => ({
  connection: one(connections, {
    fields: [jobEmailDrafts.googleConnectionId],
    references: [connections.id],
  }),
  run: one(agentRuns, { fields: [jobEmailDrafts.runId], references: [agentRuns.id] }),
}));

export const reviewRequestsRelations = relations(reviewRequests, ({ one }) => ({
  run: one(agentRuns, {
    fields: [reviewRequests.runId],
    references: [agentRuns.id],
  }),
}));
