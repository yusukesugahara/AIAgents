import { AgentRegistry } from '@ai-agents/agent-core';
import { registerDevelopmentAgents } from '@ai-agents/echo-agent';

export function createDevelopmentAgentRegistry(): AgentRegistry {
  return registerDevelopmentAgents(new AgentRegistry());
}

export function createRuntimeAgentRegistry(environment = process.env.APP_ENV): AgentRegistry {
  const registry = new AgentRegistry();

  return environment === 'development' || environment === 'test'
    ? registerDevelopmentAgents(registry)
    : registry;
}
