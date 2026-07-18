export interface WorkerHandle {
  stop(): void;
}

export function startWorker(heartbeatIntervalMs = 60_000): WorkerHandle {
  console.info(JSON.stringify({ event: 'worker.started' }));

  const heartbeat = setInterval(() => {
    console.info(JSON.stringify({ event: 'worker.heartbeat' }));
  }, heartbeatIntervalMs);

  return {
    stop() {
      clearInterval(heartbeat);
      console.info(JSON.stringify({ event: 'worker.stopped' }));
    },
  };
}
