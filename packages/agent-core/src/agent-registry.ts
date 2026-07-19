import type { AgentDefinition } from './agent.types';
import { AgentCoreError } from './errors';

export class AgentRegistry {
  readonly #agents = new Map<string, AgentDefinition<unknown, unknown>>();

  register<TInput, TOutput>(agent: AgentDefinition<TInput, TOutput>): this {
    const agentId = agent.manifest.id;

    if (this.#agents.has(agentId)) {
      throw new AgentCoreError(
        'AGENT_ALREADY_REGISTERED',
        `Agent "${agentId}" is already registered`,
      );
    }

    this.#agents.set(agentId, agent as AgentDefinition<unknown, unknown>);
    return this;
  }

  get(agentId: string): AgentDefinition<unknown, unknown> {
    const agent = this.#agents.get(agentId);

    if (!agent) {
      throw new AgentCoreError('AGENT_NOT_FOUND', `Agent "${agentId}" is not registered`);
    }

    return agent;
  }

  list(): readonly AgentDefinition<unknown, unknown>[] {
    return [...this.#agents.values()];
  }
}
