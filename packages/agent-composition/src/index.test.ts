import { describe, expect, test } from 'bun:test';

import { createDevelopmentAgentRegistry, createRuntimeAgentRegistry } from './index';

describe('Agent composition', () => {
  test('registers the development Echo Agent', () => {
    expect(createDevelopmentAgentRegistry().get('echo').manifest.triggers).toEqual(['manual']);
  });

  test('registers development Agents only in development and test environments', () => {
    expect(createRuntimeAgentRegistry('development').list()).toHaveLength(1);
    expect(createRuntimeAgentRegistry('test').list()).toHaveLength(1);
    expect(createRuntimeAgentRegistry('production').list()).toHaveLength(0);
    expect(createRuntimeAgentRegistry(undefined).list()).toHaveLength(0);
  });
});
