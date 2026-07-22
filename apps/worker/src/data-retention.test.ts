import { describe, expect, test } from 'bun:test';
import { startDataRetentionCleanup } from './data-retention';

describe('data retention cleanup', () => {
  test('uses the configured cutoff, prevents overlap, and waits during shutdown', async () => {
    const cutoffs: Date[] = [];
    let release: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const cleanup = startDataRetentionCleanup({
      cleanupIntervalMs: 60_000,
      now: () => new Date('2026-07-22T00:00:00.000Z'),
      repository: {
        deleteExpired: async (before) => {
          cutoffs.push(before);
          await pending;
          return 2;
        },
      },
      retentionMs: 90 * 86_400_000,
      runImmediately: false,
    });

    const first = cleanup.cleanupNow();
    expect(cleanup.cleanupNow()).toBe(first);
    let stopped = false;
    const stop = cleanup.stop().then(() => {
      stopped = true;
    });
    await Bun.sleep(1);
    expect(stopped).toBe(false);
    release?.();
    await stop;

    expect(cutoffs).toEqual([new Date('2026-04-23T00:00:00.000Z')]);
  });
});
