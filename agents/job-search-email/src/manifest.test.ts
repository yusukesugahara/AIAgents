import { describe, expect, test } from 'bun:test';

import { manifest } from './manifest';

describe('job-search-email manifest', () => {
  test('has a stable agent id', () => {
    expect(manifest.id).toBe('job-search-email');
  });
});
