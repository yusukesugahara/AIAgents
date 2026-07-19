import { describe, expect, test } from 'bun:test';

import { resolveApiAccessToken } from './runtime-config';

describe('API runtime configuration', () => {
  test('allows unauthenticated access only in development and test', () => {
    expect(resolveApiAccessToken({ APP_ENV: 'development' })).toBeUndefined();
    expect(resolveApiAccessToken({ APP_ENV: 'test' })).toBeUndefined();
  });

  test('fails closed outside development and test', () => {
    expect(() => resolveApiAccessToken({ APP_ENV: 'production' })).toThrow(
      'API_ACCESS_TOKEN is required unless APP_ENV is development or test',
    );
    expect(() => resolveApiAccessToken({ APP_ENV: 'prod' })).toThrow(
      'API_ACCESS_TOKEN is required unless APP_ENV is development or test',
    );
    expect(() => resolveApiAccessToken({})).toThrow(
      'API_ACCESS_TOKEN is required unless APP_ENV is development or test',
    );
    expect(() => resolveApiAccessToken({ API_ACCESS_TOKEN: '   ', APP_ENV: 'production' })).toThrow(
      'API_ACCESS_TOKEN is required unless APP_ENV is development or test',
    );
  });

  test('accepts an access token in a non-development environment', () => {
    expect(resolveApiAccessToken({ API_ACCESS_TOKEN: 'secret', APP_ENV: 'production' })).toBe(
      'secret',
    );
    expect(resolveApiAccessToken({ API_ACCESS_TOKEN: '  secret  ', APP_ENV: 'production' })).toBe(
      'secret',
    );
  });
});
