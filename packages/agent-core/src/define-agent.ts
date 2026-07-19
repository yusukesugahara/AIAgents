import type { AgentDefinition, AgentManifest } from './agent.types';

export interface DefineAgentOptions<TInput, TOutput> extends AgentDefinition<TInput, TOutput> {
  readonly manifest: AgentManifest;
}

export function defineAgent<TInput, TOutput>(
  definition: DefineAgentOptions<TInput, TOutput>,
): AgentDefinition<TInput, TOutput> {
  return definition;
}
