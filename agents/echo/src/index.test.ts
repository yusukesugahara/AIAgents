import { describe, expect, test } from 'bun:test';

import { createDevelopmentAgentRegistry, createRuntimeAgentRegistry } from './index';

describe('Development Echo Agent', () => {
  test('registers a manual Echo Agent', () => {
    const agent = createDevelopmentAgentRegistry().get('echo');

    expect(agent.manifest).toMatchObject({ id: 'echo', triggers: ['manual'] });
  });

  test('does not register the development Agent in production', () => {
    expect(createRuntimeAgentRegistry('production').list()).toHaveLength(0);
  });
});
