import type { JobRunRequest, JobWorkerEvent, WorkerFactory, WorkerLike } from './types.ts';

/** Wraps a DOM-style Worker (or anything with the same surface) as a WorkerLike. */
export function wrapDomWorker(worker: {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  addEventListener(type: 'error', listener: (event: { message?: string }) => void): void;
  terminate(): void;
}): WorkerLike {
  return {
    postMessage: (message: JobRunRequest) => worker.postMessage(message),
    onMessage: (listener) => worker.addEventListener('message', (event) => listener(event.data as JobWorkerEvent)),
    onError: (listener) =>
      worker.addEventListener('error', (event) => listener({ message: event.message ?? 'worker error' })),
    terminate: () => worker.terminate(),
  };
}

/**
 * A module Worker per job call. `entry` defaults to this package's worker-web.ts, which a bundler
 * resolves; pass your own URL when the host serves the worker elsewhere.
 */
export function createWebWorkerFactory(entry?: string | URL): WorkerFactory {
  return () =>
    wrapDomWorker(
      new Worker(entry ?? new URL('./worker-web.ts', import.meta.url), { type: 'module' }),
    );
}
