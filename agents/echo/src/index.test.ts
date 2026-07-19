import { describe, expect, test } from 'bun:test';

import { echoAgent } from './index';

describe('Development Echo Agent', () => {
  test('registers a manual Echo Agent', () => {
    expect(echoAgent.manifest).toMatchObject({ id: 'echo', triggers: ['manual'] });
  });
});
