import { describe, expect, test } from 'bun:test';
import { z } from 'zod';

import {
  AgentCoreError,
  AgentDependencyError,
  AgentRegistry,
  type AgentRunCompletion,
  type AgentRunFailure,
  AgentRunner,
  type AgentRunRepository,
  type AgentRunStart,
  createUuidV7,
  defineAgent,
  RetryableJobError,
} from './index';

const inputSchema = z.object({ greeting: z.string() });
const outputSchema = z.object({ message: z.string() });

function createAgent(
  run = async ({ greeting }: z.infer<typeof inputSchema>) => ({ message: greeting }),
) {
  return defineAgent({
    manifest: {
      id: 'test-agent',
      name: 'Test Agent',
      version: '0.1.0',
      triggers: ['manual'],
    },
    inputSchema,
    outputSchema,
    async run(_context, input) {
      return run(input);
    },
  });
}

class FakeAgentRunRepository implements AgentRunRepository {
  readonly started: AgentRunStart[] = [];
  readonly completed: AgentRunCompletion[] = [];
  readonly failed: AgentRunFailure[] = [];

  async startRun(run: AgentRunStart): Promise<void> {
    this.started.push(run);
  }

  async completeRun(run: AgentRunCompletion): Promise<void> {
    this.completed.push(run);
  }

  async failRun(run: AgentRunFailure): Promise<void> {
    this.failed.push(run);
  }

  async getLatestRunForJob(): Promise<null> {
    return null;
  }

  async getRun(): Promise<null> {
    return null;
  }
}

function createRunner(agent = createAgent()) {
  const registry = new AgentRegistry().register(agent);
  const repository = new FakeAgentRunRepository();
  const runner = new AgentRunner({
    registry,
    repository,
    now: () => new Date('2026-07-19T00:00:00.000Z'),
    runIdGenerator: () => 'run-123',
  });

  return { registry, repository, runner };
}

describe('AgentRegistry', () => {
  test('registers, lists, and retrieves an Agent by ID', () => {
    const { registry } = createRunner();

    expect(registry.list()).toHaveLength(1);
    expect(registry.get('test-agent').manifest.name).toBe('Test Agent');
  });

  test('rejects duplicate and unknown Agent IDs', () => {
    const registry = new AgentRegistry();
    registry.register(createAgent());

    expect(() => registry.register(createAgent())).toThrow(
      new AgentCoreError('AGENT_ALREADY_REGISTERED', 'Agent "test-agent" is already registered'),
    );
    expect(() => registry.get('missing-agent')).toThrow(
      new AgentCoreError('AGENT_NOT_FOUND', 'Agent "missing-agent" is not registered'),
    );
  });
});

