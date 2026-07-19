import {
  AgentRegistry,
  type AgentRegistry as AgentRegistryType,
  defineAgent,
} from '@ai-agents/agent-core';
import { z } from 'zod';

const echoInputSchema = z.object({
  value: z.string().min(1),
});

const echoOutputSchema = z.object({
  value: z.string(),
});

export const echoAgent = defineAgent({
  manifest: {
    id: 'echo',
    name: 'Development Echo Agent',
    version: '0.1.0',
    triggers: ['manual'],
  },
  inputSchema: echoInputSchema,
  outputSchema: echoOutputSchema,
  async run(_context, input) {
    return { value: input.value };
  },
});

export function registerDevelopmentAgents(registry: AgentRegistryType): AgentRegistryType {
  registry.register(echoAgent);
  return registry;
}

export function createDevelopmentAgentRegistry(): AgentRegistry {
  return registerDevelopmentAgents(new AgentRegistry());
}

export function createRuntimeAgentRegistry(environment = process.env.APP_ENV): AgentRegistry {
  const registry = new AgentRegistry();

  return environment === 'production' ? registry : registerDevelopmentAgents(registry);
}
