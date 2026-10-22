// The fx Worker (DR-53/DR-54; .cache/claude-fxworker/DESIGN.md §4, §5, §9): one module worker, `ss-fx`, running the fx world
// (world/fx-world.ts) for the main thread's facade (fx-worker-runtime.ts). It compiles the programs, starts and steps the
// effects, selects and evaluates the light sinks and fills every bucket, and sends the finished arrays back by transfer.
//
// Three hosts share `serveFx`:
//   browser   this file is the module-worker entry the facade spawns (`new Worker(new URL('./fx-worker.ts', import.meta.url),
//             { type: 'module', name: 'ss-fx' })`); it serves itself below
//   Node      the tests' worker host (tests/unit/render/fx/worker-host.ts) wires it to a `worker_threads` port
//   a page    a harness page's own worker entry sets `__ssFxWorkerHosted` before importing this module, then serves itself
// Its module closure is three-free and game-free (tools/check/source-rules.ts `fx-worker-pure`): fx/{world,sim,dsl}/**,
// fx-protocol.ts, color/color.ts and calibration.ts. Main-thread code imports this file only as `import type`.
import { FX_PROTOCOL_VERSION, FxBufferPool, frameTransfers, type FromFxWorker, type ToFxWorker, type WorkerScopeLike } from './fx-protocol.ts';
import { FxWorld, type FxWorldSeams } from './world/fx-world.ts';

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/**
 * Answers the facade's messages on `scope` with one fx world: `init` (once), `frame` (one at a time; the reply carries every
 * bucket buffer in its transfer list), `dispose`. Anything thrown while serving is fatal: the facade is told once (`fatal`)
 * and falls back to the in-process runtime; later messages are ignored. `seams`: the tests' world seams (a floor).
 */
export function serveFx(scope: WorkerScopeLike, seams: Omit<FxWorldSeams, 'log' | 'onRemove'> = {}): void {
  let world: FxWorld | null = null;
  let dead = false;
  const pool = new FxBufferPool();
  const texts = new Map<number, string>();
  const text = (ref: number): string | undefined => texts.get(ref);
  const post = (msg: FromFxWorker, transfer: ArrayBuffer[] = []): void => scope.postMessage(msg, transfer);
  scope.addEventListener('message', (ev) => {
    if (dead) return;
    const msg = ev.data as ToFxWorker;
    try {
      if (msg.t === 'init') {
        if (msg.v !== FX_PROTOCOL_VERSION) throw new Error(`the facade speaks fx protocol ${String(msg.v)}, this worker ${FX_PROTOCOL_VERSION}`);
        world = new FxWorld(msg.init, seams);
        post({ t: 'ready', v: FX_PROTOCOL_VERSION });
        return;
      }
      if (msg.t === 'frame') {
        if (world === null) throw new Error('a frame before init');
        for (const [key, buf] of msg.returned) pool.give(key, buf);
        for (const [ref, t] of msg.programs) texts.set(ref, t);
        const t0 = now();
        const out = world.frame(msg.frame, text, pool);
        post({ t: 'frame', seq: msg.seq, out, ms: now() - t0 }, frameTransfers(out));
        return;
      }
      if (msg.t === 'dispose') {
        world?.clear();
        world = null;
        dead = true;
      }
    } catch (e) {
      dead = true;
      world = null;
      post({ t: 'fatal', message: e instanceof Error ? `${e.name}: ${e.message}` : String(e) });
    }
  });
}

/** True inside a dedicated or module web worker (not in a window, jsdom or Node). */
function inWebWorker(): boolean {
  const g = globalThis as { WorkerGlobalScope?: unknown };
  return typeof g.WorkerGlobalScope === 'function' && globalThis instanceof (g.WorkerGlobalScope as abstract new () => object);
}

/** A worker entry of its own (a harness page) sets this global from a module it imports before this one, then serves itself. */
const hosted = (globalThis as { __ssFxWorkerHosted?: boolean }).__ssFxWorkerHosted === true;

if (inWebWorker() && !hosted) serveFx(globalThis as unknown as WorkerScopeLike);
