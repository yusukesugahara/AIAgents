import { describe, expect, test } from 'bun:test';

import type { AgentManifest } from './index';

describe('AgentManifest', () => {
  test('accepts a minimal manifest', () => {
    const manifest: AgentManifest = {
      id: 'test-agent',
      name: 'Test Agent',
      version: '0.1.0',
      triggers: ['manual'],
    };

    expect(manifest.id).toBe('test-agent');
  });
});
