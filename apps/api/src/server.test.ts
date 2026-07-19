import { describe, expect, test } from 'bun:test';
import { startOAuthStateCleanup } from './server';

describe('OAuth state cleanup scheduler', () => {
  test('runs at startup and periodically, prevents overlap, and waits during shutdown', async () => {
    let calls = 0;
    let finishCleanup: (() => void) | undefined;
    const cleanup = () => {
      calls += 1;
      return new Promise<void>((resolve) => {
        finishCleanup = resolve;
      });
    };
    const controller = startOAuthStateCleanup(cleanup, 1, () => {});

    await Bun.sleep(5);
    expect(calls).toBe(1);
    const stopping = controller.stop();
    let stopped = false;
    void stopping.then(() => {
      stopped = true;
    });
    await Bun.sleep(1);
    expect(stopped).toBe(false);

    finishCleanup?.();
    await stopping;
    await Bun.sleep(5);
    expect(calls).toBe(1);
  });

  test('continues after cleanup failures', async () => {
    let calls = 0;
    let errors = 0;
    const controller = startOAuthStateCleanup(
      () => {
        calls += 1;
        throw new Error('database unavailable');
      },
      1,
      () => {
        errors += 1;
      },
    );

    await Bun.sleep(10);
    await controller.stop();
    expect(calls).toBeGreaterThan(1);
    expect(errors).toBe(calls);
  });
});
