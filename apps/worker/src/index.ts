import { startWorker } from './worker';

const worker = startWorker();

function shutdown(): void {
  worker.stop();
  process.exit(0);
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
