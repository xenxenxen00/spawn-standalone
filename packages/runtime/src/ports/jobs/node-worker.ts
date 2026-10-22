import { Worker } from 'node:worker_threads';
import type { JobRunRequest, JobWorkerEvent, WorkerFactory } from './types.ts';

/**
 * node `worker_threads` adapter (tests, and any node host). Imported separately from the package
 * index so browser bundles never pull `node:worker_threads` in.
 */
export function createNodeWorkerFactory(entry: string | URL = new URL('./worker-node.ts', import.meta.url)): WorkerFactory {
  return () => {
    const worker = new Worker(entry);
    return {
      postMessage: (message: JobRunRequest) => worker.postMessage(message),
      onMessage: (listener) => worker.on('message', (event: JobWorkerEvent) => listener(event)),
      onError: (listener) => {
        worker.on('error', (error) => listener({ message: error.message }));
        worker.on('exit', (code) => listener({ message: `worker exited with code ${code}` }));
      },
      terminate: () => worker.terminate(),
    };
  };
}
