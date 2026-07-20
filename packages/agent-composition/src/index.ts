import { type AgentDefinition, AgentRegistry } from '@ai-agents/agent-core';
import { registerDevelopmentAgents } from '@ai-agents/echo-agent';
import {
  type JobSearchEmailInput,
  type JobSearchEmailOutput,
  jobSearchEmailCatalogAgent,
} from '@ai-agents/job-search-email';

export type JobSearchEmailAgentDefinition = AgentDefinition<
  JobSearchEmailInput,
  JobSearchEmailOutput
>;

export interface RuntimeAgentRegistryOptions {
  readonly environment?: string | undefined;
  readonly jobSearchEmailAgent?: JobSearchEmailAgentDefinition | undefined;
}

export function createDevelopmentAgentRegistry(): AgentRegistry {
  return createRuntimeAgentRegistry({ environment: 'development' });
}

export function createRuntimeAgentRegistry(
  environmentOrOptions: string | RuntimeAgentRegistryOptions | undefined = process.env.APP_ENV,
): AgentRegistry {
  const options: RuntimeAgentRegistryOptions =
    typeof environmentOrOptions === 'object'
      ? environmentOrOptions
      : { environment: environmentOrOptions };
  const registry = new AgentRegistry();
  const jobSearchEmailAgent = options.jobSearchEmailAgent ?? jobSearchEmailCatalogAgent;
  if (jobSearchEmailAgent.manifest.id !== jobSearchEmailCatalogAgent.manifest.id) {
    throw new Error('Job Search Email Agent dependency must use the job-search-email manifest ID');
  }
  registry.register(jobSearchEmailAgent);

  return options.environment === 'development' || options.environment === 'test'
    ? registerDevelopmentAgents(registry)
    : registry;
}
