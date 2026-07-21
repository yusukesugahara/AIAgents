import type {
  AgentRun,
  AgentRunCompletion,
  AgentRunFailure,
  AgentRunHistoryRepository,
  AgentRunListOptions,
  AgentRunListPage,
  AgentRunRepository,
  AgentRunStart,
  AgentRunStep,
  AgentRunStepCompletion,
  AgentRunStepFailure,
  AgentRunStepRepository,
  AgentRunStepStart,
} from '@ai-agents/agent-core';
import type { DatabaseConnection } from './client';

interface AgentRunRow {
  id: string;
  job_id: string;
  agent_id: string;
  status: AgentRun['status'];
  trigger_type: string;
  error_code: string | null;
  output_json: unknown | null;
  started_at: Date | string;
  completed_at: Date | string | null;
}

interface AgentRunStepRow {
  id: string;
  run_id: string;
  sequence: number;
  step_name: string;
  status: AgentRunStep['status'];
  input_json: unknown;
  output_json: unknown | null;
  error_code: string | null;
  started_at: Date | string;
  completed_at: Date | string | null;
}

export class PostgresAgentRunRepository
  implements AgentRunRepository, AgentRunHistoryRepository, AgentRunStepRepository
{
  constructor(private readonly database: Pick<DatabaseConnection, 'client'>) {}

  async startRun(run: AgentRunStart): Promise<void> {
    await this.database.client`
      INSERT INTO agent_runs (id, job_id, agent_id, trigger_type, input_json, started_at)
      VALUES (
        ${run.runId}::uuid,
        ${run.jobId}::uuid,
        ${run.agentId},
        ${run.triggerType},
        ${JSON.stringify(run.input)}::jsonb,
        ${toTimestamp(run.startedAt)}
      )
    `;
  }

  async completeRun(run: AgentRunCompletion): Promise<void> {
    const [completed] = await this.database.client`
      UPDATE agent_runs
      SET status = 'completed', output_json = ${JSON.stringify(run.output)}::jsonb,
          completed_at = ${toTimestamp(run.completedAt)}
      WHERE id = ${run.runId}::uuid
        AND status = 'running'
      RETURNING id
    `;
    if (!completed) {
      throw new Error(`Agent Run "${run.runId}" is not running and cannot be completed`);
    }
  }

  async failRun(run: AgentRunFailure): Promise<void> {
    await this.database.client.begin(async (sql) => {
      const [failed] = await sql`
        UPDATE agent_runs
        SET status = 'failed', completed_at = ${toTimestamp(run.completedAt)}
        WHERE id = ${run.runId}::uuid
          AND status = 'running'
        RETURNING id
      `;
      if (!failed) {
        throw new Error(`Agent Run "${run.runId}" is not running and cannot be failed`);
      }
      await sql`
        INSERT INTO agent_errors (run_id, job_id, code, message, occurred_at)
        SELECT id, job_id, ${run.errorCode}, ${run.errorMessage}, ${toTimestamp(run.completedAt)}
        FROM agent_runs
        WHERE id = ${run.runId}::uuid
      `;
    });
  }

  async getRun(runId: string): Promise<AgentRun | null> {
    const [run] = (await this.database.client`
      SELECT
        runs.id, runs.job_id, runs.agent_id, runs.status, runs.trigger_type,
        errors.code AS error_code, runs.output_json, runs.started_at, runs.completed_at
      FROM agent_runs AS runs
      LEFT JOIN LATERAL (
        SELECT code FROM agent_errors
        WHERE run_id = runs.id
        ORDER BY occurred_at DESC
        LIMIT 1
      ) AS errors ON TRUE
      WHERE runs.id = ${runId}::uuid
    `) as AgentRunRow[];
    return run ? toAgentRun(run) : null;
  }

  async getLatestRunForJob(jobId: string): Promise<AgentRun | null> {
    const [run] = (await this.database.client`
      SELECT
        runs.id, runs.job_id, runs.agent_id, runs.status, runs.trigger_type,
        errors.code AS error_code, runs.output_json, runs.started_at, runs.completed_at
      FROM agent_runs AS runs
      LEFT JOIN LATERAL (
        SELECT code FROM agent_errors
        WHERE run_id = runs.id
        ORDER BY occurred_at DESC
        LIMIT 1
      ) AS errors ON TRUE
      WHERE runs.job_id = ${jobId}::uuid
      ORDER BY runs.started_at DESC, runs.id DESC
      LIMIT 1
    `) as AgentRunRow[];
    return run ? toAgentRun(run) : null;
  }

  async listRuns(options: AgentRunListOptions): Promise<AgentRunListPage> {
    assertListOptions(options);
    const rows = (await this.database.client`
      SELECT
        runs.id, runs.job_id, runs.agent_id, runs.status, runs.trigger_type,
        errors.code AS error_code, runs.output_json, runs.started_at, runs.completed_at
      FROM agent_runs AS runs
      LEFT JOIN LATERAL (
        SELECT code FROM agent_errors
        WHERE run_id = runs.id
        ORDER BY occurred_at DESC
        LIMIT 1
      ) AS errors ON TRUE
      ORDER BY runs.started_at DESC, runs.id DESC
      LIMIT ${options.limit + 1}
      OFFSET ${options.offset}
    `) as AgentRunRow[];
    return {
      hasMore: rows.length > options.limit,
      runs: rows.slice(0, options.limit).map(toAgentRun),
    };
  }

  async startStep(step: AgentRunStepStart): Promise<void> {
    await this.database.client`
      INSERT INTO agent_run_steps (run_id, sequence, step_name, status, input_json, started_at)
      VALUES (
        ${step.runId}::uuid, ${step.sequence}, ${step.stepName}, 'pending',
        ${JSON.stringify(step.input)}::jsonb, ${toTimestamp(step.startedAt)}
      )
    `;
  }

  async completeStep(step: AgentRunStepCompletion): Promise<void> {
    const [completed] = await this.database.client`
      UPDATE agent_run_steps
      SET status = 'succeeded', output_json = ${JSON.stringify(step.output)}::jsonb,
          completed_at = ${toTimestamp(step.completedAt)}
      WHERE run_id = ${step.runId}::uuid
        AND step_name = ${step.stepName}
        AND status = 'pending'
      RETURNING id
    `;
    if (!completed) {
      throw new Error(`Agent Run step "${step.stepName}" is not pending and cannot be completed`);
    }
  }

  async failStep(step: AgentRunStepFailure): Promise<void> {
    const [failed] = await this.database.client`
      UPDATE agent_run_steps
      SET status = 'failed', error_code = ${step.errorCode},
          output_json = ${JSON.stringify({ retryable: step.retryable })}::jsonb,
          completed_at = ${toTimestamp(step.completedAt)}
      WHERE run_id = ${step.runId}::uuid
        AND step_name = ${step.stepName}
        AND status = 'pending'
      RETURNING id
    `;
    if (!failed) {
      throw new Error(`Agent Run step "${step.stepName}" is not pending and cannot be failed`);
    }
  }

  async getSteps(runId: string): Promise<readonly AgentRunStep[]> {
    const steps = (await this.database.client`
      SELECT id, run_id, sequence, step_name, status, input_json, output_json, error_code,
             started_at, completed_at
      FROM agent_run_steps
      WHERE run_id = ${runId}::uuid
      ORDER BY sequence, id
    `) as AgentRunStepRow[];
    return steps.map(toAgentRunStep);
  }
}

function toAgentRun(row: AgentRunRow): AgentRun {
  return {
    id: row.id,
    jobId: row.job_id,
    agentId: row.agent_id,
    status: row.status,
    triggerType: row.trigger_type,
    errorCode: row.error_code,
    output: row.output_json,
    startedAt: toDate(row.started_at),
    completedAt: row.completed_at ? toDate(row.completed_at) : null,
  };
}

function toAgentRunStep(row: AgentRunStepRow): AgentRunStep {
  return {
    id: row.id,
    runId: row.run_id,
    sequence: row.sequence,
    stepName: row.step_name,
    status: row.status,
    input: row.input_json,
    output: row.output_json,
    errorCode: row.error_code,
    startedAt: toDate(row.started_at),
    completedAt: row.completed_at ? toDate(row.completed_at) : null,
  };
}

function toTimestamp(value: Date): string {
  return value.toISOString();
}

function assertListOptions(options: AgentRunListOptions): void {
  if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 100) {
    throw new Error('Agent Run list limit must be an integer between 1 and 100');
  }
  if (!Number.isSafeInteger(options.offset) || options.offset < 0) {
    throw new Error('Agent Run list offset must be a non-negative integer');
  }
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}
