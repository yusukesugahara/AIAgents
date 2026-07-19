import { relations, sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
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

export const connections = pgTable('connections', {
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
});

export const agentDefinitions = pgTable('agent_definitions', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  agentId: text('agent_id').notNull().unique(),
  manifestJson: jsonb('manifest_json').notNull().default(sql`'{}'::jsonb`),
  isEnabled: boolean('is_enabled').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const agentSettings = pgTable('agent_settings', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  agentId: text('agent_id').notNull(),
  enabled: boolean('enabled').notNull().default(true),
  settingsJson: jsonb('settings_json').notNull().default(sql`'{}'::jsonb`),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const agentJobs = pgTable(
  'agent_jobs',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    agentId: text('agent_id').notNull(),
    inputJson: jsonb('input_json').notNull(),
    status: jobStatus('status').notNull().default('queued'),
    idempotencyKey: text('idempotency_key').unique(),
    attempts: integer('attempts').notNull().default(0),
    availableAt: timestamp('available_at', { withTimezone: true }).notNull().defaultNow(),
    lockedAt: timestamp('locked_at', { withTimezone: true }),
    lockedBy: text('locked_by'),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (table) => [index('agent_jobs_status_available_at_idx').on(table.status, table.availableAt)],
);

export const agentRuns = pgTable('agent_runs', {
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
});

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

export const agentErrors = pgTable('agent_errors', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  runId: uuid('run_id').references(() => agentRuns.id, { onDelete: 'set null' }),
  jobId: uuid('job_id').references(() => agentJobs.id, { onDelete: 'set null' }),
  code: text('code').notNull(),
  message: text('message').notNull(),
  meta: jsonb('meta').notNull().default(sql`'{}'::jsonb`),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
});

export const reviewRequests = pgTable('review_requests', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  agentId: text('agent_id').notNull(),
  jobId: uuid('job_id').references(() => agentJobs.id, { onDelete: 'set null' }),
  status: text('status').notNull().default('pending'),
  reason: text('reason').notNull().default('manual'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
});

export const usersRelations = relations(users, ({ many }) => ({
  connections: many(connections),
}));

export const connectionsRelations = relations(connections, ({ one }) => ({
  user: one(users, {
    fields: [connections.userId],
    references: [users.id],
  }),
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
}));

export const agentRunStepsRelations = relations(agentRunSteps, ({ one }) => ({
  run: one(agentRuns, {
    fields: [agentRunSteps.runId],
    references: [agentRuns.id],
  }),
}));