describe('AgentRunner', () => {
  test('rejects unsupported triggers before it creates a Run', async () => {
    const { repository, runner } = createRunner();

    await expect(
      runner.run({
        agentId: 'test-agent',
        jobId: 'job-123',
        triggerType: 'schedule',
        input: { greeting: 'Hello' },
      }),
    ).rejects.toMatchObject({ code: 'AGENT_TRIGGER_UNSUPPORTED' });
    expect(repository.started).toHaveLength(0);
  });

  test('rejects invalid input before it creates a Run', async () => {
    const { repository, runner } = createRunner();

    await expect(
      runner.run({
        agentId: 'test-agent',
        jobId: 'job-123',
        triggerType: 'manual',
        input: { greeting: 1 },
      }),
    ).rejects.toMatchObject({ code: 'AGENT_INPUT_INVALID' });
    expect(repository.started).toHaveLength(0);
  });

  test('saves a completed Run and validates its output', async () => {
    const { repository, runner } = createRunner();

    await expect(
      runner.run({
        agentId: 'test-agent',
        jobId: 'job-123',
        triggerType: 'manual',
        input: { greeting: 'Hello' },
      }),
    ).resolves.toEqual({ runId: 'run-123', output: { message: 'Hello' } });
    expect(repository.started).toEqual([
      {
        runId: 'run-123',
        jobId: 'job-123',
        agentId: 'test-agent',
        triggerType: 'manual',
        input: { greeting: 'Hello' },
        startedAt: new Date('2026-07-19T00:00:00.000Z'),
      },
    ]);
    expect(repository.completed).toEqual([
      {
        runId: 'run-123',
        output: { message: 'Hello' },
        completedAt: new Date('2026-07-19T00:00:00.000Z'),
      },
    ]);
    expect(repository.failed).toHaveLength(0);
  });

  test('converts Agent exceptions and saves the failed Run', async () => {
    const { repository, runner } = createRunner(
      createAgent(async () => {
        throw new Error('provider unavailable');
      }),
    );

    await expect(
      runner.run({
        agentId: 'test-agent',
        jobId: 'job-123',
        triggerType: 'manual',
        input: { greeting: 'Hello' },
      }),
    ).rejects.toMatchObject({ code: 'AGENT_EXECUTION_FAILED' });
    expect(repository.failed).toEqual([
      {
        runId: 'run-123',
        errorCode: 'AGENT_EXECUTION_FAILED',
        errorMessage: 'Agent "test-agent" failed during run "run-123": provider unavailable',
        completedAt: new Date('2026-07-19T00:00:00.000Z'),
      },
    ]);
  });

  test('rejects invalid Agent output and saves the failed Run', async () => {
    const { repository, runner } = createRunner(
      createAgent(async () => ({ message: 1 }) as unknown as { message: string }),
    );

    await expect(
      runner.run({
        agentId: 'test-agent',
        jobId: 'job-123',
        triggerType: 'manual',
        input: { greeting: 'Hello' },
      }),
    ).rejects.toMatchObject({ code: 'AGENT_OUTPUT_INVALID' });
    expect(repository.failed).toEqual([
      {
        runId: 'run-123',
        errorCode: 'AGENT_OUTPUT_INVALID',
        errorMessage: expect.stringContaining('returned invalid output'),
        completedAt: new Date('2026-07-19T00:00:00.000Z'),
      },
    ]);
  });

  test('saves a failed Run before retrying a retryable Agent error', async () => {
    const { repository, runner } = createRunner(
      createAgent(async () => {
        throw new RetryableJobError('temporary provider failure');
      }),
    );

    await expect(
      runner.run({
        agentId: 'test-agent',
        jobId: 'job-123',
        triggerType: 'manual',
        input: { greeting: 'Hello' },
      }),
    ).rejects.toBeInstanceOf(RetryableJobError);
    expect(repository.failed).toEqual([
      {
        runId: 'run-123',
        errorCode: 'JOB_RETRYABLE',
        errorMessage: 'temporary provider failure',
        completedAt: new Date('2026-07-19T00:00:00.000Z'),
      },
    ]);
  });

  test('preserves dependency error codes and retryability in the failed Run', async () => {
    const { repository, runner } = createRunner(
      createAgent(async () => {
        throw new AgentDependencyError('RATE_LIMITED', true, 'Gmail rate limit was exceeded');
      }),
    );

    await expect(
      runner.run({
        agentId: 'test-agent',
        jobId: 'job-123',
        triggerType: 'manual',
        input: { greeting: 'Hello' },
      }),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED', retryable: true });
    expect(repository.failed).toEqual([
      {
        runId: 'run-123',
        errorCode: 'RATE_LIMITED',
        errorMessage: 'Gmail rate limit was exceeded',
        completedAt: new Date('2026-07-19T00:00:00.000Z'),
      },
    ]);
  });

  test('treats Run completion persistence failures as retryable without overwriting the Run', async () => {
    const { repository, runner } = createRunner();
    repository.completeRun = async () => {
      throw new Error('database unavailable');
    };

    await expect(
      runner.run({
        agentId: 'test-agent',
        jobId: 'job-123',
        triggerType: 'manual',
        input: { greeting: 'Hello' },
      }),
    ).rejects.toBeInstanceOf(RetryableJobError);
    expect(repository.failed).toHaveLength(0);
  });

  test('treats Run failure persistence failures as retryable', async () => {
    const { repository, runner } = createRunner(
      createAgent(async () => {
        throw new RetryableJobError('temporary provider failure');
      }),
    );
    repository.failRun = async () => {
      throw new Error('database unavailable');
    };

    await expect(
      runner.run({
        agentId: 'test-agent',
        jobId: 'job-123',
        triggerType: 'manual',
        input: { greeting: 'Hello' },
      }),
    ).rejects.toBeInstanceOf(RetryableJobError);
  });

  test('uses UUIDv7 identifiers by default', () => {
    const runId = createUuidV7(new Date('2026-07-19T00:00:00.000Z').getTime());

    expect(runId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
