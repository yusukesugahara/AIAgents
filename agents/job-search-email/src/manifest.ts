import type { AgentManifest } from '@ai-agents/agent-core';

export const manifest: AgentManifest = {
  id: 'job-search-email',
  name: '就職活動メールエージェント',
  version: '0.1.0',
  triggers: ['manual', 'schedule', 'gmail-push'],
};
