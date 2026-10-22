// Workers for the fx facade's tests (DR-53 S5/S6), each an `FxWorkerLike`:
//   nodeFxWorker     a real `worker_threads` thread running src/render/fx/fx-worker.ts (worker-host.ts): the cross-thread path
//   ManualFxWorker   the worker code in-process, delivering each message only when the test says (`deliver`), through
//                    `structuredClone` with the transfer list, so a transferred buffer really is detached: the coalescing,
//                    fallback and transfer-rule tests
import { Worker } from 'node:worker_threads';
import { serveFx } from '../../../../src/render/fx/fx-worker.ts';
import type { FxWorkerLike } from '../../../../src/render/fx/fx-worker-runtime.ts';

export function nodeFxWorker(): FxWorkerLike & { readonly thread: Worker } {
  const thread = new Worker(new URL('./worker-host.ts', import.meta.url));
  const like: FxWorkerLike & { readonly thread: Worker } = {
    thread,
    onmessage: null,
    onerror: null,
    onmessageerror: null,
    postMessage(msg, transfer) {
      thread.postMessage(msg, transfer ?? []);
    },
    terminate() {
      void thread.terminate();
    },
  };
  thread.on('message', (data: unknown) => like.onmessage?.({ data }));
  thread.on('error', (e) => like.onerror?.(e));
  thread.on('messageerror', (e) => like.onmessageerror?.(e));
  return like;
}

/** the worker code in-process; messages wait in two queues until `deliver()` (both directions, in order) */
export class ManualFxWorker implements FxWorkerLike {
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onmessageerror: ((ev: unknown) => void) | null = null;
  terminated = false;
  /** every message posted to the worker, as posted (`t` only matters: the payload may be transferred away) */
  readonly posted: Array<{ readonly t: string }> = [];
  /** every message posted to the worker, as the worker received it */
  readonly received: unknown[] = [];
  /** the buffers handed back with frame messages, as the worker received them: whole, or detached (never expected) */
  returnedWhole = 0;
  returnedDetached = 0;
  readonly #toWorker: unknown[] = [];
  readonly #toMain: unknown[] = [];
  #listener: ((ev: { data: unknown }) => void) | null = null;

  constructor() {
    serveFx({
      postMessage: (msg, transfer) => {
        this.#toMain.push(structuredClone(msg, { transfer }));
      },
      addEventListener: (_type, fn) => {
        this.#listener = fn;
      },
    });
  }

  postMessage(msg: unknown, transfer: ArrayBuffer[] = []): void {
    if (this.terminated) return;
    // throws DataCloneError for a payload that is not plain data, as a real worker's postMessage does
    this.#toWorker.push(structuredClone(msg, { transfer }));
    this.posted.push({ t: String((msg as { t?: unknown }).t) });
  }

  terminate(): void {
    this.terminated = true;
  }

  /** messages waiting for the worker, and for the main thread */
  get queued(): { toWorker: number; toMain: number } {
    return { toWorker: this.#toWorker.length, toMain: this.#toMain.length };
  }

  /** runs every message queued for the worker, then hands every reply to the main thread; true when anything moved */
  deliver(): boolean {
    let moved = false;
    while (this.#toWorker.length > 0 && !this.terminated) {
      const data = this.#toWorker.shift();
      this.received.push(data);
      const msg = data as { t?: string; returned?: ReadonlyArray<readonly [string, ArrayBuffer]> };
      if (msg.t === 'frame') {
        for (const [, buf] of msg.returned ?? []) {
          if (buf.byteLength > 0) this.returnedWhole++;
          else this.returnedDetached++;
        }
      }
      this.#listener?.({ data });
      moved = true;
    }
    while (this.#toMain.length > 0 && !this.terminated) {
      const data = this.#toMain.shift();
      this.onmessage?.({ data });
      moved = true;
    }
    return moved;
  }

  /** delivers until nothing moves (a reply may post the pending step) */
  drain(): void {
    while (this.deliver()) {
      // the next round
    }
  }

  /** an error event, as a worker that failed to load or threw at top level raises */
  fail(message: string): void {
    this.onerror?.({ message });
  }
}
