import { AgentDependencyError } from '@ai-agents/agent-core';

export function invalidPersistenceReference(message: string): AgentDependencyError {
  return new AgentDependencyError('INVALID_REQUEST', false, message);
}
