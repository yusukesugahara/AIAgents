import { describe, expect, test } from 'bun:test';
import { createApp } from './app';
import { createConfiguredApp, FakeRunRepository, jobId, now, runId } from './app.test-support';

describe('Run history Web routes', () => {
  test('renders recent Runs without exposing stored output fields', async () => {
    const runs = new FakeRunRepository();
    runs.runs.set(runId, {
      agentId: 'job-search-email',
      completedAt: new Date(now.getTime() + 2_500),
      emailSubject: '面談日程について',
      errorCode: null,
      id: runId,
      jobId,
      output: {
        analysis: { evidence: ['private email excerpt'] },
        calendarEventId: 'calendar-event-1',
        draftId: '<script>alert(1)</script>',
        result: 'completed',
      },
      startedAt: now,
      status: 'completed',
      triggerType: 'manual',
    });
    const app = createConfiguredApp({ runs });

    const response = await app.request('/history');
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toContain('text/html');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('Content-Security-Policy')).toContain("default-src 'none'");
    expect(body).toContain('実行履歴');
    expect(body).toContain(`/history/runs/${runId}`);
    expect(body).toContain('完了');
    expect(body).toContain('面談日程について');
    expect(body).not.toContain('private email excerpt');
    expect(body).not.toContain('<script>alert(1)</script>');
  });

  test('renders safe Run details and Step outputs', async () => {
    const runs = new FakeRunRepository();
    runs.runs.set(runId, {
      agentId: 'job-search-email',
      completedAt: now,
      errorCode: 'INVALID_RESPONSE',
      errorMessage: 'Gmail returned inconsistent message and thread data',
      emailSubject: 'Interview &lt;script&gt;',
      id: runId,
      jobId,
      output: { calendarEventId: null, draftId: null, result: 'needs_review' },
      startedAt: now,
      status: 'completed',
      triggerType: 'manual',
    });
    runs.steps.set(runId, [
      {
        completedAt: now,
        errorCode: 'RATE_LIMITED',
        id: '0198be1d-a3a9-7d34-9bc3-123456789abe',
        input: { prompt: 'private prompt' },
        output: {
          notApplicableReason: 'reply_not_required',
          providerDetail: 'private provider detail',
          retryable: true,
          reviewReason: '<script>alert(1)</script>',
        },
        runId,
        sequence: 20,
        startedAt: now,
        status: 'failed',
        stepName: 'ANALYZE_EMAIL<img src=x onerror=alert(1)>',
      },
    ]);
    const app = createConfiguredApp({ runs });

    const response = await app.request(`/history/runs/${runId}`);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain('ANALYZE_EMAIL&lt;img');
    expect(body).toContain('RATE_LIMITED');
    expect(body).toContain('reply_not_required');
    expect(body).toContain('Gmail returned inconsistent message and thread data');
    expect(body).toContain('retryable');
    expect(body).toContain('needs_review');
    expect(body).toContain('対象メール: Interview &amp;lt;script&amp;gt;');
    expect(body).not.toContain('private prompt');
    expect(body).not.toContain('private provider detail');
    expect(body).not.toContain('<script>alert(1)</script>');
    expect(body).not.toContain('<img src=x');
  });

  test('does not render arbitrary persisted error messages', async () => {
    const runs = new FakeRunRepository();
    runs.runs.set(runId, {
      agentId: 'job-search-email',
      completedAt: now,
      errorCode: 'INVALID_RESPONSE',
      errorMessage: 'private provider response: mailbox@example.com',
      id: runId,
      jobId,
      startedAt: now,
      status: 'failed',
      triggerType: 'manual',
    });
    const app = createConfiguredApp({ runs });

    const body = await (await app.request(`/history/runs/${runId}`)).text();

    expect(body).not.toContain('private provider response');
    expect(body).not.toContain('mailbox@example.com');
  });

  test('renders the safe fixed OpenAI invalid-request detail', async () => {
    const runs = new FakeRunRepository();
    runs.runs.set(runId, {
      agentId: 'job-search-email',
      completedAt: now,
      errorCode: 'INVALID_REQUEST',
      errorMessage: 'OpenAI rejected the request',
      id: runId,
      jobId,
      startedAt: now,
      status: 'failed',
      triggerType: 'manual',
    });
    const app = createConfiguredApp({ runs });

    const body = await (await app.request(`/history/runs/${runId}`)).text();

    expect(body).toContain('OpenAI rejected the request');
  });

  test('rejects invalid pagination input', async () => {
    const response = await createConfiguredApp().request('/history?page=0');

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: 'BAD_REQUEST' } });
  });

  test('paginates Runs in reverse chronological order', async () => {
    const runs = new FakeRunRepository();
    const runIds = Array.from({ length: 26 }, () => crypto.randomUUID());
    for (const [index, id] of runIds.entries()) {
      runs.runs.set(id, {
        agentId: 'echo',
        completedAt: now,
        errorCode: null,
        id,
        jobId,
        startedAt: new Date(now.getTime() + index * 1_000),
        status: 'completed',
        triggerType: 'manual',
      });
    }

    const app = createConfiguredApp({ runs });
    const firstPage = await (await app.request('/history')).text();
    const secondPage = await (await app.request('/history?page=2')).text();

    expect(firstPage).toContain('/history?page=2');
    expect(firstPage).toContain(runIds[25] as string);
    expect(firstPage).not.toContain(runIds[0] as string);
    expect(secondPage).toContain('/history?page=1');
    expect(secondPage).toContain(runIds[0] as string);
    expect(secondPage).not.toContain(runIds[25] as string);
  });

  test('keeps history pages behind the configured API authentication boundary', async () => {
    const app = createApp({
      accessToken: 'expected-token',
      logger: { error() {}, info() {} },
      requestIdGenerator: () => 'history-request-id',
      runs: new FakeRunRepository(),
    });

    const response = await app.request('/history');

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: 'UNAUTHORIZED' } });
  });
});
