import { AgentDependencyError } from '@ai-agents/agent-core';

export async function persistSafely(
  operation: () => Promise<void>,
  message: string,
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    if (error instanceof AgentDependencyError) throw error;
    throw new AgentDependencyError('TEMPORARY_UNAVAILABLE', true, message, { cause: error });
  }
}

export async function persistResult<T>(operation: () => Promise<T>, message: string): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof AgentDependencyError) throw error;
    throw new AgentDependencyError('TEMPORARY_UNAVAILABLE', true, message, { cause: error });
  }
}
