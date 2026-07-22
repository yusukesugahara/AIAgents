import type { Context, Hono } from 'hono';
import { z } from 'zod';
import { type ApiAppOptions, type ApiEnvironment, ApiError } from '../api-types';
import { toRunHistoryResponse } from '../presenters';
import { renderRunHistoryDetail, renderRunHistoryList } from '../run-history-view';

const runIdSchema = z.uuid();
const pageSchema = z.coerce.number().int().min(1).max(10_000);
const pageSize = 25;

export function registerRunHistoryRoutes(app: Hono<ApiEnvironment>, options: ApiAppOptions): void {
  app.get('/history', async (context) => {
    const page = parsePage(context.req.query('page'));
    const history = requireRunRepository(options);
    const result = await history.listRuns({
      limit: pageSize,
      offset: (page - 1) * pageSize,
    });
    setHistoryHeaders(context);
    return context.html(
      renderRunHistoryList({
        hasMore: result.hasMore,
        page,
        runs: result.runs.map((run) => toRunHistoryResponse(run)),
      }),
    );
  });

  app.get('/history/runs/:runId', async (context) => {
    const runId = parseRunId(context.req.param('runId'));
    const runs = requireRunRepository(options);
    const run = await runs.getRun(runId);
    if (!run) throw new ApiError('RUN_NOT_FOUND', 404, `Run "${runId}" was not found`);
    const steps = runs.getSteps ? await runs.getSteps(runId) : [];
    setHistoryHeaders(context);
    return context.html(renderRunHistoryDetail(toRunHistoryResponse(run, steps)));
  });
}

function requireRunRepository(options: ApiAppOptions) {
  if (!options.runs) throw new ApiError('INTERNAL_ERROR', 500, 'Run Repository is not configured');
  return options.runs;
}

function parsePage(value: string | undefined): number {
  if (value === undefined || value === '') return 1;
  const parsed = pageSchema.safeParse(value);
  if (!parsed.success)
    throw new ApiError('BAD_REQUEST', 400, 'page must be an integer from 1 to 10000');
  return parsed.data;
}

function parseRunId(value: string): string {
  const parsed = runIdSchema.safeParse(value);
  if (!parsed.success) throw new ApiError('BAD_REQUEST', 400, 'ID must be a valid UUID');
  return parsed.data;
}

function setHistoryHeaders(context: Context<ApiEnvironment>): void {
  context.header('Cache-Control', 'no-store');
  context.header(
    'Content-Security-Policy',
    "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  );
  context.header('Referrer-Policy', 'no-referrer');
  context.header('X-Content-Type-Options', 'nosniff');
}
