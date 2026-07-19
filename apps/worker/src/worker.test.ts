import { describe, expect, test } from 'bun:test';

import { startWorker } from './worker';

describe('worker', () => {
  test('can be started and stopped', async () => {
    const worker = await startWorker();

    expect(worker.stop).toBeFunction();
    await worker.stop();
  });

  test('checks the database at startup and closes it at shutdown', async () => {
    let readinessChecks = 0;
    let closeCalls = 0;
    const worker = await startWorker({
      database: {
        isReady: async () => {
          readinessChecks += 1;
          return true;
        },
        close: async () => {
          closeCalls += 1;
        },
      },
    });

    expect(readinessChecks).toBe(1);
    await worker.stop();
    await worker.stop();
    expect(closeCalls).toBe(1);
  });

  test('does not start when the database is unavailable', async () => {
    let closeCalls = 0;

    await expect(
      startWorker({
        database: {
          isReady: async () => false,
          close: async () => {
            closeCalls += 1;
          },
        },
      }),
    ).rejects.toThrow('Database is not ready');
    expect(closeCalls).toBe(1);
  });
});
