// node `worker_threads` entry, the test-side twin of worker-web.ts.
import { parentPort } from 'node:worker_threads';
import { handleRunRequest, handleWarmRequest } from './job-runner.ts';
import type { JobRunRequest, JobWarmRequest } from './types.ts';

const port = parentPort;
if (port) {
  port.on('message', (request: JobRunRequest | JobWarmRequest) => {
    const env = {
      importModule: (url: string) => import(url),
      post: (message: Parameters<typeof port.postMessage>[0]) => port.postMessage(message),
    };
    void (request.type === 'warm' ? handleWarmRequest(request, env) : handleRunRequest(request, env));
  });
}
