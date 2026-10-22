// The fx Worker under Node (DR-53 S5): a `worker_threads` entry (plain Node, type stripping) that serves the real worker code
// (src/render/fx/fx-worker.ts `serveFx`) on the thread's parent port, adapted to the worker scope it expects.
import { parentPort } from 'node:worker_threads';
import { serveFx } from '../../../../src/render/fx/fx-worker.ts';
import type { WorkerScopeLike } from '../../../../src/render/fx/fx-protocol.ts';

const port = parentPort!;
const scope: WorkerScopeLike = {
  postMessage: (msg, transfer) => port.postMessage(msg, transfer),
  addEventListener: (_type, fn) => {
    port.on('message', (data: unknown) => fn({ data }));
  },
};
serveFx(scope);
