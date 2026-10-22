// Browser module-Worker entry. A bundler (Vite) turns `new Worker(new URL('./worker-web.ts', import.meta.url),
// { type: 'module' })` into a chunk; this file is that worker's whole program.
import { handleRunRequest, handleWarmRequest } from './job-runner.ts';
import type { JobRunRequest, JobWarmRequest } from './types.ts';

const scope = globalThis as unknown as {
  onmessage: ((event: { data: JobRunRequest | JobWarmRequest }) => void) | null;
  postMessage(message: unknown): void;
};

scope.onmessage = (event) => {
  const env = {
    importModule: (url: string) => import(/* @vite-ignore */ url),
    post: (message: unknown) => scope.postMessage(message),
  };
  void (event.data.type === 'warm' ? handleWarmRequest(event.data, env) : handleRunRequest(event.data, env));
};
