export interface DataRetentionHandle {
  cleanupNow(): Promise<void>;
  stop(): Promise<void>;
}

export function startDataRetentionCleanup(options: {
  readonly cleanupIntervalMs: number;
  readonly now?: () => Date;
  readonly repository: { deleteExpired(before: Date): Promise<number> };
  readonly retentionMs: number;
  readonly runImmediately?: boolean;
}): DataRetentionHandle {
  if (
    !Number.isSafeInteger(options.cleanupIntervalMs) ||
    options.cleanupIntervalMs <= 0 ||
    !Number.isSafeInteger(options.retentionMs) ||
    options.retentionMs <= 0
  ) {
    throw new Error('Data retention intervals must be positive integers');
  }
  const now = options.now ?? (() => new Date());
  let active: Promise<void> | undefined;
  let stopped = false;

  const cleanupNow = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (active) return active;
    const execution = options.repository
      .deleteExpired(new Date(now().getTime() - options.retentionMs))
      .then((deletedJobs) => {
        console.info(JSON.stringify({ deletedJobs, event: 'data_retention.completed' }));
      })
      .catch(() => {
        console.error(JSON.stringify({ code: 'CLEANUP_FAILED', event: 'data_retention.failed' }));
      })
      .finally(() => {
        if (active === execution) active = undefined;
      });
    active = execution;
    return execution;
  };

  const timer = setInterval(() => void cleanupNow(), options.cleanupIntervalMs);
  if (options.runImmediately ?? true) void cleanupNow();
  return {
    cleanupNow,
    async stop() {
      stopped = true;
      clearInterval(timer);
      await active;
    },
  };
}
