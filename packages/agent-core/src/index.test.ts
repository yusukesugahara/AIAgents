import { describe, expect, test } from 'bun:test';
import { z } from 'zod';

import {
  AgentCoreError,
  AgentRegistry,
  type AgentRunCompletion,
  type AgentRunFailure,
  AgentRunner,
  type AgentRunRepository,
  type AgentRunStart,
  defineAgent,
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
  test('rejects invalid input before it creates a Run', async () => {
    const { repository, runner } = createRunner();

    await expect(
      runner.run({ agentId: 'test-agent', triggerType: 'manual', input: { greeting: 1 } }),
    ).rejects.toMatchObject({ code: 'AGENT_INPUT_INVALID' });
    expect(repository.started).toHaveLength(0);
  });

  test('saves a completed Run and validates its output', async () => {
    const { repository, runner } = createRunner();

    await expect(
      runner.run({ agentId: 'test-agent', triggerType: 'manual', input: { greeting: 'Hello' } }),
    ).resolves.toEqual({ runId: 'run-123', output: { message: 'Hello' } });
    expect(repository.started).toEqual([
      {
        runId: 'run-123',
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
      runner.run({ agentId: 'test-agent', triggerType: 'manual', input: { greeting: 'Hello' } }),
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
      runner.run({ agentId: 'test-agent', triggerType: 'manual', input: { greeting: 'Hello' } }),
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
});
