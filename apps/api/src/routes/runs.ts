import type { JobQueue } from '@ai-agents/agent-core';
import type { Hono } from 'hono';
import { z } from 'zod';
import {
  type ApiAppOptions,
  type ApiEnvironment,
  ApiError,
  type ApiRunRepository,
} from '../api-types';
import { toJobResponse, toRunResponse } from '../presenters';

const jobIdSchema = z.uuid();

export function registerRunRoutes(app: Hono<ApiEnvironment>, options: ApiAppOptions): void {
  app.get('/jobs/:jobId', async (context) => {
    const jobId = parseId(context.req.param('jobId'));
    const job = await requireQueue(options).get(jobId);
    if (!job) throw new ApiError('JOB_NOT_FOUND', 404, `Job "${jobId}" was not found`);
    const runs = requireRunRepository(options);
    const latestRun = await runs.getLatestRunForJob(jobId);
    const steps = latestRun && runs.getSteps ? await runs.getSteps(latestRun.id) : [];
    return context.json({ job: toJobResponse(job, latestRun, steps) });
  });
  app.get('/runs/:runId', async (context) => {
    const runId = parseId(context.req.param('runId'));
    const runs = requireRunRepository(options);
    const run = await runs.getRun(runId);
    if (!run) throw new ApiError('RUN_NOT_FOUND', 404, `Run "${runId}" was not found`);
    const steps = runs.getSteps ? await runs.getSteps(runId) : [];
    return context.json({ run: toRunResponse(run, steps) });
  });
}

function requireQueue(options: ApiAppOptions): JobQueue {
  if (!options.queue) throw new ApiError('INTERNAL_ERROR', 500, 'Job Queue is not configured');
  return options.queue;
}

function requireRunRepository(options: ApiAppOptions): ApiRunRepository {
  if (!options.runs) throw new ApiError('INTERNAL_ERROR', 500, 'Run Repository is not configured');
  return options.runs;
}

function parseId(value: string): string {
  const parsed = jobIdSchema.safeParse(value);
  if (!parsed.success) throw new ApiError('BAD_REQUEST', 400, 'ID must be a valid UUID');
  return parsed.data;
}
