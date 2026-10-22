// Worker-side half of the job protocol, shared by the browser and node worker entries so the
// behaviour is one piece of code. It has no imports from the host and runs inside the worker.
import type { JobRunRequest, JobWarmRequest, JobWorkerEvent } from './types.ts';

export interface RunnerEnvironment {
  importModule(url: string): Promise<unknown>;
  post(event: JobWorkerEvent): void;
}

type RunFn = (job: unknown, args: unknown) => unknown;

function pickRun(mod: unknown): RunFn | null {
  if (typeof mod !== 'object' || mod === null) return null;
  const m = mod as { run?: unknown; default?: unknown };
  if (typeof m.run === 'function') return m.run as RunFn;
  if (typeof m.default === 'function') return m.default as RunFn;
  return null;
}

function isIterator(value: unknown): value is AsyncIterator<unknown> | Iterator<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { next?: unknown }).next === 'function' &&
    (Symbol.asyncIterator in value || Symbol.iterator in value)
  );
}

// A module's optional `export function init()` runs once per worker, before its first run().
const initialised = new WeakMap<object, Promise<void>>();
function initOnce(mod: unknown): Promise<void> {
  if (typeof mod !== 'object' || mod === null) return Promise.resolve();
  let done = initialised.get(mod);
  if (!done) {
    const init = (mod as { init?: unknown }).init;
    done = typeof init === 'function' ? Promise.resolve().then(() => (init as () => unknown)()).then(() => undefined) : Promise.resolve();
    initialised.set(mod, done);
  }
  return done;
}

/** Idle-worker warm-up: load the module and run its init(). Failures surface again on the first run. */
export async function handleWarmRequest(request: JobWarmRequest, env: RunnerEnvironment): Promise<void> {
  try {
    await initOnce(await env.importModule(request.moduleUrl));
  } catch {
    // retried (and reported) by the first real call
  }
}

/** Runs one request: loads the module, calls `run`, streams yields as parts, posts result or error. */
export async function handleRunRequest(request: JobRunRequest, env: RunnerEnvironment): Promise<void> {
  const { requestId } = request;
  try {
    const mod = await env.importModule(request.moduleUrl);
    await initOnce(mod);
    const run = pickRun(mod);
    if (!run) {
      env.post({ type: 'error', requestId, code: 'job_module_invalid', message: 'the job module exports no run() function' });
      return;
    }
    const out = await run(request.job, request.args);
    if (isIterator(out)) {
      // An (async) generator: every yield is a part, the return value is the answer.
      for (;;) {
        const step = await out.next();
        if (step.done) {
          env.post({ type: 'result', requestId, data: step.value });
          return;
        }
        env.post({ type: 'part', requestId, part: step.value });
      }
    }
    env.post({ type: 'result', requestId, data: out });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    env.post({ type: 'error', requestId, message });
  }
}
