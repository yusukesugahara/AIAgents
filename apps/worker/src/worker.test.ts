import { describe, expect, test } from 'bun:test';

import { startWorker } from './worker';

describe('worker', () => {
  test('can be started and stopped', () => {
    const worker = startWorker();

    expect(worker.stop).toBeFunction();
    worker.stop();
  });
});
