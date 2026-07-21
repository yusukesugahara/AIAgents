import { AgentCoreError, type AgentJob } from '@ai-agents/agent-core';
import type { ApiAppOptions } from './api-types';
import { ApiError } from './api-types';

export async function enqueueManualAgentRun(
  options: ApiAppOptions,
  input: {
    readonly agentId: string;
    readonly idempotencyKey?: string;
    readonly value: unknown;
  },
): Promise<AgentJob> {
  const registry = options.registry;
  if (!registry) {
    throw new ApiError('INTERNAL_ERROR', 500, 'Agent Registry is not configured');
  }
  const queue = options.queue;
  if (!queue) throw new ApiError('INTERNAL_ERROR', 500, 'Job Queue is not configured');

  const agent = (() => {
    try {
      return registry.get(input.agentId);
    } catch (error) {
      if (error instanceof AgentCoreError && error.code === 'AGENT_NOT_FOUND') {
        throw new ApiError('AGENT_NOT_FOUND', 404, `Agent "${input.agentId}" was not found`);
      }
      throw error;
    }
  })();
  if (!agent.manifest.triggers.includes('manual')) {
    throw new ApiError(
      'AGENT_TRIGGER_UNSUPPORTED',
      400,
      `Agent "${agent.manifest.id}" does not support manual runs`,
    );
  }

  const parsed = agent.inputSchema.safeParse(input.value);
  if (!parsed.success) throw new ApiError('BAD_REQUEST', 400, parsed.error.message);
  return queue.enqueue({
    agentId: agent.manifest.id,
    input: parsed.data,
    triggerType: 'manual',
    ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
  });
}
