import { describe, expect, test } from 'bun:test';
import {
  createConfiguredApp,
  createJob,
  FakeJobQueue,
  FakeRunRepository,
  jobId,
  now,
  runId,
} from './app.test-support';

describe('API Run routes', () => {
  test('returns Job metadata and keeps non-Job-Search Run output private', async () => {
    const queue = new FakeJobQueue();
    queue.jobs.set(jobId, createJob({ status: 'completed', attempts: 1, completedAt: now }));
    const runs = new FakeRunRepository();
    runs.runs.set(runId, {
      id: runId,
      jobId,
      agentId: 'echo',
      status: 'completed',
      triggerType: 'queue',
      errorCode: null,
      startedAt: now,
      completedAt: now,
    });
    const app = createConfiguredApp({ queue, runs });

    const jobResponse = await app.request(`/jobs/${jobId}`);
    const runResponse = await app.request(`/runs/${runId}`);

    expect(await jobResponse.json()).toEqual({
      job: {
        id: jobId,
        agentId: 'echo',
        status: 'completed',
        attempts: 1,
        availableAt: '2026-07-19T00:00:00.000Z',
        createdAt: '2026-07-19T00:00:00.000Z',
        completedAt: '2026-07-19T00:00:00.000Z',
        errorCode: null,
        hasError: false,
        latestRun: {
          agentId: 'echo',
          completedAt: '2026-07-19T00:00:00.000Z',
          errorCode: null,
          id: runId,
          jobId,
          output: null,
          startedAt: '2026-07-19T00:00:00.000Z',
          status: 'completed',
          steps: [],
          triggerType: 'queue',
        },
        latestRunId: runId,
      },
    });
    expect(await runResponse.json()).toEqual({
      run: {
        id: runId,
        jobId,
        agentId: 'echo',
        status: 'completed',
        triggerType: 'queue',
        errorCode: null,
        startedAt: '2026-07-19T00:00:00.000Z',
        completedAt: '2026-07-19T00:00:00.000Z',
        output: null,
        steps: [],
      },
    });
  });

  test('returns safe Job Search Email Run output and step state without stored inputs', async () => {
    const queue = new FakeJobQueue();
    queue.jobs.set(jobId, createJob({ agentId: 'job-search-email', status: 'completed' }));
    const runs = new FakeRunRepository();
    runs.runs.set(runId, {
      agentId: 'job-search-email',
      completedAt: now,
      errorCode: null,
      id: runId,
      jobId,
      output: {
        analysis: { evidence: ['private email excerpt'] },
        calendarEventId: 'calendar-event-1',
        draftId: 'draft-1',
        result: 'completed',
      },
      startedAt: now,
      status: 'completed',
      triggerType: 'manual',
    });
    runs.steps.set(runId, [
      {
        completedAt: now,
        errorCode: null,
        id: '0198be1d-a3a9-7d34-9bc3-123456789abe',
        input: { body: 'private Gmail content' },
        output: {
          draftId: 'draft-1',
          recipient: 'private@example.com',
          toolCallCount: 1,
          toolNames: ['create_reply_draft'],
          writeStatus: 'created',
        },
        runId,
        sequence: 50,
        startedAt: now,
        status: 'succeeded',
        stepName: 'CREATE_DRAFT',
      },
      {
        completedAt: now,
        errorCode: 'RATE_LIMITED',
        id: '0198be1d-a3a9-7d34-9bc3-123456789abf',
        input: { prompt: 'private prompt' },
        output: {
          draftId: { secret: 'private nested detail' },
          providerDetail: 'private detail',
          retryable: true,
          toolNames: ['send_email'],
        },
        runId,
        sequence: 20,
        startedAt: now,
        status: 'failed',
        stepName: 'ANALYZE_EMAIL',
      },
    ]);
    const app = createConfiguredApp({ queue, runs });
    const response = await app.request(`/runs/${runId}`);
    const body = await response.json();

    expect(body).toMatchObject({
      run: {
        output: {
          calendarEventId: 'calendar-event-1',
          draftId: 'draft-1',
          result: 'completed',
        },
        steps: [
          {
            errorCode: 'RATE_LIMITED',
            output: { retryable: true },
            sequence: 20,
            status: 'failed',
            stepName: 'ANALYZE_EMAIL',
          },
          {
            errorCode: null,
            output: {
              draftId: 'draft-1',
              toolCallCount: 1,
              toolNames: ['create_reply_draft'],
              writeStatus: 'created',
            },
            sequence: 50,
            status: 'succeeded',
            stepName: 'CREATE_DRAFT',
          },
        ],
      },
    });
    expect(JSON.stringify(body)).not.toContain('private');
    expect(JSON.stringify(body)).not.toContain('send_email');

    const jobResponse = await app.request(`/jobs/${jobId}`);
    const jobBody = await jobResponse.json();
    expect(jobBody).toMatchObject({
      job: {
        latestRun: {
          output: {
            calendarEventId: 'calendar-event-1',
            draftId: 'draft-1',
            result: 'completed',
          },
          steps: body.run.steps,
        },
        latestRunId: runId,
      },
    });
    expect(JSON.stringify(jobBody)).not.toContain('private');
  });

  test('exposes a Job error code without exposing its error message', async () => {
    const queue = new FakeJobQueue();
    queue.jobs.set(
      jobId,
      createJob({
        status: 'failed',
        lastErrorCode: 'AGENT_EXECUTION_FAILED',
        lastError: 'sensitive adapter detail',
      }),
    );
    const app = createConfiguredApp({ queue });

    const response = await app.request(`/jobs/${jobId}`);
    const body = await response.json();

    expect(body).toMatchObject({
      job: { errorCode: 'AGENT_EXECUTION_FAILED', hasError: true },
    });
    expect(JSON.stringify(body)).not.toContain('sensitive adapter detail');
  });

  test('reports migrated Job errors even when a legacy error code is unavailable', async () => {
    const queue = new FakeJobQueue();
    queue.jobs.set(
      jobId,
      createJob({ status: 'failed', lastErrorCode: null, lastError: 'legacy failure detail' }),
    );
    const app = createConfiguredApp({ queue });

    const response = await app.request(`/jobs/${jobId}`);
    const body = await response.json();

    expect(body).toMatchObject({ job: { errorCode: null, hasError: true } });
    expect(JSON.stringify(body)).not.toContain('legacy failure detail');
  });
});
