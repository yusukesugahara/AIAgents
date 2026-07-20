import { describe, expect, test } from 'bun:test';
import { jobSearchEmailCatalogAgent } from '@ai-agents/job-search-email';

import { createDevelopmentAgentRegistry, createRuntimeAgentRegistry } from './index';

describe('Agent composition', () => {
  test('registers the development Echo Agent', () => {
    expect(createDevelopmentAgentRegistry().get('echo').manifest.triggers).toEqual(['manual']);
  });

  test('registers development Agents only in development and test environments', () => {
    expect(createRuntimeAgentRegistry('development').list()).toHaveLength(2);
    expect(createRuntimeAgentRegistry('test').list()).toHaveLength(2);
    expect(
      createRuntimeAgentRegistry('production')
        .list()
        .map((agent) => agent.manifest.id),
    ).toEqual(['job-search-email']);
    expect(createRuntimeAgentRegistry(undefined).list()).toHaveLength(1);
  });

  test('uses an execution-bound Job Search Email Agent when supplied', () => {
    const executionAgent = {
      ...jobSearchEmailCatalogAgent,
      run: async () => ({
        analysis: null,
        calendarEventId: null,
        draftId: null,
        result: 'needs_review' as const,
      }),
    };
    expect(
      createRuntimeAgentRegistry({
        environment: 'production',
        jobSearchEmailAgent: executionAgent,
      }).get('job-search-email'),
    ).toBe(executionAgent);
  });

  test('rejects a misidentified execution Agent', () => {
    expect(() =>
      createRuntimeAgentRegistry({
        environment: 'production',
        jobSearchEmailAgent: {
          ...jobSearchEmailCatalogAgent,
          manifest: { ...jobSearchEmailCatalogAgent.manifest, id: 'different-agent' },
        },
      }),
    ).toThrow('must use the job-search-email manifest ID');
  });
});
